"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const runner = require("../lib/rank1-aave-v4-runner.js"), proof = require("../lib/rank1-aave-v4-proof.js");
const guard = require("../lib/wallet-execution-guard.js"), transport = require("../lib/executor-pinned-rpc.js");
const { harness, preparedSeam, freeze, AT, HEAD, T, STOP, EXEC, address, hash, syntheticClock, offlineHeads, assertOnlyCapabilityTraces } = require("./rank1-full-unsigned.test.js");
const ROOT = path.resolve(__dirname, "../..");

test("exact operator approval and base batch caps load without network or a key", () => {
  const authorization = runner.loadAuthorization({ now: () => AT * 1000 }); authorization.assertCurrent();
  assert.equal(authorization.caps.gasCap, 1300000n); assert.equal(authorization.caps.feeCap, 1500000000n);
  assert.equal(authorization.caps.spendCap, 1950000000000000n); assert.equal(authorization.caps.maxFlashLoanUsdcRaw, 1008000000000n);
  assert.equal(authorization.caps.minProfitUsdc, 100000000n); assert.equal(authorization.caps.eventId, runner.EVENT_ID);
});
for (const [name, mutate] of Object.entries({
  unapproved: x => { x.approved = false; }, revoked: x => { x.revoked = true; }, expired: x => { x.expiresAt = "2026-10-23T23:59:59Z"; },
  scope: x => { x.scope.borrower = address(99); }, action: x => { x.scope.actions.pop(); }, mode: x => { x.scope.modes.pop(); },
  priorHash: x => { x.priorApproval.sha256 = "0".repeat(64); }, baseHash: x => { x.baseBatch.sha256 = "0".repeat(64); },
  fee: x => { x.caps.maxFeePerGasWei = "1500000001"; }, spend: x => { x.caps.maxNativeSpendPerTransactionWei = "1950000000000001"; },
  gas: x => { x.caps.maxExecuteGasLimit++; }, value: x => { x.caps.valueWei = "1"; }, profit: x => { x.caps.minProfitUsdcRaw = "0"; },
  slippage: x => { x.caps.maxSlippageBps++; }, attempts: x => { x.caps.signedAttemptsForThisCrossingEvent++; },
  replacement: x => { x.caps.replacementTransactionsAllowed = true; }, supersession: x => { x.supersession.fields.push("maxExecuteGasLimit"); },
})) test(`new gas amendment ${name} fails closed without changing original authority`, () => {
  const readFile = file => {
    const raw = fs.readFileSync(file); if (path.resolve(file) !== path.join(ROOT, runner.GAS_APPROVAL_PATH)) return raw;
    const amended = JSON.parse(raw); mutate(amended); return Buffer.from(JSON.stringify(amended));
  };
  assert.throws(() => runner.loadAuthorization({ readFile, now: () => AT * 1000 }), guard.ExecutionError);
});
test("missing gas amendment rejects; later amendment byte changes revoke an already loaded authorization", () => {
  let changed = false;
  const readFile = file => {
    if (path.resolve(file) !== path.join(ROOT, runner.GAS_APPROVAL_PATH)) return fs.readFileSync(file);
    if (!changed) throw new Error("OFFLINE_MISSING_PUBLIC_AMENDMENT");
    return fs.readFileSync(file);
  };
  assert.throws(() => runner.loadAuthorization({ readFile, now: () => AT * 1000 }), { code: "RANK1_AUTHORIZATION_UNAVAILABLE" });
  changed = true;
  let corrupt = false;
  const auth = runner.loadAuthorization({ now: () => AT * 1000, readFile: file => {
    const raw = readFile(file); return corrupt && path.resolve(file) === path.join(ROOT, runner.GAS_APPROVAL_PATH) ? Buffer.concat([raw, Buffer.from(" ")]) : raw;
  } });
  corrupt = true; assert.throws(auth.assertCurrent, { code: "RANK1_AUTHORIZATION_COMMITMENT_MISMATCH" });
});
test("new gas amendment is revalidated after PREPARED persistence before signing", async t => {
  const f = await harness(t, { revokeGasPreSign: true }); const out = await f.run(["--loop"]);
  assert.equal(out.reason, "RANK1_AUTHORIZATION_INVALID_OR_EXPIRED"); assert.equal(out.exitCode, 2); assert.equal(f.state.signers, 0);
  const [row] = guard.readJournals(f.dirs.journalDir); assert.equal(row.record.stage, "ABORTED_UNSIGNED"); assert.equal(row.record.signerInvoked, false);
  for (const relative of [runner.GAS_APPROVAL_PATH, runner.APPROVAL_PATH, runner.BASE_PATH])
    assert.ok(f.state.reads.filter(row => row.relative === relative).length > 2);
});
const mutations = {
  target: value => { value.scope.targetId = "another-target"; }, plan: value => { value.scope.planId = "another-plan"; },
  borrower: value => { value.scope.borrower = address(99); }, spoke: value => { value.scope.spoke = address(99); },
  executor: value => { value.scope.executor = address(99); }, owner: value => { value.account = address(99); },
  expiry: value => { value.expiresAt = "2026-10-31T23:59:59Z"; }, revocation: value => { value.revoked = true; },
  reserves: value => { value.scope.debtReserveId = 3; }, batchHash: value => { value.baseBatch.sha256 = "0".repeat(64); },
  gas: value => { value.caps.maxExecuteGasLimit++; }, fee: value => { value.caps.maxFeePerGasWei = "250000001"; },
  native: value => { value.caps.maxNativeSpendPerTransactionWei = "550000000000001"; }, value: value => { value.caps.valueWei = "1"; },
  profit: value => { value.caps.minProfitUsdcRaw = "99999999"; }, flash: value => { value.caps.maxFlashLoanUsdcRaw = "1008000000001"; },
  slippage: value => { value.caps.maxSlippageBps = 51; }, variants: value => { value.caps.maxVariantsPerContext = 4; },
  attempts: value => { value.caps.signedAttemptsForThisCrossingEvent = 2; }, reset: value => { value.caps.automaticEventReset = true; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`authorization rejects wrong ${name}`, () => {
  const readFile = file => {
    const raw = fs.readFileSync(file); if (path.resolve(file) !== path.join(ROOT, runner.APPROVAL_PATH)) return raw;
    const value = JSON.parse(raw); mutate(value); return Buffer.from(JSON.stringify(value));
  };
  assert.throws(() => runner.loadAuthorization({ readFile, now: () => AT * 1000 }), guard.ExecutionError);
});
test("expired approval and changed base bytes fail closed", () => {
  assert.throws(() => runner.loadAuthorization({ now: () => Date.parse(proof.POLICY.expiresAt) }), /EXPIRED/);
  const readFile = file => Buffer.concat([fs.readFileSync(file), ...(path.resolve(file) === path.join(ROOT, runner.BASE_PATH) ? [Buffer.from(" ")] : [])]);
  assert.throws(() => runner.loadAuthorization({ readFile, now: () => AT * 1000 }), /COMMITMENT_MISMATCH/);
});
test("authorization is reloaded, not a cached approval object", () => {
  let revoked = false;
  const readFile = file => {
    const raw = fs.readFileSync(file); if (!revoked || path.resolve(file) !== path.join(ROOT, runner.APPROVAL_PATH)) return raw;
    const value = JSON.parse(raw); value.revoked = true; return Buffer.from(JSON.stringify(value));
  };
  const auth = runner.loadAuthorization({ readFile, now: () => AT * 1000 }); revoked = true;
  assert.throws(auth.assertCurrent, /INVALID_OR_EXPIRED/);
});
for (const check of [true, false]) test(`${check ? "check" : "execute"} healthy CURRENT has no execution trace, signer, lock or journal`, async t => {
  const f = await harness(t, { check, allowFuture: false }); const out = await f.run();
  assert.equal(out.mode, check ? "CHECK_ONLY" : "STANDBY"); assert.equal(f.state.signers, 0);
  assertOnlyCapabilityTraces(f.state); assert.equal(f.state.prepared.length, 0); assert.equal(f.state.sends, 0);
  assert.equal(fs.existsSync(f.dirs.lockRoot), false); assert.equal(fs.existsSync(f.dirs.journalDir), false);
});
test("check even when liquidatable has no execution trace or preparation/signing", async t => {
  const f = await harness(t, { check: true, currentLiquidatable: true, allowFuture: false });
  const out = await f.run(); assert.equal(out.mode, "CHECK_ONLY"); assert.equal(f.state.signers, 0); assert.equal(f.state.prepared.length, 0);
  assertOnlyCapabilityTraces(f.state); assert.equal(f.state.sends, 0);
  assert.equal(fs.existsSync(f.dirs.lockRoot), false); assert.equal(fs.existsSync(f.dirs.journalDir), false);
});
for (const [name, healthResult] of [
  ["truncated two-output health result", raw => raw.slice(0, 2 + 64 * 2)],
  ["extra health output", raw => raw + "0".repeat(64)],
]) test(`${name} fails the compiled four-output ABI contract`, async t => {
  const f = await harness(t, { check: true, allowFuture: false, healthResult }); const out = await f.run();
  assert.equal(out.reason, "RANK1_HEALTH_ABI_INVALID"); assert.equal(f.state.signers, 0); assert.equal(f.state.prepared.length, 0);
});
test("CURRENT first: lease trace is qualified lazily before the prepare seam", async t => {
  const f = await harness(t, { currentLiquidatable: true, prepare: preparedSeam }); const out = await f.run();
  assert.equal(out.reason, STOP); assert.equal(f.state.signers, 1); assert.equal(f.state.prepared[0].proof.mode, "CURRENT");
  assert.ok(f.state.calls.some(row => row.method === "debug_traceCall"));
  assert.equal(f.state.leases[0].current.qualifyCurrentTrace, undefined); assert.equal(typeof f.state.leases[0].qualifyCurrentTrace, "function");
});
test("CURRENT unavailable and no FUTURE produces explicit HOLD without preparation", async t => {
  const f = await harness(t, { currentLiquidatable: true, traceUnavailable: true, allowFuture: false }); const out = await f.run();
  assert.equal(out.mode, "HOLD"); assert.equal(out.currentHold, "TRACE_CAPABILITY_UNAVAILABLE"); assert.equal(f.state.signers, 0);
  assert.equal(f.state.prepared.length, 0); assert.equal(fs.existsSync(f.dirs.lockRoot), false);
});
test("a signer error named CURRENT trace unavailable is fatal, never a FUTURE retry", async t => {
  const f = await harness(t, { currentLiquidatable: true, prepare: preparedSeam, signerCode: "RANK1_CURRENT_TRACE_UNAVAILABLE" });
  const out = await f.run(["--loop"]); assert.equal(out.reason, "RANK1_CURRENT_TRACE_UNAVAILABLE");
  assert.equal(f.state.signers, 1); assert.equal(f.state.prepared.length, 1); assert.equal(f.state.prepared[0].proof.mode, "CURRENT");
  assert.equal(guard.readJournals(f.dirs.journalDir)[0].record.stage, "PREPARED");
});

for (const [name, options, code] of [
  ["more than six seconds", { afterPrepare: async (_, s, clock) => clock.wait(6001) }, "M1_V2_UNSIGNED_BUDGET_EXCEEDED"],
  ["less than two seconds headroom", { initialAge: 7000, afterPrepare: (_, s, clock) => clock.advance((AT + 12) * 1000 - clock.wall() - 1999) }, "M1_V2_CHILD_HEADROOM_INSUFFICIENT"],
  ["clock drift", { afterPrepare: (_, s, clock) => { clock.state.offset += 100; } }, "M1_V2_CLOCK_INVALID"],
  ["inflated before-gas floor", { changePrepared: p => freeze({ ...p, conservativeProfitBeforeGasWei: p.conservativeProfitBeforeGasWei + 1n }) }, "RANK1_PROFIT_FLOOR_MISMATCH"],
  ["changed final fees", { changePrepared: p => freeze({ ...p, transaction: { ...p.transaction, maxFeePerGas: p.transaction.maxFeePerGas - 1n } }) }, "RANK1_SETTLEMENT_BINDING_MISMATCH"],
  ["expired child submission", { afterPrepare: (_, s, clock) => clock.advance((AT + 12) * 1000 - clock.wall()) }, "NEXT_BLOCK_DEADLINE"],
]) test(`${name} rejects before signer`, async t => {
  const f = await harness(t, options); const out = await f.run(["--loop"]);
  assert.equal(out.reason, code); assert.equal(f.state.signers, 0); assert.equal(f.state.active, 0);
});
for (const [name, method, mutate, code] of [
  ["mismatched feed context", "readRank1Feeds", p => { p.contextTimestamp = String(AT); }, "RANK1_PROOF_CONTEXT_MISMATCH"],
  ["stale runtime pin", "verifyRank1Runtime", p => { p.pin.hash = hash(99); }, "RANK1_PROOF_PIN_MISMATCH"],
]) test(`${name} rejects before prepare/sign`, async t => {
  const original = proof[method]; t.mock.method(proof, method, async (...args) => { const p = structuredClone(await original(...args)); mutate(p); return freeze(p); });
  const f = await harness(t); const out = await f.run(["--loop"]);
  assert.equal(out.reason, code); assert.equal(f.state.prepared.length, 0); assert.equal(f.state.signers, 0);
});
test("live owner mismatch rejects and drains proof work", async t => {
  const f = await harness(t, { wrongOwner: true }); const out = await f.run(["--loop"]);
  assert.equal(out.mode, "HOLD"); assert.equal(f.state.signers, 0); assert.equal(f.state.prepared.length, 0); assert.equal(f.state.active, 0);
});
test("pre-sign revocation revalidation prevents signer and records only ABORTED_UNSIGNED", async t => {
  const f = await harness(t, { revokePreSign: true }); const out = await f.run(["--loop"]);
  assert.equal(out.reason, "RANK1_AUTHORIZATION_INVALID_OR_EXPIRED"); assert.equal(f.state.signers, 0);
  const [row] = guard.readJournals(f.dirs.journalDir); assert.equal(row.record.stage, "ABORTED_UNSIGNED"); assert.equal(row.record.signerInvoked, false);
});
for (const stage of ["PREPARED", "SENT", "UNCERTAIN", "RECEIPT_VERIFIED", "REVERTED"]) test(`${stage} event survives restart: HOLD, no signing or reset`, async t => {
  const f = await harness(t, { currentLiquidatable: true, prepare: preparedSeam, allowFuture: false });
  guard.atomicJson(path.join(f.dirs.journalDir, "prior.json"), { schema: "wallet-execution-journal/v1", stage, chainId: 1, owner: T.owner,
    executedAt: new Date(AT * 1000).toISOString(), txHash: stage === "PREPARED" ? null : hash(99),
    intent: { rank1EventId: runner.EVENT_ID, targetId: T.id, to: T.executor } });
  const before = fs.readFileSync(path.join(f.dirs.journalDir, "prior.json")); const out = await f.run();
  assert.equal(out.mode, "HOLD"); assert.equal(f.state.signers, 0); assert.equal(f.state.prepared.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.dirs.journalDir, "prior.json")), before);
  assert.equal(out.reason, stage === "PREPARED" ? "PREPARED_INTENT_REQUIRES_MANUAL_RECONCILIATION" :
    ["RECEIPT_VERIFIED", "REVERTED"].includes(stage) ? "RANK1_EVENT_ALREADY_ATTEMPTED" : "TX_ALREADY_PENDING_ON_SAME_WALLET");
});
test("sanitized HOLD never persists exception text or untrusted error codes", async t => {
  const f = await harness(t, { currentLiquidatable: true, prepare: async () => { throw new guard.ExecutionError("https://offline.invalid/PRIVATE_TEST_TEXT"); } });
  const out = await f.run(); assert.equal(out.reason, "EXECUTION_FAILED"); assert.equal(f.state.signers, 0);
  assert.doesNotMatch(JSON.stringify(f.state.outputs), /PRIVATE_TEST_TEXT|offline.invalid/);
});
test("throwing signer leaves persistent PREPARED journal; actual second guard attempt rejects", async t => {
  const f = await harness(t, { currentLiquidatable: true, prepare: preparedSeam });
  assert.equal((await f.run()).reason, STOP); assert.equal(f.state.signers, 1);
  await assert.rejects(guard.executeGuarded({ ...f.dirs, intent: { to: T.executor }, receiptRpc: () => null,
    prepare: () => assert.fail("SECOND_PREPARATION_FORBIDDEN"), signTransaction: () => assert.fail("SECOND_SIGNER_FORBIDDEN") }),
  { code: "PREPARED_INTENT_REQUIRES_MANUAL_RECONCILIATION" });
  assert.equal(guard.readJournals(f.dirs.journalDir)[0].record.stage, "PREPARED");
});

