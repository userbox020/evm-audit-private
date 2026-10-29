#!/usr/bin/env node
"use strict";

// Read-only, pinned eth_call of the bot's REAL ERC20-funded collateral leg.
// No key, wallet signer, transaction sending, or artifact containing an RPC.
const { ethers } = require("./node_modules/ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc.js");

const BOT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const PAXG = "0x45804880de22913dafe09f4980848ece6ecbaf78";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MARKET = "0x8eaf7b29f02ba8d8c1d7aeb587403dcb16e2e943e4e2f5f94b0963c2386406c9";
const COLLATERAL_WEI = 1_000_000_000_000n;
const TOKEN = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const BLUE = new ethers.Interface([
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
]);

async function check(transport = rpcCall, resolve = resolveRpc) {
  const url = await resolve(1, null, { capability: "read", timeoutMs: 12000 });
  if (!url) return { status: "BLOCKED", reason: "RPC_UNAVAILABLE" };
  const cid = await transport(url, "eth_chainId", [], 15000);
  if (cid !== "0x1") return { status: "BLOCKED", reason: "WRONG_CHAIN_OR_RPC_UNAVAILABLE" };
  const head = await transport(url, "eth_getBlockByNumber", ["latest", false], 15000);
  if (!head || !/^0x[0-9a-f]{64}$/iu.test(head.hash || "") || !/^0x[0-9a-f]+$/iu.test(head.number || "")) {
    return { status: "BLOCKED", reason: "BLOCK_PIN_UNAVAILABLE" };
  }
  const pin = head.number;
  const call = (to, data, from = BOT) => transport(url, "eth_call", [{ from, to, data }, pin], 15000);
  const [rawParams, rawMarket, rawBalance, rawAllowance, native] = await Promise.all([
    call(MORPHO, BLUE.encodeFunctionData("idToMarketParams", [MARKET])),
    call(MORPHO, BLUE.encodeFunctionData("market", [MARKET])),
    call(PAXG, TOKEN.encodeFunctionData("balanceOf", [BOT])),
    call(PAXG, TOKEN.encodeFunctionData("allowance", [BOT, MORPHO])),
    transport(url, "eth_getBalance", [BOT, pin], 15000),
  ]);
  if ([rawParams, rawMarket, rawBalance, rawAllowance, native].some((x) => x == null)) {
    return { status: "BLOCKED", reason: "PINNED_READ_UNAVAILABLE", block: Number(BigInt(pin)) };
  }
  let params, state, balance, allowance;
  try {
    params = BLUE.decodeFunctionResult("idToMarketParams", rawParams);
    state = BLUE.decodeFunctionResult("market", rawMarket);
    balance = TOKEN.decodeFunctionResult("balanceOf", rawBalance)[0];
    allowance = TOKEN.decodeFunctionResult("allowance", rawAllowance)[0];
  } catch (_) { return { status: "BLOCKED", reason: "PINNED_DECODE_FAILED", block: Number(BigInt(pin)) }; }
  const p = [params[0], params[1], params[2], params[3], params[4]];
  const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address", "uint256"], p));
  if (id.toLowerCase() !== MARKET || String(p[0]).toLowerCase() !== USDC.toLowerCase() ||
      String(p[1]).toLowerCase() !== PAXG.toLowerCase()) {
    return { status: "BLOCKED", reason: "MARKET_BINDING_MISMATCH", block: Number(BigInt(pin)) };
  }
  const available = state[0] > state[2] ? state[0] - state[2] : 0n;
  const funded = balance >= COLLATERAL_WEI && allowance >= COLLATERAL_WEI && BigInt(native) > ethers.parseEther("0.001");
  const simulated = funded ? await call(MORPHO, BLUE.encodeFunctionData("supplyCollateral", [p, COLLATERAL_WEI, BOT, "0x"])) : null;
  return {
    status: funded && simulated != null ? "FUNDING_CALL_PASSED" : "BLOCKED",
    reason: !funded ? "WALLET_BALANCE_ALLOWANCE_OR_GAS_INSUFFICIENT" : simulated == null ? "REAL_SUPPLY_COLLATERAL_CALL_REVERTED_OR_RPC_UNAVAILABLE" : "REAL_FUNDING_LEG_SIMULATED_ONLY",
    block: Number(BigInt(pin)), blockHash: head.hash,
    walletPaxgWei: balance.toString(), allowanceWei: allowance.toString(), nativeEthWei: BigInt(native).toString(),
    marketAvailableUsdcRaw: available.toString(), collateralWei: COLLATERAL_WEI.toString(),
    noSigning: true, noBroadcast: true, executable: false,
  };
}

if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== "--check") {
    console.error("usage: node tools/check-paxg-funding-call.js --check");
    process.exitCode = 1;
  } else {
    check().then((result) => {
      console.log(JSON.stringify(result));
      if (result.status !== "FUNDING_CALL_PASSED") process.exitCode = 1;
    }).catch(() => { console.error("FAIL read-only-funding-check"); process.exitCode = 1; });
  }
}

module.exports = { check };
