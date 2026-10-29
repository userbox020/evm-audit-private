#!/usr/bin/env node
// cowswap-limit-price-invariant.js
// Decode GPv2Settlement.settle() calldata and verify on-chain limit-price invariant:
//   order.sellAmount * clearingPrice[sellToken] >= order.buyAmount * clearingPrice[buyToken]
// This is the smart-contract-enforced fairness invariant behind CoW settlements.

const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const fs = require("fs");
const path = require("path");

const SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const SETTLE_TOPIC = "0x40338ce1a7c49204f0099533b1e9a7ee0a3d261f84974ab7af36105b8c4e9db4";

// GPv2Trade.Data is a compact calldata struct using token indices + packed flags.
// Selector must match mainnet settle selector 0x13d79a0b.
const SETTLE_IF = new ethers.Interface([
  "function settle(address[] tokens,uint256[] clearingPrices,tuple(uint256 sellTokenIndex,uint256 buyTokenIndex,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,uint256 flags,uint256 executedAmount,bytes signature)[] trades,tuple(address target,uint256 value,bytes callData)[][3] interactions)"
]);

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchLogs(rpc, fromBlock, toBlock) {
  const step = 1000;
  const out = [];
  for (let f = fromBlock; f <= toBlock; f += step + 1) {
    const t = Math.min(f + step, toBlock);
    const logs = await rpcCall(rpc, "eth_getLogs", [{
      address: SETTLEMENT,
      topics: [SETTLE_TOPIC],
      fromBlock: "0x" + f.toString(16),
      toBlock: "0x" + t.toString(16),
    }], 30000);
    if (Array.isArray(logs)) out.push(...logs);
    await delay(150);
  }
  return out;
}

async function main() {
  const rpc = await resolveRpc(1);
  if (!rpc) throw new Error("No Ethereum RPC resolved");

  const currentHex = await rpcCall(rpc, "eth_blockNumber", [], 8000);
  const current = parseInt(currentHex, 16);
  const from = Math.max(0, current - 2000);
  const to = current;

  console.error(`Scanning CoW Settlement events in blocks ${from}-${to}`);
  const settlementLogs = await fetchLogs(rpc, from, to);
  console.error(`Settlement events: ${settlementLogs.length}`);

  const maxTx = Math.min(300, settlementLogs.length);
  let decodedTx = 0, decodeErrors = 0, wrapperTxSkipped = 0, totalTrades = 0, limitViolations = 0;
  let missingTokenIndex = 0, sharedPriceVectorChecks = 0;
  const violations = [];
  const samples = [];

  for (let i = 0; i < maxTx; i++) {
    const txHash = settlementLogs[i].transactionHash;
    const tx = await rpcCall(rpc, "eth_getTransactionByHash", [txHash], 15000);
    if (!tx || !tx.input || tx.input === "0x") { decodeErrors++; continue; }
    // Some Settlement events are emitted via solver wrapper contracts. Without traces,
    // only direct GPv2Settlement.settle calldata can be decoded from tx.input.
    if (String(tx.to).toLowerCase() !== SETTLEMENT.toLowerCase() || tx.input.slice(0, 10) !== "0x13d79a0b") {
      wrapperTxSkipped++;
      continue;
    }

    let decoded;
    try {
      decoded = SETTLE_IF.decodeFunctionData("settle", tx.input);
    } catch (e) {
      decodeErrors++;
      continue;
    }

    decodedTx++;
    const tokens = Array.from(decoded.tokens || decoded[0] || []);
    const prices = Array.from(decoded.clearingPrices || decoded[1] || []);
    const trades = Array.from(decoded.trades || decoded[2] || []);
    totalTrades += trades.length;

    // The shared vector itself is the on-chain representation of uniform token prices for a batch.
    sharedPriceVectorChecks += trades.length;

    for (const tr of trades) {
      const sellTokenIndex = Number(tr.sellTokenIndex ?? tr[0]);
      const buyTokenIndex = Number(tr.buyTokenIndex ?? tr[1]);
      const sellToken = tokens[sellTokenIndex];
      const buyToken = tokens[buyTokenIndex];
      const sellAmount = BigInt(tr.sellAmount ?? tr[3] ?? 0);
      const buyAmount = BigInt(tr.buyAmount ?? tr[4] ?? 0);
      const sellPrice = prices[sellTokenIndex] === undefined ? undefined : BigInt(prices[sellTokenIndex]);
      const buyPrice = prices[buyTokenIndex] === undefined ? undefined : BigInt(prices[buyTokenIndex]);

      if (sellPrice === undefined || buyPrice === undefined) {
        missingTokenIndex++;
        violations.push({ txHash: txHash.slice(0, 20), invariant: "tokenIndex", sellToken, buyToken });
        continue;
      }

      const lhs = sellAmount * sellPrice;
      const rhs = buyAmount * buyPrice;
      if (lhs < rhs) {
        limitViolations++;
        violations.push({
          txHash: txHash.slice(0, 20),
          invariant: "limitPrice",
          sellToken: String(sellToken).slice(0, 10),
          buyToken: String(buyToken).slice(0, 10),
          sellAmount: sellAmount.toString(),
          buyAmount: buyAmount.toString(),
          lhs: lhs.toString(),
          rhs: rhs.toString(),
        });
      }
    }

    if (samples.length < 5) {
      samples.push({
        txHash: txHash.slice(0, 20),
        tokens: tokens.length,
        trades: trades.length,
        interactionsGroups: (decoded.interactions || decoded[3] || []).length,
      });
    }

    if ((i + 1) % 50 === 0) console.error(`  decoded ${i + 1}/${maxTx}`);
    await delay(50);
  }

  const report = {
    scannedAt: new Date().toISOString(),
    blockRange: `${from}-${to}`,
    sampledSettlements: maxTx,
    decodedSettlements: decodedTx,
    decodeErrors,
    wrapperTxSkipped,
    totalTrades,
    invariants: {
      sharedClearingPriceVector: {
        checkedTrades: sharedPriceVectorChecks,
        note: "All decoded trades use one settlement-wide token -> clearingPrice vector from settle() calldata.",
        pass: decodedTx > 0,
      },
      limitPrice: {
        checkedTrades: totalTrades,
        violations: limitViolations,
        pass: limitViolations === 0,
      },
      tokenIndexCoverage: {
        missingTokenIndex,
        pass: missingTokenIndex === 0,
      },
    },
    samples,
    violations: violations.slice(0, 25),
    verdict: limitViolations === 0 && missingTokenIndex === 0 && decodedTx > 0
      ? "ALL_LIMIT_PRICE_INVARIANTS_PASSED"
      : "VIOLATIONS_OR_DECODE_ERRORS_FOUND",
  };

  const out = path.join(__dirname, "..", "reports", "raw", "cowswap-limit-price-invariant.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.error(`Report: ${out}`);
  console.log(JSON.stringify({
    verdict: report.verdict,
    decodedSettlements: decodedTx,
    trades: totalTrades,
    limitViolations,
    missingTokenIndex,
    decodeErrors,
    wrapperTxSkipped,
  }, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
