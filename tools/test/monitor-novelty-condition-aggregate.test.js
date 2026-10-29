"use strict";
// Regression tests for the condition-family health blind spot (2026-09-16).
//
// `cycleHealth.sourceSummary` aggregates only the monitor's coarse CYCLE source groups, so a whole
// condition family could be 0% healthy (the 11 novelty-pattern scanner artifacts) while the cycle
// still reported HEALTHY and `fresh-noveltyState` passed. These tests pin the fail-closed rule
// that every condition-level source aggregate must itself be healthy.

const test = require("node:test");
const assert = require("node:assert/strict");

const manifest = require("../monitor-service-manifest");
const statusModule = require("../autopilot-status");

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const RECENT = new Date(NOW - 60_000).toISOString();

const noveltyArtifactSpec = manifest.services.find((service) => service.id === "novelty-monitor").artifact;

function healthyCycleHealth() {
  return {
    status: "HEALTHY",
    complete: true,
    broadlyFailed: false,
    blind: false,
    sourceSummary: { total: 4, healthy: 4, failed: 0, unknown: 0 },
  };
}

function noveltyState(conditions, cycleHealth = healthyCycleHealth()) {
  return { lastRun: RECENT, lastBlock: {}, conditions, cycleHealth };
}

function noveltyPatterns(summary) {
  return { lastResult: { checkedAt: RECENT, scanned: 11, alerts: 0, sourceSummary: summary } };
}

test("a fully-failing condition family cannot validate as healthy", () => {
  const artifact = noveltyState({
    "novelty-patterns": noveltyPatterns({ total: 11, healthy: 0, failed: 11, unknown: 0 }),
  });
  assert.equal(statusModule.validateArtifactSemantics(noveltyArtifactSpec, artifact, null, NOW), false);
});

test("a healthy condition family still validates", () => {
  const artifact = noveltyState({
    "novelty-patterns": noveltyPatterns({ total: 11, healthy: 11, failed: 0, unknown: 0 }),
  });
  assert.equal(statusModule.validateArtifactSemantics(noveltyArtifactSpec, artifact, null, NOW), true);
});

test("a partially-failing condition family cannot validate as healthy", () => {
  const artifact = noveltyState({
    "novelty-patterns": noveltyPatterns({ total: 11, healthy: 7, failed: 4, unknown: 0 }),
  });
  assert.equal(statusModule.validateArtifactSemantics(noveltyArtifactSpec, artifact, null, NOW), false);
});

test("missing, malformed, empty, and unknown condition aggregates fail closed", () => {
  const cases = [
    ["missing aggregate", { "novelty-patterns": { lastResult: { checkedAt: RECENT } } }],
    ["missing condition entirely", {}],
    ["malformed aggregate", { "novelty-patterns": noveltyPatterns({ total: 11, healthy: "11", failed: 0, unknown: 0 }) }],
    ["empty aggregate", { "novelty-patterns": noveltyPatterns({ total: 0, healthy: 0, failed: 0, unknown: 0 }) }],
    ["unknown count present", { "novelty-patterns": noveltyPatterns({ total: 11, healthy: 11, failed: 0, unknown: 1 }) }],
    ["not an object", { "novelty-patterns": { lastResult: { sourceSummary: "11/11" } } }],
  ];
  for (const [label, conditions] of cases) {
    assert.equal(
      statusModule.validateArtifactSemantics(noveltyArtifactSpec, noveltyState(conditions), null, NOW),
      false,
      label,
    );
  }
});

test("an undeclared condition aggregate is still validated", () => {
  const artifact = noveltyState({
    "novelty-patterns": noveltyPatterns({ total: 11, healthy: 11, failed: 0, unknown: 0 }),
    "some-other-family": noveltyPatterns({ total: 3, healthy: 1, failed: 2, unknown: 0 }),
  });
  assert.equal(statusModule.validateArtifactSemantics(noveltyArtifactSpec, artifact, null, NOW), false);
});

test("a healthy condition family never rescues a failing cycle summary", () => {
  const artifact = noveltyState(
    { "novelty-patterns": noveltyPatterns({ total: 11, healthy: 11, failed: 0, unknown: 0 }) },
    { status: "FAILED", complete: true, broadlyFailed: true, blind: false, sourceSummary: { total: 4, healthy: 1, failed: 3, unknown: 0 } },
  );
  assert.equal(statusModule.validateArtifactSemantics(noveltyArtifactSpec, artifact, null, NOW), false);
});
