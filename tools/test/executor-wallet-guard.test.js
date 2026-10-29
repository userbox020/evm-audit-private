"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { spawn } = require("node:child_process");
const { keccak256, id, zeroPadValue } = require("../node_modules/ethers");
const guard = require("../lib/wallet-execution-guard.js");
const { mockSignedTransactionBinding } = require("./signed-transaction-binding-fixture.js");
const OWNER = guard.MAIN_ACCOUNT, TO = "0x" + "22".repeat(20), TOKEN = "0x" + "33".repeat(20), HASH = "0x" + "44".repeat(32), BLOCK = "0x" + "55".repeat(32);
function temp(t) {
  const base = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir(); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "executor-guard-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lockRoot: path.join(root, "locks"), journalDir: path.join(root, "journals") };
}
function receipt(txHash = HASH, overrides = {}) {
  return { transactionHash: txHash, from: OWNER, to: TO, blockHash: BLOCK, blockNumber: "0x10", status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x2", logs: [], ...overrides };
}
function setup(t, changes = {}) {
  const dirs = temp(t), counters = { prepare: 0, sign: 0, send: 0 };
  const parserFixture = mockSignedTransactionBinding(t);
  const caps = { gasCap: 100000n, spendCap: 1000000n, feeCap: 10n, dailyCap: 3n };
  const transaction = { type: 2, chainId: 1, nonce: 0, to: TO, data: "0x1234", value: 0n, gasLimit: 30000n, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n };
  const options = { ...dirs, intent: { to: TO, profitToken: TOKEN, simulatedProfitBeforeGasRaw: "999" }, receiptWaitMs: 0,
    prepare: async () => { counters.prepare++; return { transaction, caps, conservativeProfitBeforeGasWei: 1000000n }; }, validate: async () => caps,
    signTransaction: async tx => { counters.sign++; return parserFixture.register("0x010203", tx, OWNER); },
    sendRawTransaction: async raw => { counters.send++; return keccak256(raw); }, receiptRpc: async hash => receipt(hash), ...changes };
  return { options, counters, transaction, caps, ...dirs };
}
function records(dir) { return fs.readdirSync(dir).filter(n => n.endsWith(".json")).map(n => ({ file: path.join(dir, n), value: JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) })); }
function oldSent(dir, extra = {}) { guard.atomicJson(path.join(dir, "legacy.json"), { stage: "SENT", txHash: HASH, executedAt: "2000-01-01T00:00:00Z", ...extra }); }

test("timing observers are nonauthorizing, immutable, sanitized and preserve sign/send/journal order", async t => {
  for (const failure of [null, "validation", "sign", "send", "hash"]) {
    const f = setup(t), events = []; let checks = 0;
    f.options.onTiming = e => {
      events.push(e); assert.ok(Object.isFrozen(e));
      if (e.edge === "start") throw new Error("PRIVATE_OBSERVER");
      return Promise.reject(new Error("PRIVATE_OBSERVER"));
    };
    if (failure === "validation") f.options.validate = async () => {
      if (++checks === 2) throw new guard.ExecutionError("NEXT_BLOCK_DEADLINE"); return f.caps;
    };
    if (failure === "sign") f.options.signTransaction = async () => { f.counters.sign++; throw new Error("SIGN_FAILED"); };
    if (failure === "send" || failure === "hash") f.options.sendRawTransaction = async () => {
      f.counters.send++; if (failure === "send") throw new Error("SEND_FAILED"); return HASH;
    };
    if (failure) await assert.rejects(guard.executeGuarded(f.options)); else await guard.executeGuarded(f.options);
    const row = records(f.journalDir)[0].value;
    assert.equal(row.stage, failure === "validation" ? "ABORTED_UNSIGNED" : failure === "sign" ? "PREPARED" : failure ? "UNCERTAIN" : "RECEIPT_VERIFIED");
    assert.equal(f.counters.sign, failure === "validation" ? 0 : 1);
    assert.equal(f.counters.send, ["validation", "sign"].includes(failure) ? 0 : 1);
    const active = new Map();
    for (const e of events) {
      assert.deepEqual(Object.keys(e).sort(), ["phase", "edge", "atMonoMs", "atWallMs", ...(e.edge === "end" ? ["durationMs"] : [])].sort());
      assert.ok(Number.isFinite(e.atMonoMs) && Number.isFinite(e.atWallMs));
      if (e.edge === "start") { assert.equal(active.has(e.phase), false); active.set(e.phase, e.atMonoMs); }
      if (e.edge === "end") { assert.equal(e.durationMs, e.atMonoMs - active.get(e.phase)); active.delete(e.phase); }
    }
    assert.equal(active.size, 0);
    assert.equal(events.filter(e => e.phase === "sendAck").length, failure ? 0 : 1);
    assert.ok(events.findIndex(e => e.phase === "lockWait" && e.edge === "end") < events.findIndex(e => e.phase === "preparation"));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|0x010203|signature|transaction|reason/);
  }
});

