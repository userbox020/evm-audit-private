#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { services, validateManifest, validateShortfallPolicy } = require("./monitor-service-manifest");
const { observationalShortfallDecision } = require("./autopilot-status");
const { validateAaveSourceCoverageEnvelope } = require("./aave-source-coverage");

const NOW = Date.now();

function spec() {
  return services.find((row) => row.id === "aave-v4-owner-watch").artifact;
}

function monitorCoverage(overrides = {}) {
  return {
    schema: "aave-source-coverage/v1",
    schemaVersion: 1,
    protocolVersion: "V4",
    coverageKind: "monitor",
    producerKind: "monitor",
    classification: "SOURCE_INCOMPLETE",
    complete: false,
    sampleComplete: false,
    promotionEligible: false,
    exhaustiveProof: null,
    proof: { type: "INCOMPLETE_SOURCE", exact: false, evidence: "bounded" },
    promotionClosure: { eligible: false, routePositive: false, executableNow: false, signedActionJustified: false },
    chainsExpected: 1,
    chainsObserved: 1,
    topologyGeneratedAt: new Date(NOW).toISOString(),
    topologyAgeMs: 0,
    topologyRefreshAttempted: false,
    topologyRefreshOk: true,
    topologySourceComplete: false,
    topologySourceSampleComplete: true,
    topologyUniverse: {
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
    },
    spokeReserveLinks: [],
    consumedReserveLinks: [],
    reserveLinksExpected: 0,
    reserveLinksObserved: 0,
    reserveLinksConsumed: 0,
    reserveLinksCap: 0,
    reserveLinksTruncated: false,
    truncationLimit: 20,
    wasTruncated: true,
    logChunksAttempted: 11,
    logChunksSucceeded: 11,
    logChunksFailed: 0,
    accountReadsAttempted: 60,
    accountReadsSucceeded: 60,
    accountReadsFailed: 0,
    reserveReadsAttempted: 633,
    reserveReadsSucceeded: 633,
    reserveReadsFailed: 0,
    stateReadsAttempted: 693,
    stateReadsSucceeded: 693,
    stateReadsFailed: 0,
    discoveredBorrowers: 142,
    checkedBorrowers: 60,
    spokesExpected: 13,
    spokesObserved: 11,
    errors: [
      "upstream-upstream-incomplete",
      "topology-source-incomplete",
      "required-spoke-failed",
      "spoke-filtered",
      "borrower-truncated",
      "borrower-check-incomplete",
      "source-error",
    ],
    ...overrides,
  };
}

test("the monitor manifest loads and the aave-v4 shortfall policy is well-formed", () => {
  assert.equal(validateManifest(), true);
  const policy = spec().observationalShortfall;
  assert.equal(policy.decision, "OBSERVATIONAL");
  assert.match(policy.kind, /BOUNDED_BORROWER_SCAN/);
  assert.equal(validateShortfallPolicy(policy, "aave-v4-owner-watch"), true);
});

test("the refreshed post-round-2/3 shape is accepted observationally", () => {
  const decision = observationalShortfallDecision(spec(), { sourceCoverage: monitorCoverage() }, NOW);
  assert.equal(decision.accepted, true);
  assert.deepEqual(decision.rejectedBecause, []);
  assert.equal(validateAaveSourceCoverageEnvelope(monitorCoverage(), { protocolVersion: "V4", coverageKind: "monitor" }).failures.includes("reserve-link-envelope"), true);
});

test("a genuine reserve read failure keeps the service fail-closed", () => {
  const decision = observationalShortfallDecision(spec(), { sourceCoverage: monitorCoverage({ reserveReadsFailed: 1, reserveReadsSucceeded: 632, stateReadsFailed: 1, stateReadsSucceeded: 692 }) }, NOW);
  assert.equal(decision.accepted, false);
  assert.ok(decision.rejectedBecause.includes("read-failure:reserveReadsFailed"));
  assert.ok(decision.rejectedBecause.includes("require:reserveReadsFailed"));
});

test("an incomplete (unbound) topology keeps the service fail-closed", () => {
  const coverage = monitorCoverage({
    topologySourceSampleComplete: false,
    topologyUniverse: { type: "DECLARED_STATIC_HUB_SET", bound: false, registry: null, version: null, commit: null, source: null, pinBlock: null, inventoryDigest: null, hubsDeclared: 4, failureReason: "registry-extract-invalid:x" },
  });
  const decision = observationalShortfallDecision(spec(), { sourceCoverage: coverage }, NOW);
  assert.equal(decision.accepted, false);
  assert.ok(decision.rejectedBecause.includes("require:topologySourceSampleComplete"));
  assert.ok(decision.rejectedBecause.includes("strict:topology-universe-unbound"));
});

test("a non-allowlisted producer error keeps the service fail-closed", () => {
  const decision = observationalShortfallDecision(spec(), { sourceCoverage: monitorCoverage({ errors: ["upstream-upstream-incomplete", "mystery-error"] }) }, NOW);
  assert.equal(decision.accepted, false);
  assert.ok(decision.rejectedBecause.includes("error:mystery-error"));
});
