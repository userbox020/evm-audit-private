"use strict";

// Offline regression checks for the observed refresh/deadline failure modes.
// All provider/refresh work is injected; no CLI, captures, inventory or writes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface } = require("ethers");
const topology = require("../scan-aave-v4-hubs");
const borrower = require("../scan-aave-v4-spoke-borrowers");
const watch = require("../watch-aave-v4-liquidation-triggers");
const { CollectionError } = require("../lib/aave-v4-pinned-collection");

const NOW = Date.parse("2026-10-18T04:00:00Z");
const HASH = "0x" + "12".repeat(32);
const SPOKE = "0x" + "11".repeat(20);
const USER = "0x" + "22".repeat(20);
const WAD = 10n ** 18n;
const ABI = new Interface([
  "function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserReserveStatus(uint256,address) view returns(bool,bool)",
  "function getUserSuppliedAssets(uint256,address) view returns(uint256)",
  "function getUserTotalDebt(uint256,address) view returns(uint256)",
  "function getLiquidationBonus(uint256,address,uint256) view returns(uint256)",
]);

function pin(reads) {
  return { schema: "aave-v4-state-pin/v1", chainId: 1, finality: "finalized", blockNumber: 100,
    blockHash: HASH, terminalBlockNumber: 100, terminalBlockHash: HASH, stateReadsPinned: reads };
}

function topologyFixture(ageMs = 0) {
  const registry = topology.loadAaveV4EthereumRegistry();
  const hubs = registry.hubs.map(hub => ({ ...hub, assetCountReadOk: true, assetCount: 0, assetScanTruncated: false, assets: [] }));
  hubs[0].assetCount = 1;
  hubs[0].assets = [{ assetId: 0, spokeDirectory: { count: 1, truncated: false, error: null, rows: [{
    address: SPOKE, listed: true, listedError: null, config: { error: null },
    reserve: { reserveId: 0, reserveIdError: null, errors: {},
      reserve: { hub: hubs[0].address, assetId: "0", underlying: null }, oracleData: { spoke: SPOKE, errors: {} } },
  }] } }];
  const sourceCoverage = topology.buildTopologySourceCoverage(hubs, registry);
  sourceCoverage.observationPin = pin(sourceCoverage.stateReadsAttempted);
  return { generatedAt: new Date(NOW - ageMs).toISOString(), sourceCoverage };
}

function borrowerFixture(source) {
  const sourceCoverage = borrower.buildSourceCoverage({
    upstreamCoverage: source.sourceCoverage, topologyGeneratedAt: source.generatedAt,
    chainsExpected: 1, chainsObserved: 1, spokesObserved: 1,
    observedRange: { fromBlock: 0, toBlock: 100 }, historyScope: "GENESIS_TO_TIP", fullHistoryProven: true,
    logChunksAttempted: 1, logChunksSucceeded: 1, logChunksFailed: 0,
    discoveredBorrowers: 1, checkedBorrowers: 1, accountReadsAttempted: 1, accountReadsSucceeded: 1,
    accountReadsFailed: 0, reserveReadsAttempted: 1, reserveReadsSucceeded: 1, reserveReadsFailed: 0,
    observationPin: pin(2), truncationLimit: 10000, wasTruncated: false,
  }, NOW);
  return { generatedAt: new Date(NOW).toISOString(), sourceCoverage };
}

