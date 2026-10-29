"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { atomicBundle, leakScan } = require("../atomic/ethereum-top-trades-7d-reconstruction/output");
const { RpcBudget } = require("../atomic/ethereum-top-trades-7d-reconstruction/collector");
const { sanitizeReceipt } = require("../atomic/ethereum-top-trades-7d-reconstruction/forensics");
const { argumentsOf, safeTerminalCode } = require("../atomic/ethereum-top-trades-7d-reconstruction/run");
const {
  APPROVED_TEMP,
  FORK_UPSTREAM_METHODS,
  RELAY_LIMITS,
  REPLAY_TIER,
  anvilLocalStateReplay,
  assertReplaySourceUnchanged,
  buildAnvilArgs,
  captureForkSnapshot,
  computeBalanceDeltas,
  createReadOnlyRelay,
  deriveReplayScope,
  localStateReplay,
  replayEconomics,
  sanitizedChildEnvironment,
  selectPrefixAnchor,
  selectTargetAnchor,
  validateMorphoSourceFacts,
  validateParentFallback,
  validateReplayRelayStats,
  verifyReplaySource,
  waitReady,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/local-state-replay");
const {
  BLOB_FEE_SCHEDULE,
  FAKE_EXPONENTIAL_ITERATION_CAP,
  FORGE_BUILD_TIMEOUT_MS,
  FORGE_EXECUTION_LIMITS,
  FORGE_HARNESS,
  FORGE_HARNESS_SHA256,
  FORGE_PARENT_QUALIFICATION_METHODS,
  FORGE_REPLAY_TIER,
  FORGE_RESULT_BYTES,
  FORGE_TEST_TIMEOUT_MS,
  MAX_EXCESS_BLOB_GAS,
  PINNED_ETHERS_VERSION,
  PINNED_FORGE_COMMIT,
  PINNED_FORGE_VERSION,
  assertForgeSourceBounds,
  assertPinnedEthersVersion,
  blobFeeSchedule,
  canonicalBlobBaseFee,
  canonicalType2Serialization,
  captureForgeReplay,
  cleanupRetainedForgeProject,
  corroborateForgePrestate,
  createForgeExecutionBudget,
  fakeExponential,
  fetchOptionalRawTransaction,
  forgeVersion,
  keccakRawTransaction,
  normalizedCanonicalView,
  parseForgeResult,
  qualifyForgeProvider,
  resolveForgeExecutable,
  selectForgeProviderPair,
  snapshotsFromForge,
  terminateForgeProcessTree,
  validateBlockContext,
  validateReplayLogs,
  validateSenderNonce,
  validateTraceSentinels,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/forge-state-replay");

const RAW_TRANSACTION = "0x02f86601070264825208942000000000000000000000000000000000000002808412345678c080a076abd2c100ee55697658c8b868bb5726fbf1e0981425cd6a3a82477500153cdca06db467168996588752db2f991f05c9c07aafb6ab418c09eaa3280fdd373e5aaa";
const HASH = "0x4e4ef9be1710249aab35e9190155a13a2bbbc99e3e711c8e485fd82479836c34";
const TARGET_TIMESTAMP = "1787000000";
const FORGE_VERSION_OUTPUT = "forge Version: 1.8.0-nightly\nCommit SHA: 879053163b1f82fd5ac381b68ad891ab2091e958\nBuild Profile: dist\n";
const PREVIOUS = `0x${"2".repeat(64)}`;
const BLOCK = `0x${"3".repeat(64)}`;
const PARENT = `0x${"4".repeat(64)}`;
const LOCAL_BLOCK = `0x${"5".repeat(64)}`;
const SENDER = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const EXECUTOR = "0x2000000000000000000000000000000000000002";
const FEE = "0x3000000000000000000000000000000000000003";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const COLLATERAL = "0x4000000000000000000000000000000000000004";

function candidate(index = "1") {
  return {
    transaction: { hash: HASH, blockHash: BLOCK, blockNumber: "100", transactionIndex: index, from: SENDER, to: EXECUTOR, valueWei: "0", type: "2" },
    receipt: { transactionHash: HASH, blockHash: BLOCK, blockNumber: "100", transactionIndex: index, status: "1", gasUsed: "10", effectiveGasPrice: "10", blobGasUsed: null, blobGasPrice: null, logs: [
      { address: USDC, blockHash: BLOCK, blockNumber: "100", transactionHash: HASH, transactionIndex: index, logIndex: "0", removed: false, topics: [], recognized: null, eventFacts: null, wethEvent: null, transfer: { token: USDC, from: SENDER, to: EXECUTOR, amount: "10", logIndex: "0" } },
      { address: EXECUTOR, blockHash: BLOCK, blockNumber: "100", transactionHash: HASH, transactionIndex: index, logIndex: "1", removed: false, topics: [], recognized: { protocol: "morpho-blue", event: "Liquidate", class: "liquidation" }, eventFacts: { kind: "morpho-blue-liquidate", caller: SENDER, borrower: FEE, repaidAssets: "10", repaidShares: "9", seizedAssets: "20", badDebtAssets: "0", badDebtShares: "0" }, wethEvent: null, transfer: null },
      { address: COLLATERAL, blockHash: BLOCK, blockNumber: "100", transactionHash: HASH, transactionIndex: index, logIndex: "2", removed: false, topics: [], recognized: null, eventFacts: null, wethEvent: null, transfer: { token: COLLATERAL, from: EXECUTOR, to: SENDER, amount: "20", logIndex: "2" } },
    ] },
    block: { hash: BLOCK, parentHash: PARENT, number: "100", timestamp: TARGET_TIMESTAMP, feeRecipient: FEE },
    trace: { normalized: { prestateTracer: { economicProjectionComplete: false, nativeBalanceDeltas: [{ address: SENDER, before: "1000", after: "900", deltaWei: "-100" }] } } },
  };
}

function forensicRow() {
  return { transactionHash: HASH, protocolBinding: { complete: true, protocol: "morpho-blue", event: "Liquidate", debt: { token: USDC, amount: "10", transferLogIndex: "0" }, collateral: { token: COLLATERAL, amount: "20", transferLogIndex: "2" } }, economics: { status: "UNKNOWN", routePositive: "unknown" } };
}

function makeDeepSource(parent) {
  const directory = path.join(parent, "deep-source"); const row = candidate();
  atomicBundle(directory, {
    "source-binding.json": { evidenceTier: "PARTIAL_CALL_TRACE_DEEP_RECONSTRUCTION_V1", chainId: "1", selectedHashes: [HASH], window: { start: { number: "90" }, predecessorBoundary: { number: "89" }, finalized: { number: "110" } } },
    "deep-candidates.json": { sampleKind: "PARTIAL_CALL_TRACE_DEEP_RECONSTRUCTION_V1", rows: [row] },
    "reconciled.json": { economicsCoverage: "PARTIAL_CALL_TRACE_DEEP_RECONSTRUCTION_V1", rows: [forensicRow()] },
    "runtime.json": { evidenceTier: "PARTIAL_CALL_TRACE_DEEP_RECONSTRUCTION_V1", signedActions: false, providerQualification: { independentDeclaredProviders: true, exactHistorical: { sourceBoundariesMatched: true, selectedTransactionsReceiptsBlocksMatched: true } } },
  });
  return directory;
}

test("local replay CLI requires one full source-bound hash and exposes fixed failure codes", () => {
  assert.equal(REPLAY_TIER, "LOCAL_FORK_STATE_DELTA_REPLAY_V2");
  const parsed = argumentsOf(["--local-state-replay", "--source-dir", "deep", "--hash", HASH]);
  assert.equal(parsed.mode, "local-replay");
  assert.throws(() => argumentsOf(["--local-state-replay", "--source-dir", "deep"]), /requires-source-and-hash/);
  assert.throws(() => argumentsOf(["--local-state-replay", "--source-dir", "deep", "--hash", HASH, "--traces"]), /rejects-other-mode-options/);
  assert.equal(safeTerminalCode(new Error("replay-archive-provider-unavailable")), "replay-archive-provider-unavailable");
  assert.equal(safeTerminalCode(new Error("local-anvil-forced-replay-timeout")), "local-anvil-forced-replay-timeout");
  const exited = new Error("local-anvil-exited"); exited.readinessStage = "CHILD_EXITED";
  assert.equal(safeTerminalCode(exited), "local-anvil-exited");
  assert.equal(safeTerminalCode(new Error("opaque upstream failure")), "collector-failed-closed");
});

test("shared minimal fork allowlist forwards only demonstrated startup/state methods", async (t) => {
  const forwarded = [];
  assert.deepEqual([...FORK_UPSTREAM_METHODS].sort(), ["eth_chainId", "eth_gasPrice", "eth_getBalance", "eth_getBlockByHash", "eth_getBlockByNumber", "eth_getBlockReceipts", "eth_getCode", "eth_getProof", "eth_getStorageAt", "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt"].sort());
  const relay = await createReadOnlyRelay({ forward: async (method) => { forwarded.push(method); if (method === "eth_getProof") throw new Error("opaque"); return method === "eth_chainId" ? "0x1" : null; }, limits: { requests: 40, timeoutMs: 5000 } });
  t.after(() => relay.close());
  const rpc = async (method) => (await (await fetch(`http://127.0.0.1:${relay.port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) })).json());
  for (const method of FORK_UPSTREAM_METHODS) await rpc(method);
  const rejected = ["eth_call", "eth_getLogs", "eth_feeHistory", "eth_maxPriorityFeePerGas", "eth_getBlockTransactionCountByHash", "eth_getTransactionByBlockHashAndIndex", "eth_getRawTransactionByHash", "eth_sendRawTransaction", "eth_sign", "eth_accounts", "personal_sign", "wallet_addEthereumChain", "debug_traceTransaction", "trace_replayTransaction", "engine_newPayloadV3", "admin_nodeInfo", "anvil_setBalance", "anvil_mine", "evm_mine", "evm_setIntervalMining", "miner_start", "txpool_status"];
  for (const method of rejected) assert.equal((await rpc(method)).error.message, "method-not-allowed");
  assert.deepEqual(forwarded, [...FORK_UPSTREAM_METHODS]);
  const relayStats = relay.stats();
  assert.equal(relayStats.rejectedSendCount, 1);
  assert.equal(relayStats.methodOutcomes.eth_gasPrice.allowedSuccess, 1);
  assert.equal(relayStats.methodOutcomes.eth_getProof.allowedUpstreamFailure, 1);
  assert.ok(relayStats.methodOutcomes.DENIED_READ.deniedRead > 0);
  assert.ok(relayStats.methodOutcomes.DENIED_MUTATION.deniedMutation > 0);
  assert.doesNotMatch(JSON.stringify(relayStats), /opaque|params|result|provider|error/i);
  const budgetRelay = await createReadOnlyRelay({ forward: async () => null, limits: { requests: 0, timeoutMs: 5000 } });
  t.after(() => budgetRelay.close());
  const budgetResponse = await (await fetch(`http://127.0.0.1:${budgetRelay.port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }) })).json();
  assert.equal(budgetResponse.error.message, "relay-budget-exhausted");
  assert.equal(budgetRelay.stats().methodOutcomes.eth_gasPrice.budgetRejected, 1);
  const budgetForwarded = [];
  const budget = new RpcBudget({ requests: 20, logRequests: 0, traceTransactions: 0, totalTimeoutMs: 10000, requestTimeoutMs: 1000, concurrency: 1, traceConcurrency: 1, responseBytes: 1000, totalResponseBytes: 10000 }, async ({ method }) => { budgetForwarded.push(method); return { result: "0x1", bytes: 3 }; }, FORK_UPSTREAM_METHODS);
  await budget.call({}, "eth_chainId", []);
  const accountBasicStateSequence = ["eth_getBalance", "eth_getTransactionCount", "eth_getCode", "eth_getStorageAt", "eth_getProof"];
  for (const method of accountBasicStateSequence) await budget.call({}, method, []);
  await assert.rejects(() => budget.call({}, "eth_call", []), /not-read-only-allowlisted/);
  assert.deepEqual(budgetForwarded, ["eth_chainId", ...accountBasicStateSequence]);
});

test("relay retains only capped, shape-checked denied read method names in process-local stats", async (t) => {
  const relay = await createReadOnlyRelay({ forward: async () => null, limits: { requests: 40, timeoutMs: 5000 } });
  t.after(() => relay.close());
  const rpc = async (method) => (await (await fetch(`http://127.0.0.1:${relay.port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: ["must-not-be-recorded"] }) })).json());
  const accepted = ["eth_denied0", "net_denied1", "web3_denied2", "eth_denied3", "eth_denied4", "eth_denied5", "eth_denied6", "eth_denied7", "eth_denied8"];
  for (const method of accepted) assert.equal((await rpc(method)).error.message, "method-not-allowed");
  for (const method of ["eth_bad-name", "eth_getBalance?api_key=secret", "https://secret.invalid", "web3_"]) assert.equal((await rpc(method)).error.message, "method-not-allowed");
  const stats = relay.stats();
  assert.equal(stats.deniedReadMethodNames.length, 8);
  assert.deepEqual(stats.deniedReadMethodNames.slice(0, 7), accepted.slice(0, 7));
  assert.equal(stats.deniedReadMethodNames[7], "OTHER");
  assert.equal(stats.deniedReadMethodNames.every((name) => name === "OTHER" || /^(?:eth|net|web3)_[A-Za-z0-9]{1,64}$/.test(name)), true);
  assert.doesNotMatch(JSON.stringify(stats), /api_key|secret|https:|must-not-be-recorded|bad-name/i);
});

test("relay retains only capped, shape-checked denied mutation method names in process-local stats", async (t) => {
  const relay = await createReadOnlyRelay({ forward: async () => null, limits: { requests: 40, timeoutMs: 5000 } });
  t.after(() => relay.close());
  const rpc = async (method) => (await (await fetch(`http://127.0.0.1:${relay.port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: ["must-not-be-recorded", { token: "secret" }] }) })).json());
  const valid = ["eth_send0", "eth_sign1", "evm_mutate2", "anvil_mutate3", "eth_send4", "eth_sign5", "evm_mutate6", "anvil_mutate7", "eth_send8"];
  for (const method of valid) assert.equal((await rpc(method)).error.message, "method-not-allowed");
  for (const method of ["personal_sign", "admin_nodeInfo", "eth_send-bad", "evm_bad?token=secret", "https://secret.invalid"]) assert.equal((await rpc(method)).error.message, "method-not-allowed");
  const stats = relay.stats();
  assert.equal(stats.deniedMutationMethodNames.length, 8);
  assert.deepEqual(stats.deniedMutationMethodNames.slice(0, 7), valid.slice(0, 7));
  assert.equal(stats.deniedMutationMethodNames[7], "OTHER");
  assert.equal(stats.deniedMutationMethodNames.every((name) => name === "OTHER" || /^(?:eth|net|web3|evm|anvil)_[A-Za-z0-9]{1,64}$/.test(name)), true);
  assert.equal(stats.methodOutcomes.DENIED_MUTATION.deniedMutation, valid.length + 4);
  assert.doesNotMatch(JSON.stringify(stats), /must-not-be-recorded|token|secret|https:|send-bad/i);
});

test("lazy relay lifetime excludes offline compile delay", async (t) => {
  let now = 0; let starts = 0; const relay = await createReadOnlyRelay({ lazyStart: true, now: () => now, onFirstRequest: () => { starts += 1; }, forward: async () => "0x1" }); t.after(() => relay.close());
  const rpc = async () => (await (await fetch(`http://127.0.0.1:${relay.port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })).json());
  now += 60 * 60 * 1000; assert.equal(starts, 0); assert.equal((await rpc()).result, "0x1"); assert.equal(starts, 1);
  now += 15 * 60 * 1000 + 1; assert.equal((await rpc()).error.message, "relay-budget-exhausted");
  assert.equal(starts, 1);
});

test("success relay validation permits only bounded known probes and no failures", () => {
  const empty = { requestsForwarded: 0, rejectedSendCount: 0, deniedReadMethodNames: [], deniedMutationMethodNames: [], methodOutcomes: {} };
  assert.deepEqual(validateReplayRelayStats(empty), { requestsForwarded: 0, rejectedSendCount: 0 });
  const known = { requestsForwarded: 1800, rejectedSendCount: 0, deniedReadMethodNames: ["eth_getAccountInfo"], deniedMutationMethodNames: ["anvil_nodeInfo"], methodOutcomes: { DENIED_READ: { deniedRead: 8 }, DENIED_MUTATION: { deniedMutation: 8 }, eth_chainId: { allowedSuccess: 1800 } } };
  assert.deepEqual(validateReplayRelayStats(known), { requestsForwarded: 1800, rejectedSendCount: 0 });
  const failures = [
    { ...empty, rejectedSendCount: 1 },
    { ...empty, deniedReadMethodNames: ["eth_unknown"], methodOutcomes: { DENIED_READ: { deniedRead: 1 } } },
    { ...empty, deniedMutationMethodNames: ["anvil_unknown"], methodOutcomes: { DENIED_MUTATION: { deniedMutation: 1 } } },
    { ...empty, methodOutcomes: { eth_chainId: { allowedUpstreamFailure: 1 } } },
    { ...empty, methodOutcomes: { eth_chainId: { budgetRejected: 1 } } },
    { ...known, methodOutcomes: { ...known.methodOutcomes, DENIED_READ: { deniedRead: 9 } } },
    { ...empty, methodOutcomes: { eth_notAllowlisted: { allowedSuccess: 1 } } },
    { ...empty, requestsForwarded: 1801 },
  ];
  for (const stats of failures) assert.throws(() => validateReplayRelayStats(stats), /forge-replay-relay-validation-failed/);
  assert.equal(safeTerminalCode(new Error("forge-replay-relay-validation-failed")), "forge-replay-relay-validation-failed");
});

test("relay success validation rejects missing, malformed, and unreconciled stats", () => {
  const valid = { requestsForwarded: 1, rejectedSendCount: 0, methodOutcomes: { eth_chainId: { allowedSuccess: 1 } }, deniedReadMethodNames: [], deniedMutationMethodNames: [] };
  assert.deepEqual(validateReplayRelayStats(valid), { requestsForwarded: 1, rejectedSendCount: 0 });
  for (const field of Object.keys(valid)) { const missing = structuredClone(valid); delete missing[field]; assert.throws(() => validateReplayRelayStats(missing), /relay-validation-failed/, field); }
  const malformed = [
    null, [], "stats",
    { ...valid, requestsForwarded: -1 }, { ...valid, requestsForwarded: 1.5 }, { ...valid, rejectedSendCount: -1 }, { ...valid, rejectedSendCount: "0" },
    { ...valid, methodOutcomes: [] }, { ...valid, methodOutcomes: { eth_chainId: [] } }, { ...valid, methodOutcomes: { eth_chainId: {} } },
    { ...valid, methodOutcomes: { eth_chainId: { allowedSuccess: -1 } } }, { ...valid, methodOutcomes: { eth_chainId: { allowedSuccess: 1.5 } } }, { ...valid, methodOutcomes: { eth_chainId: { allowedSuccess: 10001 } }, },
    { ...valid, deniedReadMethodNames: "eth_getAccountInfo" }, { ...valid, deniedMutationMethodNames: {} },
    { ...valid, requestsForwarded: 0 }, { ...valid, requestsForwarded: 2 },
    { ...valid, deniedReadMethodNames: ["eth_getAccountInfo"], methodOutcomes: { eth_chainId: { allowedSuccess: 1 } } },
    { ...valid, methodOutcomes: { eth_chainId: { allowedSuccess: 1 }, DENIED_READ: { deniedRead: 1 } } },
    { ...valid, deniedReadMethodNames: ["eth_getAccountInfo", "eth_getAccountInfo"], methodOutcomes: { eth_chainId: { allowedSuccess: 1 }, DENIED_READ: { deniedRead: 2 } } },
  ];
  for (const stats of malformed) assert.throws(() => validateReplayRelayStats(stats), /forge-replay-relay-validation-failed/);
});

test("Anvil argv contains only localhost relay material and bounded public anchors", () => {
  const cacheDirectory = path.join(APPROVED_TEMP, "synthetic-cache");
  const previous = buildAnvilArgs({ relayPort: 1234, localPort: 5678, chainId: "1", cacheDirectory, anchor: { kind: "PREVIOUS_TRANSACTION", transactionHash: PREVIOUS } });
  assert.ok(previous.includes("http://127.0.0.1:1234"));
  assert.ok(previous.includes(PREVIOUS));
  assert.equal(previous.includes("--block-time"), false);
  assert.equal(previous.includes("--no-mining"), false);
  const target = buildAnvilArgs({ relayPort: 1234, localPort: 5678, chainId: "1", cacheDirectory, anchor: { kind: "TRANSACTION", transactionHash: HASH } });
  assert.equal(target.includes("--block-time"), false);
  assert.ok(previous.includes("--no-storage-caching")); assert.ok(previous.includes("--quiet")); assert.ok(previous.includes("never")); assert.ok(previous.includes(cacheDirectory));
  assert.doesNotMatch(previous.join(" "), /https?:\/\/(?!127\.0\.0\.1)|authorization|bearer|x-api-key/i);
  const parent = buildAnvilArgs({ relayPort: 1234, localPort: 5678, chainId: "1", cacheDirectory, anchor: { kind: "PARENT_BLOCK", blockNumber: "99", parentHash: PARENT } });
  assert.ok(parent.includes("--fork-block-number"));
  assert.equal(parent.includes("--block-time"), false); assert.equal(parent.includes("--no-mining"), false);
  const env = sanitizedChildEnvironment({ Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", RPC_URL: "opaque", ORIGIN: "opaque", HOME: "opaque" });
  assert.deepEqual(Object.keys(env).sort(), ["Path", "SystemRoot", "TEMP", "TMP"]);
  assert.doesNotMatch(JSON.stringify(env), /rpc|origin|opaque|https?:/i);
});

test("prefix selection uses previous transaction and transaction-index-zero parent fallback", () => {
  const block = { number: "0x64", transactions: [PREVIOUS, HASH] };
  assert.deepEqual(selectPrefixAnchor(block, candidate("1")), { kind: "PREVIOUS_TRANSACTION", transactionHash: PREVIOUS, blockNumber: "100", transactionIndex: 0, canonicalPrefixHashes: [PREVIOUS], targetIndex: 1 });
  assert.deepEqual(selectTargetAnchor(block, candidate("1")), { kind: "TRANSACTION", transactionHash: HASH, blockNumber: "100", transactionIndex: 1, canonicalPrefixHashes: [PREVIOUS, HASH] });
  const parent = selectPrefixAnchor({ number: "0x64", transactions: [HASH] }, candidate("0"));
  assert.deepEqual(parent, { kind: "PARENT_BLOCK", blockNumber: "99", parentHash: PARENT, targetIndex: 0 });
});

test("parent fallback requires exact source parent hash and number", async () => {
  const source = { candidate: candidate("0") }; const anchor = selectPrefixAnchor({ number: "0x64", transactions: [HASH] }, source.candidate);
  const good = { provider: {}, budget: { call: async () => ({ hash: PARENT, number: "0x63", timestamp: "0x3e7" }) } };
  await assert.doesNotReject(() => validateParentFallback(anchor, source, good));
  const bad = { provider: {}, budget: { call: async (_provider, method) => ({ hash: PARENT, number: "0x63", timestamp: method === "eth_getBlockByHash" ? "0x3e7" : "0x3e6" }) } };
  await assert.rejects(() => validateParentFallback(anchor, source, bad), /parent-block-mismatch/);
});

function readinessClock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => { time += ms; } };
}

function readinessAnchor() {
  return { kind: "TRANSACTION", transactionHash: HASH, blockNumber: "100", transactionIndex: 1, canonicalPrefixHashes: [PREVIOUS, HASH] };
}

function readyRpc(overrides = {}) {
  return async (_port, method) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_blockNumber") return "0x64";
    if (method === "evm_setIntervalMining") return null;
    if (method === "eth_getTransactionReceipt") return Object.prototype.hasOwnProperty.call(overrides, "receipt") ? overrides.receipt : { transactionHash: HASH, blockNumber: "0x64", transactionIndex: "0x1", blockHash: LOCAL_BLOCK };
    if (method === "eth_getBlockByHash") return Object.prototype.hasOwnProperty.call(overrides, "block") ? overrides.block : { hash: LOCAL_BLOCK, number: "0x64", transactions: [PREVIOUS, HASH] };
    throw new Error("unexpected-method");
  };
}

async function assertReadinessTimeout(rpc, anchor = readinessAnchor(), expectedStage = null) {
  const clock = readinessClock();
  let observed;
  try { await waitReady({}, 9999, anchor, "1", { rpc, now: clock.now, sleep: clock.sleep, timeoutMs: 3, pollIntervalMs: 1 }); }
  catch (error) { observed = error; }
  assert.equal(observed?.message, "local-anvil-forced-replay-timeout");
  if (expectedStage) assert.equal(observed.readinessStage, expectedStage);
  return observed;
}

test("transaction readiness rejects null or mismatched local receipts", async () => {
  await assertReadinessTimeout(readyRpc({ receipt: null }), readinessAnchor(), "RECEIPT_ABSENT");
  await assertReadinessTimeout(readyRpc({ receipt: { transactionHash: PREVIOUS, blockNumber: "0x64", transactionIndex: "0x1", blockHash: LOCAL_BLOCK } }), readinessAnchor(), "RECEIPT_MISMATCH");
  await assertReadinessTimeout(readyRpc({ receipt: { transactionHash: HASH, blockNumber: "0x65", transactionIndex: "0x1", blockHash: LOCAL_BLOCK } }));
  await assertReadinessTimeout(readyRpc({ receipt: { transactionHash: HASH, blockNumber: "0x64", transactionIndex: "0x0", blockHash: LOCAL_BLOCK } }));
  await assertReadinessTimeout(readyRpc({ receipt: { transactionHash: HASH, blockNumber: "0x64", transactionIndex: "0x1", blockHash: null } }));
});

test("readiness timeout diagnostics expose only fixed stages", async () => {
  await assertReadinessTimeout(async () => { throw new Error("opaque"); }, readinessAnchor(), "LOCAL_RPC_UNAVAILABLE");
  await assertReadinessTimeout(async (_port, method) => method === "eth_chainId" ? "0x2" : "0x64", readinessAnchor(), "CHAIN_MISMATCH");
  await assertReadinessTimeout(async (_port, method) => method === "eth_chainId" ? "0x1" : "0x63", readinessAnchor(), "BLOCK_BELOW_ANCHOR");
});

test("transaction readiness enables interval mining once and disables once after commitment gate", async () => {
  const clock = readinessClock(); const calls = []; let receipts = 0;
  const rpc = async (port, method, params) => {
    calls.push({ method, params });
    if (method === "eth_getTransactionReceipt" && receipts++ === 0) return null;
    return readyRpc()(port, method, params);
  };
  await waitReady({}, 9999, readinessAnchor(), "1", { rpc, now: clock.now, sleep: clock.sleep, timeoutMs: 10, pollIntervalMs: 1 });
  assert.deepEqual(calls.filter((row) => row.method === "evm_setIntervalMining"), [
    { method: "evm_setIntervalMining", params: [1] },
    { method: "evm_setIntervalMining", params: [0] },
  ]);
  assert.ok(calls.findIndex((row) => row.method === "evm_setIntervalMining" && row.params[0] === 1) < calls.findIndex((row) => row.method === "eth_getTransactionReceipt"));
  assert.ok(calls.findIndex((row) => row.method === "evm_setIntervalMining" && row.params[0] === 0) > calls.findIndex((row) => row.method === "eth_getBlockByHash"));
  assert.equal(calls.some((row) => row.method === "anvil_mine" || row.method === "evm_mine" || /^eth_send/.test(row.method)), false);
});

test("transaction readiness failures disable interval mining without masking the primary error", async () => {
  const clock = readinessClock(); const timeoutIntervals = [];
  const absentReceiptRpc = async (port, method, params) => {
    if (method === "evm_setIntervalMining") { timeoutIntervals.push(params[0]); return null; }
    if (method === "eth_getTransactionReceipt") return null;
    return readyRpc()(port, method, params);
  };
  const timeout = await assertReadinessTimeout(absentReceiptRpc, readinessAnchor(), "RECEIPT_ABSENT");
  assert.equal(timeout.message, "local-anvil-forced-replay-timeout");
  assert.deepEqual(timeoutIntervals, [1, 0]);

  const enableIntervals = [];
  const enableFailure = await assertReadinessTimeout(async (port, method, params) => {
    if (method === "evm_setIntervalMining") { enableIntervals.push(params[0]); if (params[0] === 1) throw new Error("opaque-enable"); return null; }
    return readyRpc()(port, method, params);
  }, readinessAnchor(), "INTERVAL_ENABLE_FAILED");
  assert.equal(enableFailure.message, "local-anvil-forced-replay-timeout");
  assert.deepEqual(enableIntervals, [1, 0]);

  const disableIntervals = [];
  const disableFailure = await assertReadinessTimeout(async (port, method, params) => {
    if (method === "evm_setIntervalMining") { disableIntervals.push(params[0]); if (params[0] === 0) throw new Error("opaque-disable"); return null; }
    return readyRpc()(port, method, params);
  }, readinessAnchor(), "INTERVAL_DISABLE_FAILED");
  assert.equal(disableFailure.message, "local-anvil-forced-replay-timeout");
  assert.deepEqual(disableIntervals, [1, 0]);
});

test("transaction readiness rejects local block identity and canonical prefix mismatches", async () => {
  await assertReadinessTimeout(readyRpc({ block: { hash: BLOCK, number: "0x64", transactions: [PREVIOUS, HASH] } }), readinessAnchor(), "BLOCK_IDENTITY_MISMATCH");
  await assertReadinessTimeout(readyRpc({ block: { hash: LOCAL_BLOCK, number: "0x65", transactions: [PREVIOUS, HASH] } }));
  await assertReadinessTimeout(readyRpc({ block: { hash: LOCAL_BLOCK, number: "0x64", transactions: [HASH, PREVIOUS] } }), readinessAnchor(), "PREFIX_MISMATCH");
  await assertReadinessTimeout(readyRpc({ block: null }), readinessAnchor(), "BLOCK_ABSENT");
});

test("readiness fails immediately with fixed child-exit diagnostics", async () => {
  const child = new EventEmitter(); child.exitCode = 1; child.signalCode = null; let calls = 0;
  let observed;
  try { await waitReady(child, 9999, readinessAnchor(), "1", { rpc: async () => { calls += 1; }, timeoutMs: 30000 }); } catch (error) { observed = error; }
  assert.equal(calls, 0);
  assert.equal(observed?.message, "local-anvil-exited");
  assert.equal(observed?.readinessStage, "CHILD_EXITED");
  assert.deepEqual(Object.keys(observed).sort(), ["readinessStage"]);
});

test("transaction readiness waits for delayed forced replay and accepts a recreated local block hash", async () => {
  const clock = readinessClock(); let receipts = 0;
  const rpc = async (...args) => {
    if (args[1] === "eth_getTransactionReceipt" && receipts++ < 2) return null;
    return readyRpc()(...args);
  };
  await assert.doesNotReject(() => waitReady({}, 9999, readinessAnchor(), "1", { rpc, now: clock.now, sleep: clock.sleep, timeoutMs: 10, pollIntervalMs: 1 }));
  assert.equal(receipts, 3);
});

test("parent readiness gates exact latest block without transaction receipt or mining", async () => {
  const clock = readinessClock(); const methods = [];
  await waitReady({}, 9999, { kind: "PARENT_BLOCK", blockNumber: "99" }, "1", { rpc: async (_port, method) => { methods.push(method); return method === "eth_chainId" ? "0x1" : "0x63"; }, now: clock.now, sleep: clock.sleep, timeoutMs: 3, pollIntervalMs: 1 });
  assert.deepEqual(methods, ["eth_chainId", "eth_blockNumber"]);
  assert.equal(methods.includes("evm_setIntervalMining"), false);
  await assertReadinessTimeout(async (_port, method) => method === "eth_chainId" ? "0x1" : "0x64", { kind: "PARENT_BLOCK", blockNumber: "99" });
});

test("exact delta math reconciles gas, Morpho facts, provisional cluster, residuals, and break-even", () => {
  const scope = deriveReplayScope(candidate(), forensicRow());
  const emptyToken = (decimals, balances) => ({ decimals, balances });
  const pre = { native: { [SENDER]: "1000", [EXECUTOR]: "0", [FEE]: "0" }, tokens: {
    [USDC]: emptyToken("6", { [SENDER]: "100", [EXECUTOR]: "0", [FEE]: "0" }),
    [COLLATERAL]: emptyToken("18", { [SENDER]: "0", [EXECUTOR]: "0", [FEE]: "0" }),
  } };
  const post = { native: { [SENDER]: "890", [EXECUTOR]: "10", [FEE]: "0" }, tokens: {
    [USDC]: emptyToken("6", { [SENDER]: "90", [EXECUTOR]: "15", [FEE]: "0" }),
    [COLLATERAL]: emptyToken("18", { [SENDER]: "20", [EXECUTOR]: "0", [FEE]: "0" }),
  } };
  const deltas = computeBalanceDeltas(pre, post, scope, candidate().receipt, forensicRow(), candidate());
  assert.equal(deltas.cluster.status, "PROVISIONAL_STRATEGY_CLUSTER");
  assert.equal(deltas.gas.gasWei, "100");
  assert.equal(deltas.gas.clusterDeltaAfterAddingBackGasWei, "0");
  assert.equal(deltas.morpho.repaidAssetsRaw, "10");
  assert.equal(deltas.morpho.seizedAssetsRaw, "20");
  const economics = replayEconomics(deltas);
  assert.equal(economics.status, "UNKNOWN");
  assert.equal(economics.routePositive, "unknown");
  assert.equal(economics.gasOnlyUsdcPerEth.numerator, (5n * 10n ** 18n).toString());
  assert.equal(economics.gasOnlyUsdcPerEth.denominator, (10n ** 6n * 100n).toString());
  assert.equal(economics.gasOnlyUsdcPerEth.units, "USDC_PER_ETH");
  assert.doesNotMatch(JSON.stringify(economics), /ETH_USD/);
  assert.deepEqual(economics.residualInventory, [{ token: COLLATERAL, residualRaw: "20", pricing: "UNPRICED_NO_EXACT_UNWIND" }]);

  const unbound = structuredClone(deltas); unbound.morpho.protocolBindingStatus = "SOURCE_FACTS_INCOMPLETE";
  assert.equal(replayEconomics(unbound).gasOnlyUsdcPerEth.reason, "PROTOCOL_OBLIGATIONS_UNBOUND");
  const negativeToken = structuredClone(deltas); negativeToken.tokens.find((row) => row.token === COLLATERAL).provisionalClusterDeltaRaw = "-1";
  assert.equal(replayEconomics(negativeToken).gasOnlyUsdcPerEth.reason, "OTHER_NEGATIVE_TOKEN_LIABILITY");
  const nativeLiability = structuredClone(deltas); nativeLiability.gas.clusterDeltaAfterAddingBackGasWei = "-1";
  assert.equal(replayEconomics(nativeLiability).gasOnlyUsdcPerEth.reason, "NON_GAS_NATIVE_DELTA");
  const noSpread = structuredClone(deltas); noSpread.tokens.find((row) => row.token === USDC).provisionalClusterDeltaRaw = "0";
  assert.equal(replayEconomics(noSpread).gasOnlyUsdcPerEth.reason, "NO_POSITIVE_USDC_CLUSTER_DELTA");
  const usdcDecimalsMismatch = structuredClone(deltas); usdcDecimalsMismatch.tokens.find((row) => row.token === USDC).decimalsMatch = false;
  assert.equal(replayEconomics(usdcDecimalsMismatch).gasOnlyUsdcPerEth.reason, "TOKEN_DECIMALS_MISMATCH");
  const collateralDecimalsMismatch = structuredClone(deltas); collateralDecimalsMismatch.tokens.find((row) => row.token === COLLATERAL).decimalsMatch = false;
  assert.equal(replayEconomics(collateralDecimalsMismatch).gasOnlyUsdcPerEth.reason, "TOKEN_DECIMALS_MISMATCH");
});

test("Morpho source facts fail closed for wrong protocol, missing identities, or inconsistent transfers", () => {
  assert.equal(validateMorphoSourceFacts(candidate(), forensicRow()), true);
  const wrongProtocol = forensicRow(); wrongProtocol.protocolBinding.protocol = "other";
  assert.equal(validateMorphoSourceFacts(candidate(), wrongProtocol), false);
  const missingIdentity = forensicRow(); missingIdentity.protocolBinding.debt.token = null;
  assert.equal(validateMorphoSourceFacts(candidate(), missingIdentity), false);
  const inconsistent = candidate(); inconsistent.receipt.logs[2].transfer.amount = "19";
  assert.equal(validateMorphoSourceFacts(inconsistent, forensicRow()), false);
});

test("fork snapshot always cleans up a child when local state querying fails", async () => {
  let stopped = 0; let cacheDirectory = null; const anchor = { kind: "PARENT_BLOCK", blockNumber: "99" };
  const adapter = { freePort: async () => 9999, start: async (args, options) => { cacheDirectory = options.cacheDirectory; assert.equal(fs.existsSync(cacheDirectory), true); assert.equal(path.dirname(cacheDirectory), APPROVED_TEMP); assert.deepEqual(Object.keys(options.env).sort().every((key) => ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "WINDIR"].includes(key)), true); assert.doesNotMatch(`${args.join(" ")} ${JSON.stringify(options.env)}`, /authorization|bearer|x-api-key|rpc_url|endpoint_url/i); return {}; }, waitReady: async (_child, port, observedAnchor, chainId) => { assert.equal(port, 9999); assert.equal(observedAnchor, anchor); assert.equal(chainId, "1"); }, call: async () => { throw new Error("injected-query-failure"); }, stop: async () => { stopped += 1; } };
  await assert.rejects(() => captureForkSnapshot({ relayPort: 1234, chainId: "1", anchor, scope: { addresses: [SENDER], tokens: [] }, processAdapter: adapter }), /injected-query-failure/);
  assert.equal(stopped, 1);
  assert.equal(fs.existsSync(cacheDirectory), false);
});

test("local replay closes relay and removes child cache when a snapshot fails", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "local-replay-failure-cleanup-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = makeDeepSource(parent); let relayClosed = 0; let stopped = 0; let cacheDirectory = null;
  const adapter = { freePort: async () => 9998, start: async (_args, options) => { cacheDirectory = options.cacheDirectory; return {}; }, waitReady: async () => {}, call: async () => { throw new Error("snapshot-failure"); }, stop: async () => { stopped += 1; } };
  await assert.rejects(() => anvilLocalStateReplay({ sourceDirectory: directory, hash: HASH,
    qualifyProvider: async () => ({ provider: {}, block: { number: "0x64", transactions: [PREVIOUS, HASH] }, budget: { call: async () => null } }),
    relayFactory: async () => ({ port: 8124, stats: () => ({ requestsForwarded: 0, rejectedSendCount: 0 }), close: async () => { relayClosed += 1; } }), processAdapter: adapter }), /snapshot-failure/);
  assert.equal(stopped, 1); assert.equal(relayClosed, 1); assert.equal(fs.existsSync(cacheDirectory), false);
});

test("mocked local replay preserves source, cleans children and relay, and emits endpoint-free UNKNOWN evidence", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "local-state-replay-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = makeDeepSource(parent); const source = verifyReplaySource(directory, HASH); const before = source.before;
  let run = 0; let stopped = 0; let relayClosed = 0; const cacheDirectories = []; const readiness = [];
  const preBalances = { [SENDER]: 1000n, [EXECUTOR]: 0n, [FEE]: 0n }; const postBalances = { [SENDER]: 900n, [EXECUTOR]: 0n, [FEE]: 0n };
  const tokenPre = { [USDC]: { [SENDER]: 10n, [EXECUTOR]: 0n, [FEE]: 0n }, [COLLATERAL]: { [SENDER]: 0n, [EXECUTOR]: 0n, [FEE]: 0n } };
  const tokenPost = { [USDC]: { [SENDER]: 5n, [EXECUTOR]: 10n, [FEE]: 0n }, [COLLATERAL]: { [SENDER]: 20n, [EXECUTOR]: 0n, [FEE]: 0n } };
  const adapter = {
    freePort: async () => 9000 + run,
    start: async (_args, options) => { cacheDirectories.push(options.cacheDirectory); return { state: run++ }; }, waitReady: async (_child, _port, anchor, chainId) => { readiness.push({ anchor, chainId }); }, stop: async () => { stopped += 1; },
    call: async (_port, method, params) => {
      const state = run === 1 ? "pre" : "post";
      if (method === "eth_getBalance") return `0x${(state === "pre" ? preBalances : postBalances)[params[0]].toString(16)}`;
      const token = params[0].to; const data = params[0].data;
      if (data === "0x313ce567") return token === USDC ? "0x6" : "0x12";
      const holder = `0x${data.slice(-40)}`; const value = (state === "pre" ? tokenPre : tokenPost)[token][holder]; return `0x${value.toString(16)}`;
    },
  };
  const result = await anvilLocalStateReplay({ sourceDirectory: directory, hash: HASH,
    qualifyProvider: async () => ({ provider: {}, block: { number: "0x64", transactions: [PREVIOUS, HASH] }, budget: { call: async () => { throw new Error("unused"); } } }),
    relayFactory: async () => ({ port: 8123, stats: () => ({ requestsForwarded: 0, rejectedSendCount: 0, deniedReadMethodNames: ["eth_getAccountInfo"], deniedMutationMethodNames: [], methodOutcomes: { DENIED_READ: { deniedRead: 1 } } }), close: async () => { relayClosed += 1; } }), processAdapter: adapter });
  assert.equal(stopped, 2); assert.equal(relayClosed, 1);
  assert.deepEqual(readiness, [
    { anchor: { kind: "PREVIOUS_TRANSACTION", transactionHash: PREVIOUS, blockNumber: "100", transactionIndex: 0, canonicalPrefixHashes: [PREVIOUS], targetIndex: 1 }, chainId: "1" },
    { anchor: { kind: "TRANSACTION", transactionHash: HASH, blockNumber: "100", transactionIndex: 1, canonicalPrefixHashes: [PREVIOUS, HASH] }, chainId: "1" },
  ]);
  assert.equal(cacheDirectories.every((directory) => !fs.existsSync(directory)), true);
  assert.equal(result.bundle["replay-runtime.json"].localFork, true);
  assert.equal(result.bundle["replay-runtime.json"].prefixState, "post-previous-tx");
  assert.deepEqual(Object.keys(result.bundle["replay-runtime.json"].relay).sort(), ["rejectedSendCount", "requestsForwarded"]);
  assert.doesNotMatch(JSON.stringify(result.bundle), /eth_getAccountInfo|anvil_nodeInfo|methodOutcomes|deniedReadMethodNames|deniedMutationMethodNames/);
  assert.equal(result.bundle["economics.json"].status, "UNKNOWN");
  assert.equal(result.bundle["economics.json"].routePositive, "unknown");
  assert.doesNotThrow(() => leakScan(result.bundle));
  assert.deepEqual(assertReplaySourceUnchanged(result.source), before);
  const output = path.join(parent, "replay-output"); atomicBundle(output, result.bundle);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")).endpointFree, true);
  assert.equal(result.bundle["source-binding.json"].replayTier, REPLAY_TIER);
});

function forgeResult(overrides = {}) {
  return {
    schemaVersion: "1",
    status: "OK",
    preNative: ["1000", "0", "0"],
    postNative: ["900", "0", "0"],
    preTokenBalances: ["10", "0", "0", "0", "0", "0"],
    postTokenBalances: ["5", "10", "0", "20", "0", "0"],
    preTokenDecimals: ["6", "18"],
    postTokenDecimals: ["6", "18"],
    preSenderNonce: "7",
    postSenderNonce: "8",
    contextChainId: "1",
    contextBlockNumber: "100",
    contextTimestamp: TARGET_TIMESTAMP,
    contextCoinbase: FEE,
    contextBaseFee: "20",
    contextGasLimit: "30000000",
    contextPrevrandao: LOCAL_BLOCK,
    contextParentHash: PARENT,
    contextBlobBaseFee: "1",
    logEmitters: [USDC, EXECUTOR, COLLATERAL],
    logTopicCounts: ["0", "0", "0"],
    logTopics: [],
    logData: ["0x", "0x", "0x"],
    ...overrides,
  };
}

function forgeScope() { return deriveReplayScope(candidate(), forensicRow()); }
function parsedForge(overrides = {}) { return parseForgeResult(Buffer.from(JSON.stringify(forgeResult(overrides))), forgeScope()); }
function sentinelCorroboration() { return { twoIndependentProviderPrestateMatch: true, globalStateComplete: false }; }

function rawCanonicalView(overrides = {}) {
  const index = overrides.index == null ? 1 : overrides.index;
  const raw = {
    rawTransaction: RAW_TRANSACTION,
    transaction: { hash: HASH, blockHash: BLOCK, blockNumber: "0x64", transactionIndex: `0x${index.toString(16)}`, from: SENDER, to: EXECUTOR, nonce: "0x7", value: "0x0", type: "0x2", chainId: "0x1", gas: "0x5208", gasPrice: null, maxFeePerGas: "0x64", maxPriorityFeePerGas: "0x2", maxFeePerBlobGas: null, blobVersionedHashes: null, input: "0x12345678", accessList: [], authorizationList: null, v: "0x0", r: "0x76abd2c100ee55697658c8b868bb5726fbf1e0981425cd6a3a82477500153cdc", s: "0x6db467168996588752db2f991f05c9c07aafb6ab418c09eaa3280fdd373e5aaa", yParity: "0x0" },
    receipt: { transactionHash: HASH, blockHash: BLOCK, blockNumber: "0x64", transactionIndex: `0x${index.toString(16)}`, from: SENDER, to: EXECUTOR, status: "0x1", root: null, gasUsed: "0xa", cumulativeGasUsed: "0x14", effectiveGasPrice: "0xa", contractAddress: null, type: "0x2", logsBloom: `0x${"0".repeat(512)}`, blobGasUsed: null, blobGasPrice: null, logs: [USDC, EXECUTOR, COLLATERAL].map((address, logIndex) => ({ address, topics: [], data: "0x", blockHash: BLOCK, blockNumber: "0x64", transactionHash: HASH, transactionIndex: `0x${index.toString(16)}`, logIndex: `0x${logIndex.toString(16)}`, removed: false })) },
    block: { hash: BLOCK, parentHash: PARENT, number: "0x64", timestamp: `0x${BigInt(TARGET_TIMESTAMP).toString(16)}`, miner: FEE, baseFeePerGas: "0x14", gasLimit: "0x1c9c380", mixHash: LOCAL_BLOCK, blobGasUsed: "0x0", excessBlobGas: "0x0", transactionsRoot: `0x${"6".repeat(64)}`, stateRoot: `0x${"7".repeat(64)}`, receiptsRoot: `0x${"8".repeat(64)}`, transactions: index === 1 ? [PREVIOUS, HASH] : [HASH] },
  };
  return { raw, canonical: normalizedCanonicalView(raw, "0x1", index) };
}

test("fixed Forge harness uses only the approved transaction-fork and transact operations", () => {
  assert.equal(FORGE_REPLAY_TIER, "FORGE_VM_TRANSACT_STATE_DELTA_REPLAY_V2");
  assert.match(FORGE_HARNESS_SHA256, /^[0-9a-f]{64}$/);
  assert.equal((FORGE_HARNESS.match(/vm\.createSelectFork\(/g) || []).length, 1);
  assert.equal((FORGE_HARNESS.match(/vm\.transact\(/g) || []).length, 1);
  assert.match(FORGE_HARNESS, /createSelectFork\("replay", targetHash\)/);
  assert.match(FORGE_HARNESS, /vm\.recordLogs\(\)[\s\S]*vm\.transact\(targetHash\)/);
  assert.match(FORGE_HARNESS, /serializeBytes32\("result", "contextPrevrandao", bytes32\(block\.prevrandao\)\)/);
  assert.match(FORGE_HARNESS, /blockhash\(block\.number - 1\)/);
  assert.match(FORGE_HARNESS, /vm\.toString\(block\.blobbasefee\)/);
  assert.doesNotMatch(FORGE_HARNESS, /vm\.(?:ffi|broadcast|startBroadcast|prank|startPrank|sign|deal|store|etch|roll|warp|fee|coinbase|transact\s*\([^)]*,|createFork|selectFork)\b/);
});

test("Forge replay accepts only the pinned official nightly identity and approved portable path", () => {
  assert.deepEqual(forgeVersion(FORGE_VERSION_OUTPUT), { version: "1.8.0-nightly", commit: "879053163b1f82fd5ac381b68ad891ab2091e958" });
  for (const output of [
    FORGE_VERSION_OUTPUT.replace("879053163b1f82fd5ac381b68ad891ab2091e958", "179053163b1f82fd5ac381b68ad891ab2091e958"),
    FORGE_VERSION_OUTPUT.replace("1.8.0-nightly", "1.8.0-stable"),
    "forge Version: 1.5.1-stable\nCommit SHA: b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2\n",
    "forge Version: 1.8.0-nightly\n",
  ]) assert.throws(() => forgeVersion(output), /forge-replay-version-unsupported/);
  assert.equal(resolveForgeExecutable(), "forge");
  for (const invalid of ["forge.exe", path.join(APPROVED_TEMP, "not-forge.exe"), path.join(os.tmpdir(), "forge.exe")]) assert.throws(() => resolveForgeExecutable(invalid), /forge-replay-executable-invalid/);
  assert.equal(safeTerminalCode(new Error("forge-replay-executable-invalid")), "forge-replay-executable-invalid");
});

test("Forge canonical qualification keeps raw nonce and receipt data separate from production sanitized shapes", () => {
  const view = rawCanonicalView(); const sanitized = sanitizeReceipt(view.raw.receipt);
  assert.equal(FORGE_PARENT_QUALIFICATION_METHODS.has("eth_getRawTransactionByHash"), true);
  assert.equal(FORK_UPSTREAM_METHODS.has("eth_getRawTransactionByHash"), false);
  assert.equal(keccakRawTransaction(RAW_TRANSACTION), HASH);
  assert.equal(view.canonical.localSerialization.bytes, RAW_TRANSACTION);
  assert.equal(view.canonical.localSerialization.hash, HASH);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized.logs[0], "data"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(candidate().transaction, "nonce"), false);
  assert.equal(view.canonical.transaction.nonce, "7");
  assert.equal(view.canonical.receipt.from, SENDER);
  assert.equal(view.canonical.receipt.to, EXECUTOR);
  assert.equal(view.canonical.receipt.logs[0].data, "0x");
  assert.deepEqual(view.canonical.block.prefixHashes, [PREVIOUS, HASH]);
  const firstFamily = Symbol("declared-family-a"); const secondFamily = Symbol("declared-family-b");
  const rows = [
    { provider: { declaredGroup: true, family: firstFamily }, budget: {}, block: view.raw.block, canonical: view.canonical },
    { provider: { declaredGroup: true, family: secondFamily }, budget: {}, block: structuredClone(view.raw.block), canonical: structuredClone(view.canonical) },
  ];
  assert.equal(selectForgeProviderPair(rows).providerQualification.exactCanonicalViews, true);
  assert.equal(selectForgeProviderPair(rows).providerQualification.rawTransactionBytesAndHashMatched, true);
  assert.equal(selectForgeProviderPair(rows).providerQualification.serializationEvidenceMode, "RAW_RPC_AND_LOCAL_SERIALIZATION");
  rows[1].canonical.receipt.logs[0].data = "0x01";
  assert.throws(() => selectForgeProviderPair(rows), /two-independent-canonical-providers-unavailable/);
  rows[1].canonical = structuredClone(view.canonical); rows[1].canonical.receipt.from = FEE;
  assert.throws(() => selectForgeProviderPair(rows), /two-independent-canonical-providers-unavailable/);
  rows[1].canonical = structuredClone(view.canonical); rows[1].canonical.receipt.to = null;
  assert.throws(() => selectForgeProviderPair(rows), /two-independent-canonical-providers-unavailable/);
  rows[1].canonical = structuredClone(view.canonical); rows[1].provider.family = firstFamily;
  assert.throws(() => selectForgeProviderPair(rows), /two-independent-canonical-providers-unavailable/);
  const missingVsNull = rawCanonicalView(); delete missingVsNull.raw.transaction.authorizationList;
  const missingCanonical = normalizedCanonicalView(missingVsNull.raw, "0x1", 1);
  assert.notDeepEqual(missingCanonical.transaction.consensus.authorizationList, view.canonical.transaction.consensus.authorizationList);
  const badHash = rawCanonicalView().raw; badHash.rawTransaction = "0x02c1";
  assert.throws(() => normalizedCanonicalView(badHash, "0x1", 1), /raw-transaction-hash-mismatch/);
  const wrongReceiptFrom = rawCanonicalView().raw; wrongReceiptFrom.receipt.from = FEE;
  assert.throws(() => normalizedCanonicalView(wrongReceiptFrom, "0x1", 1), /receipt-transaction-endpoint-mismatch/);
  const wrongReceiptTo = rawCanonicalView().raw; wrongReceiptTo.receipt.to = null;
  assert.throws(() => normalizedCanonicalView(wrongReceiptTo, "0x1", 1), /receipt-transaction-endpoint-mismatch/);
  const creation = rawCanonicalView().raw; const creationHash = "0xe47ff65d15ec3b2f0dda813928cd7af594ce668163ef96479d51c8d716b3678d";
  creation.rawTransaction = "0x02f84e01070264825208808080c001a0c34f26894964228ee240ddfcd1dee929d43471de977427bca315e4ed7ced5f24a006684fc287266346895c152cc57caeecc029553149faaa437114dc67bf5f9619";
  creation.transaction.hash = creationHash; creation.transaction.to = null; creation.transaction.input = "0x"; creation.transaction.v = "0x1"; creation.transaction.yParity = "0x1"; creation.transaction.r = "0xc34f26894964228ee240ddfcd1dee929d43471de977427bca315e4ed7ced5f24"; creation.transaction.s = "0x06684fc287266346895c152cc57caeecc029553149faaa437114dc67bf5f9619";
  creation.receipt.transactionHash = creationHash; creation.receipt.to = null; creation.receipt.logs.forEach((log) => { log.transactionHash = creationHash; }); creation.block.transactions[1] = creationHash;
  assert.equal(normalizedCanonicalView(creation, "0x1", 1).receipt.to, null);
  const missingReceiptTo = rawCanonicalView().raw; delete missingReceiptTo.receipt.to;
  assert.throws(() => normalizedCanonicalView(missingReceiptTo, "0x1", 1), /canonical-view-incomplete/);
  for (const raw of ["0x", "0x0", "xyz"]) assert.throws(() => keccakRawTransaction(raw), /raw-transaction-invalid/);
});

test("pinned ethers type-2 serialization validates every signed field and recovers the known signer", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));
  assert.equal(PINNED_ETHERS_VERSION, "6.17.0");
  assert.equal(packageJson.dependencies.ethers, "6.17.0");
  assert.equal(packageLock.packages[""].dependencies.ethers, "6.17.0");
  assert.equal(packageLock.packages["node_modules/ethers"].version, "6.17.0");
  const backendSource = fs.readFileSync(path.join(__dirname, "..", "atomic", "ethereum-top-trades-7d-reconstruction", "forge-state-replay.js"), "utf8");
  assert.match(backendSource, /path\.resolve\(__dirname, "\.\.", "\.\.", "node_modules", "ethers"\)/);
  assert.doesNotMatch(backendSource, /require\(["']ethers["']\)/);
  assert.equal(assertPinnedEthersVersion().version, "6.17.0");
  assert.throws(() => assertPinnedEthersVersion({ version: "6.16.0" }, { version: "6.17.0" }), /ethers-version-mismatch/);
  assert.throws(() => assertPinnedEthersVersion({ version: "6.17.0" }, { version: "6.16.0" }), /ethers-version-mismatch/);
  assert.equal(safeTerminalCode(new Error("forge-replay-ethers-version-mismatch")), "forge-replay-ethers-version-mismatch");
  const transaction = rawCanonicalView().raw.transaction;
  const serialized = canonicalType2Serialization(transaction, HASH);
  assert.equal(serialized.bytes, RAW_TRANSACTION);
  assert.equal(serialized.hash, HASH);
  assert.equal(serialized.from, SENDER);
  assert.equal(keccakRawTransaction(serialized.bytes), HASH);
  const missingCases = [
    ["type", ["type"]], ["chainId", ["chainId"]], ["nonce", ["nonce"]], ["maxPriorityFeePerGas", ["maxPriorityFeePerGas"]], ["maxFeePerGas", ["maxFeePerGas"]], ["gas/gasLimit", ["gas", "gasLimit"]], ["to", ["to"]], ["value", ["value"]], ["input/data", ["input", "data"]], ["accessList", ["accessList"]], ["signature parity", ["yParity", "v"]], ["r", ["r"]], ["s", ["s"]], ["from", ["from"]],
  ];
  for (const [label, fields] of missingCases) { const malformed = structuredClone(transaction); for (const field of fields) delete malformed[field]; assert.throws(() => canonicalType2Serialization(malformed, HASH), /type2-canonical-invalid/, label); }
  for (const [field, value] of [["chainId", "0x01"], ["nonce", "0x07"], ["maxFeePerGas", 100], ["type", "0x3"]]) { const malformed = structuredClone(transaction); malformed[field] = value; assert.throws(() => canonicalType2Serialization(malformed, HASH), field === "type" ? /non-type2-unsupported/ : /type2-canonical-invalid/); }
  const parityMismatch = structuredClone(transaction); parityMismatch.v = "0x1";
  assert.throws(() => canonicalType2Serialization(parityMismatch, HASH), /type2-canonical-invalid/);
  for (const accessList of [{}, [{ address: EXECUTOR }], [{ address: "0x1", storageKeys: [] }], [{ address: EXECUTOR, storageKeys: ["0x01"] }], [{ address: EXECUTOR, storageKeys: [], extra: true }]]) { const malformed = structuredClone(transaction); malformed.accessList = accessList; assert.throws(() => canonicalType2Serialization(malformed, HASH), /type2-canonical-invalid/); }
  const wrongHash = structuredClone(transaction); assert.throws(() => canonicalType2Serialization(wrongHash, PREVIOUS), /type2-canonical-invalid/);
  const wrongFrom = structuredClone(transaction); wrongFrom.from = FEE; assert.throws(() => canonicalType2Serialization(wrongFrom, HASH), /type2-canonical-invalid/);
  const wrongSignature = structuredClone(transaction); wrongSignature.s = `0x${"1".repeat(64)}`; assert.throws(() => canonicalType2Serialization(wrongSignature, HASH), /type2-canonical-invalid/);
});

test("optional raw RPC fallback is bounded and local serialized bytes remain the agreement authority", async () => {
  const success = { call: async (_provider, method) => { assert.equal(method, "eth_getRawTransactionByHash"); return RAW_TRANSACTION; } };
  assert.equal(await fetchOptionalRawTransaction(success, {}, HASH), RAW_TRANSACTION);
  assert.equal(await fetchOptionalRawTransaction({ call: async () => null }, {}, HASH), null);
  assert.equal(await fetchOptionalRawTransaction({ call: async () => { throw new Error("provider-method-not-found"); } }, {}, HASH), null);
  for (const code of ["request-budget-exhausted", "response-budget-exceeded", "total-time-budget-exhausted", "provider-transport-failure"]) await assert.rejects(() => fetchOptionalRawTransaction({ call: async () => { throw new Error(code); } }, {}, HASH), new RegExp(code));
  const matched = rawCanonicalView();
  const rawMismatch = rawCanonicalView().raw; rawMismatch.rawTransaction = `0x${"00".repeat(100)}`;
  assert.throws(() => normalizedCanonicalView(rawMismatch, "0x1", 1), /raw-transaction-(?:hash|local)-mismatch/);
  const localA = rawCanonicalView(); localA.raw.rawTransaction = null; localA.canonical = normalizedCanonicalView(localA.raw, "0x1", 1);
  const localB = rawCanonicalView(); localB.raw.rawTransaction = null; localB.canonical = normalizedCanonicalView(localB.raw, "0x1", 1);
  const families = [Symbol("local-a"), Symbol("local-b")]; const localRows = [localA, localB].map((row, index) => ({ provider: { declaredGroup: true, family: families[index] }, budget: {}, block: row.raw.block, canonical: row.canonical }));
  assert.equal(selectForgeProviderPair(localRows).providerQualification.serializationEvidenceMode, "TWO_PROVIDER_LOCAL_TYPE2_SERIALIZATION");
  const mixedRows = [{ provider: { declaredGroup: true, family: Symbol("raw") }, budget: {}, block: matched.raw.block, canonical: matched.canonical }, localRows[1]];
  assert.equal(selectForgeProviderPair(mixedRows).providerQualification.serializationEvidenceMode, "TWO_PROVIDER_LOCAL_TYPE2_SERIALIZATION");
  localRows[1].canonical.localSerialization.bytes = `${localRows[1].canonical.localSerialization.bytes.slice(0, -2)}00`;
  assert.throws(() => selectForgeProviderPair(localRows), /two-independent-canonical-providers-unavailable/);
});

test("EIP-4844 blob base fee and parent context use exact canonical derivation", () => {
  assert.deepEqual(BLOB_FEE_SCHEDULE.map(({ label, timestamp, fraction }) => [label, timestamp, fraction]), [["CANCUN", 1710338135n, 3338477n], ["PECTRA", 1746612311n, 5007716n], ["FUSAKA", 1764798551n, 5007716n], ["BPO1", 1765290071n, 8346193n], ["BPO2", 1767747671n, 11684671n]]);
  for (let index = 0; index < BLOB_FEE_SCHEDULE.length; index += 1) {
    const row = BLOB_FEE_SCHEDULE[index];
    assert.equal(blobFeeSchedule(row.timestamp).label, row.label);
    assert.equal(blobFeeSchedule(row.timestamp).fraction, row.fraction);
    if (index > 0) assert.equal(blobFeeSchedule(row.timestamp - 1n).label, BLOB_FEE_SCHEDULE[index - 1].label);
  }
  assert.throws(() => blobFeeSchedule(1710338134n), /blob-base-fee-inapplicable/);
  assert.equal(MAX_EXCESS_BLOB_GAS, 18446744073709551615n);
  assert.equal(FAKE_EXPONENTIAL_ITERATION_CAP, 4096);
  for (const [excess, expected] of [[0n, 1n], [1n, 1n], [2314057n, 1n], [3338477n, 2n], [6676954n, 7n], [10015431n, 20n], [20030862n, 403n]]) assert.equal(fakeExponential(1n, excess, 3338477n), expected);
  assert.equal(fakeExponential(1n, "0x989680", 11684671n), 2n);
  for (const [fraction, expected10m, expected20m] of [[3338477n, 19n, 399n], [5007716n, 7n, 54n], [8346193n, 3n, 10n], [11684671n, 2n, 5n]]) { assert.equal(fakeExponential(1n, 10000000n, fraction), expected10m); assert.equal(fakeExponential(1n, 20000000n, fraction), expected20m); }
  for (const malicious of [MAX_EXCESS_BLOB_GAS, MAX_EXCESS_BLOB_GAS + 1n, "0x10000000000000000", "0x00", "0X1", "18446744073709551615"]) assert.throws(() => fakeExponential(1n, malicious, 3338477n), /blob-base-fee-computation-bounded/);
  assert.throws(() => fakeExponential(1n, 3338477n * BigInt(FAKE_EXPONENTIAL_ITERATION_CAP), 3338477n), /blob-base-fee-computation-bounded/);
  assert.equal(safeTerminalCode(new Error("forge-replay-blob-base-fee-computation-bounded")), "forge-replay-blob-base-fee-computation-bounded");
  assert.deepEqual(canonicalBlobBaseFee({ timestamp: TARGET_TIMESTAMP, excessBlobGas: "0x989680", blobGasUsed: "0x0" }), { value: "2", scheduleLabel: "BPO2", updateFraction: "11684671" });
  assert.throws(() => canonicalBlobBaseFee({ timestamp: "1710338134", excessBlobGas: "0x0", blobGasUsed: "0x0" }), /blob-base-fee-inapplicable/);
  assert.throws(() => canonicalBlobBaseFee({ timestamp: TARGET_TIMESTAMP }), /blob-base-fee-inapplicable/);
  const canonical = rawCanonicalView().canonical;
  assert.equal(canonical.block.context.parentHash, PARENT);
  assert.equal(canonical.block.context.blobBaseFee, "1");
  assert.equal(canonical.block.context.blobFeeScheduleLabel, "BPO2");
  assert.equal(canonical.block.context.blobBaseFeeUpdateFraction, "11684671");
  assert.throws(() => validateBlockContext(canonical, { ...parsedForge().context, parentHash: BLOCK }), /block-context-mismatch/);
  assert.throws(() => validateBlockContext(canonical, { ...parsedForge().context, blobBaseFee: "2" }), /block-context-mismatch/);
});

test("block context mismatch diagnostics expose only the fixed process-local field enum", () => {
  const canonical = rawCanonicalView().canonical; const observed = parsedForge().context;
  const mismatches = { chainId: ["2", "CHAIN_ID"], blockNumber: ["101", "BLOCK_NUMBER"], timestamp: ["1", "TIMESTAMP"], coinbase: [EXECUTOR, "COINBASE"], baseFee: ["21", "BASE_FEE"], gasLimit: ["1", "GAS_LIMIT"], prevrandao: [BLOCK, "PREVRANDAO"], parentHash: [BLOCK, "PARENT_HASH"], blobBaseFee: ["2", "BLOB_BASE_FEE"] };
  const allowed = new Set(Object.values(mismatches).map((row) => row[1]));
  for (const [key, [value, expectedField]] of Object.entries(mismatches)) {
    let captured; try { validateBlockContext(canonical, { ...observed, [key]: value }); } catch (error) { captured = error; }
    assert.equal(captured?.message, "forge-replay-block-context-mismatch");
    assert.equal(captured?.contextField, expectedField);
    assert.equal(allowed.has(captured?.contextField), true);
    assert.deepEqual(Object.keys(captured).sort(), ["contextField"]);
    assert.equal(safeTerminalCode(captured), "forge-replay-block-context-mismatch");
  }
});

test("Forge execution receives a fresh capped read budget independent of exhausted qualification", async () => {
  const exhaustedQualification = { requests: 200, started: 0, limits: { requests: 200, totalTimeoutMs: 1 } }; let calls = 0;
  const execution = createForgeExecutionBudget({ transport: async ({ method }) => { calls += 1; return { result: method === "eth_chainId" ? "0x1" : null, bytes: 3 }; } });
  assert.equal(exhaustedQualification.requests, 200);
  assert.equal(execution.requests, 0);
  assert.equal(execution.started, null);
  assert.equal(execution.limits.requests, 1800);
  assert.equal(execution.limits.totalTimeoutMs, 15 * 60 * 1000);
  assert.equal(execution.limits.requestTimeoutMs, 15000);
  assert.equal(execution.limits.concurrency, 8);
  assert.equal(execution.limits.responseBytes, 16 * 1024 * 1024);
  assert.equal(execution.limits.totalResponseBytes, 512 * 1024 * 1024);
  assert.equal(await execution.call({}, "eth_chainId", []), "0x1");
  assert.equal(calls, 1);
  execution.requests = FORGE_EXECUTION_LIMITS.requests;
  await assert.rejects(() => execution.call({}, "eth_chainId", []), /request-budget-exhausted/);
  await assert.rejects(() => execution.call({}, "debug_traceTransaction", []), /not-read-only-allowlisted/);
  let now = 0; const lazy = createForgeExecutionBudget({ now: () => now, transport: async () => ({ result: "0x1", bytes: 3 }) });
  now += 60 * 60 * 1000; assert.equal(lazy.started, null);
  assert.equal(await lazy.call({}, "eth_chainId", []), "0x1"); assert.equal(lazy.started, now);
  now += 15 * 60 * 1000; await assert.rejects(() => lazy.call({}, "eth_chainId", []), /total-time-budget-exhausted/);
  assert.deepEqual({ requests: RELAY_LIMITS.requests, timeoutMs: RELAY_LIMITS.timeoutMs, requestTimeoutMs: RELAY_LIMITS.requestTimeoutMs, concurrency: RELAY_LIMITS.concurrency, responseBytes: RELAY_LIMITS.responseBytes }, { requests: 1800, timeoutMs: 15 * 60 * 1000, requestTimeoutMs: 15000, concurrency: 8, responseBytes: 16 * 1024 * 1024 });
});

function rawPrestate(after = "0x384", includeSender = true) {
  const pre = {}; const post = {};
  if (includeSender) { pre[SENDER] = { balance: "0x3e8" }; post[SENDER] = { balance: after }; }
  return { pre, post };
}

function prestateQualified(behavior) {
  const canonical = rawCanonicalView(); const families = [Symbol("family-a"), Symbol("family-b"), Symbol("family-c")];
  const rows = families.map((family, index) => ({ provider: { declaredGroup: true, family, testIndex: index }, canonical: canonical.canonical, block: canonical.raw.block, budget: {} }));
  return { canonical: canonical.canonical, selected: rows.slice(0, 2), canonicalCandidates: rows, traceBudget: { call: async (provider, method, params) => { assert.equal(method, "debug_traceTransaction"); assert.deepEqual(params, [HASH, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }]); const value = behavior[provider.testIndex]; if (value instanceof Error) throw value; return value; } } };
}

test("process-time prestate corroboration matches two families and replaces one failed family", async () => {
  const source = { hash: HASH, candidate: candidate() };
  const direct = await corroborateForgePrestate(source, prestateQualified([rawPrestate(), rawPrestate(), rawPrestate()]));
  assert.equal(direct.evidence.twoIndependentProviderPrestateMatch, true);
  assert.equal(direct.evidence.globalStateComplete, false);
  assert.equal(direct.evidence.rawTracesPersisted, false);
  assert.deepEqual(Object.keys(direct).sort(), ["evidence", "expected"]);
  const replacement = await corroborateForgePrestate(source, prestateQualified([new Error("opaque"), rawPrestate(), rawPrestate()]));
  assert.equal(replacement.evidence.twoIndependentProviderPrestateMatch, true);
});

test("process-time prestate corroboration fails on mismatch, unavailable pair, or sender sentinel defects", async () => {
  const source = { hash: HASH, candidate: candidate() };
  await assert.rejects(() => corroborateForgePrestate(source, prestateQualified([rawPrestate(), rawPrestate("0x383"), rawPrestate()])), /prestate-corroboration-mismatch/);
  await assert.rejects(() => corroborateForgePrestate(source, prestateQualified([new Error("a"), new Error("b"), new Error("c")])), /prestate-corroboration-unavailable/);
  const missing = structuredClone(source); missing.candidate.trace.normalized.prestateTracer.nativeBalanceDeltas = [{ address: EXECUTOR, before: "0", after: "1", deltaWei: "1" }];
  await assert.rejects(() => corroborateForgePrestate(missing, prestateQualified([rawPrestate(), rawPrestate(), rawPrestate()])), /prestate-corroboration-mismatch/);
  const unchanged = structuredClone(source); unchanged.candidate.trace.normalized.prestateTracer.nativeBalanceDeltas[0] = { address: SENDER, before: "1000", after: "1000", deltaWei: "0" };
  await assert.rejects(() => corroborateForgePrestate(unchanged, prestateQualified([rawPrestate(), rawPrestate(), rawPrestate()])), /prestate-corroboration-mismatch/);
});

test("Forge project and child expose only localhost relay material and sanitized inputs", async (t) => {
  const scope = forgeScope(); const source = { hash: HASH, candidate: candidate() }; let directory; let versionDirectory;
  const portableDirectory = fs.mkdtempSync(path.join(APPROVED_TEMP, "forge-portable-test-")); const portableExecutable = path.join(portableDirectory, "forge.exe"); fs.writeFileSync(portableExecutable, "test-only"); t.after(() => fs.rmSync(portableDirectory, { recursive: true, force: true }));
  const adapter = {
    version: async (options) => { versionDirectory = options.cwd; assert.equal(path.dirname(options.cwd), APPROVED_TEMP); assert.equal(options.forgeExecutable, fs.realpathSync(portableExecutable)); assert.doesNotMatch(JSON.stringify(options.env), /secret|rpc_url|endpoint|dotenv|https?:/i); return FORGE_VERSION_OUTPUT; },
    compile: async (args, options) => { assert.equal(options.cwd, versionDirectory); assert.equal(options.forgeExecutable, fs.realpathSync(portableExecutable)); assert.equal(options.timeoutMs, FORGE_BUILD_TIMEOUT_MS); assert.equal(FORGE_BUILD_TIMEOUT_MS, 5 * 60 * 1000); assert.deepEqual(args.slice(0, 2), ["build", "--root"]); assert.ok(args.includes("--offline")); assert.equal(fs.existsSync(path.join(options.cwd, "src")), true); const config = fs.readFileSync(path.join(options.cwd, "foundry.toml"), "utf8"); assert.match(config, /^optimizer = true$/m); assert.match(config, /^optimizer_runs = 200$/m); assert.match(config, /^via_ir = true$/m); return { exitCode: 0, timedOut: false }; },
    run: async (args, options) => {
      directory = options.cwd;
      assert.equal(options.cwd, versionDirectory);
      assert.equal(options.forgeExecutable, fs.realpathSync(portableExecutable));
      assert.equal(options.timeoutMs, FORGE_TEST_TIMEOUT_MS);
      assert.equal(FORGE_TEST_TIMEOUT_MS, 15 * 60 * 1000);
      assert.deepEqual(args.slice(0, 2), ["test", "--root"]);
      assert.equal(args.includes("--offline"), false);
      assert.doesNotMatch(`${args.join(" ")} ${JSON.stringify(options.env)}`, /secret|authorization|bearer|x-api-key|https?:/i);
      const input = JSON.parse(fs.readFileSync(path.join(directory, "input.json"), "utf8"));
      const project = [fs.readFileSync(path.join(directory, "foundry.toml"), "utf8"), JSON.stringify(input), fs.readFileSync(path.join(directory, "test", "ReplayHarness.t.sol"), "utf8")].join("\n");
      assert.match(project, /http:\/\/127\.0\.0\.1:8123/);
      assert.doesNotMatch(project, /upstream-secret|authorization|bearer|x-api-key|dotenv|\.env|https:\/\//i);
      assert.deepEqual(Object.keys(input).sort(), ["addresses", "sender", "targetHash", "tokens"]);
      assert.doesNotMatch(JSON.stringify(input), /calldata|private.?key|transactionInput/i);
      fs.writeFileSync(options.resultPath, JSON.stringify(forgeResult()));
      return { exitCode: 0, timedOut: false };
    },
  };
  const captured = await captureForgeReplay({ relayPort: 8123, source, scope, processAdapter: adapter, forgeExecutable: portableExecutable, environment: { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", RPC_URL: "upstream-secret", AUTHORIZATION: "upstream-secret", DOTENV_CONFIG_PATH: "C:\\workspace\\.env.secret", DOTENV_CONFIG_DATA: "upstream-secret" } });
  assert.deepEqual(captured.identity, { version: PINNED_FORGE_VERSION, commit: PINNED_FORGE_COMMIT });
  assert.equal(captured.result.logs.length, 3);
  assert.equal(fs.existsSync(directory), false);
});

test("Forge result parsing enforces state and output caps", () => {
  const result = parsedForge();
  assert.equal(result.preNative[0], "1000");
  assert.equal(result.logs.length, 3);
  assert.throws(() => parseForgeResult(Buffer.from("{}"), forgeScope()), /result-malformed/);
  assert.throws(() => parseForgeResult(Buffer.alloc(FORGE_RESULT_BYTES + 1), forgeScope()), /result-oversized/);
  assert.throws(() => parsedForge({ preNative: ["1"] }), /result-malformed/);
  assert.throws(() => parsedForge({ preTokenDecimals: ["256", "18"] }), /result-malformed/);
  assert.throws(() => parsedForge({ postTokenDecimals: ["7", "18"] }), /token-decimals-mismatch/);
  assert.throws(() => parsedForge({ logEmitters: Array(257).fill(SENDER), logTopicCounts: Array(257).fill("0"), logData: Array(257).fill("0x") }), /result-malformed/);
});

test("Forge validation fails closed on sentinel, log, nonce, prefix, and blob mismatches", async () => {
  const scope = forgeScope(); const result = parsedForge(); const snapshots = snapshotsFromForge(result, scope); const canonical = rawCanonicalView().canonical;
  assert.equal(validateTraceSentinels(candidate(), scope, snapshots, sentinelCorroboration()).changed, 1);
  const wrongPre = structuredClone(snapshots); wrongPre.pre.native[SENDER] = "999";
  assert.throws(() => validateTraceSentinels(candidate(), scope, wrongPre, sentinelCorroboration()), /prestate-mismatch/);
  const wrongPost = structuredClone(snapshots); wrongPost.post.native[SENDER] = "899";
  assert.throws(() => validateTraceSentinels(candidate(), scope, wrongPost, sentinelCorroboration()), /poststate-mismatch/);
  const unchanged = candidate(); unchanged.trace.normalized.prestateTracer.nativeBalanceDeltas[0].after = "1000";
  assert.throws(() => validateTraceSentinels(unchanged, scope, snapshots, sentinelCorroboration()), /changed-sentinel-required/);
  assert.throws(() => validateTraceSentinels(candidate(), scope, snapshots, { twoIndependentProviderPrestateMatch: false }), /prestate-corroboration-unavailable/);
  const badDelta = candidate(); badDelta.trace.normalized.prestateTracer.nativeBalanceDeltas[0].deltaWei = "-99";
  assert.throws(() => validateTraceSentinels(badDelta, scope, snapshots, sentinelCorroboration()), /sentinel-delta-mismatch/);
  const duplicate = candidate(); duplicate.trace.normalized.prestateTracer.nativeBalanceDeltas.push(structuredClone(duplicate.trace.normalized.prestateTracer.nativeBalanceDeltas[0]));
  assert.throws(() => validateTraceSentinels(duplicate, scope, snapshots, sentinelCorroboration()), /sentinel-duplicate-address/);
  const unchangedSender = candidate(); unchangedSender.trace.normalized.prestateTracer.nativeBalanceDeltas[0] = { address: SENDER, before: "1000", after: "1000", deltaWei: "0" }; unchangedSender.trace.normalized.prestateTracer.nativeBalanceDeltas.push({ address: EXECUTOR, before: "0", after: "1", deltaWei: "1" });
  assert.throws(() => validateTraceSentinels(unchangedSender, scope, snapshots, sentinelCorroboration()), /changed-sender-sentinel-required/);
  assert.throws(() => validateTraceSentinels(candidate(), scope, snapshots, null), /prestate-corroboration-unavailable/);
  assert.equal(validateReplayLogs(canonical, result.logs).count, 3);
  const wrongLogs = structuredClone(result.logs); wrongLogs[0].data = "0x01";
  assert.throws(() => validateReplayLogs(canonical, wrongLogs), /log-mismatch/);
  assert.equal(validateSenderNonce(canonical, result).status, "SENDER_NONCE_MATCHED_CANONICAL_AND_INCREMENTED_EXACTLY_ONCE");
  assert.throws(() => validateSenderNonce(canonical, { ...result, postSenderNonce: "9" }), /nonce-mismatch/);
  assert.throws(() => validateSenderNonce({ transaction: {} }, result), /canonical-nonce-missing/);
  assert.equal(validateBlockContext(canonical, result.context).status, "ALL_APPLICABLE_CANONICAL_BLOCK_CONTEXT_FIELDS_MATCH");
  assert.throws(() => validateBlockContext(canonical, { ...result.context, timestamp: "999" }), /block-context-mismatch/);
  assert.throws(() => assertForgeSourceBounds({ candidate: candidate() }, { transactionIndex: 65 }), /prefix-cap-exceeded/);
  const oversizedScope = forgeScope(); oversizedScope.addresses = Array(17).fill(SENDER);
  await assert.rejects(() => captureForgeReplay({ relayPort: 8123, source: { hash: HASH, candidate: candidate() }, scope: oversizedScope, processAdapter: {} }), /forge-replay-scope-cap-exceeded/);
  const blob = candidate(); blob.transaction.type = "3";
  assert.throws(() => assertForgeSourceBounds({ candidate: blob }, { transactionIndex: 1 }), /non-type2-unsupported/);
});

test("Forge child failure cleans temporary project and exposes fixed terminal codes", async () => {
  let directory;
  const adapter = { version: async () => FORGE_VERSION_OUTPUT, compile: async () => ({ exitCode: 0, timedOut: false }), run: async (_args, options) => { directory = options.cwd; return { exitCode: 1, timedOut: false }; } };
  await assert.rejects(() => captureForgeReplay({ relayPort: 8123, source: { hash: HASH, candidate: candidate() }, scope: forgeScope(), processAdapter: adapter }), /forge-replay-child-failed/);
  assert.equal(fs.existsSync(directory), false);
  for (const code of ["anvil-transaction-force-queue-unusable", "forge-replay-harness-compile-failed", "forge-replay-termination-unconfirmed", "forge-replay-child-failed", "forge-replay-result-malformed", "forge-replay-token-decimals-mismatch", "forge-replay-blob-base-fee-inapplicable", "forge-replay-blob-base-fee-computation-bounded", "forge-replay-non-type2-unsupported", "forge-replay-type2-canonical-invalid", "forge-replay-ethers-version-mismatch", "forge-replay-raw-transaction-local-mismatch", "forge-replay-receipt-transaction-endpoint-mismatch", "forge-replay-prestate-corroboration-unavailable", "forge-replay-prestate-corroboration-mismatch", "forge-replay-prestate-mismatch", "forge-replay-log-mismatch", "forge-replay-nonce-mismatch", "forge-replay-block-context-mismatch"]) assert.equal(safeTerminalCode(new Error(code)), code);
});

test("mock Forge timeout waits for termination outcome and cleans the project", async () => {
  let directory; let terminated = false;
  const adapter = {
    version: async () => FORGE_VERSION_OUTPUT,
    compile: async () => ({ exitCode: 0, timedOut: false }),
    run: async (_args, options) => { directory = options.cwd; await new Promise((resolve) => setTimeout(resolve, 2)); terminated = true; return { exitCode: null, timedOut: true, terminationObserved: true }; },
  };
  await assert.rejects(() => captureForgeReplay({ relayPort: 8123, source: { hash: HASH, candidate: candidate() }, scope: forgeScope(), processAdapter: adapter }), /forge-replay-timeout/);
  assert.equal(terminated, true);
  assert.equal(fs.existsSync(directory), false);
});

test("Windows Forge termination requires successful bounded taskkill and observed root exit", async () => {
  const child = () => Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null });
  const successful = child(); let seenPid;
  assert.equal(await terminateForgeProcessTree(successful, { platform: "win32", attempts: 1, attemptTimeoutMs: 5, taskkill: async (pid) => { seenPid = pid; successful.exitCode = 1; successful.emit("exit", 1); return 0; } }), true);
  assert.equal(seenPid, 4242);
  const successWithoutExit = child();
  assert.equal(await terminateForgeProcessTree(successWithoutExit, { platform: "win32", attempts: 1, attemptTimeoutMs: 2, taskkill: async () => 0 }), false);
  const failedWithExit = child();
  assert.equal(await terminateForgeProcessTree(failedWithExit, { platform: "win32", attempts: 1, attemptTimeoutMs: 2, taskkill: async () => { failedWithExit.exitCode = 1; failedWithExit.emit("exit", 1); return 1; } }), false);
  const hung = child();
  assert.equal(await terminateForgeProcessTree(hung, { platform: "win32", attempts: 1, attemptTimeoutMs: 2, taskkill: async () => new Promise(() => {}) }), false);
  const retried = child(); let attempts = 0;
  assert.equal(await terminateForgeProcessTree(retried, { platform: "win32", attempts: 2, attemptTimeoutMs: 2, taskkill: async () => { attempts += 1; if (attempts === 2) { retried.exitCode = 1; retried.emit("exit", 1); return 0; } return 1; } }), true);
  assert.equal(attempts, 2);
  const nonWindows = child();
  assert.equal(await terminateForgeProcessTree(nonWindows, { platform: "linux", attempts: 1, attemptTimeoutMs: 2, kill: (target) => { target.exitCode = 1; target.emit("exit", 1); return true; } }), true);
});

test("unconfirmed Forge termination retains an identifiable project for manual cleanup", async () => {
  let directory; let observed;
  const adapter = {
    version: async () => FORGE_VERSION_OUTPUT,
    compile: async () => ({ exitCode: 0, timedOut: false }),
    run: async (_args, options) => { directory = options.cwd; return { exitCode: null, timedOut: true, terminationObserved: false }; },
  };
  try { await captureForgeReplay({ relayPort: 8123, source: { hash: HASH, candidate: candidate() }, scope: forgeScope(), processAdapter: adapter }); } catch (error) { observed = error; }
  assert.equal(observed?.message, "forge-replay-termination-unconfirmed");
  assert.equal(observed?.cleanupDirectoryName, path.basename(directory));
  assert.match(observed.cleanupDirectoryName, /^forge-state-replay-[A-Za-z0-9_-]+$/);
  assert.equal(fs.existsSync(directory), true);
  cleanupRetainedForgeProject(observed.cleanupDirectoryName);
  assert.equal(fs.existsSync(directory), false);
  assert.throws(() => cleanupRetainedForgeProject("../unsafe"), /invalid-cleanup-identifier/);
});

test("offline Forge harness compile failure blocks execution and cleans the project", async () => {
  let directory; let ran = false;
  const adapter = { version: async () => FORGE_VERSION_OUTPUT, compile: async (_args, options) => { directory = options.cwd; return { exitCode: 1, timedOut: false }; }, run: async () => { ran = true; } };
  await assert.rejects(() => captureForgeReplay({ relayPort: 8123, source: { hash: HASH, candidate: candidate() }, scope: forgeScope(), processAdapter: adapter }), /forge-replay-harness-compile-failed/);
  assert.equal(ran, false);
  assert.equal(fs.existsSync(directory), false);
});

test("mocked Forge replay preserves source and emits endpoint-free UNKNOWN V2 evidence", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "forge-state-replay-success-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = makeDeepSource(parent); let relayClosed = 0;
  const adapter = { version: async () => FORGE_VERSION_OUTPUT, compile: async () => ({ exitCode: 0, timedOut: false }), run: async (_args, options) => { fs.writeFileSync(options.resultPath, JSON.stringify(forgeResult())); return { exitCode: 0, timedOut: false }; } };
  const qualified = rawCanonicalView();
  const result = await localStateReplay({ sourceDirectory: directory, hash: HASH,
    qualifyForgeProviders: async () => ({ provider: {}, block: qualified.raw.block, canonical: qualified.canonical, providerQualification: { independentDeclaredProviders: true, exactCanonicalViews: true, rawTransactionBytesAndHashMatched: true, localType2SerializationMatched: true, serializationEvidenceMode: "RAW_RPC_AND_LOCAL_SERIALIZATION", qualifiedCount: 2, pairChecks: 1 }, budget: { call: async () => { throw new Error("unused"); } } }),
    corroborateForgePrestate: async (source) => ({ expected: source.candidate.trace.normalized.prestateTracer.nativeBalanceDeltas, evidence: { twoIndependentProviderPrestateMatch: true, globalStateComplete: false, rawTracesPersisted: false } }),
    relayFactory: async (relayOptions) => { assert.equal(relayOptions.lazyStart, true); assert.equal(typeof relayOptions.onFirstRequest, "function"); assert.equal(relayOptions.limits.timeoutMs, 15 * 60 * 1000); return { port: 8123, stats: () => ({ requestsForwarded: 0, rejectedSendCount: 0, deniedReadMethodNames: ["eth_getAccountInfo"], deniedMutationMethodNames: ["anvil_nodeInfo"], methodOutcomes: { DENIED_READ: { deniedRead: 1 }, DENIED_MUTATION: { deniedMutation: 1 } } }), close: async () => { relayClosed += 1; } }; }, processAdapter: adapter });
  assert.equal(relayClosed, 1);
  assert.equal(result.bundle["source-binding.json"].replayTier, FORGE_REPLAY_TIER);
  assert.equal(result.bundle["replay-runtime.json"].localExecution, true);
  assert.equal(result.bundle["replay-runtime.json"].prefixReplayedByForgeTransactionFork, true);
  assert.equal(result.bundle["replay-runtime.json"].transactCount, 1);
  assert.equal(result.bundle["replay-runtime.json"].validation.logs.status, "EXACT_CANONICAL_RECEIPT_LOG_MATCH");
  assert.equal(result.bundle["replay-runtime.json"].validation.scopedPrefixStateSentinels.treatedAsCompleteState, false);
  assert.equal(result.bundle["replay-runtime.json"].validation.scopedPrefixStateSentinels.traceProjectionComplete, false);
  assert.equal(result.bundle["replay-runtime.json"].validation.scopedPrefixStateSentinels.twoIndependentProviderPrestateMatch, true);
  assert.equal(result.bundle["replay-runtime.json"].validation.scopedPrefixStateSentinels.globalStateComplete, false);
  assert.equal(result.bundle["replay-runtime.json"].validation.scopedPrefixStateSentinels.rawTracesPersisted, false);
  assert.equal(result.bundle["replay-runtime.json"].validation.blockContext.status, "ALL_APPLICABLE_CANONICAL_BLOCK_CONTEXT_FIELDS_MATCH");
  assert.equal(result.bundle["replay-runtime.json"].validation.replayGasIndependentlyEstablished, false);
  assert.equal(result.bundle["balance-deltas.json"].gas.canonicalReceiptGasAppliedOnceInAccounting, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.bundle["balance-deltas.json"].gas, "executionAndBlobChargedExactlyOnce"), false);
  assert.equal(result.bundle["economics.json"].status, "UNKNOWN");
  assert.equal(result.bundle["replay-runtime.json"].rawChildLogsPersisted, false);
  assert.deepEqual(result.bundle["replay-runtime.json"].forgeIdentity, { version: PINNED_FORGE_VERSION, commit: PINNED_FORGE_COMMIT });
  assert.equal(result.bundle["replay-runtime.json"].providerQualification.serializationEvidenceMode, "RAW_RPC_AND_LOCAL_SERIALIZATION");
  const persisted = JSON.stringify(result.bundle);
  assert.equal(persisted.includes(RAW_TRANSACTION.slice(2)), false);
  assert.equal(persisted.includes("76abd2c100ee55697658c8b868bb5726fbf1e0981425cd6a3a82477500153cdc"), false);
  assert.equal(persisted.includes("6db467168996588752db2f991f05c9c07aafb6ab418c09eaa3280fdd373e5aaa"), false);
  assert.equal(persisted.includes("12345678"), false);
  assert.equal(persisted.includes("contextField"), false);
  assert.equal(persisted.includes("deniedMutationMethodNames"), false);
  assert.equal(persisted.includes("eth_getAccountInfo"), false);
  assert.equal(persisted.includes("anvil_nodeInfo"), false);
  assert.doesNotMatch(persisted, /forge\.exe|ATOMIC_FORGE_EXECUTABLE|dotenv|\.env/i);
  assert.doesNotMatch(JSON.stringify(result.bundle), /eth_processLocalOnly|endpoint|authorization|calldata/i);
  assert.doesNotThrow(() => leakScan(result.bundle));
  assert.deepEqual(assertReplaySourceUnchanged(result.source), result.source.before);
});
