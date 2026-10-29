"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { classifyTransaction, checkFile } = require("../atomic/solana-closed-arb-verifier.js");

const PAYER = "MriyaNN8TMp6qRWjfr723PK7xgQK7yCt7Kg2v2PQu7X";
const WSOL = "So11111111111111111111111111111111111111112";
const PUMP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const CASES = [
  { signature: "jsfPtXUSTzdMNVLAUT6xnE2EynxVMagLq7tNkQfU2C2vZ9PfRzFS2iAxXzwg3e5ZURZ2bikeuXegzgxBQr2pLVw",
    slot: 451016637, fee: 6881900077n, surplus: 13270062083n },
  { signature: "57h89SHpxk2uJXdJdUvCfrz3Wjb8jHXoHZ6NiZVVBRheK2tU8fLi4djo83nprHWCYtqXN8q61DYEJVBLzkq9maWp",
    slot: 451002664, fee: 10251n, surplus: 3117845571n },
];

function fixture(ref = CASES[0]) {
  const nativeBefore = 100000000000n;
  const wsolBefore = 50000000000n;
  const wsolAfter = wsolBefore + ref.surplus + ref.fee;
  const balance = (accountIndex, mint, value, decimals) => ({ accountIndex, mint, owner: PAYER,
    uiTokenAmount: { amount: String(value), decimals } });
  return { expectedSignature: ref.signature, expectedPayer: PAYER,
    rpcResult: { slot: ref.slot, transaction: { signatures: [ref.signature], message: {
      accountKeys: [{ pubkey: PAYER, signer: true }, { pubkey: "B".repeat(32), signer: false },
        { pubkey: "C".repeat(32), signer: false }],
    } }, meta: { err: null, fee: ref.fee.toString(),
      preBalances: [nativeBefore.toString(), "1000000", "1000000"],
      postBalances: [(nativeBefore - ref.fee).toString(), "1000000", "1000000"],
      preTokenBalances: [balance(1, WSOL, wsolBefore, 9), balance(2, "A".repeat(32), 0, 6)],
      postTokenBalances: [balance(1, WSOL, wsolAfter, 9), balance(2, "A".repeat(32), 0, 6)],
      innerInstructions: [{ index: 0, instructions: [{ programId: PUMP }, { programId: DLMM }] }],
    } } };
}
const verify = x => classifyTransaction(x);
function safe(result) {
  assert.equal(result.routeProfitProven, false);
  assert.equal(result.allInNetLamports, null);
  assert.equal(result.currentExecutable, "unknown");
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.signedActionJustified, false);
  assert.equal(result.probabilityPercent, null);
}

test("both pinned historical outcomes recompute combined payer WSOL+native delta after fee, not route PnL", () => {
  for (const ref of CASES) {
    const result = verify(fixture(ref));
    assert.equal(result.status, "OBSERVED_PAYER_SURPLUS_ONLY");
    assert.equal(result.observedCombinedPayerDeltaLamports, ref.surplus.toString());
    assert.equal(result.observedFeeLamports, ref.fee.toString());
    assert.deepEqual(result.blockers, ["UNRELATED_TRANSFER_OR_ACTOR_CLUSTER_UNRESOLVED",
      "FAILED_ATTEMPTS_INFRA_AND_CAPITAL_UNPRICED"]);
    safe(result);
  }
});

test("additional transaction signers do not replace required signature[0] fee payer", () => {
  const s = fixture();
  s.rpcResult.transaction.signatures.push(CASES[1].signature);
  assert.equal(verify(s).status, "OBSERVED_PAYER_SURPLUS_ONLY");
  s.rpcResult.transaction.signatures.reverse();
  assert.equal(verify(s).status, "NOT_READY");
});

test("wrong slot/signature/payer and non-fee payer key0 cannot qualify", () => {
  for (const mutate of [
    s => { s.rpcResult.slot++; },
    s => { s.rpcResult.transaction.signatures[0] = CASES[1].signature; },
    s => { s.expectedSignature = CASES[1].signature; },
    s => { s.expectedPayer = "D".repeat(32); },
    s => { s.rpcResult.transaction.message.accountKeys[0].pubkey = "D".repeat(32); },
    s => { s.rpcResult.transaction.message.accountKeys[0].signer = false; },
  ]) { const s = fixture(); mutate(s);
    const result = verify(s); assert.equal(result.status, "NOT_READY"); safe(result);
  }
});