test("lockWait times only synchronous acquisition, including contention, never the preparation hold", async t => {
  const f = setup(t), lock = guard.acquireWalletLock({ lockRoot: f.lockRoot }), events = [];
  try {
    await assert.rejects(guard.executeGuarded({ ...f.options, onTiming: e => events.push(e) }), { code: "WALLET_LOCK_HELD" });
    assert.deepEqual(events.map(e => [e.phase, e.edge]), [["lockWait", "start"], ["lockWait", "end"]]);
    assert.equal(events[1].durationMs, events[1].atMonoMs - events[0].atMonoMs);
    assert.equal(f.counters.prepare, 0); assert.equal(f.counters.sign, 0);
  } finally { lock.release(); }
});

for (const [phase, edge, occurrence] of [["sign", "start", 1], ["send", "start", 1],
  ["finalValidation", "end", 2], ["finalValidation", "end", 3]]) {
  test(`guard buffers ${phase}/${edge} #${occurrence}: observer deadline/authorization expiry happens only after actions and durable receipt`, async t => {
    for (const reason of ["NEXT_BLOCK_DEADLINE", "BATCH_INVALID_OR_EXPIRED"]) {
      const f = setup(t), initial = Date.parse("2026-10-23T20:00:03Z"), expires = initial + 1, events = [], observed = [], actions = [];
      let clock = initial, matches = 0;
      f.options.now = () => clock;
      f.options.validate = async () => { guard.requireThat(clock < expires, reason); return f.caps; };
      const sign = f.options.signTransaction, send = f.options.sendRawTransaction;
      f.options.signTransaction = async tx => {
        actions.push({ action: "sign", at: clock }); guard.requireThat(clock < expires, reason); return sign(tx);
      };
      f.options.sendRawTransaction = async raw => {
        actions.push({ action: "send", at: clock }); guard.requireThat(clock < expires, reason); return send(raw);
      };
      f.options.onTiming = e => {
        events.push(e);
        observed.push({ signs: f.counters.sign, sends: f.counters.send, locks: fs.readdirSync(f.lockRoot).length,
          stage: records(f.journalDir)[0].value.stage });
        if (e.phase === phase && e.edge === edge && ++matches === occurrence) clock = expires;
      };
      const result = await guard.executeGuarded(f.options);
      assert.equal(result.stage, "RECEIPT_VERIFIED"); assert.equal(clock, expires);
      assert.deepEqual(actions, [{ action: "sign", at: initial }, { action: "send", at: initial }]);
      assert.ok(observed.length > 0);
      assert.ok(observed.every(row => row.signs === 1 && row.sends === 1 && row.locks === 0 && row.stage === "RECEIPT_VERIFIED"));
      assert.ok(events.every(e => e.atWallMs === initial && Object.isFrozen(e)), "capture time, not delayed delivery time");
      assert.deepEqual(events.map(e => e.atMonoMs), events.map(e => e.atMonoMs).sort((a, b) => a - b));
    }
  });
}

test("timing buffer is bounded, capture-only, sanitized and flushed at most once despite observer failures", async () => {
  let clock = 10;
  const events = [], timing = guard.createTiming(event => {
    events.push(event); clock = 1000;
    if (events.length % 2) throw new Error("PRIVATE_OBSERVER");
    return Promise.reject(new Error("PRIVATE_OBSERVER"));
  }, () => clock);
  for (let i = 0; i < 300; i++) timing.point("sendAck");
  assert.equal(events.length, 0); assert.equal(clock, 10);
  timing.flush(); timing.flush(); timing.point("sign");
  assert.equal(events.length, 256); assert.ok(events.every(e => Object.isFrozen(e) && e.atWallMs === 10));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|signature|transaction/);
  await new Promise(resolve => setImmediate(resolve));
});

for (const [name, values] of [["missing", [undefined]], ["zero", [0n, 0, "0", "0x0"]],
  ["negative", [-1n, -1, "-1", "-0x1"]], ["invalid", [undefined, null, "UNKNOWN", "", "01", "1.5", 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}, []]],
  ["inherited", [1000000n]]]) {
  test(`${name} conservative profit rejects with PROFIT_UNVERIFIED before signing or journal creation and releases the wallet lock`, async t => {
    for (const value of values) {
      const f = setup(t), prepare = f.options.prepare;
      f.options.prepare = async () => {
        const prepared = await prepare();
        if (name === "missing" || name === "inherited") delete prepared.conservativeProfitBeforeGasWei;
        else prepared.conservativeProfitBeforeGasWei = value;
        if (name === "inherited") Object.setPrototypeOf(prepared, { conservativeProfitBeforeGasWei: value });
        return prepared;
      };
      f.options.validate = async () => assert.fail("Unverified profit must reject before transaction validation");
      f.options.receiptRpc = async () => assert.fail("Unverified profit must not request a receipt");
      await assert.rejects(guard.executeGuarded(f.options), error => {
        assert.ok(error instanceof guard.ExecutionError); assert.equal(error.code, "PROFIT_UNVERIFIED");
        assert.equal(error.message, "PROFIT_UNVERIFIED"); return true;
      });
      assert.equal(f.counters.prepare, 1); assert.equal(f.counters.sign, 0); assert.equal(f.counters.send, 0);
      assert.equal(fs.existsSync(f.journalDir), false); assert.equal(fs.readdirSync(f.lockRoot).length, 0);
    }
  });
}

