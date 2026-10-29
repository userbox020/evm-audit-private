#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const validator = require("./validate-critical-valantis-stex-remediation-assurance-step4.js");

const ROOT = path.resolve(__dirname, "..");
const raw = (name) => fs.readFileSync(path.join(ROOT, "reports", "raw", "fast", name), "utf8");
const primary = raw("critical-valantis-stex-remediation-assurance-step4-invariant.log");
const full = raw("critical-valantis-stex-remediation-assurance-step4-full.log");
const mutation = raw("critical-valantis-stex-remediation-assurance-step4-mutation.log");
const artifact = JSON.parse(raw("critical-valantis-stex-remediation-assurance-step4.json"));
let assertions = 0;
let distinctTamperClasses = 0;
function equal(actual, expected, message) { assertions += 1; assert.deepStrictEqual(actual, expected, `assertion ${assertions}: ${message}`); }
function tamper(fn, pattern, message) { assertions += 1; distinctTamperClasses += 1; assert.throws(fn, pattern, `assertion ${assertions}: ${message}`); }

const parsed = validator.parseInvariant(primary); const headers = validator.parseHeaders(primary);
equal(parsed.properties.length, 7, "property count");
equal(parsed.properties.map((row) => row.name), validator.PROPERTIES, "property names");
equal(parsed.trajectories.length, 7, "trajectory count");
equal(Object.values(parsed.aggregate).reduce((sum, row) => sum + row.calls, 0), 57344, "aggregate calls");
equal(headers.SEED, validator.SEED, "seed");
equal(headers.RUNS, "128", "runs");
equal(headers.DEPTH, "64", "depth");
equal(headers.FAIL_ON_REVERT, "true", "fail-on-revert");
equal(validator.parseSuiteSummaries(full).at(-1).passed, 271, "full suite pass count");
equal(validator.parseDirectedCoverage(raw("critical-valantis-stex-remediation-assurance-step4-directed.log")).attempts,
  Array(24).fill(1), "directed attempts");

