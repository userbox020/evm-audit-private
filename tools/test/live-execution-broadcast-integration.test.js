#!/usr/bin/env node
"use strict";

// live-execution-broadcast-integration.test.js
//
// Integration coverage for the REAL seam:
//   canonical batch (live-execution-batch.js)
//     -> consumeBatch
//     -> live-execution-broadcast-adapter.js (runBroadcast)
//     -> live-execution-broadcast-dispatch.js (dispatchOnce)
//
// Existing broadcast tests inject a MOCKED adapter, so a regression in the
// dispatcher's `deps` forwarding (the historical defect: the batch was consumed,
// the adapter ran without the transport/signer deps, failed closed, and the
// dispatcher still reported success) cannot be observed. This file binds the
// real canonical module to a temp `batchPath` through the DATA-only
// `deps.batchOptions` contract and passes that to the dispatcher, which forwards
// `deps` to the real adapter. Module injection (`deps.batch`) is deliberately not
// available: R1 removed it.
//
// MOCKED: transport, signer (in-memory throwaway EOA), send-endpoint resolver.
// REAL:   live-execution-batch.js, live-execution-batch-fixture.js,
//         live-execution-broadcast-adapter.js, live-execution-broadcast-dispatch.js.
//
// No coordination/ path is read or written; all state lives under os.tmpdir().

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Wallet, keccak256 } = require("ethers");
const batchTool = require("../live-execution-batch.js");
const adapter = require("../live-execution-broadcast-adapter.js");
const dispatch = require("../live-execution-broadcast-dispatch.js");
const { createApprovalFixture } = require("./live-execution-batch-fixture.js");

const NOW_MS = Date.parse("2026-09-12T12:00:00.000Z");
const KEY = `0x${"11".repeat(32)}`;
const TARGET = "0x2222222222222222222222222222222222222222";
const OTHER_TARGET = "0x3333333333333333333333333333333333333333";
const DATA = `0xa9059cbb${"0".repeat(64)}`;
const OTHER_DATA = `0xa9059cbb${"1".repeat(64)}`;
const SEND_URL = "https://send.invalid";

const tempDirs = new Set();
const ALL_RESULTS = [];
const ALL_PUBLISHED = [];

function tempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-broadcast-integration-"));
  tempDirs.add(dir);
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
  const approval = createApprovalFixture(dir);
  const wallet = new Wallet(KEY);
  return {
    dir,
    wallet,
    accountRef: wallet.address.toLowerCase(),
    batchPath: path.join(dir, "live-execution-batch.json"),
    registryPath: approval.registryPath,
    registrySha256: approval.registrySha256,
    sign: approval.sign,
  };
}

function actionFor(env, overrides = {}) {
  return { from: env.accountRef, to: TARGET, valueWei: "0", data: DATA, gasLimit: "100000", slippageBps: "50", ...overrides };
}

function v3Scope(env, overrides = {}) {
  const actions = overrides.actions || [
    actionFor(env),
    actionFor(env, { to: OTHER_TARGET, data: OTHER_DATA, gasLimit: "120000", slippageBps: "25" }),
  ];
  return {
    schema: batchTool.SCHEMA_V3,
    batchId: "a1b2c3d4e5f60718",
    mode: "TESTNET",
    chainId: "1",
    accountRef: env.accountRef,
    actions,
    gasCeiling: "1000000",
    feeCap: { maxFeePerGasWei: "1000000000", maxPriorityFeePerGasWei: "1000000000" },
    issuedAt: "2026-09-12T00:00:00.000Z",
    notBefore: "2026-09-12T00:00:00.000Z",
    expiresAt: "2026-09-13T00:00:00.000Z",
    nonce: "0123456789abcdef",
    ...overrides,
  };
}

function writeSigned(env, signed) {
  batchTool.writeBatch(signed, {
    batchPath: env.batchPath,
    registryPath: env.registryPath,
    registrySha256: env.registrySha256,
    requireDurable: false,
  });
}

