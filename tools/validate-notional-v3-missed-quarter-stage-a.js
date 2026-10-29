#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const r = require("./notional-v3-missed-quarter-stage-a-runner");
const absolute = (relative) => path.join(r.ROOT, ...relative.split("/"));

function main() {
  const manifest = JSON.parse(fs.readFileSync(absolute(r.MANIFEST_REL), "utf8"));
  assert.strictEqual(manifest.schemaVersion, 2); assert.strictEqual(manifest.findingId, r.FINDING_ID);
  assert.strictEqual(manifest.status, "STAGE_A_OFFLINE_PACKAGE_VALIDATED_CAPTURE_NOT_EXECUTED");
  assert.strictEqual(manifest.networkReads, 0); assert.strictEqual(manifest.inventoryReads, 0); assert.strictEqual(manifest.captureExecuted, false);
  assert.strictEqual(manifest.aggregateSha256, r.EXPECTED_PACKAGE_AGGREGATE); assert.strictEqual(r.packageAggregate(manifest), manifest.aggregateSha256);
  assert.strictEqual(r.verifyPackageBeforeConsumption(), true); assert.strictEqual(r.verifyRecords(manifest.artifacts, r.REQUIRED_ARTIFACT_PATHS), true);
  assert.strictEqual(r.verifyRecords(manifest.localInputs, r.LOCAL_INPUT_RELS), true);
  const graph = r.loadedDependencyGraph(); assert.deepStrictEqual(manifest.runtimeDependencyGraph.map((row) => row.path), graph.map((row) => row.path));
  assert.strictEqual(r.verifyRecords(manifest.runtimeDependencyGraph, graph.map((row) => row.path)), true);
  const preflight = JSON.parse(fs.readFileSync(absolute(r.PREFLIGHT_REL), "utf8")); assert.deepStrictEqual(preflight, JSON.parse(JSON.stringify(r.dryPreflight())));
  assert.strictEqual(preflight.evidence.selectedFixedCallsPerFamily, 77); assert.strictEqual(preflight.evidence.conditionalMaximum, 9);
  assert.deepStrictEqual(preflight.evidence.currencyIds, [1, 2, 3, 5, 6, 7, 8, 9, 11]); assert.strictEqual(preflight.runtimeBinding.selectorOnlyStructural, false);
  assert.strictEqual(preflight.runtimeBinding.cborFullyParsedAndConsumed, true); assert.deepStrictEqual(preflight.classifications, r.CLASSIFICATIONS); assert.deepStrictEqual(preflight.sourceStates, r.SOURCE_STATES);
  assert.match(preflight.runtimeBinding.librarySelfReference, /offset 1 length 20/u); assert.strictEqual(preflight.noNToken.rawErrorPersisted, false); assert.strictEqual(preflight.timing.rawLastInitializedAfterBlock, "invalid");
  assert.strictEqual(preflight.coherence.exactCurrentMarketCount, true); assert.strictEqual(preflight.coherence.fullyZeroLagOneAndTriggerNamespace, true);
  assert.strictEqual(preflight.httpResponseCaps.exactBoundaryAccepted, true); assert.strictEqual(preflight.httpResponseCaps.validPrefixNeverParsedAfterOverflow, true); assert.strictEqual(preflight.httpResponseCaps.transactionalEndpointAndAggregateCounters, true);
  assert.deepStrictEqual(preflight.oneShot.order, ["package-verify", "exclusive-output-reservation-with-durable-fallback", "durable-consumed-marker", "single-inventory-open"]);
  const runtime = JSON.parse(fs.readFileSync(absolute(r.RUNTIME_MANIFEST_REL), "utf8")); assert.strictEqual(runtime.schemaVersion, 2); assert.strictEqual(runtime.sourceCommit, r.SOURCE_COMMIT);
  assert.strictEqual(runtime.sourceTree, r.SOURCE_TREE); assert.strictEqual(Object.keys(runtime.contracts).length, 6);
  for (const row of Object.values(runtime.contracts)) { assert.ok(row.runtimeBytes <= r.CAPS.runtimeBytes); assert.strictEqual(row.cbor.validMap, true); const chars = row.runtimeTemplate.split("");
    for (const range of r.declaredRanges(row)) chars.splice(range.start * 2, range.length * 2, ..."00".repeat(range.length)); assert.strictEqual(r.cborBoundary(`0x${chars.join("")}`).fullyConsumed, true); }
  for (const role of ["initializeMarkets", "nTokenMint", "freeCollateral"]) { const row = runtime.contracts[role]; assert.strictEqual(row.contractKind, "library"); assert.deepStrictEqual(row.librarySelfReference.start, 1); assert.deepStrictEqual(row.librarySelfReference.length, 20); assert.strictEqual(r.validateLibrarySelfReference(row), true); }
  assert.strictEqual(fs.existsSync(absolute(r.CONSUMPTION_MARKER_REL)), false, "package must remain unconsumed");
  const capturePrefix = `${r.STEM}-notional-v3-stage-a-`; const captures = fs.readdirSync(absolute("reports/raw/fast")).filter((name) => name.startsWith(capturePrefix));
  assert.deepStrictEqual(captures, [], "capture output must remain absent");
  const test = spawnSync(process.execPath, [absolute(`tools/test-${r.STEM}.js`)], { cwd: absolute("tools"), encoding: "utf8", timeout: 300000 });
  assert.strictEqual(test.status, 0, test.stderr || test.stdout); assert.match(test.stdout, /148 checks/u); assert.match(test.stdout, /one full mocked two-family capture/u); assert.match(test.stdout, /zero real network\/inventory\/capture/u);
  process.stdout.write(`Notional V3 Stage-A validation passed: ${manifest.artifacts.length} artifacts, ${manifest.runtimeDependencyGraph.length} runtime files, ${manifest.localInputs.length} local inputs, aggregate ${manifest.aggregateSha256}\n`);
}
try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