test("M1 event is block/mode independent; signed successes/reverts and legacy target identities block, unsigned abort retries", async t => {
  for (const future of [false, true]) for (const reverted of [false, true]) {
    const f = setup(t), targetId = "targetM1_Morpho_USDe_DAI";
    f.options.intent = { ...f.options.intent, targetId, pinHash: BLOCK,
      ...(future ? { executionMode: "NEXT_BLOCK_PASSIVE", nextBlockReplayKey: id("old parent") } : {}) };
    f.options.receiptRpc = async hash => receipt(hash, { status: reverted ? "0x0" : "0x1" });
    const first = await guard.executeGuarded(f.options); assert.ok(first.intent.m1TriggerEventKey);
    f.options.intent = { to: TO, profitToken: TOKEN, targetId, pinHash: HASH, nextBlockReplayKey: id("new parent") };
    await assert.rejects(guard.executeGuarded(f.options), /M1_TRIGGER_EVENT_ALREADY_ATTEMPTED/);
    assert.equal(f.counters.sign, 1); assert.equal(f.counters.prepare, 1);
    // Pre-patch journals with targetId but no event key also count.
    const stored = records(f.journalDir)[0]; delete stored.value.intent.m1TriggerEventKey; guard.atomicJson(stored.file, stored.value);
    await assert.rejects(guard.executeGuarded(f.options), /M1_TRIGGER_EVENT_ALREADY_ATTEMPTED/);
  }
  const f = setup(t); f.options.intent.targetId = "targetM1_Morpho_USDe_DAI"; let checks = 0;
  f.options.validate = async () => { if (++checks === 2) throw new guard.ExecutionError("M1_ROUTE_POSITIVE_EVIDENCE_REQUIRED"); return f.caps; };
  await assert.rejects(guard.executeGuarded(f.options), /M1_ROUTE_POSITIVE_EVIDENCE_REQUIRED/);
  assert.equal(records(f.journalDir)[0].value.stage, "ABORTED_UNSIGNED"); assert.equal(f.counters.sign, 0);
  f.options.validate = async () => f.caps;
  assert.equal((await guard.executeGuarded(f.options)).stage, "RECEIPT_VERIFIED"); assert.equal(f.counters.sign, 1);
});
function waitMessage(child) { return new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => { if (code) reject(new Error("child exit " + code)); }); }); }

test("two concurrent OS processes cannot enter the shared-wallet signing section", async t => {
  const dirs = temp(t), modulePath = require.resolve("../lib/wallet-execution-guard.js");
  const script = `const g=require(${JSON.stringify(modulePath)});(async()=>{try{await g.withWalletLock(${JSON.stringify({ lockRoot: dirs.lockRoot })},async()=>{process.send({entered:true});await new Promise(r=>process.once('message',r));});process.exit(0);}catch(e){process.send({entered:false,code:g.safeError(e)});process.exit(0);}})();`;
  const first = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); t.after(() => { if (first.exitCode === null) first.kill(); });
  assert.deepEqual(await waitMessage(first), { entered: true });
  const second = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); t.after(() => { if (second.exitCode === null) second.kill(); });
  assert.deepEqual(await waitMessage(second), { entered: false, code: "WALLET_LOCK_HELD" });
  const exited = new Promise(resolve => first.once("exit", resolve)); first.send("release"); await exited;
  const lock = guard.acquireWalletLock({ lockRoot: dirs.lockRoot }); lock.release();
});

