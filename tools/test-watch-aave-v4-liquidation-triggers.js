#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { sourceCoverageForArtifact } = require("./watch-aave-v4-liquidation-triggers");

const BOUND_UNIVERSE = {
  type: "DECLARED_STATIC_HUB_SET",
  bound: true,
  registry: "aave-dao/aave-address-book",
  version: "v4.68.2",
  commit: "56b926e4ed27e96aeb72f2d5a8e0aaebb50548ff",
  source: "scripts/configs/v4/ethereum.ts + src/AaveV4Ethereum.ts",
  pinBlock: "0x18cfd59",
  inventoryDigest: "8b293b95955a2431bd7516abcbf52f5466ddd0b9340074b6222c5db2e507ef40",
  hubsDeclared: 4,
  failureReason: null,
};

function borrowerArtifact(topologyUniverse = BOUND_UNIVERSE, topologySourceSampleComplete = true) {
  return {
    generatedAt: new Date().toISOString(),
    sourceCoverage: {
      schema: "aave-source-coverage/v1",
      schemaVersion: 1,
      protocolVersion: "V4",
      coverageKind: "borrower-scan",
      producerKind: "borrower-scan",
      classification: "SOURCE_INCOMPLETE",
      complete: false,
      sampleComplete: false,
      promotionEligible: false,
      exhaustiveProof: null,
      proof: { type: "INCOMPLETE_SOURCE", exact: false, evidence: "bounded" },
      promotionClosure: { eligible: false, routePositive: false, executableNow: false, signedActionJustified: false },
      chainsExpected: 1,
      chainsObserved: 1,
      spokesExpected: 0,
      spokesObserved: 0,
      topologyGeneratedAt: new Date().toISOString(),
      topologyAgeMs: 0,
      topologyRefreshAttempted: false,
      topologyRefreshOk: true,
      topologySourceComplete: false,
      topologySourceSampleComplete,
      topologyUniverse,
      spokeReserveLinks: [],
      consumedReserveLinks: [],
      reserveLinksExpected: 0,
      reserveLinksObserved: 0,
      reserveLinksConsumed: 0,
      reserveLinksCap: 1,
      reserveLinksTruncated: false,
      truncationLimit: 1,
      wasTruncated: false,
      logChunksAttempted: 1,
      logChunksSucceeded: 1,
      logChunksFailed: 0,
      accountReadsAttempted: 0,
      accountReadsSucceeded: 0,
      accountReadsFailed: 0,
      reserveReadsAttempted: 0,
      reserveReadsSucceeded: 0,
      reserveReadsFailed: 0,
      stateReadsAttempted: 0,
      stateReadsSucceeded: 0,
      stateReadsFailed: 0,
      discoveredBorrowers: 0,
      checkedBorrowers: 0,
      errors: [],
    },
  };
}

test("sourceCoverageForArtifact forwards a bound topology even when the borrower scan is sample-incomplete", () => {
  const coverage = sourceCoverageForArtifact(borrowerArtifact());
  assert.equal(coverage.topologySourceSampleComplete, true);
  assert.equal(coverage.topologyUniverse?.bound, true);
  assert.equal(coverage.topologyUniverse?.registry, "aave-dao/aave-address-book");
  assert.equal(coverage.topologyUniverse?.version, "v4.68.2");
});

test("sourceCoverageForArtifact does not forward the topology when it is unbound", () => {
  const coverage = sourceCoverageForArtifact(borrowerArtifact({ ...BOUND_UNIVERSE, bound: false }, false));
  assert.equal(coverage.topologyUniverse, null);
  assert.equal(coverage.topologySourceSampleComplete, false);
});

test("sourceCoverageForArtifact does not forward the topology when the upstream sample is incomplete", () => {
  const coverage = sourceCoverageForArtifact(borrowerArtifact(BOUND_UNIVERSE, false));
  assert.equal(coverage.topologyUniverse, null);
  assert.equal(coverage.topologySourceSampleComplete, false);
});
