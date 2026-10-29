"use strict";

// Real parser/recovery boundary tests. NO signed-transaction-binding-fixture mock.
// Wallets are generated in memory for isolated offline transactions only; no key
// bytes, mnemonics or signed transactions are written to disk or printed.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Wallet, Transaction, keccak256, id, decodeRlp, encodeRlp } = require("../node_modules/ethers");
const guard = require("../lib/wallet-execution-guard.js");
const address = byte => "0x" + byte.repeat(40), word = byte => "0x" + byte.repeat(64);
const TO = address("2"), TOKEN = address("3"), BLOCK = word("5");
function setup(t, { chainId = 1 } = {}) {
  const base = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir(); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "signed-binding-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wallet = Wallet.createRandom(), account = wallet.address.toLowerCase();
  const counters = { prepare: 0, sign: 0, send: 0, receipt: 0 }, state = { signed: null };
  const transaction = { type: 2, chainId, nonce: 7, to: TO, data: "0x1234", value: 0n, gasLimit: 60000n,
    maxFeePerGas: 3n, maxPriorityFeePerGas: 1n, accessList: [] };
  const caps = { gasCap: 100000n, spendCap: 1000000n, feeCap: 10n, dailyCap: 2n, lifetimeCap: 2n };
  const options = { account, expectedChainId: chainId, lockRoot: path.join(root, "locks"), journalDir: path.join(root, "journals"),
    intent: { to: TO, profitToken: TOKEN, proofContextId: "ISOLATED_OFFLINE_PROOF", simulatedProfitBeforeGasRaw: "123" }, receiptWaitMs: 0,
    prepare: async () => { counters.prepare++; return { transaction, caps, conservativeProfitBeforeGasWei: 1000000n }; }, validate: async () => caps,
    signTransaction: async tx => { counters.sign++; state.signed = await wallet.signTransaction(tx); return state.signed; },
    sendRawTransaction: async signed => { counters.send++; return keccak256(signed); },
    receiptRpc: async txHash => { counters.receipt++; return { transactionHash: txHash, from: account, to: TO, blockHash: BLOCK,
      blockNumber: "0x10", status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x2", logs: [] }; }
  };
  return { root, wallet, account, counters, state, transaction, caps, options };
}
function journal(f) {
  const files = fs.readdirSync(f.options.journalDir).filter(name => name.endsWith(".json")); assert.equal(files.length, 1);
  const file = path.join(f.options.journalDir, files[0]), text = fs.readFileSync(file, "utf8");
  return { file, text, record: JSON.parse(text) };
}
function safeRejection(code) {
  return error => {
    assert.ok(error instanceof guard.ExecutionError); assert.equal(error.code, code); assert.equal(error.message, code);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /UNTRUSTED|privateKey|mnemonic|serialized|signature=/); return true;
  };
}
async function rejectedPostSignHold(f, code) {
  await assert.rejects(guard.executeGuarded(f.options), safeRejection(code));
  assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 0); assert.equal(f.counters.receipt, 0);
  const saved = journal(f), record = saved.record;
  assert.equal(record.stage, "PREPARED"); assert.equal(record.txHash, null); assert.equal(record.signerInvoked, true);
  assert.equal(record.signedTransactionBinding, "REJECTED"); assert.equal(record.reason, code); assert.equal(record.abortPhase, undefined);
  assert.equal(record.intent.proofContextId, "ISOLATED_OFFLINE_PROOF"); assert.equal(record.intent.calldataHash, keccak256("0x1234"));
  assert.equal(record.intent.nonce, 7); assert.equal(record.intent.gasLimit, "60000"); assert.equal(record.intent.maxFeePerGasWei, "3");
  assert.equal(record.realizedNetProfit, "UNKNOWN"); assert.doesNotMatch(saved.text, /privateKey|mnemonic|UNTRUSTED/);
  if (typeof f.state.signed === "string" && f.state.signed.length > 10) assert.equal(saved.text.includes(f.state.signed), false);
  assert.equal(guard.readJournals(f.options.journalDir, f.options.account ?? guard.MAIN_ACCOUNT, f.options.expectedChainId ?? 1)[0].record.stage, "PREPARED");
  await assert.rejects(guard.executeGuarded(f.options), safeRejection("PREPARED_INTENT_REQUIRES_MANUAL_RECONCILIATION"));
  assert.equal(f.counters.prepare, 1); assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 0); assert.equal(f.counters.receipt, 0);
  assert.equal(fs.readFileSync(saved.file, "utf8"), saved.text); assert.equal(fs.readdirSync(f.options.lockRoot).length, 0);
}
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }; });
test.after(() => { globalThis.fetch = originalFetch; });

