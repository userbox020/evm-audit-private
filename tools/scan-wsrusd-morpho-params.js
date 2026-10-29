#!/usr/bin/env node
// Resolve Morpho market params for wsrUSD->USDC market.
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

async function main() {
  const rpc = await resolveRpc(1);
  const p = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });
  const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
  const morpho = new ethers.Interface([
    "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv, uint256 ltv)",
    "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  ]);
  const id = "0x1590cb22d797e226df92ebc6e0153427e207299916e7e4e53461389ad68272fb";

  // Market params
  try {
    const raw = await p.call({ to: MORPHO, data: morpho.encodeFunctionData("idToMarketParams", [id]) });
    const d = morpho.decodeFunctionResult("idToMarketParams", raw);
    console.log("Market Params:");
    console.log("  loanToken:", d[0]);
    console.log("  collateralToken:", d[1]);
    console.log("  oracle:", d[2]);
    console.log("  irm:", d[3]);
    console.log("  lltv:", d[4]?.toString());
    console.log("  ltv:", d[5]?.toString());
  } catch (e) { console.log("idToMarketParams failed:", e.message?.slice(0,150)); }

  // Market state
  try {
    const raw = await p.call({ to: MORPHO, data: morpho.encodeFunctionData("market", [id]) });
    const d = morpho.decodeFunctionResult("market", raw);
    console.log("\nMarket State:");
    console.log("  totalSupplyAssets:", d[0]?.toString());
    console.log("  totalSupplyShares:", d[1]?.toString());
    console.log("  totalBorrowAssets:", d[2]?.toString());
    console.log("  totalBorrowShares:", d[3]?.toString());
    const supply = BigInt(d[0]?.toString() || "0");
    const borrow = BigInt(d[2]?.toString() || "0");
    console.log("  availableBorrowCash:", (supply - borrow).toString());
    console.log("  availableBorrowCashUsd:", Number(ethers.formatUnits(supply - borrow, 6)));
  } catch (e) { console.log("market failed:", e.message?.slice(0,150)); }

  // Check oracle implementation via Sourcify
  const oracleProxy = "0x938D2eDb20425cF80F008E7ec314Eb456940Da15";
  const implAddr = "0x9B4655239E91dc9E1f7599bB88FBA41B4542de5B";
  
  // Try Sourcify for the proxy and implementation
  for (const [label, addr] of [["oracle proxy", oracleProxy], ["oracle impl", implAddr]]) {
    for (const match of ["full_match", "partial_match"]) {
      try {
        const url = `https://repo.sourcify.dev/contracts/${match}/1/${addr}/metadata.json`;
        const res = await fetch(url, { headers: { "user-agent": "evm-audit/1.0" } });
        if (res.ok) {
          const meta = await res.json();
          console.log(`\n${label} Sourcify ${match}: verified`);
          console.log("  compiler:", meta?.compiler?.version);
          console.log("  contract:", meta?.settings?.compilationTarget);
        }
      } catch (_) {}
    }
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });