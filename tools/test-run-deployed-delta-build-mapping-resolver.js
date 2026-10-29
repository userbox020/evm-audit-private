#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const resolver = require("./run-deployed-delta-build-mapping-resolver.js");

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
const UPSTREAM_EXTRACTOR = "1".repeat(64);
const UPSTREAM_A = "2".repeat(64);
const UPSTREAM_B = "3".repeat(64);

function record(overrides = {}) {
  return {
    upstreamRecordCommitment: UPSTREAM_A,
    manifestBlobCommitment: "4".repeat(64),
    declarationCommitment: "5".repeat(64),
    pinnedCommitCommitment: "6".repeat(64),
    parsedMapping: {
      deployment: {
        buildInfoPath: "artifacts/build-info/fixture.json",
        sourceName: "contracts/Fixture.sol",
        contractName: "Fixture"
      }
    },
    ...overrides
  };
}
function resolve(records) {
  return resolver.resolveBatch({ records, upstreamExtractorCommitment: UPSTREAM_EXTRACTOR, now: NOW });
}
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-mapping-resolver-"));
  const outputPath = path.join(root, "reports", "monitor", "deployed-delta-build-mapping-resolver.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, outputPath };
}

test("one explicit official mapping produces commitment-only EXACT output and transient resolution", () => {
  const artifact = resolve([record()]);
  assert.equal(resolver.validateArtifact(artifact), true);
  assert.deepEqual(artifact.counts, { exact: 1, unknown: 0 });
  assert.deepEqual(Object.keys(artifact.rows[0]).sort(), [
    "contractSelectorCommitment", "mappingCommitment", "metadataPathCommitment", "reason",
    "sourceSelectorCommitment", "status", "upstreamRecordCommitment"
  ].sort());
  assert.equal(artifact.rows[0].status, "EXACT");
  assert.ok([artifact.rows[0].mappingCommitment, artifact.rows[0].metadataPathCommitment,
    artifact.rows[0].sourceSelectorCommitment, artifact.rows[0].contractSelectorCommitment]
    .every((value) => /^[0-9a-f]{64}$/.test(value)));

  let forbiddenReads = 0;
  const transient = { upstreamRecordCommitment: UPSTREAM_A };
  Object.defineProperty(transient, "address", { get() { forbiddenReads += 1; throw new Error("address read"); } });
  const detail = resolver.exactResolver(artifact)(transient);
  assert.deepEqual(detail, {
    metadataPath: "artifacts/build-info/fixture.json",
    sourceName: "contracts/Fixture.sol",
    contractName: "Fixture",
    mappingCommitment: artifact.rows[0].mappingCommitment,
    metadataPathCommitment: artifact.rows[0].metadataPathCommitment,
    sourceSelectorCommitment: artifact.rows[0].sourceSelectorCommitment,
    contractSelectorCommitment: artifact.rows[0].contractSelectorCommitment
  });
  assert.equal(forbiddenReads, 0);
  assert.equal(resolver.exactResolver(JSON.parse(JSON.stringify(artifact)))(transient), null);
});

test("missing, ambiguous, and malformed mappings are explicit UNKNOWN", () => {
  const cases = [
    [{ deployment: { address: `0x${"a".repeat(40)}` } }, "MAPPING_MISSING"],
    [{ buildInfo: "artifacts/one.json", nested: { build_info: "build-info/two.json" } }, "MAPPING_AMBIGUOUS"],
    [{ buildInfoPath: "../outside.json" }, "MAPPING_MALFORMED"],
    [{ buildInfo: "artifacts/one.json", sourceName: null }, "MAPPING_MALFORMED"],
    [{ BuildInfo: "artifacts/not-accepted.json" }, "MAPPING_MISSING"]
  ];
  for (const [parsedMapping, reason] of cases) {
    const artifact = resolve([record({ parsedMapping })]);
    assert.deepEqual(artifact.counts, { exact: 0, unknown: 1 });
    assert.deepEqual(artifact.rows[0], {
      upstreamRecordCommitment: UPSTREAM_A,
      mappingCommitment: null,
      metadataPathCommitment: null,
      sourceSelectorCommitment: null,
      contractSelectorCommitment: null,
      status: "UNKNOWN",
      reason
    });
  }
});

test("duplicate upstream records collapse to one ambiguous UNKNOWN", () => {
  const artifact = resolve([record(), record({ parsedMapping: { buildInfo: "deployments/other.json" } })]);
  assert.deepEqual(artifact.counts, { exact: 0, unknown: 1 });
  assert.equal(artifact.rows.length, 1);
  assert.equal(artifact.rows[0].reason, "MAPPING_AMBIGUOUS");
  assert.equal(resolver.exactResolver(artifact)({ upstreamRecordCommitment: UPSTREAM_A }), null);
});

test("record and object permutations preserve deterministic commitments", () => {
  const first = record();
  const second = record({
    upstreamRecordCommitment: UPSTREAM_B,
    manifestBlobCommitment: "7".repeat(64),
    declarationCommitment: "8".repeat(64),
    pinnedCommitCommitment: "9".repeat(64),
    parsedMapping: { wrapper: { contractName: "Other", build_info: "build-info/other.json", sourceName: "src/Other.sol" } }
  });
  const a = resolve([first, second]);
  const b = resolve([second, first]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.rows.map((row) => row.upstreamRecordCommitment), [UPSTREAM_A, UPSTREAM_B]);
  assert.deepEqual(a.counts, { exact: 2, unknown: 0 });
});

test("raw path, selectors, address, URL, and source never persist", () => {
  const distinctivePath = "deployments/private-build-sentinel.json";
  const distinctiveSource = "src/DistinctiveSourceSentinel.sol";
  const distinctiveContract = "DistinctiveContractSentinel";
  const distinctiveAddress = `0x${"b".repeat(40)}`;
  const distinctiveUrl = "https://mapping-secret.example.invalid/build";
  const artifact = resolve([record({ parsedMapping: {
    address: distinctiveAddress,
    documentation: distinctiveUrl,
    sourceText: "contract RawSourceSentinel {}",
    mapping: { buildInfo: distinctivePath, sourceName: distinctiveSource, contractName: distinctiveContract }
  } })]);
  const serialized = JSON.stringify(artifact);
  for (const forbidden of [distinctivePath, distinctiveSource, distinctiveContract, distinctiveAddress,
    distinctiveAddress.slice(2), distinctiveUrl, "RawSourceSentinel", "buildInfo"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(resolver.validateArtifact(artifact), true);
});

test("empty output is safe and atomic publication is exact", (t) => {
  const empty = resolve([]);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.counts, { exact: 0, unknown: 0 });
  assert.deepEqual(empty.safety, {
    localOnly: true, networkAccess: false, rpcAccess: false, processExecution: false, forkUse: false,
    pnlEvaluation: false, signing: false, transactions: false, automaticExecution: false
  });
  const paths = workspace(t);
  const artifact = resolver.runAndPublish({
    records: [record()], upstreamExtractorCommitment: UPSTREAM_EXTRACTOR,
    now: NOW, outputPath: paths.outputPath, fsImpl: fs
  });
  const bytes = fs.readFileSync(paths.outputPath);
  assert.equal(bytes.toString("utf8"), `${JSON.stringify(artifact, null, 2)}\n`);
  assert.equal(resolver.validateArtifact(JSON.parse(bytes.toString("utf8"))), true);
  assert.equal(fs.readdirSync(path.dirname(paths.outputPath)).some((name) => name.includes(".tmp")), false);
});
