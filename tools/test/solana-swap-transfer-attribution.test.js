"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { attributePinnedSwaps: attribute } = require("../atomic/solana-swap-transfer-attribution.js");
const real = require("../../reports/raw/fast/atomic-solana-closed-cycles-20260927.json");

const PAYER = "MriyaNN8TMp6qRWjfr723PK7xgQK7yCt7Kg2v2PQu7X";
const WSOL = "So11111111111111111111111111111111111111112";
const MINT = "A".repeat(32);
const PARENT = "AN225ykGPAmckE9uMCCM7jQv3L3AYwiPZbHqgMUYEgCR";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const PUMP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const REFS = [
  ["jsfPtXUSTzdMNVLAUT6xnE2EynxVMagLq7tNkQfU2C2vZ9PfRzFS2iAxXzwg3e5ZURZ2bikeuXegzgxBQr2pLVw", 451016637, "6881900077"],
  ["57h89SHpxk2uJXdJdUvCfrz3Wjb8jHXoHZ6NiZVVBRheK2tU8fLi4djo83nprHWCYtqXN8q61DYEJVBLzkq9maWp", 451002664, "10251"],
];
const KEYS = [PAYER, "B".repeat(32), "C".repeat(32), "D".repeat(32),
  "E".repeat(32), "F".repeat(32), "G".repeat(32)];
const OWNER = [null, PAYER, PAYER, "H".repeat(32), "J".repeat(32), "K".repeat(32), "L".repeat(32)];
const MINTS = [null, WSOL, MINT, WSOL, MINT, MINT, WSOL];
const DECIMALS = [null, 9, 6, 9, 6, 6, 9];

function transfer(sourceIndex, destIndex, mint, amount) {
  return { programId: mint === WSOL ? TOKEN : TOKEN_2022, stackHeight: 3,
    parsed: { type: "transferChecked", info: { source: KEYS[sourceIndex], destination: KEYS[destIndex], mint,
      tokenAmount: { amount: String(amount), decimals: mint === WSOL ? 9 : 6 } } } };
}
function addPumpTokenLog(s, count) {
  const lines = s.rpcResult.meta.logMessages;
  const at = lines.indexOf(`Program ${PUMP} success`);
  for (let i = 0; i < count; i++) {
    lines.splice(at + i * 2, 0, `Program ${TOKEN} invoke [3]`, `Program ${TOKEN} success`);
  }
}
function balances(values) {
  return values.map((value, i) => i ? ({ accountIndex: i, mint: MINTS[i], owner: OWNER[i],
    uiTokenAmount: { amount: String(value), decimals: DECIMALS[i] } }) : null).slice(1);
}
function logs() {
  return [
    `Program ${COMPUTE} invoke [1]`, `Program ${COMPUTE} success`,
    `Program ${PARENT} invoke [1]`,
    `Program ${PUMP} invoke [2]`, "Program log: Instruction: BuyExactQuoteIn",
    `Program ${TOKEN} invoke [3]`, `Program ${TOKEN} success`,
    `Program ${TOKEN_2022} invoke [3]`, `Program ${TOKEN_2022} success`,
    `Program ${PUMP} success`,
    `Program ${DLMM} invoke [2]`, "Program log: Instruction: Swap2",
    `Program ${TOKEN_2022} invoke [3]`, `Program ${TOKEN_2022} success`,
    `Program ${TOKEN} invoke [3]`, `Program ${TOKEN} success`,
    `Program ${DLMM} success`,
    `Program ${PARENT} success`,
  ];
}
function fixture([signature, slot, fee] = REFS[0]) {
  const nativeBefore = 100000000000n;
  const data = { expectedSignature: signature, rpcResult: { slot,
    transaction: { signatures: [signature], message: {
      accountKeys: KEYS.map((pubkey, i) => ({ pubkey, signer: i === 0 })),
      instructions: [{ programId: COMPUTE }, { programId: PARENT }],
    } }, meta: { err: null, fee,
      preBalances: [nativeBefore.toString(), ...Array(6).fill("0")],
      postBalances: [(nativeBefore - BigInt(fee)).toString(), ...Array(6).fill("0")],
      preTokenBalances: balances([null, 1000, 0, 500, 500, 500, 500]),
      postTokenBalances: balances([null, 1010, 0, 600, 300, 700, 390]),
      innerInstructions: [
        { index: 1, instructions: [
          { programId: PUMP, stackHeight: 2 }, transfer(1, 3, WSOL, 100), transfer(4, 2, MINT, 200),
          { programId: DLMM, stackHeight: 2 }, transfer(2, 5, MINT, 200), transfer(6, 1, WSOL, 110),
        ] },
      ], logMessages: logs(),
    } } };
  return data;
}
function neverProfit(r) {
  assert.equal(r.routeProfitProven, false); assert.equal(r.allInNet, null);
  assert.equal(r.currentExecutable, "unknown"); assert.equal(r.dispatchAllowed, false);
  assert.equal(r.signedActionJustified, false); assert.equal(r.probabilityPercent, null);
}

