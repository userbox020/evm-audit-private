#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const metadata = require("./run-deployed-delta-pinned-build-metadata.js");

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
const UPSTREAM_EXTRACTOR = "1".repeat(64);
const UPSTREAM_RECORD_A = "2".repeat(64);
const UPSTREAM_RECORD_B = "3".repeat(64);
const PINNED_COMMIT = "4".repeat(40);
const METADATA_PATH = "artifacts/build-info/pinned.json";

function buildInfo(overrides = {}) {
  return {
    _format: "hh-sol-build-info-1",
    id: "local-fixture",
    solcVersion: "0.8.24",
    solcLongVersion: "0.8.24+commit.e11b9ed9",
    input: {
      language: "Solidity",
      sources: { "contracts/Fixture.sol": { content: "contract Fixture { }" } },
      settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["evm.deployedBytecode"] } } }
    },
    output: {
      contracts: {
        "contracts/Fixture.sol": {
          Fixture: { evm: { deployedBytecode: { object: "6001600055" } } }
        }
      },
      sources: {}
    },
    ...overrides
  };
}
function bytesFor(value = buildInfo()) { return Buffer.from(JSON.stringify(value), "utf8"); }
function record(bytes, overrides = {}) {
  return {
    repositoryId: "official/project",
    metadataPath: METADATA_PATH,
    pinnedCommitSha: PINNED_COMMIT,
    upstreamExtractorCommitment: UPSTREAM_EXTRACTOR,
    upstreamRecordCommitment: UPSTREAM_RECORD_A,
    mappingCommitment: "7".repeat(64),
    metadataPathCommitment: "8".repeat(64),
    manifestBlobCommitment: "9".repeat(64),
    declarationCommitment: "5".repeat(64),
    sourceName: "contracts/Fixture.sol",
    contractName: "Fixture",
    ...overrides
  };
}
function contents(bytes, overrides = {}) {
  return {
    type: "file",
    path: METADATA_PATH,
    sha: metadata.gitBlobSha(bytes),
    size: bytes.length,
    encoding: "base64",
    content: bytes.toString("base64"),
    ...overrides
  };
}
function response(value) {
  return { status: 200, headers: { "content-type": "application/vnd.github+json" }, body: JSON.stringify(value) };
}
function extract(records, transport) {
  return metadata.extractBatch({ records, transport, now: NOW, upstreamExtractorCommitment: UPSTREAM_EXTRACTOR });
}
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-build-metadata-"));
  const outputPath = path.join(root, "reports", "monitor", "deployed-delta-pinned-build-metadata.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, outputPath };
}

