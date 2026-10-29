"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { TRANSFER_TOPIC } = require("../atomic/ethereum-top-trades-7d-reconstruction/constants");
const { argumentsOf, safeTerminalCode } = require("../atomic/ethereum-top-trades-7d-reconstruction/run");
const { atomicBundle, leakScan } = require("../atomic/ethereum-top-trades-7d-reconstruction/output");
const {
  DEEP_LIMITS,
  assertEndpointEnvironmentAbsent,
  assertSourceUnchanged,
  bindViewToSource,
  deepReconstruct,
  loadSelectedHashes,
  snapshotDirectory,
  verifySourceDirectory,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/deep-reconstruct");

const ACTOR = "0x1000000000000000000000000000000000000001";
const OTHER = "0x2000000000000000000000000000000000000002";
const COINBASE = "0x3000000000000000000000000000000000000003";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const HASH = `0x${"1".repeat(64)}`;
const BLOCK_HASH = `0x${"2".repeat(64)}`;
const PARENT_HASH = `0x${"3".repeat(64)}`;
const IMMUTABLE_SAMPLE = path.join(__dirname, "..", "..", "reports", "raw", "fast", "atomic-ethereum-top-trades-7d-reconstruction", "2026-08-25T18-58-46-001Z-f6be219e");

function sourceObjects() {
  const transaction = { hash: HASH, blockHash: BLOCK_HASH, blockNumber: "100", transactionIndex: "0", from: ACTOR, to: OTHER, valueWei: "0", type: "2" };
  const receipt = { transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: "100", transactionIndex: "0", status: "1", gasUsed: "1", effectiveGasPrice: "1", blobGasUsed: "0", blobGasPrice: "0", logs: [] };
  const block = { hash: BLOCK_HASH, parentHash: PARENT_HASH, number: "100", timestamp: "1000", feeRecipient: COINBASE };
  const window = { chainId: "1", immutable: true, start: { number: "90", hash: `0x${"4".repeat(64)}`, timestamp: "900" }, predecessorBoundary: { number: "89", hash: `0x${"6".repeat(64)}`, timestamp: "899" }, finalized: { number: "110", hash: `0x${"5".repeat(64)}`, timestamp: "1100" } };
  return { transaction, receipt, block, window, row: { transaction, receipt, block } };
}

function rawObjects() {
  const source = sourceObjects();
  return {
    transaction: { ...source.transaction, blockNumber: "0x64", transactionIndex: "0x0", value: "0x0", type: "0x2" },
    receipt: { ...source.receipt, blockNumber: "0x64", transactionIndex: "0x0", status: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", blobGasUsed: "0x0", blobGasPrice: "0x0" },
    block: { ...source.block, number: "0x64", timestamp: "0x3e8", miner: COINBASE },
  };
}

function makeSource(parent) {
  const directory = path.join(parent, "source");
  const source = sourceObjects();
  atomicBundle(directory, { "window.json": source.window, "candidates.json": { sampleKind: "BOUNDED_EVENT_SAMPLE_V1", rows: [source.row] } });
  const hashesFile = path.join(parent, "hashes.json");
  fs.writeFileSync(hashesFile, `${JSON.stringify({ hashes: [HASH] })}\n`);
  return { directory, hashesFile, source };
}

function mockInventory(count = 2) {
  return Array.from({ length: count }, (_, index) => ({ url: `http://localhost:${8545 + index}`, lineIndex: index + 1, ethereumHint: true, unsupportedMode: false, groupIdentity: Symbol(`group-${index}`), declaredGroup: true }));
}

function mockTransport(made, traceSupport = () => true, callProjection = () => ({ type: "CALL", from: ACTOR, to: OTHER, value: "0x0", calls: [] })) {
  const raw = rawObjects();
  const prestate = { pre: { [ACTOR]: { balance: "0x1" } }, post: { [ACTOR]: { balance: "0x0" } } };
  return async ({ provider, method, params }) => {
    let result;
    if (method === "eth_chainId") result = "0x1";
    else if (method === "eth_getBlockByNumber") {
      const number = BigInt(params[0]).toString();
      const boundary = [made.source.window.start, made.source.window.predecessorBoundary, made.source.window.finalized].find((row) => row.number === number);
      result = { number: `0x${BigInt(boundary.number).toString(16)}`, hash: boundary.hash, timestamp: `0x${BigInt(boundary.timestamp).toString(16)}` };
    } else if (method === "eth_getTransactionByHash") result = structuredClone(raw.transaction);
    else if (method === "eth_getTransactionReceipt") result = structuredClone(raw.receipt);
    else if (method === "eth_getBlockByHash") result = structuredClone(raw.block);
    else if (method === "debug_traceTransaction") {
      const tracer = params[1].tracer;
      if (!traceSupport(provider, tracer)) throw new Error("unsupported-trace");
      result = tracer === "callTracer" ? structuredClone(callProjection(provider)) : structuredClone(prestate);
    } else throw new Error("unexpected-method");
    return { result, bytes: Buffer.byteLength(JSON.stringify(result)) };
  };
}

test("deep CLI requires source anchoring and rejects mode/endpoint environment ambiguity", () => {
  assert.deepEqual(argumentsOf(["--deep-reconstruct", "--source-dir", "source", "--hashes-file", "hashes.json"]).mode, "deep");
  assert.throws(() => argumentsOf(["--deep-reconstruct", "--source-dir", "source"]), /requires-source-and-hashes/);
  assert.throws(() => argumentsOf(["--deep-reconstruct", "--source-dir", "source", "--hashes-file", "hashes.json", "--traces"]), /rejects-other-mode-options/);
  assert.throws(() => argumentsOf(["--deep-reconstruct", "--source-dir", "source", "--hashes-file", "hashes.json", "--rpc-url", "redacted"]), /unknown-cli-argument/);
  assert.throws(() => assertEndpointEnvironmentAbsent({ ETH_RPC_URL: "redacted" }), /rejects-endpoint-environment/);
  assert.doesNotThrow(() => assertEndpointEnvironmentAbsent({ PATH: "local" }));
  for (const code of ["required-trace-projections-unavailable", "two-independent-exact-providers-unavailable", "bounded-provider-pool-insufficient", "source-manifest-mismatch", "selected-hash-not-in-source"]) assert.equal(safeTerminalCode(new Error(code)), code);
  assert.equal(safeTerminalCode(new Error("provider said opaque internal material")), "collector-failed-closed");
});

test("source manifest mismatch, unselected/truncated hashes, and source-window violations fail closed", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deep-source-validation-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const made = makeSource(parent);
  const verified = verifySourceDirectory(made.directory);
  assert.equal(loadSelectedHashes(made.hashesFile, verified.candidates).length, 1);
  const badHashes = path.join(parent, "bad-hashes.json");
  fs.writeFileSync(badHashes, JSON.stringify([`0x${"9".repeat(64)}`]));
  assert.throws(() => loadSelectedHashes(badHashes, verified.candidates), /not-in-source/);
  fs.writeFileSync(badHashes, JSON.stringify(["0x1234"]));
  assert.throws(() => loadSelectedHashes(badHashes, verified.candidates), /truncated/);
  fs.writeFileSync(badHashes, JSON.stringify(Array.from({ length: 7 }, () => HASH)));
  assert.throws(() => loadSelectedHashes(badHashes, verified.candidates), /count-out-of-range/);

  const raw = rawObjects(); const outside = structuredClone(made.source.row); outside.block.number = "111"; outside.transaction.blockNumber = "111"; outside.receipt.blockNumber = "111";
  raw.block.number = "0x6f"; raw.transaction.blockNumber = "0x6f"; raw.receipt.blockNumber = "0x6f";
  assert.throws(() => bindViewToSource(raw, outside, made.source.window), /outside-source-window/);

  fs.appendFileSync(path.join(made.directory, "candidates.json"), " ");
  assert.throws(() => verifySourceDirectory(made.directory), /source-manifest-mismatch/);
});

test("source receipt-log binding includes position, removal state, and typed transfer facts", () => {
  const source = sourceObjects(); const raw = rawObjects();
  const padded = (value) => `0x${"0".repeat(24)}${value.slice(2)}`;
  const rawLog = { address: USDC, blockHash: BLOCK_HASH, blockNumber: "0x64", transactionHash: HASH, transactionIndex: "0x0", logIndex: "0x0", removed: false, topics: [TRANSFER_TOPIC, padded(ACTOR), padded(OTHER)], data: `0x${"5".padStart(64, "0")}` };
  raw.receipt.logs = [rawLog];
  source.row.receipt.logs = [{ address: USDC, blockHash: BLOCK_HASH, blockNumber: "100", transactionHash: HASH, transactionIndex: "0", logIndex: "0", removed: false, topics: rawLog.topics, recognized: null, eventFacts: null, wethEvent: null, transfer: { token: USDC, from: ACTOR, to: OTHER, amount: "5", logIndex: "0" } }];
  assert.doesNotThrow(() => bindViewToSource(raw, source.row, source.window));
  source.row.receipt.logs[0].transfer.amount = "6";
  assert.throws(() => bindViewToSource(raw, source.row, source.window), /receipt-log-mismatch/);
  source.row.receipt.logs[0].transfer.amount = "5"; source.row.receipt.logs[0].removed = true;
  assert.throws(() => bindViewToSource(raw, source.row, source.window), /receipt-log-mismatch/);
});

test("existing immutable 14-row sample manifest and every source byte remain unchanged", () => {
  const before = snapshotDirectory(IMMUTABLE_SAMPLE);
  const source = verifySourceDirectory(IMMUTABLE_SAMPLE);
  assert.equal(source.candidates.rows.length, 14);
  assert.doesNotThrow(() => assertSourceUnchanged(source));
  assert.deepEqual(snapshotDirectory(IMMUTABLE_SAMPLE), before);
});

test("source filename allowlist rejects secret-bearing and harmless unmanifested extras before hashing", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deep-source-filenames-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  for (const name of [".env", "wallet.json", "signer.pem", "notes.txt"]) {
    const lane = path.join(parent, name.replace(/[^a-z]/gi, "_") || "env");
    fs.mkdirSync(lane);
    const made = makeSource(lane);
    fs.writeFileSync(path.join(made.directory, name), "dummy");
    assert.throws(() => verifySourceDirectory(made.directory), /secret-bearing-filename|unmanifested-file/);
  }
});

