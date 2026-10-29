#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const batch = require("../live-execution-batch.js");
const { createApprovalFixture } = require("./live-execution-batch-fixture.js");

const NOW_MS = Date.parse("2026-09-12T12:00:00.000Z");
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER_ACCOUNT = "0x9999999999999999999999999999999999999999";
const TARGET = "0x2222222222222222222222222222222222222222";
const OTHER_TARGET = "0x3333333333333333333333333333333333333333";
const DATA = `0xa9059cbb${"0".repeat(64)}`;
const ATTESTATION = `0x${"ab".repeat(32)}`;
const OTHER_ATTESTATION = `0x${"cd".repeat(32)}`;

const stubApproval = () => ({
  scheme: "Ed25519",
  approverId: "test-approver",
  scopeCommitment: `0x${"00".repeat(32)}`,
  signature: Buffer.alloc(64).toString("base64"),
});
const withApproval = (scope) => ({ ...scope, approval: stubApproval() });

function v3Scope(overrides = {}) {
  return {
    schema: batch.SCHEMA_V3,
    batchId: "a1b2c3d4e5f60718",
    mode: "TESTNET",
    chainId: "1",
    accountRef: ACCOUNT,
    actions: [{ from: ACCOUNT, to: TARGET, valueWei: "0", data: DATA, gasLimit: "100000", slippageBps: "50" }],
    gasCeiling: "1000000",
    feeCap: { maxFeePerGasWei: "1000000000", maxPriorityFeePerGasWei: "1000000000" },
    issuedAt: "2026-09-12T00:00:00.000Z",
    notBefore: "2026-09-12T00:00:00.000Z",
    expiresAt: "2026-09-13T00:00:00.000Z",
    nonce: "0123456789abcdef",
    ...overrides,
  };
}
function productionScope(overrides = {}) {
  return v3Scope({ mode: "PRODUCTION", testnetAttestation: ATTESTATION, ...overrides });
}
function v2Scope(overrides = {}) {
  return {
    schema: batch.SCHEMA,
    batchId: "a1b2c3d4e5f60718",
    mode: "FORK_TESTNET",
    chainId: "1",
    accountRef: ACCOUNT,
    actions: [{ from: ACCOUNT, to: TARGET, valueWei: "0", data: DATA, gasLimit: "100000", slippageBps: "50" }],
    gasCeiling: "1000000",
    anvil: { executablePath: path.resolve(os.tmpdir(), "synthetic-anvil.exe"), sha256: `0x${"33".repeat(32)}`, version: "anvil test-version" },
    issuedAt: "2026-09-12T00:00:00.000Z",
    notBefore: "2026-09-12T00:00:00.000Z",
    expiresAt: "2026-09-13T00:00:00.000Z",
    nonce: "0123456789abcdef",
    ...overrides,
  };
}
function tempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-batch-v3-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const approval = createApprovalFixture(dir);
  return { dir, batchPath: path.join(dir, "live-execution-batch.json"), registryPath: approval.registryPath, registrySha256: approval.registrySha256, sign: approval.sign };
}
function writeSigned(env, signed) {
  batch.writeBatch(signed, { batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256 });
}
function writeRaw(env, signed, name) {
  const file = path.join(env.dir, name);
  fs.writeFileSync(file, JSON.stringify(signed));
  return file;
}
function stateAt(env, file = env.batchPath) {
  return batch.batchState({ batchPath: file, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => NOW_MS });
}

test("v3 TESTNET batch with detached approval reaches VALID without an anvil pin", (t) => {
  const env = tempEnv(t);
  const signed = env.sign(v3Scope());
  writeSigned(env, signed);
  const state = stateAt(env);
  assert.equal(state.state, batch.STATES.VALID);
  assert.equal(state.batchCommitment, batch.commitment(signed));
  assert.equal(state.batch.schema, batch.SCHEMA_V3);
  assert.equal(state.batch.mode, "TESTNET");
  assert.equal(Object.hasOwn(state.batch, "anvil"), false);
  assert.equal(state.terminal, undefined);
  const row = batch.authorizationRow({ batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => NOW_MS });
  assert.equal(row.authorizationState, "VALID");
  assert.equal(row.approval.approverId, "test-approver");
  assert.doesNotMatch(JSON.stringify(row), /publicKey|registryPath|signature|https?:|privatekey|secret|endpoint/i);
});

test("v2 batches still validate exactly and MODES remains exactly FORK_TESTNET", (t) => {
  const env = tempEnv(t);
  const signed = env.sign(v2Scope());
  writeSigned(env, signed);
  assert.equal(stateAt(env).state, batch.STATES.VALID);
  assert.deepEqual(batch.MODES, ["FORK_TESTNET"]);
  assert.equal(Object.isFrozen(batch.MODES), true);
  assert.deepEqual(batch.MODES_V3, ["TESTNET", "PRODUCTION"]);
  assert.equal(Object.isFrozen(batch.MODES_V3), true);
  assert.equal(batch.SCHEMA_V3, "live-execution-batch/v3");
  assert.equal(batch.APPROVAL_DOMAIN.endsWith("\u0000"), true);
  assert.equal(batch.APPROVAL_DOMAIN_V3.endsWith("\u0000"), true);
  assert.notEqual(batch.APPROVAL_DOMAIN_V3, batch.APPROVAL_DOMAIN);
});

