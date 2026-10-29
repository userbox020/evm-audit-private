#!/usr/bin/env node
"use strict";

// Offline suite for the bounded Morpho Blue F (flash-liquidity/fee) producer.
// The monitor source artifact is synthetic; no network, no endpoint material.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const producer = require("./scan-morpho-f-coverage.js");
const audit = require("./audit-trigger-coverage-universe.js");

const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));

function artifact() {
  return {
    schema: producer.SOURCE_SCHEMA,
    capturedAt: "2026-09-21T04:59:48.000Z",
    markets: [
      { chainId: 1, market: "A/USDC", marketId: `0x${"1".repeat(64)}`, loan: "USDC", status: "WATCH", marketState: { availableLiquidity: "100" }, errors: [] },
      { chainId: 1, market: "B/USDC", marketId: `0x${"2".repeat(64)}`, loan: "USDC", status: "WATCH", marketState: { availableLiquidity: "0" }, errors: [] },
      { chainId: 8453, market: "C/USDC", marketId: `0x${"3".repeat(64)}`, loan: "USDC", status: "TRIGGERED", marketState: { availableLiquidity: "200" }, errors: [] },
    ],
  };
}

test("emits one covered F binder per chain from the monitor artifact", () => {
  const result = producer.buildBinders({ artifact: artifact() });
  assert.equal(result.binders.length, 2);
  assert.equal(result.covered, 2);
  assert.equal(result.blocked, 0);
  for (const binder of result.binders) {
    assert.equal(binder.value.observedAt, "2026-09-21T04:59:48.000Z");
    assert.equal(binder.value.family, "Morpho Blue");
    assert.equal(binder.value.triggerClass, "F");
    assert.equal(binder.value.enumeration.ref, producer.FLASH_REF);
    assert.equal(binder.value.reads.failed, 0);
    assert.equal(binder.value.reads.succeeded + binder.value.reads.failed, binder.value.reads.attempted);
    assert.equal(binder.value.coverage.complete, true);
    assert.deepEqual(binder.value.onFire, { economics: true, keylessFixedPinFork: true, alert: true });
    assert.deepEqual(binder.value.blockers, []);
    assert.ok(binder.value.evidence.some((line) => line.includes(producer.FLASH_FEE_NOTE)));
    assert.ok(binder.value.evidence.some((line) => /per monitored market loan-asset available liquidity/.test(line)));
  }
});

test("F evidence maps exactly the enabled Morpho F universe rows", () => {
  const result = producer.buildBinders({ artifact: artifact() });
  for (const binder of result.binders) {
    const row = UNIVERSE.rows.find((entry) => entry.id === binder.id);
    assert.equal(row.onFire.enabled, true);
    assert.equal(row.artifactPath, binder.artifactPath);
    const shape = audit.genericEvidenceShape(binder.value, row);
    assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
  }
});

test("fails a chain closed when a monitored market lacks a state read", () => {
  const source = artifact();
  source.markets.find((market) => market.chainId === 8453).marketState = null;
  const result = producer.buildBinders({ artifact: source });
  const base = result.binders.find((binder) => binder.id === "base-morpho-blue-f");
  assert.equal(base.value.coverage.complete, false);
  assert.equal(base.value.dispatchEnabled, false);
  assert.ok(base.value.reads.failed >= 1);
  assert.ok(base.value.blockers.length > 0);
  const eth = result.binders.find((binder) => binder.id === "ethereum-morpho-blue-f");
  assert.equal(eth.value.coverage.complete, true);
});

test("rejects a non-canonical source artifact", () => {
  assert.throws(() => producer.buildBinders({ artifact: { schema: "wrong", capturedAt: new Date().toISOString(), markets: [] } }), /SOURCE_INVALID/);
});

test("does not leak URLs or credentials into the binders", () => {
  const result = producer.buildBinders({ artifact: artifact() });
  assert.doesNotMatch(JSON.stringify(result.binders), /https?:\/\/|wss?:\/\/|authorization|bearer|api[_-]?key|private[_-]?key|rpc_endpoints/i);
});

test("CLI option parsing is strict", () => {
  assert.deepEqual(producer.parseOptions(["--check"]), { apply: false });
  assert.deepEqual(producer.parseOptions([]), { apply: true });
  assert.throws(() => producer.parseOptions(["--nope"]), /usage/);
});