test("both pinned signatures: strict ordered four-leg Token2022/WSOL flow is observational only", () => {
  for (const ref of REFS) {
    const r = attribute(fixture(ref));
    assert.equal(r.status, "TRANSFER_FLOW_OBSERVED_ONLY");
    assert.deepEqual(r.observedLegs, { pumpFirstWsolOutboundRaw: "100", pumpIntermediateInboundRaw: "200",
      dlmmIntermediateOutboundRaw: "200", dlmmWsolInboundRaw: "110" });
    assert.equal(r.observedNetworkFeeLamports, ref[2]);
    assert.match(r.blockers.join(" "), /NO_INDEPENDENT_PROGRAM_PARSER/);
    neverProfit(r);
  }
});

test("both saved finalized public fixtures bind nested parent/stack and raw transfers without profit attribution", () => {
  assert.equal(real.schema, "solana-closed-arb-finalized-fixtures/v1");
  assert.equal(real.items.length, 2);
  const expected = [
    { pumpFirstWsolOutboundRaw: "100229867489", pumpIntermediateInboundRaw: "3654826661350",
      dlmmIntermediateOutboundRaw: "3654826661350", dlmmWsolInboundRaw: "120982008497" },
    { pumpFirstWsolOutboundRaw: "17409788070", pumpIntermediateInboundRaw: "3384631268989",
      dlmmIntermediateOutboundRaw: "3384631268989", dlmmWsolInboundRaw: "20666644196" },
  ];
  const other = [["25007452", "550163944", "25007452"],
    ["4343760", "130312785", "4343759"]];
  for (const [i, item] of real.items.entries()) {
    const r = attribute({ expectedSignature: item.signature, rpcResult: item.rpcResult });
    assert.equal(r.status, "TRANSFER_FLOW_OBSERVED_ONLY", JSON.stringify(r));
    assert.deepEqual(r.observedLegs, expected[i]);
    assert.deepEqual(r.additionalPumpWsolOutboundsRaw, other[i]);
    assert.ok(r.blockers.includes("UNATTRIBUTED_OR_EXTERNAL_TRANSFER"));
    assert.ok(r.blockers.includes("PUMPSWAP_MULTIPLE_WSOL_OUTFLOWS_UNSEGMENTED"));
    neverProfit(r);
  }
});

