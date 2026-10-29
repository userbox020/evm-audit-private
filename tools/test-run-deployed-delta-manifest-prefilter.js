#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");
const feedModule = require("./build-fresh-deployed-delta-candidate-feed-v1.js");
const scopeModule = require("./deployed-delta-sentinel-scope.js");
const scorerModule = require("./run-deployed-delta-source-risk-scorer.js");
const prefilter = require("./run-deployed-delta-manifest-prefilter.js");

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const sha40 = (number) => number.toString(16).padStart(40, "0");
const EXCLUDED_ID = sentinelModule.REPOSITORIES[0].id;
const EXCLUSION_SCOPE = Object.freeze({
  requiredPollStatuses: Object.freeze(["unchanged", "candidate-change"]),
  excludedIds: new Set([EXCLUDED_ID])
});

function sentinel(status = "unchanged", chainTextHints = ["137"]) {
  const generatedAt = new Date(NOW - 60_000).toISOString();
  const repositories = sentinelModule.REPOSITORIES.map((repository, index) => {
    const candidate = status === "candidate-change" && index === 0;
    return {
      id: repository.id,
      officialUrl: repository.officialUrl,
      defaultBranch: "main",
      sourceClass: repository.sourceClass,
      observedHeadSha: sha40(index + 101),
      previousHeadSha: sha40(index + 1),
      releaseIds: [],
      tags: [],
      configuredManifestPaths: [...sentinelModule.MANIFEST_PREFIXES],
      changedManifestPaths: candidate ? ["contracts/Vault.sol", "deployments/137/Vault.json"] : [],
      changeHints: candidate ? ["implementation", "deployment-manifest", "oracle-config", "pause-unpause-config"] : [],
      chainTextHints: candidate ? [...chainTextHints] : [],
      evidenceUrls: [],
      etagByUrl: {},
      pollStatus: ["incomplete", "rate-limited"].includes(status) ? status : candidate ? "candidate-change" : "unchanged",
      observedAt: generatedAt
    };
  });
  return {
    schema: sentinelModule.SCHEMA,
    generatedAt,
    runId: "manifest-prefilter-test-run",
    status,
    baselineCreated: false,
    repositories
  };
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-prefilter-"));
  const monitor = path.join(root, "reports", "monitor");
  const sentinelPath = path.join(monitor, "official-deployed-delta-sentinel.json");
  const scorerPath = path.join(monitor, "deployed-delta-source-risk-scorer.json");
  const outputPath = path.join(monitor, "deployed-delta-manifest-prefilter.json");
  const feedDirectory = path.join(monitor, "fresh-deployed-delta-candidate-feed-runs");
  fs.mkdirSync(monitor, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, monitor, sentinelPath, scorerPath, outputPath, feedDirectory };
}

function writeSentinel(paths, value) {
  fs.writeFileSync(paths.sentinelPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function run(paths, value, scope) {
  writeSentinel(paths, value);
  fs.writeFileSync(paths.scorerPath, `${JSON.stringify(scorerModule.scoreSentinel(value, NOW), null, 2)}\n`);
  return prefilter.runAndPublish({
    sentinelPath: paths.sentinelPath,
    scorerPath: paths.scorerPath,
    outputPath: paths.outputPath,
    feedDirectory: paths.feedDirectory,
    fsImpl: fs,
    now: NOW,
    scope
  });
}

test("unchanged sentinel immutably publishes a matching empty feed and EMPTY summary", async (t) => {
  const paths = workspace(t);
  const input = sentinel("unchanged");
  const result = await run(paths, input);
  assert.equal(prefilter.validateArtifact(result.artifact), true);
  assert.equal(result.artifact.status, "EMPTY");
  assert.equal(result.artifact.diagnostics.failureCode, "NONE");
  assert.deepEqual(result.artifact.counts, {
    candidateRepositories: 0, resolvedRepositories: 0, unresolvedRepositories: 0, evidenceRows: 0
  });
  assert.equal(result.feed.status, "empty");
  assert.equal(result.feed.inputCommitments.sentinel, feedModule.sha256Canonical(input));
  assert.equal(result.artifact.scorerCommitment, feedModule.sha256Canonical(scorerModule.scoreSentinel(input, NOW)));
  assert.equal(result.artifact.feedId, result.feed.feedId);
  assert.deepEqual(fs.readdirSync(paths.feedDirectory), [`${result.feed.feedId}.json`]);
  assert.equal(prefilter.validateArtifact(JSON.parse(fs.readFileSync(paths.outputPath, "utf8"))), true);

  const repeated = await run(paths, input);
  assert.deepEqual(repeated, result);
  assert.deepEqual(fs.readdirSync(paths.feedDirectory), [`${result.feed.feedId}.json`]);
});

test("one unique allowed chain creates one incomplete unknown-only observation", async (t) => {
  const paths = workspace(t);
  const input = sentinel("candidate-change", ["137"]);
  const result = await run(paths, input);
  assert.equal(result.artifact.status, "INCOMPLETE");
  assert.equal(result.artifact.diagnostics.failureCode, "EVIDENCE_UNKNOWN");
  assert.deepEqual(result.artifact.counts, {
    candidateRepositories: 1, resolvedRepositories: 1, unresolvedRepositories: 0, evidenceRows: 1
  });
  assert.equal(result.feed.status, "incomplete");
  assert.equal(result.feed.observations.length, 1);
  const observation = result.feed.observations[0];
  assert.deepEqual(observation.delta.classes, ["config", "implementation", "oracle", "unpause"]);
  assert.deepEqual(observation.delta.affectedLocations, [
    { path: "contracts/Vault.sol", startLine: 1, endLine: 1, symbol: "path-level-change", side: "head" },
    { path: "deployments/137/Vault.json", startLine: 1, endLine: 1, symbol: "path-level-change", side: "head" }
  ]);
  assert.deepEqual(observation.stages, {
    sourceExact: "unknown", deploymentCurrent: "unknown", deploymentFinalized: "unknown",
    runtimeBound: "unknown", runtimeDeltaApplied: "unknown", fresh: "true",
    publicAccountingPath: "unknown", liquidExit: "unknown", novelty: "unknown"
  });
  assert.equal(observation.deploymentTriageEligible, "unknown");
  assert.equal(result.feed.candidates.length, 0);
  assert.doesNotMatch(JSON.stringify({ summary: result.artifact, feed: result.feed }), /(?:https?|wss?):\/\/|0x[0-9a-f]{40}|routePositive/i);
});

test("exact Aave Ink paths resolve chain 57073 even for a pre-fix sentinel row", async (t) => {
  const paths = workspace(t);
  const input = sentinel("candidate-change", []);
  const original = input.repositories[0];
  original.changedManifestPaths = [];
  original.changeHints = [];
  original.pollStatus = "unchanged";
  const aave = input.repositories.find((repository) => repository.id === "aave-dao/aave-address-book");
  aave.changedManifestPaths = ["src/AaveV3InkWhitelabel.sol", "src/ts/AaveV3InkWhitelabel.ts"];
  aave.changeHints = ["deployment-manifest", "release"];
  aave.chainTextHints = [];
  aave.pollStatus = "candidate-change";

  const result = await run(paths, input);
  assert.equal(result.artifact.diagnostics.failureCode, "EVIDENCE_UNKNOWN");
  assert.deepEqual(result.artifact.counts, {
    candidateRepositories: 1, resolvedRepositories: 1, unresolvedRepositories: 0, evidenceRows: 1
  });
  assert.equal(result.feed.observations[0].identity.chainId, "57073");
  assert.deepEqual(result.feed.observations[0].delta.affectedLocations.map((row) => row.path), aave.changedManifestPaths);

  const conflictingPaths = workspace(t);
  aave.chainTextHints = ["137"];
  const conflicting = await run(conflictingPaths, input);
  assert.equal(conflicting.feed, null);
  assert.equal(conflicting.artifact.diagnostics.failureCode, "IDENTITY_UNRESOLVED");
});

test("ambiguous or absent chain identity publishes no feed and an unresolved summary", async (t) => {
  for (const hints of [["100", "137"], []]) {
    const paths = workspace(t);
    const result = await run(paths, sentinel("candidate-change", hints));
    assert.equal(result.feed, null);
    assert.equal(result.artifact.status, "INCOMPLETE");
    assert.equal(result.artifact.feedId, null);
    assert.equal(result.artifact.diagnostics.failureCode, "IDENTITY_UNRESOLVED");
    assert.deepEqual(result.artifact.counts, {
      candidateRepositories: 1, resolvedRepositories: 0, unresolvedRepositories: 1, evidenceRows: 0
    });
    assert.equal(fs.existsSync(paths.feedDirectory), false);
  }
});

test("malformed, incomplete, and rate-limited sentinels reject before publication", async (t) => {
  for (const status of ["incomplete", "rate-limited"]) {
    const paths = workspace(t);
    writeSentinel(paths, sentinel(status));
    await assert.rejects(prefilter.runAndPublish({
      sentinelPath: paths.sentinelPath, scorerPath: paths.scorerPath,
      outputPath: paths.outputPath, feedDirectory: paths.feedDirectory, fsImpl: fs, now: NOW
    }), (error) => error && error.code === "SENTINEL_INVALID");
    assert.equal(fs.existsSync(paths.outputPath), false);
    assert.equal(fs.existsSync(paths.feedDirectory), false);
  }
  const paths = workspace(t);
  fs.writeFileSync(paths.sentinelPath, "{malformed\n");
  await assert.rejects(prefilter.runAndPublish({
    sentinelPath: paths.sentinelPath, scorerPath: paths.scorerPath,
    outputPath: paths.outputPath, feedDirectory: paths.feedDirectory, fsImpl: fs, now: NOW
  }), (error) => error && error.code === "SENTINEL_INVALID");
  assert.equal(fs.existsSync(paths.outputPath), false);
});

test("summary validator rejects forbidden output and inconsistent invariants", async (t) => {
  const paths = workspace(t);
  const { artifact } = await run(paths, sentinel("unchanged"));
  for (const leaked of ["https://bad.invalid/x", `0x${"a".repeat(40)}`, "private_key"]) {
    const changed = structuredClone(artifact);
    changed.diagnostics.failureCode = leaked;
    assert.equal(prefilter.validateArtifact(changed), false);
  }
  const inconsistent = structuredClone(artifact);
  inconsistent.counts.evidenceRows = 1;
  assert.equal(prefilter.validateArtifact(inconsistent), false);
});

test("identities and path aggregation are deterministic under path permutation", () => {
  const first = sentinel("candidate-change", ["137"]);
  const second = structuredClone(first);
  second.repositories[0].changedManifestPaths.reverse();
  const a = prefilter.buildEvidenceRows(first);
  const b = prefilter.buildEvidenceRows(second);
  assert.equal(a.evidence.length, 1);
  assert.deepEqual(a, b);
  assert.equal(feedModule.validateEvidenceRow(a.evidence[0]), true);
  assert.match(a.evidence[0].identity.targetCommitment, /^[0-9a-f]{64}$/);
  assert.equal(a.evidence[0].source.exact, "unknown");
  assert.equal(a.evidence[0].source.treeCommitment, null);
  assert.equal(a.evidence[0].deployment.pinCommitment, null);
  assert.equal(a.evidence[0].runtime.runtimeCommitment, null);
});

test("missing, invalid, or mismatched scorer rejects before prefilter publication", async (t) => {
  for (const mode of ["missing", "invalid", "mismatched"]) {
    const paths = workspace(t);
    const input = sentinel("candidate-change", ["137"]);
    writeSentinel(paths, input);
    if (mode === "invalid") fs.writeFileSync(paths.scorerPath, "{}\n");
    if (mode === "mismatched") fs.writeFileSync(paths.scorerPath, `${JSON.stringify(scorerModule.scoreSentinel(sentinel("unchanged"), NOW))}\n`);
    await assert.rejects(prefilter.runAndPublish({
      sentinelPath: paths.sentinelPath,
      scorerPath: paths.scorerPath,
      outputPath: paths.outputPath,
      feedDirectory: paths.feedDirectory,
      fsImpl: fs,
      now: NOW
    }), (error) => error && ["SCORER_MISSING", "SCORER_INVALID"].includes(error.code));
    assert.equal(fs.existsSync(paths.outputPath), false);
    assert.equal(fs.existsSync(paths.feedDirectory), false);
  }
});

test("only scorer-selected globally bounded paths are carried into unknown evidence", async (t) => {
  const paths = workspace(t);
  const input = sentinel("candidate-change", ["137"]);
  input.repositories[0].changedManifestPaths = Array.from({ length: 65 }, (_, index) =>
    `contracts/137/Vault${String(index).padStart(2, "0")}.sol`
  );
  const result = await run(paths, input);
  assert.equal(result.feed.observations.length, 1);
  const locations = result.feed.observations[0].delta.affectedLocations;
  assert.equal(locations.length, 64);
  assert.deepEqual(locations.map((row) => row.path), [...input.repositories[0].changedManifestPaths].sort().slice(0, 64));
  assert.equal(locations.some((row) => row.path.endsWith("Vault64.sol")), false);
  assert.equal("priority" in result.feed.observations[0], false);
  assert.ok(Object.values(result.feed.observations[0].stages).every((value) => value === "unknown" || value === "true"));
});

test("an incomplete sentinel failing only a declared exclusion proceeds to evidence and feed publication", async (t) => {
  const paths = workspace(t);
  const input = sentinel("unchanged", ["137"]);
  input.status = "incomplete";
  input.repositories[0].pollStatus = "incomplete";
  const candidateRepository = input.repositories[1];
  candidateRepository.pollStatus = "candidate-change";
  candidateRepository.changedManifestPaths = ["contracts/Vault.sol", "deployments/137/Vault.json"];
  candidateRepository.changeHints = ["implementation", "deployment-manifest"];
  candidateRepository.chainTextHints = ["137"];
  const result = await run(paths, input, EXCLUSION_SCOPE);
  assert.equal(result.artifact.status, "INCOMPLETE");
  assert.notEqual(result.feed, null);
  assert.equal(result.artifact.counts.evidenceRows > 0, true);
  assert.equal(prefilter.validateArtifact(result.artifact), true);
});

test("an incomplete sentinel failing an in-scope repository still rejects before publication", async (t) => {
  const paths = workspace(t);
  const input = sentinel("unchanged", ["137"]);
  input.status = "incomplete";
  input.repositories[0].pollStatus = "incomplete";
  input.repositories[1].pollStatus = "incomplete";
  await assert.rejects(run(paths, input, EXCLUSION_SCOPE), (error) => error && error.code === "SENTINEL_INVALID");
  assert.equal(fs.existsSync(paths.outputPath), false);
});
