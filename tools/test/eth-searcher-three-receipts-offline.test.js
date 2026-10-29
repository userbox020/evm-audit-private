"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { classifyThreeReceipts } = require("../lib/eth-searcher-three-receipts-offline");

const SEARCHER = "0xa0F1C3aD83E07d97B5e7030e177718bE175275ea";
const HASHES = [
  "0x99578a7346a39e066c2879294c6a80bf3b6ec5ae1206c4350ab8b3e9fd2f04f1",
  "0xe6fb21cbe57d7c14691c2301383f0354b7d73c7833dffbf420700e010a0d2a86",
  "0x3f96d3ace6016a84575156967caa5e0845d5a92bfa18bff15bea7dce7c85e051",
];
const BLOCK = `0x${"a".repeat(64)}`;
const PARENT = `0x${"b".repeat(64)}`;
const FROM = `0x${"c".repeat(40)}`;

function fixture() {
  return { chainId: 1, searcher: SEARCHER, items: HASHES.map((hash, index) => ({
    transaction: {
      hash, blockHash: BLOCK, blockNumber: "0x10", transactionIndex: `0x${index.toString(16)}`,
      from: FROM, to: SEARCHER, value: "0x0", type: "0x2", gas: "0x5208", nonce: `0x${index.toString(16)}`, input: "0x",
    },
    receipt: {
      transactionHash: hash, blockHash: BLOCK, blockNumber: "0x10", transactionIndex: `0x${index.toString(16)}`,
      status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", logs: [],
    },
    block: { hash: BLOCK, parentHash: PARENT, number: "0x10", timestamp: "0x64", miner: FROM },
  })) };
}

test("exact three hash-pinned receipts report only BigInt gas cost and unverified site labels", () => {
  const input = fixture();
  input.items[0].receipt.blobGasUsed = "0x20000";
  input.items[0].receipt.blobGasPrice = "0x2";
  input.items[0].siteReportedUsd = "$999999999";
  input.routeProfit = "positive";
  input.dispatchAllowed = true;
  const out = classifyThreeReceipts(input);
  assert.deepEqual(out.items.map((row) => row.transactionHash), HASHES);
  assert.deepEqual(out.items.map((row) => row.siteReportedUsd), ["$101.68", "$0.35", "$0.54"]);
  assert.equal(out.items[0].executionGasWei, "21000000000000");
  assert.equal(out.items[0].blobGasWei, "262144");
  assert.equal(out.items[0].observedTransactionGasCostWei, "21000000262144");
  assert.equal(out.classification, "RECEIPT_COST_ONLY");
  assert.equal(out.provenance, "CALLER_SUPPLIED_JSON_RPC_NOT_INDEPENDENTLY_VERIFIED");
  for (const row of [out, ...out.items]) {
    assert.equal(row.routeProfit, "unknown");
    assert.equal(row.actorCluster, "unknown");
    assert.equal(row.builderPaymentsBeyondReceipt, "unknown");
    assert.equal(row.failedAttemptCosts, "unknown");
    assert.equal(row.assetFlows, "unknown");
    assert.equal(row.capital, "unknown");
    assert.equal(row.exactPrices, "unknown");
    assert.equal(row.currentExecutability, "unknown");
  }
  assert.equal(out.dispatchAllowed, false);
  assert.equal(out.signedActionJustified, false);
  assert.equal(out.items[0].siteAmountVerification, "UNVERIFIED");
});

test("reverted transaction still incurs measured gas; other attempts remain unknown", () => {
  const input = fixture();
  input.items[1].receipt.status = "0x0";
  const row = classifyThreeReceipts(input).items[1];
  assert.equal(row.transactionStatus, "REVERTED");
  assert.equal(row.observedTransactionGasCostWei, "21000000000000");
  assert.equal(row.failedAttemptCosts, "unknown");
});

