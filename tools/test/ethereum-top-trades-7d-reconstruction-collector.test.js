"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { LOG_REGISTRY } = require("../atomic/ethereum-top-trades-7d-reconstruction/constants");
const {
  adaptiveLogRange,
  bindDiscoveryProvenance,
  buildEthereumCandidatePool,
  consumeResponseBody,
  corroborateCandidates,
  equalConsensusFields,
  establishWindow,
  fetchTransport,
  forkPlan,
  normalizeCallTrace,
  normalizePrestate,
  parseInventoryText,
  processOnlyHeaders,
  selectAgreedProviders,
  validateCandidateView,
  validateDiscoveredLog,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/collector");
const { bindProtocolLiabilities, buildLedger, calculateEconomics, sanitizeLog } = require("../atomic/ethereum-top-trades-7d-reconstruction/forensics");
const { atomicBundle, leakScan } = require("../atomic/ethereum-top-trades-7d-reconstruction/output");

const ACTOR = "0x1000000000000000000000000000000000000001";
const OTHER = "0x2000000000000000000000000000000000000002";
const COINBASE = "0x3000000000000000000000000000000000000003";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const hash = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const hex = (value) => `0x${BigInt(value).toString(16)}`;

function provider(index) {
  return { url: `mock:${index}`, family: `family-${index}`, declaredGroup: true, ordinal: `provider-${String(index + 1).padStart(2, "0")}` };
}

function qualificationObjects(number, txHash) {
  const blockHash = hash(number);
  return {
    transaction: { hash: txHash, blockHash, blockNumber: hex(number), transactionIndex: "0x0", from: ACTOR, to: OTHER, value: "0x0", type: "0x2", input: "0x", nonce: "0x1", gas: "0x5208" },
    receipt: { transactionHash: txHash, blockHash, blockNumber: hex(number), transactionIndex: "0x0", status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", logs: [] },
    block: { hash: blockHash, parentHash: hash(BigInt(number) - 1n), number: hex(number), timestamp: hex(1000n + BigInt(number)), miner: COINBASE, transactions: [txHash] },
  };
}

test("qualification continues beyond the first eight and malformed chain IDs fail per-provider", async () => {
  const pool = Array.from({ length: 10 }, (_, index) => provider(index));
  const budget = {
    async call(row, method, params) {
      const index = Number(row.url.slice(5));
      if (method === "eth_chainId") return index < 8 ? "malformed" : "0x1";
      if (method === "eth_getLogs") return [];
      if (method === "eth_getBlockByNumber") {
        const requested = params[0];
        const tip = index === 8 ? 120n : 118n;
        const number = requested === "finalized" ? tip : BigInt(requested);
        return { number: hex(number), hash: hash(number), timestamp: hex(1000n + number), transactions: [hash(9000)] };
      }
      const objects = qualificationObjects(118, hash(9000));
      if (method === "eth_getTransactionByHash") return objects.transaction;
      if (method === "eth_getTransactionReceipt") return objects.receipt;
      if (method === "eth_getBlockByHash") return objects.block;
      throw new Error("unexpected-mock-method");
    },
  };
  const selected = await selectAgreedProviders(pool, budget);
  assert.deepEqual(selected.selected.map((row) => row.provider.ordinal), ["provider-09", "provider-10"]);
  assert.equal(selected.commonFinalized.number, "118");
  assert.equal(selected.publicQualifications.filter((row) => row.capabilities.chain1).length, 2);
  assert.equal(selected.selected.every((row) => row.capabilities.transaction && row.capabilities.receipt && row.capabilities.blockByHash), true);
});

test("declared provider groups collapse aliases and Ethereum/auth filtering occurs before caps", () => {
  const nonEthereum = Array.from({ length: 70 }, (_, index) => `https://noneth-${index}.invalid`).join("\n");
  const text = `## Base\n${nonEthereum}\n## Ethereum\n### Service Alpha\nhttps://alias-a.invalid\nhttps://alias-b.invalid\n### Service Beta\nhttps://independent.invalid\n### Service Gamma\nhttps://unsupported.invalid auth-required`;
  const entries = parseInventoryText(text);
  const pool = buildEthereumCandidatePool(entries, 3);
  assert.equal(pool.length, 3);
  assert.notEqual(pool[0].family, pool[1].family);
  assert.equal(pool[0].family, pool[2].family);
  assert.equal(pool.some((row) => row.url.includes("unsupported")), false);
});

test("section Origin metadata remains process-only, inherits narrowly, and reaches transport", async (t) => {
  const origin = "https://opaque-origin.invalid";
  const parsed = parseInventoryText(`## Provider Alpha\norigin: ${origin}\n### Ethereum\nhttps://rpc-one.invalid/path/token\n#### Archive\nhttps://rpc-two.invalid/path/key\n## Public Category\n### Ethereum\nhttps://public.invalid`);
  assert.equal(parsed.length, 3);
  assert.deepEqual(processOnlyHeaders(parsed[0]), { Origin: origin });
  assert.deepEqual(processOnlyHeaders(parsed[1]), { Origin: origin });
  assert.equal(processOnlyHeaders(parsed[2]), null);
  const pool = buildEthereumCandidatePool(parsed, 3);
  assert.deepEqual(processOnlyHeaders(pool[0]), { Origin: origin });
  assert.doesNotMatch(JSON.stringify(parsed), /opaque-origin|\bOrigin\b/i);
  assert.doesNotMatch(JSON.stringify(pool), /opaque-origin|\bOrigin\b/i);
  assert.doesNotThrow(() => leakScan({ ordinal: pool[0].ordinal, capabilities: { chain1: true } }));

  const originalFetch = global.fetch; let receivedHeaders = null;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (_location, options) => { receivedHeaders = options.headers; return { ok: true, body: null }; };
  const response = await fetchTransport({ provider: pool[0], method: "eth_chainId", params: [], id: 1, signal: null, abort: () => {}, consume: async () => Buffer.from('{"jsonrpc":"2.0","id":1,"result":"0x1"}') });
  assert.equal(response.result, "0x1");
  assert.deepEqual(receivedHeaders, { "content-type": "application/json", Origin: origin });
});

test("required transaction capabilities replace a failing family with a bounded backup", async () => {
  const pool = [provider(0), provider(1), provider(2)];
  const txHash = hash(9100);
  const budget = {
    async call(row, method, params) {
      const index = Number(row.url.slice(5));
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getLogs") return [];
      if (method === "eth_getBlockByNumber") {
        const number = params[0] === "finalized" ? 120n : BigInt(params[0]);
        return { number: hex(number), hash: hash(number), timestamp: hex(1000n + number), transactions: [txHash] };
      }
      if (method === "eth_getTransactionByHash" && index === 1) return null;
      const objects = qualificationObjects(120, txHash);
      if (method === "eth_getTransactionByHash") return objects.transaction;
      if (method === "eth_getTransactionReceipt") return objects.receipt;
      if (method === "eth_getBlockByHash") return objects.block;
      throw new Error("unexpected-mock-method");
    },
  };
  const selected = await selectAgreedProviders(pool, budget);
  assert.deepEqual(selected.selected.map((row) => row.provider.ordinal), ["provider-01", "provider-03"]);
  const failed = selected.publicQualifications.find((row) => row.ordinal === "provider-02");
  assert.equal(failed.capabilities.transaction, false);
});

test("window uses common finalized height and validates start plus predecessor on both providers", async () => {
  const selected = [provider(0), provider(1)].map((row) => ({ provider: row }));
  const finalized = { number: "60580", hash: hash(60580), timestamp: "1604800" };
  const budget = {
    async call(_row, method, params) {
      assert.equal(method, "eth_getBlockByNumber");
      const number = BigInt(params[0]);
      return { number: hex(number), hash: hash(number), timestamp: hex(999000n + 10n * number) };
    },
  };
  const window = await establishWindow(selected, finalized, budget);
  assert.equal(window.start.number, "100");
  assert.equal(window.start.timestamp, "1000000");
  assert.equal(window.predecessorBoundary.number, "99");
  assert.equal(window.predecessorBoundary.beforeTarget, true);
});

test("response helper cancels and aborts declared, streamed, and total-byte size failures", async () => {
  let declaredCancelled = 0; let declaredAborted = 0;
  const declared = { headers: { get: () => "11" }, body: { cancel: async () => { declaredCancelled += 1; } } };
  await assert.rejects(() => consumeResponseBody(declared, { perResponseBytes: 10, reserve: () => {}, abort: () => { declaredAborted += 1; } }), /response-budget-exceeded/);
  assert.deepEqual([declaredCancelled, declaredAborted], [1, 1]);

  let streamedCancelled = 0; let streamedAborted = 0; let read = 0;
  const streamed = { headers: { get: () => null }, body: { getReader: () => ({ read: async () => read++ === 0 ? { done: false, value: Buffer.alloc(11) } : { done: true }, cancel: async () => { streamedCancelled += 1; } }) } };
  await assert.rejects(() => consumeResponseBody(streamed, { perResponseBytes: 10, reserve: () => {}, abort: () => { streamedAborted += 1; } }), /response-budget-exceeded/);
  assert.deepEqual([streamedCancelled, streamedAborted], [1, 1]);

  let totalCancelled = 0; let totalAborted = 0;
  const total = { headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: false, value: Buffer.alloc(6) }), cancel: async () => { totalCancelled += 1; } }) } };
  await assert.rejects(() => consumeResponseBody(total, { perResponseBytes: 10, reserve: () => { throw new Error("response-budget-exceeded"); }, abort: () => { totalAborted += 1; } }), /response-budget-exceeded/);
  assert.deepEqual([totalCancelled, totalAborted], [1, 1]);
});

