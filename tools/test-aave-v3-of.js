"use strict";

// Offline suite for the Aave V3 reserve-oracle (O) and flash-liquidity/fee (F)
// vertical on Ethereum and Base. No network: binder schema, fire predicates,
// universe enablement, validator, wiring, and scenario-assertion checks only.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const of = require("./scan-aave-v3-of");
const coverage = require("./audit-trigger-coverage-universe");
const watch = require("./run-profit-trigger-watch");
const bridge = require("./run-trigger-fork-poc");
const autopilot = require("./trigger-fork-autopilot");
const dispatcher = require("./monitor-alert-dispatcher");

const ROOT = path.resolve(__dirname, "..");
const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));

const ROWS = Object.freeze([
  Object.freeze({ id: "ethereum-aave-v3-o", chainId: 1, triggerClass: "O" }),
  Object.freeze({ id: "ethereum-aave-v3-f", chainId: 1, triggerClass: "F" }),
  Object.freeze({ id: "base-aave-v3-o", chainId: 8453, triggerClass: "O" }),
  Object.freeze({ id: "base-aave-v3-f", chainId: 8453, triggerClass: "F" }),
]);
const PRODUCERS = Object.freeze(["aave-v3-eth-reserve-watch", "aave-v3-base-reserve-watch"]);

function syntheticArtifact(config, triggerClass) {
  return {
    schema: triggerClass === "O" ? "aave-v3-reserve-observation/v1" : "aave-v3-flash-observation/v1",
    chainId: config.chainId,
    observedAt: new Date().toISOString(),
    pin: { number: 1, hash: `0x${"1".repeat(64)}`, timestamp: new Date().toISOString() },
    reservesObserved: 5,
    historyStartBound: { block: config.deployBlock, proven: true },
  };
}

test("Aave V3 O/F binders map the four enabled universe rows", () => {
  for (const row of ROWS) {
    const universeRows = UNIVERSE.rows.filter((item) => item.id === row.id);
    assert.equal(universeRows.length, 1);
    assert.equal(universeRows[0].onFire.enabled, true);
    assert.equal(universeRows[0].chainId, row.chainId);
    assert.equal(universeRows[0].triggerClass, row.triggerClass);
    assert.equal(universeRows[0].artifactPath, `reports/monitor/trigger-coverage/aave-v3-${row.chainId === 1 ? "ethereum" : "base"}-${row.triggerClass.toLowerCase()}.json`);
    const config = of.chainConfig(row.chainId);
    const artifact = syntheticArtifact(config, row.triggerClass);
    const reads = { attempted: 10, succeeded: 10, failed: 0, unclassifiedFailures: 0 };
    const binder = of.binderFor(config, row.triggerClass, artifact, reads, []);
    const shape = coverage.genericEvidenceShape(binder, universeRows[0]);
    assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
      && shape.stagesWired && shape.complete && shape.dispatchEnabled, true, row.id);
    assert.deepEqual(binder.blockers, []);
    // A read failure must block completion.
    const incomplete = of.binderFor(config, row.triggerClass, artifact, { attempted: 10, succeeded: 9, failed: 1, unclassifiedFailures: 0 }, []);
    assert.equal(coverage.genericEvidenceShape(incomplete, universeRows[0]).complete, false);
  }
});

test("Aave V3 O fire predicate catches invalid price, invalid answer, and extreme staleness", () => {
  const config = of.chainConfig(1);
  const metadata = new Map([
    ["0xaaa", { timestamped: true, updatedAtRaw: "1000", latestAnswerRaw: "100" }],
    ["0xbbb", { timestamped: true, updatedAtRaw: "1000", latestAnswerRaw: "0" }],
    ["0xccc", { timestamped: true, updatedAtRaw: "1", latestAnswerRaw: "100" }],
  ]);
  const rows = [
    { asset: "0xaaa", assetPriceRaw: "0", source: "0xs1" },
    { asset: "0xbbb", assetPriceRaw: "100", source: "0xs2" },
    { asset: "0xccc", assetPriceRaw: "100", source: "0xs3" },
  ];
  const anomalies = of.reserveAnomalies(rows, metadata, 2000n, { ...config, maxSourceAgeSeconds: 500 });
  assert.deepEqual(anomalies.map((a) => a.reason).sort(), ["invalid-aave-price", "invalid-source-answer", "stale-source"]);
  assert.equal(anomalies.find((a) => a.reason === "stale-source").ageSeconds, 1999);
  // A healthy set yields no anomaly.
  assert.deepEqual(of.reserveAnomalies([{ asset: "0xaaa", assetPriceRaw: "100", source: "0xs1" }], metadata, 1100n, config), []);
});

test("Aave V3 F fire predicate catches premium drift and zero liquidity", () => {
  const baseline = { total: "5", toProtocol: "10000" };
  assert.deepEqual(of.flashAnomalies("5", "10000", baseline, [{ asset: "0xa", liquidityRaw: "1" }]), []);
  const drift = of.flashAnomalies("10", "10000", baseline, [{ asset: "0xa", liquidityRaw: "1" }]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].reason, "premium-total-changed");
  const zero = of.flashAnomalies("5", "10000", baseline, [{ asset: "0xb", liquidityRaw: "0" }]);
  assert.equal(zero.length, 1);
  assert.equal(zero[0].reason, "zero-flash-liquidity");
});