test("real ephemeral type-2 signatures recover the explicit account and bind all proved execution fields before send", async t => {
  assert.throws(() => Transaction.from("0x010203")); // No parser fixture is installed here.
  for (const chainId of [1, 8453, 42161]) {
    const f = setup(t, { chainId });
    const send = f.options.sendRawTransaction;
    f.options.sendRawTransaction = async signed => {
      const decoded = Transaction.from(signed), saved = journal(f).record;
      assert.equal(decoded.from.toLowerCase(), f.account); assert.equal(decoded.type, 2); assert.equal(decoded.chainId, BigInt(chainId));
      assert.equal(decoded.nonce, f.transaction.nonce); assert.equal(decoded.to.toLowerCase(), TO); assert.equal(decoded.data, f.transaction.data);
      assert.equal(decoded.value, f.transaction.value); assert.equal(decoded.gasLimit, f.transaction.gasLimit);
      assert.equal(decoded.maxFeePerGas, f.transaction.maxFeePerGas); assert.equal(decoded.maxPriorityFeePerGas, f.transaction.maxPriorityFeePerGas);
      assert.deepEqual(decoded.accessList, []); assert.equal(saved.stage, "PREPARED"); assert.equal(saved.txHash, keccak256(signed));
      assert.equal(saved.intent.calldataHash, keccak256(f.transaction.data)); assert.deepEqual(saved.intent.accessList, []);
      return send(signed);
    };
    const result = await guard.executeGuarded(f.options);
    assert.equal(result.stage, "RECEIPT_VERIFIED"); assert.equal(result.owner, f.account); assert.equal(result.chainId, chainId);
    assert.equal(result.txHash, keccak256(f.state.signed)); assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 1);
    assert.equal(result.intent.proofContextId, "ISOLATED_OFFLINE_PROOF");
  }
});

test("real signatures bind ordered access lists including duplicate slots; omitted lists mean empty", async t => {
  for (const accessList of [undefined, [[address("a"), [word("b"), word("b")]]],
    [{ address: address("a"), storageKeys: [word("b")] }, { address: address("c"), storageKeys: [] }]]) {
    const f = setup(t); if (accessList === undefined) delete f.transaction.accessList; else f.transaction.accessList = accessList;
    const result = await guard.executeGuarded(f.options), decoded = Transaction.from(f.state.signed);
    assert.equal(result.stage, "RECEIPT_VERIFIED"); assert.equal(f.counters.send, 1);
    assert.deepEqual(result.intent.accessList, decoded.accessList.map(row => ({ address: row.address.toLowerCase(), storageKeys: row.storageKeys })));
  }
});

test("a valid signature with any changed type-2 execution field rejects without sending", async t => {
  for (const change of [{ chainId: 8453 }, { nonce: 8 }, { to: address("4") }, { to: null }, { data: "0xabcd" }, { data: "0x" },
    { value: 1n }, { gasLimit: 60001n }, { maxFeePerGas: 4n }, { maxPriorityFeePerGas: 2n },
    { accessList: [{ address: address("a"), storageKeys: [word("b")] }] }]) {
    const f = setup(t);
    f.options.signTransaction = async tx => {
      f.counters.sign++; f.state.signed = await f.wallet.signTransaction({ ...tx, ...change }); return f.state.signed;
    };
    await rejectedPostSignHold(f, "SIGNED_TRANSACTION_MISMATCH");
  }
});

test("valid legacy and type-1 signed transactions cannot replace the authorized type-2 envelope", async t => {
  for (const type of [0, 1]) {
    const f = setup(t);
    f.options.signTransaction = async tx => {
      f.counters.sign++; const changed = { ...tx, type, gasPrice: 3n }; delete changed.maxFeePerGas; delete changed.maxPriorityFeePerGas;
      if (type === 0) delete changed.accessList;
      f.state.signed = await f.wallet.signTransaction(changed); return f.state.signed;
    };
    await rejectedPostSignHold(f, "SIGNED_TRANSACTION_MISMATCH");
  }
});