function validDiscoveryLog(source, number, index = 0) {
  return {
    address: source.address,
    topics: [source.topic],
    removed: false,
    blockNumber: hex(number),
    blockHash: hash(1000 + number),
    transactionHash: hash(2000 + number),
    transactionIndex: "0x1",
    logIndex: hex(index),
  };
}

test("adaptive log splitting reaches minimum chunks and respects request budget", async () => {
  const source = LOG_REGISTRY[0];
  const budget = {
    logRequests: 0,
    requests: 0,
    limits: { logRequests: 8, requests: 8 },
    async call(_provider, _method, params) {
      this.logRequests += 1; this.requests += 1;
      const from = BigInt(params[0].fromBlock); const to = BigInt(params[0].toBlock);
      if (to - from + 1n > 2n) throw new Error("provider-rpc-failure");
      return [validDiscoveryLog(source, Number(from))];
    },
  };
  const result = await adaptiveLogRange(provider(0), source, { from: 1n, to: 8n }, budget, { minimumChunkBlocks: 2, rangeQuota: 1 });
  assert.equal(result.covered.length, 4);
  assert.equal(result.uncovered.length, 0);
  assert.equal(result.events.length, 4);
  assert.equal(budget.requests, 7);

  const capped = { ...budget, logRequests: 0, requests: 0, limits: { logRequests: 2, requests: 2 } };
  const limited = await adaptiveLogRange(provider(0), source, { from: 1n, to: 8n }, capped, { minimumChunkBlocks: 2, rangeQuota: 1 });
  assert.ok(limited.uncovered.length > 0);
  assert.ok(capped.requests <= 2);
});

