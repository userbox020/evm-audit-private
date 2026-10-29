"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const preflight = require("../lib/common-finalized-rpc-preflight");

const ADDRESS = "0x" + "11".repeat(20);
const ZERO = "0x" + "0".repeat(40);
const WORD = "0x" + "0".repeat(64);
const HASH = "0x" + "aa".repeat(32);
function fixture() {
  const calls = [];
  const rpc = preflight.createRpcLedger(async (handle, method, params) => {
    calls.push({ handle, method, params });
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return {
      number: "0x64", hash: HASH, parentHash: WORD, stateRoot: WORD, timestamp: "0x6553f100",
    };
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getStorageAt") return WORD;
    if (method === "eth_call") return WORD;
    if (method === "eth_getLogs") return [];
    assert.fail("unexpected method");
  });
  return { calls, options: {
    chainId: 1, rpc, preferredFamilies: 2,
    candidates: ["alchemy", "infura"].map((operatorFamily, i) => ({ handle: `fixture-${i}`, operatorFamily })),
    probe: async ({ reader }) => ({
      code: await reader.getCode(ADDRESS),
      storage: await reader.getStorageAt(ADDRESS, WORD),
      value: await reader.call({ to: ADDRESS, data: "0x" }),
    }),
  } };
}

test("invalid log-canary addresses reject before candidate access or any ledger call", async () => {
  for (const logCanaryAddress of [null, false, 1, "", "0x1", "0x" + "1".repeat(39), "0x" + "1".repeat(41),
    "0x" + "g".repeat(40), [ADDRESS], { toString: () => ADDRESS }]) {
    const f = fixture();
    await assert.rejects(preflight.qualifyCommonFinalized({ ...f.options, logCanaryAddress,
      get candidates() { assert.fail("candidate access prohibited"); },
    }), { code: "INVALID_PREFLIGHT_INPUT" });
    assert.equal(f.options.rpc.networkCalls, 0);
    assert.deepEqual(f.calls, []);
  }
});

test("an explicit full-address canary changes only the two-family log targets", async () => {
  const f = fixture();
  const result = await preflight.qualifyCommonFinalized({ ...f.options, logCanaryAddress: ADDRESS });
  assert.equal(result.selected.length, 2);
  assert.equal(result.diagnostics.stateConsensusFamilies, 2);
  const logs = f.calls.filter(row => row.method === "eth_getLogs");
  assert.equal(logs.length, 2);
  for (const row of logs) assert.deepEqual(row.params, [{ address: ADDRESS, topics: [WORD], blockHash: HASH }]);
});

test("omitted, undefined and explicit zero canaries preserve identical legacy calls and pin shape", async () => {
  const outputs = [];
  for (const options of [{}, { logCanaryAddress: undefined }, { logCanaryAddress: ZERO }]) {
    const f = fixture();
    const result = await preflight.qualifyCommonFinalized({ ...f.options, ...options });
    const logs = f.calls.filter(row => row.method === "eth_getLogs");
    assert.equal(logs.length, 2);
    assert.ok(logs.every(row => row.params[0].address === ZERO));
    assert.equal(Object.hasOwn(result.pin, "chainId"), false);
    outputs.push({ calls: f.calls, pin: result.pin, diagnostics: result.diagnostics, callsUsed: result.callsUsed });
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[0], outputs[2]);
});