for (const fault of ["extra-file", "renamed-file", "missing-file", "wrong-event", "wrong-attempt", "wrong-action", "wrong-owner", "wrong-chain",
  "unchanged-preexisting", "modified-preexisting", "removed-preexisting", "PREPARED", "SENT", "UNCERTAIN", "signer-invoked", "extra-field"])
  test(`actual second-validation unsigned abort ${fault === "unchanged-preexisting" ? "can" : "cannot"} authorize recovery with ${fault}`, async t => {
    let fired = false, prior, priorBytes, persisted;
    const f = await harness(t, { currentLiquidatable: true, prepare: preparedSeam, autoHeads: true, maxRuns: 2,
      health: (child, state) => !child && state.leases.length === 1,
      wallHook: (_, clock, dirs) => {
        if (fired) return;
        const row = guard.readJournals(dirs.journalDir).find(row => row.record.stage === "PREPARED" && row.record.intent?.rank1EventId === runner.EVENT_ID);
        if (row) { persisted = row; fired = true; clock.advance(6001); }
      },
    });
    const actual = guard.executeGuarded;
    if (fault.endsWith("preexisting")) {
      let checks = 0;
      const caps = { gasCap: 100000n, spendCap: 1000000n, feeCap: 10n, dailyCap: null };
      await assert.rejects(actual({ ...f.dirs, now: f.clock.wall, intent: { to: T.executor, profitToken: T.usdc, targetId: "UNRELATED_PRIOR" },
        prepare: () => ({ transaction: { type: 2, chainId: 1, nonce: 0, to: T.executor, data: "0x1234", value: 0n,
          gasLimit: 30000n, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }, caps, conservativeProfitBeforeGasWei: 1000000n }),
        validate: () => { if (++checks === 2) throw new guard.ExecutionError("NEXT_BLOCK_DEADLINE"); return caps; },
        signTransaction: () => assert.fail("PRIOR_SIGNER_FORBIDDEN") }), { code: "NEXT_BLOCK_DEADLINE" });
      [prior] = guard.readJournals(f.dirs.journalDir); assert.equal(prior.record.stage, "ABORTED_UNSIGNED");
      priorBytes = fs.readFileSync(prior.file);
    }
    t.mock.method(guard, "executeGuarded", async args => {
      try { return await actual(args); } catch (error) {
        assert.equal(error.code, "M1_V2_UNSIGNED_BUDGET_EXCEEDED");
        const row = guard.readJournals(f.dirs.journalDir).find(row => row.file === persisted.file);
        assert.equal(row.record.stage, "ABORTED_UNSIGNED"); assert.equal(row.record.signerInvoked, false);
        if (fault === "extra-file") guard.atomicJson(path.join(f.dirs.journalDir, "additional.json"), row.record);
        else if (fault === "renamed-file") fs.renameSync(row.file, path.join(f.dirs.journalDir, "unbound.json"));
        else if (fault === "missing-file") fs.unlinkSync(row.file);
        else if (fault === "modified-preexisting") fs.appendFileSync(prior.file, " ");
        else if (fault === "removed-preexisting") fs.unlinkSync(prior.file);
        else {
          if (fault === "wrong-event") row.record.intent.rank1EventId = "UNBOUND_EVENT";
          if (fault === "wrong-attempt") row.record.intent.rank1AttemptId = "UNBOUND_ATTEMPT";
          if (fault === "wrong-action") row.record.intent.calldataHash = hash(999);
          if (fault === "wrong-owner") row.record.owner = address(99);
          if (fault === "wrong-chain") row.record.chainId = 8453;
          if (["PREPARED", "SENT", "UNCERTAIN"].includes(fault)) { row.record.stage = fault; row.record.txHash = fault === "PREPARED" ? null : hash(99); }
          if (fault === "signer-invoked") row.record.signerInvoked = true;
          if (fault === "extra-field") row.record.signedTransactionBinding = "REJECTED";
          guard.atomicJson(row.file, row.record);
        }
        throw error;
      }
    });
    const out = await f.run(["--loop"]); assert.equal(fired, true);
    if (fault === "unchanged-preexisting") {
      assert.equal(out.mode, "STANDBY"); assert.equal(out.exitCode, 0); assert.equal(f.state.signers, 0);
      assert.ok(out.pin.number > HEAD); assert.deepEqual(fs.readFileSync(prior.file), priorBytes);
      assert.equal(guard.readJournals(f.dirs.journalDir).length, 2); return;
    }
    assert.equal(out.exitCode, 2);
    assert.equal(f.state.leases.length, 1); assert.equal(f.state.signers, 0); assert.equal(out.terminal, true);
    assert.ok(f.state.outputs.every(row => !row.scheduled));
  });
