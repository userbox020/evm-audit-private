"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const manifest = require("../monitor-service-manifest");
const statusModule = require("../autopilot-status");
const { buildCompletionArtifact } = require("../morpho-find-liquidatable");

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function producerCoverage(overrides = {}) {
  return {
    currentBlock: 1000,
    logQuerySuccessful: true,
    observedRange: { fromBlock: 0, toBlock: 1000 },
    historyScope: "GENESIS_TO_TIP",
    historyStartBound: { block: 0, kind: "genesis", proven: true, proof: "genesis" },
    fullHistoryProven: true,
    caps: { borrowLogs: 500, borrowersPerMarket: 30 },
    borrowLogs: { discovered: 4, processed: 4, omittedByCap: 0, malformed: 0, wasTruncated: false },
    markets: { discoveryScope: "processedBorrowLogs", discovered: 2, attempted: 2, resolved: 2, unresolved: 0 },
    borrowers: { discoveryScope: "processedBorrowLogs", discoveredUnique: 4, discoveredMarketBorrowerPairs: 4, selectedForCheck: 4, omittedByCap: 0, wasTruncated: false },
    positions: { discovered: 4, selectedForCheck: 4, readAttempts: 4, successfullyChecked: 4, readFailures: 0, unchecked: 0, uncheckedDueToBorrowerCap: 0, uncheckedDueToUnresolvedMarket: 0 },
    reads: {
      attempts: 12,
      successes: 12,
      failures: 0,
      byKind: {
        blockNumber: { attempts: 1, successes: 1, failures: 0 },
        borrowLogs: { attempts: 1, successes: 1, failures: 0 },
        marketParams: { attempts: 2, successes: 2, failures: 0 },
        marketState: { attempts: 2, successes: 2, failures: 0 },
        oraclePrice: { attempts: 2, successes: 2, failures: 0 },
        position: { attempts: 4, successes: 4, failures: 0 },
      },
    },
    operationalFailures: 0,
    errors: 0,
    ...overrides,
  };
}

function boundedCoverage() {
  return producerCoverage({
    currentBlock: 10000,
    observedRange: { fromBlock: 5000, toBlock: 10000 },
    historyScope: "RECENT_BLOCK_SUFFIX",
    historyStartBound: null,
    fullHistoryProven: false,
  });
}

function morphoSpec() {
  return manifest.services.find((service) => service.id === "morpho-startup-scan").artifact;
}

test("manifest declares the morpho startup scan as bounded-observational", () => {
  const service = manifest.services.find((row) => row.id === "morpho-startup-scan");
  assert.equal(service.coverageMode, "BOUNDED_OBSERVATIONAL");
  assert.equal(service.mode, "read-only");
  assert.equal(service.kind, "scheduled");
  assert.equal(manifest.validateManifest(), true);
});

test("an honest bounded-window artifact validates observationally and a genuine exhaustive artifact still passes strictly", () => {
  const spec = morphoSpec();
  const exhaustive = buildCompletionArtifact(producerCoverage(), [], new Date(NOW));
  const bounded = buildCompletionArtifact(boundedCoverage(), [], new Date(NOW));

  assert.equal(exhaustive.classification, "EXHAUSTIVE_COMPLETE");
  assert.equal(exhaustive.complete, true);
  assert.equal(exhaustive.coverage.fullHistoryProven, true);
  assert.equal(statusModule.validateArtifactSemantics(spec, exhaustive, null, NOW), true);

  assert.equal(bounded.classification, "BOUNDED_WINDOW_INCOMPLETE");
  assert.equal(bounded.complete, false);
  assert.equal(bounded.coverage.fullHistoryProven, false);
  assert.equal(statusModule.validateArtifactSemantics(spec, bounded, null, NOW), true);
});

test("a bounded artifact is reported observational and accepted by the scheduled service", () => {
  const bounded = buildCompletionArtifact(boundedCoverage(), [], new Date(NOW));
  const row = statusModule.buildServiceStatuses([], {
    nowMs: NOW,
    artifactMap: { "reports/monitor/morpho-liquidatable-startup.json": { json: bounded, mtimeMs: NOW - 1000 } },
    scriptExists: () => true,
  }).find((service) => service.id === "morpho-startup-scan");
  assert.equal(row.artifact.observational, true);
  assert.equal(row.artifact.acceptable, true);
  assert.equal(row.artifact.semanticValid, true);
  assert.equal(row.readiness, "complete");
});

test("a falsely-complete or truncated morpho artifact still fails closed", () => {
  const spec = morphoSpec();
  const exhaustive = buildCompletionArtifact(producerCoverage(), [], new Date(NOW));
  const bounded = buildCompletionArtifact(boundedCoverage(), [], new Date(NOW));
  const cases = [
    ["exhaustive classification with complete flag but no proven history", {
      ...exhaustive,
      coverage: { ...exhaustive.coverage, fullHistoryProven: false },
    }],
    ["bounded observation relabelled as exhaustive and complete", {
      ...bounded,
      classification: "EXHAUSTIVE_COMPLETE",
      complete: true,
    }],
    ["bounded observation that asserts completeness", { ...bounded, complete: true }],
    ["bounded observation that claims proven history", {
      ...bounded,
      coverage: { ...bounded.coverage, fullHistoryProven: true },
    }],
    ["bounded observation with no blocker explanation", { ...bounded, blocker: null }],
    ["bounded observation with truncated discovery", {
      ...bounded,
      coverage: {
        ...bounded.coverage,
        borrowLogs: { ...bounded.coverage.borrowLogs, omittedByCap: 1, wasTruncated: true },
      },
    }],
  ];
  for (const [label, artifact] of cases) {
    assert.equal(statusModule.validateArtifactSemantics(spec, artifact, null, NOW), false, label);
  }
});
