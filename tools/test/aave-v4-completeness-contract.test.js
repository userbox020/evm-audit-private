"use strict";

// Offline integration of independent topology, history, and observation-pin evidence.
const test = require("node:test");
const assert = require("node:assert/strict");
const topology = require("../scan-aave-v4-hubs");
const borrower = require("../scan-aave-v4-spoke-borrowers");
const watch = require("../watch-aave-v4-liquidation-triggers");
const { classifyAaveV4Artifact } = require("../monitor-novelty-conditions");
const { EXHAUSTIVE_COMPLETE, SOURCE_INCOMPLETE, validateAaveSourceCoverageEnvelope } = require("../aave-source-coverage");

const NOW = Date.parse("2026-09-20T18:00:00Z");
const HASH = "0x" + "12".repeat(32);
const OTHER_HASH = "0x" + "34".repeat(32);
const SPOKE = "0x0000000000000000000000000000000000000009";

function pin(reads) {
  return {
    schema: "aave-v4-state-pin/v1", chainId: 1, blockNumber: 100, blockHash: HASH,
    finality: "finalized", stateReadsPinned: reads,
    terminalBlockNumber: 100, terminalBlockHash: HASH,
  };
}

function fixture() {
  const registry = topology.loadAaveV4EthereumRegistry();
  const hubs = registry.hubs.map(row => ({
    address: row.address, assetCountReadOk: true, assetCount: 0,
    assetScanTruncated: false, assets: [],
  }));
  hubs[0].assetCount = 1;
  hubs[0].assets = [{
    assetId: 0, status: "ok", spokeDirectory: {
      count: 1, truncated: false, error: null, rows: [{
        address: SPOKE, listed: true, listedError: null, config: { error: null },
        reserve: {
          reserveId: 2, reserveIdError: null, errors: {},
          reserve: { hub: hubs[0].address, assetId: "0", underlying: null },
          oracleData: { spoke: SPOKE, errors: {} },
        },
      }],
    },
  }];
  const upstreamCoverage = topology.buildTopologySourceCoverage(hubs, registry);
  upstreamCoverage.observationPin = pin(upstreamCoverage.stateReadsAttempted);
  return {
    upstreamCoverage, topologyGeneratedAt: new Date(NOW - 1_000).toISOString(),
    chainsExpected: 1, chainsObserved: 1, spokesObserved: 1,
    observedRange: { fromBlock: 10, toBlock: 100 }, historyScope: "DEPLOYMENT_TO_PIN",
    historyStartBound: { block: 10, proven: true, proof: "synthetic deployment-boundary fixture" },
    fullHistoryProven: true, logChunksAttempted: 1, logChunksSucceeded: 1, logChunksFailed: 0,
    discoveredBorrowers: 1, checkedBorrowers: 1,
    accountReadsAttempted: 1, accountReadsSucceeded: 1, accountReadsFailed: 0,
    reserveReadsAttempted: 1, reserveReadsSucceeded: 1, reserveReadsFailed: 0,
    truncationLimit: 20, wasTruncated: false, excludedSpokes: [], errors: [], observationPin: pin(2),
  };
}

function closed(coverage) {
  assert.equal(coverage.complete, false);
  assert.equal(coverage.exhaustiveProof, null);
  assert.equal(coverage.promotionEligible, false);
  assert.deepEqual(coverage.promotionClosure, {
    eligible: false, routePositive: false, executableNow: false, signedActionJustified: false,
  });
}