test("discovered logs reject wrong source, topic, range, and removed state", () => {
  const source = LOG_REGISTRY[0];
  const good = validDiscoveryLog(source, 5);
  assert.equal(validateDiscoveredLog(good, source, { from: 1n, to: 10n }).returnedBlockNumber, "5");
  assert.throws(() => validateDiscoveredLog({ ...good, removed: true }, source, { from: 1n, to: 10n }), /invalid-discovered/);
  assert.throws(() => validateDiscoveredLog({ ...good, address: OTHER }, source, { from: 1n, to: 10n }), /invalid-discovered/);
  assert.throws(() => validateDiscoveredLog({ ...good, topics: [LOG_REGISTRY[6].topic] }, source, { from: 1n, to: 10n }), /invalid-discovered/);
  assert.throws(() => validateDiscoveredLog({ ...good, blockNumber: "0x20" }, source, { from: 1n, to: 10n }), /invalid-discovered/);
});

test("one malformed log taints its entire response and excludes sampled coverage", async () => {
  const source = LOG_REGISTRY[0];
  const budget = {
    logRequests: 0, requests: 0, limits: { logRequests: 1, requests: 1 },
    async call() {
      this.logRequests += 1; this.requests += 1;
      return [validDiscoveryLog(source, 5), { ...validDiscoveryLog(source, 5, 1), topics: [LOG_REGISTRY[6].topic] }];
    },
  };
  const result = await adaptiveLogRange(provider(0), source, { from: 5n, to: 5n }, budget, { minimumChunkBlocks: 1, rangeQuota: 4 });
  assert.equal(result.covered.length, 0);
  assert.equal(result.events.length, 0);
  assert.deepEqual(result.uncovered, [{ fromBlock: "5", toBlock: "5", reason: "tainted-log-response" }]);
});

test("full discovery provenance binds to the exact receipt log and mismatches fail closed", () => {
  const source = LOG_REGISTRY[0];
  const rawLog = validDiscoveryLog(source, 5);
  const provenance = [{ ...validateDiscoveredLog(rawLog, source, { from: 1n, to: 10n }), discoveryProvider: "provider-01", status: "DISCOVERED_SINGLE_PROVIDER" }];
  const bound = bindDiscoveryProvenance(provenance, { logs: [rawLog] });
  assert.equal(bound[0].status, "VERIFIED_RECEIPT_LOG");
  assert.equal(bound[0].sourceAddress, source.address);
  assert.equal(bound[0].sourceTopic, source.topic);
  assert.equal(bound[0].requestedFromBlock, "1");
  assert.throws(() => bindDiscoveryProvenance(provenance, { logs: [{ ...rawLog, topics: [LOG_REGISTRY[6].topic] }] }), /provenance-receipt-mismatch/);
  const seed = bindDiscoveryProvenance([{ acquisition: "local-seed", status: "UNVERIFIED_SEED", transactionHash: hash(1) }], { logs: [] });
  assert.equal(seed[0].status, "UNVERIFIED_SEED");
  assert.equal(seed[0].receiptRetrieved, true);
});

test("mocked two-provider candidate projection rejects discovery provenance absent from receipt", async () => {
  const source = LOG_REGISTRY[0];
  const raw = candidateRaw();
  const indexedAddress = (value) => `0x${"0".repeat(24)}${value.slice(2)}`;
  const word = (value) => BigInt(value).toString(16).padStart(64, "0");
  const receiptLog = {
    address: source.address, topics: [source.topic, indexedAddress(USDC), indexedAddress(WETH), indexedAddress(ACTOR)], data: `0x${word(1)}${word(2)}${"0".repeat(24)}${OTHER.slice(2)}${word(0)}`, removed: false,
    blockHash: raw.block.hash, blockNumber: raw.block.number,
    transactionHash: raw.transaction.hash, transactionIndex: raw.transaction.transactionIndex, logIndex: "0x0",
  };
  raw.receipt.logs = [receiptLog];
  const selected = [provider(0), provider(1)].map((row) => ({ provider: row }));
  const budget = {
    async call(_provider, method) {
      if (method === "eth_getTransactionByHash") return structuredClone(raw.transaction);
      if (method === "eth_getTransactionReceipt") return structuredClone(raw.receipt);
      if (method === "eth_getBlockByHash") return structuredClone(raw.block);
      throw new Error("unexpected-mock-method");
    },
  };
  const provenance = [{
    sourceClass: source.class, sourceProtocol: source.protocol, sourceEvent: source.event,
    sourceAddress: source.address, sourceTopic: source.topic, returnedBlockHash: raw.block.hash,
    returnedBlockNumber: "100", transactionHash: raw.transaction.hash, transactionIndex: "2", logIndex: "0",
    requestedFromBlock: "90", requestedToBlock: "110", discoveryProvider: "provider-01", status: "DISCOVERED_SINGLE_PROVIDER",
  }];
  const accepted = await corroborateCandidates(selected, [{ hash: raw.transaction.hash, provenance }], WINDOW, budget, false);
  assert.equal(accepted.rows.length, 1);
  assert.equal(accepted.rows[0].acquisitionProvenance[0].status, "VERIFIED_RECEIPT_LOG");
  const wrong = structuredClone(provenance); wrong[0].sourceTopic = LOG_REGISTRY[6].topic;
  const rejected = await corroborateCandidates(selected, [{ hash: raw.transaction.hash, provenance: wrong }], WINDOW, budget, false);
  assert.deepEqual(rejected.rejected, [{ transactionHash: raw.transaction.hash, reason: "discovery-provenance-receipt-mismatch" }]);
});

