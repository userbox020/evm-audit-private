#!/usr/bin/env node
"use strict";

// Shared reader for the official deployed-delta sentinel's declared scope.
//
// The single source of truth is `tools/trigger-coverage-delta-binders.json`
// (`sentinelScope.excludedRepositories` / `requiredPollStatuses`), the same config the
// trigger-coverage delta binder builder consumes. Downstream deployed-delta stages use
// this helper so an `incomplete`/`rate-limited` sentinel is accepted ONLY when every
// failing repository is a declared exclusion; any in-scope failure fails closed.

const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(__dirname, "trigger-coverage-delta-binders.json");
const CONFIG_SCHEMA = "trigger-coverage-delta-binders/v1";
const DEFAULT_REQUIRED_POLL_STATUSES = Object.freeze(["unchanged", "candidate-change"]);
const ALL_POLL_STATUSES = Object.freeze(["unchanged", "candidate-change", "incomplete", "rate-limited"]);
const REPO_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

class SentinelScopeError extends Error {
  constructor(code) { super(code); this.name = "SentinelScopeError"; this.code = code; }
}
function fail(code) { throw new SentinelScopeError(code); }
function ownObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function normalizeSentinelScope(config) {
  if (!ownObject(config) || config.schema !== CONFIG_SCHEMA || !ownObject(config.sentinelScope)) {
    fail("SENTINEL_SCOPE_CONFIG_INVALID");
  }
  const scope = config.sentinelScope;
  const required = scope.requiredPollStatuses;
  if (!Array.isArray(required) || required.length === 0
      || required.some((status) => !ALL_POLL_STATUSES.includes(status))
      || new Set(required).size !== required.length) fail("SENTINEL_SCOPE_REQUIRED_INVALID");
  if (!Array.isArray(scope.excludedRepositories)) fail("SENTINEL_SCOPE_EXCLUSIONS_INVALID");
  const excludedIds = new Set();
  const excluded = [];
  for (const entry of scope.excludedRepositories) {
    if (!ownObject(entry) || typeof entry.id !== "string" || !REPO_ID.test(entry.id)
        || typeof entry.reason !== "string" || !entry.reason.trim() || excludedIds.has(entry.id)) {
      fail("SENTINEL_SCOPE_EXCLUSION_INVALID");
    }
    excludedIds.add(entry.id);
    excluded.push(Object.freeze({ id: entry.id, reason: entry.reason }));
  }
  return Object.freeze({
    requiredPollStatuses: Object.freeze([...required]),
    required: new Set(required),
    excludedIds,
    excluded: Object.freeze(excluded),
  });
}

function loadSentinelScope(configPath = CONFIG_PATH) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (_) {
    fail("SENTINEL_SCOPE_CONFIG_INVALID");
  }
  return normalizeSentinelScope(config);
}

function resolveScope(scope, configPath) {
  return scope || loadSentinelScope(configPath);
}

function assessSentinelScope(sentinel, scope) {
  if (!ownObject(sentinel) || !Array.isArray(sentinel.repositories)) fail("SENTINEL_SCOPE_INPUT_INVALID");
  if (!ownObject(scope) || !Array.isArray(scope.requiredPollStatuses)) fail("SENTINEL_SCOPE_INPUT_INVALID");
  const required = scope.required || new Set(scope.requiredPollStatuses);
  const excludedIds = scope.excludedIds || new Set();
  const inScope = sentinel.repositories.filter((repository) => !excludedIds.has(repository.id));
  if (inScope.length === 0) fail("SENTINEL_SCOPE_EMPTY");
  const failedInScope = inScope
    .filter((repository) => !required.has(repository.pollStatus))
    .map((repository) => ({ id: repository.id, pollStatus: repository.pollStatus }));
  const failedExcluded = sentinel.repositories
    .filter((repository) => excludedIds.has(repository.id) && !required.has(repository.pollStatus))
    .map((repository) => ({ id: repository.id, pollStatus: repository.pollStatus }));
  const candidateChanges = inScope
    .filter((repository) => repository.pollStatus === "candidate-change")
    .map((repository) => repository.id)
    .sort();
  return Object.freeze({
    ok: failedInScope.length === 0,
    status: sentinel.status,
    effectiveStatus: candidateChanges.length > 0 ? "candidate-change" : "unchanged",
    inScopeCount: inScope.length,
    candidateChanges: Object.freeze(candidateChanges),
    failedInScope: Object.freeze(failedInScope.map(Object.freeze)),
    failedExcluded: Object.freeze(failedExcluded.map(Object.freeze)),
    excludedIds: Object.freeze([...excludedIds].sort()),
  });
}

module.exports = Object.freeze({
  WORKSPACE, CONFIG_PATH, CONFIG_SCHEMA,
  DEFAULT_REQUIRED_POLL_STATUSES, ALL_POLL_STATUSES,
  SentinelScopeError, normalizeSentinelScope, loadSentinelScope, resolveScope, assessSentinelScope,
});