test("unbound aborted addition before PREPARED is not this attempt's unsigned-abort evidence", async t => {
  const f = await harness(t, { currentLiquidatable: true, maxRuns: 3, prepare: preparedSeam,
    afterPrepare: (_, state, clock) => {
      guard.atomicJson(path.join(f.dirs.journalDir, "unbound.json"), { schema: "wallet-execution-journal/v1", stage: "ABORTED_UNSIGNED",
        chainId: 1, owner: T.owner, executedAt: new Date(clock.wall()).toISOString(), txHash: null, signerInvoked: false,
        abortPhase: "PRE_SIGN_VALIDATION", abortedAt: new Date(clock.wall()).toISOString(), reason: "M1_V2_UNSIGNED_BUDGET_EXCEEDED",
        intent: { targetId: T.id, rank1EventId: runner.EVENT_ID, to: T.executor } });
      clock.advance(6001);
    } });
  const out = await f.run(["--loop"]); assert.equal(out.exitCode, 2); assert.equal(f.state.leases.length, 1); assert.equal(f.state.signers, 0);
});
for (const disguise of [false, true]) test(`actual signer WALLET_LOCK_HELD remains terminal${disguise ? " even with an unsigned-looking journal" : ""}`, async t => {
  const f = await harness(t, { currentLiquidatable: true, prepare: preparedSeam, signerCode: "WALLET_LOCK_HELD", maxRuns: 3 });
  if (disguise) {
    const actual = guard.executeGuarded;
    t.mock.method(guard, "executeGuarded", async args => {
      try { return await actual(args); } catch (error) {
        const [row] = guard.readJournals(f.dirs.journalDir); assert.equal(row.record.stage, "PREPARED");
        guard.atomicJson(row.file, { ...row.record, stage: "ABORTED_UNSIGNED", signerInvoked: false, abortPhase: "PRE_SIGN_VALIDATION",
          abortedAt: new Date(f.clock.wall()).toISOString(), reason: error.code });
        throw error;
      }
    });
  }
  const out = await f.run(["--loop"]); assert.equal(out.reason, "WALLET_LOCK_HELD"); assert.equal(out.exitCode, 2);
  assert.equal(f.state.signers, 1); assert.equal(f.state.leases.length, 1); assert.ok(f.state.outputs.every(row => !row.scheduled));
});
test("WALLET_LOCK_HELD thrown after actual guard acquired its lock is terminal", async t => {
  const f = await harness(t, { currentLiquidatable: true, maxRuns: 3, prepare: () => { throw new guard.ExecutionError("WALLET_LOCK_HELD"); } });
  const out = await f.run(["--loop"]); assert.equal(out.reason, "WALLET_LOCK_HELD"); assert.equal(out.exitCode, 2);
  assert.equal(f.state.signers, 0); assert.equal(f.state.leases.length, 1); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
});