test("failed transaction, absent programs, fee mismatch and native inflow do not qualify", () => {
  for (const mutate of [
    s => { s.rpcResult.meta.err = { InstructionError: [0, "Custom"] }; },
    s => { s.rpcResult.meta.innerInstructions[0].instructions.pop(); },
    s => { s.rpcResult.meta.innerInstructions = []; },
    s => { s.rpcResult.meta.fee = "6881900078"; },
    s => { s.rpcResult.meta.postBalances[0] = s.rpcResult.meta.preBalances[0]; },
  ]) { const s = fixture(); mutate(s);
    const result = verify(s); assert.equal(result.status, "NOT_READY"); safe(result);
  }
});

test("non-WSOL payer inventory changes fail closed, including compensating opposite account changes", () => {
  const s = fixture();
  s.rpcResult.meta.postTokenBalances[1].uiTokenAmount.amount = "1";
  assert.equal(verify(s).status, "NOT_READY");
  s.rpcResult.meta.preTokenBalances.push({ ...s.rpcResult.meta.preTokenBalances[1], accountIndex: 0 });
  s.rpcResult.meta.postTokenBalances.push({ ...s.rpcResult.meta.postTokenBalances[1], accountIndex: 0,
    uiTokenAmount: { amount: "0", decimals: 6 } });
  assert.equal(verify(s).status, "NOT_READY");
});

test("omitted token owner, unmatched pre/post, missing fee and invalid lamports are incomplete", () => {
  for (const mutate of [
    s => { delete s.rpcResult.meta.preTokenBalances[0].owner; },
    s => { delete s.rpcResult.meta.postTokenBalances[1].owner; },
    s => { s.rpcResult.meta.postTokenBalances.pop(); },
    s => { delete s.rpcResult.meta.fee; },
    s => { s.rpcResult.meta.fee = "-1"; },
    s => { s.rpcResult.meta.preBalances[0] = 1.5; },
    s => { s.rpcResult.meta.postTokenBalances[0].uiTokenAmount.amount = "1.5"; },
    s => { delete s.rpcResult.meta.err; },
  ]) { const s = fixture(); mutate(s);
    const result = verify(s); assert.equal(result.status, "INCOMPLETE"); safe(result);
  }
});

test("spoofed unrelated inbound WSOL still remains payer surplus only and explicit attribution gap", () => {
  const s = fixture();
  s.rpcResult.meta.innerInstructions[0].instructions.push({ programId: "D".repeat(32),
    parsed: { type: "transfer", info: { destination: PAYER, amount: "123" } } });
  const result = verify(s);
  assert.equal(result.status, "OBSERVED_PAYER_SURPLUS_ONLY");
  assert.equal(result.routeProfitProven, false);
  assert.match(result.blockers.join(" "), /UNRELATED_TRANSFER/);
  safe(result);
});

test("no WSOL or intermediate owner evidence, invalid inner programs and oversize inputs reject", () => {
  for (const mutate of [
    s => { s.rpcResult.meta.preTokenBalances[0].owner = "D".repeat(32);
      s.rpcResult.meta.postTokenBalances[0].owner = "D".repeat(32); },
    s => { s.rpcResult.meta.preTokenBalances.pop(); s.rpcResult.meta.postTokenBalances.pop(); },
    s => { s.rpcResult.meta.innerInstructions[0].instructions[0].programId = "not-base58"; },
    s => { s.extra = "PRIVATE_ENDPOINT_MARKER".repeat(14000); },
  ]) { const s = fixture(); mutate(s);
    const result = verify(s); assert.equal(result.status, "INCOMPLETE");
    assert.equal(JSON.stringify(result).includes("PRIVATE_ENDPOINT_MARKER"), false); safe(result);
  }
});

test("offline CLI only checks bounded absolute file and never echoes secret-looking arguments", () => {
  assert.equal(checkFile("relative.json").status, "INCOMPLETE");
  const script = path.resolve(__dirname, "..", "atomic", "solana-closed-arb-verifier.js");
  for (const args of [[], ["--check", "relative.json"], ["--network"], ["--check", "PRIVATE_ENDPOINT_MARKER"]]) {
    const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout).status, "INCOMPLETE");
    assert.equal(run.stdout.includes("PRIVATE_ENDPOINT_MARKER"), false);
  }
});