test("bounded selected-hash deep reconstruction uses exact providers, preserves source bytes, and emits endpoint-free output", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deep-reconstruct-offline-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const made = makeSource(parent); const before = snapshotDirectory(made.directory);
  const result = await deepReconstruct({ sourceDirectory: made.directory, hashesFile: made.hashesFile, inventoryEntries: mockInventory(), transport: mockTransport(made), limits: { ...DEEP_LIMITS, candidatePool: 2, requests: 20 } });
  assert.deepEqual(snapshotDirectory(made.directory), before);
  assert.doesNotThrow(() => assertSourceUnchanged(result.source));
  assert.equal(result.bundle["runtime.json"].weeklyDiscovery, false);
  assert.equal(result.bundle["runtime.json"].budgets.requestsUsed, 18);
  assert.equal(result.bundle["runtime.json"].evidenceTier, "PARTIAL_CALL_TRACE_DEEP_RECONSTRUCTION_V1");
  assert.equal(result.bundle["source-binding.json"].evidenceTier, "PARTIAL_CALL_TRACE_DEEP_RECONSTRUCTION_V1");
  assert.equal(result.bundle["runtime.json"].providerQualification.callTraceCorroboration, "TWO_PROVIDER_MATCHED_CALL_PROJECTIONS");
  assert.equal(result.bundle["deep-candidates.json"].rows[0].trace.normalized.callTracer.rootBindingComplete, true);
  assert.equal(result.bundle["reconciled.json"].rows[0].economics.status, "UNKNOWN");
  assert.equal(result.bundle["reconciled.json"].rows[0].economics.routePositive, "unknown");
  assert.deepEqual(result.bundle["reconciled.json"].rows[0].rankingEvidence, { confidence: 2, reproducibility: 0, liquidityCapacity: 0 });
  assert.ok(result.bundle["reconciled.json"].rows[0].blockers.includes("historical-metadata-and-pricing-not-collected"));
  assert.deepEqual(result.bundle["fork-plan.json"].rows, []);
  assert.doesNotThrow(() => leakScan(result.bundle));
  const output = path.join(parent, "deep-output");
  atomicBundle(output, result.bundle);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")).endpointFree, true);
  assert.deepEqual(snapshotDirectory(made.directory), before);
});

