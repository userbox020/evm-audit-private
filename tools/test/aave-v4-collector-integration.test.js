"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface } = require("ethers");
const topology = require("../scan-aave-v4-hubs");
const borrower = require("../scan-aave-v4-spoke-borrowers");
const history = require("../lib/aave-v4-borrower-history");
const watch = require("../watch-aave-v4-liquidation-triggers");
const { openPinnedCollection, CollectionError } = require("../lib/aave-v4-pinned-collection");
const { REVIEWED_OPERATOR_FAMILY_IDS } = require("../lib/common-finalized-rpc-preflight");
const { validateAaveSourceCoverageEnvelope } = require("../aave-source-coverage");
const NOW = Date.parse("2026-09-20T20:00:00Z");
const SPOKE = "0x" + "11".repeat(20);
const word = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const account = n => "0x" + n.toString(16).padStart(40, "0");
const ABI = new Interface([
  "function multicall(bytes[]) returns(bytes[])",
  "function getAssetCount() view returns(uint256)",
  "function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserReserveStatus(uint256,address) view returns(bool,bool)",
  "function getUserSuppliedAssets(uint256,address) view returns(uint256)",
  "function getUserTotalDebt(uint256,address) view returns(uint256)",
  "function getLiquidationBonus(uint256,address,uint256) view returns(uint256)",
]);
function header(n) { return { number: "0x" + n.toString(16), hash: word(n + 1), parentHash: word(n), stateRoot: word(900), timestamp: "0x" + (NOW / 1000 - 600).toString(16) }; }
function makeRpc({ users = 25, failUser = null, terminalMismatch = false, bonusRevertUser = null } = {}) {
  const seen = new Set();
  const calls = [];
  let corrupt = false;
  const logs = Array.from({ length: users }, (_, index) => {
    const user = account(index + 100);
    const event = history.BORROW.encodeEventLog(history.BORROW.getEvent("Borrow"), [0, user, user, 1, 1]);
    return { address: SPOKE, topics: event.topics, data: event.data, blockNumber: "0x1", blockHash: word(2), transactionHash: word(index + 1000), logIndex: "0x" + index.toString(16), removed: false };
  });
  const rpc = async (handle, method, params) => {
    calls.push({ method, params });
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") {
      const result = header(params[0] === "finalized" ? 100 : Number(BigInt(params[0])));
      return corrupt ? { ...result, hash: word(777) } : result;
    }
    if (method === "eth_getLogs") {
      if (params[0].blockHash) return [];
      return logs.filter(row => Number(row.blockNumber) >= Number(BigInt(params[0].fromBlock)) && Number(row.blockNumber) <= Number(BigInt(params[0].toBlock)));
    }
    assert.deepEqual(params.at(-1), { blockHash: word(101), requireCanonical: true });
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getStorageAt") return word(0);
    return evaluate(params[0].data);
  };
  function evaluate(data) {
    const decoded = ABI.parseTransaction({ data });
    if (decoded.name === "multicall") return ABI.encodeFunctionResult(decoded.name, [Array.from(decoded.args[0], evaluate)]);
    if (decoded.name === "getAssetCount") return ABI.encodeFunctionResult(decoded.name, [0]);
    if (decoded.name === "getUserAccountData") {
      const user = decoded.args[0].toLowerCase(); seen.add(user);
      if (terminalMismatch) corrupt = true;
      if (user === failUser) throw new CollectionError("RPC_TRANSPORT");
      return ABI.encodeFunctionResult(decoded.name, [0, 10n ** 18n, 2n * 10n ** 18n, 0, 1, 1, 1]);
    }
    // The optional-bonus fixture must actually have enabled, positive collateral.
    if (decoded.name === "getUserReserveStatus") return ABI.encodeFunctionResult(decoded.name, [decoded.args[1].toLowerCase() === bonusRevertUser, true]);
    if (decoded.name === "getUserSuppliedAssets" && decoded.args[1].toLowerCase() === bonusRevertUser) return ABI.encodeFunctionResult(decoded.name, [10n ** 18n]);
    if (decoded.name === "getLiquidationBonus" && decoded.args[1].toLowerCase() === bonusRevertUser) throw new CollectionError("CALL_EXCEPTION");
    return ABI.encodeFunctionResult(decoded.name, [decoded.name === "getLiquidationBonus" ? 10499 : decoded.name === "getUserTotalDebt" ? 10n ** 18n : 0]);
  }
  return { seen, calls, collectionOptions: { rpc, candidates: [0, 1].map(i => ({ handle: "fixture-" + i, operatorFamily: REVIEWED_OPERATOR_FAMILY_IDS[i] })) } };
}