function scoringFixture({ supplied = 0n, collateral = false, bonusError = null, debtError = null, allowedPages = Infinity } = {}) {
  const calls = [];
  let pageChecks = 0;
  function evaluate({ data }) {
    const decoded = ABI.parseTransaction({ data });
    calls.push(decoded);
    if (decoded.name === "getLiquidationBonus" && bonusError) throw new CollectionError(bonusError);
    if (decoded.name === "getUserTotalDebt" && debtError) throw new CollectionError(debtError);
    const values = {
      getUserAccountData: [0, WAD, 2n * WAD, WAD, WAD, collateral ? 1 : 0, 1],
      getUserReserveStatus: [collateral, true], getUserSuppliedAssets: [supplied],
      getUserTotalDebt: [WAD], getLiquidationBonus: [10500],
    };
    return ABI.encodeFunctionResult(decoded.name, values[decoded.name]);
  }
  const provider = {
    call: async tx => evaluate(tx),
    callMany: async transactions => transactions.map(tx => {
      try { return { value: evaluate(tx) }; } catch (error) { return { error: error.code }; }
    }),
  };
  const context = { provider, canCollect: () => ++pageChecks <= allowedPages };
  const spoke = { hub: "fixture", spoke: SPOKE, linkedAssets: [{ reserve: { reserveId: 0 }, assetId: 0, decimals: 18, priceUsd: 1 }] };
  return { context, spoke, calls };
}

test("existing 600-second expiry and 300-second scan headroom stay strict", () => {
  assert.equal(borrower.TOPOLOGY_MAX_AGE_MS, 600000);
  assert.equal(watch.TOPOLOGY_SCAN_HEADROOM_MS, 300000);
  assert.equal(watch.topologyUsable(topologyFixture(300000), NOW, 300000), true);
  assert.equal(watch.topologyUsable(topologyFixture(300001), NOW, 300000), false);
  assert.equal(watch.topologyUsable(topologyFixture(600001), NOW), false);
  assert.equal(watch.topologyUsable(topologyFixture(-60001), NOW), false);
});

test("a thrown topology refresh cannot reuse even a still-warm complete borrower proof", () => {
  const source = topologyFixture(300001);
  const cached = borrowerFixture(source);
  assert.equal(cached.sourceCoverage.complete, true);
  let runs = 0;
  const status = watch.refreshTopologyIfNeeded({ nowMs: NOW, load: () => source,
    run: () => { runs += 1; throw new Error("PRIVATE_FIXTURE_DETAIL"); } });
  const coverage = watch.sourceCoverageForArtifact(cached, { nowMs: NOW, ...status, topologyRefreshError: status.error });
  assert.equal(runs, 1);
  assert.equal(status.error, "topology-refresh-failed");
  assert.equal(coverage.complete, false);
  assert.equal(coverage.sampleComplete, false);
  assert.ok(coverage.errors.includes("topology-refresh-failed"));
  assert.doesNotMatch(JSON.stringify(coverage), /PRIVATE_FIXTURE_DETAIL/);
});

test("refresh failure then genuine recovery is per-cycle; cached timestamps are never redated", () => {
  let source = topologyFixture(600001);
  const cached = borrowerFixture(topologyFixture());
  const originalTimestamp = cached.generatedAt;
  const failed = watch.refreshTopologyIfNeeded({ nowMs: NOW, afterNowMs: NOW, load: () => source, run: () => {} });
  assert.equal(failed.error, "topology-refresh-incomplete");
  const invalid = watch.sourceCoverageForArtifact(cached, { nowMs: NOW, ...failed, topologyRefreshError: failed.error });
  assert.equal(invalid.complete, false);
  assert.ok(invalid.errors.includes("topology-refresh-incomplete"));
  const recovered = watch.refreshTopologyIfNeeded({ nowMs: NOW, afterNowMs: NOW, load: () => source,
    run: () => { source = topologyFixture(); } });
  assert.equal(recovered.topologyRefreshOk, true);
  const fresh = borrowerFixture(source);
  assert.equal(watch.sourceCoverageForArtifact(fresh, { nowMs: NOW, ...recovered }).complete, true);
  assert.equal(cached.generatedAt, originalTimestamp);
});

test("a long refresh is checked at completion, never against its starting clock", () => {
  let source = topologyFixture(600001);
  const status = watch.refreshTopologyIfNeeded({ nowMs: NOW, afterNowMs: NOW + 300001,
    load: () => source, run: () => { source = topologyFixture(); } });
  assert.equal(status.topologyRefreshOk, false);
  assert.equal(status.error, "topology-refresh-incomplete");
});

