#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  boundTopologyProvenanceFailure,
  validateAaveSourceCoverage,
} = require("./aave-source-coverage");

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

function v4Coverage(overrides = {}) {
  return {
    schema: "aave-source-coverage/v1",
    schemaVersion: 1,
    protocolVersion: "V4",
    coverageKind: "monitor",
    producerKind: "monitor",
    classification: "BOUNDED_OBSERVATIONAL",
    complete: false,
    sampleComplete: true,
    promotionEligible: false,
    exhaustiveProof: null,
    proof: { type: "BOUNDED_OBSERVATION", exact: false, evidence: "bounded" },
    promotionClosure: { eligible: false, routePositive: false, executableNow: false, signedActionJustified: false },
    chainsExpected: 1,
    chainsObserved: 1,
    topologyGeneratedAt: new Date().toISOString(),
    topologyAgeMs: 0,
    topologyRefreshAttempted: true,
    topologyRefreshOk: true,
    spokesExpected: 0,
    spokesObserved: 0,
    topologyUniverse: { ...BOUND_UNIVERSE },
    spokeReserveLinks: [],
    consumedReserveLinks: [],
    reserveLinksExpected: 0,
    reserveLinksObserved: 0,
    reserveLinksConsumed: 0,
    reserveLinksCap: 1,
    reserveLinksTruncated: false,
    wasTruncated: false,
    truncationLimit: 1,
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
    ...overrides,
  };
}

const OPTIONS = { protocolVersion: "V4", coverageKind: "monitor", expectedChains: 1 };

test("boundTopologyProvenanceFailure accepts a pinned, versioned bound topology", () => {
  assert.equal(boundTopologyProvenanceFailure(BOUND_UNIVERSE), null);
});

test("boundTopologyProvenanceFailure fails closed when the topology is unbound", () => {
  assert.equal(boundTopologyProvenanceFailure({ ...BOUND_UNIVERSE, bound: false }), "topology-universe-unbound");
  assert.equal(boundTopologyProvenanceFailure({ ...BOUND_UNIVERSE, bound: undefined }), "topology-universe-unbound");
});

test("boundTopologyProvenanceFailure fails closed when provenance is missing or malformed", () => {
  assert.equal(boundTopologyProvenanceFailure({ ...BOUND_UNIVERSE, registry: null }), "topology-universe-provenance");
  assert.equal(boundTopologyProvenanceFailure({ ...BOUND_UNIVERSE, version: "" }), "topology-universe-provenance");
  assert.equal(boundTopologyProvenanceFailure({ ...BOUND_UNIVERSE, commit: "not-a-commit" }), "topology-universe-provenance");
  assert.equal(boundTopologyProvenanceFailure({ ...BOUND_UNIVERSE, source: " " }), "topology-universe-provenance");
  assert.equal(boundTopologyProvenanceFailure({ ...BOUND_UNIVERSE, pinBlock: null }), "topology-universe-provenance");
  assert.equal(boundTopologyProvenanceFailure({ ...BOUND_UNIVERSE, inventoryDigest: "0xabc" }), "topology-universe-provenance");
});

test("boundTopologyProvenanceFailure rejects a missing or non-declared-static universe", () => {
  assert.equal(boundTopologyProvenanceFailure(null), "topology-universe");
  assert.equal(boundTopologyProvenanceFailure([]), "topology-universe");
  assert.equal(boundTopologyProvenanceFailure({ ...BOUND_UNIVERSE, type: "SOMETHING_ELSE" }), "topology-universe");
});

test("strict validation passes for an otherwise-valid V4 coverage with a bound topology", () => {
  const result = validateAaveSourceCoverage(v4Coverage(), OPTIONS);
  assert.deepEqual(result.failures, []);
  assert.equal(result.valid, true);
  assert.equal(result.readiness, "ready-observational");
});

test("strict validation reports topology-universe-unbound for an unbound topology", () => {
  const result = validateAaveSourceCoverage(v4Coverage({ topologyUniverse: { ...BOUND_UNIVERSE, bound: false } }), OPTIONS);
  assert.ok(result.failures.includes("topology-universe-unbound"));
  assert.ok(!result.failures.includes("topology-universe"));
  assert.equal(result.valid, false);
});

test("strict validation reports topology-universe-provenance for bound-but-unprovenanced topologies", () => {
  const result = validateAaveSourceCoverage(v4Coverage({ topologyUniverse: { ...BOUND_UNIVERSE, commit: null } }), OPTIONS);
  assert.ok(result.failures.includes("topology-universe-provenance"));
  assert.equal(result.valid, false);
});

test("strict validation keeps the generic topology-universe failure for a non-declared-static universe", () => {
  const result = validateAaveSourceCoverage(v4Coverage({ topologyUniverse: { type: "OTHER", bound: false } }), OPTIONS);
  assert.ok(result.failures.includes("topology-universe"));
  assert.equal(result.valid, false);
});

test("the topology check is V4-only and does not affect the V3 path", () => {
  const v3 = {
    ...v4Coverage({ topologyUniverse: { type: "OTHER", bound: false } }),
    protocolVersion: "V3",
    coverageKind: "monitor",
    producerKind: "monitor",
    requiredChainIds: [1],
    observedChainIds: [1],
    routeGeneratedAt: new Date().toISOString(),
    readinessGeneratedAt: new Date().toISOString(),
    maxSourceAgeMs: 60_000,
    routeRefreshAttempted: true,
    routeRefreshOk: true,
    readinessStateReadsAttempted: 0,
    readinessStateReadsSucceeded: 0,
    readinessStateReadsFailed: 0,
    readinessAccountReadsAttempted: 0,
    readinessAccountReadsSucceeded: 0,
    readinessAccountReadsFailed: 0,
  };
  const failures = validateAaveSourceCoverage(v3, { protocolVersion: "V3", coverageKind: "monitor", expectedChains: 1, requiredChainIds: [1] }).failures;
  assert.ok(!failures.includes("topology-universe"));
  assert.ok(!failures.includes("topology-universe-unbound"));
  assert.ok(!failures.includes("topology-universe-provenance"));
});
