#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");
const feeder = require("./build-fresh-deployed-delta-candidate-feed-v1.js");
const ranker = require("./run-deployed-delta-profit-ranker.js");

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const EXCLUDED_ID = sentinelModule.REPOSITORIES[0].id;
const EXCLUSION_SCOPE = Object.freeze({
  requiredPollStatuses: Object.freeze(["unchanged", "candidate-change"]),
  excludedIds: new Set([EXCLUDED_ID])
});
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const sha40 = (value) => value.toString(16).padStart(40, "0");
const sha64 = (value) => value.toString(16).padStart(64, "0");
const reference = (id, value) => ({ kind: "attestation", id, sha256: sha64(value) });

function sentinel(status = "candidate-change") {
  return {
    schema: sentinelModule.SCHEMA,
    generatedAt: iso(-60_000),
    runId: "ranker-sentinel-1",
    status,
    baselineCreated: false,
    repositories: sentinelModule.REPOSITORIES.map((repository, index) => ({
      id: repository.id,
      officialUrl: repository.officialUrl,
      defaultBranch: "main",
      sourceClass: repository.sourceClass,
      observedHeadSha: sha40(index + 101),
      previousHeadSha: sha40(index + 1),
      releaseIds: [],
      tags: [],
      configuredManifestPaths: [...sentinelModule.MANIFEST_PREFIXES],
      changedManifestPaths: index === 0 ? ["contracts/Vault.sol"] : [],
      changeHints: index === 0 ? ["implementation"] : [],
      chainTextHints: [],
      evidenceUrls: [],
      etagByUrl: {},
      pollStatus: status === "incomplete" || status === "rate-limited" ? status : index === 0 ? "candidate-change" : "unchanged",
      observedAt: iso(-60_000)
    }))
  };
}
function evidence(sent, index = 1, route = "true") {
  const repository = sent.repositories[0];
  return {
    schema: feeder.EVIDENCE_SCHEMA,
    evidenceId: `evidence-${index}`,
    deltaId: `delta-${index}`,
    observedAt: iso(-30_000),
    expiresAt: iso(60 * 60 * 1000),
    sentinelBinding: {
      runId: sent.runId,
      repositoryId: repository.id,
      previousHeadSha: repository.previousHeadSha,
      observedHeadSha: repository.observedHeadSha
    },
    identity: { protocol: `protocol-${index}`, chainId: "1", targetCommitment: sha64(500 + index) },
    delta: {
      classes: ["implementation"],
      affectedLocations: [{ path: "contracts/Vault.sol", startLine: index, endLine: index + 1, symbol: `Vault.apply${index}`, side: "head" }]
    },
    source: { exact: "true", commit: repository.observedHeadSha, treeCommitment: sha64(600 + index), references: [reference(`source-${index}`, 10 + index)] },
    deployment: { current: "true", finalized: "true", pinCommitment: sha64(700 + index), references: [reference(`deployment-${index}`, 20 + index)] },
    runtime: { bound: "true", deltaApplied: "true", runtimeCommitment: sha64(800 + index), references: [reference(`runtime-${index}`, 30 + index)] },
    route: { publicAccountingPath: route, liquidExit: route, references: [reference(`route-${index}`, 40 + index)] },
    novelty: { status: "true", references: [reference(`novelty-${index}`, 50 + index)] }
  };
}
function suppression() {
  return {
    schema: feeder.SUPPRESSION_SCHEMA,
    indexId: "ranker-suppression",
    generatedAt: iso(-60_000),
    expiresAt: iso(2 * 60 * 60 * 1000),
    entries: []
  };
}
function feed(sent = sentinel(), count = 1, route = "true") {
  const rows = Array.from({ length: count }, (_, index) => evidence(sent, index + 1, route));
  return feeder.buildFeed({ sentinel: sent, evidence: rows, suppression: suppression(), now: NOW });
}
function gates(value = "true") {
  return Object.fromEntries(ranker.ATTESTATION_GATE_KEYS.map((key) => [key, value]));
}
function attestations(value, gateFactory = () => gates()) {
  return {
    schema: ranker.ROUTE_ATTESTATION_SCHEMA,
    generatedAt: iso(-10_000),
    expiresAt: iso(30 * 60 * 1000),
    feedId: value.feedId,
    rows: value.candidates.map((candidate, index) => ({
      candidateId: candidate.candidateId,
      gates: gateFactory(candidate, index),
      references: [reference(`profit-route-${index + 1}`, 100 + index)]
    })).sort((a, b) => a.candidateId.localeCompare(b.candidateId))
  };
}
function reseal(value) {
  const body = {};
  for (const [key, child] of Object.entries(value)) if (key !== "feedId") body[key] = child;
  value.feedId = feeder.sha256Canonical(body);
  return value;
}
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deployed-delta-ranker-"));
  fs.mkdirSync(path.join(root, "reports", "monitor", "fresh-deployed-delta-candidate-feed-runs"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function paths(root) {
  const monitor = path.join(root, "reports", "monitor");
  return {
    sentinelPath: path.join(monitor, "official-deployed-delta-sentinel.json"),
    feedDirectory: path.join(monitor, "fresh-deployed-delta-candidate-feed-runs"),
    attestationPath: path.join(monitor, "deployed-delta-profit-route-attestations.json"),
    outputPath: path.join(monitor, "deployed-delta-profit-ranker.json")
  };
}
function writeInputs(root, sent, value, attest = undefined) {
  const names = paths(root);
  fs.writeFileSync(names.sentinelPath, `${JSON.stringify(sent)}\n`);
  if (value) fs.writeFileSync(path.join(names.feedDirectory, `${value.feedId}.json`), `${JSON.stringify(value)}\n`);
  if (attest !== undefined) fs.writeFileSync(names.attestationPath, typeof attest === "string" ? attest : `${JSON.stringify(attest)}\n`);
  return names;
}

test("READY requires all ten gates and emits exact deterministic rows", () => {
  const sent = sentinel();
  const value = feed(sent, 2);
  const artifact = ranker.rank({ sentinel: sent, feed: value, attestations: attestations(value), now: NOW });
  assert.equal(artifact.status, "READY");
  assert.deepEqual(artifact.trigger, { status: "READY", positive: true, reason: "QUALIFYING_CANDIDATE_READY" });
  assert.equal(artifact.ranked.length, 2);
  assert.deepEqual(artifact.ranked.map((row) => row.candidateId), [...value.candidates.map((row) => row.candidateId)].sort());
  assert.ok(artifact.ranked.every((row) => row.blockers.length === 0 && Object.values(row.gates).every((gate) => gate === "true")));
  assert.equal(ranker.validateArtifact(artifact), true);
});

test("an explicit false gate per candidate produces schema-valid EMPTY", () => {
  const sent = sentinel(), value = feed(sent, 2);
  const attested = attestations(value, (_candidate, index) => ({ ...gates(), [index ? "publicLoss" : "permissionless"]: "false" }));
  const artifact = ranker.rank({ sentinel: sent, feed: value, attestations: attested, now: NOW });
  assert.equal(artifact.status, "EMPTY");
  assert.equal(artifact.counts.rankedCandidates, 0);
  assert.equal(artifact.diagnostics.failureCode, "NONE");
  assert.equal(ranker.validateArtifact(artifact), true);
});

test("unknown or missing controlling attestations produce INCOMPLETE", () => {
  const sent = sentinel(), value = feed(sent);
  const unknown = attestations(value, () => ({ ...gates(), economicsComplete: "unknown" }));
  assert.equal(ranker.rank({ sentinel: sent, feed: value, attestations: unknown, now: NOW }).diagnostics.failureCode, "EVIDENCE_UNKNOWN");
  const missing = attestations(value);
  missing.rows = [];
  const artifact = ranker.rank({ sentinel: sent, feed: value, attestations: missing, now: NOW });
  assert.equal(artifact.status, "INCOMPLETE");
  assert.equal(artifact.diagnostics.failureCode, "ATTESTATION_MISSING");
});

test("unknown feed route gates fail closed even with complete attestations", () => {
  const sent = sentinel(), value = feed(sent, 1, "unknown");
  const artifact = ranker.rank({ sentinel: sent, feed: value, attestations: attestations(value), now: NOW });
  assert.equal(artifact.status, "INCOMPLETE");
  assert.equal(artifact.diagnostics.failureCode, "EVIDENCE_UNKNOWN");
});

test("stale, malformed, and sentinel-mismatched feeds are INCOMPLETE", () => {
  const sent = sentinel(), current = feed(sent);
  const stale = structuredClone(current);
  stale.generatedAt = iso(-2 * 60 * 60 * 1000);
  stale.expiresAt = iso(-60 * 60 * 1000);
  reseal(stale);
  assert.equal(feeder.validateFeed(stale), true);
  assert.equal(ranker.rank({ sentinel: sent, feed: stale, attestations: attestations(stale), now: NOW }).diagnostics.failureCode, "FEED_STALE");
  const malformed = structuredClone(current);
  malformed.extra = true;
  assert.equal(ranker.rank({ sentinel: sent, feed: malformed, attestations: null, now: NOW }).diagnostics.failureCode, "FEED_INVALID");
  const mismatched = structuredClone(current);
  mismatched.inputCommitments.sentinel = sha64(9999);
  reseal(mismatched);
  assert.equal(ranker.rank({ sentinel: sent, feed: mismatched, attestations: attestations(mismatched), now: NOW }).diagnostics.failureCode, "FEED_MISMATCH");
});

test("stale, malformed, mismatched, and unsorted attestations are rejected", () => {
  const sent = sentinel(), value = feed(sent, 2);
  const stale = attestations(value);
  stale.generatedAt = iso(-2 * 60 * 60 * 1000);
  stale.expiresAt = iso(-1);
  assert.equal(ranker.validateAttestations(stale, { now: NOW }), false);
  assert.equal(ranker.rank({ sentinel: sent, feed: value, attestations: stale, now: NOW, attestationState: "STALE" }).diagnostics.failureCode, "ATTESTATION_STALE");
  const malformed = attestations(value);
  malformed.rows[0].gates.extra = "true";
  assert.equal(ranker.validateAttestations(malformed, { now: NOW }), false);
  const mismatch = attestations(value);
  mismatch.feedId = sha64(333);
  assert.equal(ranker.rank({ sentinel: sent, feed: value, attestations: mismatch, now: NOW }).diagnostics.failureCode, "ATTESTATION_MISMATCH");
  const unsorted = attestations(value);
  unsorted.rows.reverse();
  assert.equal(ranker.validateAttestations(unsorted, { now: NOW }), false);
});

test("an empty current feed needs no attestation and produces EMPTY", () => {
  const sent = sentinel(), value = feed(sent, 0);
  const artifact = ranker.rank({ sentinel: sent, feed: value, attestations: null, now: NOW, attestationState: "MISSING" });
  assert.equal(artifact.status, "EMPTY");
  assert.equal(artifact.diagnostics.attestationStatus, "NOT_REQUIRED");
});

test("disk discovery chooses newest matching feed and publishes stable output", (t) => {
  const root = temp(t), sent = sentinel(), older = feed(sent), newer = feed(sent, 2);
  older.generatedAt = iso(-20_000); reseal(older);
  newer.generatedAt = iso(-10_000); reseal(newer);
  const names = writeInputs(root, sent, older);
  fs.writeFileSync(path.join(names.feedDirectory, `${newer.feedId}.json`), JSON.stringify(newer));
  fs.writeFileSync(names.attestationPath, JSON.stringify(attestations(newer)));
  const artifact = ranker.runAndPublish({ ...names, now: NOW });
  assert.equal(artifact.status, "READY");
  assert.equal(artifact.counts.feedCandidates, 2);
  assert.equal(ranker.validateArtifact(JSON.parse(fs.readFileSync(names.outputPath, "utf8"))), true);
});

test("no matching feed and malformed present files publish INCOMPLETE without throwing", (t) => {
  const root = temp(t), sent = sentinel(), value = feed(sent);
  value.inputCommitments.sentinel = sha64(44); reseal(value);
  let names = writeInputs(root, sent, value);
  let artifact = ranker.runAndPublish({ ...names, now: NOW });
  assert.equal(artifact.diagnostics.failureCode, "FEED_MISMATCH");
  fs.rmSync(names.feedDirectory, { recursive: true, force: true });
  fs.mkdirSync(names.feedDirectory);
  fs.writeFileSync(path.join(names.feedDirectory, `${sha64(1)}.json`), "{bad\n");
  artifact = ranker.runAndPublish({ ...names, now: NOW });
  assert.equal(artifact.diagnostics.failureCode, "FEED_INVALID");
});

test("candidate-feed directory count and per-file size bounds fail closed", (t) => {
  const root = temp(t), sent = sentinel(), names = writeInputs(root, sent, null);
  for (let index = 0; index <= ranker.MAX_FILES; index += 1) fs.writeFileSync(path.join(names.feedDirectory, `${sha64(index + 1)}.json`), "{}\n");
  assert.equal(ranker.runAndPublish({ ...names, now: NOW }).diagnostics.failureCode, "FEED_INVALID");
  fs.rmSync(names.feedDirectory, { recursive: true, force: true });
  fs.mkdirSync(names.feedDirectory);
  fs.writeFileSync(path.join(names.feedDirectory, `${sha64(1)}.json`), Buffer.alloc(ranker.MAX_BYTES + 1));
  assert.equal(ranker.runAndPublish({ ...names, now: NOW }).diagnostics.failureCode, "FEED_INVALID");
});

test("leak guard rejects URLs, endpoint secrets, addresses, and transaction hashes", () => {
  const sent = sentinel(), value = feed(sent), artifact = ranker.rank({ sentinel: sent, feed: value, attestations: attestations(value), now: NOW });
  for (const leaked of ["https://example.invalid", "rpc_endpoint", `0x${"1".repeat(40)}`, `0x${"2".repeat(64)}`, "private_key"]) {
    const changed = structuredClone(artifact);
    changed.ranked[0].deltaId = leaked;
    assert.equal(ranker.validateArtifact(changed), false);
  }
});

test("atomic replace validates exact readback and removes temporary files", (t) => {
  const root = temp(t), sent = sentinel(), value = feed(sent);
  const artifact = ranker.rank({ sentinel: sent, feed: value, attestations: attestations(value), now: NOW });
  const outputPath = paths(root).outputPath;
  const events = [];
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from, to) => { events.push([from, to]); fs.renameSync(from, to); };
  ranker.publishAtomic(artifact, { outputPath, fsImpl });
  assert.equal(events.length, 1);
  assert.equal(events[0][1], outputPath);
  assert.equal(ranker.validateArtifact(JSON.parse(fs.readFileSync(outputPath, "utf8"))), true);
  assert.equal(fs.readdirSync(path.dirname(outputPath)).some((name) => name.endsWith(".tmp")), false);

  const corruptingFs = Object.create(fs);
  let renamed = false;
  corruptingFs.renameSync = (from, to) => { fs.renameSync(from, to); renamed = true; };
  corruptingFs.readFileSync = (filename, ...args) => renamed && path.resolve(filename) === path.resolve(outputPath)
    ? Buffer.from("{}\n") : fs.readFileSync(filename, ...args);
  assert.throws(() => ranker.publishAtomic(artifact, { outputPath, fsImpl: corruptingFs }), (error) => error.code === "READBACK_INVALID");
});

test("validator enforces exact fields, bounded output, and zero-argument CLI", async () => {
  const sent = sentinel(), value = feed(sent), artifact = ranker.rank({ sentinel: sent, feed: value, attestations: attestations(value), now: NOW });
  const changed = structuredClone(artifact);
  changed.extra = true;
  assert.equal(ranker.validateArtifact(changed), false);
  const original = process.exitCode;
  process.exitCode = undefined;
  await ranker.main(["--once"]);
  assert.equal(process.exitCode, 2);
  process.exitCode = original;
});

test("an incomplete sentinel failing only a declared exclusion passes the ranker sentinel gate", () => {
  const sent = sentinel("incomplete");
  for (const repository of sent.repositories) repository.pollStatus = "unchanged";
  sent.repositories[0].pollStatus = "incomplete";
  sent.repositories[1].pollStatus = "candidate-change";
  sent.repositories[1].changedManifestPaths = ["contracts/Vault.sol"];
  sent.repositories[1].changeHints = ["implementation"];
  const artifact = ranker.rank({
    sentinel: sent, feed: null, attestations: null, now: NOW, scope: EXCLUSION_SCOPE
  });
  assert.equal(artifact.diagnostics.failureCode, "FEED_MISSING");
  assert.notEqual(artifact.diagnostics.failureCode, "SENTINEL_INCOMPLETE");
});

test("an incomplete sentinel failing an in-scope repository is SENTINEL_INCOMPLETE", () => {
  const sent = sentinel("incomplete");
  for (const repository of sent.repositories) repository.pollStatus = "unchanged";
  sent.repositories[1].pollStatus = "incomplete";
  const artifact = ranker.rank({
    sentinel: sent, feed: null, attestations: null, now: NOW, scope: EXCLUSION_SCOPE
  });
  assert.equal(artifact.diagnostics.failureCode, "SENTINEL_INCOMPLETE");
  assert.equal(artifact.diagnostics.sentinelStatus, "INCOMPLETE");
});