test("call-only deep success remains UNKNOWN, records unavailable prestate, and has no fork promotion", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deep-trace-capability-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const made = makeSource(parent);
  const oneProvider = await deepReconstruct({ sourceDirectory: made.directory, hashesFile: made.hashesFile, inventoryEntries: mockInventory(), transport: mockTransport(made, (provider, tracer) => provider.ordinal === "provider-01" && tracer === "callTracer"), limits: { ...DEEP_LIMITS, candidatePool: 2, requests: 20 } });
  assert.equal(oneProvider.bundle["runtime.json"].providerQualification.callTraceCorroboration, "SINGLE_PROVIDER_CALL_PROJECTION");
  assert.equal(oneProvider.bundle["runtime.json"].providerQualification.traceProvider, "provider-01");
  assert.equal(oneProvider.bundle["deep-candidates.json"].rows[0].prestateProjection.complete, false);
  assert.equal(oneProvider.bundle["reconciled.json"].rows[0].ledger.coverage.nativeStateComplete, false);
  assert.equal(oneProvider.bundle["reconciled.json"].rows[0].ledger.nativeFlowVsStateDiff.complete, false);
  assert.equal(oneProvider.bundle["reconciled.json"].rows[0].economics.status, "UNKNOWN");
  assert.equal(oneProvider.bundle["reconciled.json"].rows[0].economics.routePositive, "unknown");
  assert.ok(oneProvider.bundle["reconciled.json"].rows[0].blockers.includes("prestate-projection-unavailable"));
  assert.deepEqual(oneProvider.bundle["fork-plan.json"].rows, []);
});

