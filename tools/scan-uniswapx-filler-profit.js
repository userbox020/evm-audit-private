#!/usr/bin/env node
// scan-uniswapx-filler-profit.js — Phase 2B: Profit from receipt Transfer events
const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "uniswapx-filler-profit.json");
const TIMEOUT = 20_000;
const CHAIN_ID = 1;

const REACTOR = "0x00000011f84b9aa48e5f8aa8b9897600006289be";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function main() {
  console.log("UniswapX Phase 2B — Transfer-based Filler Profit\n");

  const ethRpc = await resolveRpc(CHAIN_ID);
  if (!ethRpc) { console.error("No ETH RPC"); process.exit(1); }
  console.log("RPC resolved.");

  const blockHex = await rpcCall(ethRpc, "eth_blockNumber");
  if (!blockHex) { console.error("No RPC"); process.exit(1); }
  const block = parseInt(blockHex, 16);

  // Get Fill events
  const logs = await rpcCall(ethRpc, "eth_getLogs", [{ fromBlock: "0x" + (block - 500).toString(16), toBlock: "latest", address: REACTOR }], 25000);
  if (!Array.isArray(logs)) { console.log("No events"); process.exit(0); }

  const txHashes = [...new Set(logs.map(l => l.transactionHash).filter(Boolean))];
  console.log(`Found ${txHashes.length} Fill txs in last 500 blocks`);

  const results = [];
  for (const txHash of txHashes) {
    // Get transaction to identify filler contract
    const tx = await rpcCall(ethRpc, "eth_getTransactionByHash", [txHash]);
    if (!tx) continue;
    const filler = tx.to; // filler contract address

    // Get receipt
    const receipt = await rpcCall(ethRpc, "eth_getTransactionReceipt", [txHash]);
    if (!receipt) continue;

    // Extract Transfer events
    const transfers = (receipt.logs || []).filter(l => l.topics[0] === TRANSFER_TOPIC);
    if (transfers.length < 2) continue;

    // Classify: transfers TO filler vs FROM filler vs DEX routing
    let valueToFiller = 0, valueFromFiller = 0;
    const fillerLC = filler.toLowerCase();
    
    for (const t of transfers) {
      const from = "0x" + t.topics[1].slice(26);
      const to = "0x" + t.topics[2].slice(26);
      const amount = Number(BigInt(t.data)) / 1e18;

      if (to.toLowerCase() === fillerLC) {
        // Someone sent tokens TO the filler
        valueToFiller += amount * 1700; // rough ETH price
      } else if (from.toLowerCase() === fillerLC) {
        // Filler sent tokens OUT
        valueFromFiller += amount * 1700;
      }
    }

    const gas = parseInt(receipt.gasUsed, 16);
    const gasPrice = parseInt(tx.gasPrice, 16) / 1e9;
    const gasCost = (gas * gasPrice) / 1e18 * 1700; // rough USD
    
    const grossProfit = valueToFiller - valueFromFiller;
    const netProfit = grossProfit - gasCost;

    results.push({
      txHash: txHash.slice(0, 16),
      filler: filler.slice(0, 12),
      transfers: transfers.length,
      gas, gasCost: Math.round(gasCost),
      valueToFiller: Math.round(valueToFiller),
      valueFromFiller: Math.round(valueFromFiller),
      grossProfit: Math.round(grossProfit),
      netProfit: Math.round(netProfit),
      marginPct: valueToFiller > 0 ? ((grossProfit / valueToFiller) * 100).toFixed(2) + "%" : "N/A",
    });
  }

  results.sort((a, b) => b.grossProfit - a.grossProfit);

  console.log(`\n=== Profit Analysis (${results.length} txs) ===`);
  for (const r of results.slice(0, 15)) {
    const icon = r.grossProfit > 100 ? "🚨" : r.grossProfit > 10 ? "💰" : "  ";
    console.log(`${icon} ${r.filler}... gas=$${r.gasCost} in=$${r.valueToFiller} out=$${r.valueFromFiller} gross=$${r.grossProfit} net=$${r.netProfit} margin=${r.marginPct}`);
  }

  // Summary
  const totalGross = results.reduce((s, r) => s + r.grossProfit, 0);
  const totalNet = results.reduce((s, r) => s + r.netProfit, 0);
  const avgMargin = results.reduce((s, r) => s + (r.grossProfit / Math.max(1, r.valueToFiller)), 0) / results.length * 100;

  console.log(`\n=== Summary ===`);
  console.log(`  Total fills analyzed: ${results.length}`);
  console.log(`  Total gross profit: $${Math.round(totalGross).toLocaleString()}`);
  console.log(`  Total net profit: $${Math.round(totalNet).toLocaleString()}`);
  console.log(`  Avg gross margin: ${avgMargin.toFixed(2)}%`);

  const artifact = { scannedAt: new Date().toISOString(), block, fillsAnalyzed: results.length, totalGross: Math.round(totalGross), totalNet: Math.round(totalNet), avgMarginPct: avgMargin.toFixed(2), results };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
