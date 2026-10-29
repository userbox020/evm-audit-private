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
const scorer = require("./run-deployed-delta-source-risk-scorer.js");

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const sha40 = (number) => number.toString(16).padStart(40, "0");
const EXCLUDED_ID = sentinelModule.REPOSITORIES[0].id;
const EXCLUSION_SCOPE = Object.freeze({
  requiredPollStatuses: Object.freeze(["unchanged", "candidate-change"]),
  excludedIds: new Set([EXCLUDED_ID])
});

function sentinel(status = "unchanged") {
  const generatedAt = new Date(NOW - 60_000).toISOString();
  return {
    schema: sentinelModule.SCHEMA,
    generatedAt,
    runId: "source-risk-scorer-test-run",
    status,
    baselineCreated: false,
    repositories: sentinelModule.REPOSITORIES.map((repository, index) => ({
      id: repository.id,
      officialUrl: repository.officialUrl,
      defaultBranch: "main",
      sourceClass: repository.sourceClass,
      observedHeadSha: sha40(index + 101),
      previousHeadSha: sha40(index + 1),
      releaseIds: [], tags: [],
      configuredManifestPaths: [...sentinelModule.MANIFEST_PREFIXES],
      changedManifestPaths: [], changeHints: [], chainTextHints: [], evidenceUrls: [], etagByUrl: {},
      pollStatus: ["incomplete", "rate-limited"].includes(status) ? status : "unchanged",
      observedAt: generatedAt
    }))
  };
}

function candidate(status = "candidate-change") {
  const value = sentinel(status);
  if (status === "candidate-change") {
    const fixtures = [
      { index: 0, paths: ["contracts/Misc.sol"], hints: ["unknown"] },
      { index: 1, paths: ["contracts/UpgradeProxy.sol"], hints: ["implementation"] },
      { index: 2, paths: ["contracts/OraclePrice.sol"], hints: ["oracle-config"] }
    ];
    for (const fixture of fixtures) {
      const repository = value.repositories[fixture.index];
      repository.changedManifestPaths = fixture.paths;
      repository.changeHints = fixture.hints;
      repository.pollStatus = "candidate-change";
    }
  }
  return value;
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-risk-scorer-"));
  const monitor = path.join(root, "reports", "monitor");
  const sentinelPath = path.join(monitor, "official-deployed-delta-sentinel.json");
  const outputPath = path.join(monitor, "deployed-delta-source-risk-scorer.json");
  fs.mkdirSync(monitor, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, monitor, sentinelPath, outputPath };
}

function run(paths, input) {
  fs.writeFileSync(paths.sentinelPath, `${JSON.stringify(input, null, 2)}\n`);
  return scorer.runAndPublish({ sentinelPath: paths.sentinelPath, outputPath: paths.outputPath, fsImpl: fs, now: NOW });
}

test("unchanged sentinel publishes strict EMPTY local-only summary", (t) => {
  const paths = workspace(t);
  const input = sentinel("unchanged");
  const artifact = run(paths, input);
  assert.equal(artifact.status, "EMPTY");
  assert.deepEqual(artifact.selected, []);
  assert.deepEqual(artifact.counts, {
    candidateRepositories: 0, candidatePaths: 0, selectedRepositories: 0, selectedPaths: 0
  });
  assert.equal(artifact.sentinelCommitment, feedModule.sha256Canonical(input));
  assert.equal(scorer.validateArtifact(artifact), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.outputPath, "utf8")), artifact);
  assert.deepEqual(artifact.safety, {
    localOnly: true, networkAccess: false, rpcAccess: false, forkUse: false, pnlEvaluation: false,
    signing: false, transactions: false, automaticExecution: false
  });
});

test("candidate classes and lexicographic priorities rank HIGH then MEDIUM then LOW", () => {
  const input = candidate();
  const artifact = scorer.scoreSentinel(input, NOW);
  assert.equal(scorer.validateArtifact(artifact), true);
  assert.equal(artifact.status, "INCOMPLETE");
  assert.deepEqual(artifact.selected.map((row) => row.priority), ["HIGH", "MEDIUM", "LOW"]);
  assert.deepEqual(artifact.selected.map((row) => row.classes), [
    ["oracle-price"], ["proxy-module"], ["other"]
  ]);
  assert.deepEqual(artifact.counts, {
    candidateRepositories: 3, candidatePaths: 3, selectedRepositories: 3, selectedPaths: 3
  });
  assert.doesNotMatch(JSON.stringify(artifact), /(?:https?|wss?):\/\/|0x[0-9a-f]{40}|sourceExact|runtimeBound|routePositive|accountingLoss|liquidity|profit|economics/i);
});

test("path token rules conservatively produce sorted unique classes", () => {
  const input = sentinel("candidate-change");
  const repository = input.repositories[0];
  repository.pollStatus = "candidate-change";
  repository.changedManifestPaths = [
    "contracts/ShareVault.sol", "contracts/LiquidationPrecision.sol", "contracts/QueueEpoch.sol",
    "contracts/AdapterModule.sol", "deployments/MarketPool.sol"
  ];
  repository.changeHints = ["pause-unpause-config"];
  const row = scorer.scoreSentinel(input, NOW).selected[0];
  assert.deepEqual(row.classes, [
    "liquidation-rounding", "new-market-unpause", "proxy-module", "queue-epoch", "share-accounting"
  ]);
  assert.equal(row.priority, "HIGH");
});

