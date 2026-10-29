#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const batch = require("../live-execution-batch.js");
const { createApprovalFixture } = require("./live-execution-batch-fixture.js");

const NOW_MS = Date.parse("2026-09-12T12:00:00.000Z");
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const DATA = `0xa9059cbb${"0".repeat(64)}`;
const MANIFEST = `0x${"11".repeat(32)}`;
const RUN_ID = "run-clear-consumed-1";
const CLI = path.join(__dirname, "..", "live-execution-batch.js");

function scope(overrides = {}) {
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
function tempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-batch-clear-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const approval = createApprovalFixture(dir);
  return {
    dir,
    batchPath: path.join(dir, "live-execution-batch.json"),
    registryPath: approval.registryPath,
    registrySha256: approval.registrySha256,
    sign: approval.sign,
  };
}
function options(env, extra = {}) {
  return { batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => NOW_MS, ...extra };
}
function writeValid(env, overrides = {}) {
  const signed = env.sign(scope(overrides));
  batch.writeBatch(signed, options(env));
  return signed;
}
function consume(env, signed) {
  return batch.consumeBatch({
    expectedBatchCommitment: batch.commitment(signed),
    manifestCommitment: MANIFEST,
    runId: RUN_ID,
    ...options(env),
  });
}
function markerPathFor(env, commitment) {
  return batch.terminalPathFor(commitment, env.batchPath);
}
function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function stateNow(env) {
  return batch.batchState(options(env));
}
function captured(fn) {
  try { fn(); } catch (error) { return error; }
  return undefined;
}

test("CONSUMED batch clears to ABSENT and archives both files byte-identically", (t) => {
  const env = tempEnv(t);
  const signed = writeValid(env);
  const commitment = batch.commitment(signed);
  consume(env, signed);
  assert.equal(stateNow(env).state, batch.STATES.CONSUMED);

  const markerPath = markerPathFor(env, commitment);
  const batchDigest = sha256File(env.batchPath);
  const markerDigest = sha256File(markerPath);
  const result = batch.clearConsumedBatch(options(env));

  assert.equal(result.ok, true);
  assert.equal(result.cleared, true);
  assert.equal(result.authorizationState, batch.STATES.ABSENT);
  assert.equal(stateNow(env).state, batch.STATES.ABSENT);

  const archivedBatch = batch.archivedBatchPathFor(commitment, env.batchPath);
  const archivedTerminal = batch.archivedTerminalPathFor(commitment, env.batchPath);
  assert.equal(result.archive.batch, archivedBatch);
  assert.equal(result.archive.terminal, archivedTerminal);
  assert.equal(path.basename(batch.archiveDirectoryFor(env.batchPath)), batch.ARCHIVE_DIR);

  assert.equal(fs.existsSync(env.batchPath), false);
  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(fs.existsSync(archivedBatch), true);
  assert.equal(fs.existsSync(archivedTerminal), true);
  assert.equal(sha256File(archivedBatch), batchDigest);
  assert.equal(sha256File(archivedTerminal), markerDigest);
  assert.match(path.basename(archivedBatch), new RegExp(commitment.slice(2)));
  assert.match(path.basename(archivedTerminal), new RegExp(commitment.slice(2)));
});

test("VALID batch is refused with a sanitized code and left untouched", (t) => {
  const env = tempEnv(t);
  const signed = writeValid(env);
  const commitment = batch.commitment(signed);
  const before = sha256File(env.batchPath);
  const error = captured(() => batch.clearConsumedBatch(options(env)));

  assert.equal(error?.code, "CLEAR_CONSUMED_REFUSED_VALID");
  assert.equal(stateNow(env).state, batch.STATES.VALID);
  assert.equal(sha256File(env.batchPath), before);
  assert.equal(fs.existsSync(batch.archiveDirectoryFor(env.batchPath)), false);
  assert.equal(fs.existsSync(markerPathFor(env, commitment)), false);
});

test("ABSENT canonical state is a reported no-op", (t) => {
  const env = tempEnv(t);
  const result = batch.clearConsumedBatch(options(env));

  assert.equal(result.ok, true);
  assert.equal(result.cleared, false);
  assert.equal(result.authorizationState, batch.STATES.ABSENT);
  assert.equal(result.archive, null);
  assert.equal(fs.existsSync(batch.archiveDirectoryFor(env.batchPath)), false);
});