test("concurrent relay helper sends identical opaque bytes while primary acknowledgement is pending", async () => {
  const events = [], bytes = "OFFLINE_OPAQUE_BYTES_NOT_A_TRANSACTION"; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = runner.sendIdentical({ signed: bytes, assertDispatch() { events.push("guard"); },
    active: { async send(signed, dispatch) { dispatch(); assert.equal(signed, bytes); events.push("primary"); await gate; events.push("ack"); return hash(99); } },
    secondaryRpc: async (_, method, params, timeout, dispatch) => { dispatch(); assert.equal(method, "eth_sendRawTransaction"); assert.deepEqual(params, [bytes]); events.push("secondary"); } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(events.includes("secondary"), true); release();
  assert.equal(await pending, hash(99)); assert.ok(events.indexOf("secondary") < events.indexOf("ack"));
});
test("send guard failure occurs before any physical fetch (actual http transport)", async t => {
  let fetched = 0; t.mock.method(globalThis, "fetch", () => { fetched++; assert.fail("NO_FETCH"); });
  const fail = () => { throw new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED"); };
  await assert.rejects(runner.sendIdentical({ signed: "OFFLINE_NOT_SIGNED", assertDispatch: fail,
    active: { send: () => assert.fail("NO_PRIMARY") } }), { code: "PIN_EVIDENCE_INVALIDATED" });
  await assert.rejects(transport.httpRpc({ handle: "https://offline.invalid" }, "eth_sendRawTransaction", ["OFFLINE_NOT_SIGNED"], 100, fail));
  assert.equal(fetched, 0);
});
test("failed primary remains authoritative after secondary drain; revocation blocks not-yet-issued relay", async () => {
  let secondary = 0, invalid = false;
  const error = new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED");
  await assert.rejects(runner.sendIdentical({ signed: "OPAQUE", assertDispatch() {}, active: { send: async () => { throw error; } },
    secondaryRpc: () => { secondary++; } }), { code: error.code });
  assert.equal(secondary, 1); secondary = 0;
  await assert.rejects(runner.sendIdentical({ signed: "OPAQUE", assertDispatch() { if (invalid) throw error; },
    active: { send: async () => { invalid = true; return hash(99); } }, secondaryRpc: () => { secondary++; } }), { code: error.code });
  assert.equal(secondary, 0);
});

async function physicalRelays(t) {
  const clock = syntheticClock(), candidates = [{ family: "alchemy", handle: "https://offline-a.invalid" }, { family: "quicknode", handle: "https://offline-b.invalid" }];
  const state = { sends: [], active: 0, configuration: Object.freeze({}), armed: false, originHook: () => {}, fetchHook: () => {}, results: new Map() };
  const gates = [], hex = n => "0x" + BigInt(n).toString(16);
  const origin = handle => { if (state.armed) state.originHook(handle); return null; };
  t.mock.method(require("../shared-rpc.js"), "getOrigin", origin);
  const fetchMock = t.mock.method(globalThis, "fetch", async (handle, options) => {
    const { method, params } = JSON.parse(options.body);
    let result, error;
    if (method === "eth_sendRawTransaction") {
      const row = { handle, bytes: params[0], done: false }; state.sends.push(row); state.active++;
      let release; const gate = new Promise(resolve => { release = resolve; }); gates.push(release);
      state.fetchHook(row);
      try { await gate; result = state.results.get(handle) ?? hash(99); }
      finally { row.done = true; state.active--; }
      if (result instanceof Error) throw result;
    } else {
      await clock.wait(3); // Nonzero RTT, including the real factory qualification.
      if (params[1]?.blockHash === "0x" + "f".repeat(64)) error = { code: -32000, message: "unknown block" };
      else if (method === "eth_chainId") result = "0x1";
      else if (method === "eth_getBlockByNumber") {
        const n = params[0] === "latest" ? HEAD : Number(BigInt(params[0]));
        result = { number: hex(n), hash: hash(n), parentHash: hash(n - 1), stateRoot: hash(n + 77),
          timestamp: hex(AT + (n - HEAD) * 12), baseFeePerGas: hex(50000000), gasLimit: hex(60000000) };
      } else if (method === "eth_getCode") result = "0x6001";
      else if (method === "eth_call") result = hash(BigInt(params[1].blockHash));
      else assert.fail("UNMODELED_PHYSICAL_RPC");
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(error ? { error } : { result }) }));
  });
  const factory = transport.createM1HotPathFactory({ rpc: transport.httpRpc, now: clock.wall, monotonic: clock.mono,
    qualificationMode: "capability-v1", allowFuture: false,
    getCapabilityContext: () => ({ rpc: transport.httpRpc, fetch: fetchMock, configuration: state.configuration, inventoryRevision: 1 }) });
  t.after(async () => { gates.forEach(release => release()); await factory.close(); });
  let ready = factory.maintain({ candidates });
  for (let i = 0; ready.refreshing && i < 500; i++) { await new Promise(resolve => setImmediate(resolve)); ready = factory.maintain({ candidates }); }
  assert.equal(ready.selection, "READY");
  const { createM1V2Budget } = require("../execute-top-whale-trigger.js");
  const budget = createM1V2Budget({ wallNow: clock.wall, monotonicNow: clock.mono }), lease = await factory.acquire({ candidates });
  budget.bind(lease); budget.acceptUnsigned(lease, lease.current);
  const authorization = runner.loadAuthorization({ now: clock.wall, readFile: file => {
    const raw = fs.readFileSync(file);
    if (!state.gasRevoked || path.resolve(file) !== path.join(ROOT, runner.GAS_APPROVAL_PATH)) return raw;
    const changed = JSON.parse(raw); changed.revoked = true; return Buffer.from(JSON.stringify(changed));
  } });
  const dispatch = () => { lease.current.assertUsable(); authorization.assertCurrent(); budget.assertDispatch(lease, lease.current); lease.current.assertUsable(); };
  state.armed = true;
  return { state, clock, lease, budget, release: () => gates.forEach(fn => fn()),
    send: () => runner.sendIdentical({ active: lease.current, signed: "0x1234", assertDispatch: dispatch, secondaryRpc: transport.httpRpc }) };
}
test("actual primary + secondary httpRpc physical fetches overlap, identical bytes, both drain", async t => {
  const f = await physicalRelays(t); let done = false;
  const work = f.send().then(result => { done = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.state.sends.length, 2); assert.equal(done, false);
  assert.equal(f.state.active, 2); assert.ok(f.state.sends.every(row => row.bytes === "0x1234"));
  f.release(); assert.equal(await work, hash(99)); assert.equal(f.state.active, 0); assert.ok(f.state.sends.every(row => row.done));
});
for (const fault of ["clock", "trust", "gas-approval"]) test(`late ${fault} in HTTP setup prevents both not-yet-issued physical fetches`, async t => {
  const f = await physicalRelays(t);
  f.state.originHook = handle => {
    if (!handle.endsWith("/fast")) return;
    if (fault === "clock") f.clock.advance(Math.max(0, (AT + 12) * 1000 - f.clock.wall() - 1999));
    else if (fault === "gas-approval") f.state.gasRevoked = true;
    else f.state.configuration = Object.freeze({ revoked: true });
  };
  await assert.rejects(f.send()); assert.equal(f.state.sends.length, 0); assert.equal(f.state.active, 0);
});
test("revocation at first physical fetch cannot undo it, but prevents the other and drains issued work", async t => {
  const f = await physicalRelays(t); let done = false;
  f.state.fetchHook = () => { f.state.configuration = Object.freeze({ revoked: true }); };
  const work = assert.rejects(f.send()).then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.state.sends.length, 1); assert.equal(done, false);
  f.release(); await work; assert.equal(f.state.active, 0); assert.equal(f.state.sends[0].done, true);
});
for (const fault of ["primary-error", "secondary-hash"]) test(`actual physical ${fault}: drain both, never substitute secondary outcome`, async t => {
  const f = await physicalRelays(t);
  f.state.fetchHook = row => {
    if (fault === "primary-error" && !row.handle.endsWith("/fast")) f.state.results.set(row.handle, new Error("OFFLINE_PRIMARY_FAILURE"));
    if (fault === "secondary-hash" && row.handle.endsWith("/fast")) f.state.results.set(row.handle, hash(100));
  };
  const work = assert.rejects(f.send(), fault === "secondary-hash" ? { code: "SECONDARY_BROADCAST_HASH_MISMATCH" } : undefined);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.state.sends.length, 2);
  f.release(); await work; assert.equal(f.state.active, 0);
});