tamper(() => validator.validateSuiteLog(`${full}\n[FAIL: injected]`, { suites: 17, passed: 271, failed: 0, skipped: 0, total: 271 }, "x"), /failure lines absent/u, "failure marker");
tamper(() => validator.validateSuiteLog(`${full}\nSuite result: FAILED`, { suites: 17, passed: 271, failed: 0, skipped: 0, total: 271 }, "x"), /failure lines absent/u, "failed suite marker");
tamper(() => validator.validateSuiteLog(`${full}\nEncountered 1 failing tests`, { suites: 17, passed: 271, failed: 0, skipped: 0, total: 271 }, "x"), /failure lines absent/u, "failing-tests marker");
tamper(() => validator.validateSuiteLog(`${full}\nEXIT: 1`, { suites: 17, passed: 271, failed: 0, skipped: 0, total: 271 }, "x"), /failure lines absent/u, "nonzero exit marker");
tamper(() => validator.validateSuiteLog(full.replace("271 tests passed, 0 failed", "270 tests passed, 1 failed"), { suites: 17, passed: 271, failed: 0, skipped: 0, total: 271 }, "x"), /all suite summaries/u, "suite failure count");
tamper(() => validator.validateSuiteLog(full.replace("0 skipped (271 total tests)", "1 skipped (271 total tests)"), { suites: 17, passed: 271, failed: 0, skipped: 0, total: 271 }, "x"), /all suite summaries/u, "suite skipped count");
tamper(() => validator.validateSuiteLog(full, { suites: 17, passed: 270, failed: 0, skipped: 0, total: 271 }, "x"), /all suite summaries/u, "suite expected pass mismatch");
tamper(() => validator.validateInvariantLog(primary.replace("calls: 8192", "calls: 8191"), 128, 64, validator.SEED), /dimensions/u, "property call mismatch");
tamper(() => validator.validateInvariantLog(primary.replace("reverts: 0", "reverts: 1"), 128, 64, validator.SEED), /dimensions/u, "property revert mismatch");
tamper(() => validator.validateInvariantLog(primary.replace("runs: 128", "runs: 127"), 128, 64, validator.SEED), /dimensions/u, "property run mismatch");
tamper(() => validator.validateInvariantLog(primary.replace(/^\[PASS\].+\r?\n/mu, ""), 128, 64, validator.SEED), /invariant names/u, "property omission");
tamper(() => validator.validateInvariantLog(primary.replace(/^\| Step4Handler \| actionBufferUsed.+\r?\n/mu, ""), 128, 64, validator.SEED), /trajectory/u, "action omission");
tamper(() => validator.validateInvariantLog(primary.replace(/(\| Step4Handler \| actionBufferUsed\s+\| )(\d+)/u, (_, p, n) => `${p}${Number(n) + 1}`), 128, 64, validator.SEED), /trajectory calls/u, "action call mismatch");
tamper(() => validator.validateInvariantLog(primary.replace(/(\| Step4Handler \| actionBufferUsed\s+\| \d+\s+\| )0/u, (_, p) => `${p}1`), 128, 64, validator.SEED), /trajectory reverts/u, "action revert mismatch");
tamper(() => validator.validateInvariantLog(primary.replace(validator.SEED, `0x${"44".repeat(32)}`), 128, 64, validator.SEED), /invariant parameters/u, "seed mismatch");
tamper(() => validator.validateInvariantLog(primary.replace("RUNS: 128", "RUNS: 64"), 128, 64, validator.SEED), /invariant parameters/u, "header runs mismatch");
tamper(() => validator.validateInvariantLog(primary.replace("DEPTH: 64", "DEPTH: 63"), 128, 64, validator.SEED), /invariant parameters/u, "depth mismatch");
tamper(() => validator.validateInvariantLog(primary.replace("FAIL_ON_REVERT: true", "FAIL_ON_REVERT: false"), 128, 64, validator.SEED), /invariant parameters/u, "fail-on-revert mismatch");
tamper(() => validator.validateInvariantLog(primary.replace(validator.PROPERTIES[0], "invariant_Injected"), 128, 64, validator.SEED), /invariant names/u, "property-name drift");
tamper(() => validator.validateMutationLog(mutation.replace(/\[FAIL:/gu, "[PASS:")), /expected failure lines/u, "mutation failure corruption");
tamper(() => validator.validateMutationLog(mutation.replace("ACTUAL_EXIT: 1", "ACTUAL_EXIT: 0")), /expected exit/u, "mutation exit corruption");
tamper(() => validator.validateMutationLog(mutation.replace(/live manager request hidden from module tracking/gu, "redacted")), /hidden-request assertion/u, "mutation assertion corruption");
tamper(() => validator.validateArtifactSchema({ ...artifact, injected: true }), /exact schema/u, "artifact schema extra");
tamper(() => validator.validateArtifactSchema({ ...artifact, schemaVersion: "4" }), /field types/u, "artifact schema type");
tamper(() => validator.validateEnvironmentEntry({ path: "foundry.toml", bytes: 1, sha256: "00".repeat(32) }, Buffer.from("x")), /environment foundry\.toml/u, "environment/config hash drift");
tamper(() => validator.parseSubmoduleStatus(`+${"1".repeat(40)} lib/forge-std`), /SUBMODULE_STATUS_DRIFT/u, "submodule pin drift");

assert.strictEqual(assertions, validator.EXPECTED_TEST_ASSERTIONS);
assert.strictEqual(distinctTamperClasses, validator.EXPECTED_TAMPER_CLASSES);
process.stdout.write(`${JSON.stringify({ status: "PASS", assertions, distinctTamperClasses,
  classes: ["failure-marker", "suite-failed-marker", "failing-tests-marker", "nonzero-exit", "suite-failed-count",
    "suite-skipped-count", "suite-pass-count", "property-call-count", "property-revert-count", "property-run-count",
    "property-omission", "action-omission", "action-call-count", "action-revert-count", "seed", "runs", "depth",
    "fail-on-revert", "property-name", "mutation-failure", "mutation-exit", "mutation-assertion", "schema-extra",
    "schema-type", "environment-config-hash", "submodule-pin"], offline: true, networkReads: 0, transactions: 0 }, null, 2)}\n`);