test("strict immutable Contents fixture yields commitment-only EXACT metadata", async () => {
  const bytes = bytesFor();
  let requestUrl = null;
  const artifact = await extract([record(bytes)], async (url) => { requestUrl = url; return response(contents(bytes)); });
  assert.equal(requestUrl, metadata.contentsUrl(record(bytes)));
  assert.equal(metadata.validateArtifact(artifact), true);
  assert.equal(artifact.status, "EXACT");
  assert.deepEqual(artifact.counts, { exact: 1, unknown: 0 });
  assert.deepEqual(Object.keys(artifact.rows[0]).sort(), [
    "buildMetadataCommitment", "compilerMetadataCommitment", "compilerSettingsCommitment", "declarationCommitment",
    "deployedRuntimeCommitment", "manifestBlobCommitment", "mappingCommitment", "metadataBlobCommitment",
    "metadataPathCommitment", "reason", "standardInputCommitment", "status", "upstreamRecordCommitment"
  ].sort());
  assert.equal(artifact.rows[0].upstreamRecordCommitment, UPSTREAM_RECORD_A);
  assert.equal(artifact.rows[0].manifestBlobCommitment, "9".repeat(64));
  assert.equal(artifact.rows[0].metadataBlobCommitment, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(artifact.rows[0].manifestBlobCommitment, artifact.rows[0].metadataBlobCommitment);
  assert.equal(artifact.rows[0].mappingCommitment, "7".repeat(64));
  assert.equal(artifact.rows[0].metadataPathCommitment, "8".repeat(64));
  assert.equal(artifact.rows[0].declarationCommitment, "5".repeat(64));
  assert.ok(Object.values(artifact.rows[0]).filter((value) => typeof value === "string" && value.length === 64)
    .every((value) => /^[0-9a-f]{64}$/.test(value)));
  const serialized = JSON.stringify(artifact);
  for (const forbidden of ["contract Fixture", "6001600055", "official/project", METADATA_PATH, PINNED_COMMIT]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  const changedProvenance = await extract([record(bytes, {
    repositoryId: "official/other-project", pinnedCommitSha: "d".repeat(40)
  })], async () => response(contents(bytes)));
  assert.equal(changedProvenance.rows[0].metadataBlobCommitment, artifact.rows[0].metadataBlobCommitment);
  assert.notEqual(changedProvenance.rows[0].buildMetadataCommitment, artifact.rows[0].buildMetadataCommitment);
  assert.deepEqual(metadata.exactResolver(artifact)({ upstreamRecordCommitment: UPSTREAM_RECORD_A }), {
    buildMetadataCommitment: artifact.rows[0].buildMetadataCommitment,
    metadataBlobCommitment: artifact.rows[0].metadataBlobCommitment,
    compilerMetadataCommitment: artifact.rows[0].compilerMetadataCommitment,
    compilerSettingsCommitment: artifact.rows[0].compilerSettingsCommitment,
    standardInputCommitment: artifact.rows[0].standardInputCommitment,
    deployedRuntimeCommitment: artifact.rows[0].deployedRuntimeCommitment
  });
});

test("missing, ambiguous, and malformed compiler metadata become UNKNOWN", async () => {
  const variants = [
    [buildInfo({ output: { contracts: {}, sources: {} } }), "METADATA_MISSING"],
    [buildInfo({ output: { contracts: {
      "contracts/Fixture.sol": {
        Fixture: { evm: { deployedBytecode: { object: "6001600055" } } },
        Other: { evm: { deployedBytecode: { object: "6002600055" } } }
      }
    }, sources: {} } }), "METADATA_MISSING"],
    [{ nope: true }, "METADATA_MALFORMED"]
  ];
  for (const [value, reason] of variants) {
    const bytes = bytesFor(value);
    const selector = reason === "METADATA_MISSING" && Object.keys(value.output.contracts).length > 0
      ? record(bytes, { sourceName: null, contractName: null }) : record(bytes);
    const artifact = await extract([selector], async () => response(contents(bytes)));
    assert.equal(artifact.status, "INCOMPLETE");
    assert.equal(artifact.rows[0].status, "UNKNOWN");
    assert.equal(artifact.rows[0].reason, reason === "METADATA_MISSING" && selector.sourceName === null ? "METADATA_AMBIGUOUS" : reason);
    assert.equal(artifact.rows[0].metadataBlobCommitment, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.equal(artifact.rows[0].buildMetadataCommitment, null);
  }
});

test("malformed Contents, base64, Git blob hash, and invalid mapping provenance fail closed", async () => {
  const bytes = bytesFor();
  const cases = [
    [contents(bytes, { content: "not base64!" }), "BASE64_INVALID"],
    [contents(bytes, { sha: "0".repeat(40) }), "GIT_BLOB_MISMATCH"],
    [contents(bytes, { unexpected: true }), "CONTENT_INVALID"]
  ];
  for (const [body, code] of cases) {
    await assert.rejects(extract([record(bytes)], async () => response(body)),
      (error) => error instanceof metadata.MetadataError && error.code === code);
  }
  await assert.rejects(extract([record(bytes, { mappingCommitment: null })], async () => response(contents(bytes))),
    (error) => error instanceof metadata.MetadataError && error.code === "RECORD_INVALID");
});

test("row ordering and commitments are deterministic without persisting source or runtime", async () => {
  const first = bytesFor();
  const second = bytesFor(buildInfo({ id: "other-fixture", input: {
    language: "Solidity", sources: { "contracts/Other.sol": { content: "contract Other {}" } }, settings: { optimizer: { enabled: false, runs: 0 } }
  }, output: { contracts: { "contracts/Other.sol": { Other: { evm: { deployedBytecode: { object: "6003" } } } } }, sources: {} } }));
  const recordA = record(first);
  const recordB = record(second, {
    upstreamRecordCommitment: UPSTREAM_RECORD_B, mappingCommitment: "a".repeat(64),
    metadataPathCommitment: "b".repeat(64), manifestBlobCommitment: "c".repeat(64),
    declarationCommitment: "6".repeat(64), sourceName: "contracts/Other.sol", contractName: "Other"
  });
  const byRecord = new Map([[UPSTREAM_RECORD_A, first], [UPSTREAM_RECORD_B, second]]);
  const transport = async (url) => {
    const bytes = url.includes("Other") ? second : first;
    return response(contents(bytes));
  };
  // Paths are immutable and equal here, so route responses by invocation order instead.
  let cursor = 0;
  const orderedTransport = async () => response(contents([first, second][cursor++]));
  const a = await extract([recordA, recordB], orderedTransport);
  cursor = 0;
  const b = await extract([recordB, recordA], orderedTransport);
  assert.deepEqual(a, b);
  assert.deepEqual(a.rows.map((row) => row.upstreamRecordCommitment), [UPSTREAM_RECORD_A, UPSTREAM_RECORD_B]);
  assert.doesNotMatch(JSON.stringify(a), /contract Other|6003|contracts\/Other\.sol/i);
  void byRecord; void transport;
});

test("empty batch is local-only and atomic publication has exact readback", async (t) => {
  const empty = await extract([], null);
  assert.equal(empty.status, "EMPTY");
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.safety, {
    localOnly: true, networkAccess: false, rpcAccess: false, processExecution: false, forkUse: false,
    pnlEvaluation: false, signing: false, transactions: false, automaticExecution: false
  });
  const paths = workspace(t);
  const bytes = bytesFor();
  const artifact = await metadata.runAndPublish({
    records: [record(bytes)], upstreamExtractorCommitment: UPSTREAM_EXTRACTOR, now: NOW,
    transport: async () => response(contents(bytes)), outputPath: paths.outputPath, fsImpl: fs
  });
  const written = fs.readFileSync(paths.outputPath);
  assert.equal(written.toString("utf8"), `${JSON.stringify(artifact, null, 2)}\n`);
  assert.equal(metadata.validateArtifact(JSON.parse(written.toString("utf8"))), true);
  assert.equal(fs.readdirSync(path.dirname(paths.outputPath)).some((name) => name.includes(".tmp")), false);
});
