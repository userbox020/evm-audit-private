#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./critical-stakewise-v3-mainnet-deployment-economics-successor-r3-runner.js");

const ROOT = path.resolve(__dirname, "..");
const rel = (value) => path.join(ROOT, ...value.split("/"));
const read = (value) => fs.readFileSync(rel(value));
const text = (value) => read(value).toString("utf8");
const json = (value) => JSON.parse(text(value));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;
function check(value, message) { checks += 1; if (!value) throw new Error(`check ${checks} failed: ${message}`); }
function equal(actual, expected, message) { check(JSON.stringify(actual) === JSON.stringify(expected), message); }

check(process.argv.length === 2, "validator takes no arguments");
const scripts = [`tools/${runner.PREFIX}-runner.js`, `tools/test-${runner.PREFIX}.js`, `tools/validate-${runner.PREFIX}.js`];
for (const script of scripts) equal(cp.spawnSync(process.execPath, ["--check", rel(script)], { cwd: ROOT, env: {} }).status, 0,
  `${script} syntax`);

equal(json("reports/raw/fast/critical-stakewise-v3-mainnet-deployment-economics-successor-manifest.json").aggregateSha256,
  "bff81a2af3b762755dc27ab79f6d515b224505379f9c05429d1be754c2791d42", "R1 unchanged");
equal(json("reports/raw/fast/critical-stakewise-v3-mainnet-deployment-economics-successor-r2-manifest.json").aggregateSha256,
  "57dc239d68ee240585f519568c447f516cf9c93d49a44ba1dbfff92e4b036731", "R2 unchanged");
equal(sha256(read("tools/critical-stakewise-v3-mainnet-deployment-economics-successor-r2-runner.js")),
  "ef8f97a5ecd9da953eb11b46ee325589027309d8a0a42455d04f0b811b0ce298", "R2 runner unchanged");

const checkOnly = cp.spawnSync(process.execPath, [rel(scripts[0]), "--check-only"], { cwd: ROOT, env: {}, encoding: "utf8" });
equal([checkOnly.status, checkOnly.stderr], [0, ""], "check-only passes");
const generated = JSON.parse(checkOnly.stdout); const preflight = json(runner.PREFLIGHT_REL);
equal(generated, preflight, "checked-in preflight exact");
equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "preflight offline");
equal([preflight.correctness.stagedTypeAwareReads, preflight.correctness.metaSkipsVaultMevAndKeeper,
  preflight.correctness.datasetCompleteCoverageRequired, preflight.correctness.exactIntegerEconomicsOrNull,
  preflight.correctness.applicabilityMissingMeansNull], [true, true, true, true, true], "R3 correction declarations");
equal(preflight.caps.maxSubVaultsPerMeta, 50, "meta sub-vault cap");
equal(preflight.caps.retriesPerRequest, 0, "no retry");
equal(preflight.runtime, runner.runtimeBinding(), "runtime exact");
check(preflight.runtime.loadedEntry.path.endsWith("ethers/lib.commonjs/index.js"), "actual loaded ethers entry");
check(preflight.runtime.dependencyClosure.every((row) => row.integrity && row.packageJsonPath), "locked closure integrity");

const tests = cp.spawnSync(process.execPath, [rel(scripts[1])], { cwd: ROOT, env: {}, encoding: "utf8" });
equal([tests.status, tests.stderr], [0, ""], "synthetic tests pass");
const testResult = JSON.parse(tests.stdout);
equal([testResult.status, testResult.networkReads, testResult.inventoryReads, testResult.captureExecuted],
  ["PASS", 0, 0, false], "tests offline");
equal(testResult.fixtureClasses, 47, "all blocker fixture classes");

const source = text(scripts[0]);
for (const marker of [
  "META_SUBVAULTS", "NON_META_KEEPER_MEV", "subVaultsRegistry", "maxSubVaultsPerMeta", "stageError",
  "dataset.values.length === 0", "2 * dataset.values.length - 1", "TREE_LEAF_INDEX_COVERAGE_INCOMPLETE",
  "TREE_PARENT_RECOMPUTE_MISMATCH", "DISCOVERED_VAULT_ROWS_MISSING", "completeForDiscovered",
  "depositSharesCeil", "feeAssetsFloor", "feeSharesFloor", "queueConversionAssetsFloor",
  "checkpointBurnedSharesFloor", "attackerCheckpointAssetsFloor", "securityShares", "currentSupply",
  "EXACT_INTEGER_MODEL_WHEN_ALL_INPUTS_EXACT", "captureGates.allComplete !== true",
  "captureGates.familyAgreement !== true", "captureGates.terminalPin !== true", "captureGates.datasetComplete !== true",
  "deploymentApplicabilityCandidate: allComplete ?", "loadedEntryAbsolute", "integrity: row.integrity"
]) check(source.includes(marker), `runner marker ${marker}`);

