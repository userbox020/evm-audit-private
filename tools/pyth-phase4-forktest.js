#!/usr/bin/env node
// pyth-phase4-forktest.js — Phase 4: Find Morpho oracle instances + build fork-test
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");
const fs = require("fs"); const path = require("path");

const OUT = path.join(__dirname, "..", "reports", "raw", "fast", "pyth-phase4-forktest.json");
const ARB_FACTORY = "0x3e2D5966bF67Ed2F66edfbc325f6bCf3d64EaA0A";
const ETH_FACTORY = "0x1ed187354d6bfb983932d9983917b199a7253ab9";
const BASE_FACTORY = "0x0A250c472cb43fb4F476cc6f47da9CA85E071Bbb";

const ETH_USD = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
const WBTC_USD = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

// Morpho Blue address on Arbitrum
const MORPHO_ARB = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// getPriceUnsafe selector
const GET_PRICE_UNSAFE = "0x96834ad3";

// Try to find deployed oracle instances via factory events (eth_getLogs)
async function findDeployedOracles(rpc, factoryAddr, chainLabel) {
  // OracleCreated event: topic = keccak256("OracleCreated(address,address)")
  // Or CreateMarket event for Morpho
  // For the Pyth wrapper factory, try the generic Create event
  
  // Try OracleCreated event sig
  const eventSig = ethers.id("OracleCreated(address,address)");
  console.log(`  Event topic: ${eventSig}`);

  // Query recent logs — use a recent block range
  const block = await rpcCall(rpc, "eth_blockNumber", [], 5000);
  if (!block) { console.log(`  Cannot get block number for ${chainLabel}`); return []; }
  const currentBlock = parseInt(block, 16);
  const fromBlock = "0x" + Math.max(0, currentBlock - 500000).toString(16);
  const toBlock = block;

  const logs = await rpcCall(rpc, "eth_getLogs", [{
    address: factoryAddr,
    fromBlock,
    toBlock,
    topics: [eventSig]
  }], 15000);

  const oracles = [];
  if (logs && Array.isArray(logs)) {
    console.log(`  Found ${logs.length} OracleCreated events`);
    for (const log of logs.slice(0, 5)) {
      // OracleCreated(address indexed oracle, address indexed creator)
      // oracle is in topic[1] (indexed)
      if (log.topics && log.topics.length >= 2) {
        const oracleAddr = "0x" + log.topics[1].slice(26);
        oracles.push(oracleAddr);
        console.log(`    Oracle: ${oracleAddr}`);
      }
    }
  } else {
    // Try alternative — the factory might not have events, or uses different event name
    console.log("  No OracleCreated events — trying manual address discovery");
    
    // Try known Morpho Pyth oracle addresses from Pyth docs / GitHub examples
    // These are example deployments
    const knownOracles = [];
    if (chainLabel === "Base") {
      knownOracles.push("0xCb0108cD41C0A83145be1EBA8BffE15D85FFc3e7"); // WBTC/USDT example from README
    }
    
    for (const addr of knownOracles) {
      const code = await rpcCall(rpc, "eth_getCode", [addr, "latest"], 5000);
      if (code && code.length > 10) {
        oracles.push(addr);
        console.log(`    Known oracle: ${addr} (${(code.length-2)/2}B)`);
      }
    }
  }

  return oracles;
}

async function checkOracle(rpc, oracleAddr) {
  const r = { addr: oracleAddr, deployed: false };
  
  const code = await rpcCall(rpc, "eth_getCode", [oracleAddr, "latest"], 5000);
  if (!code || code.length < 10) return r;
  r.deployed = true;
  r.codeSize = (code.length - 2) / 2;

  // Check for Pyth selectors
  const methods = [];
  for (const [name, sel] of Object.entries({
    getPriceUnsafe: "0x96834ad3",
    getPriceNoOlderThan: "0x41da4bb7",
    getEmaPriceNoOlderThan: "0xb3993119"
  })) {
    if (code.includes(sel.slice(2))) methods.push(name);
  }
  r.methods = methods;
  r.usesUnsafe = methods.includes("getPriceUnsafe");

  // Try reading ETH/USD via getPriceUnsafe
  const raw = await rpcCall(rpc, "eth_call", [{ to:oracleAddr, data:GET_PRICE_UNSAFE + ETH_USD.slice(2)}, "latest"], 8000);
  if (raw && raw.length >= 130) {
    const price = BigInt("0x" + raw.slice(2, 66));
    if (price !== 0n) {
      const MAX = BigInt("0x7FFFFFFFFFFFFFFF");
      const pv = price > MAX ? price - BigInt("0x10000000000000000") : price;
      const expRaw = parseInt(raw.slice(186, 194), 16);
      const exp = expRaw > 0x7FFFFFFF ? expRaw - 0x100000000 : expRaw;
      const ts = Number(BigInt("0x" + raw.slice(194, 258)));
      const age = Math.floor(Date.now()/1000) - ts;
      r.ethUsd = { price: Number(pv) * Math.pow(10, exp), timestamp: ts, age };
    }
  }

  // Check if this oracle is Morpho IOracle compatible (has price() getter)
  const morphoPriceRaw = await rpcCall(rpc, "eth_call", [{ to:oracleAddr, data:"0xa035b1fe"}, "latest"], 5000);
  if (morphoPriceRaw && morphoPriceRaw.length >= 66) {
    r.hasMorphoPriceGetter = true;
    r.morphoPrice = Number(BigInt("0x" + morphoPriceRaw.slice(2, 66))) / 1e18;
  }

  return r;
}