test("two call-only providers corroborate matching calls and mismatches fall back to a bounded provider", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deep-call-corroboration-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const made = makeSource(parent);
  const callOnly = (_provider, tracer) => tracer === "callTracer";
  const matched = await deepReconstruct({ sourceDirectory: made.directory, hashesFile: made.hashesFile, inventoryEntries: mockInventory(), transport: mockTransport(made, callOnly), limits: { ...DEEP_LIMITS, candidatePool: 2, requests: 20 } });
  assert.equal(matched.bundle["runtime.json"].providerQualification.callTraceCorroboration, "TWO_PROVIDER_MATCHED_CALL_PROJECTIONS");
  assert.equal(matched.bundle["runtime.json"].providerQualification.prestateCompleteEverySelectedHash, false);

  const variant = (provider) => ({ type: "CALL", from: ACTOR, to: OTHER, value: "0x0", calls: provider.ordinal === "provider-02" ? [{ type: "CALL", from: ACTOR, to: OTHER, value: "0x1" }] : [] });
  const fallback = await deepReconstruct({ sourceDirectory: made.directory, hashesFile: made.hashesFile, inventoryEntries: mockInventory(3), transport: mockTransport(made, callOnly, variant), limits: { ...DEEP_LIMITS, candidatePool: 3, requests: 40 } });
  assert.equal(fallback.bundle["runtime.json"].providerQualification.callTraceCorroboration, "TWO_PROVIDER_MATCHED_CALL_PROJECTIONS");
  assert.deepEqual(fallback.bundle["deep-candidates.json"].rows[0].sourceBinding.exactHistoricalProviders, ["provider-01", "provider-03"]);
});

test("deep reconstruction fails with the fixed code when no complete call projection exists", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deep-no-call-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const made = makeSource(parent);
  await assert.rejects(() => deepReconstruct({ sourceDirectory: made.directory, hashesFile: made.hashesFile, inventoryEntries: mockInventory(), transport: mockTransport(made, () => false), limits: { ...DEEP_LIMITS, candidatePool: 2, requests: 20 } }), /required-trace-projections-unavailable/);
});
