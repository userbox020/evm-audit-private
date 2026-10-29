#!/usr/bin/env node
"use strict";
const assert = require("assert"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const r = require("./beefy-balancer-v3-monad-deployment-binding-r2-runner");
const absolute = (relative) => path.join(r.ROOT, ...relative.split("/"));
function independentAggregate(value) { const rows = [...value.artifacts.map((x) => `artifacts:${x.path}:${x.sha256}`),
  ...value.runtimeDependencyGraph.map((x) => `runtime:${x.path}:${x.sha256}`), ...value.localInputs.map((x) => `localInputs:${x.path}:${x.sha256}`)];
return crypto.createHash("sha256").update(rows.sort().join("\n")).digest("hex"); }
function main() {
  const manifest = JSON.parse(fs.readFileSync(absolute(r.MANIFEST_REL), "utf8"));
  assert.strictEqual(manifest.schemaVersion, 2); assert.strictEqual(manifest.findingId, r.FINDING_ID);
  assert.strictEqual(manifest.status, "R2_OFFLINE_PACKAGE_VALIDATED_CAPTURE_NOT_EXECUTED");
  assert.strictEqual(manifest.inventoryReads, 0); assert.strictEqual(manifest.networkReads, 0); assert.strictEqual(manifest.captureExecuted, false);
  assert.strictEqual(manifest.aggregateSha256, r.EXPECTED_PACKAGE_AGGREGATE);
  assert.strictEqual(independentAggregate(manifest), manifest.aggregateSha256);
  assert.strictEqual(r.verifyPackageBeforeConsumption(), true);
  assert.strictEqual(r.verifyRecords(manifest.artifacts, r.REQUIRED_ARTIFACT_PATHS), true);
  assert.strictEqual(r.verifyRecords(manifest.localInputs, r.LOCAL_INPUT_RELS), true);
  const graph = r.loadedDependencyGraph(); assert.deepStrictEqual(manifest.runtimeDependencyGraph.map((x) => x.path), graph.map((x) => x.path));
  assert.strictEqual(r.verifyRecords(manifest.runtimeDependencyGraph, graph.map((x) => x.path)), true);
  const tampered = structuredClone(manifest); tampered.artifacts[0].sha256 = "0".repeat(64);
  assert.notStrictEqual(independentAggregate(tampered), tampered.aggregateSha256);
  assert.throws(() => r.verifyPackageBeforeConsumption({ manifest: tampered }), /PACKAGE_AGGREGATE_MISMATCH/u);
  const preflight = JSON.parse(fs.readFileSync(absolute(r.PREFLIGHT_REL), "utf8"));
  assert.deepStrictEqual(preflight, JSON.parse(JSON.stringify(r.dryPreflight())));
  assert.strictEqual(preflight.oneShot.atomicExclusive, true); assert.strictEqual(preflight.oneShot.fileAndDirectoryFsyncBeforeInventory, true);
  assert.strictEqual(preflight.oneShot.neverRemovedOnFailure, true); assert.strictEqual(preflight.oneShot.freshUtcRunIdRequired, true);
  assert.strictEqual(preflight.endpointPolicy.minimumHostnameFamilies, 2); assert.strictEqual(preflight.pin.eip1898.requireCanonical, true);
  assert.deepStrictEqual([...preflight.methods.allowed].sort(), [...r.ALLOWED_METHODS].sort());
  assert.strictEqual(preflight.conclusions.economics, null); assert.strictEqual(preflight.conclusions.routePositive, null);
  assert.strictEqual(preflight.conclusions.executableNow, null); assert.strictEqual(preflight.conclusions.deploymentApplicability, null);
  assert.strictEqual(preflight.conclusions.promotable, false); assert.strictEqual(preflight.conclusions.fork, false);
  assert.ok(r.LOCAL_INPUT_RELS.includes("targets/beefy-contracts-4621d2dd/contracts/BIFI/infra/BeefySwapper.sol"));
  assert.strictEqual(fs.existsSync(absolute(r.CONSUMPTION_MARKER_REL)), false, "R2 marker must remain unconsumed");
  const test = spawnSync(process.execPath, [absolute(`tools/test-${r.STEM}.js`)], { cwd: path.join(r.ROOT,"tools"), encoding:"utf8", timeout:120000 });
  assert.strictEqual(test.status, 0, test.stderr || test.stdout); assert.match(test.stdout, /zero network\/inventory\/capture/u);
  process.stdout.write(`beefy balancer v3 monad R2 validation passed: ${manifest.artifacts.length} artifacts, ${manifest.runtimeDependencyGraph.length} runtime files, ${manifest.localInputs.length} local inputs, aggregate ${manifest.aggregateSha256}\n`);
}
try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