// Runner timing fixture only: no real transport qualification or optional work.
async function coldStartupFixture(t, { readyAt = 22500, healthDelay = 0, check = false, abortAt } = {}) {
  let f;
  const controller = new AbortController(), state = { maintains: [], acquireAt: null, closeAt: null, drainedAt: null, pending: 0, factories: 0 };
  t.mock.method(transport, "createM1HotPathFactory", profile => {
    state.factories++; state.pending++; let closing = null;
    return {
      maintain: () => {
        state.maintains.push(profile.monotonic());
        return { selection: profile.monotonic() >= readyAt ? "READY" : "HOLD", refreshing: true };
      },
      acquire: async () => {
        state.acquireAt = profile.monotonic(); assert.ok(state.acquireAt >= readyAt);
        const pin = freeze({ chainId: 1, number: HEAD, hash: hash(HEAD), timestamp: Math.floor(profile.now() / 1000) });
        const current = { pin, assertUsable: () => assert.equal(closing, null), code: () => assert.fail("NO_RUNTIME_PROOF_EXPECTED"),
          evidence: { independentFamilies: true, strictEvidence: true, fixedProviderPair: true, rawTimestamp: true,
            codeHashPinnedQualified: true, aliases: [1, 2], qualification: [1, 2].map(alias => ({ alias, qualified: true,
              strictEvidence: true, hashPinnedCallQualified: true, callUnknownHashRejected: true, codeHashPinnedQualified: true, codeUnknownHashRejected: true })) },
          call: async tx => {
            assert.deepEqual(tx, { to: T.executor, data: EXEC.encodeFunctionData("previewHealthFactor", [T.spoke, T.borrower]) });
            f.clock.advance(healthDelay);
            return EXEC.encodeFunctionResult("previewHealthFactor", [10n ** 18n + 1n, false, 1n, 1n]);
          }, recheck: async () => {},
        };
        return { current, cancelFuture() {}, isFutureReady: () => false, onFutureReady: () => () => {}, takeFuture: () => null };
      },
      close: () => closing ||= (async () => {
        state.closeAt = profile.monotonic(); await f.clock.wait(40); state.pending--; state.drainedAt = profile.monotonic();
      })(),
    };
  });
  f = await harness(t, { check, maxRuns: check ? Infinity : 1, signal: controller.signal,
    sleep: async (ms, _, clock) => {
      await clock.wait(ms);
      if (abortAt !== undefined && clock.mono() >= abortAt) controller.abort();
    },
    onOutput: row => {
      if (state.acquireAt === null) assert.equal(Object.hasOwn(row, "budget"), false);
      if (row.terminal) { assert.equal(state.pending, 0); assert.ok(state.drainedAt !== null); }
    },
  });
  return { ...f, startup: state };
}
for (const healthDelay of [0, 6000, 6001]) test(`cold startup READY at 22.5s starts a fresh detection budget; observation ${healthDelay}ms`, async t => {
  const f = await coldStartupFixture(t, { healthDelay }), out = await f.run(["--loop"]);
  assert.equal(f.startup.factories, 1); assert.equal(f.startup.acquireAt, 22500);
  assert.deepEqual(f.state.acquisitions, [22500]); assert.equal(f.state.leases.length, 1);
  assert.equal(out.budget.detectionMonoMs, 22500); assert.equal(out.budget.detectionWallMs, AT * 1000 + 1000 + 22500);
  assert.equal(out.mode, healthDelay > 6000 ? "HOLD" : "STANDBY");
  if (healthDelay > 6000) assert.equal(out.reason, "M1_V2_UNSIGNED_BUDGET_EXCEEDED");
  assert.equal(out.exitCode, 0); assert.equal(out.terminal, true); assert.equal(out.scheduled, false);
  assert.equal(f.state.signers, 0); assert.equal(f.state.sends, 0); assert.equal(f.state.prepared.length, 0);
  assert.equal(fs.existsSync(f.dirs.lockRoot), false); assert.equal(fs.existsSync(f.dirs.journalDir), false);
});
test("cold startup never READY holds at 30s, closes/drains, and honors maxRuns", async t => {
  const f = await coldStartupFixture(t, { readyAt: Infinity }), out = await f.run(["--loop"]);
  assert.equal(out.reason, "RANK1_STARTUP_QUALIFICATION_HOLD"); assert.equal(out.exitCode, 0);
  assert.equal(f.startup.closeAt, 30000); assert.equal(f.startup.drainedAt, 30040); assert.equal(f.clock.mono(), 30040);
  assert.equal(f.startup.factories, 1); assert.equal(f.state.acquisitions.length, 0);
  assert.equal(f.state.signers, 0); assert.equal(f.state.sends, 0); assert.equal(out.terminal, true); assert.equal(out.scheduled, false);
  assert.equal(fs.existsSync(f.dirs.lockRoot), false); assert.equal(fs.existsSync(f.dirs.journalDir), false);
});
test("cold startup check-only retains its absolute 20s cap for a 25s qualifier", async t => {
  const f = await coldStartupFixture(t, { check: true, readyAt: 25000 }), out = await f.run();
  assert.equal(out.reason, "RANK1_CHECK_DEADLINE"); assert.equal(out.mode, "HOLD"); assert.equal(out.exitCode, 1);
  assert.equal(f.startup.closeAt, 20000); assert.equal(f.startup.drainedAt, 20040); assert.equal(f.clock.mono(), 20040);
  assert.equal(f.startup.factories, 1); assert.equal(f.state.acquisitions.length, 0);
  assert.equal(f.state.signers, 0); assert.equal(f.state.sends, 0); assert.ok(f.state.outputs.every(row => !row.scheduled));
  assert.equal(fs.existsSync(f.dirs.lockRoot), false); assert.equal(fs.existsSync(f.dirs.journalDir), false);
});
test("cold startup abort during warming closes/drains without acquisition or signing", async t => {
  const f = await coldStartupFixture(t, { abortAt: 12500 }), out = await f.run(["--loop"]);
  assert.equal(out.reason, "RANK1_STOP_REQUESTED"); assert.equal(out.exitCode, 0);
  assert.equal(f.startup.closeAt, 12500); assert.equal(f.startup.drainedAt, 12540); assert.equal(f.clock.mono(), 12540);
  assert.equal(f.startup.factories, 1); assert.equal(f.state.acquisitions.length, 0);
  assert.equal(f.state.signers, 0); assert.equal(f.state.sends, 0); assert.equal(out.terminal, true); assert.equal(out.scheduled, false);
  assert.equal(fs.existsSync(f.dirs.lockRoot), false); assert.equal(fs.existsSync(f.dirs.journalDir), false);
});

