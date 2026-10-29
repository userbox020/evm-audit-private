#!/usr/bin/env node
const { ethers } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");
(async () => {
  const r = await resolveRpc(1);
  const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
  const USER = "0x1a557354c5b8d7df38ea914209e416dc7065b158";
  const AAVE = new ethers.Interface(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);
  const raw = await rpcCall(r, "eth_call", [{ to: POOL, data: AAVE.encodeFunctionData("getUserAccountData", [USER]) }, "latest"], 12000);
  if (!raw || raw === "0x") { console.log("FAIL"); return; }
  const d = AAVE.decodeFunctionResult("getUserAccountData", raw);
  const hf = Number(ethers.formatUnits(d[5], 18));
  const debt = Number(ethers.formatUnits(d[1], 8));
  const coll = Number(ethers.formatUnits(d[0], 8));
  console.log(JSON.stringify({
    user: USER, healthFactor: hf.toFixed(6),
    bpsToLiquidation: hf > 1 ? ((hf - 1) * 10000).toFixed(2) : "LIQUIDATABLE",
    debtUsd: Math.round(debt).toLocaleString(),
    collUsd: Math.round(coll).toLocaleString(),
    liquidatable: hf < 1,
  }, null, 2));
})();