test("independent complete evidence crosses topology -> borrower -> watch without opening promotion", () => {
  const input = fixture();
  const original = structuredClone(input);
  assert.equal(input.upstreamCoverage.complete, false, "topology does not attest full position history");
  const coverage = borrower.buildSourceCoverage(input, NOW);
  assert.deepEqual(input, original, "producer does not mutate its proof inputs");
  assert.equal(coverage.classification, EXHAUSTIVE_COMPLETE);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.topologySourceComplete, false);
  assert.deepEqual(coverage.topologySourceCoverage, input.upstreamCoverage);
  assert.equal(coverage.blocker, null);
  assert.equal(validateAaveSourceCoverageEnvelope(coverage, { protocolVersion: "V4", coverageKind: "borrower-scan" }).valid, true);
  const monitored = watch.sourceCoverageForArtifact({ sourceCoverage: coverage }, { nowMs: NOW });
  assert.equal(monitored.complete, true);
  assert.equal(monitored.classification, EXHAUSTIVE_COMPLETE);
  assert.equal(validateAaveSourceCoverageEnvelope(monitored, { protocolVersion: "V4", coverageKind: "monitor" }).valid, true);
  assert.equal(monitored.promotionEligible, false);
  assert.deepEqual(monitored.promotionClosure, { eligible: false, routePositive: false, executableNow: false, signedActionJustified: false });
});

test("missing or inconsistent authority/history/pin/sample evidence cannot become exhaustive", () => {
  const cases = [
    ["unbound registry", x => { x.upstreamCoverage.topologyUniverse.bound = false; }],
    ["malformed provenance", x => { x.upstreamCoverage.topologyUniverse.commit = "invalid"; }],
    ["missing hub", x => { x.upstreamCoverage.hubsObserved -= 1; }],
    ["failed topology read", x => { x.upstreamCoverage.stateReadsSucceeded -= 1; x.upstreamCoverage.stateReadsFailed = 1; }],
    ["missing consumed link", x => { x.upstreamCoverage.consumedReserveLinks = []; }],
    ["recent history", x => { x.historyScope = "RECENT_BLOCK_SUFFIX"; x.fullHistoryProven = false; x.historyStartBound = null; }],
    ["recent scope with asserted history flag", x => { x.historyScope = "RECENT_BLOCK_SUFFIX"; }],
    ["missing range", x => { x.observedRange = null; }],
    ["mismatched history start", x => { x.historyStartBound.block = 11; }],
    ["failed log chunk", x => { x.logChunksAttempted = 2; x.logChunksFailed = 1; }],
    ["filtered spoke", x => { x.excludedSpokes = [{ spoke: SPOKE, reasons: ["below-minimum-owed-usd"] }]; }],
    ["truncated page", x => { x.wasTruncated = true; }],
    ["invalid cap", x => { x.truncationLimit = 0; }],
    ["unchecked borrower", x => { x.discoveredBorrowers = 2; }],
    ["failed account read", x => { x.accountReadsSucceeded = 0; x.accountReadsFailed = 1; }],
    ["stale topology", x => { x.topologyGeneratedAt = new Date(NOW - 600_001).toISOString(); }],
    ["missing topology pin", x => { delete x.upstreamCoverage.observationPin; }],
    ["missing borrower pin", x => { delete x.observationPin; }],
    ["unfinalized", x => { x.observationPin.finality = "latest"; }],
    ["wrong chain", x => { x.observationPin.chainId = 8453; }],
    ["malformed hash", x => { x.observationPin.blockHash = "invalid"; }],
    ["zero hash", x => { x.observationPin.blockHash = "0x" + "00".repeat(32); x.observationPin.terminalBlockHash = x.observationPin.blockHash; }],
    ["wrong block hash", x => { x.observationPin.blockHash = OTHER_HASH; x.observationPin.terminalBlockHash = OTHER_HASH; }],
    ["unreconciled reads", x => { x.observationPin.stateReadsPinned = 1; }],
    ["terminal hash changed", x => { x.observationPin.terminalBlockHash = OTHER_HASH; }],
    ["terminal number changed", x => { x.observationPin.terminalBlockNumber = 101; }],
    ["missing terminal confirmation", x => { delete x.observationPin.terminalBlockHash; }],
    ["history extends beyond pin", x => { x.observedRange.toBlock = 101; }],
  ];
  for (const [name, mutate] of cases) {
    const input = fixture();
    mutate(input);
    const coverage = borrower.buildSourceCoverage(input, NOW);
    assert.doesNotThrow(() => closed(coverage), name);
    assert.ok(coverage.blocker, name);
  }
});