function topologyArtifact() {
  const registry = topology.loadAaveV4EthereumRegistry();
  const hubs = registry.hubs.map(row => ({ ...row, assetCountReadOk: true, assetCount: 0, assetScanTruncated: false, assets: [], listedSpokeDependencies: [] }));
  const reserve = { reserveId: 0, reserveIdError: null, errors: {}, reserve: { hub: hubs[0].address, assetId: "0", underlying: null }, oracleData: { spoke: SPOKE, errors: {} } };
  hubs[0].assetCount = 1;
  hubs[0].assets = [{ assetId: 0, decimals: 18, priceUsd: 1, status: "ok", spokeDirectory: { count: 1, truncated: false, error: null, rows: [{ address: SPOKE, listed: true, listedError: null, config: { error: null }, reserve }] } }];
  // Deliberately below the old minimum-debt filter: full enumeration must include it.
  hubs[0].listedSpokeDependencies = [{ address: SPOKE, totalAddedAssetsUsd: 1, totalOwedUsd: 1, linkedAssets: [{ assetId: 0, symbol: "TEST", reserve }] }];
  const coverage = topology.buildTopologySourceCoverage(hubs, registry);
  coverage.observationPin = { schema: "aave-v4-state-pin/v1", chainId: 1, finality: "finalized", blockNumber: 100, blockHash: word(101), stateReadsPinned: coverage.stateReadsAttempted, terminalBlockNumber: 100, terminalBlockHash: word(101) };
  return { generatedAt: new Date(NOW - 1000).toISOString(), hubs, sourceCoverage: coverage };
}
function store() {
  const state = { value: null, saves: 0 };
  return { state, load: identity => state.value || history.emptyHistory(identity), save: value => { state.value = structuredClone(value); state.saves += 1; } };
}

test("topology collector emits an executed finalized pin only after terminal agreement", async () => {
  const f = makeRpc({ users: 0 });
  const result = await topology.collectTopology({
    now: () => NOW, collectionOptions: f.collectionOptions, fetchPrices: async () => ({}),
    scanHub: async (_provider, hub) => ({ ...hub, assetCountReadOk: true, assetCount: 0, assetScanTruncated: false, assets: [], listedSpokeDependencies: [], sourceVerified: false,
      totals: { cashUsd: 0, totalOwedUsd: 0, reviewCandidates: 0, watchCandidates: 0, routePositive: 0 } }),
  });
  assert.equal(result.sourceCoverage.sampleComplete, true);
  assert.equal(result.sourceCoverage.complete, false);
  assert.equal(result.sourceCoverage.observationPin.stateReadsPinned, 4);
  assert.equal(result.sourceCoverage.observationPin.blockHash, word(101));
  assert.equal(watch.topologyUsable(result, NOW), true);
});

test("all historical users across multiple pages are checked at the topology pin, including low-debt spokes", async () => {
  const f = makeRpc(); const cache = store();
  const result = await borrower.collectBorrowers(topologyArtifact(), { now: () => NOW, collectionOptions: f.collectionOptions, historyStore: cache, pageSize: 20 });
  assert.equal(result.complete, true);
  assert.equal(result.sourceCoverage.fullHistoryProven, true);
  assert.equal(result.history.complete, true);
  assert.equal(result.summary.usersDiscovered, 25);
  assert.equal(result.summary.usersScored, 25);
  assert.equal(result.spokes[0].pagesChecked, 2);
  assert.equal(result.spokes[0].topUsers.length, 20, "display cap does not drop checked users");
  assert.equal(f.seen.size, 25);
  assert.equal(result.sourceCoverage.excludedSpokes.length, 0);
  assert.equal(result.sourceCoverage.observationPin.blockHash, word(101));
  assert.equal(validateAaveSourceCoverageEnvelope(result.sourceCoverage, { protocolVersion: "V4", coverageKind: "borrower-scan" }).valid, true);
  assert.equal(cache.state.saves, 1);
  assert.deepEqual(result.sourceCoverage.promotionClosure, { eligible: false, routePositive: false, executableNow: false, signedActionJustified: false });
});

test("partial history and borrower budgets remain explicit incomplete observations", async () => {
  for (const options of [{ historyOptions: { maxChunks: 1, chunkSize: 1 } }, { maxUsers: 5 }]) {
    const f = makeRpc(); const cache = store();
    const result = await borrower.collectBorrowers(topologyArtifact(), { now: () => NOW, collectionOptions: f.collectionOptions, historyStore: cache, ...options });
    assert.equal(result.complete, false);
    assert.equal(result.sourceCoverage.sampleComplete, false);
    assert.ok(result.history.complete === false || result.summary.usersScored < result.summary.usersDiscovered);
    assert.equal(result.sourceCoverage.promotionEligible, false);
  }
});

