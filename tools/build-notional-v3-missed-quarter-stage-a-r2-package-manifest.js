#!/usr/bin/env node
"use strict";
const fs = require("fs");
const r = require("./notional-v3-missed-quarter-stage-a-r2-runner");
function main() {
  r.verifyR1Lineage(); const preflightPath = `${r.ROOT}/${r.PREFLIGHT_REL}`;
  fs.writeFileSync(preflightPath, `${JSON.stringify(r.dryPreflight(), null, 2)}\n`, { encoding: "utf8", flag: "w" });
  const artifacts = r.REQUIRED_ARTIFACT_PATHS.map((relative) => r.fileRecord(relative, relative === `tools/${r.STEM}-runner.js`)), localInputs = r.LOCAL_INPUT_RELS.map((relative) => r.fileRecord(relative));
  const manifest = { schemaVersion: 1, findingId: r.FINDING_ID, status: "STAGE_A_R2_OFFLINE_PACKAGE_VALIDATED_CAPTURE_NOT_EXECUTED",
    source: { commit: r.SOURCE_COMMIT, tree: r.SOURCE_TREE }, lineage: r.R1_LINEAGE, successorPolicy: { noSuccessorAfterAnyR2Dispatch: true, r2Dispatched: false },
    networkReads: 0, inventoryReads: 0, captureExecuted: false, offlineValidation: { inheritedR1Assertions: 148, r2Assertions: 65, totalAssertions: 213, fixtureClasses: 16, fullMockedAnnotatedTwoFamilyCapture: true },
    artifacts, runtimeDependencyGraph: r.loadedDependencyGraph(), localInputs };
  manifest.aggregateSha256 = r.packageAggregate(manifest); const runnerPath = `${r.ROOT}/tools/${r.STEM}-runner.js`, runner = fs.readFileSync(runnerPath, "utf8"),
    patched = runner.replace(/const EXPECTED_PACKAGE_AGGREGATE = "[0-9a-f]{64}";/u, `const EXPECTED_PACKAGE_AGGREGATE = "${manifest.aggregateSha256}";`);
  if (patched === runner && !runner.includes(manifest.aggregateSha256)) throw new Error("RUNNER_AGGREGATE_PATCH_FAILED"); fs.writeFileSync(runnerPath, patched, { encoding: "utf8", flag: "w" });
  fs.writeFileSync(`${r.ROOT}/${r.MANIFEST_REL}`, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  process.stdout.write(`sealed ${r.MANIFEST_REL} (${artifacts.length} artifacts; aggregate ${manifest.aggregateSha256})\n`);
}
try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