// Runner-only contract fixture. Its private exact-object set does NOT implement
// or impersonate the transport's issued-RPC provenance; full integrations below
// use the actual opt-in transport retirement API instead.
function acquisitionFixture(options = {}) {
  const state = { starts: [], retired: [], factories: [], closed: new Set(), issued: [], maintains: 0 };
  return { state, decorateFactory(real, profile, context) {
    assert.equal(profile.rank1AcquisitionRecovery, true);
    assert.equal(profile.selectionPolicy, "rank1-prefer-dual");
    assert.equal(profile.qualificationMode, "capability-v1");
    assert.equal(typeof profile.allowFuture, "boolean");
    assert.equal(profile.monotonic, context.clock.mono);
    for (const key of ["rpc", "now", "resolveOrigin", "getCapabilityContext"]) assert.equal(typeof profile[key], "function");
    const index = state.factories.length, owned = new WeakSet(); let outstanding = false;
    state.factories.push(index);
    const close = async () => {
      await real.close(); state.closed.add(index);
      if (outstanding) { outstanding = false; context.state.active--; }
    };
    const facade = {
      maintain: input => { state.maintains++; return real.maintain(input); }, close,
      acquire: async input => {
        const number = state.starts.length; state.starts.push({ at: context.clock.mono(), index });
        if (options.outcomes?.[number] === "success") return real.acquire(input);
        await context.clock.wait(5);
        const error = new guard.ExecutionError("PINNED_RPC_FAILED"); owned.add(error);
        const emitted = options.forged ? new guard.ExecutionError(error.code) : error;
        state.issued.push(emitted); outstanding = true; context.state.active++;
        await options.beforeReject?.(context, emitted); throw emitted;
      },
      retireFailedAcquisition: async error => {
        assert.ok(state.issued.includes(error));
        if (!owned.has(error)) throw new guard.ExecutionError("OFFLINE_UNKNOWN_RECOVERY_ERROR");
        owned.delete(error);
        await context.clock.wait(40); await close();
        state.retired.push({ at: context.clock.mono(), index });
        await options.afterRetire?.(context);
        if (options.reject) throw new guard.ExecutionError("OFFLINE_RETIREMENT_REJECTED");
        return Object.hasOwn(options, "result") ? options.result : true;
      },
    };
    if (options.noApi) delete facade.retireFailedAcquisition;
    return facade;
  } };
}
test("private acquisition retirement drains/closes before new cold factory; failed detection budget is discarded", async t => {
  const fixture = acquisitionFixture({ outcomes: ["failure", "success"] });
  const f = await harness(t, { check: true, maxRuns: 2, decorateFactory: fixture.decorateFactory,
    onOutput: (row, state) => {
      if (row.reason !== "RANK1_RPC_RECOVERY_HOLD") return;
      assert.equal(state.active, 0); assert.equal(state.signers, 0); assert.equal(fixture.state.closed.has(0), true);
      assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
    } });
  const out = await f.run(); assert.equal(out.mode, "CHECK_ONLY"); assert.equal(out.exitCode, 0);
  assert.equal(f.state.factories.length, 2); assert.equal(f.state.retirements.length, 1);
  assert.equal(f.state.retirements[0].error, fixture.state.issued[0]); assert.equal(f.state.peakAcquiring, 1);
  assert.ok(f.state.acquisitions[1] >= fixture.state.retired[0].at + 1000);
  assert.equal(out.budget.detectionMonoMs, f.state.acquisitions[1]);
  assert.ok(f.state.outputs[0].budget.detectionMonoMs < out.budget.detectionMonoMs);
});
for (const [name, extra] of [["missing API", { noApi: true }], ["forged rejection", { forged: true }],
  ["false", { result: false }], ["undefined", { result: undefined }], ["truthy nonboolean", { result: 1 }], ["rejected retirement", { reject: true }]])
  test(`failed acquisition ${name} is terminal, never silently restarts`, async t => {
    const fixture = acquisitionFixture(extra), f = await harness(t, { maxRuns: 3, decorateFactory: fixture.decorateFactory });
    const out = await f.run(["--loop"]); assert.equal(out.exitCode, 2); assert.equal(out.terminal, true);
    assert.equal(f.state.factories.length, 1); assert.equal(f.state.acquisitions.length, 1); assert.equal(f.state.signers, 0);
    assert.equal(f.state.retirements.length, extra.noApi ? 0 : 1); assert.ok(f.state.outputs.every(row => !row.scheduled));
  });
