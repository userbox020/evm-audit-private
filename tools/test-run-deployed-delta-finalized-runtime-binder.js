#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const binder = require("./run-deployed-delta-finalized-runtime-binder.js");

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const ADDRESS_A = `0x${"a".repeat(40)}`;
const ADDRESS_B = `0x${"b".repeat(40)}`;
const BUILD_A = "1".repeat(64);
const RUNTIME_A = "2".repeat(64);
const BUILD_B = "3".repeat(64);
const RUNTIME_B = "4".repeat(64);
const UPSTREAM_A = "5".repeat(64);
const UPSTREAM_B = "6".repeat(64);
const UPSTREAM_BATCH = "7".repeat(64);
const AUTHORITY_A = "8".repeat(64);
const AUTHORITY_B = "9".repeat(64);
const hash = (character) => `0x${character.repeat(64)}`;

function record(overrides = {}) {
  return {
    upstreamRecordCommitment: UPSTREAM_A,
    upstreamAuthorityCommitment: AUTHORITY_A,
    chainId: "137",
    address: ADDRESS_A,
    topology: "DIRECT",
    expectedBuildCommitment: BUILD_A,
    expectedRuntimeCommitment: RUNTIME_A,
    ...overrides
  };
}
function header(overrides = {}) {
  return {
    number: "12345678",
    hash: hash("5"),
    parentHash: hash("6"),
    stateRoot: hash("7"),
    timestamp: "1788091200",
    ...overrides
  };
}
function observation(family, overrides = {}) {
  const finalized = header(overrides.header || {});
  return {
    family,
    chainId: "137",
    header: finalized,
    terminalHeader: structuredClone(finalized),
    readBlockHash: finalized.hash,
    topology: "DIRECT",
    buildCommitment: BUILD_A,
    runtimeCommitment: RUNTIME_A,
    ...overrides,
    header: finalized,
    terminalHeader: overrides.terminalHeader || structuredClone(finalized)
  };
}
function families(overridesA = {}, overridesB = {}) {
  return [observation("operator-family-a", overridesA), observation("operator-family-b", overridesB)];
}
function bind(records, observations, extra = {}) {
  return binder.bindBatch({ records, observations, now: NOW, upstreamBatchCommitment: UPSTREAM_BATCH, ...extra });
}
function batch(options) { return binder.bindBatch({ upstreamBatchCommitment: UPSTREAM_BATCH, ...options }); }
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finalized-runtime-binder-"));
  const outputPath = path.join(root, "reports", "monitor", "deployed-delta-finalized-runtime-binder.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, outputPath };
}

test("two distinct stable finalized families produce PASS only on complete match", () => {
  const artifact = bind([record()], [families()]);
  assert.equal(binder.validateArtifact(artifact), true);
  assert.deepEqual(artifact.counts, { pass: 1, fail: 0, unknown: 0, blocked: 0 });
  assert.equal(artifact.bindings[0].status, "PASS");
  assert.equal(artifact.bindings[0].reason, "COMPLETE_MATCH");
  assert.equal(artifact.bindings[0].authorityCommitment, AUTHORITY_A);
  assert.equal(artifact.finalizedConsensusFamilyMinimum, 2);
});

test("one operator family remains UNKNOWN", () => {
  const artifact = bind([record()], [[observation("only-family")]]);
  assert.deepEqual(artifact.counts, { pass: 0, fail: 0, unknown: 1, blocked: 0 });
  assert.equal(artifact.bindings[0].reason, "INSUFFICIENT_FAMILIES");
});

test("full finalized header disagreement remains UNKNOWN", () => {
  const changed = header({ hash: hash("8") });
  const artifact = bind([record()], [[
    observation("family-a"),
    observation("family-b", { header: changed, terminalHeader: structuredClone(changed), readBlockHash: changed.hash })
  ]]);
  assert.equal(artifact.bindings[0].status, "UNKNOWN");
  assert.equal(artifact.bindings[0].reason, "FINALIZED_HEADER_DISAGREEMENT");
});

test("two-family corroborated build or runtime mismatch produces FAIL", () => {
  const mismatch = { buildCommitment: "9".repeat(64), runtimeCommitment: "8".repeat(64) };
  const artifact = bind([record()], [[observation("family-a", mismatch), observation("family-b", mismatch)]]);
  assert.deepEqual(artifact.counts, { pass: 0, fail: 1, unknown: 0, blocked: 0 });
  assert.equal(artifact.bindings[0].status, "FAIL");
  assert.equal(artifact.bindings[0].reason, "CORROBORATED_MISMATCH");
});

test("missing expected commitments remain UNKNOWN without qualification", () => {
  let calls = 0;
  const artifact = batch({
    records: [record({ expectedRuntimeCommitment: null })],
    qualifier: () => { calls += 1; return families(); },
    now: NOW
  });
  assert.equal(calls, 0);
  assert.equal(artifact.bindings[0].status, "UNKNOWN");
  assert.equal(artifact.bindings[0].reason, "EXPECTED_COMMITMENT_MISSING");
});

