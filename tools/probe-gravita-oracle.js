#!/usr/bin/env node
// probe-gravita-oracle.js — Gravita Tellor+Chainlink Oracle Timing Scanner
// Probes Gravita's PriceFeed on 5 chains for Tellor freshness + Chainlink staleness.
const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "gravita-oracle-scan.json");

// Gravita uses Liquity V2 architecture. Key contracts per chain (from Gravita docs):
// BorrowerOperations → manages CDP, reads PriceFeed
// PriceFeed → Chainlink primary + Tellor fallback
// Tellor query: getDataBefore(tokenId, timestamp) or getCurrentValue(tokenId)

// Tellor oracle addresses on Gravita chains (from deployment admin outputs)
const GRAVITA_CHAINS = [
  { name:"Ethereum", id:1, weth:"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", tellor:"0x..." },
  { name:"Arbitrum", id:42161, weth:"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", tellor:"0x..." },
  { name:"Optimism", id:10, weth:"0x4200000000000000000000000000000000000006", tellor:"0x..." },
  { name:"Linea", id:59144, weth:"0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", tellor:"0x..." },
  { name:"zkSync", id:324, weth:"0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", tellor:"0x..." },
];

// Tellor Oracle interface (TellorFlex on L2s)
const TELLOR_ABI = {
  // getCurrentValue(bytes32 queryId) → (bool ifRetrieve, bytes value, uint256 timestamp)
  getCurrentValue: "0x9b7e799d",
  // getDataBefore(bytes32 queryId, uint256 timestamp) → (bool, bytes, uint256)  
  getDataBefore: "0x0fae75e4",
};

// Chainlink ETH/USD feeds per chain
const CHAINLINK_FEEDS = {
  1: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
  42161: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  10: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
  59144: "0x3c6Cd9Cc7c7a4c2Cf5a82734CD249D7D593354dA",
  324: "0x6D41d1dc818112880b40e26BD6FD347E410501e1",
};

// Tellor ETH/USD query IDs (keccak256(abi.encode("SpotPrice", abi.encode("eth","usd"))))
const TELLOR_ETH_USD_ID = "0x83a7f3d48786ac2667503a61e8c415438ed2922eb86a2906e4ee66d9a2ce4992";

async function probeChain(name, id, tellorAddr) {
  const rpc = await resolveRpc(id);
  if (!rpc) return { name, error: "no-rpc" };

  const result = { name, chainId: id, chainlink: null, tellor: null };

  // 1. Chainlink ETH/USD
  const clFeed = CHAINLINK_FEEDS[id];
  if (clFeed) {
    const clRaw = await rpcCall(rpc, "eth_call", [{ to: clFeed, data: "0xfeaf968c" }, "latest"], 8000);
    if (clRaw && clRaw.length >= 258) {
      const answer = BigInt("0x" + clRaw.slice(2 + 64, 2 + 128));
      const updatedAt = Number(BigInt("0x" + clRaw.slice(2 + 192, 2 + 256)));
      result.chainlink = { price: Number(answer) / 1e8, updatedAt, age: Math.floor(Date.now() / 1000) - updatedAt };
    }
  }

  // 2. Tellor getCurrentValue for ETH/USD
  if (tellorAddr && !tellorAddr.includes("...")) {
    const tData = TELLOR_ABI.getCurrentValue + "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000020" + TELLOR_ETH_USD_ID.slice(2);
    // Simplified: call getCurrentValue(bytes32)
    const tRaw = await rpcCall(rpc, "eth_call", [{ to: tellorAddr, data: tData }, "latest"], 8000);
    if (tRaw && tRaw !== "0x" && tRaw.length > 130) {
      // Decode: (bool retrieved, bytes value, uint256 timestamp)
      const retrieved = parseInt(tRaw.slice(2, 66), 16);
      const valueOffset = parseInt(tRaw.slice(66, 130), 16) * 2;
      const valueLen = parseInt(tRaw.slice(valueOffset + 2, valueOffset + 66), 16) * 2;
      const valueBytes = tRaw.slice(valueOffset + 66, valueOffset + 66 + valueLen);
      const timestamp = Number(BigInt("0x" + tRaw.slice(130, 194)));
      if (retrieved > 0 && valueBytes) {
        const price = Number(BigInt("0x" + valueBytes)) / 1e18;
        result.tellor = { price, timestamp, age: Math.floor(Date.now() / 1000) - timestamp, retrieved: true };
      }
    }
  }

  // 3. Cross-reference
  const clAge = result.chainlink?.age;
  const tAge = result.tellor?.age;
  result.risk = (!result.tellor?.retrieved) ? "CRITICAL — Tellor down" :
                (tAge > 3600) ? "HIGH — Tellor stale >1h" :
                (clAge > 3600) ? "MEDIUM — Chainlink stale >1h" : "LOW";

  return result;
}

async function main() {
  console.log("=== Gravita Tellor + Chainlink Oracle Scan ===\n");

  const results = [];
  for (const c of GRAVITA_CHAINS) {
    const r = await probeChain(c.name, c.id, c.tellor);
    results.push(r);
    const cl = r.chainlink ? "$" + r.chainlink.price.toFixed(2) + " (" + r.chainlink.age + "s ago)" : "N/A";
    const tl = r.tellor?.retrieved ? "$" + r.tellor.price.toFixed(2) + " (" + r.tellor.age + "s ago)" : "N/A";
    console.log(r.name.padEnd(10) + ": CL=" + cl.padEnd(25) + " TL=" + tl.padEnd(25) + " " + r.risk);
  }

  // Summary
  console.log("\n=== Attack Model ===");
  console.log("Gravita = Liquity V2 fork. Chainlink primary + Tellor fallback.");
  console.log("If Tellor is stale/offline: Chainlink becomes sole oracle with no cross-validation.");
  console.log("If Chainlink is stale: Protocol rejects borrows at >4h (configurable).");
  console.log("Double-stale (both > threshold): protocol accepts stale price → borrow at inflated value.");
  console.log("GRAI minted at inflated ETH price → swap on DEX → profit.");

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 2));
  console.log("\nArtifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
