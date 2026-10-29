"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const runner = require("./critical-stakewise-v3-mainnet-deployment-economics-successor-r5-runner");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, ...runner.MANIFEST_REL.split("/"));
const EXPECTED_PREDECESSORS = Object.freeze({
  r1: "bff81a2af3b762755dc27ab79f6d515b224505379f9c05429d1be754c2791d42",
  r2: "57dc239d68ee240585f519568c447f516cf9c93d49a44ba1dbfff92e4b036731",
  r3: "3bf69565e76adebf3ac2ac6a38076cfda13172f7d692711c2d5008d8a0108b2a",
  r4: "639f264a76d3acf0b566c2e4ed740d51949896462d1924ee36d267779d7e02f0"
});
const PREDECESSOR_MANIFESTS = Object.freeze({
  r1: "reports/raw/fast/critical-stakewise-v3-mainnet-deployment-economics-successor-manifest.json",
  r2: "reports/raw/fast/critical-stakewise-v3-mainnet-deployment-economics-successor-r2-manifest.json",
  r3: "reports/raw/fast/critical-stakewise-v3-mainnet-deployment-economics-successor-r3-manifest.json",
  r4: "reports/raw/fast/critical-stakewise-v3-mainnet-deployment-economics-successor-r4-manifest.json"
});
const REQUIRED_ARTIFACTS = Object.freeze([
  "tools/critical-stakewise-v3-mainnet-deployment-economics-successor-r5-runner.js",
  "tools/test-critical-stakewise-v3-mainnet-deployment-economics-successor-r5.js",
  "tools/validate-critical-stakewise-v3-mainnet-deployment-economics-successor-r5.js",
  "tools/fixtures/critical-stakewise-v3-mainnet-deployment-economics-successor-r5-fixtures.json",
  "reports/critical-stakewise-v3-mainnet-deployment-economics-successor-r5.md",
  "reports/raw/fast/critical-stakewise-v3-mainnet-deployment-economics-successor-r5-preflight.json"
]);

function absolute(relative) { return path.join(ROOT, ...relative.split("/")); }
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  assert.strictEqual(manifest.schemaVersion, 5);
  assert.strictEqual(manifest.findingId, runner.FINDING_ID);
  assert.strictEqual(manifest.status, "R5_OFFLINE_PACKAGE_VALIDATED_NO_CAPTURE");
  assert.deepStrictEqual(manifest.predecessorAggregates, EXPECTED_PREDECESSORS);
  for (const [revision, relative] of Object.entries(PREDECESSOR_MANIFESTS)) {
    assert.strictEqual(JSON.parse(fs.readFileSync(absolute(relative), "utf8")).aggregateSha256,
      EXPECTED_PREDECESSORS[revision], `${revision} predecessor aggregate`);
  }
  assert.deepStrictEqual(manifest.artifacts.map((row) => row.path).sort(), [...REQUIRED_ARTIFACTS].sort());
  for (const row of manifest.artifacts) {
    const bytes = fs.readFileSync(absolute(row.path));
    assert.strictEqual(bytes.length, row.bytes, `${row.path} bytes`);
    assert.strictEqual(sha(bytes), row.sha256, `${row.path} hash`);
  }
  assert.deepStrictEqual(manifest.localInputs.map((row) => row.path).sort(), [...runner.LOCAL_INPUT_RELS].sort());
  assert.strictEqual(runner.verifyFileRecords(manifest.localInputs, runner.LOCAL_INPUT_RELS), true);
  assert.strictEqual(runner.packageAggregate(manifest), manifest.aggregateSha256);
  assert.strictEqual(runner.dependencyGraphAggregate(manifest.runtimeDependencyGraph), manifest.runtimeDependencyGraphAggregate);
  assert.strictEqual(runner.verifyDependencyGraph(manifest.runtimeDependencyGraph), true);

  const preflight = JSON.parse(fs.readFileSync(absolute(runner.PREFLIGHT_REL), "utf8"));
  assert.deepStrictEqual(preflight, JSON.parse(JSON.stringify(runner.dryPreflight())));
  assert.strictEqual(preflight.schemaVersion, 5);
  assert.strictEqual(preflight.networkReads, 0);
  assert.strictEqual(preflight.inventoryReads, 0);
  assert.strictEqual(preflight.correctness.economics, null);
  assert.strictEqual(preflight.correctness.applicability, null);
  assert.strictEqual(preflight.correctness.exactAffectedSemantics, null);
  assert.strictEqual(preflight.gates.deploymentApplicabilityCandidate, null);
  assert.strictEqual(preflight.gates.routePositive, null);
  assert.strictEqual(preflight.gates.promotable, false);

  const source = fs.readFileSync(absolute(REQUIRED_ARTIFACTS[0]), "utf8");
  for (const forbidden of ["function computeEconomics", "function exactContractCell", "function evaluateApplicability",
    "depositSweepBps", "EXACT_INTEGER_MODEL"]) assert.ok(!source.includes(forbidden), forbidden);
  for (const required of ["LegacyPoolEscrow", "loadedDependencyGraph", "pendingDonationObservable",
    "currentStateComplete", "exactAffectedSemantics = null", "record.present", "identityDiagnosticRow",
    "LOCAL_INPUT_RELS", "packageAggregate"]) assert.ok(source.includes(required), required);

  const test = spawnSync(process.execPath, [absolute("tools/test-critical-stakewise-v3-mainnet-deployment-economics-successor-r5.js")],
    { cwd: path.join(ROOT, "tools"), encoding: "utf8", timeout: 120000 });
  assert.strictEqual(test.status, 0, test.stderr || test.stdout);
  assert.match(test.stdout, /zero network\/inventory reads/u);
  process.stdout.write(`stakewise successor r5 validation passed: ${manifest.artifacts.length} artifacts, ${manifest.runtimeDependencyGraph.length} loaded dependency files, ${manifest.localInputs.length} local inputs, aggregate ${manifest.aggregateSha256}\n`);
}

try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }

module.exports = { EXPECTED_PREDECESSORS, PREDECESSOR_MANIFESTS, REQUIRED_ARTIFACTS };