const manifest = json(runner.MANIFEST_REL);
equal([manifest.schemaVersion, manifest.findingId, manifest.status], [3, runner.FINDING_ID, "R3_PREPARED_NOT_EXECUTED"],
  "manifest state");
const sections = ["artifacts", "reusedInputs", "productionInputs", "runtimeInputs"];
for (const section of sections) {
  check(Array.isArray(manifest[section]) && manifest[section].length > 0, `${section} nonempty`);
  for (const row of manifest[section]) {
    const bytes = read(row.path); equal([row.bytes, row.sha256], [bytes.length, sha256(bytes)], `${row.path} binding`);
  }
}
const allRecords = sections.flatMap((section) => manifest[section]);
const aggregate = sha256(Buffer.from(allRecords.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8"));
equal(manifest.aggregateSha256, aggregate, "aggregate covers every section");
equal(manifest.aggregateRecordCount, allRecords.length, "aggregate record count");
equal(manifest.runtime, runner.runtimeBinding(), "manifest runtime exact");
const entry = manifest.runtimeInputs.find((row) => row.path === `tools/${manifest.runtime.loadedEntry.path}`);
check(entry && entry.bytes === manifest.runtime.loadedEntry.bytes && entry.sha256 === manifest.runtime.loadedEntry.sha256,
  "loaded ethers executable entry independently bound");
for (const required of ["tools/package.json", "tools/package-lock.json", "tools/node_modules/ethers/package.json"]) {
  check(manifest.runtimeInputs.some((row) => row.path === required), `${required} runtime bound`);
}
for (const required of ["VaultImmutables.sol", "VaultEnterExit.sol", "VaultFee.sol", "SubVaultsRegistry.sol",
  "VaultSubVaults.sol", "VaultMev.sol", "SharedMevEscrow.sol", "ISharedMevEscrow.sol", "ExitQueue.sol"]) {
  check(manifest.productionInputs.some((row) => row.path.endsWith(required)), `${required} production bound`);
}
check(!allRecords.some((row) => /approval|capture\.json|consumption-ledger/iu.test(row.path)), "no consumed artifact bound");

const report = text(runner.REPORT_REL);
for (const marker of [runner.CAPTURE_FLAG, "R1 AND R2 BLOCKED UNCHANGED", "META_SUBVAULTS", "2*n-1",
  "fee shares", "One-wei", "exactly `null`", "actual loaded ethers", "aggregate covers all records",
  "No endpoint inventory"] ) check(report.includes(marker), `report marker ${marker}`);

const outputDir = path.dirname(rel(runner.PREFLIGHT_REL));
equal(fs.readdirSync(outputDir).filter((name) => name.startsWith(`${runner.PREFIX}-swv3econr3-`) && name.endsWith(".json")), [],
  "no R3 capture output");
for (const file of [...scripts, runner.FIXTURE_REL, runner.PREFLIGHT_REL, runner.MANIFEST_REL, runner.REPORT_REL]) {
  const value = text(file); check(value.endsWith("\n"), `${file} newline`); check(!/[ \t]+$/gmu.test(value), `${file} no trailing whitespace`);
}
for (const file of [runner.PREFLIGHT_REL, runner.MANIFEST_REL]) {
  const value = text(file); check(!/(?:https?|wss?):\/\//iu.test(value), `${file} no provider URL`);
  check(!/"(?:endpointHash|providerHash|hostname|domain|headers|rawResponse)"/iu.test(value), `${file} no provider material`);
}

process.stdout.write(`${JSON.stringify({ status: "PASS", checks, offlineFixtureChecks: testResult.checks,
  fixtureClasses: testResult.fixtureClasses, aggregateSha256: manifest.aggregateSha256,
  aggregateRecordCount: manifest.aggregateRecordCount, networkReads: 0, inventoryReads: 0, captureExecuted: false })}\n`);
