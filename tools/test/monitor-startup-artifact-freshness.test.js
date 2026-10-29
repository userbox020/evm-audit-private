"use strict";

// Startup-scoped freshness contract for the three monitor-set launch artifacts (2026-09-16).
//
// These artifacts are written once per monitor-set launch and have no between-launch refresher, so
// a 24 h window expired by construction on sessions longer than a day. The manifest now declares a
// 7-day window for exactly these three. These tests pin both halves of the contract:
//   * an artifact older than 24 h (but younger than the declared startup window) is FRESH and
//     ACCEPTABLE, so the launch-scoped artifacts stop flapping red purely on age; and
//   * a MISSING or MALFORMED artifact still FAILS, so only the time dimension was relaxed and
//     every structural/correctness check stays strict.

const test = require("node:test");
const assert = require("node:assert/strict");

const manifest = require("../monitor-service-manifest");
const statusModule = require("../autopilot-status");
const { buildCompletionArtifact } = require("../morpho-find-liquidatable");

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
// 28.8 h — the exact age observed at diagnosis, and comfortably beyond the old 1440-minute window.
const OLDER_THAN_A_DAY = new Date(NOW - 1728 * 60_000).toISOString();
const STARTUP_WINDOW_MINUTES = 10080; // 7 days
const OLD_WINDOW_MINUTES = 1440; // 24 h

const STARTUP_SERVICE_IDS = ["morpho-startup-scan", "disabled-routes-report", "research-watch-build"];

function specFor(serviceId) {
  const service = manifest.services.find((row) => row.id === serviceId);
  assert.ok(service, `manifest service present: ${serviceId}`);
  return service;
}

function morphoCoverage(overrides = {}) {
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

function validDisabledRoutes(generatedAt) {
  return {
    generatedAt,
    scanner: "tools/autopilot-disabled-routes.js",
    summary: {
      observedLowFundCandidates: 1,
      disabledRoutes: 1,
      executableNow: false,
      executableNowCount: 0,
      signedActionJustified: false,
      hardStop: false,
    },
    observedLowFundCandidates: [{}],
    disabledRoutes: [{}],
  };
}

// A synthetic artifact map that holds each startup artifact at a given age (or absence/shape).
function validStartupArtifacts(generatedAt) {
  return {
    "reports/monitor/morpho-liquidatable-startup.json": {
      json: buildCompletionArtifact(morphoCoverage(), [], new Date(generatedAt)),
      mtimeMs: Date.parse(generatedAt),
    },
    "reports/monitor/autopilot-disabled-routes.json": {
      json: validDisabledRoutes(generatedAt),
      mtimeMs: Date.parse(generatedAt),
    },
    "reports/monitor/research-watch-startup.done": {
      text: "completed",
      mtimeMs: Date.parse(generatedAt),
    },
  };
}

function statusFor(serviceId, artifactMap, nowMs = NOW) {
  return statusModule.buildServiceStatuses([], {
    nowMs,
    artifactMap,
    scriptExists: () => true,
  }).find((service) => service.id === serviceId);
}

test("the three startup artifacts declare a lifecycle window beyond 24 hours and stay scheduled/read-only", () => {
  for (const serviceId of STARTUP_SERVICE_IDS) {
    const service = specFor(serviceId);
    assert.equal(service.kind, "scheduled", serviceId);
    assert.equal(service.mode, "read-only", serviceId);
    assert.equal(service.artifact.freshnessMinutes, STARTUP_WINDOW_MINUTES, serviceId);
    assert.ok(service.artifact.freshnessMinutes > OLD_WINDOW_MINUTES, serviceId);
  }
  assert.equal(manifest.validateManifest(), true);
});

test("a 28.8 h-old startup artifact now passes the freshness dimension for all three services", () => {
  const artifacts = validStartupArtifacts(OLDER_THAN_A_DAY);
  for (const serviceId of STARTUP_SERVICE_IDS) {
    const row = statusFor(serviceId, artifacts);
    assert.equal(row.artifact.exists, true, serviceId);
    assert.equal(row.artifact.valid, true, serviceId);
    assert.equal(row.artifact.semanticValid, true, serviceId);
    assert.equal(row.artifact.maxAgeMinutes, STARTUP_WINDOW_MINUTES, serviceId);
    assert.ok(row.artifact.ageMinutes > OLD_WINDOW_MINUTES, `${serviceId} age ${row.artifact.ageMinutes}`);
    assert.equal(row.artifact.fresh, true, serviceId);
    assert.equal(row.artifact.acceptable, true, serviceId);
    assert.equal(row.readiness, "complete", serviceId);
  }
});

test("a missing startup artifact still fails every service", () => {
  for (const serviceId of STARTUP_SERVICE_IDS) {
    const service = specFor(serviceId);
    const row = statusFor(serviceId, { [service.artifact.path]: { exists: false } });
    assert.equal(row.artifact.exists, false, serviceId);
    assert.equal(row.artifact.acceptable, false, serviceId);
    assert.equal(row.readiness, "pending-artifact", serviceId);
  }
});

test("a malformed startup artifact still fails every service", () => {
  const service = specFor("morpho-startup-scan");
  const disabled = specFor("disabled-routes-report");
  const research = specFor("research-watch-build");

  const morpho = statusFor("morpho-startup-scan", {
    [service.artifact.path]: { json: { schemaVersion: 2, generatedAt: new Date(NOW - 60_000).toISOString() }, mtimeMs: NOW - 60_000 },
  });
  assert.equal(morpho.artifact.valid, false);
  assert.equal(morpho.artifact.acceptable, false);

  const disabledRow = statusFor("disabled-routes-report", {
    [disabled.artifact.path]: { json: { generatedAt: new Date(NOW - 60_000).toISOString(), scanner: "tools/autopilot-disabled-routes.js", summary: "not-an-object" }, mtimeMs: NOW - 60_000 },
  });
  assert.equal(disabledRow.artifact.valid, false);
  assert.equal(disabledRow.artifact.acceptable, false);

  // Right age, wrong marker text: the completion-marker validator must still reject it.
  const researchRow = statusFor("research-watch-build", {
    [research.artifact.path]: { text: "failed", mtimeMs: NOW - 60_000 },
  });
  assert.equal(researchRow.artifact.valid, false);
  assert.equal(researchRow.artifact.acceptable, false);
});
