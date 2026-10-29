#!/usr/bin/env node
"use strict";

// Keyless, LOCAL-fork-only rehearsal of the bot wallet's real PAXG funding leg.
// Synthetic supplier liquidity is explicitly hypothetical when the live market
// is empty. This is evidence about mechanics, never authorization to broadcast.
const path = require("node:path");
const fork = require("./run-fork-poc.js");
const { resolveRpc, rpcCall } = require("./shared-rpc.js");

const BOT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const PAXG = "0x45804880de22913dafe09f4980848ece6ecbaf78";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MARKET = "0x8eaf7b29f02ba8d8c1d7aeb587403dcb16e2e943e4e2f5f94b0963c2386406c9";
// Public W9 holder discovery, for an EXOGENOUS supplier action in the local fork.
const SUPPLIER = "0x15abb66bA754F05cBC0165A64A11cDed1543dE48";
const COLLATERAL_WEI = 1_000_000_000_000n; // 0.000001 PAXG from the wallet's EXISTING balance
const BORROW_USDC_RAW = 100_000_000n;
const SYNTHETIC_SUPPLY_USDC_RAW = 101_000_000n;
const MORPHO_IF = [
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  "function supply((address,address,address,address,uint256),uint256,uint256,address,bytes) returns (uint256,uint256)",
  "function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
  "function borrow((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
];
const ERC20_IF = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
async function run(ctx) {
  const { ethers } = ctx;
  const morpho = new ethers.Interface(MORPHO_IF);
  const token = new ethers.Interface(ERC20_IF);
  const read = async (contract, iface, fn, args = []) => iface.decodeFunctionResult(
    fn, await ctx.call({ to: contract, data: iface.encodeFunctionData(fn, args) }),
  );

  const p = await read(MORPHO, morpho, "idToMarketParams", [MARKET]);
  const params = [p[0], p[1], p[2], p[3], p[4]];
  ctx.assert(params[0].toLowerCase() === USDC.toLowerCase() && params[1].toLowerCase() === PAXG.toLowerCase(), "market-assets-match");
  ctx.assert(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address", "uint256"], params)).toLowerCase() === MARKET, "market-id-bound");
  ctx.assert(ctx.blockHash.toLowerCase() === String(ctx.input.blockHash).toLowerCase(), "native-balance-pin-bound");
  // Seed ONLY the native balance, to its exact public value at this same pin,
  // before token reads make Anvil query eth_getAccountInfo (denied by the relay).
  await ctx.setBalance(BOT, `0x${BigInt(ctx.input.nativeBalanceWei).toString(16)}`);
  ctx.log("walletNativeBalanceAtPinWei", String(ctx.input.nativeBalanceWei));

  let walletColl, allowance, market;
  try { walletColl = await read(PAXG, token, "balanceOf", [BOT]); }
  catch (_) { ctx.assert(false, "fork-wallet-paxg-read-unsupported"); return; }
  try { allowance = await read(PAXG, token, "allowance", [BOT, MORPHO]); }
  catch (_) { ctx.assert(false, "fork-wallet-allowance-read-unsupported"); return; }
  try { market = await read(MORPHO, morpho, "market", [MARKET]); }
  catch (_) { ctx.assert(false, "fork-market-read-unsupported"); return; }
  const liveAvailable = market[0] > market[2] ? market[0] - market[2] : 0n;
  ctx.log("liveAvailableUsdcRaw", liveAvailable.toString());
  ctx.log("walletPaxgRaw", walletColl[0].toString());
  ctx.log("walletPaxgAllowanceRaw", allowance[0].toString());
  ctx.assert(walletColl[0] >= COLLATERAL_WEI, "wallet-owns-real-collateral");
  ctx.assert(allowance[0] >= COLLATERAL_WEI, "wallet-has-real-morpho-allowance");
  ctx.assert(BigInt(ctx.input.nativeBalanceWei) > ethers.parseEther("0.001"), "wallet-has-native-gas-at-pin");
  if (ctx._state.asserts.some((a) => !a.pass)) return;

  // Model future supply by impersonating a known real USDC holder. Only its GAS
  // is fork-funded; neither party receives fake ERC20 balances or allowances.
  if (liveAvailable < BORROW_USDC_RAW) {
    ctx.log("syntheticSupplierLiquidity", true);
    ctx.log("liveExecutionEligible", false);
    await ctx.setBalance(SUPPLIER, "0xDE0B6B3A7640000"); // local gas only
    let supplierBal;
    try { supplierBal = await read(USDC, token, "balanceOf", [SUPPLIER]); }
    catch (_) { ctx.assert(false, "fork-real-supplier-usdc-read-unsupported"); return; }
    ctx.assert(supplierBal[0] >= SYNTHETIC_SUPPLY_USDC_RAW, "hypothetical-supplier-balance");
    if (supplierBal[0] < SYNTHETIC_SUPPLY_USDC_RAW) return;
    ctx.log("hypotheticalSupplierFromRealHolder", true);
    await ctx.send({ from: SUPPLIER, to: USDC, data: token.encodeFunctionData("approve", [MORPHO, SYNTHETIC_SUPPLY_USDC_RAW]) });
    await ctx.send({ from: SUPPLIER, to: MORPHO, data: morpho.encodeFunctionData("supply", [params, SYNTHETIC_SUPPLY_USDC_RAW, 0, SUPPLIER, "0x"]) });
  } else {
    ctx.log("syntheticSupplierLiquidity", false);
    ctx.log("liveExecutionEligible", false); // Profit and signed authority are separately checked.
  }

  const afterFunding = await read(MORPHO, morpho, "market", [MARKET]);
  ctx.assert(afterFunding[0] - afterFunding[2] >= BORROW_USDC_RAW, "fork-has-borrowable-usdc");
  const before = await read(USDC, token, "balanceOf", [BOT]);
  const collateralReceipt = await ctx.send({ from: BOT, to: MORPHO, data: morpho.encodeFunctionData("supplyCollateral", [params, COLLATERAL_WEI, BOT, "0x"]) });
  const positionAfterSupply = await read(MORPHO, morpho, "position", [MARKET, BOT]);
  ctx.assert(positionAfterSupply[2] >= COLLATERAL_WEI, "wallet-collateral-recorded");
  const borrowReceipt = await ctx.send({ from: BOT, to: MORPHO, data: morpho.encodeFunctionData("borrow", [params, BORROW_USDC_RAW, 0, BOT, BOT]), gas: "0x493e0" }); // 300k, local fork only
  const after = await read(USDC, token, "balanceOf", [BOT]);
  const position = await read(MORPHO, morpho, "position", [MARKET, BOT]);
  ctx.assert(after[0] - before[0] === BORROW_USDC_RAW, "wallet-receives-exact-usdc");
  ctx.assert(position[1] > 0n, "wallet-borrow-debt-recorded");
  ctx.log("collateralGasUsed", BigInt(collateralReceipt.receipt.gasUsed).toString());
  ctx.log("borrowGasUsed", BigInt(borrowReceipt.receipt.gasUsed).toString());
  ctx.log("borrowedUsdcRaw", (after[0] - before[0]).toString());
  ctx.log("proofScope", "FORK_MECHANICS_ONLY; synthetic supplier when live liquidity is absent; no signed authority or positive-net claim");
}

async function main() {
  const rpc = await resolveRpc(1, null, { capability: "read", timeoutMs: 12000 });
  if (!rpc) throw new Error("qualified-read-rpc-unavailable");
  const header = await rpcCall(rpc, "eth_getBlockByNumber", ["finalized", false], 15000);
  if (!header || !header.hash || !header.number) throw new Error("finalized-block-unavailable");
  const balance = await rpcCall(rpc, "eth_getBalance", [BOT, header.number], 15000);
  if (!balance || !/^0x[0-9a-f]+$/iu.test(balance)) throw new Error("pinned-native-balance-unavailable");
  const supplierCode = await rpcCall(rpc, "eth_getCode", [SUPPLIER, header.number], 15000);
  if (supplierCode !== "0x") throw new Error("hypothetical-supplier-not-a-verified-eoa");
  const outPath = path.join(__dirname, "..", "reports", "raw", "fast", "exploit-rearm-canary", "paxg-route-real-local.json");
  const result = await fork.runForkPoc(
    { chain: "1", block: BigInt(header.number).toString(), scenario: __filename, scenarioName: "paxg-route-real-local", run: true, outPath,
      scenarioInput: { blockHash: header.hash, nativeBalanceWei: BigInt(balance).toString() } },
  );
  console.log(JSON.stringify({ status: result.status, blocker: result.blocker, outPath: path.relative(process.cwd(), outPath) }));
  if (result.status !== "PASS") process.exitCode = 1;
}

module.exports = { run };
if (require.main === module) main().catch(() => { console.error("FAIL local-fork-preflight"); process.exitCode = 1; });