test("wrong recovered signer rejects and the default production account is never inferred from returned bytes", async t => {
  const wrong = setup(t), otherWallet = Wallet.createRandom();
  wrong.options.signTransaction = async tx => { wrong.counters.sign++; wrong.state.signed = await otherWallet.signTransaction(tx); return wrong.state.signed; };
  await rejectedPostSignHold(wrong, "SIGNED_TRANSACTION_MISMATCH");
  const defaults = setup(t); delete defaults.options.account; delete defaults.options.expectedChainId;
  await rejectedPostSignHold(defaults, "SIGNED_TRANSACTION_MISMATCH");
  assert.equal(journal(defaults).record.owner, guard.MAIN_ACCOUNT); assert.equal(journal(defaults).record.chainId, 1);
  const fromOverride = setup(t); fromOverride.transaction.from = otherWallet.address;
  await assert.rejects(guard.executeGuarded(fromOverride.options), safeRejection("TX_SCOPE_INVALID"));
  assert.equal(fromOverride.counters.sign, 0); assert.equal(fromOverride.counters.send, 0);
});

test("access-list address, key, ordering and duplicate differences reject despite otherwise identical signed fields", async t => {
  const original = [{ address: address("a"), storageKeys: [word("b"), word("c")] }, { address: address("d"), storageKeys: [] }];
  for (const changed of [[], [{ ...original[0], address: address("e") }, original[1]],
    [{ ...original[0], storageKeys: [word("b"), word("e")] }, original[1]],
    [{ ...original[0], storageKeys: [word("c"), word("b")] }, original[1]], [original[1], original[0]],
    [{ ...original[0], storageKeys: [word("b"), word("c"), word("c")] }, original[1]]]) {
    const f = setup(t); f.transaction.accessList = structuredClone(original);
    f.options.signTransaction = async tx => {
      f.counters.sign++; f.state.signed = await f.wallet.signTransaction({ ...tx, accessList: changed }); return f.state.signed;
    };
    await rejectedPostSignHold(f, "SIGNED_TRANSACTION_MISMATCH"); assert.deepEqual(journal(f).record.intent.accessList, original);
  }
});

test("malformed and unsigned bytes produce sanitized durable post-sign holds, never unsigned aborts", async t => {
  for (const malformed of [null, {}, "UNTRUSTED_SIGNER_OUTPUT", "0x", "0x1", "0x010203", "0x02", "0x0200", "0x010203\n"]) {
    const f = setup(t);
    f.options.signTransaction = async () => { f.counters.sign++; f.state.signed = malformed; return malformed; };
    await rejectedPostSignHold(f, "SIGNED_TRANSACTION_INVALID");
  }
  const unsigned = setup(t);
  unsigned.options.signTransaction = async tx => { unsigned.counters.sign++; return Transaction.from(tx).unsignedSerialized; };
  await rejectedPostSignHold(unsigned, "SIGNED_TRANSACTION_INVALID");
});

test("real signature truncation and invalid recovery components fail closed without leaking parser details", async t => {
  for (const mutate of [signed => signed.slice(0, -2), signed => {
    const fields = decodeRlp("0x" + signed.slice(4)); fields[9] = "0x02"; return "0x02" + encodeRlp(fields).slice(2);
  }, signed => {
    const fields = decodeRlp("0x" + signed.slice(4)); fields[10] = "0x"; fields[11] = "0x"; return "0x02" + encodeRlp(fields).slice(2);
  }]) {
    const f = setup(t);
    f.options.signTransaction = async tx => { f.counters.sign++; f.state.signed = mutate(await f.wallet.signTransaction(tx)); return f.state.signed; };
    await rejectedPostSignHold(f, "SIGNED_TRANSACTION_INVALID");
  }
});

test("signer mutation of the supplied transaction cannot redefine the previously proved execution", async t => {
  for (const signBeforeMutation of [false, true]) {
    const f = setup(t); f.transaction.accessList = [{ address: address("a"), storageKeys: [word("b")] }];
    f.options.signTransaction = async tx => {
      f.counters.sign++; const signed = signBeforeMutation ? await f.wallet.signTransaction(tx) : null;
      tx.data = "0xabcdef"; tx.gasLimit = 59000n; tx.accessList[0].storageKeys[0] = word("c");
      f.state.signed = signed ?? await f.wallet.signTransaction(tx); return f.state.signed;
    };
    await rejectedPostSignHold(f, "SIGNED_TRANSACTION_MISMATCH");
    assert.deepEqual(journal(f).record.intent.accessList, [{ address: address("a"), storageKeys: [word("b")] }]);
  }
});

