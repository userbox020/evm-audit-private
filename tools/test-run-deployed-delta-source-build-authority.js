#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const authority = require("./run-deployed-delta-source-build-authority.js");

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const UPSTREAM_EXTRACTOR = "1".repeat(64);
const UPSTREAM_RECORD_A = "2".repeat(64);
const UPSTREAM_RECORD_B = "3".repeat(64);
const commitment = (number) => number.toString(16).padStart(64, "0");

function record(overrides = {}) {
  return {
    upstreamExtractorCommitment: UPSTREAM_EXTRACTOR,
    upstreamRecordCommitment: UPSTREAM_RECORD_A,
    sourceCommitment: commitment(10),
    blobCommitment: commitment(11),
    declarationCommitment: commitment(12),
    compilerSettingsCommitment: commitment(13),
    standardInputCommitment: commitment(14),
    buildRuntimeCommitment: commitment(15),
    upstreamMetadataCommitment: commitment(16),
    topology: "DIRECT",
    ...overrides
  };
}
function resolve(records, extra = {}) {
  return authority.resolveBatch({
    records,
    upstreamExtractorCommitment: UPSTREAM_EXTRACTOR,
    now: NOW,
    ...extra
  });
}
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-build-authority-"));
  const outputPath = path.join(root, "reports", "monitor", "deployed-delta-source-build-authority.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, outputPath };
}

test("complete pinned authority produces one commitment-only EXACT result", () => {
  const artifact = resolve([record()]);
  assert.equal(authority.validateArtifact(artifact), true);
  assert.deepEqual(artifact.counts, { exact: 1, unknown: 0 });
  assert.deepEqual(Object.keys(artifact.rows[0]).sort(), [
    "authorityCommitment", "expectedBuildCommitment", "expectedRuntimeCommitment", "metadataCommitment",
    "status", "topology", "upstreamRecordCommitment"
  ].sort());
  assert.equal(artifact.rows[0].status, "EXACT");
  assert.equal(artifact.rows[0].topology, "DIRECT");
  assert.match(artifact.rows[0].expectedBuildCommitment, /^[0-9a-f]{64}$/);
  assert.equal(artifact.rows[0].expectedRuntimeCommitment, commitment(15));
  assert.equal(artifact.rows[0].metadataCommitment, commitment(16));
  assert.match(artifact.rows[0].authorityCommitment, /^[0-9a-f]{64}$/);

  const resolver = authority.expectedResolver(artifact);
  let addressReads = 0;
  const transient = { upstreamRecordCommitment: UPSTREAM_RECORD_A };
  Object.defineProperty(transient, "address", { get() { addressReads += 1; throw new Error("address read"); } });
  assert.deepEqual(resolver(transient), {
    topology: "DIRECT",
    expectedBuildCommitment: artifact.rows[0].expectedBuildCommitment,
    expectedRuntimeCommitment: artifact.rows[0].expectedRuntimeCommitment,
    metadataCommitment: artifact.rows[0].metadataCommitment,
    authorityCommitment: artifact.rows[0].authorityCommitment
  });
  assert.equal(addressReads, 0);
});

test("missing or incomplete exact input becomes UNKNOWN with no expectations", () => {
  const incomplete = record();
  delete incomplete.standardInputCommitment;
  const artifact = resolve([incomplete]);
  assert.deepEqual(artifact.counts, { exact: 0, unknown: 1 });
  assert.deepEqual(artifact.rows[0], {
    upstreamRecordCommitment: UPSTREAM_RECORD_A,
    expectedBuildCommitment: null,
    expectedRuntimeCommitment: null,
    metadataCommitment: null,
    topology: null,
    authorityCommitment: null,
    status: "UNKNOWN"
  });
  assert.equal(authority.expectedResolver(artifact)({ upstreamRecordCommitment: UPSTREAM_RECORD_A }), null);
});

test("duplicate upstream record authority collapses to one UNKNOWN row", () => {
  const artifact = resolve([record(), record({ topology: "EIP1967_PROXY" })]);
  assert.deepEqual(artifact.counts, { exact: 0, unknown: 1 });
  assert.equal(artifact.rows.length, 1);
  assert.equal(artifact.rows[0].upstreamRecordCommitment, UPSTREAM_RECORD_A);
  assert.equal(artifact.rows[0].status, "UNKNOWN");
});

