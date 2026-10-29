#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const planner = require("./run-deployed-delta-invariant-planner.js");
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
const hash = (n) => n.toString(16).padStart(64, "0");
function input() {
  const record = hash(1); const authority = hash(2);
  return { now: NOW, upstreamExtractorCommitment: hash(9), authorityBatchCommitment: hash(10), binderBatchCommitment: hash(11), scorerBatchCommitment: hash(12),
    authorityRows: [{ recordCommitment: record, authorityCommitment: authority, status: "EXACT" }],
    binderRows: [{ recordCommitment: record, authorityCommitment: authority, binderCommitment: hash(3), status: "PASS" }],
    scorerRows: [{ recordCommitment: record, scorerCommitment: hash(4), classes: ["liquidation-rounding", "oracle-price", "proxy-module", "queue-epoch", "share-accounting"] }] };
}
test("exact authority and PASS binder join emits bounded non-executing class plans", () => {
  const artifact = planner.planBatch(input());
  assert.equal(planner.validateArtifact(artifact), true);
  assert.equal(artifact.counts.planned, 5);
  assert.deepEqual(new Set(artifact.plans.map((row) => row.template)), new Set(input().scorerRows[0].classes.map((klass) => planner.TEMPLATES[klass])));
  assert.ok(artifact.plans.every((row) => row.status === "PLANNED"));
  assert.doesNotMatch(JSON.stringify(artifact), /(?:https?:\/\/|0x[0-9a-f]{40}|target|address|source|calldata|economic|profit|loss)/i);
});
test("missing or non-PASS authority/binder joins never plan", () => {
  const missing = input(); missing.binderRows = [];
  const failed = input(); failed.binderRows[0].status = "FAIL";
  for (const value of [missing, failed]) {
    const artifact = planner.planBatch(value);
    assert.equal(artifact.counts.planned, 0);
    assert.ok(artifact.plans.every((row) => row.status === "BLOCKED"));
  }
});
test("other maps to UNKNOWN rather than a claimed plan", () => {
  const value = input(); value.scorerRows[0].classes = ["other"];
  const artifact = planner.planBatch(value);
  assert.deepEqual(artifact.counts, { planned: 0, blocked: 0, unknown: 1 });
  assert.equal(artifact.plans[0].template, "OTHER_UNKNOWN");
  assert.equal(artifact.plans[0].status, "UNKNOWN");
  assert.equal(artifact.plans[0].scorerCommitment, hash(4));
  value.binderRows = [];
  assert.equal(planner.planBatch(value).plans[0].status, "UNKNOWN");
});
test("schema and leak validation are atomic", () => {
  const artifact = planner.planBatch(input());
  const extra = structuredClone(artifact); extra.plans[0].extra = true;
  const leak = structuredClone(artifact); leak.plans[0].template = "https://bad.invalid";
  assert.equal(planner.validateArtifact(extra), false);
  assert.equal(planner.validateArtifact(leak), false);
  const invalid = input(); invalid.scorerRows[0].address = "0x1234567890123456789012345678901234567890";
  assert.throws(() => planner.planBatch(invalid), { code: "INPUT_INVALID" });
});
test("planning and publication are deterministic and atomic", (t) => {
  const first = planner.planBatch(input()); const permuted = input(); permuted.scorerRows[0].classes.reverse();
  const second = planner.planBatch(permuted);
  assert.deepEqual(first, second);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-planner-")); const outputPath = path.join(root, "nested", "plans.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  planner.publishAtomic(first, { outputPath, fsImpl: fs });
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), first);
  assert.equal(fs.readdirSync(path.dirname(outputPath)).some((name) => name.includes(".tmp")), false);
  const renameFailure = new Proxy(fs, { get(target, property) {
    if (property === "renameSync") return () => { throw new Error("injected rename failure"); };
    return Reflect.get(target, property);
  } });
  assert.throws(() => planner.publishAtomic(first, { outputPath, fsImpl: renameFailure }), /injected rename failure/);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), first);
  assert.equal(fs.readdirSync(path.dirname(outputPath)).some((name) => name.includes(".tmp")), false);
});
