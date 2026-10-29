#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const audit = require("./audit-trigger-coverage-universe.js");
const builder = require("./build-trigger-coverage-morpho-binders.js");

const WORKSPACE = builder.WORKSPACE;
const CONFIG_PATH = builder.CONFIG_PATH;
const ORACLE_REL = "reports/raw/fast/morpho-frozen-oracle-status.json";

function realConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
function realUniverse() { return JSON.parse(fs.readFileSync(audit.UNIVERSE_PATH, "utf8")); }
function realArtifact() { return JSON.parse(fs.readFileSync(path.join(WORKSPACE, ORACLE_REL), "utf8")); }
function row(universe, id) {
  const found = universe.rows.find((entry) => entry.id === id);
  assert.ok(found, `missing row ${id}`);
  return found;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

test("covers the two O rows from the monitor artifact", () => {
  const result = builder.buildBinders({});
  // The Morpho F rows are now produced by scan-morpho-f-coverage.js.
  assert.equal(result.binders.length, 2);
  assert.equal(result.covered, 2);
  assert.equal(result.blocked, 0);
  assert.deepEqual(builder.checkUniverseWiring(result.universe, result.config), []);

  const o = result.binders.find((binder) => binder.id === "ethereum-morpho-blue-o");
  assert.equal(o.value.observedAt, result.artifact.capturedAt);
  assert.equal(o.value.enumeration.ref, "bounded oracle-market observation");
  assert.equal(o.value.enumeration.boundDeclared, true);
  assert.equal(o.value.reads.failed, 0);
  assert.equal(o.value.reads.succeeded + o.value.reads.failed, o.value.reads.attempted);
  assert.equal(o.value.classSemantics.exact, true);
  assert.equal(o.value.coverage.complete, true);
  assert.deepEqual(o.value.onFire, { economics: true, keylessFixedPinFork: true, alert: true });
  assert.equal(o.value.dispatchEnabled, true);
  assert.deepEqual(o.value.blockers, []);
  assert.ok(o.value.evidence.some((line) => /reference-unavailable markets excluded/.test(line)));
});

test("covered O binders audit COVERED at the observation time", () => {
  const result = builder.buildBinders({ apply: true });
  const universe = result.universe;
  const nowMs = Date.parse(result.artifact.capturedAt) + 1_000;
  for (const binder of result.binders) {
    const assessed = audit.auditRow(row(universe, binder.id), { workspace: WORKSPACE, nowMs });
    assert.equal(assessed.status, "COVERED", `${binder.id} should be COVERED`);
    assert.deepEqual(assessed.blockers, []);
  }
});

test("fails closed when a market observation reports a read error", () => {
  const artifact = clone(realArtifact());
  const ethMarket = artifact.markets.find((market) => market.chainId === 1);
  ethMarket.errors = ["state-unavailable"];
  const result = builder.buildBinders({ artifact });
  const eth = result.binders.find((binder) => binder.id === "ethereum-morpho-blue-o");
  assert.equal(eth.value.coverage.complete, false);
  assert.ok(eth.value.reads.failed >= 1);
  assert.ok(eth.value.blockers.some((line) => /read errors/.test(line)));
  const base = result.binders.find((binder) => binder.id === "base-morpho-blue-o");
  assert.equal(base.value.coverage.complete, true);
});

test("fails closed when the chain has no observed markets", () => {
  const artifact = clone(realArtifact());
  artifact.markets = [];
  const result = builder.buildBinders({ artifact });
  assert.equal(result.covered, 0);
  assert.equal(result.blocked, 2);
  for (const binder of result.binders) {
    assert.ok(binder.value.blockers.some((line) => /no Morpho Blue oracle markets observed/.test(line)));
  }
});

test("rejects a non-canonical oracle source artifact", () => {
  assert.throws(() => builder.buildBinders({ artifact: { schema: "wrong", capturedAt: new Date().toISOString(), markets: [] } }), /ORACLE_SOURCE_INVALID/);
});

test("config validation is fail-closed on row-set, blocker, keys, and output drift", () => {
  const universe = realUniverse();

  const missingRow = realConfig();
  delete missingRow.rows["base-morpho-blue-o"];
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: missingRow }), /CONFIG_ROW_SET_INVALID/);

  const missingBlocker = realConfig();
  missingBlocker.rows["ethereum-morpho-blue-o"] = { source: "oracle", mode: "BLOCKED", evidence: ["x"] };
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: missingBlocker }), /CONFIG_ROW_BLOCKER_MISSING/);

  const blockerOnCovered = realConfig();
  blockerOnCovered.rows["base-morpho-blue-o"] = { source: "oracle", mode: "COVERED", blocker: "should not exist" };
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: blockerOnCovered }), /CONFIG_ROW_BLOCKER_UNEXPECTED/);

  const badKeys = realConfig();
  badKeys.rows["base-morpho-blue-o"] = { source: "oracle", mode: "COVERED", extra: true };
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: badKeys }), /CONFIG_ROW_INVALID/);

  const badOutput = realConfig();
  badOutput.outputDir = "reports/monitor/other";
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: badOutput }), /UNIVERSE_ARTIFACT_MISMATCH/);

  const badFreshness = realConfig();
  badFreshness.freshnessSeconds = 1800;
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: badFreshness }), /UNIVERSE_FRESHNESS_MISMATCH/);
});

test("CLI option parsing is strict", () => {
  assert.deepEqual(builder.parseOptions(["--check"]), { apply: false, check: true });
  assert.deepEqual(builder.parseOptions(["--apply"]), { apply: true, check: false });
  assert.throws(() => builder.parseOptions(["--check", "--apply"]), /usage/);
  assert.throws(() => builder.parseOptions(["--nope"]), /usage/);
});
