#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const r = require("./notional-v3-missed-quarter-stage-a-r2-runner");
const absolute = (relative) => path.join(r.ROOT, ...relative.split("/"));
function main() {
  assert.strictEqual(r.verifyR1Lineage(), true); const manifest = JSON.parse(fs.readFileSync(absolute(r.MANIFEST_REL), "utf8")); assert.strictEqual(manifest.schemaVersion, 1); assert.strictEqual(manifest.findingId, r.FINDING_ID);
  assert.strictEqual(manifest.status, "STAGE_A_R2_OFFLINE_PACKAGE_VALIDATED_CAPTURE_NOT_EXECUTED"); assert.strictEqual(manifest.lineage.aggregateSha256, r.R1_LINEAGE.aggregateSha256); assert.strictEqual(manifest.lineage.result.sha256, r.R1_LINEAGE.result.sha256);
  assert.strictEqual(manifest.lineage.result.status, "NOTIONAL_STAGE_A_REJECTED"); assert.strictEqual(manifest.lineage.result.calls, 0); assert.strictEqual(manifest.lineage.result.responseBytes, 0);
  assert.deepStrictEqual(manifest.successorPolicy, { noSuccessorAfterAnyR2Dispatch: true, r2Dispatched: false }); assert.strictEqual(manifest.networkReads, 0); assert.strictEqual(manifest.inventoryReads, 0); assert.strictEqual(manifest.captureExecuted, false);
  assert.strictEqual(manifest.aggregateSha256, r.EXPECTED_PACKAGE_AGGREGATE); assert.strictEqual(r.packageAggregate(manifest), manifest.aggregateSha256); assert.strictEqual(r.verifyPackageBeforeConsumption(), true);
  assert.strictEqual(r.verifyRecords(manifest.artifacts, r.REQUIRED_ARTIFACT_PATHS), true); assert.strictEqual(r.verifyRecords(manifest.localInputs, r.LOCAL_INPUT_RELS), true); const graph = r.loadedDependencyGraph();
  assert.deepStrictEqual(manifest.runtimeDependencyGraph.map((row) => row.path), graph.map((row) => row.path)); assert.strictEqual(r.verifyRecords(manifest.runtimeDependencyGraph, graph.map((row) => row.path)), true);
  const preflight = JSON.parse(fs.readFileSync(absolute(r.PREFLIGHT_REL), "utf8")); assert.deepStrictEqual(preflight, JSON.parse(JSON.stringify(r.dryPreflight()))); assert.strictEqual(preflight.lineage.r1Calls, 0);
  assert.strictEqual(preflight.parser.annotatedEthereumDirectAndAngleUrls, true); assert.deepStrictEqual(preflight.parser.pool, { maximumInstances: 6, maximumFamilies: 4, maximumPerFamily: 2, uniqueHost: true, order: "preferred-premium-credentialed-then-fallback-public-unannotated-stable-family-rounds" });
  assert.strictEqual(preflight.parser.outputContainsIdentitiesMaterialOrParserCounts, false); assert.strictEqual(preflight.qualification.finalSelectionAfterCapabilityConsensus, true); assert.strictEqual(preflight.qualification.retries, 0); assert.strictEqual(preflight.qualification.noRetriesOrReplacementAfterQualification, true);
  assert.strictEqual(preflight.successorPolicy.noSuccessorAfterAnyR2Dispatch, true); assert.deepStrictEqual(preflight.offlineValidation, { inheritedR1Assertions: 148, r2Assertions: 65, totalAssertions: 213, fixtureClasses: 16, fullMockedAnnotatedTwoFamilyCapture: true });
  const actual = r.parseInventoryText(fs.readFileSync(absolute(r.ANNOTATED_FIXTURE_REL), "utf8")); assert.strictEqual(actual.rows.length, 6); assert.strictEqual(new Set(actual.rows.map((row) => row.family)).size, 4);
  const runtime = JSON.parse(fs.readFileSync(absolute(r.RUNTIME_MANIFEST_REL), "utf8")); assert.strictEqual(runtime.sourceCommit, r.SOURCE_COMMIT); assert.strictEqual(runtime.sourceTree, r.SOURCE_TREE); assert.strictEqual(Object.keys(runtime.contracts).length, 6);
  assert.strictEqual(fs.existsSync(absolute(r.CONSUMPTION_MARKER_REL)), false, "R2 marker must remain absent"); const outputPrefix = `${r.STEM}-notional-v3-stage-a-r2-`, outputs = fs.readdirSync(absolute("reports/raw/fast")).filter((name) => name.startsWith(outputPrefix)); assert.deepStrictEqual(outputs, [], "R2 capture output must remain absent");
  assert.strictEqual(fs.existsSync(absolute(r.R1_LINEAGE.marker.path)), true, "R1 consumed marker retained"); const test = spawnSync(process.execPath, [absolute(`tools/test-${r.STEM}.js`)], { cwd: absolute("tools"), encoding: "utf8", timeout: 600000 });
  assert.strictEqual(test.status, 0, test.stderr || test.stdout); assert.match(test.stdout, /148 inherited R1 assertions unchanged \+ 65 substantive R2 assertions = 213 total/u); assert.match(test.stdout, /zero real inventory\/network\/RPC\/capture\/output/u);
  assert.strictEqual(r.verifyR1Lineage(), true); process.stdout.write(`Notional V3 Stage-A R2 validation passed: ${manifest.artifacts.length} artifacts, ${manifest.runtimeDependencyGraph.length} runtime files, ${manifest.localInputs.length} local inputs, 213 assertions, aggregate ${manifest.aggregateSha256}\n`);
}
try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