function sanitizableLog(source) {
  const indexedAddress = (value) => `0x${"0".repeat(24)}${value.slice(2)}`;
  const word = (value) => BigInt(value).toString(16).padStart(64, "0");
  return { ...validDiscoveryLog(source, 5), topics: [source.topic, indexedAddress(USDC), indexedAddress(WETH), indexedAddress(ACTOR)], data: `0x${word(1)}${word(2)}${"0".repeat(24)}${OTHER.slice(2)}${word(0)}`, transactionIndex: "0x1" };
}

test("event recognition keys on emitting address and topic, separating Aave from Spark", () => {
  const aave = LOG_REGISTRY.find((row) => row.protocol === "aave-v3");
  const spark = LOG_REGISTRY.find((row) => row.protocol === "spark");
  assert.equal(sanitizeLog(sanitizableLog(aave)).recognized.protocol, "aave-v3");
  assert.equal(sanitizeLog(sanitizableLog(spark)).recognized.protocol, "spark");
  assert.equal(sanitizeLog({ ...sanitizableLog(aave), address: OTHER }).recognized, null);
});

test("typed Uniswap v3 facts preserve signed amounts and reject non-canonical widths", () => {
  const source = LOG_REGISTRY.find((row) => row.protocol === "uniswap-v3");
  const indexedAddress = (value) => `0x${"0".repeat(24)}${value.slice(2)}`;
  const word = (value) => (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, "0");
  const base = { ...validDiscoveryLog(source, 5), topics: [source.topic, indexedAddress(ACTOR), indexedAddress(OTHER)], transactionIndex: "0x1" };
  const decoded = sanitizeLog({ ...base, data: `0x${word(-5n)}${word(7n)}${word(123n)}${word(456n)}${word(-1n)}` });
  assert.equal(decoded.eventFacts.amount0, "-5");
  assert.equal(decoded.eventFacts.amount1, "7");
  assert.equal(decoded.eventFacts.tick, "-1");
  assert.throws(() => sanitizeLog({ ...base, data: `0x${word(1n)}${word(1n)}${word(1n << 160n)}${word(1n)}${word(0n)}` }), /swap-width/);
});

test("typed Morpho Liquidate facts preserve repay, seize, and bad-debt amounts", () => {
  const source = LOG_REGISTRY.find((row) => row.protocol === "morpho-blue");
  const indexedAddress = (value) => `0x${"0".repeat(24)}${value.slice(2)}`;
  const word = (value) => BigInt(value).toString(16).padStart(64, "0");
  const log = sanitizeLog({ ...validDiscoveryLog(source, 5), topics: [source.topic, hash(99), indexedAddress(ACTOR), indexedAddress(OTHER)], data: `0x${word(20)}${word(9)}${word(10)}${word(2)}${word(3)}`, transactionIndex: "0x1" });
  assert.deepEqual(log.eventFacts, { kind: "morpho-blue-liquidate", marketId: hash(99), caller: ACTOR, borrower: OTHER, repaidAssets: "20", repaidShares: "9", seizedAssets: "10", badDebtAssets: "2", badDebtShares: "3" });
});

