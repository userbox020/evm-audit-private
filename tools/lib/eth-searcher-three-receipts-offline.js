"use strict";

// This module does not fetch, price, trace or reconstruct a route. Inputs are
// caller-supplied JSON-RPC objects, not independently authenticated chain data.
const fs = require("node:fs");
const path = require("node:path");
const {
  fullHash, sanitizeBlock, sanitizeReceipt, sanitizeTransaction,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/forensics");

const SEARCHER = "0xa0f1c3ad83e07d97b5e7030e177718be175275ea";
const SITE_CLAIMS = Object.freeze({
  "0x99578a7346a39e066c2879294c6a80bf3b6ec5ae1206c4350ab8b3e9fd2f04f1": "$101.68",
  "0xe6fb21cbe57d7c14691c2301383f0354b7d73c7833dffbf420700e010a0d2a86": "$0.35",
  "0x3f96d3ace6016a84575156967caa5e0845d5a92bfa18bff15bea7dce7c85e051": "$0.54",
});
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HEX_DATA = /^0x(?:[0-9a-f]{2})*$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const UNKNOWN = Object.freeze({
  routeProfit: "unknown", actorCluster: "unknown", builderPaymentsBeyondReceipt: "unknown",
  failedAttemptCosts: "unknown", assetFlows: "unknown", capital: "unknown",
  exactPrices: "unknown", currentExecutability: "unknown",
});

function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid-${name}`);
  return value;
}

function quantity(value, name) {
  if (typeof value !== "string" || !QUANTITY.test(value) || value.length > 66) throw new Error(`invalid-${name}`);
  return BigInt(value);
}

function matchingHash(value, expected, name) {
  if (fullHash(value, name) !== expected) throw new Error(`mismatched-${name}`);
}

function validateLog(log, tx, block, seenIndexes) {
  object(log, "log");
  if (!ADDRESS.test(log.address)) throw new Error("invalid-log-address");
  if (log.removed !== false) throw new Error("removed-or-unspecified-log");
  if (!Array.isArray(log.topics) || log.topics.length > 4) throw new Error("invalid-log-topics");
  for (const topic of log.topics) fullHash(topic, "log-topic");
  if (typeof log.data !== "string" || log.data.length > 131074 || !HEX_DATA.test(log.data)) throw new Error("invalid-log-data");
  matchingHash(log.transactionHash, tx.hash, "log-transaction-hash");
  matchingHash(log.blockHash, block.hash, "log-block-hash");
  if (quantity(log.transactionIndex, "log-transaction-index") !== BigInt(tx.transactionIndex) ||
      quantity(log.blockNumber, "log-block-number") !== BigInt(block.number)) throw new Error("mismatched-log-pin");
  const index = quantity(log.logIndex, "log-index").toString();
  if (seenIndexes.has(index)) throw new Error("duplicate-log-index");
  seenIndexes.add(index);
}

function classifyThreeReceipts(input, options = {}) {
  object(input, "input");
  object(options, "options");
  if (Object.keys(options).length) throw new Error("unsupported-options");
  if (input.chainId !== 1 && input.chainId !== "1" && input.chainId !== "0x1") throw new Error("wrong-chain-id");
  if (typeof input.searcher !== "string" || input.searcher.toLowerCase() !== SEARCHER) throw new Error("wrong-searcher");
  if (!Array.isArray(input.items) || input.items.length !== 3) throw new Error("exactly-three-items-required");
  const seen = new Set();
  const items = input.items.map((entry) => {
    object(entry, "item");
    const tx = object(entry.transaction, "transaction");
    const receipt = object(entry.receipt, "receipt");
    const header = object(entry.block, "block");
    const hash = fullHash(tx.hash, "transaction-hash");
    if (!Object.hasOwn(SITE_CLAIMS, hash)) throw new Error("unpinned-transaction");
    if (seen.has(hash)) throw new Error("duplicate-transaction");
    seen.add(hash);
    if (typeof tx.to !== "string" || tx.to.toLowerCase() !== SEARCHER) throw new Error("wrong-transaction-recipient");
    if (!ADDRESS.test(tx.from)) throw new Error("invalid-transaction-sender");
    for (const key of ["blockNumber", "transactionIndex", "value", "type", "gas", "nonce"]) quantity(tx[key], `transaction-${key}`);
    if (typeof tx.input !== "string" || tx.input.length > 262146 || !HEX_DATA.test(tx.input)) throw new Error("invalid-transaction-input");
    for (const key of ["number", "timestamp"]) quantity(header[key], `block-${key}`);
    fullHash(header.hash, "block-hash");
    fullHash(header.parentHash, "parent-hash");
    if (header.hash.toLowerCase() === header.parentHash.toLowerCase()) throw new Error("self-parent-block");
    if (quantity(header.number, "block-number") === 0n) throw new Error("genesis-transaction-block");
    if (!ADDRESS.test(header.miner)) throw new Error("invalid-block-miner");
    const transaction = sanitizeTransaction(tx);
    const block = sanitizeBlock(header);
    matchingHash(transaction.blockHash, block.hash, "transaction-block-hash");
    if (transaction.blockNumber !== block.number) throw new Error("mismatched-transaction-block-number");
    matchingHash(receipt.transactionHash, hash, "receipt-transaction-hash");
    matchingHash(receipt.blockHash, block.hash, "receipt-block-hash");
    if (quantity(receipt.blockNumber, "receipt-block-number") !== BigInt(block.number) ||
        quantity(receipt.transactionIndex, "receipt-transaction-index") !== BigInt(transaction.transactionIndex)) throw new Error("mismatched-receipt-pin");
    const status = quantity(receipt.status, "receipt-status");
    if (status !== 0n && status !== 1n) throw new Error("invalid-receipt-status");
    const gasUsed = quantity(receipt.gasUsed, "gas-used");
    const effectiveGasPrice = quantity(receipt.effectiveGasPrice, "effective-gas-price");
    if (gasUsed > quantity(tx.gas, "transaction-gas")) throw new Error("gas-used-exceeds-limit");
    const blobUsed = receipt.blobGasUsed != null;
    const blobPrice = receipt.blobGasPrice != null;
    if (blobUsed !== blobPrice) throw new Error("partial-blob-gas");
    const blobGasUsed = blobUsed ? quantity(receipt.blobGasUsed, "blob-gas-used") : 0n;
    const blobGasPrice = blobPrice ? quantity(receipt.blobGasPrice, "blob-gas-price") : 0n;
    if (!Array.isArray(receipt.logs) || receipt.logs.length > 4096) throw new Error("invalid-receipt-logs");
    const seenIndexes = new Set();
    for (const log of receipt.logs) validateLog(log, transaction, block, seenIndexes);
    // Existing sanitizers accept the canonical JSON-RPC field shape. Their
    // event decoding is not evidence of actor control or complete asset flows.
    sanitizeReceipt(receipt);
    const executionGasWei = gasUsed * effectiveGasPrice;
    const blobGasWei = blobGasUsed * blobGasPrice;
    return {
      transactionHash: hash, blockHash: block.hash, blockNumber: block.number,
      transactionIndex: transaction.transactionIndex, transactionStatus: status === 0n ? "REVERTED" : "SUCCESS",
      transactionSender: transaction.from, observedTransactionGasCostWei: (executionGasWei + blobGasWei).toString(),
      executionGasWei: executionGasWei.toString(), blobGasWei: blobGasWei.toString(),
      siteReportedUsd: SITE_CLAIMS[hash], siteAmountVerification: "UNVERIFIED",
      classification: "RECEIPT_COST_ONLY", ...UNKNOWN,
    };
  });
  if (seen.size !== 3) throw new Error("missing-pinned-transaction");
  return { chainId: 1, searcher: SEARCHER, classification: "RECEIPT_COST_ONLY",
    provenance: "CALLER_SUPPLIED_JSON_RPC_NOT_INDEPENDENTLY_VERIFIED", items,
    ...UNKNOWN, dispatchAllowed: false, signedActionJustified: false };
}

function checkFile(file) {
  if (!path.isAbsolute(file)) throw new Error("absolute-file-required");
  const resolved = path.resolve(file);
  if (path.extname(resolved).toLowerCase() !== ".json") throw new Error("json-file-required");
  let cursor = path.parse(resolved).root;
  for (const component of resolved.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, component);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("symlink-disallowed");
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("file-size-or-type-disallowed");
    const buffer = Buffer.alloc(stat.size + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes !== stat.size) throw new Error("file-changed-during-read");
    return classifyThreeReceipts(JSON.parse(buffer.toString("utf8", 0, bytes)));
  } finally { fs.closeSync(fd); }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--check") throw new Error("usage");
    process.stdout.write(`${JSON.stringify(checkFile(process.argv[3]), null, 2)}\n`);
  } catch (_) {
    process.stderr.write("Offline receipt check rejected input (expected --check <absolute .json file>).\n");
    process.exitCode = 1;
  }
}

module.exports = { classifyThreeReceipts, checkFile };
