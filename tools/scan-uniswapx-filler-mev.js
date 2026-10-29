#!/usr/bin/env node
// scan-uniswapx-filler-mev.js — UniswapX filler MEV extraction scanner
const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "uniswapx-filler-mev.json");
const TIMEOUT = 20_000;
const CHAIN_ID = 1;

// UniswapX contracts on Ethereum
const REACTORS = {
  v2Dutch: "0x00000011f84b9aa48e5f8aa8b9897600006289be",
  v1Exclusive: "0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4",
};

async function main() {
  console.log("UniswapX Filler MEV Scanner\n");

  const ethRpc = await resolveRpc(CHAIN_ID);
  if (!ethRpc) { console.error("No ETH RPC"); process.exit(1); }
  console.log("RPC resolved.");

  const blockHex = await rpcCall(ethRpc, "eth_blockNumber");
  if (!blockHex) { console.error("No RPC"); process.exit(1); }
  const block = parseInt(blockHex, 16);
  console.log(`Current block: ${block}`);

  const allResults = {};

  for (const [name, addr] of Object.entries(REACTORS)) {
    console.log(`\n${name} (${addr.slice(0,12)}...)...`);

    // Query ALL events in last 1000 blocks (no topic filter — extract Fill events)
    const logs = await rpcCall(ethRpc, "eth_getLogs", [{
      fromBlock: "0x" + (block - 1000).toString(16),
      toBlock: "latest",
      address: addr,
    }], 25000);

    if (!Array.isArray(logs) || logs.length === 0) {
      console.log("  No events found");
      allResults[name] = { events: 0 };
      continue;
    }

    console.log(`  Events in last 1K blocks: ${logs.length}`);

    // Analyze event topics
    const topicCounts = {};
    for (const l of logs) {
      const t0 = l.topics[0];
      topicCounts[t0] = (topicCounts[t0] || 0) + 1;
    }
    console.log("  Event types:");
    for (const [t, c] of Object.entries(topicCounts).sort(([,a],[,b]) => b-a).slice(0, 5)) {
      console.log(`    ${t.slice(0,16)}...: ${c}`);
    }

    // Extract filler addresses from Fill events
    // Fill event: topic[0] = Fill signature, topic[1] = orderHash, topic[2] = filler, topic[3] = swapper
    const fillEvents = logs.filter(l => l.topics.length >= 4);
    const fillers = {};
    for (const l of fillEvents) {
      const filler = "0x" + (l.topics[2] || "").slice(26);
      if (filler.length !== 42) continue;
      fillers[filler] = (fillers[filler] || 0) + 1;
    }

    const topFillers = Object.entries(fillers).sort(([,a],[,b]) => b-a).slice(0, 10);
    console.log(`\n  Top fillers by event count:`);
    for (const [f, c] of topFillers) {
      console.log(`    ${f.slice(0,12)}...: ${c} fills`);
    }

    allResults[name] = {
      address: addr,
      totalEvents: logs.length,
      eventTypes: Object.keys(topicCounts).length,
      fillEvents: fillEvents.length,
      uniqueFillers: Object.keys(fillers).length,
      topFillers: topFillers.map(([addr, count]) => ({ addr, count })),
    };
  }

  // Summary
  console.log("\n=== Summary ===");
  for (const [name, r] of Object.entries(allResults)) {
    console.log(`${name}: ${r.fillEvents || 0} fills, ${r.uniqueFillers || 0} unique fillers`);
  }

  // Profit analysis: for a sample Fill, compute the Dutch auction range vs fill timestamp
  // The Dutch auction decays from startAmount to endAmount over decayTime
  // If filler gets order at endAmount but fills at startAmount, they capture the spread
  console.log("\n=== Dutch Auction Profit Model ===");
  console.log("Dutch auction: price drops linearly from startAmount to endAmount over decayTime");
  console.log("Filler profit = (startAmount - fillAmount) * volume - gas");
  console.log("If filler fills at endAmount but user expected startAmount, filler captures full spread");
  console.log("Need to decode order parameters from Fill event data to compute exact profit");
  console.log("This requires UniswapX ABI — source at github.com/Uniswap/UniswapX");

  const artifact = { scannedAt: new Date().toISOString(), block, byReactor: allResults, note: "Phase 1: filler discovery. Phase 2: profit per order." };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
