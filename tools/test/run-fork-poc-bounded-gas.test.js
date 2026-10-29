"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createScenarioContext } = require("../run-fork-poc.js");

test("local fork send accepts a bounded explicit gas limit and rejects oversized gas", async () => {
  const calls = [];
  const localRpc = { async call(method, args) {
    calls.push({ method, args });
    if (method === "anvil_impersonateAccount") return true;
    if (method === "eth_sendTransaction") return "0x" + "ab".repeat(32);
    if (method === "eth_getTransactionReceipt") return { status: "0x1", gasUsed: "0x10000" };
    throw new Error("unexpected local RPC method");
  } };
  const ctx = createScenarioContext({
    chainId: 1, block: { number: "1", hash: "0x" + "cc".repeat(32) }, localRpc,
    ethers: {},
  });
  const from = "0x" + "11".repeat(20), to = "0x" + "22".repeat(20);
  const sent = await ctx.send({ from, to, data: "0x12345678", gas: "0x493e0" });
  assert.equal(sent.receipt.status, "0x1");
  const sentCall = calls.find((x) => x.method === "eth_sendTransaction");
  assert.equal(sentCall.args[0].gas, "0x493e0");
  await assert.rejects(ctx.send({ from, to, data: "0x12345678", gas: "0xf4241" }),
    (error) => error.code === "SCENARIO_SEND_INVALID");
  assert.equal(calls.filter((x) => x.method === "eth_sendTransaction").length, 1);
});