test("real fixture mutated Token2022 ID, relative stack, or unrelated credit fails closed", () => {
  for (const item of real.items) {
    for (const mutate of [
      r => { r.meta.innerInstructions[0].instructions[2].programId =
        "TokenzQdBNbLqP5VEhdkAS6EPF4GmHFU4Jsp7dXay7"; },
      r => { r.meta.innerInstructions[0].instructions[2].stackHeight = 2; },
      r => {
        const instructions = r.meta.innerInstructions[0].instructions;
        const accountKeys = r.transaction.message.accountKeys;
        const original = instructions[3].parsed.info;
        const source = original.destination, destination = original.source;
        const sourceIndex = accountKeys.findIndex(k => k.pubkey === source);
        const destinationIndex = accountKeys.findIndex(k => k.pubkey === destination);
        const additional = structuredClone(instructions[3]);
        Object.assign(additional.parsed.info, { source, destination, tokenAmount:
          { ...additional.parsed.info.tokenAmount, amount: "1" } });
        instructions.splice(7, 0, additional);
        const sourceBalance = r.meta.postTokenBalances.find(b => b.accountIndex === sourceIndex);
        const destBalance = r.meta.postTokenBalances.find(b => b.accountIndex === destinationIndex);
        sourceBalance.uiTokenAmount.amount = (BigInt(sourceBalance.uiTokenAmount.amount) - 1n).toString();
        destBalance.uiTokenAmount.amount = (BigInt(destBalance.uiTokenAmount.amount) + 1n).toString();
        r.meta.postBalances[sourceIndex] -= 1;
        r.meta.postBalances[destinationIndex] += 1;
        const at = r.meta.logMessages.indexOf(`Program ${PUMP} invoke [3]`);
        r.meta.logMessages.splice(at, 0, `Program ${TOKEN} invoke [3]`, `Program ${TOKEN} success`);
      },
    ]) {
      const copy = structuredClone(item.rpcResult);
      mutate(copy);
      const r = attribute({ expectedSignature: item.signature, rpcResult: copy });
      assert.equal(r.status, "INCOMPLETE"); neverProfit(r);
    }
  }
});

test("altered signature/slot, swap order, wrong program and ambiguous repeated top level fail", () => {
  for (const mutate of [
    s => { s.expectedSignature = REFS[1][0]; },
    s => { s.rpcResult.slot++; },
    s => { s.rpcResult.transaction.message.instructions.reverse(); },
    s => { s.rpcResult.transaction.message.instructions[1].programId = "Q".repeat(32); },
    s => { s.rpcResult.transaction.message.instructions.push({ programId: PUMP }); },
    s => { s.rpcResult.meta.logMessages[1] = "Program log: Instruction: Swap2"; },
    s => { s.rpcResult.meta.logMessages.pop(); },
  ]) { const s = fixture(); mutate(s); const r = attribute(s);
    assert.equal(r.status, "INCOMPLETE"); neverProfit(r);
  }
});

test("Token2022 intermediate, classic WSOL, mint and decimals cannot be swapped", () => {
  for (const mutate of [
    s => { s.rpcResult.meta.innerInstructions[0].instructions[2].programId = TOKEN; },
    s => { s.rpcResult.meta.innerInstructions[0].instructions[5].programId = TOKEN_2022; },
    s => { s.rpcResult.meta.innerInstructions[0].instructions[4].parsed.info.mint = "Z".repeat(32); },
    s => { s.rpcResult.meta.innerInstructions[0].instructions[1].parsed.info.tokenAmount.decimals = 6; },
    s => { s.rpcResult.meta.preTokenBalances[0].uiTokenAmount.decimals = 6;
      s.rpcResult.meta.postTokenBalances[0].uiTokenAmount.decimals = 6;
      s.rpcResult.meta.innerInstructions[0].instructions[1].parsed.info.tokenAmount.decimals = 6;
      s.rpcResult.meta.innerInstructions[0].instructions[5].parsed.info.tokenAmount.decimals = 6; },
    s => { s.rpcResult.meta.innerInstructions[0].instructions[1].parsed.type = "transfer"; },
    s => { delete s.rpcResult.meta.innerInstructions[0].instructions[1].stackHeight; },
    s => { s.rpcResult.meta.innerInstructions[0].instructions[1].stackHeight = 2; },
    s => { s.rpcResult.meta.logMessages[5] = `Program ${TOKEN_2022} invoke [3]`; },
    s => { s.rpcResult.transaction.message.instructions.push({ programId: TOKEN }); },
  ]) { const s = fixture(); mutate(s); assert.equal(attribute(s).status, "INCOMPLETE"); }
});