test("crashed/stale locks never expire; release requires the exact owner token", async t => {
  const dirs = temp(t), modulePath = require.resolve("../lib/wallet-execution-guard.js");
  const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(modulePath)}).acquireWalletLock(${JSON.stringify({ lockRoot: dirs.lockRoot })});process.exit(0);`], { stdio: "ignore" });
  await new Promise(resolve => child.once("exit", resolve));
  const directory = path.join(dirs.lockRoot, fs.readdirSync(dirs.lockRoot)[0]);
  const owner = JSON.parse(fs.readFileSync(path.join(directory, "owner.json"))); owner.createdAt = "1900-01-01T00:00:00Z"; guard.atomicJson(path.join(directory, "owner.json"), owner);
  assert.throws(() => guard.acquireWalletLock({ lockRoot: dirs.lockRoot }), /WALLET_LOCK_HELD/);
  const another = temp(t), own = guard.acquireWalletLock({ lockRoot: another.lockRoot });
  guard.atomicJson(path.join(own.directory, "owner.json"), { token: "not-owner" });
  assert.throws(() => own.release(), /LOCK_OWNER_MISMATCH/); assert.equal(fs.existsSync(own.directory), true);
});

test("PREPARED/SENT/UNCERTAIN and old untyped SENT records block indefinitely; malformed journals and receipt RPC errors fail closed", async t => {
  for (const stage of ["PREPARED", "SENT", "UNCERTAIN"]) {
    const f = setup(t, { receiptRpc: async () => null }); oldSent(f.journalDir, { stage });
    await assert.rejects(guard.executeGuarded(f.options), /TX_ALREADY_PENDING_ON_SAME_WALLET/); assert.equal(f.counters.prepare, 0); assert.equal(f.counters.sign, 0);
  }
  const corrupt = setup(t); fs.mkdirSync(corrupt.journalDir); fs.writeFileSync(path.join(corrupt.journalDir, "bad.json"), "{");
  await assert.rejects(guard.executeGuarded(corrupt.options), /JOURNAL_MALFORMED/); assert.equal(corrupt.counters.sign, 0);
  const failure = setup(t, { receiptRpc: async () => { throw new Error("https://private.invalid/secret"); } }); oldSent(failure.journalDir);
  await assert.rejects(guard.executeGuarded(failure.options), /RECEIPT_RPC_FAILED/); assert.equal(failure.counters.sign, 0);
  assert.equal(records(failure.journalDir)[0].value.stage, "SENT");
});

test("receipt reconciliation is persisted before any new nonce/signing work and before releasing the lock", async t => {
  const f = setup(t); oldSent(f.journalDir);
  const prepare = f.options.prepare;
  f.options.prepare = async () => { assert.equal(records(f.journalDir)[0].value.stage, "RECEIPT_VERIFIED"); return prepare(); };
  const result = await guard.executeGuarded(f.options);
  assert.equal(result.stage, "RECEIPT_VERIFIED"); assert.equal(f.counters.sign, 1); assert.equal(records(f.journalDir).length, 2);
  assert.equal(fs.readdirSync(f.lockRoot).length, 0);
});

test("intent and signed transaction hash are durable before send; ambiguous send cannot be retried by another pass", async t => {
  const f = setup(t);
  f.options.sendRawTransaction = async raw => {
    f.counters.send++; const journal = records(f.journalDir)[0].value;
    assert.equal(journal.stage, "PREPARED"); assert.equal(journal.txHash, keccak256(raw)); assert.equal(journal.intent.calldataHash, keccak256("0x1234"));
    throw new Error("secret endpoint response");
  };
  await assert.rejects(guard.executeGuarded(f.options), /BROADCAST_OUTCOME_UNCERTAIN/);
  const journal = records(f.journalDir)[0].value; assert.equal(journal.stage, "UNCERTAIN"); assert.equal(journal.txHash, keccak256("0x010203"));
  assert.doesNotMatch(JSON.stringify(journal), /0x010203|secret endpoint|privateKey|signedRaw/);
  f.options.receiptRpc = async () => null;
  await assert.rejects(guard.executeGuarded(f.options), /TX_ALREADY_PENDING_ON_SAME_WALLET/); assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 1);
});

test("failure during signing retains a PREPARED intent requiring attended reconciliation", async t => {
  const f = setup(t);
  f.options.signTransaction = async () => { f.counters.sign++; throw new Error("synthetic signer crashed"); };
  await assert.rejects(guard.executeGuarded(f.options), /synthetic signer crashed/);
  const journal = records(f.journalDir)[0].value; assert.equal(journal.stage, "PREPARED"); assert.equal(journal.txHash, null);
  assert.equal(journal.abortPhase, undefined); assert.equal(journal.signerInvoked, undefined);
  await assert.rejects(guard.executeGuarded(f.options), /PREPARED_INTENT_REQUIRES_MANUAL_RECONCILIATION/);
  assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 0);
});

test("late approval/context failure persists an unsigned terminal audit trail and permits current execution under unchanged caps", async t => {
  for (const reason of ["BATCH_INVALID_OR_EXPIRED", "NEXT_BLOCK_DEADLINE"]) {
    const f = setup(t); f.caps.dailyCap = 1n; f.caps.lifetimeCap = 1n; const originalCaps = { ...f.caps }; let checks = 0;
    f.options.intent = { ...f.options.intent, executionMode: "NEXT_BLOCK_PASSIVE", nextBlockReplayKey: id("unsigned-" + reason) };
    f.options.validate = async () => { if (++checks === 2) throw new guard.ExecutionError(reason); return f.caps; };
    await assert.rejects(guard.executeGuarded(f.options), { code: reason });
    assert.equal(f.counters.sign, 0); assert.equal(f.counters.send, 0);
    const [{ file, value: aborted }] = records(f.journalDir), before = fs.readFileSync(file, "utf8");
    assert.equal(aborted.stage, "ABORTED_UNSIGNED"); assert.equal(aborted.txHash, null); assert.equal(aborted.reason, reason);
    assert.equal(aborted.signerInvoked, false); assert.equal(aborted.abortPhase, "PRE_SIGN_VALIDATION");
    assert.ok(Number.isFinite(Date.parse(aborted.abortedAt))); assert.equal(aborted.realizedNetProfit, "UNKNOWN");
    assert.equal(guard.readJournals(f.journalDir)[0].record.stage, "ABORTED_UNSIGNED");
    await guard.reconcilePending({ journalDir: f.journalDir, receiptRpc: async () => assert.fail("Unsigned abort must not request a receipt") });
    f.options.intent = { to: TO, profitToken: TOKEN, executionMode: "CURRENT_STATE" }; f.options.validate = async () => f.caps;
    const result = await guard.executeGuarded(f.options);
    assert.equal(result.stage, "RECEIPT_VERIFIED"); assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 1);
    assert.deepEqual(f.caps, originalCaps); assert.equal(records(f.journalDir).length, 2);
    assert.equal(fs.readFileSync(file, "utf8"), before); assert.equal(fs.readdirSync(f.lockRoot).length, 0);
  }
});

test("unsigned aborts do not consume signed daily/lifetime limits while actual signed attempts still do", async t => {
  for (const [cap, error] of [["dailyCap", "DAILY_EXECUTION_CAP_REACHED"], ["lifetimeCap", "LIFETIME_EXECUTION_CAP_REACHED"]]) {
    const f = setup(t); f.caps.dailyCap = null; f.caps.lifetimeCap = null; f.caps[cap] = 1n;
    let checks = 0;
    f.options.validate = async () => { if (++checks === 2) throw new guard.ExecutionError("NEXT_BLOCK_DEADLINE"); return f.caps; };
    await assert.rejects(guard.executeGuarded(f.options), { code: "NEXT_BLOCK_DEADLINE" });
    f.options.validate = async () => f.caps;
    await guard.executeGuarded(f.options);
    await assert.rejects(guard.executeGuarded(f.options), { code: error });
    assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 1);
    assert.deepEqual(records(f.journalDir).map(row => row.value.stage).sort(), ["ABORTED_UNSIGNED", "RECEIPT_VERIFIED"]);
  }
});

test("same-position unsigned retry remains eligible, but its signed or reverted retry blocks further replay", async t => {
  for (const status of ["0x1", "0x0"]) {
    const f = setup(t); let checks = 0;
    f.options.intent = { ...f.options.intent, executionMode: "NEXT_BLOCK_PASSIVE", nextBlockReplayKey: id("same-position-" + status) };
    f.options.validate = async () => { if (++checks === 2) throw new guard.ExecutionError("NEXT_BLOCK_DEADLINE"); return f.caps; };
    await assert.rejects(guard.executeGuarded(f.options), { code: "NEXT_BLOCK_DEADLINE" });
    f.options.validate = async () => { throw new guard.ExecutionError("BATCH_INVALID_OR_EXPIRED"); };
    await assert.rejects(guard.executeGuarded(f.options), { code: "BATCH_INVALID_OR_EXPIRED" });
    assert.equal(f.counters.sign, 0); assert.equal(f.counters.send, 0); assert.equal(records(f.journalDir).length, 1);
    f.options.validate = async () => f.caps; f.options.receiptRpc = async txHash => receipt(txHash, { status });
    const result = await guard.executeGuarded(f.options);
    assert.equal(result.stage, status === "0x1" ? "RECEIPT_VERIFIED" : "REVERTED");
    await assert.rejects(guard.executeGuarded(f.options), { code: "NEXT_BLOCK_ALREADY_ATTEMPTED" });
    assert.equal(f.counters.prepare, 3); assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 1);
    assert.equal(records(f.journalDir).filter(row => row.value.stage === "ABORTED_UNSIGNED").length, 1);
  }
});

test("post-sign validation failure stays uncertain and blocks later execution even without a send", async t => {
  const f = setup(t); let checks = 0;
  f.options.validate = async () => { if (++checks === 3) throw new guard.ExecutionError("NEXT_BLOCK_DEADLINE"); return f.caps; };
  await assert.rejects(guard.executeGuarded(f.options), { code: "BROADCAST_OUTCOME_UNCERTAIN" });
  const journal = records(f.journalDir)[0].value;
  assert.equal(journal.stage, "UNCERTAIN"); assert.equal(journal.txHash, keccak256("0x010203")); assert.equal(journal.abortPhase, undefined);
  f.options.receiptRpc = async () => null;
  await assert.rejects(guard.executeGuarded(f.options), { code: "TX_ALREADY_PENDING_ON_SAME_WALLET" });
  assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 0);
});

test("failure to persist the unsigned abort fails closed and retains the prepared manual hold", async t => {
  const f = setup(t); let checks = 0, failAbort = false, failedWrites = 0;
  f.options.validate = async () => {
    if (++checks === 2) { failAbort = true; throw new guard.ExecutionError("NEXT_BLOCK_DEADLINE"); }
    return f.caps;
  };
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (failAbort && path.dirname(destination) === f.journalDir) { failedWrites++; throw new Error("UNTRUSTED_FILESYSTEM_DETAILS"); }
    return rename(source, destination);
  });
  await assert.rejects(guard.executeGuarded(f.options), error => {
    assert.equal(error.code, "UNSIGNED_ABORT_PERSIST_FAILED"); assert.equal(error.message, error.code);
    assert.doesNotMatch(JSON.stringify(error) + error.stack, /UNTRUSTED/); return true;
  });
  assert.equal(failedWrites, 1); assert.equal(f.counters.sign, 0); assert.equal(f.counters.send, 0);
  const journal = records(f.journalDir)[0].value; assert.equal(journal.stage, "PREPARED"); assert.equal(journal.txHash, null);
  await assert.rejects(guard.executeGuarded(f.options), { code: "PREPARED_INTENT_REQUIRES_MANUAL_RECONCILIATION" });
});

test("unsigned abort reasons strip raw errors and malformed abort classifications never bypass journal holds", async t => {
  for (const failure of [new Error("UNTRUSTED_PROVIDER_MESSAGE"), new guard.ExecutionError("https://example.invalid/UNTRUSTED"),
    new guard.ExecutionError("UNTRUSTED_CODE\n")]) {
    const f = setup(t); let checks = 0;
    f.options.validate = async () => { if (++checks === 2) throw failure; return f.caps; };
    await assert.rejects(guard.executeGuarded(f.options), { code: "PRE_SIGN_VALIDATION_FAILED" });
    const [{ file, value }] = records(f.journalDir);
    assert.equal(value.reason, "PRE_SIGN_VALIDATION_FAILED"); assert.doesNotMatch(JSON.stringify(value), /UNTRUSTED|example\.invalid/);
    for (const change of [{ txHash: HASH }, { signerInvoked: true }, { signerInvoked: undefined }, { abortPhase: "POST_SIGN_VALIDATION" },
      { abortPhase: undefined }, { abortedAt: "invalid" }, { reason: "https://example.invalid/" }, { chainId: undefined }, { owner: undefined }]) {
      guard.atomicJson(file, { ...value, ...change });
      assert.throws(() => guard.readJournals(f.journalDir), { code: "JOURNAL_MALFORMED" });
    }
  }
});

test("process key loader accesses only the approved file and unavailable keys fail safely without any real secret reads", async t => {
  const approvedFile = path.resolve(__dirname, "../../.env.exploit"), accesses = []; let unavailable = true;
  t.mock.method(fs, "existsSync", file => { accesses.push(file); assert.equal(file, approvedFile); return !unavailable; });
  t.mock.method(fs, "readFileSync", (file, encoding) => {
    accesses.push(file); assert.equal(file, approvedFile); assert.equal(encoding, "utf8");
    if (unavailable) throw new Error("UNTRUSTED_FILESYSTEM_DETAILS");
    return "# Offline stub: deliberately no key material\nMODE=offline\n";
  });
  for (unavailable of [true, false]) {
    await assert.rejects(guard.signWithProcessKey({}), error => {
      assert.equal(error.code, "KEY_UNAVAILABLE"); assert.equal(error.message, "KEY_UNAVAILABLE");
      assert.doesNotMatch(error.stack + JSON.stringify(error), /UNTRUSTED/); return true;
    });
  }
  assert.equal(accesses.length, 2); assert.ok(accesses.every(file => file === approvedFile));
});

test("receipt telemetry separates actual gas, validated transfers, simulated profit and unknown realized net", async t => {
  const f = setup(t);
  f.options.receiptRpc = async txHash => receipt(txHash, { logs: [{ address: TOKEN, transactionHash: txHash, blockHash: BLOCK, logIndex: "0x0", removed: false,
    topics: [id("Transfer(address,address,uint256)"), zeroPadValue(TO, 32), zeroPadValue(OWNER, 32)], data: "0x" + 123n.toString(16).padStart(64, "0") }] });
  const result = await guard.executeGuarded(f.options);
  assert.equal(result.actualGasCostWei, (21000n * 2n).toString()); assert.equal(result.actualTokenGainRaw, "123");
  assert.equal(result.intent.simulatedProfitBeforeGasRaw, "999"); assert.equal(result.realizedNetProfit, "UNKNOWN"); assert.equal(result.txHash, keccak256("0x010203"));
  const duplicate = await f.options.receiptRpc(result.txHash); duplicate.logs.push(duplicate.logs[0]); assert.throws(() => guard.receiptSummary(result, duplicate), /RECEIPT_LOG_INVALID/);
  const unknown = guard.receiptSummary(result, receipt(result.txHash)); assert.equal(unknown.actualTokenGainRaw, null); assert.equal(unknown.tokenGainEvidence, "UNKNOWN");
  const reverted = guard.receiptSummary(result, receipt(result.txHash, { status: "0x0" })); assert.equal(reverted.stage, "REVERTED"); assert.equal(reverted.actualGasCostWei, "42000");
  assert.throws(() => guard.receiptSummary(result, receipt(HASH)), /RECEIPT_INVALID/);
});

test("fresh caps are revalidated before signing; spend/value/priority and per-day limits are enforced", async t => {
  for (const edit of [{ value: 1n }, { gasLimit: 100001n }, { maxFeePerGas: 11n }, { maxPriorityFeePerGas: -1n }, { nonce: -1 }]) {
    const f = setup(t); Object.assign(f.transaction, edit); await assert.rejects(guard.executeGuarded(f.options)); assert.equal(f.counters.sign, 0);
  }
  const tightened = setup(t); let validations = 0;
  tightened.options.validate = async () => (++validations < 2 ? tightened.caps : { ...tightened.caps, spendCap: 1n });
  await assert.rejects(guard.executeGuarded(tightened.options), /TX_CAP_EXCEEDED/); assert.equal(tightened.counters.sign, 0);
  assert.throws(() => guard.buildFees(50000n, 100n, { gasCap: 100000n, spendCap: 1n, feeCap: 10n }), /FEE_CAP_BELOW_BASE_FEE/);
  const capped = setup(t); oldSent(capped.journalDir, { stage: "RECEIPT_VERIFIED", executedAt: new Date().toISOString() }); capped.caps.dailyCap = 1n;
  await assert.rejects(guard.executeGuarded(capped.options), /DAILY_EXECUTION_CAP_REACHED/); assert.equal(capped.counters.sign, 0);
});

test("shared dynamic tip scales with conservative profit and respects child base, spend and fee ceilings", () => {
  const gas = 1500000n, base = 41500000n, child = 46687500n;
  const caps = { gasCap: gas, spendCap: 2000000000000000n, feeCap: null };
  assert.equal(guard.TIP_PROFIT_SHARE_BPS, 5000n);
  const low = guard.buildFeePolicy(gas, base, caps, 1000000000000000n);
  const high = guard.buildFeePolicy(gas, base, caps, 2000000000000000n);
  assert.equal(low.maxPriorityFeePerGas, 333333333n);
  assert.equal(low.maxFeePerGas, 380020833n);
  assert.equal(high.maxPriorityFeePerGas, 666666666n);
  assert.ok(high.maxPriorityFeePerGas > low.maxPriorityFeePerGas);
  for (const feeCap of [null, child, child + 1n, 250000000n]) {
    const bounded = { ...caps, feeCap };
    for (const profit of [1000000000000000n, 2000000000000000n, 1000000000000000000n]) {
      const fees = guard.buildFeePolicy(gas, base, bounded, profit);
      assert.ok(fees.maxFeePerGas >= child);
      assert.ok(fees.maxFeePerGas <= caps.spendCap / gas);
      assert.ok(feeCap === null || fees.maxFeePerGas <= feeCap);
      assert.equal(fees.maxPriorityFeePerGas, fees.maxFeePerGas - child);
      assert.ok(profit - gas * fees.maxFeePerGas > 0n);
      guard.validateTransaction({ type: 2, chainId: 1, to: TO, data: "0x1234", nonce: 0, value: 0n, ...fees }, bounded);
    }
  }
  assert.deepEqual(guard.buildFees(1250000n, base, caps, 1000000000000000n), low, "120% padding precedes the tip budget");
  assert.throws(() => guard.buildFeePolicy(gas, base, { ...caps, feeCap: child - 1n }, 10n ** 18n), /FEE_CAP_BELOW_BASE_FEE/);
  assert.throws(() => guard.buildFeePolicy(gas, base, { ...caps, spendCap: gas * child - 1n }, 10n ** 18n), /FEE_CAP_BELOW_BASE_FEE/);
  assert.equal(guard.buildFeePolicy(1n, 9n, { gasCap: 1n, spendCap: 11n, feeCap: null }, 100n).maxFeePerGas, 11n, "child base rounds up");
});

test("legacy tip floor is used only when profitable; missing explicit P cannot select the non-profit fallback", () => {
  const caps = { gasCap: 1n, spendCap: 1000000000n, feeCap: null };
  const affordableFloor = guard.buildFeePolicy(1n, 0n, caps, 60000000n);
  assert.equal(affordableFloor.maxPriorityFeePerGas, 50000000n);
  const belowFloor = guard.buildFeePolicy(1n, 0n, caps, 40000000n);
  assert.equal(belowFloor.maxPriorityFeePerGas, 20000000n);
  assert.ok(40000000n - belowFloor.maxFeePerGas > 0n);
  for (const invalid of [undefined, null, "UNKNOWN", -1n]) {
    assert.throws(() => guard.buildFeePolicy(1n, 0n, caps, invalid), /PROFIT_BEFORE_GAS_REQUIRED/);
    assert.throws(() => guard.buildFees(1n, 0n, { ...caps, gasCap: 2n }, invalid), /PROFIT_BEFORE_GAS_REQUIRED/);
  }
  assert.deepEqual(guard.buildFeePolicy(1n, 41500000n, caps), {
    gasLimit: 1n, maxFeePerGas: 133000000n, maxPriorityFeePerGas: 50000000n,
  });
});

test("zero and worst-case nonpositive profit abort unsigned before the signer, including exact break-even", async t => {
  const caps = { gasCap: 1500000n, spendCap: 2000000000000000n, feeCap: null };
  // P covers child base alone, but not child base plus the prescribed 50% tip.
  for (const profit of [0n, 100000000000000n, 140062500000000n]) {
    const f = setup(t);
    f.options.prepare = async () => ({ caps, transaction: { ...f.transaction,
      ...guard.buildFeePolicy(1500000n, 41500000n, caps, profit) }, conservativeProfitBeforeGasWei: profit });
    await assert.rejects(guard.executeGuarded(f.options), /PROFIT_NET_NONPOSITIVE/);
    assert.equal(f.counters.sign, 0); assert.equal(f.counters.send, 0); assert.equal(fs.existsSync(f.journalDir), false);
  }
  // The last guard independently enforces P against the actual transaction, not
  // just the builder's result or token-denominated/rounded net telemetry.
  for (const profit of [undefined, null, 0n, 89999n, 90000n]) {
    const f = setup(t);
    f.options.prepare = async () => ({ transaction: f.transaction, caps: f.caps, conservativeProfitBeforeGasWei: profit });
    await assert.rejects(guard.executeGuarded(f.options), { code: profit == null || profit === 0n ? "PROFIT_UNVERIFIED" : "PROFIT_NET_NONPOSITIVE" });
    assert.equal(f.counters.sign, 0); assert.equal(f.counters.send, 0);
    assert.equal(fs.existsSync(f.journalDir), false);
  }
});

test("all fee builders share the policy rather than repeating the fixed priority-fee literal", () => {
  assert.match(guard.buildFees.toString(), /buildFeePolicy/);
  assert.doesNotMatch(guard.buildFees.toString(), /50000000n/);
  for (const file of ["next-block-execution.js", "m1-live-evidence.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "../lib", file), "utf8");
    assert.match(source, /guard\.buildFeePolicy\(/);
    assert.doesNotMatch(source, /50000000n/);
  }
});

test("future replay identity blocks confirmed/reverted variants independently of rank, calldata and nonce", async t => {
  const replayKey = id("1:protocol:borrower:market|parentHash|targetTimestamp");
  for (const stage of ["RECEIPT_VERIFIED", "REVERTED"]) {
    const f = setup(t); oldSent(f.journalDir, { stage, intent: { targetId: "old-rank", nextBlockReplayKey: replayKey } });
    f.options.intent = { ...f.options.intent, targetId: "new-rank", executionMode: "NEXT_BLOCK_PASSIVE", nextBlockReplayKey: replayKey };
    f.transaction.nonce = 9; f.transaction.data = "0xabcdef";
    await assert.rejects(guard.executeGuarded(f.options), /NEXT_BLOCK_ALREADY_ATTEMPTED/);
    assert.equal(f.counters.prepare, 0); assert.equal(f.counters.sign, 0); assert.equal(f.counters.send, 0);
  }
  const missing = setup(t); missing.options.intent.executionMode = "NEXT_BLOCK_PASSIVE";
  await assert.rejects(guard.executeGuarded(missing.options), /NEXT_BLOCK_REPLAY_KEY_REQUIRED/); assert.equal(missing.counters.sign, 0);
});

test("lifetime cap includes old finalized/reverted attempts across days and is rechecked before signing", async t => {
  const f = setup(t); f.caps.lifetimeCap = 5n;
  for (let i = 0; i < 5; i++) guard.atomicJson(path.join(f.journalDir, `old-${i}.json`), {
    stage: i % 2 ? "REVERTED" : "RECEIPT_VERIFIED", txHash: HASH, executedAt: "2000-01-01T00:00:00Z",
  });
  await assert.rejects(guard.executeGuarded(f.options), /LIFETIME_EXECUTION_CAP_REACHED/);
  assert.equal(f.counters.sign, 0); assert.equal(f.counters.send, 0);
  const changed = setup(t); oldSent(changed.journalDir, { stage: "REVERTED" }); let checks = 0;
  changed.options.validate = async () => ({ ...changed.caps, lifetimeCap: ++checks > 1 ? 1n : 5n });
  await assert.rejects(guard.executeGuarded(changed.options), /LIFETIME_EXECUTION_CAP_REACHED/); assert.equal(changed.counters.sign, 0);
});
