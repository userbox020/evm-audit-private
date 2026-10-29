#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const test = require("node:test");
const b = require("./live-execution-batch.js");
const { createApprovalFixture } = require("./test/live-execution-batch-fixture.js");

const NOW_MS = Date.parse("2026-09-12T12:00:00.000Z");
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const OTHER_TARGET = "0x3333333333333333333333333333333333333333";
const DATA = `0xa9059cbb${"0".repeat(128)}`;
const MANIFEST_COMMITMENT = `0x${"44".repeat(32)}`;

function batchScope(overrides = {}) {
  return {
    schema: b.SCHEMA,
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
function tempEnv(t, approverId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-batch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const approval = createApprovalFixture(dir, approverId);
  return { dir, batchPath: path.join(dir, "live-execution-batch.json"), registryPath: approval.registryPath, registrySha256: approval.registrySha256, sign: approval.sign };
}
function write(env, scope = batchScope()) {
  const signed = env.sign(scope);
  b.writeBatch(signed, { batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256 });
  return signed;
}
function state(env, now = NOW_MS) {
  return b.batchState({ batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => now });
}

test("only a trusted detached Ed25519 approval over the exact domain-separated scope can become VALID", (t) => {
  const env = tempEnv(t);
  const signed = write(env);
  const valid = state(env);
  assert.equal(valid.state, b.STATES.VALID);
  assert.equal(valid.batchCommitment, b.commitment(signed));
  const row = b.authorizationRow({ batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => NOW_MS });
  assert.equal(row.authorizationState, "VALID");
  assert.equal(row.batch.actionCount, "1");
  assert.equal(row.approval.approverId, "test-approver");
  assert.match(row.approval.registryFingerprint, /^0x[0-9a-f]{64}$/u);
  assert.match(row.approval.keyFingerprint, /^0x[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(row), /publicKey|registryPath|signature|https?:|privatekey|secret|endpoint/i);
});

test("unsigned, self-asserted, unknown-approver, wrong-commitment, and replayed approvals fail closed", (t) => {
  const cases = [];
  const unsigned = { ...batchScope(), approval: undefined };
  cases.push(unsigned);

  const self = tempEnv(t, "trusted");
  const selfSigned = self.sign(batchScope());
  selfSigned.approval.signature = Buffer.alloc(64).toString("base64");
  cases.push(selfSigned);

  const unknown = self.sign(batchScope({ batchId: "b1b2c3d4e5f60718" }));
  unknown.approval.approverId = "unknown";
  cases.push(unknown);

  const wrong = self.sign(batchScope({ batchId: "c1b2c3d4e5f60718" }));
  wrong.approval.scopeCommitment = `0x${"99".repeat(32)}`;
  cases.push(wrong);

  const replay = self.sign(batchScope({ batchId: "d1b2c3d4e5f60718" }));
  replay.actions[0].data = `0xa9059cbb${"1".repeat(128)}`;
  cases.push(replay);

  for (const [index, value] of cases.entries()) {
    const file = path.join(self.dir, `case-${index}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    assert.notEqual(b.batchState({ batchPath: file, registryPath: self.registryPath, registrySha256: self.registrySha256, now: () => NOW_MS }).state, b.STATES.VALID, `case ${index}`);
  }
});

test("schema, complete action tuples, actor identity, and duplicate action reuse are strict", (t) => {
  const env = tempEnv(t);
  const mutations = [
    (scope) => { scope.schema = "live-execution-batch/v1"; },
    (scope) => { scope.accountRef = OTHER_TARGET; },
    (scope) => { scope.actions[0].from = OTHER_TARGET; },
    (scope) => { scope.actions[0].data = "0x1234"; },
    (scope) => { scope.actions[0].gasLimit = "0"; },
    (scope) => { scope.actions[0].slippageBps = "10001"; },
    (scope) => { scope.actions = [scope.actions[0], { ...scope.actions[0] }]; },
    (scope) => { scope.anvil.executablePath = "anvil"; },
  ];
  for (const mutate of mutations) {
    const scope = batchScope();
    mutate(scope);
    assert.throws(() => b.validateBatch({ ...scope, approval: { scheme: "Ed25519", approverId: "x", scopeCommitment: `0x${"00".repeat(32)}`, signature: Buffer.alloc(64).toString("base64") } }));
  }
  assert.equal(env.dir.length > 0, true);
});

test("exact positional scope rejects actor, target, value, calldata, gas, slippage, count, order, and reuse drift", () => {
  const second = { from: ACCOUNT, to: OTHER_TARGET, valueWei: "2", data: `0x095ea7b3${"2".repeat(128)}`, gasLimit: "200000", slippageBps: "25" };
  const scope = batchScope({ actions: [batchScope().actions[0], second] });
  const base = (action) => ({ chainId: "1", ...action });
  assert.equal(b.checkAction(scope, base(scope.actions[0]), 0).ok, true);
  for (const [field, value, reason] of [
    ["from", OTHER_TARGET, "SCOPE_ACTOR_MISMATCH"], ["to", OTHER_TARGET, "SCOPE_TARGET_MISMATCH"], ["valueWei", "1", "SCOPE_VALUE_MISMATCH"],
    ["data", `0xa9059cbb${"1".repeat(128)}`, "SCOPE_CALLDATA_MISMATCH"], ["gasLimit", "99999", "SCOPE_GAS_MISMATCH"], ["slippageBps", "49", "SCOPE_SLIPPAGE_MISMATCH"],
  ]) assert.equal(b.checkAction(scope, { ...base(scope.actions[0]), [field]: value }, 0).reason, reason);
  assert.equal(b.checkAction(scope, base(scope.actions[0]), 1).reason, "SCOPE_TARGET_MISMATCH");
  assert.equal(b.checkAction(scope, base(scope.actions[0]), 2).reason, "SCOPE_ACTION_COUNT_OR_ORDER_MISMATCH");
});

test("commitment-specific consumption is atomic, terminal, and binds manifest plus run ID", async (t) => {
  const env = tempEnv(t);
  const signed = write(env);
  const expectedBatchCommitment = b.commitment(signed);
  const attempts = await Promise.allSettled([1, 2].map((number) => Promise.resolve().then(() => b.consumeBatch({
    batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => NOW_MS, expectedBatchCommitment,
    manifestCommitment: MANIFEST_COMMITMENT, runId: `run-${number}`,
  }))));
  assert.equal(attempts.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((row) => row.status === "rejected").length, 1);
  const terminal = state(env);
  assert.equal(terminal.state, b.STATES.CONSUMED);
  assert.equal(terminal.terminal.manifestCommitment, MANIFEST_COMMITMENT);
  assert.match(terminal.terminal.runId, /^run-[12]$/u);
  assert.equal(fs.existsSync(b.terminalPathFor(expectedBatchCommitment, env.batchPath)), true);
  assert.throws(() => b.revokeBatch({ batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => NOW_MS, expectedBatchCommitment, revocationRef: "late-revoke" }), /BATCH_TERMINAL_CONSUMED/);
});

test("revocation wins against consumption and replacement canonical batches are independently revocable", (t) => {
  const env = tempEnv(t);
  const first = write(env, batchScope({ batchId: "11111111", nonce: "11111111" }));
  const revokedA = b.revokeBatch({ batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => NOW_MS, expectedBatchCommitment: b.commitment(first), revocationRef: "replace-a" });
  assert.equal(revokedA.marker.state, b.STATES.REVOKED);
  assert.throws(() => b.consumeBatch({ batchPath: revokedA.archive, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => NOW_MS, expectedBatchCommitment: b.commitment(first), manifestCommitment: MANIFEST_COMMITMENT, runId: "late" }), /BATCH_TERMINAL_REVOKED/);
  const second = write(env, batchScope({ batchId: "22222222", nonce: "22222222" }));
  const revokedB = b.revokeBatch({ batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => NOW_MS, expectedBatchCommitment: b.commitment(second), revocationRef: "replace-b" });
  assert.notEqual(revokedA.archive, revokedB.archive);
  assert.equal(fs.existsSync(revokedA.archive), true);
  assert.equal(fs.existsSync(revokedB.archive), true);
  assert.equal(state(env).state, b.STATES.ABSENT);
});

test("absent, time-window, malformed registry, and sanitized command paths fail closed", (t) => {
  const env = tempEnv(t);
  assert.equal(state(env).state, b.STATES.ABSENT);
  write(env, batchScope({ notBefore: "2026-09-12T18:00:00.000Z" }));
  assert.equal(state(env).state, b.STATES.NOT_YET_VALID);
  fs.rmSync(env.registryPath);
  assert.equal(state(env).state, b.STATES.INVALID);
  assert.equal(state(env).reason, "APPROVER_REGISTRY_UNAVAILABLE");
  assert.throws(() => b.statusCommand(["--x"]), /USAGE_ERROR/);
  assert.throws(() => b.leakGuard({ rpc: "x" }), /BATCH_SECRET_FIELD_REJECTED/);
  for (const key of ["private-key", "client_secret", "access.token", "refresh token", "authorization-header", "RPC_endpoint", "provider-url", "websocket.url"]) {
    assert.throws(() => b.leakGuard({ nested: { [key]: "x" } }), /BATCH_SECRET_FIELD_REJECTED/, key);
  }
  assert.doesNotThrow(() => b.leakGuard({ tokenAddress: TARGET, providerName: "local" }));
  assert.throws(() => b.assertNoNumbers({ a: 1 }), /NONCANONICAL_NUMBER/);
  assert.match(crypto.createHash("sha256").update(b.APPROVAL_DOMAIN).digest("hex"), /^[0-9a-f]{64}$/u);
});

test("registry trust anchor, unique keys, and filesystem identity are mandatory", (t) => {
  const env = tempEnv(t);
  const signed = write(env);
  assert.equal(b.batchState({ batchPath: env.batchPath, registryPath: env.registryPath, now: () => NOW_MS }).reason, "APPROVER_REGISTRY_TRUST_ANCHOR_UNAVAILABLE");
  assert.equal(b.batchState({ batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: `0x${"00".repeat(32)}`, now: () => NOW_MS }).reason, "APPROVER_REGISTRY_TRUST_ANCHOR_MISMATCH");
  const duplicate = JSON.parse(fs.readFileSync(env.registryPath, "utf8"));
  duplicate.approvers.push({ ...duplicate.approvers[0], approverId: "duplicate-id" });
  const duplicatePath = path.join(env.dir, "duplicate-registry.json");
  fs.writeFileSync(duplicatePath, JSON.stringify(duplicate));
  const duplicateDigest = `0x${crypto.createHash("sha256").update(fs.readFileSync(duplicatePath)).digest("hex")}`;
  assert.equal(b.batchState({ batchPath: env.batchPath, registryPath: duplicatePath, registrySha256: duplicateDigest, now: () => NOW_MS }).reason, "APPROVER_REGISTRY_DUPLICATE_KEY");
  const unsafeIo = { ...fs, lstatSync(file) { const stat = fs.lstatSync(file); return path.resolve(file) === path.resolve(env.batchPath) ? { ...stat, isSymbolicLink: () => true, isFile: () => false } : stat; } };
  assert.equal(b.batchState({ batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, io: unsafeIo, now: () => NOW_MS }).reason, "FILESYSTEM_PATH_UNSAFE");
  assert.equal(b.commitment(signed), b.commitment(signed));
});

test("canonical registry uses only the approved source pin and optional exact environment assertion", (t) => {
  const env = tempEnv(t);
  const approvedPin = "0x718e4b53c6b3d2b1f3308672b6aa5db1270b789e5c4e1975eebda745ac1e47ee";
  const original = process.env[b.TRUST_ANCHOR_ENV];
  t.after(() => {
    if (original === undefined) delete process.env[b.TRUST_ANCHOR_ENV];
    else process.env[b.TRUST_ANCHOR_ENV] = original;
  });
  assert.throws(() => b.verifyApproval(env.sign(batchScope()), { batchPath: b.BATCH_PATH, registryPath: env.registryPath, registrySha256: env.registrySha256 }), /CANONICAL_REGISTRY_REQUIRED/);
  assert.equal(b.CANONICAL_REGISTRY_SHA256, approvedPin);
  assert.equal(`0x${crypto.createHash("sha256").update(fs.readFileSync(b.REGISTRY_PATH)).digest("hex")}`, approvedPin);
  delete process.env[b.TRUST_ANCHOR_ENV];
  assert.equal(b.trustedRegistryDigest({ registryPath: b.REGISTRY_PATH, registrySha256: env.registrySha256 }), approvedPin);
  process.env[b.TRUST_ANCHOR_ENV] = `0x${"bb".repeat(32)}`;
  assert.throws(() => b.trustedRegistryDigest({ registryPath: b.REGISTRY_PATH, trustedRegistrySha256: env.registrySha256 }), /APPROVER_REGISTRY_ENV_ASSERTION_MISMATCH/);
  process.env[b.TRUST_ANCHOR_ENV] = "malformed";
  assert.throws(() => b.trustedRegistryDigest({ registryPath: b.REGISTRY_PATH }), /APPROVER_REGISTRY_ENV_ASSERTION_INVALID/);
  delete process.env[b.TRUST_ANCHOR_ENV];
  const unreadableIo = { ...fs, lstatSync() { throw new Error("registry bytes must not be read"); } };
  assert.equal(b.batchState({ batchPath: env.batchPath, registryPath: b.REGISTRY_PATH, registrySha256: env.registrySha256, io: unreadableIo, now: () => NOW_MS }).reason, "FILESYSTEM_PATH_UNAVAILABLE");
  assert.throws(() => b.verifyApproval(env.sign(batchScope()), { batchPath: path.join(env.dir, "custom-batch.json"), registryPath: b.REGISTRY_PATH, registrySha256: env.registrySha256 }, unreadableIo), /APPROVER_REGISTRY_UNAVAILABLE/);
  assert.equal(b.trustedRegistryDigest({ registryPath: env.registryPath, registrySha256: env.registrySha256 }), env.registrySha256);
  assert.equal(b.trustedRegistryDigest({ registryPath: env.registryPath, trustedRegistrySha256: env.registrySha256 }), env.registrySha256);
});

test("pure canonical source-pin helper validates optional environment assertions", () => {
  const pin = `0x${"aa".repeat(32)}`;
  assert.equal(b.canonicalRegistryDigest(pin, undefined), pin);
  assert.throws(() => b.canonicalRegistryDigest(null, pin), /APPROVER_REGISTRY_TRUST_ANCHOR_UNAVAILABLE/);
  assert.throws(() => b.canonicalRegistryDigest("malformed", pin), /APPROVER_REGISTRY_TRUST_ANCHOR_UNAVAILABLE/);
  assert.throws(() => b.canonicalRegistryDigest(pin, ""), /APPROVER_REGISTRY_ENV_ASSERTION_INVALID/);
  assert.throws(() => b.canonicalRegistryDigest(pin, "malformed"), /APPROVER_REGISTRY_ENV_ASSERTION_INVALID/);
  assert.throws(() => b.canonicalRegistryDigest(pin, `0x${"bb".repeat(32)}`), /APPROVER_REGISTRY_ENV_ASSERTION_MISMATCH/);
  assert.equal(b.canonicalRegistryDigest(pin, pin), pin);
});

test("durable lifecycle failures fail closed and separate processes have one terminal winner", async (t) => {
  const env = tempEnv(t);
  const signed = write(env);
  const expected = b.commitment(signed);
  const failingFsync = { ...fs, fsyncSync() { const error = new Error("fault"); error.code = "EIO"; throw error; } };
  const markerPath = b.terminalPathFor(expected, env.batchPath);
  assert.throws(() => b.consumeBatch({ batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, expectedBatchCommitment: expected, manifestCommitment: MANIFEST_COMMITMENT, runId: "fsync-fault", io: failingFsync, now: () => NOW_MS }), /DURABLE_WRITE_FAILED/);
  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(fs.readdirSync(env.dir).some((name) => name.endsWith(".tmp")), false);
  const failingRename = { ...fs, renameSync() { const error = new Error("fault"); error.code = "EIO"; throw error; } };
  assert.equal(b.revokeBatch({ batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, expectedBatchCommitment: expected, revocationRef: "rename-fault", io: failingRename, now: () => NOW_MS }).archiveStatus, "ARCHIVE_NOT_COMPLETED");
  fs.rmSync(markerPath);
  const worker = `const b=require(process.argv[1]);try{b.consumeBatch({batchPath:process.argv[2],registryPath:process.argv[3],registrySha256:process.argv[4],expectedBatchCommitment:process.argv[5],manifestCommitment:process.argv[6],runId:process.argv[7],now:()=>${NOW_MS}});process.exitCode=0}catch(_){process.exitCode=1}`;
  const spawn = (runId) => new Promise((resolve) => childProcess.spawn(process.execPath, ["-e", worker, require.resolve("./live-execution-batch.js"), env.batchPath, env.registryPath, env.registrySha256, expected, MANIFEST_COMMITMENT, runId], { windowsHide: true }).once("exit", (code) => resolve(code)));
  const results = await Promise.all([spawn("process-a"), spawn("process-b")]);
  assert.equal(results.filter((code) => code === 0).length, 1);
});

test("durable writes close before pre-publication cleanup and report post-publication uncertainty", (t) => {
  const env = tempEnv(t);
  const target = path.join(env.dir, "target.json");
  const events = [];
  const preflightFault = {
    ...fs,
    closeSync(fd) { events.push("close"); return fs.closeSync(fd); },
    unlinkSync(file) { events.push("unlink"); return fs.unlinkSync(file); },
    fsyncSync(fd) { if (typeof fd === "number") { const error = new Error("fault"); error.code = "EIO"; throw error; } return fs.fsyncSync(fd); },
  };
  assert.throws(() => b.durableExclusiveWrite(target, Buffer.from("x"), { io: preflightFault }), /DURABLE_WRITE_FAILED/);
  assert.equal(events.indexOf("close") < events.indexOf("unlink"), true);
  assert.equal(fs.existsSync(target), false);
  if (process.platform !== "linux") return;
  let fsyncs = 0;
  const postPublishFault = { ...fs, fsyncSync(fd) { if (++fsyncs === 3) { const error = new Error("fault"); error.code = "EIO"; throw error; } return fs.fsyncSync(fd); } };
  assert.throws(() => b.durableExclusiveWrite(target, Buffer.from("x"), { io: postPublishFault, requireDurable: true }), /DURABILITY_COMMIT_INDETERMINATE/);
  assert.equal(fs.existsSync(target), true);
});
