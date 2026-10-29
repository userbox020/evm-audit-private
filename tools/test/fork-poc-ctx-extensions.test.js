"use strict";

// Focused offline tests for the additive run-fork-poc/v1 ctx extensions:
//   ctx.setCode        (anvil_setCode etch-approximation)
//   ctx.sendAuthorization / ctx.send7702 (local type-0x4 EIP-7702 delegation)
// No network, no fork: localRpc is mocked. Nothing here reads keys from disk.

const test = require("node:test");
const assert = require("node:assert/strict");
const ethers = require("ethers");
const { createScenarioContext, ForkError } = require("../run-fork-poc.js");

const BLOCK = { number: "1", hash: `0x${"cc".repeat(32)}` };
const DELEGATE = `0x${"22".repeat(20)}`;
const DESIGNATOR = `0xef0100${"22".repeat(20)}`;

function makeCtx(localRpc, ethersValue = ethers) {
  return createScenarioContext({ chainId: 1, block: BLOCK, localRpc, ethers: ethersValue });
}

test("ctx.setCode etches exactly the supplied code and reports capability", async () => {
  const calls = [];
  const localRpc = {
    async call(method, args) {
      calls.push({ method, args });
      if (method === "anvil_setCode") return true;
      throw new Error(`unexpected local RPC method ${method}`);
    },
  };
  const ctx = makeCtx(localRpc);
  assert.equal(typeof ctx.setCode, "function");

  const address = `0x${"aa".repeat(20)}`;
  assert.equal(await ctx.setCode(address, DESIGNATOR), true);
  const etch = calls.find((entry) => entry.method === "anvil_setCode");
  assert.deepEqual(etch.args, [address, DESIGNATOR]);

  const caps = ctx.capabilities();
  assert.equal(caps.setCode, true);
  assert.equal(caps.authorizationList, "unknown");

  // Permissive about the code *shape* (empty code is allowed) but the inputs
  // themselves are still validated, and an invalid call never reaches the node.
  assert.equal(await ctx.setCode(address, "0x"), true);
  await assert.rejects(ctx.setCode(address, "0xZZ"), (error) => error.code === "SCENARIO_SETCODE_INVALID");
  await assert.rejects(ctx.setCode("0x1234", DESIGNATOR), (error) => error.code === "SCENARIO_SETCODE_INVALID");
});

test("ctx.sendAuthorization / ctx.send7702 fail closed when the node rejects type-4", async () => {
  const localRpc = {
    async call(method) {
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "anvil_setBalance") return true;
      if (method === "eth_gasPrice") return "0x3b9aca00";
      if (method === "eth_sendRawTransaction") throw new ForkError("LOCAL_RPC_METHOD_FAILED", "LOCAL_RPC_eth_sendRawTransaction");
      throw new Error(`unexpected local RPC method ${method}`);
    },
  };
  const ctx = makeCtx(localRpc);
  assert.equal(typeof ctx.sendAuthorization, "function");
  assert.equal(ctx.send7702, ctx.sendAuthorization);

  const outcome = await ctx.send7702({ delegate: DELEGATE });
  assert.equal(outcome.capability, false);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "LOCAL_RPC_METHOD_FAILED");

  const caps = ctx.capabilities();
  assert.equal(caps.authorizationList, false);
  assert.equal(caps.authorizationListReason, "LOCAL_RPC_METHOD_FAILED");

  // A second call short-circuits on the cached capability: one send attempt only.
  const again = await ctx.sendAuthorization({ delegate: DELEGATE });
  assert.equal(again.capability, false);
});

test("ctx.sendAuthorization signs a local type-0x4 auth and returns no key material", async () => {
  let raw = null;
  const localRpc = {
    async call(method, args) {
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "anvil_setBalance") return true;
      if (method === "eth_gasPrice") return "0x3b9aca00";
      if (method === "eth_sendRawTransaction") { raw = args[0]; return `0x${"ab".repeat(32)}`; }
      if (method === "eth_getTransactionReceipt") return { status: "0x1", gasUsed: "0x5208" };
      throw new Error(`unexpected local RPC method ${method}`);
    },
  };
  const ctx = makeCtx(localRpc);
  const key = `0x${"11".repeat(32)}`;
  const eoa = new ethers.Wallet(key).address;

  const outcome = await ctx.send7702({ eoa, delegate: DELEGATE, privateKeyEphemeral: key });
  assert.equal(outcome.capability, true);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.delegate, DELEGATE);
  assert.equal(outcome.account, eoa);

  const parsed = ethers.Transaction.from(raw);
  assert.equal(parsed.type, 4);
  assert.equal(parsed.authorizationList.length, 1);
  assert.equal(parsed.authorizationList[0].address.toLowerCase(), DELEGATE);

  // The ephemeral private key is never echoed in the returned evidence.
  assert.equal(JSON.stringify(outcome).includes(key), false);
  assert.equal(Object.keys(outcome).some((name) => /private|secret|key/iu.test(name)), false);
  assert.equal(ctx.capabilities().authorizationList, true);

  // A supplied eoa that the ephemeral key cannot sign for is a hard misuse.
  await assert.rejects(
    ctx.sendAuthorization({ eoa: `0x${"99".repeat(20)}`, delegate: DELEGATE, privateKeyEphemeral: key }),
    (error) => error.code === "SCENARIO_AUTH_KEY_MISMATCH",
  );
});

test("ctx evidence never contains the ephemeral key or any endpoint URL", async () => {
  const localRpc = {
    async call(method) {
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "anvil_setBalance") return true;
      if (method === "eth_gasPrice") return "0x3b9aca00";
      if (method === "eth_sendRawTransaction") return `0x${"ab".repeat(32)}`;
      if (method === "eth_getTransactionReceipt") return { status: "0x1", gasUsed: "0x5208" };
      throw new Error(`unexpected local RPC method ${method}`);
    },
  };
  const ctx = makeCtx(localRpc);
  const key = `0x${"11".repeat(32)}`;
  const eoa = new ethers.Wallet(key).address;

  const outcome = await ctx.send7702({ eoa, delegate: DELEGATE, privateKeyEphemeral: key });
  ctx.log("auth", { capability: outcome.capability, applied: outcome.applied });
  ctx.log("capabilities", ctx.capabilities());

  const evidence = JSON.stringify({ observations: ctx._state.observations, outcome, ctxKeys: Object.keys(ctx) });
  assert.equal(evidence.includes(key), false);
  assert.equal(/(?:https?|wss?):\/\//iu.test(evidence), false);
  assert.equal(evidence.includes("127.0.0.1"), false);
});
