"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface } = require("ethers");
const { collectTopology } = require("../scan-aave-v4-hubs");

const ABI = new Interface(["function getAssetCount() view returns(uint256)"]);
const NOW = Date.parse("2026-09-20T20:00:00Z");
const ORDER = ["REGISTRY", "PIN_QUALIFICATION", "ASSET_ENUMERATION", "PRICE_LOOKUP", "HUB_1", "HUB_2", "HUB_3", "HUB_4", "DEPENDENCY_METADATA", "COVERAGE_VALIDATION", "PIN_CONFIRMATION", "COMPLETE"];
function fixture(extra = {}) {
  const seen = [];
  let hubs = 0;
  const context = {
    pin: { number: 100, hash: "0x" + "01".repeat(32), stateRoot: "0x" + "02".repeat(32), timestamp: NOW / 1000 },
    provider: { call: async () => ABI.encodeFunctionResult("getAssetCount", [0]) },
    confirmPin: async () => {}, observationPin: () => null,
    statistics: () => ({ networkCalls: 0 }),
  };
  const dependencies = {
    now: () => NOW,
    openCollection: async () => context,
    fetchPrices: async () => ({}),
    scanHub: async (_provider, hub) => {
      hubs += 1;
      return { ...hub, assetCountReadOk: true, assetCount: 0, assetScanTruncated: false,
        assets: [], listedSpokeDependencies: [], sourceVerified: false,
        totals: { cashUsd: 0, totalOwedUsd: 0, reviewCandidates: 0, watchCandidates: 0, routePositive: 0 } };
    },
    ...extra,
  };
  return { dependencies, context, seen, onDiagnosticStage: stage => seen.push(stage), get hubs() { return hubs; } };
}

test("opt-in stage callback tracks the real fixture flow without changing collector output", async () => {
  const baseline = fixture();
  const expected = await collectTopology(baseline.dependencies);
  const observed = fixture();
  const actual = await collectTopology({ ...observed.dependencies, onDiagnosticStage: observed.onDiagnosticStage });
  assert.deepEqual(actual, expected);
  assert.deepEqual(observed.seen, ORDER);
  assert.equal(observed.hubs, 4);
  assert.equal(actual.sourceCoverage.sampleComplete, true);
  assert.equal(actual.sourceCoverage.complete, false);
  assert.equal(actual.collection.diagnosticStage, "COMPLETE");
  assert.equal(actual.collection.metadata.viewsSkippedForBudget, 0);
});

test("hook exceptions are ignored without changing output or control flow", async () => {
  const plain = fixture();
  const hooked = fixture();
  const expected = await collectTopology(plain.dependencies);
  const actual = await collectTopology({ ...hooked.dependencies, onDiagnosticStage: () => { throw new Error("fixture-hook-private-value"); } });
  assert.deepEqual(actual, expected);
  assert.equal(hooked.hubs, 4);
});

test("actual failures stop at the entered stage; callback never receives collector objects", async () => {
  const scenarios = [
    ["PIN_QUALIFICATION", f => ({ openCollection: async () => { throw new Error("fixture-pin"); } })],
    ["PRICE_LOOKUP", f => ({ fetchPrices: async () => { throw new Error("fixture-prices"); } })],
    ["HUB_4", f => ({ scanHub: async (...args) => { if (++f.calls === 4) throw new Error("fixture-hub"); return f.dependencies.scanHub(...args); } })],
    ["PIN_CONFIRMATION", f => { f.context.confirmPin = async () => { throw new Error("fixture-terminal"); }; return {}; }],
  ];
  for (const [stage, alter] of scenarios) {
    const f = fixture(); f.calls = 0;
    await assert.rejects(collectTopology({ ...f.dependencies, ...alter(f),
      onDiagnosticStage: (...args) => { assert.equal(args.length, 1); assert.equal(typeof args[0], "string"); f.seen.push(args[0]); },
    }));
    assert.equal(f.seen.at(-1), stage);
    assert.deepEqual(f.seen, ORDER.slice(0, ORDER.indexOf(stage) + 1));
  }
});
