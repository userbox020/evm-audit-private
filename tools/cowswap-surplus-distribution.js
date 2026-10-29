#!/usr/bin/env node
// cowswap-surplus-distribution.js
// Defensive on-chain visibility pass for CoW Protocol fee/surplus distribution.
// Important limitation: true user surplus and solver rewards require off-chain auction
// reference prices/scores and reward accounting; they cannot be derived from events alone.

const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const fs = require("fs");
const path = require("path");

const SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const SETTLE_TOPIC = "0x40338ce1a7c49204f0099533b1e9a7ee0a3d261f84974ab7af36105b8c4e9db4";
const SETTLE_IF = new ethers.Interface([
  "function settle(address[] tokens,uint256[] clearingPrices,tuple(uint256 sellTokenIndex,uint256 buyTokenIndex,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,uint256 flags,uint256 executedAmount,bytes signature)[] trades,tuple(address target,uint256 value,bytes callData)[][3] interactions)"
]);

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchSettlementLogs(rpc, fromBlock, toBlock) {
  const logs = [];
  for (let f = fromBlock; f <= toBlock; f += 1001) {
    const t = Math.min(f + 1000, toBlock);
    const r = await rpcCall(rpc, "eth_getLogs", [{
      address: SETTLEMENT,
      topics: [SETTLE_TOPIC],
      fromBlock: "0x" + f.toString(16),
      toBlock: "0x" + t.toString(16),
    }], 30000);
    if (Array.isArray(r)) logs.push(...r);
    await delay(150);
  }
  return logs;
}

function addBig(map, key, amount) {
  map.set(key, (map.get(key) || 0n) + amount);
}

async function main() {
  const rpc = await resolveRpc(1);
  if (!rpc) throw new Error("No Ethereum RPC resolved");

  const current = parseInt(await rpcCall(rpc, "eth_blockNumber", [], 8000), 16);
  const from = Math.max(0, current - 2000);
  const logs = await fetchSettlementLogs(rpc, from, current);
  const maxTx = Math.min(300, logs.length);

  let decoded = 0, wrapperSkipped = 0, decodeErrors = 0, trades = 0;
  let nonzeroFeeTrades = 0, zeroFeeTrades = 0;
  let totalInteractions = 0, settlementsWithInteractions = 0;
  const feesBySellToken = new Map();
  const executedBySellToken = new Map();
  const sampleTrades = [];

  for (let i = 0; i < maxTx; i++) {
    const txHash = logs[i].transactionHash;
    const tx = await rpcCall(rpc, "eth_getTransactionByHash", [txHash], 15000);
    if (!tx || !tx.input) { decodeErrors++; continue; }
    if (String(tx.to).toLowerCase() !== SETTLEMENT.toLowerCase() || tx.input.slice(0, 10) !== "0x13d79a0b") {
      wrapperSkipped++;
      continue;
    }

    let dec;
    try { dec = SETTLE_IF.decodeFunctionData("settle", tx.input); }
    catch (_) { decodeErrors++; continue; }

    decoded++;
    const tokens = Array.from(dec.tokens || dec[0] || []);
    const tradeList = Array.from(dec.trades || dec[2] || []);
    const interactions = Array.from(dec.interactions || dec[3] || []);
    const interactionCount = interactions.reduce((acc, g) => acc + Array.from(g || []).length, 0);
    totalInteractions += interactionCount;
    if (interactionCount > 0) settlementsWithInteractions++;

    for (const tr of tradeList) {
      trades++;
      const sellTokenIndex = Number(tr.sellTokenIndex ?? tr[0]);
      const sellToken = (tokens[sellTokenIndex] || "unknown").toLowerCase();
      const feeAmount = BigInt(tr.feeAmount ?? tr[7] ?? 0);
      const executedAmount = BigInt(tr.executedAmount ?? tr[9] ?? 0);
      addBig(feesBySellToken, sellToken, feeAmount);
      addBig(executedBySellToken, sellToken, executedAmount);
      if (feeAmount > 0n) nonzeroFeeTrades++; else zeroFeeTrades++;
      if (sampleTrades.length < 10) {
        sampleTrades.push({
          txHash: txHash.slice(0, 20),
          sellToken,
          feeAmount: feeAmount.toString(),
          executedAmount: executedAmount.toString(),
        });
      }
    }
    await delay(50);
  }

  const feeRows = [...feesBySellToken.entries()]
    .map(([token, amount]) => ({ token, rawFeeAmount: amount.toString(), rawExecutedAmount: (executedBySellToken.get(token) || 0n).toString() }))
    .sort((a, b) => BigInt(b.rawFeeAmount) > BigInt(a.rawFeeAmount) ? 1 : -1)
    .slice(0, 25);

  const report = {
    scannedAt: new Date().toISOString(),
    blockRange: `${from}-${current}`,
    sampledSettlements: maxTx,
    decodedDirectSettlements: decoded,
    wrapperTxSkipped: wrapperSkipped,
    decodeErrors,
    trades,
    feeVisibility: {
      nonzeroFeeTrades,
      zeroFeeTrades,
      feesBySellToken: feeRows,
      note: "Raw feeAmount grouped by sell token; not normalized by decimals/price.",
    },
    interactions: {
      settlementsWithInteractions,
      totalInteractions,
      avgInteractionsPerDecodedSettlement: decoded ? totalInteractions / decoded : 0,
      note: "Interactions are solver route/execution calls; surplus cannot be attributed from calldata alone.",
    },
    surplusDistribution: {
      verdict: "NOT_ONCHAIN_DETERMINABLE_FROM_SETTLEMENT_EVENTS_ALONE",
      defensibleClaims: [
        "Limit prices are enforced on-chain against a settlement-wide clearing price vector.",
        "Per-order raw feeAmount can be decoded from direct settle() calldata.",
        "Solver competition concentration is observable from Settlement events.",
      ],
      notDefensibleFromOnChainAlone: [
        "True user surplus vs EBBO/baseline AMM quotes.",
        "Solver reward/profit after off-chain scoring and COW reward accounting.",
        "Collusion or score inflation without auction service/governance data.",
      ],
    },
    sampleTrades,
    verdict: "NO_ONCHAIN_SURPLUS_EXTRACTION_EVIDENCE; TRUE_SURPLUS_REQUIRES_OFFCHAIN_AUCTION_DATA",
  };

  const out = path.join(__dirname, "..", "reports", "raw", "cowswap-surplus-distribution.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.error(`Report: ${out}`);
  console.log(JSON.stringify({
    verdict: report.verdict,
    decodedDirectSettlements: decoded,
    trades,
    nonzeroFeeTrades,
    zeroFeeTrades,
    wrapperTxSkipped: wrapperSkipped,
  }, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
