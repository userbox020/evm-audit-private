#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./critical-stakewise-v3-mainnet-deployment-economics-successor-r2-runner.js");

const ROOT = path.resolve(__dirname, "..");
const rel = (value) => path.join(ROOT, ...value.split("/"));
const read = (value) => fs.readFileSync(rel(value));
const text = (value) => read(value).toString("utf8");
const json = (value) => JSON.parse(text(value));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;
function check(value, message) { checks += 1; if (!value) throw new Error(`check ${checks} failed: ${message}`); }
function equal(actual, expected, message) { check(JSON.stringify(actual) === JSON.stringify(expected), message); }

check(process.argv.length === 2, "validator accepts no arguments");
const scripts = [`tools/${runner.PREFIX}-runner.js`, `tools/test-${runner.PREFIX}.js`, `tools/validate-${runner.PREFIX}.js`];
for (const script of scripts) equal(cp.spawnSync(process.execPath, ["--check", rel(script)], { cwd: ROOT, env: {} }).status, 0,
  `${script} syntax`);

const r1Manifest = json("reports/raw/fast/critical-stakewise-v3-mainnet-deployment-economics-successor-manifest.json");
equal(r1Manifest.aggregateSha256, "bff81a2af3b762755dc27ab79f6d515b224505379f9c05429d1be754c2791d42", "blocked R1 unchanged");
equal(sha256(read("tools/critical-stakewise-v3-mainnet-deployment-economics-successor-runner.js")),
  "f7e36ee422d3f4606278e3993bb41dadde9c64275f436b92ddc1d2102eb63aa1", "R1 runner unchanged");

const checkOnly = cp.spawnSync(process.execPath, [rel(scripts[0]), "--check-only"], { cwd: ROOT, env: {}, encoding: "utf8" });
equal([checkOnly.status, checkOnly.stderr], [0, ""], "R2 check-only passes");
const generated = JSON.parse(checkOnly.stdout); const preflight = json(runner.PREFLIGHT_REL);
equal(generated, preflight, "preflight exact");
equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "preflight no side effects");
equal([preflight.providerPolicy.hostnameConsensusPromotable, preflight.providerPolicy.backendIndependenceProven,
  preflight.providerPolicy.allResultsNonpromotable], [false, false, true], "consensus explicitly nonpromotable");
equal(preflight.correctness.rewardDelta, "proof.reward-storedReward", "correct reward delta");
equal(preflight.correctness.unlockedMevDoubleCounted, false, "unlocked MEV excluded");
equal(preflight.correctness.oneBehindPredicate,
  "canHarvest&& !isHarvestRequired && !stateUpdateRequired && vaultNonce+1==globalNonce", "one-behind exact");
equal(preflight.correctness.datasetSchema, "openzeppelin-standard-v1[address,int160,uint160]", "actual dataset schema");
equal(preflight.gates.routePositive, null, "route unknown");
equal(preflight.gates.executableNow, null, "executable unknown");
equal(preflight.caps.retriesPerRequest, 0, "no retry");
equal(preflight.runtime, runner.runtimeBinding(), "runtime binding exact");
equal(preflight.rolesRequired, runner.ROLE_KEYS, "all manifest roles required");

const tests = cp.spawnSync(process.execPath, [rel(scripts[1])], { cwd: ROOT, env: {}, encoding: "utf8" });
equal([tests.status, tests.stderr], [0, ""], "R2 synthetic tests pass");
const testResult = JSON.parse(tests.stdout);
equal([testResult.status, testResult.networkReads, testResult.inventoryReads, testResult.captureExecuted],
  ["PASS", 0, 0, false], "tests offline only");
equal(testResult.fixtureClasses, 47, "all blocker fixture classes");