test("upstream extractor mismatch becomes UNKNOWN", () => {
  const artifact = resolve([record({ upstreamExtractorCommitment: "f".repeat(64) })]);
  assert.deepEqual(artifact.counts, { exact: 0, unknown: 1 });
  assert.equal(artifact.rows[0].status, "UNKNOWN");
  assert.equal(artifact.rows[0].authorityCommitment, null);
});

test("record permutation preserves deterministic rows and batch commitment", () => {
  const first = record();
  const second = record({
    upstreamRecordCommitment: UPSTREAM_RECORD_B,
    sourceCommitment: commitment(20),
    blobCommitment: commitment(21),
    declarationCommitment: commitment(22),
    compilerSettingsCommitment: commitment(23),
    standardInputCommitment: commitment(24),
    buildRuntimeCommitment: commitment(25),
    topology: "EIP1967_PROXY"
  });
  const a = resolve([first, second]);
  const b = resolve([second, first]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.rows.map((row) => row.upstreamRecordCommitment), [UPSTREAM_RECORD_A, UPSTREAM_RECORD_B]);
});

test("forbidden source, target, URL, bytecode, ABI, and raw compiler inputs never persist", () => {
  const distinctiveAddress = `0x${"a".repeat(40)}`;
  const distinctiveUrl = "https://authority-secret.example.invalid/source";
  const distinctiveSource = "contract DistinctiveSourceSentinel {}";
  const forbiddenRecords = [
    record({ sourceText: distinctiveSource }),
    record({ upstreamRecordCommitment: UPSTREAM_RECORD_B, targetAddress: distinctiveAddress }),
    record({ upstreamRecordCommitment: "4".repeat(64), url: distinctiveUrl }),
    record({ upstreamRecordCommitment: "5".repeat(64), bytecode: "6000" }),
    record({ upstreamRecordCommitment: "6".repeat(64), abi: [] }),
    record({ upstreamRecordCommitment: "7".repeat(64), rawCompilerOutput: distinctiveSource })
  ];
  const artifact = resolve(forbiddenRecords);
  assert.deepEqual(artifact.counts, { exact: 0, unknown: 6 });
  const serialized = JSON.stringify(artifact);
  for (const forbidden of [distinctiveAddress, distinctiveAddress.slice(2), distinctiveUrl, distinctiveSource,
    "sourceText", "targetAddress", "bytecode", "rawCompilerOutput"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(authority.validateArtifact(artifact), true);
});

test("validator rejects leaks, extra fields, bad expectations, and tampered batch binding", () => {
  const artifact = resolve([record()]);
  const leaked = structuredClone(artifact);
  leaked.rows[0].url = "https://bad.invalid";
  assert.equal(authority.validateArtifact(leaked), false);
  const unknownWithExpectation = structuredClone(artifact);
  unknownWithExpectation.rows[0].status = "UNKNOWN";
  assert.equal(authority.validateArtifact(unknownWithExpectation), false);
  const tampered = structuredClone(artifact);
  tampered.upstreamExtractorCommitment = "e".repeat(64);
  assert.equal(authority.validateArtifact(tampered), false);
});

test("empty authority batch is safe and local-only", () => {
  const artifact = resolve([]);
  assert.deepEqual(artifact.rows, []);
  assert.deepEqual(artifact.counts, { exact: 0, unknown: 0 });
  assert.deepEqual(artifact.safety, {
    localOnly: true,
    networkAccess: false,
    rpcAccess: false,
    processExecution: false,
    forkUse: false,
    pnlEvaluation: false,
    signing: false,
    transactions: false,
    automaticExecution: false
  });
  assert.equal(authority.validateArtifact(artifact), true);
});

test("atomic publication and strict readback are exact", (t) => {
  const paths = workspace(t);
  const artifact = authority.runAndPublish({
    records: [record()], upstreamExtractorCommitment: UPSTREAM_EXTRACTOR,
    now: NOW, outputPath: paths.outputPath, fsImpl: fs
  });
  const bytes = fs.readFileSync(paths.outputPath);
  assert.equal(bytes.toString("utf8"), `${JSON.stringify(artifact, null, 2)}\n`);
  assert.equal(authority.validateArtifact(JSON.parse(bytes.toString("utf8"))), true);
  assert.equal(fs.readdirSync(path.dirname(paths.outputPath)).some((name) => name.includes(".tmp")), false);
});