test("direct and batch paths skip optional bonus only for proven empty/non-collateral positions", async () => {
  for (const batchReads of [false, true]) for (const eligibility of [{ supplied: 0n, collateral: true }, { supplied: WAD, collateral: false }]) {
    const f = scoringFixture(eligibility);
    const result = await borrower.scanIndexedSpoke(f.context, f.spoke, [{ user: USER }], { batchReads, pageSize: 1, remainingUsers: 1 });
    assert.equal(result.reserveReadsAttempted, 1);
    assert.equal(result.reserveReadsSucceeded, 1);
    assert.equal(result.reserveReadsFailed, 0);
    assert.equal(result.optionalReserveReadsAttempted, 0);
    assert.equal(f.calls.filter(call => call.name === "getLiquidationBonus").length, 0);
    for (const name of ["getUserReserveStatus", "getUserSuppliedAssets", "getUserTotalDebt"]) {
      assert.equal(f.calls.filter(call => call.name === name).length, 1);
    }
  }
});

test("nonzero supplied collateral exercises the real optional bonus in both scoring paths", async () => {
  for (const batchReads of [false, true]) {
    const f = scoringFixture({ supplied: WAD, collateral: true });
    const result = await borrower.scanIndexedSpoke(f.context, f.spoke, [{ user: USER }], { batchReads, pageSize: 1, remainingUsers: 1 });
    const bonus = f.calls.filter(call => call.name === "getLiquidationBonus");
    assert.equal(bonus.length, 1);
    assert.equal(bonus[0].args[2], WAD);
    assert.equal(result.optionalReserveReadsAttempted, 1);
    assert.equal(result.optionalReserveReadsSucceeded, 1);
    assert.equal(result.topUsers[0].reserves[0].liquidationBonusBps, 10500);
  }
});

test("optional EVM revert and transport/budget failure stay distinct without hiding required-read failures", async () => {
  for (const batchReads of [false, true]) for (const code of ["CALL_EXCEPTION", "RPC_TRANSPORT", "COLLECTION_BUDGET_EXHAUSTED"]) {
    const f = scoringFixture({ supplied: WAD, collateral: true, bonusError: code });
    const result = await borrower.scanIndexedSpoke(f.context, f.spoke, [{ user: USER }], { batchReads, pageSize: 1, remainingUsers: 1 });
    assert.equal(result.optionalReserveReadsAttempted, 1);
    assert.equal(result.optionalReserveReadsSucceeded, 0);
    assert.equal(result.optionalReserveReadsReverted, code === "CALL_EXCEPTION" ? 1 : 0);
    assert.equal(result.optionalReserveReadsFailed, code === "CALL_EXCEPTION" ? 0 : 1);
    assert.equal(result.reserveReadsFailed, code === "CALL_EXCEPTION" ? 0 : 1);
  }
});

test("zero collateral never exempts required core reserve reads from failure accounting", async () => {
  for (const batchReads of [false, true]) {
    const f = scoringFixture({ debtError: "RPC_TRANSPORT" });
    const result = await borrower.scanIndexedSpoke(f.context, f.spoke, [{ user: USER }], { batchReads, pageSize: 1, remainingUsers: 1 });
    assert.equal(result.reserveReadsAttempted, 1);
    assert.equal(result.reserveReadsFailed, 1);
    assert.equal(result.optionalReserveReadsAttempted, 0);
  }
});

test("a stopped collection page preserves undispatched users as explicit incomplete enumeration", async () => {
  const f = scoringFixture({ allowedPages: 1 });
  const result = await borrower.scanIndexedSpoke(f.context, f.spoke, [{ user: USER }, { user: "0x" + "33".repeat(20) }],
    { batchReads: true, pageSize: 1, remainingUsers: 2 });
  assert.equal(result.usersDiscovered, 2);
  assert.equal(result.usersScored, 1);
  assert.equal(result.wasTruncated, true);
  assert.equal(result.pagesChecked, 1);
});
