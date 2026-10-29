#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const audit = require("./audit-trigger-coverage-universe.js");
const builder = require("./build-trigger-coverage-balancer-binders.js");

const WORKSPACE = builder.WORKSPACE;
const CONFIG_PATH = builder.CONFIG_PATH;
const PHASE0_REL = "reports/raw/fast/balancer-v3-phase0.json";

function realConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
function realUniverse() { return JSON.parse(fs.readFileSync(audit.UNIVERSE_PATH, "utf8")); }
function row(universe, id) {
  const found = universe.rows.find((entry) => entry.id === id);
  assert.ok(found, `missing row ${id}`);
  return found;
}

test("emits one recognized blocked binder per non-conformable Balancer row", () => {
  const result = builder.buildBinders({});
  // The V3 F rows are produced by scan-balancer-v3-coverage.js and the V3 X/R rows
  // by scan-balancer-v3-xr.js; this builder owns the two remaining gaps.
  assert.equal(result.binders.length, 2);
  assert.equal(result.covered, 0);
  assert.equal(result.blocked, 2);
  assert.deepEqual(builder.checkUniverseWiring(result.universe, result.config), []);
  for (const binder of result.binders) {
    assert.equal(binder.value.schema, "trigger-coverage-evidence/v1");
    assert.equal(binder.value.coverage.complete, false);
    assert.equal(binder.value.dispatchEnabled, false);
    assert.deepEqual(binder.value.onFire, { economics: false, keylessFixedPinFork: false, alert: false });
    assert.equal(binder.value.enumeration.boundDeclared, false);
    assert.equal(binder.value.enumeration.successful, false);
    assert.equal(binder.value.classSemantics.exact, false);
    assert.ok(binder.value.blockers.length > 0);
    const shape = audit.genericEvidenceShape(binder.value, row(result.universe, binder.id));
    assert.equal(shape.identity, true);
    assert.equal(shape.complete, false);
  }
});

test("copies source timestamps verbatim and uses null when no source exists", () => {
  const result = builder.buildBinders({});
  const phase0 = JSON.parse(fs.readFileSync(path.join(WORKSPACE, PHASE0_REL), "utf8"));
  assert.equal(result.binders.find((binder) => binder.id === "base-balancer-v3-x").value.observedAt, phase0.generatedAt);
  assert.equal(result.binders.find((binder) => binder.id === "base-balancer-v2-r").value.observedAt, null);
});

test("blocked binders audit as BLOCKED with the declared gap and no leak", () => {
  const result = builder.buildBinders({});
  const universe = result.universe;
  const nowMs = Date.parse("2026-09-20T17:56:25.057Z");
  for (const binder of result.binders) {
    const target = path.join(WORKSPACE, binder.artifactPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(binder.value, null, 2)}\n`);
    const assessed = audit.auditRow(row(universe, binder.id), { workspace: WORKSPACE, nowMs });
    assert.equal(assessed.status, "BLOCKED", `${binder.id} should be BLOCKED`);
    assert.ok(assessed.blockers.length > 0);
    assert.doesNotMatch(JSON.stringify(binder.value), /https?:\/\/|wss?:\/\/|authorization|bearer|api[_-]?key|private[_-]?key|mnemonic|secret|rpc_endpoints/i);
  }
});

test("config validation is fail-closed on row-set, blocker, evidence, and output drift", () => {
  const universe = realUniverse();

  const missingRow = realConfig();
  delete missingRow.rows["base-balancer-v3-x"];
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: missingRow }), /CONFIG_ROW_SET_INVALID/);

  const missingBlocker = realConfig();
  missingBlocker.rows["base-balancer-v3-x"] = { source: null, mode: "BLOCKED", evidence: ["x"] };
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: missingBlocker }), /CONFIG_ROW_BLOCKER_MISSING/);

  const emptyEvidence = realConfig();
  emptyEvidence.rows["base-balancer-v2-r"] = { source: null, mode: "BLOCKED", blocker: "gap", evidence: [] };
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: emptyEvidence }), /CONFIG_ROW_EVIDENCE_INVALID/);

  const badOutput = realConfig();
  badOutput.outputDir = "reports/monitor/other";
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: badOutput }), /UNIVERSE_ARTIFACT_MISMATCH/);

  const badSchema = realConfig();
  badSchema.schema = "wrong";
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: badSchema }), /CONFIG_SCHEMA_INVALID/);
});

test("CLI option parsing is strict", () => {
  assert.deepEqual(builder.parseOptions(["--check"]), { apply: false, check: true });
  assert.deepEqual(builder.parseOptions(["--apply"]), { apply: true, check: false });
  assert.throws(() => builder.parseOptions(["--check", "--apply"]), /usage/);
  assert.throws(() => builder.parseOptions(["--nope"]), /usage/);
});
