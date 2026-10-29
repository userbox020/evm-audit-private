"use strict";

// An additional fixed-action check AFTER the canonical module validates the
// Ed25519 v3 approval. This module does not load signers or call a dispatcher.
const { ethers } = require("../node_modules/ethers");
const { BOT, MORPHO, buildActions } = require("./paxg-exact-actions.js");

const PARAMS = [
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x45804880de22913dafe09f4980848ece6ecbaf78",
  "0xdd1778f71a4a1c6a0efebd8ae9f8848634ce1101",
  "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
  915000000000000000n,
];
const EXPECTED = buildActions(PARAMS);

function matchPaxgBatch(state) {
  if (!state || state.state !== "VALID" || !state.approval?.scopeCommitment ||
      !/^0x[0-9a-f]{64}$/u.test(state.batchCommitment || "")) return "SIGNED_V3_BATCH_ABSENT";
  const batch = state.batch;
  if (batch?.schema !== "live-execution-batch/v3" || batch.mode !== "PRODUCTION" ||
      batch.chainId !== "1" || batch.accountRef !== BOT ||
      !/^0x[0-9a-f]{64}$/u.test(batch.testnetAttestation || "")) return "SIGNED_PAXG_SCOPE_MISMATCH";
  if (!Array.isArray(batch.actions) || batch.actions.length !== 2 ||
      batch.gasCeiling !== "480000") return "SIGNED_PAXG_ACTIONS_MISMATCH";
  const fields = ["from", "to", "valueWei", "data", "gasLimit", "slippageBps"];
  for (let i = 0; i < 2; i++) {
    if (fields.some((field) => batch.actions[i]?.[field] !== EXPECTED[i][field])) return "SIGNED_PAXG_ACTIONS_MISMATCH";
  }
  const fee = batch.feeCap;
  if (!fee || !/^(0|[1-9][0-9]*)$/u.test(fee.maxFeePerGasWei || "") ||
      !/^(0|[1-9][0-9]*)$/u.test(fee.maxPriorityFeePerGasWei || "") ||
      BigInt(fee.maxFeePerGasWei) === 0n ||
      BigInt(fee.maxPriorityFeePerGasWei) > BigInt(fee.maxFeePerGasWei) ||
      BigInt(fee.maxFeePerGasWei) > ethers.parseUnits("5", "gwei")) return "SIGNED_PAXG_FEE_CAP_INVALID";
  return null;
}

module.exports = { matchPaxgBatch, PARAMS };