test("complete expectations without authority commitment remain strict UNKNOWN", () => {
  let calls = 0;
  const artifact = batch({
    records: [record({ upstreamAuthorityCommitment: null })],
    qualifier: () => { calls += 1; return families(); },
    now: NOW
  });
  assert.equal(calls, 0);
  assert.equal(artifact.bindings[0].status, "UNKNOWN");
  assert.equal(artifact.bindings[0].reason, "AUTHORITY_COMMITMENT_MISSING");
  assert.equal(artifact.bindings[0].authorityCommitment, null);
  assert.equal(binder.validateArtifact(artifact), true);
});

test("unsupported proxy topology remains UNKNOWN", () => {
  const artifact = bind([record({ topology: "CUSTOM_PROXY" })], [families(
    { topology: "CUSTOM_PROXY" }, { topology: "CUSTOM_PROXY" }
  )]);
  assert.equal(artifact.bindings[0].status, "UNKNOWN");
  assert.equal(artifact.bindings[0].reason, "TOPOLOGY_UNSUPPORTED");
});

test("invalid transient input and absent qualifier are BLOCKED", () => {
  const invalid = batch({ records: [{ address: ADDRESS_A }], observations: [[]], now: NOW });
  assert.equal(invalid.bindings[0].status, "BLOCKED");
  assert.equal(invalid.bindings[0].reason, "INPUT_INVALID");
  const absent = batch({ records: [record()], now: NOW });
  assert.equal(absent.bindings[0].status, "BLOCKED");
  assert.equal(absent.bindings[0].reason, "QUALIFIER_MISSING");
});

test("public input commitment binds upstream metadata but never the transient address", () => {
  const first = batch({ records: [record({ address: ADDRESS_A })], now: NOW });
  const second = batch({ records: [record({ address: ADDRESS_B })], now: NOW });
  const changedUpstream = batch({
    records: [record({ address: ADDRESS_A, upstreamRecordCommitment: UPSTREAM_B })],
    now: NOW
  });
  const changedAuthority = batch({
    records: [record({ address: ADDRESS_A, upstreamAuthorityCommitment: AUTHORITY_B })],
    now: NOW
  });
  assert.equal(first.bindings[0].inputCommitment, second.bindings[0].inputCommitment);
  assert.equal(first.inputBatchCommitment, second.inputBatchCommitment);
  assert.notEqual(first.bindings[0].inputCommitment, changedUpstream.bindings[0].inputCommitment);
  assert.notEqual(first.inputBatchCommitment, changedUpstream.inputBatchCommitment);
  assert.notEqual(first.bindings[0].inputCommitment, changedAuthority.bindings[0].inputCommitment);
  assert.notEqual(first.inputBatchCommitment, changedAuthority.inputBatchCommitment);

  let qualifiedAddress = null;
  const qualified = batch({
    records: [record({ address: ADDRESS_B })],
    qualifier: (transient) => { qualifiedAddress = transient.address; return families(); },
    now: NOW
  });
  assert.equal(qualifiedAddress, ADDRESS_B);
  assert.equal(qualified.bindings[0].status, "PASS");
});

test("duplicate upstream commitments are BLOCKED before qualification", () => {
  let calls = 0;
  const artifact = batch({
    records: [record({ address: ADDRESS_A }), record({ address: ADDRESS_B })],
    qualifier: () => { calls += 1; return families(); },
    now: NOW
  });
  assert.equal(calls, 0);
  assert.deepEqual(artifact.counts, { pass: 0, fail: 0, unknown: 0, blocked: 2 });
  assert.ok(artifact.bindings.every((binding) => binding.reason === "UPSTREAM_COMMITMENT_DUPLICATE"));
  assert.equal(binder.validateArtifact(artifact), true);
});

test("upstream batch commitment is required and binds both batch commitments", () => {
  const first = bind([record()], [families()]);
  const second = bind([record()], [families()], { upstreamBatchCommitment: "8".repeat(64) });
  assert.equal(first.upstreamBatchCommitment, UPSTREAM_BATCH);
  assert.notEqual(first.inputBatchCommitment, second.inputBatchCommitment);
  assert.notEqual(first.bindingBatchCommitment, second.bindingBatchCommitment);
  assert.throws(() => binder.bindBatch({ records: [], now: NOW }),
    (error) => error && error.code === "UPSTREAM_BATCH_COMMITMENT_INVALID");
  const tampered = structuredClone(first);
  tampered.upstreamBatchCommitment = "9".repeat(64);
  assert.equal(binder.validateArtifact(tampered), false);
});