for (const when of ["before", "after"]) for (const fault of ["authorization", "journal", "event", "clock", "lock"])
  test(`${fault} change ${when} acquisition retirement stops without another factory`, async t => {
    let lock;
    const mutate = ({ state, clock, dirs }) => {
      if (fault === "authorization") state.revoked = true;
      if (fault === "clock") clock.state.offset += 100;
      if (fault === "lock") lock = guard.acquireWalletLock({ lockRoot: dirs.lockRoot });
      if (["journal", "event"].includes(fault)) guard.atomicJson(path.join(dirs.journalDir, "external.json"), {
        schema: "wallet-execution-journal/v1", stage: fault === "event" ? "REVERTED" : "PREPARED", chainId: 1, owner: T.owner,
        executedAt: new Date(clock.wall()).toISOString(), txHash: fault === "event" ? hash(999) : null,
        intent: { to: T.executor, ...(fault === "event" ? { targetId: T.id, rank1EventId: runner.EVENT_ID } : {}) },
      });
    };
    const fixture = acquisitionFixture({ [when === "before" ? "beforeReject" : "afterRetire"]: mutate });
    const f = await harness(t, { maxRuns: 3, decorateFactory: fixture.decorateFactory,
      onOutput: row => { if (row.terminal && lock) { lock.release(); lock = null; } } });
    const out = await f.run(["--loop"]); assert.equal(out.exitCode, 2); assert.equal(f.state.factories.length, 1);
    assert.equal(f.state.retirements.length, when === "before" ? 0 : 1); assert.equal(f.state.signers, 0);
    assert.ok(f.state.outputs.every(row => !row.scheduled));
  });