async function main() {
  console.log("=== Phase 4: Pyth Morpho Oracle Fork Test ===\n");

  // Focus on Arbitrum — highest Pyth staleness (9.4h)
  const rpcArb = await resolveRpc(42161);
  if (!rpcArb) { console.error("No Arbitrum RPC"); return; }

  console.log("--- Finding Morpho PythOracle instances on Arbitrum ---");
  const arbOracles = await findDeployedOracles(rpcArb, ARB_FACTORY, "Arb");

  console.log("\n--- Checking Oracle Instances ---");
  const allFindings = [];
  for (const oracleAddr of arbOracles) {
    const r = await checkOracle(rpcArb, oracleAddr);
    allFindings.push(r);
    console.log(`  ${oracleAddr.slice(0,10)}...: deployed=${r.deployed} unsafe=${r.usesUnsafe} morphoPrice=${r.morphoPrice?.toFixed(2) || "N/A"}`);
    if (r.ethUsd) {
      console.log(`    ETH/USD via getPriceUnsafe: $${r.ethUsd.price.toFixed(2)} (${r.ethUsd.age}s stale)`);
    }
  }

  // Also check Ethereum + Base factories for comparison
  const rpcEth = await resolveRpc(1);
  if (rpcEth) {
    console.log("\n--- Ethereum Morpho Oracles ---");
    const ethOracles = await findDeployedOracles(rpcEth, ETH_FACTORY, "ETH");
    for (const oa of ethOracles.slice(0, 3)) {
      const r = await checkOracle(rpcEth, oa);
      allFindings.push(r);
      console.log(`  ${oa.slice(0,10)}...: unsafe=${r.usesUnsafe} price=${r.morphoPrice?.toFixed(2) || "N/A"}`);
    }
  }

  const rpcBase = await resolveRpc(8453);
  if (rpcBase) {
    console.log("\n--- Base Morpho Oracles ---");
    const baseOracles = await findDeployedOracles(rpcBase, BASE_FACTORY, "Base");
    for (const oa of baseOracles.slice(0, 3)) {
      const r = await checkOracle(rpcBase, oa);
      allFindings.push(r);
      console.log(`  ${oa.slice(0,10)}...: unsafe=${r.usesUnsafe} price=${r.morphoPrice?.toFixed(2) || "N/A"}`);
    }
  }

  // Build attack scenario
  const exploitable = allFindings.filter(r => r.usesUnsafe && r.ethUsd && r.ethUsd.age > 3600);
  console.log(`\n=== Exploitable Oracles (>1h stale Pyth) ===`);
  console.log(`Found: ${exploitable.length}`);

  if (exploitable.length > 0) {
    console.log("\n=== Fork Test Instructions ===");
    console.log("1. Start anvil fork:");
    console.log("   anvil --fork-url <ARBITRUM_RPC> --fork-block-number <RECENT>");
    console.log("");
    console.log("2. Verify stale Pyth price via oracle:");
    for (const e of exploitable.slice(0, 1)) {
      console.log(`   cast call ${e.addr} "price()(uint256)" --rpc-url http://localhost:8545`);
      console.log(`   # Should return stale ETH/USD price (${e.ethUsd.age}s old)`);
      console.log("");
      console.log("3. Attack flow:");
      console.log("   # Step A: Get flash loan of USDC via Aave V3");
      console.log("   # Step B: Supply USDC to Morpho market using Pyth oracle");
      console.log("   # Step C: Borrow ETH against USDC at stale Pyth price");
      console.log("   # Step D: If stale price overvalues USDC → borrow more ETH than collateral worth");
      console.log("   # Step E: Sell ETH for USDC, repay flash loan, keep profit");
    }
  } else {
    console.log("\nNo exploitable oracles found — all Morpho Pyth oracles are safe or Pyth is fresh");
    console.log("\nThe factories contain getPriceUnsafe but individual oracles may enforce staleness");
    console.log("via Morpho's IOracle interface wrapping or Pyth wrapper validation logic");
  }

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt:new Date().toISOString(), allFindings, exploitable }, null, 2));
  console.log("\nArtifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
