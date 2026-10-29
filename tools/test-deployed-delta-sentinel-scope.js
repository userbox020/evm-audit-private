#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const scope = require("./deployed-delta-sentinel-scope.js");

function sentinel(rows, status = "unchanged") {
  return {
    schema: "official-deployed-delta-sentinel/v1",
    generatedAt: new Date(Date.UTC(2026, 8, 20, 12, 0, 0)).toISOString(),
    runId: "scope-test-run",
    status,
    baselineCreated: false,
    repositories: rows.map(([id, pollStatus]) => ({ id, pollStatus }))
  };
}

test("the binder config is the single source of truth for required statuses and exclusions", () => {
  const loaded = scope.loadSentinelScope();
  assert.deepEqual(loaded.requiredPollStatuses, ["unchanged", "candidate-change"]);
  assert.equal(loaded.excludedIds.has("Instadapp/fluid-contracts-public"), true);
  assert.equal(loaded.excluded.length, 1);
  assert.equal(typeof loaded.excluded[0].reason, "string");
  assert.ok(loaded.excluded[0].reason.length > 0);
});

test("an incomplete sentinel is accepted only when every failure is a declared exclusion", () => {
  const loaded = scope.loadSentinelScope();
  const accepted = scope.assessSentinelScope(sentinel([
    ["a/one", "unchanged"],
    ["b/two", "candidate-change"],
    ["Instadapp/fluid-contracts-public", "incomplete"]
  ], "incomplete"), loaded);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.effectiveStatus, "candidate-change");
  assert.deepEqual([...accepted.candidateChanges], ["b/two"]);
  assert.deepEqual(accepted.failedInScope, []);
  assert.deepEqual(accepted.failedExcluded.map((row) => row.id), ["Instadapp/fluid-contracts-public"]);

  const rejected = scope.assessSentinelScope(sentinel([
    ["a/one", "rate-limited"],
    ["Instadapp/fluid-contracts-public", "incomplete"]
  ], "rate-limited"), loaded);
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.failedInScope.map((row) => row.id), ["a/one"]);
});

test("effective status is unchanged when no in-scope repository changed", () => {
  const loaded = scope.loadSentinelScope();
  const assessment = scope.assessSentinelScope(sentinel([
    ["a/one", "unchanged"],
    ["Instadapp/fluid-contracts-public", "rate-limited"]
  ], "rate-limited"), loaded);
  assert.equal(assessment.ok, true);
  assert.equal(assessment.effectiveStatus, "unchanged");
  assert.deepEqual(assessment.candidateChanges, []);
});

test("malformed scopes and empty in-scope repository sets fail closed", () => {
  assert.throws(() => scope.normalizeSentinelScope({ schema: "not-the-binder-config" }), /SENTINEL_SCOPE_CONFIG_INVALID/);
  assert.throws(() => scope.normalizeSentinelScope({
    schema: "trigger-coverage-delta-binders/v1",
    sentinelScope: { requiredPollStatuses: ["bogus"], excludedRepositories: [] }
  }), /SENTINEL_SCOPE_REQUIRED_INVALID/);
  assert.throws(() => scope.normalizeSentinelScope({
    schema: "trigger-coverage-delta-binders/v1",
    sentinelScope: { requiredPollStatuses: ["unchanged"], excludedRepositories: [{ id: "bad id", reason: "x" }] }
  }), /SENTINEL_SCOPE_EXCLUSION_INVALID/);
  const realScope = scope.loadSentinelScope();
  assert.throws(() => scope.assessSentinelScope(sentinel([["Instadapp/fluid-contracts-public", "incomplete"]]), realScope), /SENTINEL_SCOPE_EMPTY/);
});