function candidateRaw(overrides = {}) {
  const txHash = hash(11); const blockHash = hash(22);
  const transaction = { hash: txHash, blockHash, blockNumber: "0x64", transactionIndex: "0x2", from: ACTOR, to: OTHER, value: "0x0", type: "0x2", input: "0x1234", nonce: "0x1", gas: "0x5208" };
  const receipt = { transactionHash: txHash, blockHash, blockNumber: "0x64", transactionIndex: "0x2", status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", logs: [] };
  const block = { hash: blockHash, parentHash: hash(21), number: "0x64", timestamp: "0x3e8", miner: COINBASE };
  return { transaction: { ...transaction, ...overrides.transaction }, receipt: { ...receipt, ...overrides.receipt }, block: { ...block, ...overrides.block } };
}

const WINDOW = { start: { number: "90", timestamp: "900" }, finalized: { number: "110", timestamp: "1100" } };

test("candidate validation rejects inconsistent and out-of-window transaction objects", () => {
  const raw = candidateRaw();
  assert.equal(validateCandidateView(raw, hash(11), WINDOW), true);
  assert.throws(() => validateCandidateView(candidateRaw({ receipt: { transactionHash: hash(12) } }), hash(11), WINDOW), /hash-mismatch/);
  assert.throws(() => validateCandidateView(candidateRaw({ receipt: { transactionIndex: "0x3" } }), hash(11), WINDOW), /consensus-field-mismatch/);
  assert.throws(() => validateCandidateView(candidateRaw({ block: { timestamp: "0x7d0" } }), hash(11), WINDOW), /outside-immutable-window/);
  const badLog = { address: USDC, topics: [], data: "0x", removed: true, blockHash: hash(22), blockNumber: "0x64", transactionHash: hash(11), transactionIndex: "0x2", logIndex: "0x0" };
  assert.throws(() => validateCandidateView(candidateRaw({ receipt: { logs: [badLog] } }), hash(11), WINDOW), /log-consensus/);
});

test("corroboration compares explicit consensus fields and ignores provider extensions", () => {
  const first = candidateRaw(); const second = candidateRaw();
  first.transaction.providerExtension = "one"; second.transaction.providerExtension = "two";
  assert.equal(equalConsensusFields(first, second), true);
  second.receipt.gasUsed = "0x1";
  assert.equal(equalConsensusFields(first, second), false);
});

function completeCoverage() {
  return { clusterComplete: true, tokenStateComplete: true, nativeFlowsComplete: true, nativeStateComplete: true, liabilitiesComplete: true, fundingSourcesComplete: true };
}

test("ledger is non-vacuous, keeps WETH separate, and includes top-level transaction value", () => {
  const vacuous = buildLedger({ actor: ACTOR, cluster: { addresses: [ACTOR], controlEvidence: [{ kind: "fixture" }] }, coverage: completeCoverage(), blockFeeRecipient: COINBASE });
  assert.equal(vacuous.reconciliationComplete, false);

  const txValue = buildLedger({ actor: ACTOR, transaction: { from: ACTOR, to: OTHER, valueWei: "9" }, receipt: { status: "1", gasUsed: "0", effectiveGasPrice: "0" }, stateDiffs: [{ asset: "native", address: ACTOR, before: "9", after: "0" }], cluster: { addresses: [ACTOR], controlEvidence: [{ kind: "fixture" }] }, coverage: completeCoverage(), blockFeeRecipient: COINBASE });
  assert.deepEqual(txValue.assetDeltas, [{ asset: "native", rawDelta: "-9" }]);
  assert.equal(txValue.reconciliationComplete, true);
  const failedValue = buildLedger({ actor: ACTOR, transaction: { from: ACTOR, to: OTHER, valueWei: "9" }, receipt: { status: "0", gasUsed: "1", effectiveGasPrice: "1" }, blockFeeRecipient: COINBASE });
  assert.deepEqual(failedValue.assetDeltas, []);

  const mismatchedUnwrap = buildLedger({ actor: ACTOR, nativeFlows: [{ from: WETH, to: ACTOR, amountWei: "9" }], wethEvents: [{ kind: "withdrawal", account: ACTOR, amount: "10" }], cluster: { addresses: [ACTOR], controlEvidence: [{ kind: "fixture" }] }, coverage: completeCoverage(), blockFeeRecipient: COINBASE });
  assert.equal(mismatchedUnwrap.wethNativeReconciliation.complete, false);
  assert.equal(mismatchedUnwrap.reconciliationComplete, false);
});

function economicInput(ledger) {
  return {
    ledger,
    candidateBlockNumber: "100",
    assets: { native: { historicalDecimals: 18, decimalsSourceBlock: "100", price: { exact: true, sourceBlock: "100", usdMicrosPerWhole: "2000000000", nativeWeiPerWhole: "1000000000000000000" } } },
    receipt: { gasUsed: "21000", effectiveGasPrice: "1" },
    haircuts: Object.fromEntries(["slippage", "unwind", "financing", "latency", "competition", "uncertainty"].map((key) => [key, { usdMicros: "0", nativeWei: "0" }])),
    capital: { ownUsdMicros: "0", borrowedUsdMicros: "0", peakUsdMicros: "1", ownNativeWei: "0", borrowedNativeWei: "0", peakNativeWei: "1" },
    gates: { source: true, reachability: true, reproducibility: true, publicActor: true },
  };
}

test("economics rejects missing gas, wrong metadata block, and unproved inbound funding", () => {
  const ledger = { reconciliationComplete: true, nativeFlowVsStateDiff: { complete: true, gasAddedBackWei: "21000" }, assetDeltas: [], inboundFundingObserved: false, fundingAndLiabilityCoverageComplete: true };
  const missingGas = economicInput(ledger); delete missingGas.receipt.effectiveGasPrice;
  assert.equal(calculateEconomics(missingGas).reason, "gas-unbounded");
  const wrongBlock = economicInput(ledger); wrongBlock.assets.native.price.sourceBlock = "99";
  assert.equal(calculateEconomics(wrongBlock).reason, "gas-price-conversion-unbounded");
  const funding = economicInput({ ...ledger, inboundFundingObserved: true, fundingAndLiabilityCoverageComplete: false });
  assert.equal(calculateEconomics(funding).reason, "inbound-funding-source-or-liability-unbounded");
});

test("trace normalization bounds depth/nodes and never emits provider-controlled type strings", () => {
  const root = { type: "CALL" }; let cursor = root;
  for (let index = 0; index < 30; index += 1) { cursor.calls = [{ type: index === 2 ? "SECRET ARBITRARY VALUE" : "DELEGATECALL" }]; cursor = cursor.calls[0]; }
  const normalized = normalizeCallTrace(root, { traceNodeLimit: 10, traceDepthLimit: 5 });
  assert.equal(normalized.truncated, true);
  assert.ok(normalized.calls <= 10);
  assert.equal(normalized.callTypes.OTHER, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.callTypes, "SECRET ARBITRARY VALUE"), false);
});