function writeRaw(env, value) {
  fs.writeFileSync(env.batchPath, `${JSON.stringify(value, null, 2)}\n`);
}

function rawState(env) {
  return batchTool.batchState({
    batchPath: env.batchPath,
    registryPath: env.registryPath,
    registrySha256: env.registrySha256,
    now: () => NOW_MS,
  });
}

function consumeDirect(env, signed, runId) {
  return batchTool.consumeBatch({
    batchPath: env.batchPath,
    registryPath: env.registryPath,
    registrySha256: env.registrySha256,
    requireDurable: false,
    expectedBatchCommitment: batchTool.commitment(signed),
    manifestCommitment: batchTool.scopeCommitment(signed),
    runId,
    now: () => NOW_MS,
  });
}

function makeTransport(config = {}) {
  const calls = { methods: [], sendRaw: 0, chainId: 0, nonce: 0, receipt: 0, rawTxs: [], txHashes: [], receiptFor: [] };
  const transport = async (_url, method, params) => {
    calls.methods.push(method);
    if (method === "eth_chainId") {
      calls.chainId += 1;
      return typeof config.chainId === "function" ? config.chainId() : (config.chainId ?? "0x1");
    }
    if (method === "eth_getTransactionCount") {
      calls.nonce += 1;
      return typeof config.nonce === "function" ? config.nonce() : (config.nonce ?? "0x5");
    }
    if (method === "eth_sendRawTransaction") {
      calls.sendRaw += 1;
      calls.rawTxs.push(params[0]);
      if (config.sendError) throw new Error("synthetic send failure");
      const hash = config.txHash !== undefined ? config.txHash : keccak256(params[0]);
      calls.txHashes.push(hash);
      return hash;
    }
    if (method === "eth_getTransactionReceipt") {
      calls.receipt += 1;
      calls.receiptFor.push(params[0]);
      if (typeof config.receipt === "function") return config.receipt(params[0]);
      return config.receipt === undefined ? { status: "0x1", transactionHash: params[0] } : config.receipt;
    }
    throw new Error("unexpected transport method");
  };
  return { transport, calls };
}

function makeDeps(env, config = {}) {
  const { transport, calls } = makeTransport(config);
  const published = [];
  const counters = { endpointResolve: 0, loadSigner: 0 };
  const deps = {
    // R1: DATA-only path binding. The real module is always consulted; there is
    // no `deps.batch` behavior injection.
    batchOptions: { batchPath: env.batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256 },
    transport,
    loadSigner: config.loadSigner || (async () => { counters.loadSigner += 1; return env.wallet; }),
    resolveSendEndpoint: async () => { counters.endpointResolve += 1; return SEND_URL; },
    now: () => NOW_MS,
    publishResult: (value) => { published.push(value); return { written: true, writeOnce: true }; },
  };
  return { deps, calls, published, counters };
}

function dispatchArgs(signed, deps, overrides = {}) {
  return {
    expectedBatchCommitment: batchTool.commitment(signed),
    confirmBatchId: signed.batchId,
    signerRef: "key-ref",
    endpointRef: "endpoint-ref",
    deps,
    ...overrides,
  };
}

function record(result, published) {
  ALL_RESULTS.push(result);
  for (const envelope of published || []) ALL_PUBLISHED.push(envelope);
  return result;
}