test("bound, complete history without a pin reports the missing observation proof, not missing registry", () => {
  const input = fixture();
  delete input.observationPin;
  const coverage = borrower.buildSourceCoverage(input, NOW);
  closed(coverage);
  assert.match(coverage.blocker, /pin/i);
  assert.doesNotMatch(coverage.blocker, /not bound/i);
});

test("incomplete borrower and watch retain validated topology context without claiming a complete sample", () => {
  const input = fixture();
  input.discoveredBorrowers = 2;
  input.wasTruncated = true;
  const coverage = borrower.buildSourceCoverage(input, NOW);
  closed(coverage);
  assert.match(coverage.blocker, /borrower-truncated/);
  const monitored = watch.sourceCoverageForArtifact({ sourceCoverage: coverage }, { nowMs: NOW });
  closed(monitored);
  assert.equal(monitored.classification, SOURCE_INCOMPLETE);
  assert.equal(monitored.spokesExpected, 1);
  assert.equal(monitored.reserveLinksExpected, 1);
  assert.equal(monitored.reserveLinksConsumed, 1);
  assert.deepEqual(monitored.consumedReserveLinks, input.upstreamCoverage.consumedReserveLinks);
  assert.deepEqual(monitored.topologySourceCoverage, input.upstreamCoverage);
  assert.equal(validateAaveSourceCoverageEnvelope(monitored, { protocolVersion: "V4", coverageKind: "monitor" }).valid, true);
});

test("watch rejects a forged flat registry instead of restoring unvalidated authority flags", () => {
  const coverage = borrower.buildSourceCoverage(fixture(), NOW);
  coverage.topologyUniverse = { ...coverage.topologyUniverse, commit: "f".repeat(40) };
  const monitored = watch.sourceCoverageForArtifact({ sourceCoverage: coverage }, { nowMs: NOW });
  closed(monitored);
  assert.equal(monitored.topologyUniverse, null);
});

test("envelope validation rejects self-attested exhaustive flags without the required evidence", () => {
  const coverage = borrower.buildSourceCoverage(fixture(), NOW);
  delete coverage.topologySourceCoverage;
  delete coverage.observationPin;
  coverage.classification = EXHAUSTIVE_COMPLETE;
  coverage.complete = true;
  coverage.sampleComplete = true;
  coverage.fullHistoryProven = true;
  coverage.exhaustiveProof = { type: "self-attested", exact: true, evidence: "unsupported" };
  coverage.proof = { ...coverage.exhaustiveProof };
  assert.equal(validateAaveSourceCoverageEnvelope(coverage, { protocolVersion: "V4", coverageKind: "borrower-scan" }).valid, false);
});

test("a failed borrower scan cannot be restored to exhaustive by its retained proof", () => {
  const coverage = borrower.buildSourceCoverage(fixture(), NOW);
  const monitored = watch.sourceCoverageForArtifact({ sourceCoverage: coverage }, { nowMs: NOW, scanAttempted: true, scanOk: false });
  closed(monitored);
  assert.equal(monitored.sampleComplete, false);
});

test("exhaustive metadata remains linked to its explicit history and pinned proof", () => {
  const input = fixture();
  input.observedRange.fromBlock = 0;
  input.historyScope = "GENESIS_TO_TIP";
  input.historyStartBound = null;
  const coverage = borrower.buildSourceCoverage(input, NOW);
  assert.equal(coverage.complete, true);
  for (const mutate of [
    row => { row.fullHistoryProven = false; },
    row => { row.exhaustiveProof.blockHash = OTHER_HASH; row.proof = { ...row.exhaustiveProof }; },
    row => { row.exhaustiveProof.registryCommit = "f".repeat(40); row.proof = { ...row.exhaustiveProof }; },
  ]) {
    const forged = structuredClone(coverage);
    mutate(forged);
    assert.equal(validateAaveSourceCoverageEnvelope(forged, { protocolVersion: "V4", coverageKind: "borrower-scan" }).valid, false);
  }
});

