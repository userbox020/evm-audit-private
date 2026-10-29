#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const runner = require("./beefy-balancer-v3-monad-deployment-binding-r1-runner");

function absolute(relative) { return path.join(runner.ROOT, ...relative.split("/")); }
function independentAggregate(value) { const rows = [...value.artifacts.map((x) => `artifacts:${x.path}:${x.sha256}`),
  ...value.runtimeDependencyGraph.map((x) => `runtime:${x.path}:${x.sha256}`),
  ...value.localInputs.map((x) => `localInputs:${x.path}:${x.sha256}`)];
return crypto.createHash("sha256").update(rows.sort().join("\n")).digest("hex"); }
function main() {
  const manifest = JSON.parse(fs.readFileSync(absolute(runner.MANIFEST_REL), "utf8"));
  assert.strictEqual(manifest.schemaVersion, 1); assert.strictEqual(manifest.findingId, runner.FINDING_ID);
  assert.strictEqual(manifest.status, "OFFLINE_PACKAGE_VALIDATED_CAPTURE_NOT_EXECUTED");
  assert.strictEqual(manifest.inventoryReads, 0); assert.strictEqual(manifest.networkReads, 0); assert.strictEqual(manifest.captureExecuted, false);
  assert.strictEqual(runner.verifyRecords(manifest.artifacts, runner.REQUIRED_ARTIFACT_PATHS), true);
  assert.strictEqual(runner.verifyRecords(manifest.localInputs, runner.LOCAL_INPUT_RELS), true);
  const observedGraph = runner.loadedDependencyGraph();
  assert.deepStrictEqual(manifest.runtimeDependencyGraph.map((row) => row.path), observedGraph.map((row) => row.path));
  assert.strictEqual(runner.verifyRecords(manifest.runtimeDependencyGraph, observedGraph.map((row) => row.path)), true);
  assert.strictEqual(independentAggregate(manifest), manifest.aggregateSha256);
  const tampered = structuredClone(manifest); tampered.localInputs[0].sha256 = "f".repeat(64);
  assert.notStrictEqual(independentAggregate(tampered), tampered.aggregateSha256);
  const preflight = JSON.parse(fs.readFileSync(absolute(runner.PREFLIGHT_REL), "utf8"));
  assert.deepStrictEqual(preflight, JSON.parse(JSON.stringify(runner.dryPreflight())));
  assert.strictEqual(preflight.target.chainId, "143"); assert.strictEqual(preflight.target.strategy, runner.STRATEGY);
  assert.strictEqual(preflight.target.beefyVault, runner.BEEFY_VAULT); assert.strictEqual(preflight.target.metadataId, runner.METADATA_ID);
  assert.strictEqual(preflight.endpointPolicy.captureOnlyReadExactlyOnce, true);
  assert.deepStrictEqual([...preflight.methods.allowed].sort(), [...runner.ALLOWED_METHODS].sort());
  assert.strictEqual(preflight.methods.graphql, false); assert.strictEqual(preflight.methods.logs, false);
  assert.strictEqual(preflight.methods.publicGets, false); assert.strictEqual(preflight.retryAllowed, false);
  assert.strictEqual(preflight.conclusions.economics, null); assert.strictEqual(preflight.conclusions.routePositive, null);
  assert.strictEqual(preflight.conclusions.executableNow, null); assert.strictEqual(preflight.conclusions.deploymentApplicability, null);
  assert.strictEqual(preflight.conclusions.promotable, false); assert.strictEqual(preflight.conclusions.fork, false);
  const test = spawnSync(process.execPath, [absolute(`tools/test-${runner.STEM}.js`)],
    { cwd: path.join(runner.ROOT, "tools"), encoding: "utf8", timeout: 120000 });
  assert.strictEqual(test.status, 0, test.stderr || test.stdout); assert.match(test.stdout, /zero network\/inventory\/capture/u);
  process.stdout.write(`beefy balancer v3 monad validation passed: ${manifest.artifacts.length} artifacts, ${manifest.runtimeDependencyGraph.length} runtime files, ${manifest.localInputs.length} local inputs, aggregate ${manifest.aggregateSha256}\n`);
}
try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