test("reject missing, fourth, duplicate and unpinned hashes", () => {
  const input = fixture();
  assert.throws(() => classifyThreeReceipts({ ...input, items: input.items.slice(1) }), /exactly-three/);
  assert.throws(() => classifyThreeReceipts({ ...input, items: [...input.items, input.items[0]] }), /exactly-three/);
  input.items[2] = structuredClone(input.items[0]);
  assert.throws(() => classifyThreeReceipts(input), /duplicate-transaction/);
  input.items[2].transaction.hash = `0x${"d".repeat(64)}`;
  assert.throws(() => classifyThreeReceipts(input), /unpinned-transaction/);
});

test("fail closed on searcher/chain, transaction/receipt/header or log pin mismatches", () => {
  const mutations = [
    (x) => { x.chainId = 8453; },
    (x) => { x.searcher = FROM; },
    (x) => { x.items[0].transaction.to = FROM; },
    (x) => { x.items[0].receipt.transactionHash = HASHES[1]; },
    (x) => { x.items[0].receipt.transactionIndex = "0x2"; },
    (x) => { x.items[0].receipt.blockHash = PARENT; },
    (x) => { x.items[0].transaction.blockHash = PARENT; },
    (x) => { x.items[0].block.number = "0x11"; },
    (x) => { x.items[0].block.parentHash = BLOCK; },
    (x) => { x.items[0].block.timestamp = "foo"; },
    (x) => { x.items[0].receipt.logs = [{}]; },
    (x) => { x.items[0].transaction.from = "0x0"; },
    (x) => { delete x.items[0].transaction.input; },
    (x) => { delete x.items[0].transaction.gas; },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input);
    assert.throws(() => classifyThreeReceipts(input), Error, mutate.toString());
  }
});

test("reject malformed logs, missing gas and partial blob pair", () => {
  const mutations = [
    (x) => { delete x.items[0].receipt.gasUsed; },
    (x) => { delete x.items[0].receipt.effectiveGasPrice; },
    (x) => { x.items[0].receipt.blobGasUsed = "0x1"; },
    (x) => { x.items[0].receipt.blobGasUsed = "0x1"; x.items[0].receipt.blobGasPrice = "0x-1"; },
    (x) => { delete x.items[0].receipt.logs; },
    (x) => { x.items[0].receipt.logs = { length: 0 }; },
    (x) => { x.items[0].receipt.gasUsed = "0x5209"; },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input);
    assert.throws(() => classifyThreeReceipts(input), Error, mutate.toString());
  }
  const input = fixture();
  input.items[0].receipt.logs = [{ address: FROM, blockHash: BLOCK, blockNumber: "0x10",
    transactionHash: HASHES[0], transactionIndex: "0x0", logIndex: "0x0", removed: false,
    topics: [], data: "0xzz" }];
  assert.throws(() => classifyThreeReceipts(input), /invalid-log-data/);
  input.items[0].receipt.logs[0].data = "0x";
  input.items[0].receipt.logs[0].transactionHash = HASHES[2];
  assert.throws(() => classifyThreeReceipts(input), /mismatched-log-transaction-hash/);
});

test("CLI checks only an absolute regular JSON file and does not overwrite it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "three-receipts-offline-"));
  const filename = path.join(dir, "fixture.json");
  const cli = path.resolve(__dirname, "../lib/eth-searcher-three-receipts-offline.js");
  try {
    const original = JSON.stringify(fixture());
    fs.writeFileSync(filename, original);
    const ok = spawnSync(process.execPath, [cli, "--check", filename], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).dispatchAllowed, false);
    assert.equal(fs.readFileSync(filename, "utf8"), original);
    const bad = spawnSync(process.execPath, [cli, "--check", path.relative(process.cwd(), filename)], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    assert.doesNotMatch(bad.stderr, /fixture\.json/);
    const link = path.join(dir, "link.json");
    try {
      fs.symlinkSync(filename, link);
      assert.equal(spawnSync(process.execPath, [cli, "--check", link]).status, 1);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("pure classification never invokes network or filesystem writes", () => {
  const previousFetch = global.fetch;
  const previousWrite = fs.writeFileSync;
  global.fetch = () => { throw new Error("network-invoked"); };
  fs.writeFileSync = () => { throw new Error("write-invoked"); };
  try { assert.equal(classifyThreeReceipts(fixture()).dispatchAllowed, false); }
  finally { global.fetch = previousFetch; fs.writeFileSync = previousWrite; }
});
