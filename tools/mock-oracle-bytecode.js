const ethers = require("C:/_Work/__EVM_AUDIT/tools/node_modules/ethers");

// Build minimal mock contract bytecode that returns controlled values
// These are runtime bytecode snippets that get deployed via anvil_setCode

// Mock that returns a fixed uint256 value (for oracle.price() style calls)
function buildMockReturnValue(valueWei) {
  const valueHex = ethers.toBeHex(BigInt(valueWei), 32).slice(2); // 64 hex chars
  // Minimal EVM: PUSH32 value → PUSH1 0 → MSTORE → PUSH1 32 → PUSH1 0 → RETURN
  return "0x" +
    "7f" + valueHex +  // PUSH32 <value>
    "6000" +           // PUSH1 0
    "52" +             // MSTORE
    "6020" +           // PUSH1 32
    "6000" +           // PUSH1 0
    "f3";              // RETURN
}

// Mock Chainlink AggregatorV3 — returns latestRoundData with stale price
function buildMockChainlinkFeed(inflatedPrice8, staleTimestamp) {
  // inflatedPrice8: price in 8 decimals (e.g., 260000000000 for $2600)
  // staleTimestamp: unix timestamp for "updatedAt" (e.g., 2h ago)
  const priceHex = ethers.toBeHex(BigInt(inflatedPrice8), 32).slice(2);
  const tsHex = ethers.toBeHex(BigInt(staleTimestamp), 32).slice(2);
  // ABI-encoded: (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  // 5 fields = 5x32 = 160 bytes
  // roundId=1, answer=price, startedAt=0, updatedAt=timestamp, answeredInRound=1
  const roundId = "0000000000000000000000000000000000000000000000000000000000000001";
  const answer = priceHex;
  const startedAt = "0000000000000000000000000000000000000000000000000000000000000000";
  const updatedAt = tsHex;
  const answeredInRound = "0000000000000000000000000000000000000000000000000000000000000001";
  const returnData = roundId + answer + startedAt + updatedAt + answeredInRound;
  
  return "0x" +
    // Store the return data in memory at offset 0x20 (skip first 32 for length)
    "7f" + returnData.slice(0,64) + "6020" + "52" +
    "7f" + returnData.slice(64,128) + "6040" + "52" +
    "7f" + returnData.slice(128,192) + "6060" + "52" +
    "7f" + returnData.slice(192,256) + "6080" + "52" +
    "7f" + returnData.slice(256,320) + "60a0" + "52" +
    // Return 160 bytes starting at memory offset 0x20
    "60a0" + "6020" + "f3";
}

// Mock Fluid oracle — returns fixed exchange rate ($1.00 for operate mode)
function buildMockFluidOracle(overvaluedRate) {
  // Fluid oracle has getExchangeRateOperate() which returns (uint256 exchangePrice_, uint256 liquidationPrice_)
  const rateHex = ethers.toBeHex(BigInt(overvaluedRate), 32).slice(2);
  const returnData = rateHex + rateHex; // Same for exchange and liquidation
  return "0x" +
    "7f" + returnData.slice(0,64) + "6020" + "52" +
    "7f" + returnData.slice(64,128) + "6040" + "52" +
    "6040" + "6020" + "f3";
}

console.log("Mock contract bytecode builders loaded.");
console.log("Types:");
console.log("  buildMockReturnValue(valueWei) — returns single uint256");
console.log("  buildMockChainlinkFeed(price8, ts) — returns Chainlink latestRoundData");
console.log("  buildMockFluidOracle(rate) — returns (exchangePrice, liquidationPrice)");

// Export
module.exports = { buildMockReturnValue, buildMockChainlinkFeed, buildMockFluidOracle };
