#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const batch = require("../live-execution-batch.js");
const runner = require("../run-approved-fork-validation.js");
const { createApprovalFixture } = require("./live-execution-batch-fixture.js");

const ACTOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ACTOR = "0xa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROTOCOL = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "0xcccccccccccccccccccccccccccccccccccccccc";
const TARGET = "0xdddddddddddddddddddddddddddddddddddddddd";
const OTHER_TARGET = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const HASH = `0x${"11".repeat(32)}`;
const STATE_ROOT = `0x${"22".repeat(32)}`;
const DATA = `0xa9059cbb${"0".repeat(64)}${"1".repeat(64)}${"2".repeat(64)}`;
const PROFIT = 1000n * 10n ** 6n;

const callFixture = (overrides = {}) => ({ id: "c1", actor: ACTOR, to: TARGET, data: DATA, valueWei: "0", gasLimit: "1000000", slippageBps: "50", ...overrides });
function manifestFixture(overrides = {}) {
  return {
    schema: runner.MANIFEST_SCHEMA,
    manifestId: "a1b2c3d4e5f60718",
    chainId: "1",
    pinBlockNumber: "10",
    pinBlockHash: HASH,
    pinStateRoot: STATE_ROOT,
    pinFinality: "finalized",
    calls: [callFixture()],
    watch: [
      { id: "actor-native", token: "native", holder: ACTOR, decimals: "18", role: "attacker" },
      { id: "target-native", token: "native", holder: TARGET, decimals: "18", role: "observer" },
      { id: "w1", token: TOKEN, holder: ACTOR, decimals: "6", role: "attacker" },
      { id: "w2", token: TOKEN, holder: PROTOCOL, decimals: "6", role: "protocol" },
    ],
    pricesUsd: [{ token: TOKEN, usdPerToken: "1" }, { token: "native", usdPerToken: "1" }],
    ...overrides,
  };
}
function batchScope(calls, now, overrides = {}) {
  return {
    schema: batch.SCHEMA,
    batchId: "abcdef0123456789",
    mode: "FORK_TESTNET",
    chainId: "1",
    accountRef: ACTOR,
    actions: calls.map((call) => ({ from: call.actor, to: call.to, valueWei: call.valueWei, data: call.data, gasLimit: call.gasLimit, slippageBps: call.slippageBps })),
    gasCeiling: calls.reduce((total, call) => total + BigInt(call.gasLimit), 0n).toString(),
    anvil: { executablePath: path.resolve(os.tmpdir(), "synthetic-anvil.exe"), sha256: `0x${"33".repeat(32)}`, version: "anvil test-version" },
    issuedAt: new Date(now - 60_000).toISOString(),
    notBefore: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    nonce: "abcdef0123456789",
    ...overrides,
  };
}
function environment(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-validation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const batchPath = path.join(dir, "live-execution-batch.json");
  const manifestPath = path.join(dir, "manifest.json");
  const outPath = path.join(dir, "out", "result.json");
  const manifest = manifestFixture(options.manifest);
  const watchKeys = new Set(manifest.watch.map((row) => `${row.token}:${row.holder}`));
  for (const entry of runner.minimumBalanceWatch(manifest.calls)) {
    if (watchKeys.has(`${entry.token}:${entry.holder}`)) continue;
    manifest.watch.push({ id: `required-${manifest.watch.length + 1}`, ...entry, decimals: "18" });
    watchKeys.add(`${entry.token}:${entry.holder}`);
  }
  const approval = createApprovalFixture(dir);
  const signedBatch = approval.sign(batchScope(options.approvedCalls || manifest.calls, now, options.batch));
  batch.writeBatch(signedBatch, { batchPath, registryPath: approval.registryPath, registrySha256: approval.registrySha256 });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const state = { started: 0, stopped: 0, profitApplied: false, reverted: false, methods: [], endpointResolved: 0, identityChecked: 0, calls: 0 };
  const readBalance = (token, holder) => state.profitApplied && token === TOKEN && holder === ACTOR ? PROFIT : 0n;
  let snapshotValid = true;
  const localRpc = {
    call: async (method, params) => {
      state.methods.push(method);
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByNumber") return { number: "0xa", hash: HASH, stateRoot: STATE_ROOT };
      if (method === "evm_snapshot") { snapshotValid = true; return "0x1"; }
      if (method === "evm_revert") {
        if (!snapshotValid) return options.invalidationResult === undefined ? false : options.invalidationResult;
        if (options.revertResult === false) return false;
        state.reverted = true;
        snapshotValid = false;
        if (!options.stickyRevert) state.profitApplied = false;
        return true;
      }
      if (method === "anvil_setBalance" || method === "anvil_impersonateAccount" || method === "anvil_stopImpersonatingAccount") return true;
      if (method === "eth_sendTransaction") { state.sentTransaction = params[0]; state.profitApplied = true; state.calls += 1; return `0x${"ab".repeat(32)}`; }
      if (method === "eth_getTransactionReceipt") return options.receipt || { status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x0" };
      if (method === "eth_call") { const holder = `0x${params[0].data.slice(34, 74)}`; return `0x${readBalance(TOKEN, holder).toString(16).padStart(64, "0")}`; }
      if (method === "eth_getBalance") return `0x${readBalance("native", params[0]).toString(16)}`;
      throw new Error(`unexpected local method ${method}`);
    },
    stats: () => ({ requests: state.methods.length, bytes: 1 }),
  };
  const authOptions = { batchPath, registryPath: approval.registryPath, registrySha256: approval.registrySha256, now: () => now };
  const deps = {
    loadAuthorization: async () => batch.batchState(authOptions),
    consumeAuthorization: async (request) => batch.consumeBatch({ ...authOptions, ...request }),
    verifyAnvilIdentity: async () => { state.identityChecked += 1; if (options.identityFailure) throw new runner.ForkError(options.identityFailure, "TOOLCHAIN"); return { absolutePath: true, sha256Matched: true, versionMatched: true, identity: { realPath: signedBatch.anvil.executablePath, dev: "1", ino: "1", size: "1", mtimeMs: "1", sha256: signedBatch.anvil.sha256, fd: "test", execPath: "/proc/self/fd/test" } }; },
    resolveUpstream: async () => { state.endpointResolved += 1; return "http://synthetic.invalid"; },
    qualifyUpstream: async () => { await options.onQualify?.({ authOptions, signedBatch }); return { chainIdMatched: true, pinHashMatched: true, pinStateRootMatched: true, finalizedAtOrAfterPin: true }; },
    transport: async () => { throw new Error("upstream transport must not be used by fake local rpc"); },
    freePort: async () => 39_999,
    startAnvil: async (pin, identity) => { assert.equal(pin.executablePath, signedBatch.anvil.executablePath); assert.equal(identity.sha256, signedBatch.anvil.sha256); state.started += 1; return { exitCode: null, signalCode: null, kill() {}, once() {}, removeListener() {} }; },
    stopAnvil: async () => { state.stopped += 1; return true; },
    createLocalRpc: () => localRpc,
  };
  return { dir, batchPath, registryPath: approval.registryPath, registrySha256: approval.registrySha256, manifestPath, outPath, manifest, signedBatch, state, deps, authOptions };
}
const run = (env, overrides = {}) => runner.runForkValidation({ manifestPath: env.manifestPath, outPath: env.outPath, deps: env.deps, ...overrides });

test("authenticated exact scope is consumed before calls and produces sanitized incomplete/unverified economics", async (t) => {
  const env = environment(t);
  const result = await run(env, { runId: "run-success" });
  assert.equal(result.output.status, "FORK_VALIDATION_COMPLETE");
  assert.equal(result.output.classification, "INCOMPLETE_UNVERIFIED_ESTIMATE_NONPOSITIVE_OR_UNPRICED");
  assert.equal(result.output.netUsdEstimate, null);
  assert.equal(result.output.routePositive, "unknown");
  assert.equal(result.output.economicsComplete, false);
  assert.equal(result.output.authorizationStateAtRun, "CONSUMED");
  assert.equal(result.output.watchedStateRollbackVerified, true);
  assert.equal(env.state.sentTransaction.from, ACTOR);
  assert.equal(env.state.sentTransaction.gas, "0xf4240");
  assert.equal(env.state.identityChecked, 1);
  assert.equal(env.state.endpointResolved, 1);
  assert.equal(batch.batchState(env.authOptions).state, batch.STATES.CONSUMED);
  const terminal = batch.batchState(env.authOptions).terminal;
  assert.equal(terminal.manifestCommitment, runner.manifestCommitment(env.manifest));
  assert.equal(terminal.runId, "run-success");
  assert.equal(result.output.scopeCommitment, batch.scopeCommitment(env.signedBatch));
  assert.equal(result.output.approval.approverId, "test-approver");
  assert.doesNotMatch(JSON.stringify(result.output), /synthetic\.invalid|publicKey|registryPath|signature/i);
});

test("runner rejects every arbitrary batch path and CLI --batch form", async (t) => {
  const env = environment(t);
  for (const batchPath of [env.batchPath, ".\\relative.json", path.resolve(env.dir, "alternate.json")]) {
    await assert.rejects(run(env, { batchPath }), /RUNNER_BATCH_PATH_OVERRIDE_REJECTED/);
  }
  assert.throws(() => runner.parseArgs(["--manifest", env.manifestPath, "--batch", env.batchPath]), /USAGE_ERROR/);
  assert.deepEqual(runner.parseArgs(["--manifest", env.manifestPath]), { manifestPath: env.manifestPath });
  assert.equal(env.state.identityChecked, 0);
  assert.equal(env.state.endpointResolved, 0);
});

test("actor, recipient/spender/amount/minOut/deadline/calldata, value, gas, slippage, count, order, and reuse drift reject before upstream", async (t) => {
  const base = callFixture();
  const dataMutations = [
    `0xa9059cbb${"3".repeat(64)}${"1".repeat(64)}${"2".repeat(64)}`,
    `0xa9059cbb${"0".repeat(64)}${"3".repeat(64)}${"2".repeat(64)}`,
    `0x095ea7b3${"3".repeat(64)}${"1".repeat(64)}${"2".repeat(64)}`,
    `0x095ea7b3${"0".repeat(64)}${"3".repeat(64)}${"2".repeat(64)}`,
    `0x38ed1739${"0".repeat(64)}${"3".repeat(64)}${"2".repeat(64)}`,
    `0x38ed1739${"0".repeat(64)}${"1".repeat(64)}${"3".repeat(64)}`,
  ];
  const variants = [
    { actor: OTHER_ACTOR }, { to: OTHER_TARGET }, { valueWei: "1" }, { gasLimit: "999999" }, { slippageBps: "49" },
    ...dataMutations.map((data) => ({ data })),
  ];
  for (const [index, mutation] of variants.entries()) {
    const env = environment(t, { approvedCalls: [base], manifest: { calls: [{ ...base, ...mutation }] } });
    await assert.rejects(run(env), /SCOPE_(?:ACTOR|TARGET|VALUE|CALLDATA|GAS|SLIPPAGE)_MISMATCH/, `variant ${index}`);
    assert.equal(env.state.endpointResolved, 0);
  }
  const second = callFixture({ id: "c2", to: OTHER_TARGET, data: `0x095ea7b3${"4".repeat(192)}`, gasLimit: "500000", slippageBps: "25" });
  for (const calls of [[base], [second, base], [base, base]]) {
    const env = environment(t, { approvedCalls: [base, second], manifest: { calls } });
    await assert.rejects(run(env), /(?:SCOPE_(?:ACTION_COUNT_OR_ORDER|ACTOR|TARGET|CALLDATA)_MISMATCH|MANIFEST_CALLS_INVALID)/);
    assert.equal(env.state.endpointResolved, 0);
  }
});

test("missing/expired authorization and path, digest, or version identity failures happen before endpoint access", async (t) => {
  const absent = environment(t);
  fs.rmSync(absent.batchPath);
  await assert.rejects(run(absent), /BATCH_NOT_VALID:ABSENT/);
  assert.equal(absent.state.identityChecked, 0);
  assert.equal(absent.state.endpointResolved, 0);
  for (const code of ["ANVIL_PATH_NOT_ABSOLUTE", "ANVIL_DIGEST_MISMATCH", "ANVIL_VERSION_MISMATCH"]) {
    const env = environment(t, { identityFailure: code });
    await assert.rejects(run(env), new RegExp(code));
    assert.equal(env.state.identityChecked, 1);
    assert.equal(env.state.endpointResolved, 0);
    assert.equal(env.state.started, 0);
  }
});

test("default Anvil execution fails closed on unsupported host before endpoint access", { skip: process.platform === "linux" }, async (t) => {
  const env = environment(t);
  delete env.deps.verifyAnvilIdentity;
  await assert.rejects(run(env), /ANVIL_STABLE_EXECUTION_UNSUPPORTED/);
  assert.equal(env.state.endpointResolved, 0);
});

test("Linux verifier executes the pinned open descriptor", { skip: process.platform !== "linux" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "descriptor-anvil-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = path.join(dir, "anvil-probe");
  fs.writeFileSync(executablePath, "#!/bin/sh\nprintf '%s\\n' 'descriptor-version'\n");
  fs.chmodSync(executablePath, 0o700);
  const sha256 = `0x${require("node:crypto").createHash("sha256").update(fs.readFileSync(executablePath)).digest("hex")}`;
  const verified = runner.verifyAnvilIdentity({ executablePath, sha256, version: "descriptor-version" });
  assert.equal(verified.versionMatched, true);
  assert.equal(verified.identity.execPath, "/proc/self/fd/3");
  runner.closeAnvilDescriptor(verified.identity);
  assert.doesNotThrow(() => runner.closeAnvilDescriptor(verified.identity));
});

test("consume/revoke setup races fail closed and a second invocation cannot reuse authorization", async (t) => {
  const consumed = environment(t, { onQualify: ({ authOptions, signedBatch }) => batch.consumeBatch({ ...authOptions, expectedBatchCommitment: batch.commitment(signedBatch), manifestCommitment: `0x${"55".repeat(32)}`, runId: "racer" }) });
  await assert.rejects(run(consumed), /BATCH_RECHECK_NOT_VALID:CONSUMED/);
  assert.equal(consumed.state.calls, 0);

  const revoked = environment(t, { onQualify: ({ authOptions, signedBatch }) => batch.revokeBatch({ ...authOptions, expectedBatchCommitment: batch.commitment(signedBatch), revocationRef: "race" }) });
  await assert.rejects(run(revoked), /BATCH_RECHECK_NOT_VALID:ABSENT/);
  assert.equal(revoked.state.calls, 0);

  const reused = environment(t);
  await run(reused, { runId: "first" });
  await assert.rejects(run(reused, { runId: "second" }), /BATCH_NOT_VALID:CONSUMED/);
  assert.equal(reused.state.calls, 1);
});

test("consume or revoke after final recheck but before reservation loses atomically without calls", async (t) => {
  const consumed = environment(t);
  const consumeNormally = consumed.deps.consumeAuthorization;
  consumed.deps.consumeAuthorization = async (request) => {
    await consumeNormally({ ...request, manifestCommitment: `0x${"66".repeat(32)}`, runId: "final-race-consume" });
    return consumeNormally(request);
  };
  await assert.rejects(run(consumed, { runId: "loser" }), /BATCH_TERMINAL_CONSUMED/);
  assert.equal(consumed.state.calls, 0);

  const revoked = environment(t);
  revoked.deps.consumeAuthorization = async (request) => {
    batch.revokeBatch({ ...revoked.authOptions, expectedBatchCommitment: request.expectedBatchCommitment, revocationRef: "final-race-revoke" });
    return batch.consumeBatch({ ...revoked.authOptions, ...request });
  };
  await assert.rejects(run(revoked, { runId: "loser" }), /BATCH_TERMINAL_(?:REVOKED|ABSENT)/);
  assert.equal(revoked.state.calls, 0);
});

test("two concurrent runners have exactly one atomic consumption winner", async (t) => {
  const env = environment(t);
  const attempts = await Promise.allSettled([run(env, { runId: "parallel-a" }), run(env, { runId: "parallel-b" })]);
  assert.equal(attempts.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((row) => row.status === "rejected").length, 1);
  assert.equal(env.state.calls, 1);
  assert.equal(batch.batchState(env.authOptions).state, batch.STATES.CONSUMED);
});

test("false revert, watched divergence, and failed independent invalidation proof all reject rollback", async (t) => {
  const falseRevert = environment(t, { revertResult: false });
  await assert.rejects(run(falseRevert), /SNAPSHOT_REVERT_UNCONFIRMED/);
  const divergence = environment(t, { stickyRevert: true });
  await assert.rejects(run(divergence), /SNAPSHOT_ROLLBACK_MISMATCH/);
  const reusableSnapshot = environment(t, { invalidationResult: true });
  await assert.rejects(run(reusableSnapshot), /SNAPSHOT_INVALIDATION_UNCONFIRMED/);
});

test("manifest validation and exact integer economics remain fail closed", () => {
  const invalid = manifestFixture();
  delete invalid.calls[0].slippageBps;
  assert.throws(() => runner.validateManifest(invalid), /MANIFEST_CALLS_INVALID/);
  const insufficientWatch = manifestFixture({ watch: [{ id: "only", token: "native", holder: ACTOR, decimals: "18", role: "attacker" }] });
  assert.throws(() => runner.validateManifest(insufficientWatch), /MANIFEST_WATCH_COVERAGE_INVALID/);
  const manifest = manifestFixture({ pricesUsd: [{ token: TOKEN, usdPerToken: "1.23456789" }] });
  assert.deepEqual(runner.computeNetUsdEstimate(manifest, [{ token: TOKEN, holder: ACTOR, role: "attacker", decimals: "6", deltaRaw: "9007199254740993" }], 0n), { value: "11119998978.735160", positive: true, nativeExecutionCostsCaptured: false });
});

test("p1b seam: all expectations are required together and strictly encoded", async () => {
  let loads = 0;
  const deps = { loadAuthorization: async () => { loads += 1; throw new Error("must-not-load"); } };
  await assert.rejects(runner.runForkValidation({ manifestPath: "missing", deps, expectedManifestBytesSha256: `0x${"11".repeat(32)}` }), /RUNNER_EXPECTATIONS_INCOMPLETE/);
  await assert.rejects(runner.runForkValidation({ manifestPath: "missing", deps, expectedManifestBytesSha256: `0x${"11".repeat(32)}`, expectedManifestCommitment: `0x${"22".repeat(32)}`, expectedBatchCommitment: `0X${"33".repeat(32)}` }), /RUNNER_EXPECTATION_INVALID/);
  assert.equal(loads, 0);
});

test("p1b seam: byte, semantic, and batch mismatches stop before upstream", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p1b-runner-seam-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = manifestFixture(), watchKeys = new Set(manifest.watch.map((row) => `${row.token}:${row.holder}`));
  for (const entry of runner.minimumBalanceWatch(manifest.calls)) if (!watchKeys.has(`${entry.token}:${entry.holder}`)) { manifest.watch.push({ id: `seam-${manifest.watch.length}`, ...entry, decimals: "18" }); watchKeys.add(`${entry.token}:${entry.holder}`); }
  const bytes = Buffer.from(JSON.stringify(manifest)), manifestPath = path.join(directory, "manifest.json"); fs.writeFileSync(manifestPath, bytes);
  const byteHash = `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`, semanticHash = runner.manifestCommitment(manifest);
  const state = { loads: 0, identity: 0, endpoint: 0 };
  const initialBatch = batchScope(manifest.calls, Date.now()), batchHash = batch.commitment(initialBatch);
  const authorization = { state: batch.STATES.VALID, batch: initialBatch, batchCommitment: batchHash, scopeCommitment: `0x${"55".repeat(32)}`, approval: { approverId: "synthetic" } };
  const deps = { loadAuthorization: async () => { state.loads += 1; return authorization; }, verifyAnvilIdentity: async () => { state.identity += 1; throw new Error("ENTRY_REACHED"); }, resolveUpstream: async () => { state.endpoint += 1; throw new Error("must-not-resolve"); } };
  const expected = { expectedManifestBytesSha256: byteHash, expectedManifestCommitment: semanticHash, expectedBatchCommitment: batchHash };
  await assert.rejects(runner.runForkValidation({ manifestPath, deps, ...expected, expectedManifestBytesSha256: `0x${"66".repeat(32)}` }), /MANIFEST_BYTES_COMMITMENT_MISMATCH/);
  await assert.rejects(runner.runForkValidation({ manifestPath, deps, ...expected, expectedManifestCommitment: `0x${"77".repeat(32)}` }), /MANIFEST_SEMANTIC_COMMITMENT_MISMATCH/);
  await assert.rejects(runner.runForkValidation({ manifestPath, deps, ...expected, expectedBatchCommitment: `0x${"88".repeat(32)}` }), /BATCH_EXPECTED_COMMITMENT_MISMATCH/);
  assert.equal(state.identity, 0); assert.equal(state.endpoint, 0);
  await assert.rejects(runner.runForkValidation({ manifestPath, deps }), /ENTRY_REACHED/);
  assert.equal(state.identity, 1); assert.equal(state.endpoint, 0);
});

test("p1b seam: raw-byte assertion precedes fatal UTF-8 decoding", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p1b-runner-utf8-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "manifest.json"), bytes = Buffer.from([0xff, 0xfe]); fs.writeFileSync(manifestPath, bytes);
  const common = { manifestPath, deps: { loadAuthorization: async () => { throw new Error("must-not-load"); } }, expectedManifestCommitment: HASH, expectedBatchCommitment: HASH };
  await assert.rejects(runner.runForkValidation({ ...common, expectedManifestBytesSha256: `0x${"99".repeat(32)}` }), /MANIFEST_BYTES_COMMITMENT_MISMATCH/);
  const exact = `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  await assert.rejects(runner.runForkValidation({ ...common, expectedManifestBytesSha256: exact }), /MANIFEST_UTF8_INVALID/);
});
