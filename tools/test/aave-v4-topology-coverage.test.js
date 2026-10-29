"use strict";

// Focused coverage/schema tests for the Aave V4 topology -> borrower -> watch
// chain. They prove both directions:
//   * a genuinely complete topology still validates and reaches readiness; and
//   * an incomplete, missing, or dishonestly-complete artifact still fails closed.
//
// All fixtures are offline; no RPC, endpoint, or network access is used.

const test = require("node:test");
const assert = require("node:assert/strict");

const topology = require("../scan-aave-v4-hubs");
const borrower = require("../scan-aave-v4-spoke-borrowers");
const watch = require("../watch-aave-v4-liquidation-triggers");
const { LIMITS: COLLECTION_LIMITS } = require("../lib/aave-v4-pinned-collection");
const {
  BOUNDED_OBSERVATIONAL,
  SOURCE_INCOMPLETE,
  validateAaveSourceCoverageEnvelope,
} = require("../aave-source-coverage");

const NOW_MS = Date.parse("2026-09-15T00:30:00.000Z");

function goodRow(hubAddress, assetId, spoke, reserveId = 0) {
  return {
    address: spoke,
    listed: true,
    listedError: null,
    config: { error: null },
    reserve: {
      reserveId,
      reserveIdError: null,
      errors: {},
      reserve: { hub: hubAddress, assetId: String(assetId), underlying: null },
      oracleData: { spoke, errors: {} },
    },
  };
}

function failedRow(spoke) {
  return {
    address: spoke,
    listed: true,
    listedError: null,
    config: { error: null },
    reserve: { reserveId: null, reserveIdError: "call-reverted", errors: {}, reserve: null, oracleData: null },
  };
}

function emptyHubs() {
  return Array.from({ length: 3 }, (_, index) => ({
    address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    assetCountReadOk: true,
    assetCount: 0,
    assetScanTruncated: false,
    assets: [],
  }));
}

function hubWithRows(rows) {
  return [
    {
      address: "0x0000000000000000000000000000000000000001",
      assetCountReadOk: true,
      assetCount: 1,
      assetScanTruncated: false,
      assets: [{
        assetId: 7,
        status: "ok",
        spokeDirectory: { count: rows.length, truncated: false, error: null, rows },
      }],
    },
    ...Array.from({ length: 2 }, (_, index) => ({
      address: `0x${(index + 2).toString(16).padStart(40, "0")}`,
      assetCountReadOk: true,
      assetCount: 0,
      assetScanTruncated: false,
      assets: [],
    })),
  ];
}

function readyBorrowerCoverage(nowMs = NOW_MS) {
  const upstream = topology.buildTopologySourceCoverage(emptyHubs());
  return borrower.buildSourceCoverage({
    topologyGeneratedAt: new Date(nowMs - 1_000).toISOString(),
    topologyRefreshAttempted: false,
    topologyRefreshOk: true,
    topologySourceComplete: false,
    topologySourceSampleComplete: true,
    topologyUniverse: upstream.topologyUniverse,
    spokeReserveLinks: upstream.spokeReserveLinks,
    upstreamCoverage: upstream,
    chainsExpected: 1,
    chainsObserved: 1,
    spokesExpected: 0,
    spokesObserved: 0,
    observedRange: { fromBlock: 1, toBlock: 100 },
    historyScope: "RECENT_BLOCK_SUFFIX",
    fullHistoryProven: false,
    logChunksAttempted: 1, logChunksSucceeded: 1, logChunksFailed: 0,
    discoveredBorrowers: 0, checkedBorrowers: 0,
    accountReadsAttempted: 0, accountReadsSucceeded: 0, accountReadsFailed: 0,
    reserveReadsAttempted: 0, reserveReadsSucceeded: 0, reserveReadsFailed: 0,
    truncationLimit: 20, wasTruncated: false, errors: [],
  }, nowMs);
}

function pinnedTopology(ageMs = 0, nowMs = NOW_MS) {
  const sourceCoverage = topology.buildTopologySourceCoverage(emptyHubs());
  sourceCoverage.observationPin = {
    schema: "aave-v4-state-pin/v1", chainId: 1, finality: "finalized",
    blockNumber: 100, blockHash: "0x" + "12".repeat(32),
    terminalBlockNumber: 100, terminalBlockHash: "0x" + "12".repeat(32),
    stateReadsPinned: sourceCoverage.stateReadsAttempted,
  };
  return { generatedAt: new Date(nowMs - ageMs).toISOString(), sourceCoverage };
}

