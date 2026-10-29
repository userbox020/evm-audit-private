#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");
const scorerModule = require("./run-deployed-delta-source-risk-scorer.js");
const extractorModule = require("./run-deployed-delta-manifest-extractor.js");
const prefilterModule = require("./run-deployed-delta-manifest-prefilter.js");
const gateModule = require("./run-deployed-delta-sealed-local-evidence-economics-gate.js");
const rankerModule = require("./run-deployed-delta-profit-ranker.js");

const NOW = Date.UTC(2026, 8, 20, 18, 35, 45);
const sha40 = (number) => number.toString(16).padStart(40, "0");
const EXCLUDED_ID = "Instadapp/fluid-contracts-public";
const AAVE_ID = "aave-dao/aave-address-book";
const CURVE_ID = "curvefi/curve-core";
const ETHERFI_ID = "etherfi-protocol/cash-v3";
const SCOPE = Object.freeze({
  requiredPollStatuses: Object.freeze(["unchanged", "candidate-change"]),
  excludedIds: new Set([EXCLUDED_ID])
});

function entry(repository, candidate, index) {
  const observedAt = new Date(NOW - 60_000).toISOString();
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
    changedManifestPaths: candidate ? [...candidate.changedManifestPaths] : [],
    changeHints: candidate ? [...candidate.changeHints] : [],
    chainTextHints: candidate ? [...candidate.chainTextHints] : [],
    evidenceUrls: [],
    etagByUrl: {},
    pollStatus: candidate ? "candidate-change" : repository.id === EXCLUDED_ID ? "incomplete" : "unchanged",
    observedAt
  };
}

function sentinel(candidates) {
  return {
    schema: sentinelModule.SCHEMA,
    generatedAt: new Date(NOW - 60_000).toISOString(),
    runId: "chain-resolution-test-run",
    status: "incomplete",
    baselineCreated: false,
    repositories: sentinelModule.REPOSITORIES.map((repository, index) => entry(repository, candidates[repository.id], index))
  };
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chain-resolution-"));
  const monitor = path.join(root, "reports", "monitor");
  fs.mkdirSync(monitor, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    monitor,
    sentinelPath: path.join(monitor, "sentinel.json"),
    scorerPath: path.join(monitor, "scorer.json"),
    extractorPath: path.join(monitor, "extractor.json"),
    mappingPath: path.join(monitor, "mapping.json"),
    metadataPath: path.join(monitor, "metadata.json"),
    authorityPath: path.join(monitor, "authority.json"),
    binderPath: path.join(monitor, "binder.json"),
    invariantPath: path.join(monitor, "invariant.json"),
    prefilterPath: path.join(monitor, "prefilter.json"),
    feedDirectory: path.join(monitor, "feed"),
    attestationPath: path.join(monitor, "attestations.json"),
    rankerPath: path.join(monitor, "ranker.json")
  };
}

function writeSentinel(paths, candidates) {
  const input = sentinel(candidates);
  fs.writeFileSync(paths.sentinelPath, `${JSON.stringify(input)}\n`);
  return input;
}

function score(paths) {
  return scorerModule.runAndPublish({
    sentinelPath: paths.sentinelPath, outputPath: paths.scorerPath, fsImpl: fs, now: NOW, scope: SCOPE
  });
}

async function runExtractor(paths, transport) {
  return extractorModule.runAndPublish({
    sentinelPath: paths.sentinelPath,
    scorerPath: paths.scorerPath,
    outputPath: paths.extractorPath,
    mappingOutputPath: paths.mappingPath,
    metadataOutputPath: paths.metadataPath,
    authorityOutputPath: paths.authorityPath,
    binderOutputPath: paths.binderPath,
    invariantOutputPath: paths.invariantPath,
    fsImpl: fs,
    now: NOW,
    scope: SCOPE,
    transport
  });
}

async function runPrefilter(paths) {
  return prefilterModule.runAndPublish({
    sentinelPath: paths.sentinelPath,
    scorerPath: paths.scorerPath,
    outputPath: paths.prefilterPath,
    feedDirectory: paths.feedDirectory,
    fsImpl: fs,
    now: NOW,
    scope: SCOPE
  });
}