test("Aave V3 chain configs pin the verified deployment bounds and oracle", () => {
  assert.equal(of.chainConfig(1).deployBlock, 16291127);
  assert.equal(of.chainConfig(1).codeAbsentBlock, 16291126);
  assert.equal(of.chainConfig(1).oraclePinned.toLowerCase(), "0x54586be62e3c3580375ae3723c145253060ca0c2");
  assert.equal(of.chainConfig(8453).deployBlock, 2357134);
  assert.equal(of.chainConfig(8453).codeAbsentBlock, 2357133);
  assert.equal(of.chainConfig(8453).oraclePinned.toLowerCase(), "0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156");
  assert.equal(of.chainConfig(1).pool, "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2");
  assert.equal(of.chainConfig(8453).pool, "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
});

test("Aave V3 producers are wired through watch, bridge, autopilot, and dispatcher", () => {
  for (const id of PRODUCERS) {
    assert.equal(watch.PRODUCER_IDS.includes(id), true);
    assert.deepEqual([...watch.SUCCESS_STATUSES[id]], ["NO_CHANGE", "ATOMIC_FORK_REQUIRED"]);
    assert.equal(autopilot.SUPPORTED_EVENTS.get(id), "ATOMIC_FORK_REQUIRED");
    assert.equal(autopilot.CROSS_VENUE_PRODUCERS.has(id), true);
    assert.equal(dispatcher.FORK_PROMOTION_PRODUCERS.includes(id), true);
  }
  assert.equal(bridge.FIXED_CHAIN["aave-v3-eth-reserve-watch"], 1);
  assert.equal(bridge.FIXED_CHAIN["aave-v3-base-reserve-watch"], 8453);
});

test("Aave V3 producer evidence validates the anomaly envelope", () => {
  const base = {
    chainId: 1, blockNumberRaw: "1", blockHash: `0x${"c".repeat(64)}`, blockTimestamp: new Date().toISOString(),
    routeCount: 5, failedCount: 0, firedCount: 0, candidate: null,
  };
  assert.equal(watch.validateEvidence("aave-v3-eth-reserve-watch", "NO_CHANGE", base), true);
  assert.equal(watch.validateEvidence("aave-v3-eth-reserve-watch", "NO_CHANGE", { ...base, chainId: 8453 }), false);
  assert.equal(watch.validateEvidence("aave-v3-base-reserve-watch", "NO_CHANGE", { ...base, chainId: 8453 }), true);
  assert.equal(watch.validateEvidence("aave-v3-base-reserve-watch", "NO_CHANGE", base), false);

  const candidate = { routeKey: "a".repeat(64), eventId: "a".repeat(64), class: "O", anomalyReason: "stale-source", asset: `0x${"2".repeat(40)}`, anomalyCount: 2 };
  const fired = { ...base, firedCount: 1, candidate };
  assert.equal(watch.validateEvidence("aave-v3-eth-reserve-watch", "ATOMIC_FORK_REQUIRED", fired), true);
  assert.equal(watch.validateEvidence("aave-v3-eth-reserve-watch", "ATOMIC_FORK_REQUIRED", { ...fired, candidate: { ...candidate, class: "Z" } }), false);
  assert.equal(watch.validateEvidence("aave-v3-eth-reserve-watch", "ATOMIC_FORK_REQUIRED", { ...fired, candidate: { ...candidate, routeKey: "b".repeat(64) } }), false);
  assert.equal(watch.validateEvidence("aave-v3-eth-reserve-watch", "ATOMIC_FORK_REQUIRED", { ...fired, candidate: { ...candidate, asset: "not-an-address" } }), false);
  assert.equal(watch.validateEvidence("aave-v3-eth-reserve-watch", "ATOMIC_FORK_REQUIRED", { ...fired, firedCount: 0 }), false);
  // A pool-level F anomaly has a null asset.
  const poolCandidate = { ...candidate, class: "F", anomalyReason: "premium-total-changed", asset: null };
  assert.equal(watch.validateEvidence("aave-v3-eth-reserve-watch", "ATOMIC_FORK_REQUIRED", { ...base, firedCount: 1, candidate: poolCandidate }), true);
});

test("Aave V3 scenarios abort on an exact-pin mismatch before any RPC", async () => {
  for (const [chainId, label] of [[1, "ethereum-chain"], [8453, "base-chain"]]) {
    const scenario = require(path.join(__dirname, "fork-poc", "triggers", `aave-v3-${chainId === 1 ? "eth" : "base"}-reserve-watch.js`));
    assert.equal(scenario.chainId, chainId);
    const seen = [];
    const ctx = {
      chainId,
      blockHash: `0x${"2".repeat(64)}`,
      input: { blockHash: `0x${"1".repeat(64)}`, candidate: {} },
      fatal: false,
      assert(condition, name) {
        const pass = condition === true;
        seen.push(name);
        if (!pass && this.fatal) throw Object.assign(new Error("SCENARIO_ASSERT_FAILED"), { code: "SCENARIO_ASSERT_FAILED" });
        return pass;
      },
    };
    await assert.rejects(() => scenario.run(ctx), /SCENARIO_ASSERT_FAILED/u);
    assert.deepEqual(seen, [label, "exact-pin-hash"]);
    assert.equal(Object.hasOwn(ctx, "ethers"), false);
  }
});

test("Aave V3 scenarios document the state-consistency probe and never deploy", () => {
  for (const file of ["aave-v3-eth-reserve-watch.js", "aave-v3-base-reserve-watch.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "fork-poc", "triggers", file), "utf8");
    assert.match(source, /STATE-CONSISTENCY probe/u);
    assert.match(source, /no state change/u);
    assert.equal(/ctx\.deploy/u.test(source), false);
    assert.equal(/ctx\.send/u.test(source), false);
  }
});