test("an existing archive for the same commitment is refused without overwrite", (t) => {
  const env = tempEnv(t);
  const signed = writeValid(env);
  const commitment = batch.commitment(signed);
  consume(env, signed);

  const archivedBatch = batch.archivedBatchPathFor(commitment, env.batchPath);
  fs.mkdirSync(path.dirname(archivedBatch), { recursive: true });
  fs.writeFileSync(archivedBatch, "SENTINEL-ARCHIVE");
  const batchBefore = sha256File(env.batchPath);
  const markerBefore = sha256File(markerPathFor(env, commitment));

  const error = captured(() => batch.clearConsumedBatch(options(env)));
  assert.equal(error?.code, "CLEAR_CONSUMED_ARCHIVE_EXISTS");
  assert.equal(fs.readFileSync(archivedBatch, "utf8"), "SENTINEL-ARCHIVE");
  assert.equal(sha256File(env.batchPath), batchBefore);
  assert.equal(sha256File(markerPathFor(env, commitment)), markerBefore);
  assert.equal(stateNow(env).state, batch.STATES.CONSUMED);
});

test("unknown flags and stray positional arguments are refused", () => {
  for (const args of [["--force"], ["extra"], ["--archive", "x"]]) {
    const error = captured(() => batch.clearConsumedCommand(args));
    assert.equal(error?.code, "USAGE_ERROR", JSON.stringify(args));
  }
  const proc = spawnSync(process.execPath, [CLI, "clear-consumed", "--force"], { encoding: "utf8" });
  const row = JSON.parse(proc.stdout.trim());
  assert.equal(row.status, "FAIL_CLOSED");
  assert.equal(row.blocker, "USAGE_ERROR");
  assert.equal(proc.status, 1);
});

test("clear-consumed does not run when the archive directory cannot be created safely", (t) => {
  const env = tempEnv(t);
  const signed = writeValid(env);
  const commitment = batch.commitment(signed);
  consume(env, signed);
  fs.writeFileSync(batch.archiveDirectoryFor(env.batchPath), "not-a-directory");
  const batchBefore = sha256File(env.batchPath);
  const markerBefore = sha256File(markerPathFor(env, commitment));

  const error = captured(() => batch.clearConsumedBatch(options(env)));
  assert.equal(error?.code, "CLEAR_CONSUMED_ARCHIVE_UNAVAILABLE");
  assert.equal(fs.readFileSync(batch.archiveDirectoryFor(env.batchPath), "utf8"), "not-a-directory");
  assert.equal(sha256File(env.batchPath), batchBefore);
  assert.equal(sha256File(markerPathFor(env, commitment)), markerBefore);
  assert.equal(stateNow(env).state, batch.STATES.CONSUMED);

  const stubEnv = tempEnv(t);
  const stubSigned = writeValid(stubEnv);
  consume(stubEnv, stubSigned);
  const io = Object.create(fs);
  io.mkdirSync = () => { const denied = new Error("denied"); denied.code = "EACCES"; throw denied; };
  const stubError = captured(() => batch.clearConsumedBatch(options(stubEnv, { io })));
  assert.equal(stubError?.code, "CLEAR_CONSUMED_ARCHIVE_UNAVAILABLE");
  assert.equal(stateNow(stubEnv).state, batch.STATES.CONSUMED);
  assert.equal(fs.existsSync(batch.archiveDirectoryFor(stubEnv.batchPath)), false);
});

test("other canonical states fail closed with sanitized codes and change nothing", (t) => {
  const invalidEnv = tempEnv(t);
  fs.writeFileSync(invalidEnv.batchPath, "{not-json");
  const invalidError = captured(() => batch.clearConsumedBatch(options(invalidEnv)));
  assert.equal(invalidError?.code, "CLEAR_CONSUMED_REFUSED_INVALID");
  assert.equal(fs.readFileSync(invalidEnv.batchPath, "utf8"), "{not-json");

  const expiredEnv = tempEnv(t);
  const signed = writeValid(expiredEnv, {
    batchId: "0011223344556677",
    nonce: "0011223344556677",
    issuedAt: "2026-09-01T00:00:00.000Z",
    notBefore: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-02T00:00:00.000Z",
  });
  const expiredCommitment = batch.commitment(signed);
  assert.equal(stateNow(expiredEnv).state, batch.STATES.EXPIRED);
  const expiredError = captured(() => batch.clearConsumedBatch(options(expiredEnv)));
  assert.equal(expiredError?.code, "CLEAR_CONSUMED_REFUSED_EXPIRED");
  assert.equal(fs.existsSync(expiredEnv.batchPath), true);
  assert.equal(fs.existsSync(markerPathFor(expiredEnv, expiredCommitment)), false);
  assert.equal(fs.existsSync(batch.archiveDirectoryFor(expiredEnv.batchPath)), false);
});
