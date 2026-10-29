"use strict";

// Unsigned, static v3 action construction. It neither approves a batch nor
// dispatches; the canonical Ed25519-approved v3 batch remains mandatory.
const { ethers } = require("../node_modules/ethers");
const MARKET = "0x8eaf7b29f02ba8d8c1d7aeb587403dcb16e2e943e4e2f5f94b0963c2386406c9";
const BOT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const PAXG = "0x45804880de22913dafe09f4980848ece6ecbaf78";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ORACLE = "0xdd1778f71a4a1c6a0efebd8ae9f8848634ce1101";
const IF = new ethers.Interface([
  "function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
  "function borrow((address,address,address,address,uint256),uint256,uint256,address,address)",
]);

function buildActions(params) {
  if (!Array.isArray(params) || params.length !== 5 ||
      String(params[0]).toLowerCase() !== USDC || String(params[1]).toLowerCase() !== PAXG ||
      String(params[2]).toLowerCase() !== ORACLE ||
      ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "uint256"], params,
      )).toLowerCase() !== MARKET) throw new Error("MARKET_PARAMS_MISMATCH");
  const action = (data, gasLimit) => ({
    from: BOT, to: MORPHO, valueWei: "0", data, gasLimit, slippageBps: "0",
  });
  return [
    action(IF.encodeFunctionData("supplyCollateral", [params, 1_000_000_000_000n, BOT, "0x"]), "180000"),
    action(IF.encodeFunctionData("borrow", [params, 100_000_000n, 0n, BOT, BOT]), "300000"),
  ];
}

module.exports = { MARKET, BOT, MORPHO, IF, buildActions };
