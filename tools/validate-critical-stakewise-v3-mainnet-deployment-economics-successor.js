#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./critical-stakewise-v3-mainnet-deployment-economics-successor-runner.js");

const ROOT = path.resolve(__dirname, "..");
const rel = (value) => path.join(ROOT, ...value.split("/"));
const read = (value) => fs.readFileSync(rel(value));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;
function check(value, message) { checks += 1; if (!value) throw new Error(`check ${checks} failed: ${message}`); }
function equal(actual, expected, message) { check(JSON.stringify(actual) === JSON.stringify(expected), message); }

check(process.argv.length === 2, "validator accepts no arguments");
const scripts = [
  `tools/${runner.PREFIX}-runner.js`,
  `tools/test-${runner.PREFIX}.js`,
  `tools/validate-${runner.PREFIX}.js`
];
for (const script of scripts) equal(cp.spawnSync(process.execPath, ["--check", rel(script)], { cwd: ROOT, env: {} }).status, 0, `${script} syntax`);

const checkOnly = cp.spawnSync(process.execPath, [rel(scripts[0]), "--check-only"], { cwd: ROOT, env: {}, encoding: "utf8" });
equal([checkOnly.status, checkOnly.stderr], [0, ""], "check-only passes");
const generated = JSON.parse(checkOnly.stdout);
const preflight = JSON.parse(read(runner.PREFLIGHT_REL));
equal(generated, preflight, "checked-in preflight exact");
equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "check-only has no side effects");
equal(preflight.methods.allowed, [...runner.ALLOWED_METHODS].sort(), "allowlist exact");
equal(preflight.caps.retriesPerRequest, 0, "no retry");
equal([preflight.gates.routePositive, preflight.gates.executableNow], [null, null], "route gates unknown");

const tests = cp.spawnSync(process.execPath, [rel(scripts[1])], { cwd: ROOT, env: {}, encoding: "utf8" });
equal([tests.status, tests.stderr], [0, ""], "synthetic tests pass");
const testResult = JSON.parse(tests.stdout);
equal([testResult.status, testResult.networkReads, testResult.inventoryReads, testResult.captureExecuted], ["PASS", 0, 0, false],
  "tests offline only");

const manifest = JSON.parse(read(runner.MANIFEST_REL));
equal([manifest.schemaVersion, manifest.findingId, manifest.status], [1, runner.FINDING_ID, "PREPARED_NOT_EXECUTED"], "manifest status");
for (const section of ["artifacts", "sourceInputs"]) {
  for (const row of manifest[section]) {
    const bytes = read(row.path);
    equal([row.bytes, row.sha256], [bytes.length, sha256(bytes)], `${row.path} binding`);
  }
}
const aggregate = sha256(Buffer.from(manifest.artifacts.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8"));
equal(manifest.aggregateSha256, aggregate, "manifest aggregate");
check(manifest.sourceInputs.some((row) => row.path.endsWith("eth-exitqueue-step2-runner.js")), "step2 runner bound");
check(manifest.sourceInputs.some((row) => row.path.endsWith("ostoken-mainnet-runner.js")), "osToken runner bound");
check(!manifest.sourceInputs.some((row) => /approval|capture\.json|consumption-ledger/iu.test(row.path)), "no consumed approval/output bound");

const report = read(runner.REPORT_REL).toString("utf8");
for (const marker of [runner.CAPTURE_FLAG, "fresh one-shot run ID", "SINGLE_FAMILY_DIAGNOSTIC", "D * Rnet / (A + D)",
  "UNAVAILABLE_GATEWAY_NOT_ROBUSTLY_BOUND", "No capture was executed", "eth_getBalance"]) check(report.includes(marker), `report marker ${marker}`);

for (const file of [...scripts, runner.FIXTURE_REL, runner.PREFLIGHT_REL, runner.MANIFEST_REL, runner.REPORT_REL]) {
  const text = read(file).toString("utf8");
  check(text.endsWith("\n"), `${file} newline`);
  check(!/[ \t]+$/gmu.test(text), `${file} no trailing whitespace`);
}
for (const file of [runner.PREFLIGHT_REL, runner.MANIFEST_REL]) {
  const text = read(file).toString("utf8");
  check(!/(?:https?|wss?):\/\//iu.test(text), `${file} no endpoint URL`);
  check(!/"(?:endpointHash|providerHash|hostname|domain|headers|rawResponse)"/iu.test(text), `${file} no endpoint material`);
}

process.stdout.write(`${JSON.stringify({ status: "PASS", checks, offlineFixtureChecks: testResult.checks,
  fixtureClasses: testResult.fixtureClasses, aggregateSha256: manifest.aggregateSha256, networkReads: 0,
  inventoryReads: 0, captureExecuted: false })}\n`);