test("trace normalization projects bounded native transfers and explicit fee-recipient payments", () => {
  const normalized = normalizeCallTrace({ type: "CALL", from: ACTOR, to: OTHER, value: "0x5", calls: [{ type: "CALL", from: OTHER, to: COINBASE, value: "0x7" }] }, { traceNodeLimit: 10, traceDepthLimit: 5, traceProjectionLimit: 10 }, COINBASE);
  assert.equal(normalized.economicProjectionComplete, true);
  assert.deepEqual(normalized.nativeTransfers.map((row) => row.amountWei), ["7"]);
  assert.deepEqual(normalized.proposerPayments, [{ from: OTHER, to: COINBASE, amountWei: "7", kind: "direct-fee-recipient", pbsEstablished: false }]);

  const capped = normalizeCallTrace({ type: "CALL", from: ACTOR, to: OTHER, value: "0x1", calls: [{ type: "CALL", from: ACTOR, to: OTHER, value: "0x2" }, { type: "CALL", from: ACTOR, to: OTHER, value: "0x3" }] }, { traceNodeLimit: 10, traceDepthLimit: 5, traceProjectionLimit: 1 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.economicProjectionComplete, false);
  assert.equal(capped.nativeTransfers.length, 1);
});

test("bound call traces exclude nonpersistent and reverted frames and never double-count root value", () => {
  const binding = { from: ACTOR, to: OTHER, valueWei: "5", receiptStatus: "1" };
  const trace = { type: "CALL", from: ACTOR, to: OTHER, value: "0x5", calls: [
    { type: "CALL", from: ACTOR, to: OTHER, value: "0x1" },
    { type: "DELEGATECALL", from: ACTOR, to: OTHER, value: "0x2" },
    { type: "CALLCODE", from: ACTOR, to: OTHER, value: "0x3" },
    { type: "STATICCALL", from: ACTOR, to: OTHER, value: "0x4" },
    { type: "CREATE", from: ACTOR, to: COINBASE, value: "0x8" },
    { type: "CREATE2", from: ACTOR, to: OTHER, value: "0x9" },
    { type: "CALL", from: ACTOR, to: OTHER, value: "0x5", error: "execution reverted", calls: [{ type: "CALL", from: ACTOR, to: OTHER, value: "0x6" }] },
  ] };
  const normalized = normalizeCallTrace(trace, { traceNodeLimit: 20, traceDepthLimit: 10, traceProjectionLimit: 20 }, COINBASE, binding);
  assert.equal(normalized.rootBindingComplete, true);
  assert.deepEqual(normalized.nativeTransfers.map((row) => row.amountWei), ["1", "8", "9"]);
  assert.equal(normalized.nativeTransfers.some((row) => row.amountWei === "5"), false);
  assert.equal(normalizeCallTrace({ ...trace, error: "reverted" }, { traceNodeLimit: 20, traceDepthLimit: 10, traceProjectionLimit: 20 }, COINBASE, binding).economicProjectionComplete, false);
  assert.equal(normalizeCallTrace(trace, { traceNodeLimit: 20, traceDepthLimit: 10, traceProjectionLimit: 20 }, COINBASE, { ...binding, to: COINBASE }).economicProjectionComplete, false);
  const failedReceipt = normalizeCallTrace(trace, { traceNodeLimit: 20, traceDepthLimit: 10, traceProjectionLimit: 20 }, COINBASE, { ...binding, receiptStatus: "0" });
  assert.equal(failedReceipt.economicProjectionComplete, false);
  assert.deepEqual(failedReceipt.nativeTransfers, []);
  assert.equal(normalizeCallTrace(null, { traceNodeLimit: 20, traceDepthLimit: 10, traceProjectionLimit: 20 }, COINBASE, binding).economicProjectionComplete, false);
  assert.equal(normalizeCallTrace({ ...trace, calls: {} }, { traceNodeLimit: 20, traceDepthLimit: 10, traceProjectionLimit: 20 }, COINBASE, binding).economicProjectionComplete, false);
  assert.equal(normalizeCallTrace({ ...trace, calls: [null] }, { traceNodeLimit: 20, traceDepthLimit: 10, traceProjectionLimit: 20 }, COINBASE, binding).economicProjectionComplete, false);
});

test("prestate normalization projects native balance deltas and fails completeness on malformed pairs", () => {
  const normalized = normalizePrestate({ pre: { [ACTOR]: { balance: "0x64" } }, post: { [ACTOR]: { balance: "0x5a" } } }, { traceNodeLimit: 10, traceProjectionLimit: 10 });
  assert.deepEqual(normalized.nativeBalanceDeltas, [{ address: ACTOR, before: "100", after: "90", deltaWei: "-10", created: false, deleted: false }]);
  assert.equal(normalized.economicProjectionComplete, true);
  const malformed = normalizePrestate({ pre: { [ACTOR]: { nonce: "0x1" } }, post: { [ACTOR]: { balance: "0x5a" } } }, { traceNodeLimit: 10, traceProjectionLimit: 10 });
  assert.equal(malformed.economicProjectionComplete, false);
});

test("prestate union handles proven creation/deletion and rejects missing diff schemas", () => {
  const created = "0x4000000000000000000000000000000000000004";
  const deleted = "0x5000000000000000000000000000000000000005";
  const normalized = normalizePrestate({ pre: { [deleted]: { balance: "0x9" } }, post: { [created]: { balance: "0x7" } } }, { traceNodeLimit: 10, traceProjectionLimit: 10 });
  assert.equal(normalized.economicProjectionComplete, true);
  assert.deepEqual(normalized.nativeBalanceDeltas, [
    { address: deleted, before: "9", after: "0", deltaWei: "-9", created: false, deleted: true },
    { address: created, before: "0", after: "7", deltaWei: "7", created: true, deleted: false },
  ]);
  assert.equal(normalizePrestate(null, { traceNodeLimit: 10, traceProjectionLimit: 10 }).economicProjectionComplete, false);
  assert.equal(normalizePrestate({ pre: {}, post: null }, { traceNodeLimit: 10, traceProjectionLimit: 10 }).economicProjectionComplete, false);
  assert.equal(normalizePrestate({ pre: { [deleted]: { balance: "0x9" } }, post: { [created]: { balance: "0x7" } } }, { traceNodeLimit: 1, traceProjectionLimit: 10 }).economicProjectionComplete, false);
});

test("native reconciliation adds exact execution and blob gas back once and blocks disagreement", () => {
  const input = {
    actor: ACTOR,
    cluster: { addresses: [ACTOR], controlEvidence: [{ kind: "fixture" }] },
    coverage: completeCoverage(),
    nativeFlows: [{ from: ACTOR, to: OTHER, amountWei: "4" }],
    stateDiffs: [{ asset: "native", address: ACTOR, before: "20", after: "0" }],
    receipt: { gasUsed: "2", effectiveGasPrice: "3", blobGasUsed: "2", blobGasPrice: "5" },
    blockFeeRecipient: COINBASE,
  };
  const ledger = buildLedger(input);
  assert.deepEqual(ledger.nativeFlowVsStateDiff, { flowDelta: "-4", stateDiffDelta: "-20", gasAddedBackWei: "16", agrees: true, complete: true, accountingModel: "economic-native-flows-excluding-gas;receipt-gas-deducted-once" });
  assert.equal(ledger.reconciliationComplete, true);
  const mismatch = buildLedger({ ...input, stateDiffs: [{ asset: "native", address: ACTOR, before: "21", after: "0" }] });
  assert.equal(mismatch.nativeFlowVsStateDiff.agrees, false);
  assert.equal(mismatch.reconciliationComplete, false);
});

test("Morpho and Aave liability bindings require unique exact transfers and reject user funding", () => {
  const morpho = LOG_REGISTRY.find((row) => row.protocol === "morpho-blue").address;
  const morphoCandidate = { receipt: { logs: [
    { address: morpho, logIndex: "1", recognized: { protocol: "morpho-blue", event: "Liquidate" }, eventFacts: { kind: "morpho-blue-liquidate", caller: ACTOR, borrower: OTHER, seizedAssets: "20", repaidShares: "9", repaidAssets: "10", badDebtShares: "2", badDebtAssets: "3" } },
    { logIndex: "2", transfer: { token: USDC, from: ACTOR, to: morpho, amount: "10" } },
    { logIndex: "3", transfer: { token: WETH, from: morpho, to: ACTOR, amount: "20" } },
  ] } };
  const morphoBound = bindProtocolLiabilities(morphoCandidate, [ACTOR]);
  assert.equal(morphoBound.complete, true);
  assert.deepEqual(morphoBound.badDebt, { shares: "2", assets: "3" });
  assert.equal(morphoBound.debt.token, USDC);
  const funded = structuredClone(morphoCandidate);
  funded.receipt.logs.push({ logIndex: "4", transfer: { token: USDC, from: OTHER, to: ACTOR, amount: "10" } });
  assert.equal(bindProtocolLiabilities(funded, [ACTOR]).complete, false);
  funded.receipt.logs.push({ logIndex: "5", transfer: { token: USDC, from: ACTOR, to: OTHER, amount: "11" } });
  funded.evidence = { flashLoans: [{ asset: USDC, lender: OTHER, principal: "10", premium: "1" }] };
  const flashBound = bindProtocolLiabilities(funded, [ACTOR]);
  assert.equal(flashBound.complete, true);
  assert.deepEqual(flashBound.recognizedFlashLoans[0].principal, "10");

  const aave = LOG_REGISTRY.find((row) => row.protocol === "aave-v3").address;
  const debtAToken = "0x6000000000000000000000000000000000000006";
  const collateralAToken = "0x7000000000000000000000000000000000000007";
  const aaveCandidate = { evidence: { aaveReserveBindings: { [USDC]: { aToken: debtAToken }, [WETH]: { aToken: collateralAToken } } }, receipt: { logs: [
    { address: aave, logIndex: "1", recognized: { protocol: "aave-v3", event: "LiquidationCall" }, eventFacts: { kind: "aave-liquidation-call", liquidator: ACTOR, user: OTHER, collateralAsset: WETH, debtAsset: USDC, debtToCover: "10", liquidatedCollateralAmount: "20", receiveAToken: false } },
    { logIndex: "2", transfer: { token: USDC, from: ACTOR, to: debtAToken, amount: "10" } },
    { logIndex: "3", transfer: { token: WETH, from: collateralAToken, to: ACTOR, amount: "20" } },
  ] } };
  assert.equal(bindProtocolLiabilities(aaveCandidate, [ACTOR]).complete, true);
  const noReserveLookup = structuredClone(aaveCandidate); delete noReserveLookup.evidence;
  assert.equal(bindProtocolLiabilities(noReserveLookup, [ACTOR]).reason, "aave-reserve-atoken-counterparties-unproven");
  const unrelatedPool = structuredClone(aaveCandidate); unrelatedPool.receipt.logs[1].transfer.to = aave;
  assert.equal(bindProtocolLiabilities(unrelatedPool, [ACTOR]).complete, false);
  aaveCandidate.receipt.logs[0].eventFacts.receiveAToken = true;
  aaveCandidate.receipt.logs[2].transfer = { token: collateralAToken, from: OTHER, to: ACTOR, amount: "20" };
  assert.equal(bindProtocolLiabilities(aaveCandidate, [ACTOR]).complete, true);
});

test("fork plan ranks explicit positive and stronger known evidence without numeric string coercion", () => {
  const base = { classification: { type: "arbitrage", verified: false }, ledger: { reconciliationComplete: false } };
  const strictLedger = { reconciliationComplete: true, nativeFlowVsStateDiff: { complete: true }, fundingAndLiabilityCoverageComplete: true, coverage: completeCoverage() };
  const gates = { source: true, reachability: true, reproducibility: true, publicActor: true };
  const plan = forkPlan([
    { ...base, transactionHash: hash(3), economics: { status: "UNKNOWN", routePositive: "unknown" } },
    { ...base, transactionHash: hash(2), classification: { type: "arbitrage", verified: true }, ledger: strictLedger, economics: { status: "KNOWN", routePositive: false, gates } },
    { ...base, transactionHash: hash(1), classification: { type: "arbitrage", verified: true }, ledger: strictLedger, economics: { status: "KNOWN", routePositive: true, gates } },
  ]);
  assert.deepEqual(plan.rows.map((row) => row.transactionHash), [hash(1), hash(2)]);
});

test("UNKNOWN fork candidates rank only by evidence completeness and are never promoted", () => {
  const weak = { transactionHash: hash(9), classification: { type: "pattern-only", verified: false }, ledger: { coverage: {}, reconciliationComplete: false, nativeFlowVsStateDiff: { complete: false }, wethNativeReconciliation: { evidencePresent: false, complete: false } }, protocolBinding: { complete: false }, economics: { status: "UNKNOWN", routePositive: "unknown" } };
  const strong = { ...structuredClone(weak), transactionHash: hash(8), classification: { type: "pattern-only", verified: true }, ledger: { coverage: { nativeFlowsComplete: true, nativeStateComplete: true }, reconciliationComplete: false, nativeFlowVsStateDiff: { complete: true }, wethNativeReconciliation: { evidencePresent: false, complete: false } } };
  const plan = forkPlan([weak, strong]);
  assert.deepEqual(plan.rows.map((row) => row.transactionHash), [hash(8), hash(9)]);
  assert.equal(plan.rows.some((row) => row.routePositive === true), false);
});

test("strict KNOWN ranking carries confidence, reproducibility, and liquidity before conservative net", () => {
  const strictLedger = { reconciliationComplete: true, nativeFlowVsStateDiff: { complete: true }, fundingAndLiabilityCoverageComplete: true, coverage: completeCoverage() };
  const row = (id, net, rankingEvidence) => ({ transactionHash: hash(id), classification: { type: "arbitrage", verified: true }, ledger: strictLedger, economics: { status: "KNOWN", routePositive: true, net: { usdMicros: net }, gates: { source: true, reachability: true, reproducibility: true, publicActor: true } }, rankingEvidence });
  const plan = forkPlan([row(1, "100", { confidence: 1, reproducibility: 1, liquidityCapacity: 1 }), row(2, "10", { confidence: 2, reproducibility: 1, liquidityCapacity: 1 })]);
  assert.deepEqual(plan.rows.map((item) => item.transactionHash), [hash(2), hash(1)]);
});

test("atomic visibility failure removes staging directory", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "event-sample-cleanup-"));
  const output = path.join(parent, "artifacts");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  assert.throws(() => atomicBundle(output, { "window.json": { sampleKind: "BOUNDED_EVENT_SAMPLE_V1" } }, { beforeRename: () => { throw new Error("injected-failure"); } }), /injected-failure/);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(parent), []);
});