test("validation cannot mutate the original execution before signing or weaken a signed envelope's later caps", async t => {
  const before = setup(t); let checks = 0;
  before.options.validate = async () => { if (++checks === 2) before.transaction.data = "0xabcd"; return before.caps; };
  await assert.rejects(guard.executeGuarded(before.options), safeRejection("UNSIGNED_TRANSACTION_CHANGED"));
  assert.equal(journal(before).record.stage, "ABORTED_UNSIGNED"); assert.equal(before.counters.sign, 0); assert.equal(before.counters.send, 0);
  const after = setup(t); checks = 0;
  after.options.validate = async () => {
    if (++checks === 3) { after.transaction.gasLimit = 1n; return { ...after.caps, spendCap: 10n }; }
    return after.caps;
  };
  await assert.rejects(guard.executeGuarded(after.options), safeRejection("BROADCAST_OUTCOME_UNCERTAIN"));
  assert.equal(journal(after).record.stage, "UNCERTAIN"); assert.equal(journal(after).record.txHash, keccak256(after.state.signed));
  assert.equal(after.counters.sign, 1); assert.equal(after.counters.send, 0);
  after.options.receiptRpc = async () => null;
  await assert.rejects(guard.executeGuarded(after.options), safeRejection("TX_ALREADY_PENDING_ON_SAME_WALLET"));
});

test("binding-hold persistence failure retains the original prepared manual blocker and never sends", async t => {
  const f = setup(t); let returned = false;
  f.options.signTransaction = async () => { f.counters.sign++; returned = true; return "0x010203"; };
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (returned && path.dirname(destination) === f.options.journalDir) throw new Error("UNTRUSTED_PERSISTENCE_DETAILS");
    return rename(source, destination);
  });
  await assert.rejects(guard.executeGuarded(f.options), safeRejection("SIGNED_BINDING_HOLD_PERSIST_FAILED"));
  const saved = journal(f).record; assert.equal(saved.stage, "PREPARED"); assert.equal(saved.txHash, null); assert.equal(saved.abortPhase, undefined);
  assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 0);
  await assert.rejects(guard.executeGuarded(f.options), safeRejection("PREPARED_INTENT_REQUIRES_MANUAL_RECONCILIATION"));
});

test("there is no production skip-verification option and M1/replay identities remain in rejected signed journals", async t => {
  const f = setup(t);
  f.options.skipSignedTransactionVerification = true;
  f.options.intent = { ...f.options.intent, targetId: "targetM1_Morpho_USDe_DAI", executionMode: "NEXT_BLOCK_PASSIVE", nextBlockReplayKey: id("offline-parent") };
  f.options.signTransaction = async () => { f.counters.sign++; return "0x010203"; };
  await rejectedPostSignHold(f, "SIGNED_TRANSACTION_INVALID");
  const saved = journal(f).record;
  assert.equal(saved.intent.nextBlockReplayKey, id("offline-parent")); assert.match(saved.intent.m1TriggerEventKey, /^0x[0-9a-f]{64}$/);
});

test("successful real signatures preserve signed lifetime limits and finalized/reverted M1 replay protection", async t => {
  const limited = setup(t); limited.caps.lifetimeCap = 1n;
  await guard.executeGuarded(limited.options);
  await assert.rejects(guard.executeGuarded(limited.options), safeRejection("LIFETIME_EXECUTION_CAP_REACHED"));
  assert.equal(limited.counters.sign, 1);
  for (const status of ["0x1", "0x0"]) {
    const f = setup(t); f.options.intent.targetId = "targetM1_Morpho_USDe_DAI";
    const receipt = f.options.receiptRpc; f.options.receiptRpc = async hash => ({ ...await receipt(hash), status });
    const result = await guard.executeGuarded(f.options); assert.equal(result.stage, status === "0x1" ? "RECEIPT_VERIFIED" : "REVERTED");
    f.transaction.nonce++; f.options.intent.executionMode = "NEXT_BLOCK_PASSIVE"; f.options.intent.nextBlockReplayKey = id("different-parent");
    await assert.rejects(guard.executeGuarded(f.options), safeRejection("M1_TRIGGER_EVENT_ALREADY_ATTEMPTED"));
    assert.equal(f.counters.sign, 1); assert.equal(f.counters.send, 1);
  }
});