test("topology freshness remains 600 seconds and validity headroom is strict and opt-in", () => {
  assert.equal(borrower.TOPOLOGY_MAX_AGE_MS, 600_000);
  assert.equal(watch.TOPOLOGY_SCAN_HEADROOM_MS, COLLECTION_LIMITS.maxMs + 60_000);
  assert.equal(watch.TOPOLOGY_SCAN_HEADROOM_MS, 300_000);
  assert.equal(watch.topologyUsable(pinnedTopology(480_000), NOW_MS), true);
  assert.equal(watch.topologyUsable(pinnedTopology(480_000), NOW_MS, watch.TOPOLOGY_SCAN_HEADROOM_MS), false);
  assert.equal(watch.topologyUsable(pinnedTopology(600_000), NOW_MS), true);
  assert.equal(watch.topologyUsable(pinnedTopology(600_001), NOW_MS), false);
  for (const invalid of [-1, NaN, Infinity, "0", null, 0.5, 600_001]) {
    assert.equal(watch.topologyUsable(pinnedTopology(), NOW_MS, invalid), false);
  }
});

test("fresh-now topology with insufficient scan lifetime refreshes to a usable new source", () => {
  let artifact = pinnedTopology(480_000);
  let runs = 0;
  const afterNowMs = NOW_MS + 20_000;
  const result = watch.refreshTopologyIfNeeded({
    nowMs: NOW_MS, afterNowMs, load: () => artifact,
    run: () => { runs += 1; artifact = pinnedTopology(120_000, afterNowMs); },
  });
  assert.equal(runs, 1);
  assert.deepEqual(result, { topologyRefreshAttempted: true, topologyRefreshOk: true });
  assert.equal(watch.topologyUsable(artifact, afterNowMs, watch.TOPOLOGY_SCAN_HEADROOM_MS), true);
});

test("post-refresh scan headroom is checked at completion and insufficient lifetime never retries", () => {
  let artifact = pinnedTopology(480_000);
  let runs = 0;
  let loads = 0;
  const result = watch.refreshTopologyIfNeeded({
    nowMs: NOW_MS, afterNowMs: NOW_MS + 180_001,
    load: () => { loads += 1; return artifact; },
    run: () => { runs += 1; artifact = pinnedTopology(120_000); },
  });
  assert.equal(runs, 1);
  assert.equal(loads, 2);
  assert.equal(watch.topologyUsable(artifact, NOW_MS + 180_001), true);
  assert.deepEqual(result, { topologyRefreshAttempted: true, topologyRefreshOk: false, error: "topology-refresh-incomplete" });
});

test("sufficient pre-scan headroom including the exact boundary skips refresh", () => {
  for (const ageMs of [120_000, 300_000]) {
    let loads = 0;
    const result = watch.refreshTopologyIfNeeded({
      nowMs: NOW_MS, load: () => { loads += 1; return pinnedTopology(ageMs); },
      run: () => assert.fail("fresh topology with sufficient lifetime must not refresh"),
    });
    assert.equal(loads, 1);
    assert.deepEqual(result, { topologyRefreshAttempted: false, topologyRefreshOk: true });
  }
});

test("headroom cannot bypass missing schema, sample completeness or observation-pin guards", () => {
  const noPin = pinnedTopology();
  delete noPin.sourceCoverage.observationPin;
  const badPin = pinnedTopology();
  badPin.sourceCoverage.observationPin.terminalBlockHash = "0x" + "34".repeat(32);
  const incomplete = pinnedTopology();
  incomplete.sourceCoverage.sampleComplete = false;
  const badSchema = pinnedTopology();
  badSchema.sourceCoverage.schema = "invalid";
  for (const artifact of [null, {}, noPin, badPin, incomplete, badSchema]) {
    assert.equal(watch.topologyUsable(artifact, NOW_MS), false);
    const result = watch.refreshTopologyIfNeeded({ nowMs: NOW_MS, afterNowMs: NOW_MS, load: () => artifact, run: () => {} });
    assert.deepEqual(result, { topologyRefreshAttempted: true, topologyRefreshOk: false, error: "topology-refresh-incomplete" });
  }
});