test("missing owner, unmatched account, missing inner group and malformed raw fail closed", () => {
  for (const mutate of [
    s => { delete s.rpcResult.meta.preTokenBalances[0].owner; },
    s => { s.rpcResult.meta.postTokenBalances.pop(); },
    s => { s.rpcResult.meta.innerInstructions.pop(); },
    s => { s.rpcResult.meta.innerInstructions[0].instructions[1].parsed.info.tokenAmount.amount = "1.5"; },
    s => { s.rpcResult.meta.postTokenBalances[0].uiTokenAmount.amount = "1011"; },
    s => { s.rpcResult.meta.innerInstructions[0].instructions[2].parsed.info.tokenAmount.amount = "199"; },
  ]) { const s = fixture(); mutate(s); const r = attribute(s);
    assert.equal(r.status, "INCOMPLETE"); neverProfit(r);
  }
});

test("invented unrelated payer credit is explicitly blocked despite exact accounted balances", () => {
  const s = fixture();
  s.rpcResult.meta.innerInstructions[0].instructions.splice(3, 0, transfer(3, 1, WSOL, 5));
  addPumpTokenLog(s, 1);
  s.rpcResult.meta.postTokenBalances[0].uiTokenAmount.amount = "1015";
  s.rpcResult.meta.postTokenBalances[2].uiTokenAmount.amount = "595";
  const r = attribute(s);
  assert.equal(r.status, "INCOMPLETE");
  assert.equal(r.unattributedTokenTransferCount, 1);
  assert.ok(r.blockers.includes("UNATTRIBUTED_OR_EXTERNAL_TRANSFER"));
  neverProfit(r);
});

test("compensating payer token movements cannot hide extra edges", () => {
  const s = fixture();
  s.rpcResult.meta.innerInstructions[0].instructions.splice(3, 0,
    transfer(3, 1, WSOL, 5), transfer(1, 3, WSOL, 5));
  addPumpTokenLog(s, 2);
  const r = attribute(s);
  assert.equal(r.status, "INCOMPLETE");
  assert.ok(r.blockers.includes("SWAP_LEG_EDGES_AMBIGUOUS") ||
    r.blockers.includes("UNATTRIBUTED_OR_EXTERNAL_TRANSFER"));
  neverProfit(r);
});

test("native third-party delta and fee discrepancy cannot be counted as route PnL", () => {
  const other = fixture(); other.rpcResult.meta.postBalances[3] = "1";
  const r = attribute(other);
  assert.equal(r.status, "INCOMPLETE");
  assert.ok(r.blockers.includes("UNATTRIBUTED_OR_EXTERNAL_TRANSFER"));
  neverProfit(r);
  const fee = fixture(); fee.rpcResult.meta.postBalances[0] = fee.rpcResult.meta.preBalances[0];
  assert.equal(attribute(fee).status, "INCOMPLETE");
  const unsafe = fixture(); unsafe.rpcResult.meta.fee = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(attribute(unsafe).status, "INCOMPLETE");
});

test("bounded input with no network, secret-looking text or unsafe output reflection", () => {
  const huge = fixture(); huge.extra = "PRIVATE_ENDPOINT_MARKER".repeat(25000);
  const r = attribute(huge);
  assert.equal(r.status, "INCOMPLETE");
  assert.equal(JSON.stringify(r).includes("PRIVATE_ENDPOINT_MARKER"), false);
  neverProfit(r);
  const cyclic = fixture(); cyclic.loop = cyclic;
  assert.equal(attribute(cyclic).status, "INCOMPLETE");
});