test("unstable terminal reread, chain mismatch, canonical hash gap, and family disagreement stay UNKNOWN", () => {
  const cases = [
    [families({}, { terminalHeader: header({ timestamp: "1788091201" }) }), "TERMINAL_REREAD_UNSTABLE"],
    [families({}, { chainId: "1" }), "CHAIN_MISMATCH"],
    [families({}, { readBlockHash: hash("9") }), "CANONICAL_BLOCK_HASH_UNPROVEN"],
    [families({}, { runtimeCommitment: "9".repeat(64) }), "OBSERVATION_DISAGREEMENT"]
  ];
  for (const [observed, reason] of cases) {
    const artifact = bind([record()], [observed]);
    assert.equal(artifact.bindings[0].status, "UNKNOWN");
    assert.equal(artifact.bindings[0].reason, reason);
  }
});

test("distinctive transient address, URL, token, and source text never persist", () => {
  const distinctiveUrl = "https://provider-secret.example.invalid/rpc";
  const distinctiveTokenSource = "token_PRIVATE_source_text_SENTINEL";
  const artifact = batch({
    records: [record()],
    qualifier: () => [observation(distinctiveUrl), observation(distinctiveTokenSource)],
    now: NOW
  });
  const serialized = JSON.stringify(artifact);
  for (const forbidden of [ADDRESS_A, ADDRESS_A.slice(2), distinctiveUrl, distinctiveTokenSource, "provider-secret", "source_text_SENTINEL"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.doesNotMatch(serialized, /0x[0-9a-f]{40}|https?:\/\/|provider|endpoint|raw|sourceText/i);
  assert.equal(binder.validateArtifact(artifact), true);
});

test("record and family permutations preserve deterministic commitment-only output", () => {
  const firstRecord = record();
  const secondRecord = record({
    upstreamRecordCommitment: UPSTREAM_B,
    upstreamAuthorityCommitment: AUTHORITY_B,
    address: ADDRESS_B,
    chainId: "1",
    topology: "EIP1967_PROXY",
    expectedBuildCommitment: BUILD_B,
    expectedRuntimeCommitment: RUNTIME_B
  });
  const firstObserved = families();
  const secondObserved = [
    observation("second-b", {
      chainId: "1", topology: "EIP1967_PROXY", buildCommitment: BUILD_B, runtimeCommitment: RUNTIME_B
    }),
    observation("second-a", {
      chainId: "1", topology: "EIP1967_PROXY", buildCommitment: BUILD_B, runtimeCommitment: RUNTIME_B
    })
  ];
  const a = bind([firstRecord, secondRecord], [firstObserved, secondObserved]);
  const b = bind([secondRecord, firstRecord], [[...secondObserved].reverse(), [...firstObserved].reverse()]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.counts, { pass: 2, fail: 0, unknown: 0, blocked: 0 });
});

test("production-safe empty batch requires no qualifier or observation", () => {
  const artifact = batch({ records: [], now: NOW });
  assert.deepEqual(artifact.bindings, []);
  assert.deepEqual(artifact.counts, { pass: 0, fail: 0, unknown: 0, blocked: 0 });
  assert.equal(binder.validateArtifact(artifact), true);
});

test("network and RPC safety flags are explicit and constrained", () => {
  const local = bind([record()], [families()]);
  assert.deepEqual(local.safety, {
    localOnly: true, networkAccess: false, rpcAccess: false, forkUse: false, pnlEvaluation: false,
    signing: false, transactions: false, automaticExecution: false
  });
  const remote = batch({
    records: [record()], observations: [families()], now: NOW, networkAccess: true, rpcAccess: true
  });
  assert.equal(remote.safety.localOnly, false);
  assert.equal(remote.safety.networkAccess, true);
  assert.equal(remote.safety.rpcAccess, true);
  assert.equal(binder.validateArtifact(remote), true);
  assert.throws(() => batch({ records: [], now: NOW, networkAccess: false, rpcAccess: true }),
    (error) => error && error.code === "INVALID_SAFETY");
  const invalid = structuredClone(remote);
  invalid.safety.networkAccess = false;
  assert.equal(binder.validateArtifact(invalid), false);
});

test("atomic publication and readback are exact", (t) => {
  const paths = workspace(t);
  const artifact = binder.runAndPublish({
    records: [record()], observations: [families()], upstreamBatchCommitment: UPSTREAM_BATCH,
    now: NOW, outputPath: paths.outputPath, fsImpl: fs
  });
  const bytes = fs.readFileSync(paths.outputPath);
  assert.equal(bytes.toString("utf8"), `${JSON.stringify(artifact, null, 2)}\n`);
  assert.equal(binder.validateArtifact(JSON.parse(bytes.toString("utf8"))), true);
  assert.equal(fs.readdirSync(path.dirname(paths.outputPath)).some((name) => name.includes(".tmp")), false);
});