test("failed headroom refresh is sanitized and leaves borrower coverage ineligible", () => {
  let runs = 0;
  const result = watch.refreshTopologyIfNeeded({
    nowMs: NOW_MS, load: () => pinnedTopology(480_000),
    run: () => { runs += 1; throw new Error("SENSITIVE_FIXTURE_DETAIL"); },
  });
  assert.equal(runs, 1);
  assert.deepEqual(result, { topologyRefreshAttempted: true, topologyRefreshOk: false, error: "topology-refresh-failed" });
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_FIXTURE_DETAIL/);
  const coverage = watch.sourceCoverageForArtifact({ sourceCoverage: readyBorrowerCoverage() }, {
    nowMs: NOW_MS, ...result, topologyRefreshError: result.error,
  });
  assert.equal(coverage.complete, false);
  assert.equal(coverage.promotionEligible, false);
  assert.ok(coverage.errors.includes("topology-refresh-failed"));
});

test("borrower coverage still fails closed when completion exceeds topology expiry", () => {
  const before = readyBorrowerCoverage();
  assert.equal(before.sampleComplete, true);
  assert.equal(before.errors.includes("topology-stale"), false);
  const coverage = watch.sourceCoverageForArtifact({ sourceCoverage: before }, { nowMs: NOW_MS + 600_001 });
  assert.equal(coverage.sampleComplete, false);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.promotionEligible, false);
  assert.ok(coverage.errors.includes("topology-stale"));
});

test("Aave V4 complete topology validates and reaches observational readiness", () => {
  const spoke = "0x0000000000000000000000000000000000000009";
  const coverage = topology.buildTopologySourceCoverage(
    hubWithRows([goodRow("0x0000000000000000000000000000000000000001", 7, spoke, 3)]),
  );
  assert.equal(coverage.sampleComplete, true);
  assert.equal(coverage.classification, BOUNDED_OBSERVATIONAL);
  assert.equal(coverage.reserveLinksExpected, 1);
  assert.equal(coverage.reserveLinksObserved, 1);
  assert.equal(coverage.reserveLinksConsumed, 1);
  assert.equal(coverage.spokesExpected, 1);
  assert.equal(coverage.spokesObserved, 1);
  assert.deepEqual(coverage.errors, []);
  assert.equal(validateAaveSourceCoverageEnvelope(coverage, {
    protocolVersion: "V4", coverageKind: "topology",
  }).valid, true);
  assert.equal(validateAaveSourceCoverageEnvelope(coverage, {
    protocolVersion: "V4", coverageKind: "topology", requireSampleComplete: true,
  }).valid, true);
});

test("Aave V4 unreadable reserve reads are never counted as observed links", () => {
  const goodSpoke = "0x0000000000000000000000000000000000000009";
  const failedSpoke = "0x000000000000000000000000000000000000000b";
  const coverage = topology.buildTopologySourceCoverage(hubWithRows([
    goodRow("0x0000000000000000000000000000000000000001", 7, goodSpoke, 3),
    failedRow(failedSpoke),
  ]));
  // Regression: `Number(null)` is 0, so the old producer fabricated an observed
  // reserveId-0 link for every failed reserve read.
  assert.equal(coverage.reserveLinksExpected, 2);
  assert.equal(coverage.reserveLinksObserved, 1);
  assert.equal(coverage.reserveLinksConsumed, 1);
  assert.equal(coverage.classification, SOURCE_INCOMPLETE);
  assert.equal(coverage.sampleComplete, false);
  assert.ok(coverage.errors.includes("required-spoke-failed"));
  assert.ok(coverage.errors.includes("reserve-state-read-failed"));

  // Structurally valid, but readiness still fails closed.
  assert.equal(validateAaveSourceCoverageEnvelope(coverage, {
    protocolVersion: "V4", coverageKind: "topology",
  }).valid, true);
  const strict = validateAaveSourceCoverageEnvelope(coverage, {
    protocolVersion: "V4", coverageKind: "topology", requireSampleComplete: true,
  });
  assert.equal(strict.valid, false);
  assert.ok(strict.failures.includes("upstream-incomplete"));
});

