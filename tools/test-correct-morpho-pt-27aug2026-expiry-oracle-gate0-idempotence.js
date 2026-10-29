#!/usr/bin/env node
"use strict";

// Offline rerun-safety test. It invokes only the branch correction tool, never
// RPC/network code, and proves all correction artifacts remain byte-identical.
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NS = "morpho-pt-27aug2026-expiry-oracle-gate0";
const DIR = path.join(ROOT, "reports", "raw", "fast", NS);
const TOOL = path.join(ROOT, "tools", `correct-${NS}.js`);
const { classifyCommitments } = require(TOOL);
const OUT = path.join(DIR, "correction-idempotence-results.json");
const FILES = {
  capture: path.join(DIR, "capture.json"),
  inputs: path.join(DIR, "verified-compiler-inputs.json"),
  source: path.join(DIR, "source-runtime-manifest.json"),
  correction: path.join(DIR, "correction-manifest.json")
};
const sha256 = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
let assertions = 0;
function assert(value, label) { assertions++; if (!value) throw new Error(`ASSERTION_FAILED:${label}`); }
function snapshot() { return Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file)])); }
function commitments(values) { return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { sha256: sha256(value), bytes: value.length }])); }
function assertSame(before, after, stage) {
  for (const name of Object.keys(FILES)) assert(before[name].equals(after[name]), `${stage}-byte-identical-${name}`);
}
function assertCanonical(values, stage) {
  const capture = JSON.parse(values.capture.toString("utf8"));
  assert(capture.rows.length === 3, `${stage}-three-rows`);
  for (const row of capture.rows) {
    assert(Object.hasOwn(row, "storedSupplyMinusStoredBorrowAssets"), `${stage}-subtraction-present-${row.label}`);
    assert(BigInt(row.storedSupplyMinusStoredBorrowAssets)
      === BigInt(row.marketState.totalSupplyAssets) - BigInt(row.marketState.totalBorrowAssets), `${stage}-subtraction-exact-${row.label}`);
  }
  assert(capture.chain.twoDistinctHostnameFamiliesAgreedUnderCaptureHeuristic === true, `${stage}-hostname-family-agreement`);
}
function invoke(args) {
  const result = childProcess.spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  assert(result.status === 0, `invoke-${args.join("-") || "normal"}-exit`);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function main() {
  if (process.argv.length !== 2) throw new Error("ARGV_FORBIDDEN");
  const initial = snapshot();
  assertCanonical(initial, "initial");
  const initialCommitments = commitments(initial), manifest = JSON.parse(initial.correction.toString("utf8"));
  assert(classifyCommitments(initialCommitments, manifest) === "ALREADY_CORRECTED", "classify-corrected");
  assert(classifyCommitments(manifest.parent, manifest) === "PARENT_READY", "classify-parent");
  const mismatch = { ...initialCommitments, capture: { ...initialCommitments.capture, sha256: `0x${"00".repeat(32)}` } };
  assert(classifyCommitments(mismatch, manifest) === "MISMATCH", "classify-neither-fail-closed");

  const check = invoke(["--check"]);
  assert(check.status === "ALREADY_CORRECTED" && check.checkMode === true && check.writes === 0, "check-mode-zero-write");
  const afterCheck = snapshot();
  assertSame(initial, afterCheck, "check-mode");
  assertCanonical(afterCheck, "after-check");

  const first = invoke([]);
  assert(first.status === "ALREADY_CORRECTED" && first.checkMode === false && first.writes === 0, "first-rerun-zero-write");
  const afterFirst = snapshot();
  assertSame(initial, afterFirst, "first-rerun");
  assertCanonical(afterFirst, "after-first");

  const second = invoke([]);
  assert(second.status === "ALREADY_CORRECTED" && second.checkMode === false && second.writes === 0, "second-rerun-zero-write");
  const afterSecond = snapshot();
  assertSame(initial, afterSecond, "second-rerun");
  assertCanonical(afterSecond, "after-second");

  const output = {
    schema: `${NS}/correction-idempotence-results-v1`, generatedAt: new Date().toISOString(), status: "PASS", assertions,
    checkMode: { status: check.status, writes: check.writes },
    firstRun: { status: first.status, writes: first.writes },
    secondRun: { status: second.status, writes: second.writes },
    byteIdenticalArtifacts: Object.keys(FILES), commitments: commitments(afterSecond),
    stateMachineCases: { corrected: "ALREADY_CORRECTED", parent: "PARENT_READY", neither: "MISMATCH" },
    invariants: { storedSubtractionFieldsPresent: 3, storedSubtractionFieldsExact: 3, hostnameFamilyAgreement: true },
    safety: { offline: true, network: false, rpc: false, inventoryRead: false, envRead: false, keyRead: false,
      fork: false, transaction: false, signing: false, broadcast: false, productionMutation: false }
  };
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ status: output.status, assertions, secondRun: second.status, writes: second.writes,
    byteIdenticalArtifacts: output.byteIdenticalArtifacts.length, storedSubtractionFields: 3, hostnameFamilyAgreement: true }));
}

try { main(); } catch (error) { console.error(JSON.stringify({ status: "FAIL", diagnostic: String(error.message || error).slice(0, 300) })); process.exitCode = 1; }
