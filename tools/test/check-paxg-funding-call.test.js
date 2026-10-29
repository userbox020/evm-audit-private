"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("../node_modules/ethers");
const { check } = require("../check-paxg-funding-call.js");
const BLUE = new ethers.Interface([
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
]);
const TOKEN = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const params = [
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x45804880de22913dafe09f4980848ece6ecbaf78",
  "0xdd1778f71a4a1c6a0efebd8ae9f8848634ce1101",
  "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
  915000000000000000n,
];

test("wrong-chain RPC is refused before any token calls", async () => {
  const calls = [];
  const transport = async (_url, method) => { calls.push(method); return "0x2105"; };
  const r = await check(transport, async () => "in-process-test-only");
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.reason, "WRONG_CHAIN_OR_RPC_UNAVAILABLE");
  assert.deepEqual(calls, ["eth_chainId"]);
});

test("token/market reads must all resolve; no simulated collateral is accepted on partial RPC results", async () => {
  const transport = async (_url, method) => method === "eth_chainId" ? "0x1"
    : method === "eth_getBlockByNumber" ? { number: "0x1", hash: "0x" + "aa".repeat(32) }
      : null;
  const r = await check(transport, async () => "in-process-test-only");
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.reason, "PINNED_READ_UNAVAILABLE");
});

test("real funded supplyCollateral eth_call passes but never grants execution", async () => {
  let supplierCall = false;
  const transport = async (_url, method, args) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return { number: "0x11", hash: "0x" + "cc".repeat(32) };
    if (method === "eth_getBalance") return "0x" + ethers.parseEther("0.02").toString(16);
    assert.equal(method, "eth_call");
    assert.equal(args[1], "0x11");
    if (args[0].data.startsWith(BLUE.getFunction("idToMarketParams").selector)) {
      return BLUE.encodeFunctionResult("idToMarketParams", params);
    }
    if (args[0].data.startsWith(BLUE.getFunction("market").selector)) {
      return BLUE.encodeFunctionResult("market", [1000000000000n, 1n, 1000000000000n, 1n, 0n, 0n]);
    }
    if (args[0].data.startsWith(TOKEN.getFunction("balanceOf").selector)) {
      return TOKEN.encodeFunctionResult("balanceOf", [2000000000000n]);
    }
    if (args[0].data.startsWith(TOKEN.getFunction("allowance").selector)) {
      return TOKEN.encodeFunctionResult("allowance", [2000000000000n]);
    }
    if (args[0].data.startsWith(BLUE.getFunction("supplyCollateral").selector)) {
      assert.equal(args[0].from.toLowerCase(), "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a");
      supplierCall = true;
      return "0x";
    }
    throw new Error("unexpected method");
  };
  const result = await check(transport, async () => "in-process-test-only");
  assert.equal(result.status, "FUNDING_CALL_PASSED");
  assert.equal(result.marketAvailableUsdcRaw, "0");
  assert.equal(supplierCall, true);
  assert.equal(result.executable, false);
});

test("the funding checker never reads a key or sends a transaction", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(require.resolve("../check-paxg-funding-call.js"), "utf8");
  assert.doesNotMatch(source, /\.env|PRIVATE_KEY|eth_sendRawTransaction|new\s+ethers\.Wallet/u);
  assert.match(source, /executable: false/u);
});