test("Aave V4 incomplete topology cannot be laundered into a complete claim", () => {
  const goodSpoke = "0x0000000000000000000000000000000000000009";
  const failedSpoke = "0x000000000000000000000000000000000000000b";
  const incomplete = topology.buildTopologySourceCoverage(hubWithRows([
    goodRow("0x0000000000000000000000000000000000000001", 7, goodSpoke, 3),
    failedRow(failedSpoke),
  ]));

  // A dishonest sampleComplete=true with missing links is rejected.
  const laundered = structuredClone(incomplete);
  laundered.sampleComplete = true;
  laundered.classification = BOUNDED_OBSERVATIONAL;
  assert.equal(validateAaveSourceCoverageEnvelope(laundered, {
    protocolVersion: "V4", coverageKind: "topology",
  }).valid, false);

  // A genuinely complete topology with a dropped consumed link is rejected.
  const complete = topology.buildTopologySourceCoverage(
    hubWithRows([goodRow("0x0000000000000000000000000000000000000001", 7, goodSpoke, 3)]),
  );
  const missing = structuredClone(complete);
  missing.consumedReserveLinks.pop();
  assert.equal(validateAaveSourceCoverageEnvelope(missing, {
    protocolVersion: "V4", coverageKind: "topology",
  }).valid, false);

  const duplicate = structuredClone(complete);
  duplicate.consumedReserveLinks.push(structuredClone(duplicate.consumedReserveLinks[0]));
  duplicate.reserveLinksConsumed += 1;
  duplicate.spokeReserveLinks[0].links.push(structuredClone(duplicate.spokeReserveLinks[0].links[0]));
  duplicate.spokeReserveLinks[0].consumed += 1;
  assert.equal(validateAaveSourceCoverageEnvelope(duplicate, {
    protocolVersion: "V4", coverageKind: "topology",
  }).valid, false);
});

test("Aave V4 watch monitor coverage fails closed on a missing upstream envelope", () => {
  const coverage = watch.sourceCoverageForArtifact({}, { nowMs: NOW_MS });
  assert.equal(coverage.classification, SOURCE_INCOMPLETE);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.sampleComplete, false);
  assert.equal(coverage.chainsExpected, 1);
  assert.equal(coverage.chainsObserved, 0);
  assert.ok(coverage.errors.includes("upstream-coverage-not-object"));
  assert.equal(coverage.promotionEligible, false);
});

test("Aave V4 watch distinguishes refresh exception from unusable artifact", () => {
  const thrown = watch.refreshTopologyIfNeeded({
    nowMs: NOW_MS, load: () => null, run: () => { throw new Error("scanner-failed"); },
  });
  assert.equal(thrown.topologyRefreshAttempted, true);
  assert.equal(thrown.topologyRefreshOk, false);
  assert.equal(thrown.error, "topology-refresh-failed");

  const incomplete = watch.refreshTopologyIfNeeded({
    nowMs: NOW_MS, load: () => null, run: () => {}, afterNowMs: NOW_MS,
  });
  assert.equal(incomplete.topologyRefreshAttempted, true);
  assert.equal(incomplete.topologyRefreshOk, false);
  assert.equal(incomplete.error, "topology-refresh-incomplete");

  const ready = readyBorrowerCoverage();
  const thrownCode = watch.sourceCoverageForArtifact({ sourceCoverage: ready }, {
    nowMs: NOW_MS,
    topologyRefreshAttempted: true,
    topologyRefreshOk: false,
    topologyRefreshError: "topology-refresh-failed",
  });
  assert.ok(thrownCode.errors.includes("topology-refresh-failed"));

  const incompleteCode = watch.sourceCoverageForArtifact({ sourceCoverage: ready }, {
    nowMs: NOW_MS,
    topologyRefreshAttempted: true,
    topologyRefreshOk: false,
    topologyRefreshError: "topology-refresh-incomplete",
  });
  assert.ok(incompleteCode.errors.includes("topology-refresh-incomplete"));
  assert.equal(incompleteCode.errors.includes("topology-refresh-failed"), false);
});
