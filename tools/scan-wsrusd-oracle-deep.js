#!/usr/bin/env node
// Detailed bytecode analysis of the wsrUSD oracle implementation.

const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

async function main() {
  const rpc = await resolveRpc(1);
  if (!rpc) { console.log("RPC unavailable"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });

  const implAddr = "0x9B4655239E91dc9E1f7599bB88FBA41B4542de5B";
  const code = await provider.getCode(implAddr);
  const hex = code.slice(2).toLowerCase();
  
  // Extended selector set
  const extendedSelectors = {
    "convertToAssets(uint256)": "07a2d13a",
    "totalAssets()": "23452b30",
    "price()": "c688d24e",
    "totalSupply()": "18160ddd",
    "balanceOf(address)": "70a08231",
    "latestRoundData()": "feaf968c",
    "decimals()": "313ce567",
    "getPrice()": "5ac0a728",
    "getRate()": "3a4b45e0",
    "consult(uint256)": "bef392d4",
    "convertToShares(uint256)": "aa5727fa",
    "asset()": "38e62424",
    "maxDeposit(address)": "2d98a7b0",
    "maxRedeem(address)": "ce5cb0f6",
    "getUnderlyingAmount()": "9b97d1f3",
    "1e18()": "8e3e2ad6",
    "getPriceUsd()": "4c9EDD58",
    "scaledPrice()": "1230cbb7",
    "rate()": "f205655e",
    "getValue()": "3e58ee0b",
    "oracle()": "38d9a40b",
    "feed()": "56b8c5be",
    "priceFeed()": "81c0c3c8",
    "scale()": "5c0958f5",
    "price oracle()": "f45d3d4e",
    "getLatestPrice()": "28bd3e10",
    "getPrice(uint256)": "8e7663a0",
    "sample(uint256)": "7e8b7e87",
    "priceOf(address)": "1ab0b944",
    "valueOf(address,uint256)": "8f1ee8a0",
    "ASSET()": "2bc26f68",
    "get(address)": "1f8de530",
    "latestAnswer()": "76b4f6d9",
    "latestTimestamp()": "66ba0c80",
    "getRoundData(uint80)": "fe8211cc",
    "updatedAt()": "d2c95ca7",
    "getPriceFeed()": "1b19e8e9",
    "base()": "4cee73ab",
    "getRateSafe()": "f82e1d8b",
  };
  
  console.log("wsrUSD oracle implementation bytecode analysis:");
  console.log("Address:", implAddr);
  console.log("Code size:", hex.length / 2, "bytes");
  console.log("");
  
  const found = [];
  for (const [name, selector] of Object.entries(extendedSelectors)) {
    const count = (hex.match(new RegExp(selector, "g")) || []).length;
    if (count > 0) found.push({ selector, name, count });
  }
  
  if (found.length > 0) {
    console.log("Found selectors:");
    found.forEach(f => console.log(`  ${f.selector} ${f.name}: ${f.count} hits`));
  } else {
    console.log("No standard selectors found in bytecode.");
    console.log("This may use a non-standard price oracle pattern.");
  }
  
  // Try to call the oracle with different calldata patterns
  console.log("\nTrying direct calls to the minimal proxy (oracle address):");
  const oracleAddr = "0x938D2eDb20425cF80F008E7ec314Eb456940Da15";
  
  // Try calling with the marketId as calldata (Morpho oracle pattern)
  const marketId = "0x1590cb22d797e226df92ebc6e0153427e207299916e7e4e53461389ad68272fb";
  console.log("  Trying with marketId params...");
  
  // Try the oracle with no args
  for (const [sig, sel] of Object.entries({"price()":"c688d24e","getPrice()":"5ac0a728","getRate()":"3a4b45e0","rate()":"f205655e","getValue()":"3e58ee0b","latestAnswer()":"76b4f6d9","assetPrice()":"13332e8e","getLatestPrice()":"28bd3e10"})) {
    try {
      const raw = await provider.call({ to: oracleAddr, data: "0x" + sel });
      if (raw && raw !== "0x" && raw.length >= 10) {
        console.log(`  ${sig} -> ${raw.slice(0,66)}`);
        try { const val = BigInt(raw.slice(0,66)); console.log(`    value: ${val.toString()}`); } catch(_) {}
      }
    } catch (e) {
      // Try with the collateral address as param
      try {
        const collateral = "0xd3fD63209FA2D55B07A0f6db36C2f43900be3094";
        const calldata = "0x" + sel + collateral.slice(2).padStart(64, "0");
        const raw2 = await provider.call({ to: oracleAddr, data: calldata });
        if (raw2 && raw2 !== "0x" && raw2.length >= 10) {
          console.log(`  ${sig}(collateral) -> ${raw2.slice(0,66)}`);
        }
      } catch (_) {}
    }
  }
  
  // Try Morpho-specific oracle interface: price(bytes32 id, address collateral, address loan)
  // This is the Morpho Blue oracle interface
  try {
    const morphoOracleSel = "0x1aa436d8"; // price(bytes32,address,address) approximate
    const calldata = morphoOracleSel + marketId.slice(2) + "0xd3fD63209FA2D55B07A0f6db36C2f43900be3094".slice(2).padStart(64,"0") + "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".slice(2).padStart(64,"0");
    const raw = await provider.call({ to: oracleAddr, data: calldata });
    console.log("  Morpho price(bytes32,address,address) -> ", raw?.slice(0,66));
  } catch(_) {}
  
  // Also try the implementation directly with same patterns
  console.log("\nTrying direct calls to implementation:");
  for (const [sig, sel] of Object.entries({"price()":"c688d24e","getPrice()":"5ac0a728","getRate()":"3a4b45e0","rate()":"f205655e","latestAnswer()":"76b4f6d9"})) {
    try {
      const raw = await provider.call({ to: implAddr, data: "0x" + sel });
      if (raw && raw !== "0x" && raw.length >= 10) {
        console.log(`  ${sig} -> ${raw.slice(0,66)}`);
      }
    } catch (e) {}
  }
  
  // Try calling Morpho's idToMarketParams to get the actual oracle
  const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
  const morphoIface = new ethers.Interface([
    "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv, uint256 ltv)",
    "function market(bytes32) view returns (uint128, uint128, uint128, uint128, uint128, uint128)",
  ]);
  try {
    const raw = await provider.call({ to: MORPHO, data: morphoIface.encodeFunctionData("idToMarketParams", [marketId]) });
    const decoded = morphoIface.decodeFunctionResult("idToMarketParams", raw);
    console.log("\nMorpho idToMarketParams for wsrUSD->USDC:");
    console.log("  loanToken:", decoded[0]);
    console.log("  collateralToken:", decoded[1]);
    console.log("  oracle:", decoded[2]);
    console.log("  irm:", decoded[3]);
    console.log("  lltv:", decoded[4]?.toString());
    console.log("  ltv:", decoded[5]?.toString());
  } catch(e) { console.log("  Morpho call failed:", e.message?.slice(0,100)); }
  
  // Market state
  try {
    const raw = await provider.call({ to: MORPHO, data: morphoIface.encodeFunctionData("market", [marketId]) });
    const decoded = morphoIface.decodeFunctionResult("market", raw);
    console.log("\nMorpho market state for wsrUSD->USDC:");
    console.log("  totalSupplyAssets:", decoded[0]?.toString());
    console.log("  totalSupplyShares:", decoded[1]?.toString());
    console.log("  totalBorrowAssets:", decoded[2]?.toString());
    console.log("  totalBorrowShares:", decoded[3]?.toString());
    
    const supply = BigInt(decoded[0]?.toString() || "0");
    const borrow = BigInt(decoded[2]?.toString() || "0");
    const available = supply - borrow;
    console.log("  availableBorrowCash:", available.toString());
    console.log("  availableBorrowCashUsd:", Number(ethers.formatUnits(available, 6)));
  } catch(e) { console.log("  market call failed:", e.message?.slice(0,100)); }
}

main().then(() => process.exit(0)).catch(err => { console.error(err.stack || err.message); process.exit(1); });