test("global selection is deterministically limited to 64 lexically sorted paths", () => {
  const input = sentinel("candidate-change");
  const repository = input.repositories[0];
  repository.pollStatus = "candidate-change";
  repository.changedManifestPaths = Array.from({ length: 70 }, (_, index) =>
    `contracts/Vault${String(69 - index).padStart(2, "0")}.sol`
  );
  repository.changeHints = ["implementation"];
  const first = scorer.scoreSentinel(input, NOW);
  const permuted = structuredClone(input);
  permuted.repositories[0].changedManifestPaths.reverse();
  const second = scorer.scoreSentinel(permuted, NOW);
  assert.equal(first.counts.candidatePaths, 70);
  assert.equal(first.counts.selectedPaths, 64);
  assert.equal(first.counts.selectedRepositories, 1);
  assert.deepEqual(first.selected, second.selected);
  assert.deepEqual(first.selected[0].selectedPaths, [...repository.changedManifestPaths].sort().slice(0, 64));
  assert.equal(scorer.validateArtifact(first), true);
});

test("candidate selection remains deterministic under path and hint permutations", () => {
  const first = candidate();
  first.repositories[2].changedManifestPaths.push("contracts/QueueEpoch.sol");
  first.repositories[2].changeHints.push("implementation");
  const second = structuredClone(first);
  second.repositories[2].changedManifestPaths.reverse();
  second.repositories[2].changeHints.reverse();
  const project = (artifact) => ({ status: artifact.status, selected: artifact.selected, counts: artifact.counts });
  assert.deepEqual(project(scorer.scoreSentinel(first, NOW)), project(scorer.scoreSentinel(second, NOW)));
});

test("malformed, stale, incomplete, and rate-limited sentinels fail before publication", (t) => {
  for (const mode of ["malformed", "stale", "incomplete", "rate-limited"]) {
    const paths = workspace(t);
    if (mode === "malformed") fs.writeFileSync(paths.sentinelPath, "{malformed\n");
    else {
      const input = candidate(mode);
      if (mode === "stale") {
        input.status = "unchanged";
        input.repositories.forEach((row) => { row.pollStatus = "unchanged"; row.changedManifestPaths = []; row.changeHints = []; });
        input.generatedAt = new Date(NOW - feedModule.SENTINEL_MAX_AGE_MS).toISOString();
        input.repositories.forEach((row) => { row.observedAt = input.generatedAt; });
      }
      fs.writeFileSync(paths.sentinelPath, `${JSON.stringify(input)}\n`);
    }
    assert.throws(() => scorer.runAndPublish({
      sentinelPath: paths.sentinelPath, outputPath: paths.outputPath, fsImpl: fs, now: NOW
    }), (error) => error && ["SENTINEL_INVALID", "SENTINEL_STALE"].includes(error.code));
    assert.equal(fs.existsSync(paths.outputPath), false);
  }
});

test("validator rejects leaks, extra fields, ordering, and count invariants", () => {
  const artifact = scorer.scoreSentinel(candidate(), NOW);
  const leaked = structuredClone(artifact);
  leaked.selected[0].selectedPaths[0] = "contracts/bad.example.com.sol";
  assert.equal(scorer.validateArtifact(leaked), false);
  const extra = structuredClone(artifact);
  extra.selected[0].score = 10;
  assert.equal(scorer.validateArtifact(extra), false);
  const reordered = structuredClone(artifact);
  reordered.selected.reverse();
  assert.equal(scorer.validateArtifact(reordered), false);
  const counts = structuredClone(artifact);
  counts.counts.selectedPaths += 1;
  assert.equal(scorer.validateArtifact(counts), false);
});

test("atomic publication readback remains strictly valid", (t) => {
  const paths = workspace(t);
  const artifact = run(paths, candidate());
  const bytes = fs.readFileSync(paths.outputPath);
  assert.equal(bytes.toString("utf8"), `${JSON.stringify(artifact, null, 2)}\n`);
  assert.equal(scorer.validateArtifact(JSON.parse(bytes.toString("utf8"))), true);
  assert.equal(fs.readdirSync(paths.monitor).some((name) => name.includes(".tmp")), false);
});

test("an incomplete sentinel failing only a declared exclusion is scored, not rejected", (t) => {
  const paths = workspace(t);
  const input = candidate("candidate-change");
  input.status = "incomplete";
  input.repositories[0].pollStatus = "incomplete";
  fs.writeFileSync(paths.sentinelPath, `${JSON.stringify(input)}\n`);
  const artifact = scorer.runAndPublish({
    sentinelPath: paths.sentinelPath, outputPath: paths.outputPath, fsImpl: fs, now: NOW, scope: EXCLUSION_SCOPE
  });
  assert.equal(artifact.status, "INCOMPLETE");
  assert.equal(artifact.selected.length > 0, true);
  assert.equal(fs.existsSync(paths.outputPath), true);
});

test("an incomplete sentinel failing an in-scope repository still fails closed", (t) => {
  const paths = workspace(t);
  const input = candidate("candidate-change");
  input.status = "incomplete";
  input.repositories[1].pollStatus = "incomplete";
  fs.writeFileSync(paths.sentinelPath, `${JSON.stringify(input)}\n`);
  assert.throws(() => scorer.runAndPublish({
    sentinelPath: paths.sentinelPath, outputPath: paths.outputPath, fsImpl: fs, now: NOW, scope: EXCLUSION_SCOPE
  }), (error) => error && error.code === "SENTINEL_INVALID");
  assert.equal(fs.existsSync(paths.outputPath), false);
});
