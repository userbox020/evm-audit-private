"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyNoveltyPatternArtifact,
  classifyForkArtifact,
} = require("../monitor-novelty-conditions");

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

test("stale E43 artifact with old CRITICAL rows becomes one INFO health event", () => {
  const event = classifyNoveltyPatternArtifact("precision-loss", {
    generatedAt: new Date(NOW - 25 * 3600_000).toISOString(),
    critical: [{ severity: "CRITICAL" }],
    high: [],
  }, NOW);

  assert.equal(event.severity, "INFO");
  assert.equal(event.sourceHealth, "STALE");
  assert.equal(event.autoExecutable, false);
  assert.equal(event.criticalCount, undefined);
});

test("fresh E43 count event carries source time, age, and execution prohibition", () => {
  const generatedAt = new Date(NOW - 10 * 60_000).toISOString();
  const event = classifyNoveltyPatternArtifact("precision-loss", {
    generatedAt,
    critical: [{ id: 1 }],
    high: [{ id: 2 }, { id: 3 }],
  }, NOW);

  assert.equal(event.severity, "CRITICAL");
  assert.equal(event.criticalCount, 1);
  assert.equal(event.highCount, 2);
  assert.equal(event.sourceGeneratedAt, generatedAt);
  assert.equal(event.sourceAgeMs, 10 * 60_000);
  assert.equal(event.autoExecutable, false);
});

test("fresh E23 positive evidence remains hard-stop evidence only", () => {
  const result = classifyForkArtifact({
    generatedAt: new Date(NOW - 5 * 60_000).toISOString(),
    status: "fork-positive",
    fork: { success: true, netProfitUsd: 1 },
  }, NOW);

  assert.equal(result.positive, true);
  assert.equal(result.fresh, true);
});
