"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildActions, MARKET, BOT, MORPHO, IF } = require("../lib/paxg-exact-actions.js");
const { matchPaxgBatch } = require("../lib/paxg-batch-match.js");
const params = [
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x45804880de22913dafe09f4980848ece6ecbaf78",
  "0xdd1778f71a4a1c6a0efebd8ae9f8848634ce1101",
  "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
  915000000000000000n,
];

test("unsigned v3 actions bind the exact Morpho market and fixed collateral/borrow amounts", () => {
  const actions = buildActions(params);
  assert.equal(actions.length, 2);
  assert.ok(actions.every((a) => a.from === BOT && a.to === MORPHO && a.valueWei === "0"));
  const supply = IF.decodeFunctionData("supplyCollateral", actions[0].data);
  const borrow = IF.decodeFunctionData("borrow", actions[1].data);
  assert.equal(supply[1], 1_000_000_000_000n);
  assert.equal(borrow[1], 100_000_000n);
  assert.equal(borrow[3].toLowerCase(), BOT);
  assert.equal(MARKET.length, 66);
});

test("oracle/IRM/LLTV substitution is rejected before a draft is written", () => {
  assert.throws(() => buildActions([params[0], params[1], params[2], "0x" + "11".repeat(20), params[4]]), /MARKET_PARAMS_MISMATCH/u);
  assert.throws(() => buildActions([params[0], params[1], params[2], params[3], 1n]), /MARKET_PARAMS_MISMATCH/u);
});

test("the fixed action match refuses unsigned, extra-action, wrong-chain, and altered-call batches", () => {
  assert.equal(matchPaxgBatch({ state: "ABSENT" }), "SIGNED_V3_BATCH_ABSENT");
  const batch = {
    schema: "live-execution-batch/v3", mode: "PRODUCTION", chainId: "1", accountRef: BOT,
    testnetAttestation: "0x" + "aa".repeat(32),
    actions: buildActions(params), gasCeiling: "480000",
    feeCap: { maxFeePerGasWei: "5000000000", maxPriorityFeePerGasWei: "2000000000" },
  };
  const approved = { state: "VALID", approval: { scopeCommitment: "0x" + "ab".repeat(32) },
    batchCommitment: "0x" + "bb".repeat(32), batch };
  assert.equal(matchPaxgBatch(approved), null);
  assert.equal(matchPaxgBatch({ ...approved, batch: { ...batch, chainId: "8453" } }), "SIGNED_PAXG_SCOPE_MISMATCH");
  assert.equal(matchPaxgBatch({ ...approved, batch: { ...batch, actions: [...batch.actions, batch.actions[0]] } }), "SIGNED_PAXG_ACTIONS_MISMATCH");
  const modified = [{ ...batch.actions[0], data: "0x12345678" }, batch.actions[1]];
  assert.equal(matchPaxgBatch({ ...approved, batch: { ...batch, actions: modified } }), "SIGNED_PAXG_ACTIONS_MISMATCH");
  assert.equal(matchPaxgBatch({ ...approved, batch: { ...batch, feeCap: { ...batch.feeCap, maxFeePerGasWei: "20000000000" } } }), "SIGNED_PAXG_FEE_CAP_INVALID");
});