test("v3 rejects anvil, feeCap shape/value errors, and mode drift", (t) => {
  const env = tempEnv(t);
  assert.equal(env.dir.length > 0, true);
  const withAnvil = v3Scope({ anvil: { executablePath: path.resolve(os.tmpdir(), "synthetic-anvil.exe"), sha256: `0x${"33".repeat(32)}`, version: "anvil test-version" } });
  assert.throws(() => batch.validateBatch(withApproval(withAnvil)), /BATCH_SCHEMA_INVALID/);
  const missingFeeCap = v3Scope();
  delete missingFeeCap.feeCap;
  assert.throws(() => batch.validateBatch(withApproval(missingFeeCap)), /BATCH_SCHEMA_INVALID/);
  assert.throws(() => batch.validateBatch(withApproval(v3Scope({ feeCap: { maxFeePerGasWei: 1000000000, maxPriorityFeePerGasWei: "1000000000" } }))), /BATCH_FEE_CAP_INVALID/);
  assert.throws(() => batch.validateBatch(withApproval(v3Scope({ feeCap: { maxFeePerGasWei: "1000000000" } }))), /BATCH_FEE_CAP_INVALID/);
  assert.throws(() => batch.validateBatch(withApproval(v3Scope({ feeCap: { maxFeePerGasWei: "01", maxPriorityFeePerGasWei: "0" } }))), /BATCH_FEE_CAP_INVALID/);
  assert.throws(() => batch.validateBatch(withApproval(v3Scope({ feeCap: { maxFeePerGasWei: "1000000000", maxPriorityFeePerGasWei: "1000000000", extra: "0" } }))), /BATCH_FEE_CAP_INVALID/);
  assert.throws(() => batch.validateBatch(withApproval(v3Scope({ mode: "FORK_TESTNET" }))), /BATCH_MODE_INVALID/);
});

test("PRODUCTION requires an exact lowercase attestation and TESTNET forbids it", (t) => {
  const env = tempEnv(t);
  const signed = env.sign(productionScope());
  writeSigned(env, signed);
  assert.equal(stateAt(env).state, batch.STATES.VALID);
  assert.equal(stateAt(env).batch.testnetAttestation, ATTESTATION);
  const missing = productionScope();
  delete missing.testnetAttestation;
  assert.throws(() => batch.validateBatch(withApproval(missing)), /BATCH_SCHEMA_INVALID/);
  assert.throws(() => batch.validateBatch(withApproval(productionScope({ testnetAttestation: ATTESTATION.toUpperCase() }))), /BATCH_TESTNET_ATTESTATION_INVALID/);
  assert.throws(() => batch.validateBatch(withApproval(productionScope({ testnetAttestation: `0x${"ab".repeat(31)}` }))), /BATCH_TESTNET_ATTESTATION_INVALID/);
  assert.throws(() => batch.validateBatch(withApproval(productionScope({ testnetAttestation: 7 }))), /BATCH_TESTNET_ATTESTATION_INVALID/);
  assert.throws(() => batch.validateBatch(withApproval({ ...v3Scope(), testnetAttestation: ATTESTATION })), /BATCH_SCHEMA_INVALID/);
});

test("tampering any signed scope field invalidates the approval", (t) => {
  const env = tempEnv(t);
  const mutations = [
    ["chainId", (scope) => { scope.chainId = "2"; }],
    ["accountRef", (scope) => { scope.accountRef = OTHER_ACCOUNT; scope.actions[0].from = OTHER_ACCOUNT; }],
    ["action", (scope) => { scope.actions[0].to = OTHER_TARGET; }],
    ["gasCeiling", (scope) => { scope.gasCeiling = "1000001"; }],
    ["feeCap", (scope) => { scope.feeCap.maxFeePerGasWei = "1000000001"; }],
    ["expiresAt", (scope) => { scope.expiresAt = "2026-09-12T18:00:00.000Z"; }],
    ["nonce", (scope) => { scope.nonce = "fedcba9876543210"; }],
  ];
  for (const [name, mutate] of mutations) {
    const signed = env.sign(v3Scope());
    mutate(signed);
    const file = writeRaw(env, signed, `tamper-${name}.json`);
    assert.equal(stateAt(env, file).state, batch.STATES.INVALID, name);
    assert.equal(stateAt(env, file).reason, "BATCH_APPROVAL_SCOPE_MISMATCH", name);
  }
  const attested = env.sign(productionScope());
  attested.testnetAttestation = OTHER_ATTESTATION;
  const attestationFile = writeRaw(env, attested, "tamper-attestation.json");
  assert.equal(stateAt(env, attestationFile).state, batch.STATES.INVALID);
  assert.equal(stateAt(env, attestationFile).reason, "BATCH_APPROVAL_SCOPE_MISMATCH");
});

test("v2 and v3 approvals are domain separated in both directions", (t) => {
  const env = tempEnv(t);
  const v3SignedWithV2Domain = env.sign(v3Scope(), batch.SCHEMA);
  const v3File = writeRaw(env, v3SignedWithV2Domain, "v3-v2-domain.json");
  assert.equal(stateAt(env, v3File).state, batch.STATES.INVALID);
  assert.equal(stateAt(env, v3File).reason, "BATCH_APPROVAL_SIGNATURE_INVALID");
  const v2SignedWithV3Domain = env.sign(v2Scope(), batch.SCHEMA_V3);
  const v2File = writeRaw(env, v2SignedWithV3Domain, "v2-v3-domain.json");
  assert.equal(stateAt(env, v2File).state, batch.STATES.INVALID);
  assert.equal(stateAt(env, v2File).reason, "BATCH_APPROVAL_SIGNATURE_INVALID");
});