test("Aave Ethereum deltas resolve to chain 1 and publish a feed the scheduler treats as PASS", async (t) => {
  const paths = workspace(t);
  writeSentinel(paths, {
    [AAVE_ID]: {
      changedManifestPaths: [
        "scripts/configs/v4/ethereum.ts", "src/AaveV4Ethereum.sol", "src/AaveV3XLayer.sol",
        "src/ts/AaveV3Ethereum.ts", "src/ts/AaveV3XLayer.ts", "src/ts/AaveV4Ethereum.ts"
      ],
      changeHints: ["deployment-manifest", "release"], chainTextHints: []
    },
    [CURVE_ID]: {
      changedManifestPaths: ["deployments/prod/arc.yaml", "deployments/prod/robinhood.yaml"],
      changeHints: ["deployment-manifest"], chainTextHints: []
    },
    [ETHERFI_ID]: {
      changedManifestPaths: ["scripts/gnosis-txs/ListDrvEnaUniNearEth3CP.s.sol"],
      changeHints: ["unknown"], chainTextHints: []
    }
  });

  const scorer = score(paths);
  assert.equal(scorer.status, "INCOMPLETE");
  assert.deepEqual(scorer.selected.map((row) => row.repositoryId).sort(), [AAVE_ID, CURVE_ID, ETHERFI_ID].sort());

  let transportCalls = 0;
  const extractor = await runExtractor(paths, async () => { transportCalls += 1; throw new Error("transport must not be used"); });
  assert.equal(transportCalls, 0);
  assert.deepEqual(extractor.counts, { selectedFiles: 0, fetchedFiles: 0, resolvedFiles: 0, unresolvedFiles: 0 });
  assert.equal(extractorModule.validateArtifact(extractor), true);

  const prefilter = await runPrefilter(paths);
  assert.equal(prefilter.artifact.status, "INCOMPLETE");
  assert.notEqual(prefilter.artifact.feedId, null);
  assert.equal(prefilter.artifact.counts.candidateRepositories, 3);
  assert.equal(prefilter.artifact.counts.resolvedRepositories, 1);
  assert.equal(prefilter.artifact.counts.unresolvedRepositories, 2);
  assert.equal(prefilter.artifact.counts.evidenceRows, 1);
  assert.equal(prefilterModule.validateArtifact(prefilter.artifact), true);
  assert.equal(prefilter.feed.counts.evidence, 1);
  assert.equal(prefilter.feed.observations.length, 1);
  assert.equal(prefilter.feed.observations[0].identity.chainId, "1");
  assert.equal(prefilter.feed.observations[0].identity.protocol, AAVE_ID);

  // Scheduler PASS condition: the gate's attestation is bound to the published feed even when no
  // sealed local economics evidence exists (empty rows, matching feedId).
  const attestations = gateModule.buildAttestations({
    now: NOW, feed: prefilter.feed, evidence: null, mapping: null, authority: null, binder: null
  });
  assert.equal(attestations.feedId, prefilter.feed.feedId);
  assert.equal(attestations.rows.length, 0);
  assert.equal(rankerModule.validateAttestations(attestations, { now: NOW }), true);
  gateModule.publishAtomic(attestations, { now: NOW, fsImpl: fs, outputPath: paths.attestationPath });

  const ranker = rankerModule.runAndPublish({
    sentinelPath: paths.sentinelPath,
    feedDirectory: paths.feedDirectory,
    attestationPath: paths.attestationPath,
    outputPath: paths.rankerPath,
    now: NOW,
    scope: SCOPE
  });
  assert.equal(rankerModule.validateArtifact(ranker), true);
  assert.equal(ranker.diagnostics.sentinelStatus, "VALID");
  assert.equal(ranker.diagnostics.failureCode, "FEED_INCOMPLETE");
});

test("candidates without a watched chain identity stay fail-closed and publish no feed", async (t) => {
  const paths = workspace(t);
  writeSentinel(paths, {
    [CURVE_ID]: {
      changedManifestPaths: ["deployments/prod/arc.yaml", "deployments/prod/robinhood.yaml"],
      changeHints: ["deployment-manifest"], chainTextHints: []
    },
    [ETHERFI_ID]: {
      changedManifestPaths: ["scripts/gnosis-txs/ListDrvEnaUniNearEth3CP.s.sol"],
      changeHints: ["unknown"], chainTextHints: []
    }
  });
  score(paths);
  const prefilter = await runPrefilter(paths);
  assert.equal(prefilter.artifact.status, "INCOMPLETE");
  assert.equal(prefilter.artifact.feedId, null);
  assert.equal(prefilter.artifact.diagnostics.failureCode, "IDENTITY_UNRESOLVED");
  assert.equal(prefilter.feed, null);
  assert.equal(prefilter.artifact.counts.evidenceRows, 0);
  assert.equal(prefilterModule.validateArtifact(prefilter.artifact), true);
});

test("a resolvable curve YAML manifest yields evidence but is never fetched by the extractor", async (t) => {
  const paths = workspace(t);
  writeSentinel(paths, {
    [CURVE_ID]: {
      changedManifestPaths: ["deployments/prod/avalanche.yaml"],
      changeHints: ["deployment-manifest"], chainTextHints: []
    }
  });
  const scorer = score(paths);
  assert.deepEqual(scorer.selected.map((row) => row.repositoryId), [CURVE_ID]);

  let transportCalls = 0;
  const extractor = await runExtractor(paths, async () => { transportCalls += 1; throw new Error("transport must not be used"); });
  assert.equal(transportCalls, 0);
  assert.equal(extractor.counts.selectedFiles, 0);

  const prefilter = await runPrefilter(paths);
  assert.notEqual(prefilter.artifact.feedId, null);
  assert.equal(prefilter.feed.counts.evidence, 1);
  assert.equal(prefilter.feed.observations[0].identity.chainId, "43114");
  assert.equal(prefilter.feed.observations[0].identity.protocol, CURVE_ID);
});