test("a terminal mismatch publishes neither a result nor a history checkpoint", async () => {
  const f = makeRpc({ terminalMismatch: true }); const cache = store();
  await assert.rejects(borrower.collectBorrowers(topologyArtifact(), { now: () => NOW, collectionOptions: f.collectionOptions, historyStore: cache }), { code: "TERMINAL_PIN_MISMATCH" });
  assert.equal(cache.state.saves, 0);
});

test("failed account reads and userless positive debt cannot claim exhaustive coverage", async () => {
  for (const configuration of [{ failUser: account(100) }, { users: 0 }]) {
    const f = makeRpc(configuration); const cache = store();
    const result = await borrower.collectBorrowers(topologyArtifact(), { now: () => NOW, collectionOptions: f.collectionOptions, historyStore: cache });
    assert.equal(result.complete, false);
    assert.equal(result.sourceCoverage.sampleComplete, false);
    assert.ok(result.sourceCoverage.errors.includes(configuration.users === 0 ? "borrower-history-debt-unaccounted" : "account-read-failed"));
  }
});

test("unpinned cached topology is rejected before inventory or transport access", async () => {
  const source = topologyArtifact(); delete source.sourceCoverage.observationPin;
  let opened = false;
  await assert.rejects(borrower.collectBorrowers(source, { now: () => NOW, openCollection: async () => { opened = true; } }), /topology-pin-missing/);
  assert.equal(opened, false);
  assert.equal(watch.topologyUsable(source, NOW), false);
});

test("batched and direct scoring agree, including an isolated optional bonus revert", async () => {
  const outputs = [];
  for (const batchReads of [false, true]) {
    const f = makeRpc({ bonusRevertUser: account(117) });
    outputs.push(await borrower.collectBorrowers(topologyArtifact(), { now: () => NOW, collectionOptions: f.collectionOptions,
      historyStore: store(), pageSize: 20, maxUsers: 10000, batchReads }));
  }
  assert.equal(outputs[1].complete, true);
  assert.equal(outputs[1].summary.optionalReserveReadsReverted, 1);
  assert.deepEqual(outputs[1].summary, outputs[0].summary);
  assert.deepEqual(outputs[1].spokes, outputs[0].spokes);
  assert.deepEqual(outputs[1].sourceCoverage, outputs[0].sourceCoverage);
  assert.ok(outputs[1].collection.networkCalls < outputs[0].collection.networkCalls);
});

test("a population above the old 2048-user default finishes within a small physical request budget", async () => {
  const f = makeRpc({ users: 2053 });
  const result = await borrower.collectBorrowers(topologyArtifact(), { now: () => NOW,
    collectionOptions: { ...f.collectionOptions, limits: { maxRequests: 384 } }, historyStore: store(), batchReads: true });
  assert.equal(result.complete, true);
  assert.equal(result.summary.usersDiscovered, 2053);
  assert.equal(result.summary.usersScored, 2053);
  assert.equal(result.summary.reserveReadsSucceeded, 2053);
  assert.equal(result.summary.paginationComplete, true);
  assert.equal(result.query.maxUsersPerPass, 10000);
  assert.ok(result.collection.networkCalls <= 384);
  assert.equal(result.sourceCoverage.observationPin.stateReadsPinned, 4106);
  assert.equal(result.collection.stateTransportFailures, 0);
  const watching = watch.summarizeBorrowers(result, { nowMs: NOW });
  assert.equal(watching.sourceCoverage.complete, true);
});

test("batching preserves required-read failures, explicit user caps and terminal mismatch rejection", async () => {
  for (const mode of ["account", "cap", "terminal"]) {
    const f = makeRpc({ failUser: mode === "account" ? account(117) : null, terminalMismatch: mode === "terminal" });
    const cache = store();
    const result = borrower.collectBorrowers(topologyArtifact(), { now: () => NOW, collectionOptions: f.collectionOptions,
      historyStore: cache, batchReads: true, ...(mode === "cap" ? { maxUsers: 5 } : {}) });
    if (mode === "terminal") {
      await assert.rejects(result, { code: "TERMINAL_PIN_MISMATCH" }); assert.equal(cache.state.saves, 0);
    } else {
      const output = await result;
      assert.equal(output.complete, false);
      assert.equal(output.sourceCoverage.promotionEligible, false);
      assert.ok(output.sourceCoverage.errors.includes(mode === "cap" ? "borrower-pagination-incomplete" : "account-read-failed"));
    }
  }
});
