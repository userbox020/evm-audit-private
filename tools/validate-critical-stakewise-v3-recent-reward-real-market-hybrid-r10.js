"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const runner = require("./critical-stakewise-v3-recent-reward-real-market-hybrid-r10-runner");

const ROOT = path.resolve(__dirname, "..");
function absolute(relative) { return path.join(ROOT, ...relative.split("/")); }
function independentPackageAggregate(value) {
  const records = [...(value.artifacts || []).map((row) => `artifacts:${row.path}:${row.sha256}`),
    ...(value.runtimeDependencyGraph || []).map((row) => `runtime:${row.path}:${row.sha256}`),
    ...(value.localInputs || []).map((row) => `localInputs:${row.path}:${row.sha256}`)];
  return crypto.createHash("sha256").update(records.sort().join("\n")).digest("hex");
}
function main() {
  const manifest = JSON.parse(fs.readFileSync(absolute(runner.MANIFEST_REL), "utf8"));
  assert.strictEqual(manifest.schemaVersion, 10);
  assert.strictEqual(manifest.findingId, runner.FINDING_ID);
  assert.strictEqual(manifest.status, "R10_OFFLINE_PACKAGE_VALIDATED_NO_CAPTURE");
  assert.strictEqual(manifest.predecessorAggregates.r9, "d45fce9d837ba0e7871caa59d810ef43d87429929e6cfe776f6945d47476e3cb");
  assert.strictEqual(runner.assertArtifactPathSet(manifest.artifacts), true);
  assert.strictEqual(runner.verifyFileRecords(manifest.artifacts, runner.REQUIRED_ARTIFACT_PATHS), true);
  assert.strictEqual(runner.verifyDependencyGraph(manifest.runtimeDependencyGraph), true);
  assert.strictEqual(runner.verifyFileRecords(manifest.localInputs, runner.LOCAL_INPUT_RELS), true);
  assert.strictEqual(independentPackageAggregate(manifest), manifest.aggregateSha256);
  const tampered = JSON.parse(JSON.stringify(manifest)); tampered.localInputs[0].sha256 = "f".repeat(64);
  assert.notStrictEqual(independentPackageAggregate(tampered), tampered.aggregateSha256);
  const preflight = JSON.parse(fs.readFileSync(absolute(runner.PREFLIGHT_REL), "utf8"));
  assert.deepStrictEqual(preflight, JSON.parse(JSON.stringify(runner.dryPreflight())));
  assert.strictEqual(preflight.scope.genesisOnly, true);
  assert.strictEqual(preflight.scope.recentRewardLookbackBlocks, 100000);
  assert.strictEqual(preflight.scope.rewardLogChunkBlocks, 5000);
  assert.strictEqual(preflight.correctness.gasCost, null);
  assert.strictEqual(preflight.correctness.modelExact, false);
  assert.strictEqual(preflight.correctness.requiredQuoteCellsMustBeNonNull, true);
  assert.strictEqual(preflight.correctness.controllerDebtConversionPerCell, true);
  assert.strictEqual(preflight.correctness.aaveVirtualUnderlyingFromDedicatedGetterOnly, true);
  assert.strictEqual(preflight.correctness.aaveReserveDataAbi, "ReserveDataLegacy_15_FIELDS");
  assert.strictEqual(preflight.correctness.aaveImplementationBinding, "UNKNOWN");
  assert.strictEqual(preflight.correctness.aaveFlashEligibility, null);
  assert.strictEqual(preflight.correctness.controllerHeadroomExact, null);
  assert.strictEqual(preflight.correctness.controllerEligibility, null);
  assert.strictEqual(preflight.correctness.genesisVersionRequired, 5);
  assert.strictEqual(preflight.gates.routePositive, null);
  assert.strictEqual(preflight.gates.promotable, false);
  for (const input of [
    "targets/gearbox-core-v3-v1.53.0/lib/@gearbox-protocol/sdk-gov/src/tokens/balancer.ts",
    "targets/gearbox-core-v3-v1.53.0/lib/@gearbox-protocol/sdk-gov/src/contracts/contracts.ts",
    "targets/aave-horizon-mglobal-address-book-a57a24d7/src/AaveV3Ethereum.sol",
    "tools/critical-stakewise-v3-mainnet-deployment-economics-successor-r3-runner.js",
    "targets/stakewise-v3-core-v5.0.1/contracts/vaults/modules/VaultState.sol",
    "targets/stakewise-v3-core-v5.0.1/contracts/vaults/modules/VaultEnterExit.sol",
    "targets/stakewise-v3-core-v5.0.1/contracts/vaults/modules/VaultOsToken.sol",
    "targets/stakewise-v3-core-v5.0.1/contracts/vaults/modules/VaultMev.sol",
    "targets/stakewise-v3-core-v5.0.1/contracts/tokens/OsTokenVaultController.sol",
    "targets/aave-v3-origin-v3.6.0-remediation/src/contracts/interfaces/IPool.sol",
    "targets/aave-v3-origin-v3.6.0-remediation/src/contracts/protocol/libraries/configuration/ReserveConfiguration.sol"
  ]) assert.ok(runner.LOCAL_INPUT_RELS.includes(input), input);
  const test = spawnSync(process.execPath, [absolute("tools/test-critical-stakewise-v3-recent-reward-real-market-hybrid-r10.js")],
    { cwd: path.join(ROOT, "tools"), encoding: "utf8", timeout: 120000 });
  assert.strictEqual(test.status, 0, test.stderr || test.stdout);
  assert.match(test.stdout, /zero network\/inventory reads/u);
  process.stdout.write(`stakewise hybrid r10 validation passed: ${manifest.artifacts.length} artifacts, ${manifest.runtimeDependencyGraph.length} runtime files, ${manifest.localInputs.length} local inputs, aggregate ${manifest.aggregateSha256}\n`);
}
try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