test("bound observational evidence still survives serialized watch ingestion", () => {
  const input = fixture();
  input.observedRange.fromBlock = 90;
  input.historyScope = "RECENT_BLOCK_SUFFIX";
  input.historyStartBound = null;
  input.fullHistoryProven = false;
  delete input.observationPin;
  delete input.upstreamCoverage.observationPin;
  const coverage = borrower.buildSourceCoverage(input, NOW);
  closed(coverage);
  assert.equal(coverage.sampleComplete, true);
  const generatedAt = new Date(NOW).toISOString();
  const snapshot = watch.summarizeBorrowers({
    generatedAt, scanner: watch.SOURCE_SCANNER, sourceCoverage: coverage,
    summary: { activeBorrowers: 0, nearLiquidation: 0, liquidatable: 0, routePositive: 0 }, topUsers: [],
  }, { nowMs: NOW });
  snapshot.generatedAt = generatedAt;
  snapshot.iteration = 1;
  const artifact = JSON.parse(JSON.stringify(watch.forceMonitorOnlyArtifact(
    watch.buildWatchArtifact(snapshot, [], {}, { generatedAt }),
  )));
  assert.equal(classifyAaveV4Artifact(artifact, NOW).status, "VALID_FRESH");
  closed(artifact.sourceCoverage);
});

test("exhaustive evidence retains exact linkage through the monitor sanitizer and JSON boundary", () => {
  const coverage = borrower.buildSourceCoverage(fixture(), NOW);
  const generatedAt = new Date(NOW).toISOString();
  const snapshot = watch.summarizeBorrowers({ generatedAt, scanner: watch.SOURCE_SCANNER, sourceCoverage: coverage,
    summary: { activeBorrowers: 0, nearLiquidation: 0, liquidatable: 0, routePositive: 0 }, topUsers: [] }, { nowMs: NOW });
  snapshot.generatedAt = generatedAt;
  const artifact = JSON.parse(JSON.stringify(watch.forceMonitorOnlyArtifact(watch.buildWatchArtifact(snapshot, [], {}, { generatedAt }))));
  assert.deepEqual(artifact.sourceCoverage.exhaustiveProof, coverage.exhaustiveProof);
  assert.equal(validateAaveSourceCoverageEnvelope(artifact.sourceCoverage, { protocolVersion: "V4", coverageKind: "monitor" }).valid, true);
  assert.equal(classifyAaveV4Artifact(artifact, NOW).status, "VALID_FRESH");
  assert.equal(artifact.sourceCoverage.promotionEligible, false);
  assert.equal(artifact.safety.signedActionJustified, false);
  const { validateArtifactSemantics } = require("../autopilot-status");
  const spec = require("../monitor-service-manifest").services.find(service => service.id === "aave-v4-owner-watch").artifact;
  assert.equal(validateArtifactSemantics(spec, artifact, null, NOW), true);
  for (const mutate of [
    row => { row.proof.evidence = row.exhaustiveProof.evidence = "unvalidated text"; },
    row => { row.fullHistoryProven = false; },
    row => { row.observationPin.terminalBlockHash = OTHER_HASH; },
    row => { row.wasTruncated = true; },
    row => { row.reserveReadsFailed = 1; },
  ]) {
    const forged = structuredClone(artifact);
    mutate(forged.sourceCoverage);
    assert.equal(validateAaveSourceCoverageEnvelope(forged.sourceCoverage, { protocolVersion: "V4", coverageKind: "monitor" }).valid, false);
    assert.equal(classifyAaveV4Artifact(forged, NOW).status, "SCHEMA_INVALID");
    assert.equal(validateArtifactSemantics(spec, forged, null, NOW), false);
  }
});