for (const stage of ["PREPARED", "SENT", "UNCERTAIN", "REVERTED"]) test(`preexisting ${stage} prevents acquisition recovery`, async t => {
  const fixture = acquisitionFixture(), f = await harness(t, { maxRuns: 3, decorateFactory: fixture.decorateFactory });
  const file = path.join(f.dirs.journalDir, "prior.json");
  guard.atomicJson(file, { schema: "wallet-execution-journal/v1", stage, chainId: 1, owner: T.owner,
    executedAt: new Date(AT * 1000).toISOString(), txHash: stage === "PREPARED" ? null : hash(999),
    intent: { to: T.executor, targetId: T.id, rank1EventId: runner.EVENT_ID } });
  const before = fs.readFileSync(file); const out = await f.run(["--loop"]);
  assert.equal(out.exitCode, 2); assert.equal(f.state.retirements.length, 0); assert.equal(f.state.factories.length, 1);
  assert.deepEqual(fs.readFileSync(file), before);
});
test("acquisition backoff 1/2/4/8/12/12 seconds survives real advisory WS storms and READY warmups", async t => {
  const fixture = acquisitionFixture(), options = { maxRuns: 7, autoHeads: true, allowFuture: false, decorateFactory: fixture.decorateFactory,
    sleep: async (ms, state, clock) => {
      await clock.wait(Math.max(1, Math.ceil(ms)));
      if (state.outputs.length) for (let i = 0; i < 4; i++) heads.head();
    } };
  const f = await harness(t, options), heads = offlineHeads(f.clock); Object.assign(options, heads);
  const out = await f.run(["--loop", "--target1-ws-heads"]); assert.equal(out.reason, "RANK1_RPC_RECOVERY_HOLD");
  assert.equal(out.terminal, true); assert.equal(out.scheduled, false); assert.ok(heads.state.wakes > 0);
  for (let i = 1; i < fixture.state.starts.length; i++) {
    const delay = fixture.state.starts[i].at - fixture.state.retired[i - 1].at, expected = [1000, 2000, 4000, 8000, 12000, 12000][i - 1];
    assert.ok(delay >= expected && delay < expected + 1000, `${i}: ${delay}`);
  }
  assert.equal(f.state.factories.length, 7); assert.equal(f.state.retirements.length, 7); assert.equal(f.state.peakAcquiring, 1);
  assert.equal(f.state.signers, 0); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
  assert.ok(f.state.outputs.slice(0, 6).every(row => row.scheduled && !row.terminal));
});
test("only successful lease acquisition resets consecutive recovery backoff", async t => {
  const fixture = acquisitionFixture({ outcomes: ["failure", "failure", "success", "failure", "success"] });
  const f = await harness(t, { maxRuns: 5, autoHeads: true, allowFuture: false, decorateFactory: fixture.decorateFactory });
  const out = await f.run(["--loop"]); assert.equal(out.exitCode, 0, out.reason); assert.equal(f.state.leases.length, 2);
  const delay = fixture.state.starts[4].at - fixture.state.retired[2].at;
  assert.ok(delay >= 1000 && delay < 2000, String(delay)); assert.equal(f.state.signers, 0);
});
test("failed acquisition retirement preserves an earlier requireFreshAfter fence across the replacement factory", async t => {
  const fixture = acquisitionFixture({ outcomes: ["success", "failure", "success", "success"] }); let sameHead = false, firstHealthReads;
  const f = await harness(t, { maxRuns: 4, allowFuture: false, advancedTimestamp: AT + 12, prepare: preparedSeam, decorateFactory: fixture.decorateFactory,
    health: (_, state) => state.leases.length === 1,
    afterPrepare: (_, state, clock) => clock.advance(6001),
    onOutput: (row, state) => {
      const reads = state.calls.filter(call => call.method === "eth_call" && call.params[0].to === T.executor).length;
      if (row.reason === "M1_V2_UNSIGNED_BUDGET_EXCEEDED") firstHealthReads = reads;
      if (row.reason === "RANK1_WAITING_FRESH_HEAD") {
        sameHead = true; assert.equal(reads, firstHealthReads); state.parentAdvanced = true;
      }
    } });
  const out = await f.run(["--loop"]); assert.equal(sameHead, true); assert.equal(out.mode, "STANDBY");
  assert.equal(out.pin.number, HEAD + 1); assert.equal(f.state.retirements.length, 1); assert.equal(f.state.factories.length, 2);
  assert.equal(f.state.signers, 0); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
});
test("check recovery honors the absolute 20-second deadline, including WS wake storms", async t => {
  const fixture = acquisitionFixture(), options = { check: true, maxRuns: Infinity, autoHeads: true, decorateFactory: fixture.decorateFactory,
    sleep: async (ms, state, clock) => { await clock.wait(Math.max(1, Math.ceil(ms))); if (state.outputs.length) heads.head(); } };
  const f = await harness(t, options), heads = offlineHeads(f.clock); Object.assign(options, heads);
  const out = await f.run(["--target1-ws-heads"]); assert.equal(out.reason, "RANK1_CHECK_DEADLINE"); assert.equal(out.exitCode, 1);
  assert.ok(f.clock.mono() >= 20000 && f.clock.mono() < 20250); assert.ok(f.state.acquisitions.every(at => at < 20000));
  assert.ok(f.state.outputs.every(row => !row.scheduled)); assert.equal(f.state.signers, 0);
});
for (const when of ["retirement", "backoff"]) test(`abort signal during ${when} ends recovery without a new acquisition`, async t => {
  const controller = new AbortController();
  const fixture = acquisitionFixture({ afterRetire: () => { if (when === "retirement") controller.abort(); } });
  const f = await harness(t, { signal: controller.signal, maxRuns: 5, decorateFactory: fixture.decorateFactory,
    sleep: async (ms, state, clock) => { await clock.wait(Math.max(1, Math.ceil(ms))); if (when === "backoff" && state.outputs.length) controller.abort(); } });
  const out = await f.run(["--loop"]); assert.equal(out.terminal, true); assert.equal(out.scheduled, false); assert.equal(out.exitCode, 0);
  assert.equal(f.state.acquisitions.length, 1); assert.equal(f.state.factories.length, 1); assert.equal(f.state.signers, 0);
});
test("non-loop execute has no hidden second pass after eligible acquisition retirement", async t => {
  const fixture = acquisitionFixture(), f = await harness(t, { maxRuns: 5, decorateFactory: fixture.decorateFactory });
  const out = await f.run(); assert.equal(out.reason, "RANK1_RPC_RECOVERY_HOLD"); assert.equal(out.terminal, true);
  assert.equal(f.state.acquisitions.length, 1); assert.equal(f.state.retirements.length, 1); assert.equal(out.scheduled, false);
});
for (const origin of ["prepare", "feed", "validation", "signer"]) test(`post-acquisition ${origin} transport lookalike never calls retirement`, async t => {
  let apiCalls = 0;
  const options = { currentLiquidatable: true, maxRuns: 3, prepare: preparedSeam,
    decorateFactory: real => ({ maintain: real.maintain, close: real.close, acquire: real.acquire,
      retireFailedAcquisition: () => { apiCalls++; throw new Error("NO_RETIREMENT_ALLOWED"); } }) };
  if (origin === "prepare") options.prepare = () => { throw new guard.ExecutionError("PINNED_RPC_FAILED"); };
  if (origin === "feed") options.rpcHook = row => { if (row.method === "eth_call" && row.params[0].to === proof.POLICY.usdcUsd.address) throw new guard.ExecutionError("RPC_TIMEOUT"); };
  if (origin === "signer") options.signerCode = "PINNED_RPC_FAILED";
  if (origin === "validation") {
    const actual = guard.executeGuarded;
    t.mock.method(guard, "executeGuarded", args => actual({ ...args, validate: async () => { await args.validate(); throw new guard.ExecutionError("PINNED_RPC_FAILED"); } }));
  }
  const f = await harness(t, options), out = await f.run(["--loop"]);
  assert.equal(out.exitCode, 2); assert.equal(apiCalls, 0); assert.equal(f.state.factories.length, 1);
  assert.equal(f.state.signers, origin === "signer" ? 1 : 0); assert.ok(f.state.outputs.every(row => !row.scheduled));
});