function assertSanitized(value, label) {
  const serialized = JSON.stringify(value);
  assert.equal(typeof serialized, "string", label);
  assert.equal(/https?:\/\//iu.test(serialized), false, `${label}: URL leaked`);
  assert.equal(/[A-Za-z]:\\/u.test(serialized), false, `${label}: Windows absolute path leaked`);
  assert.equal(/(?:^|[\s"'(])\/(?:home|root|mnt|users|var|etc|tmp|opt|coordination)\//iu.test(serialized), false, `${label}: POSIX absolute path leaked`);
  assert.equal(serialized.includes(KEY), false, `${label}: 0x private key leaked`);
  assert.equal(serialized.includes(KEY.slice(2)), false, `${label}: raw private key leaked`);
  assert.equal(serialized.includes("key-ref"), false, `${label}: signer ref leaked`);
  assert.equal(serialized.includes("endpoint-ref"), false, `${label}: endpoint ref leaked`);
  assert.equal(serialized.includes("coordination"), false, `${label}: coordination path leaked`);
  for (const dir of tempDirs) assert.equal(serialized.includes(dir), false, `${label}: temp dir leaked`);
}

test("[1] end-to-end real seam: consume -> real adapter -> dispatcher broadcasts once per action", async (t) => {
  const env = tempEnv(t);
  const signed = env.sign(v3Scope(env));
  writeSigned(env, signed);
  assert.equal(rawState(env).state, batchTool.STATES.VALID, "fixture batch is canonically VALID before dispatch");

  const { deps, calls, published, counters } = makeDeps(env);
  assert.equal(deps.runBroadcast, undefined, "no adapter is injected; the real adapter must run via forwarded deps");

  const commitment = batchTool.commitment(signed);
  const scopeValue = batchTool.scopeCommitment(signed);
  const result = record(await dispatch.dispatchOnce(dispatchArgs(signed, deps)), published);

  assert.equal(result.status, dispatch.STATUS.BROADCASTED);
  assert.equal(result.adapterStatus, "COMPLETED");
  assert.equal(result.blocker, null);
  assert.equal(calls.sendRaw, 2, "exactly one eth_sendRawTransaction per action");
  assert.equal(calls.methods.filter((method) => method === "eth_sendRawTransaction").length, 2);
  assert.equal(calls.receipt, 2, "one receipt per action");
  assert.deepEqual(result.counts, { actions: 2, attempts: 2, sends: 2, confirmations: 2 });
  assert.equal(calls.txHashes.length, 2);
  for (let index = 0; index < calls.txHashes.length; index += 1) {
    assert.equal(calls.txHashes[index], keccak256(calls.rawTxs[index]), "node hash equals the signed raw tx hash");
    assert.equal(calls.receiptFor[index], calls.txHashes[index], "receipt is bound to the sent tx hash");
  }

  const final = rawState(env);
  assert.equal(final.state, batchTool.STATES.CONSUMED, "final canonical state is CONSUMED");
  assert.equal(final.batchCommitment, commitment);
  assert.equal(final.scopeCommitment, scopeValue);
  assert.equal(final.terminal.state, batchTool.STATES.CONSUMED);
  assert.equal(final.terminal.batchCommitment, commitment);
  assert.equal(final.terminal.manifestCommitment, scopeValue);
  assert.equal(final.terminal.runId, result.runId);
  assert.equal(counters.endpointResolve, 1, "F2: preflight resolution is reused by the adapter");
  assert.equal(counters.loadSigner, 1);

  assert.equal(published.length, 1, "exactly one published envelope");
  assert.equal(published[0].status, "BROADCASTED");
  assert.equal(published[0].adapterStatus, "COMPLETED");
  assertSanitized(result, "happy-path result");
  assertSanitized(published[0], "happy-path published envelope");
});

test("[2] forged approval (signature or signed scope) is refused before any transport call", async (t) => {
  const cases = [
    ["tampered signature", (signed) => { signed.approval.signature = Buffer.alloc(64).toString("base64"); }],
    ["tampered chainId", (signed) => { signed.chainId = "2"; }],
    ["tampered action target", (signed) => { signed.actions[0].to = "0x9999999999999999999999999999999999999999"; }],
  ];
  for (const [label, tamper] of cases) {
    const env = tempEnv(t);
    const signed = env.sign(v3Scope(env));
    tamper(signed);
    writeRaw(env, signed); // writeBatch would itself reject a forged approval
    assert.equal(rawState(env).state, batchTool.STATES.INVALID, `${label}: canonical state is INVALID`);

    const { deps, calls, published, counters } = makeDeps(env);
    const result = record(await dispatch.dispatchOnce(dispatchArgs(signed, deps)), published);

    assert.equal(result.status, dispatch.STATUS.REFUSED, label);
    assert.equal(result.blocker, "DISPATCH_BATCH_STATE_INVALID", label);
    assert.equal(calls.methods.length, 0, `${label}: transport never called`);
    assert.equal(calls.sendRaw, 0, `${label}: nothing sent`);
    assert.equal(counters.endpointResolve, 0, `${label}: endpoint is never probed`);
    assert.equal(counters.loadSigner, 0, `${label}: signer is never loaded`);
    assert.equal(published.length, 0, `${label}: nothing published`);
  }
});

test("[3] HIGH-1: real adapter fails closed on VALID-but-unconsumed, then succeeds only after real consumeBatch", async (t) => {
  const env = tempEnv(t);
  const signed = env.sign(v3Scope(env, { actions: [actionFor(env)] }));
  writeSigned(env, signed);
  assert.equal(rawState(env).state, batchTool.STATES.VALID);

  const { deps, calls, counters } = makeDeps(env);
  const commitment = batchTool.commitment(signed);
  const scopeValue = batchTool.scopeCommitment(signed);
  const request = { batch: signed, runId: "high1-run", expectedBatchCommitment: commitment, scopeCommitment: scopeValue, signerRef: "key-ref", endpointRef: "endpoint-ref", deps };

  const before = await adapter.runBroadcast(request);
  assert.equal(before.status, adapter.STATUS.FAIL_CLOSED);
  assert.equal(before.blocker, adapter.BLOCKER.NOT_CONSUMED);
  assert.equal(before.blocker, "BROADCAST_NOT_CONSUMED");
  assert.equal(calls.methods.length, 0, "no endpoint/chain/nonce is touched before consumption");
  assert.equal(calls.sendRaw, 0);
  // Ordering instrument: the adapter must not touch the endpoint resolver or the
  // signer loader until the CONSUMED precondition holds.
  assert.equal(counters.endpointResolve, 0, "endpoint resolver untouched before CONSUMED");
  assert.equal(counters.loadSigner, 0, "signer loader untouched before CONSUMED");

  const marker = consumeDirect(env, signed, "high1-run");
  assert.equal(marker.state, batchTool.STATES.CONSUMED);
  assert.equal(rawState(env).state, batchTool.STATES.CONSUMED);

  const after = await adapter.runBroadcast(request);
  assert.equal(after.status, adapter.STATUS.COMPLETED);
  assert.equal(after.blocker, null);
  assert.equal(calls.sendRaw, 1, "exactly one send after the real consumption");
  assert.equal(calls.receipt, 1);
  assert.equal(counters.endpointResolve, 1, "endpoint resolved once, after CONSUMED");
  assert.equal(counters.loadSigner, 1, "signer loaded once, after CONSUMED");

  const wrongRun = await adapter.runBroadcast({ ...request, runId: "high1-other" });
  assert.equal(wrongRun.status, adapter.STATUS.FAIL_CLOSED);
  assert.equal(wrongRun.blocker, "BROADCAST_NOT_CONSUMED");
  assert.equal(calls.sendRaw, 1, "a mismatched runId cannot reuse the consumed marker");
  assert.equal(counters.loadSigner, 1, "no extra signer load on the runId mismatch");
});

test("[4] at-most-once: a second dispatchOnce refuses and total sends equal the action count", async (t) => {
  const env = tempEnv(t);
  const signed = env.sign(v3Scope(env));
  writeSigned(env, signed);
  const { deps, calls, published } = makeDeps(env);
  const args = dispatchArgs(signed, deps);

  const first = record(await dispatch.dispatchOnce(args), published);
  assert.equal(first.status, dispatch.STATUS.BROADCASTED);
  assert.equal(calls.sendRaw, 2, "first call sends one per action");

  const second = record(await dispatch.dispatchOnce(args), published);
  assert.equal(second.status, dispatch.STATUS.REFUSED);
  assert.equal(second.blocker, "DISPATCH_BATCH_STATE_CONSUMED");
  assert.equal(calls.sendRaw, 2, "second call never resends");

  assert.equal(published.length, 1, "the refused call publishes nothing");
  const terminals = fs.readdirSync(env.dir).filter((name) => name.startsWith("live-execution-batch-terminal-"));
  assert.equal(terminals.length, 1, "exactly one canonical terminal marker exists");
  assert.equal(rawState(env).state, batchTool.STATES.CONSUMED);
});

test("[5] MEDIUM-1 status mapping: adapter INCOMPLETE and FAIL_CLOSED never become BROADCASTED", async (t) => {
  const incompleteEnv = tempEnv(t);
  const incompleteSigned = incompleteEnv.sign(v3Scope(incompleteEnv, { actions: [actionFor(incompleteEnv)] }));
  writeSigned(incompleteEnv, incompleteSigned);
  const incomplete = makeDeps(incompleteEnv, { sendError: true });
  const incompleteResult = record(await dispatch.dispatchOnce(dispatchArgs(incompleteSigned, incomplete.deps)), incomplete.published);

  assert.equal(incompleteResult.status, dispatch.STATUS.INCOMPLETE);
  assert.notEqual(incompleteResult.status, dispatch.STATUS.BROADCASTED);
  assert.equal(incompleteResult.adapterStatus, "INCOMPLETE");
  assert.equal(incompleteResult.blocker, "DISPATCH_BROADCAST_INCOMPLETE");
  assert.equal(incomplete.calls.sendRaw, 1, "one send attempt, no resend");
  assert.equal(incompleteResult.counts.attempts, 1);
  // runCli's non-zero-exit contract is `result.status !== STATUS.BROADCASTED`.
  assert.equal(incompleteResult.status !== dispatch.STATUS.BROADCASTED, true);

  const closedEnv = tempEnv(t);
  const closedSigned = closedEnv.sign(v3Scope(closedEnv, { actions: [actionFor(closedEnv)] }));
  writeSigned(closedEnv, closedSigned);
  // F1(e): a wrong chain is now refused by the pre-consume probe, so the adapter
  // is reached only when the chain matches. Use a malformed nonce to force a
  // genuine post-consume adapter FAIL_CLOSED and keep the status-mapping contract
  // under test.
  const closed = makeDeps(closedEnv, { nonce: "0xzz" });
  const closedResult = record(await dispatch.dispatchOnce(dispatchArgs(closedSigned, closed.deps)), closed.published);

  assert.equal(closedResult.status, dispatch.STATUS.FAIL_CLOSED);
  assert.notEqual(closedResult.status, dispatch.STATUS.BROADCASTED);
  assert.equal(closedResult.adapterStatus, "FAIL_CLOSED");
  assert.equal(closedResult.blocker, "DISPATCH_BROADCAST_ADAPTER_FAIL_CLOSED");
  assert.equal(closed.calls.sendRaw, 0, "nonce mismatch aborts before any send");
  assert.equal(rawState(closedEnv).state, batchTool.STATES.CONSUMED, "post-consume adapter failure is terminal");
  assert.equal(closedResult.status !== dispatch.STATUS.BROADCASTED, true);
});

test("[6] sanitization: no dispatcher result or published envelope leaks a URL, key, ref, or path", () => {
  assert.equal(ALL_RESULTS.length >= 5, true, "dispatcher results were recorded");
  assert.equal(ALL_PUBLISHED.length >= 3, true, "published envelopes were recorded");
  for (const result of ALL_RESULTS) assertSanitized(result, "dispatcher result");
  for (const envelope of ALL_PUBLISHED) assertSanitized(envelope, "published envelope");
});