const source = text(scripts[0]);
for (const marker of [
  "REQUIRED_${name}_MISSING", "missingRequiredFields", "counterEquationValid", "allStartedSettled", "group.cancel()",
  "proof.reward-storedReward", "unlockedMevCountedAsReward: false", "vault.isHarvestRequired === false",
  "vault.stateUpdateRequired === false", "vault.keeperRewardsNonce + 1n === globalNonce", "standard-v1",
  "INT160_MIN", "UINT160_MAX", "TREE_DUPLICATE_REJECTED", "MERKLE_PROOF_INVALID", "UNLOCKED_MEV_NONMONOTONIC",
  "EthFoxVault", "BLOCKLIST", "EthCommunityVault", "ERC20", "numericVersion", "GLOBAL_ROLE_INTEGRITY_FAILED",
  "LATEST_REWARDS_EVENT_KEEPER_MISMATCH", "finalizedBlockHash", "finalizedBlockTimestamp",
  "BACKEND_INDEPENDENCE_UNPROVEN", "routePositive: null", "deploymentApplicabilityCandidate", "runtimeBinding"
]) check(source.includes(marker), `runner correction marker ${marker}`);

const manifest = json(runner.MANIFEST_REL);
equal([manifest.schemaVersion, manifest.findingId, manifest.status], [2, runner.FINDING_ID, "R2_PREPARED_NOT_EXECUTED"],
  "manifest state");
for (const section of ["artifacts", "reusedToolInputs", "productionInputs", "runtimeInputs"]) {
  for (const row of manifest[section]) {
    const bytes = read(row.path); equal([row.bytes, row.sha256], [bytes.length, sha256(bytes)], `${row.path} binding`);
  }
}
const aggregate = sha256(Buffer.from(manifest.artifacts.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8"));
equal(manifest.aggregateSha256, aggregate, "artifact aggregate");
equal(manifest.runtime.nodeVersion, process.version, "manifest Node version");
equal(manifest.runtime.ethersVersion, "6.16.0", "manifest ethers version");
equal(manifest.runtime.dependencyClosure, runner.runtimeBinding().dependencyClosure, "manifest ethers closure");
for (const required of ["tools/package.json", "tools/package-lock.json", "tools/node_modules/ethers/package.json"]) {
  check(manifest.runtimeInputs.some((row) => row.path === required), `${required} bound`);
}
for (const required of ["KeeperRewards.sol", "VaultState.sol", "VaultMev.sol", "EthFoxVault.sol", "EthCommunityVault.sol",
  "OsTokenVaultController.sol", "OsTokenConfig.sol", "OsTokenRedeemer.sol"]) {
  check(manifest.productionInputs.some((row) => row.path.endsWith(required)), `${required} production binding`);
}
check(!manifest.productionInputs.some((row) => /approval|capture\.json|consumption-ledger/iu.test(row.path)),
  "no approval/consumed output bound");

const report = text(runner.REPORT_REL);
for (const marker of [runner.CAPTURE_FLAG, "R1 remains unchanged", "reward - storedReward", "StandardMerkleTree",
  "Fox is blocklist", "Community is public ERC20", "backend-independence", "routePositive", "Node `v24.13.0`", "No inventory or network capture"] ) {
  check(report.includes(marker), `report marker ${marker}`);
}

const outputDir = path.dirname(rel(runner.PREFLIGHT_REL));
const liveNames = fs.readdirSync(outputDir).filter((name) => name.startsWith(`${runner.PREFIX}-swv3econr2-`) && name.endsWith(".json"));
equal(liveNames, [], "no R2 live capture output exists");
for (const file of [...scripts, runner.FIXTURE_REL, runner.PREFLIGHT_REL, runner.MANIFEST_REL, runner.REPORT_REL]) {
  const value = text(file); check(value.endsWith("\n"), `${file} final newline`); check(!/[ \t]+$/gmu.test(value), `${file} no trailing whitespace`);
}
for (const file of [runner.PREFLIGHT_REL, runner.MANIFEST_REL]) {
  const value = text(file); check(!/(?:https?|wss?):\/\//iu.test(value), `${file} no provider URL`);
  check(!/"(?:endpointHash|providerHash|hostname|domain|headers|rawResponse)"/iu.test(value), `${file} no provider material`);
}

process.stdout.write(`${JSON.stringify({ status: "PASS", checks, offlineFixtureChecks: testResult.checks,
  fixtureClasses: testResult.fixtureClasses, aggregateSha256: manifest.aggregateSha256, nodeVersion: process.version,
  ethersVersion: preflight.runtime.ethersVersion, networkReads: 0, inventoryReads: 0, captureExecuted: false })}\n`);
