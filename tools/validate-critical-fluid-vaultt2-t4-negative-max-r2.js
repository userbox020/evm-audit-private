#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const rel = (...parts) => path.join(root, ...parts);
const read = (file) => fs.readFileSync(rel(...file.split("/")));
const text = (file) => read(file).toString("utf8");
const json = (file) => JSON.parse(text(file));
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}

function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

const prefix = "reports/raw/fast/critical-fluid-vaultt2-t4-negative-max-r2";
const captureNames = [
  "target-clean",
  "target-full-status",
  "vulnerable-clean",
  "vulnerable-full-status",
  "patched-full-status",
  "remediation-diff",
  "remediation-diff-check",
  "vulnerable-fmt",
  "patched-fmt",
  "vulnerable-lint",
  "patched-lint",
  "vulnerable-focused",
  "patched-build",
  "patched-focused",
  "relevant-vault",
  "relevant-dex",
  "liquidity-duplicate-regression"
];
const forgeCaptures = new Set([
  "vulnerable-fmt",
  "patched-fmt",
  "vulnerable-lint",
  "patched-lint",
  "vulnerable-focused",
  "patched-build",
  "patched-focused",
  "relevant-vault",
  "relevant-dex",
  "liquidity-duplicate-regression"
]);
const captures = {};

for (const name of captureNames) {
  const capture = json(`${prefix}-${name}.capture.json`);
  captures[name] = capture;
  equal(capture.capture, name, `${name} capture name`);
  equal(capture.exitCode, 0, `${name} exit code`);
  equal(capture.signal, null, `${name} signal`);
  equal(capture.timedOut, false, `${name} timeout`);
  equal(capture.spawnError, null, `${name} spawn error`);
  equal(capture.environment.RUN_OTHERS, "false", `${name} RUN_OTHERS`);
  equal(capture.environment.FLUID_R2_NETWORK_ALLOWED, "false", `${name} network flag`);
  equal(capture.gitHead.stdout.trim(), "a9949b48ba1247d4f478cd0acb40896b5c8bf3f8", `${name} git head`);
  check(capture.forgeVersion.stdout.includes("forge Version: 1.5.1-stable"), `${name} Forge version`);
  check(capture.solcVersion.stdout.includes("0.8.21+commit.d9974bed"), `${name} solc version`);
  if (forgeCaptures.has(name) && !name.endsWith("fmt")) check(capture.command.includes("--offline"), `${name} offline command`);
  for (const stream of ["stdout", "stderr"]) {
    const bytes = read(capture[stream].path);
    equal(bytes.length, capture[stream].bytes, `${name} ${stream} bytes`);
    equal(sha256(bytes), capture[stream].sha256, `${name} ${stream} hash`);
  }
}

equal(captures["target-clean"].cwd, "targets/fluid-contracts-public", "target status cwd");
equal(read(captures["target-clean"].stdout.path).length, 0, "target tracked status clean");
equal(text(captures["target-full-status"].stdout.path), "?? test/foundry/critical/\n", "target full status disclosed");
equal(read(captures["vulnerable-clean"].stdout.path).length, 0, "vulnerable tracked production clean");
equal(text(captures["vulnerable-full-status"].stdout.path), "?? test/foundry/critical/\n", "vulnerable full status");
equal(
  text(captures["patched-full-status"].stdout.path),
  " M contracts/protocols/vault/vaultT2/coreModule/mainOperate.sol\n M contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol\n?? test/foundry/critical/\n",
  "patched full status"
);

const diff = text(captures["remediation-diff"].stdout.path);
equal(sha256(read(captures["remediation-diff"].stdout.path)), "84abb7d78c0bdd84608be5ea1fdbf81a9e90f068ca40db28087543ebaec8025c", "remediation diff hash");
equal(read(captures["remediation-diff"].stdout.path).length, 1588, "remediation diff bytes");
equal((diff.match(/^diff --git /gmu) || []).length, 2, "two-file remediation diff");
equal((diff.match(/^-        if \(\(colToken0MinMax_ <= 0\) \|\| \(colToken0MinMax_ <= 0\)\)/gmu) || []).length, 2, "two vulnerable predicates in diff");
equal((diff.match(/^\+        if \(\(colToken0MinMax_ <= 0\) \|\| \(colToken1MinMax_ <= 0\)\)/gmu) || []).length, 2, "two patched predicates in diff");
equal(read(captures["remediation-diff-check"].stdout.path).length, 0, "diff check stdout empty");
check(text(captures["remediation-diff"].stderr.path).includes("LF will be replaced by CRLF"), "diff EOL warning retained");

for (const name of ["vulnerable-fmt", "patched-fmt"]) {
  equal(read(captures[name].stdout.path).length, 0, `${name} stdout empty`);
  equal(read(captures[name].stderr.path).length, 0, `${name} stderr empty`);
}

const vulnerableLintOut = text(captures["vulnerable-lint"].stdout.path);
const vulnerableLintErr = text(captures["vulnerable-lint"].stderr.path);
const patchedLintOut = text(captures["patched-lint"].stdout.path);
const patchedLintErr = text(captures["patched-lint"].stderr.path);
check(vulnerableLintOut.includes("Compiler run successful with warnings:"), "vulnerable lint compile success");
check(patchedLintOut.includes("Compiler run successful with warnings:"), "patched lint compile success");
equal((vulnerableLintErr.match(/warning\[unsafe-typecast\]/gu) || []).length, 8, "vulnerable unsafe cast warnings");
equal((vulnerableLintErr.match(/error\[/gu) || []).length, 0, "vulnerable lint errors");
equal((patchedLintErr.match(/warning\[divide-before-multiply\]/gu) || []).length, 5, "patched divide warnings");
equal((patchedLintErr.match(/warning\[unsafe-typecast\]/gu) || []).length, 45, "patched unsafe cast warnings");
equal((patchedLintErr.match(/error\[/gu) || []).length, 0, "patched lint errors");

const vulnerable = text(captures["vulnerable-focused"].stdout.path);
equal((vulnerable.match(/^\[PASS\]/gmu) || []).length, 4, "vulnerable PASS lines");
check(vulnerable.includes("4 tests passed, 0 failed, 0 skipped (4 total tests)"), "vulnerable aggregate");

function namedAll(transcript, name) {
  const rows = [...transcript.matchAll(new RegExp(`^  ${name}: (-?\\d+)$`, "gmu"))].map((row) => row[1]);
  check(rows.length > 0, `${name} present`);
  return rows;
}

equal(namedAll(vulnerable, "VULNERABLE_ORDER_TOKEN0_DECIMALS"), ["18", "6"], "vulnerable token0 orderings");
equal(namedAll(vulnerable, "VULNERABLE_ORDER_TOKEN1_DECIMALS"), ["6", "18"], "vulnerable token1 orderings");
equal(namedAll(vulnerable, "VULNERABLE_T2_NEGATIVE_TOKEN1_CONSUMED"), ["10000001", "10000000000001000001"], "vulnerable T2 acceptance");
equal(namedAll(vulnerable, "VULNERABLE_T4_NEGATIVE_TOKEN1_CONSUMED"), ["10000001", "10000000000001000001"], "vulnerable T4 acceptance");
const vulnerableExact = {
  T2_PRE_SHIFT_TOKEN1_QUOTE: "50000001",
  T2_POST_SHIFT_TOKEN1_CONSUMED: "54176322",
  T2_RESERVE_SHIFT_EXTRA_TOKEN1: "4176321",
  T2_POST_SHIFT_TOKEN0_MAX: "45841502929688000001",
  T2_POOL_SHARE_DELTA: "50000000000000000000",
  T2_POSITION_SUPPLY_CREDIT: "50000000000000000000",
  T2_RESERVE0_DELTA: "45841502929688",
  T2_RESERVE1_DELTA: "54176322000000",
  T2_ALLOWANCE1_SPEND: "54176322",
  T4_PRE_SHIFT_TOKEN1_QUOTE: "50000001",
  T4_POST_SHIFT_TOKEN1_CONSUMED: "52322670",
  T4_RESERVE_SHIFT_EXTRA_TOKEN1: "2322669",
  T4_POST_SHIFT_TOKEN0_MAX: "47682854655344000001",
  T4_POOL_SHARE_DELTA: "50000000000000000000",
  T4_POSITION_SUPPLY_CREDIT: "50000000000000000000",
  T4_RESERVE0_DELTA: "47682854655344",
  T4_RESERVE1_DELTA: "52322670000000",
  T4_ALLOWANCE1_SPEND: "52322670",
  DIRECT_CALLER_TOKEN1_SPEND: "10000001",
  OPERATOR_CALLER_TOKEN1_SPEND: "10000001",
  CUSTODIAL_CALLER_TOKEN1_SPEND: "10000001",
  OUTSIDER_GAIN: "0"
};
for (const [name, value] of Object.entries(vulnerableExact)) equal(namedAll(vulnerable, name), [value], `${name} exact`);

const patched = text(captures["patched-focused"].stdout.path);
equal((patched.match(/^\[PASS\]/gmu) || []).length, 12, "patched PASS lines");
check(patched.includes("Suite result: ok. 7 passed; 0 failed; 0 skipped"), "patched unit suite");
check(patched.includes("Suite result: ok. 5 passed; 0 failed; 0 skipped"), "patched invariant suite");
check(patched.includes("12 tests passed, 0 failed, 0 skipped (12 total tests)"), "patched aggregate");
const invariantRows = [...patched.matchAll(/^\[PASS\] (invariant_[^(]+)\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)$/gmu)];
equal(invariantRows.length, 4, "patched invariant count");
for (const row of invariantRows) equal(row.slice(2).map(Number), [128, 4096, 0], `patched invariant tuple ${row[1]}`);
equal(invariantRows.reduce((sum, row) => sum + Number(row[3]), 0), 16384, "patched total invariant calls");
equal(namedAll(patched, "AFTER_INVARIANT_CHECKS"), ["1", "1", "1", "1"], "afterInvariant enforcement count");

const handlerRows = [...patched.matchAll(/\| FluidVaultT2T4R2StateHandler \| ([A-Za-z]+)\s+\| (\d+)\s+\| 0\s+\| 0\s+\|/gu)]
  .map((row) => [row[1], Number(row[2])]);
const campaign = [
  ["imperfectDeposit", 577],
  ["imperfectPayback", 601],
  ["outsiderBorrow", 582],
  ["ownerBorrow", 596],
  ["ownerWithdraw", 578],
  ["perfectDeposit", 587],
  ["perfectPayback", 575]
];
equal(handlerRows.length, 28, "four handler tables");
for (let i = 0; i < 4; i += 1) equal(handlerRows.slice(i * 7, i * 7 + 7), campaign, `handler campaign ${i}`);
equal(campaign.reduce((sum, row) => sum + row[1], 0), 4096, "handler calls per campaign");

const patchedExact = {
  PATCHED_T2_PRE_SHIFT_TOKEN1_MAX: "50000001",
  PATCHED_T2_POST_SHIFT_TOKEN1_EXACT: "54176322",
  PATCHED_T4_PRE_SHIFT_TOKEN1_MAX: "50000001",
  PATCHED_T4_POST_SHIFT_TOKEN1_EXACT: "52322670",
  T2_NORMAL_DEBT_BORROW_TOKEN1: "1000000000",
  T2_DEBT_SLIPPAGE_ARGUMENTS: "0",
  T4_BORROW_TOKEN1_EXACT: "9999998",
  T4_PAYBACK_TOKEN1_EXACT: "10000000",
  T2_WITHDRAW_TOKEN1_EXACT: "9999999",
  T4_WITHDRAW_TOKEN1_EXACT: "9999999",
  PATCHED_DIRECT_MALFORMED_SPEND: "0",
  PATCHED_OPERATOR_MALFORMED_SPEND: "0",
  PATCHED_CUSTODIAL_MALFORMED_SPEND: "0",
  PATCHED_OUTSIDER_GAIN: "0",
  STATEFUL_OUTSIDER_EXPECTED_REVERTS: "1",
  STATEFUL_RESERVE_CHECKS: "7"
};
for (const [name, value] of Object.entries(patchedExact)) equal(namedAll(patched, name), [value], `${name} exact`);
equal(namedAll(patched, "PATCHED_ORDER_TOKEN0_DECIMALS"), ["18", "6"], "patched token0 orderings");
equal(namedAll(patched, "PATCHED_ORDER_TOKEN1_DECIMALS"), ["6", "18"], "patched token1 orderings");
equal(namedAll(patched, "STATEFUL_ACTION_INDEX"), ["0", "1", "2", "3", "4", "5"], "stateful action indices");
equal(namedAll(patched, "STATEFUL_ACTION_SUCCESSES"), ["1", "1", "1", "1", "1", "1"], "stateful bootstrap successes");

const buildOut = text(captures["patched-build"].stdout.path);
check(buildOut.includes("Compiling 209 files with Solc 0.8.21"), "patched build compile count");
check(buildOut.includes("Compiler run successful with warnings:"), "patched build success");
check(captures["patched-build"].command.includes("--skip test"), "patched production build skips tests");
check(captures["patched-build"].stderr.bytes > 0, "patched build warnings retained");
check(text(captures["relevant-vault"].stdout.path).includes("2 tests passed, 0 failed, 0 skipped (2 total tests)"), "relevant Vault total");
check(text(captures["relevant-dex"].stdout.path).includes("15 tests passed, 0 failed, 0 skipped (15 total tests)"), "relevant DEX total");
check(captures["relevant-dex"].command.includes("--ffi"), "local DEX FFI declared");
check(text(captures["liquidity-duplicate-regression"].stdout.path).includes("409 tests passed, 0 failed, 0 skipped (409 total tests)"), "Liquidity duplicate regression total");

const sourcePaths = {
  targetT2: "targets/fluid-contracts-public/contracts/protocols/vault/vaultT2/coreModule/mainOperate.sol",
  targetT4: "targets/fluid-contracts-public/contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol",
  vulnerableT2: "remediations/fluid-vaultt2-t4-r2-vulnerable/contracts/protocols/vault/vaultT2/coreModule/mainOperate.sol",
  vulnerableT4: "remediations/fluid-vaultt2-t4-r2-vulnerable/contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol",
  patchedT2: "remediations/fluid-vaultt2-t4-r2/contracts/protocols/vault/vaultT2/coreModule/mainOperate.sol",
  patchedT4: "remediations/fluid-vaultt2-t4-r2/contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol",
  vulnerableTest: "remediations/fluid-vaultt2-t4-r2-vulnerable/test/foundry/critical/fluidVaultT2T4NegativeMaxVulnerableR2.t.sol",
  patchedTest: "remediations/fluid-vaultt2-t4-r2/test/foundry/critical/fluidVaultT2T4NegativeMaxRemediationR2.t.sol"
};
equal(sha256(read(sourcePaths.targetT2)), "7fce18b280f3c2767b981ff33ea728e9737d5a2ec77c77617485abdea5018f39", "target T2 hash");
equal(sha256(read(sourcePaths.targetT4)), "cb094c994b4c919ba67b323b74c4c1bedfd9c7eb9d5d768baf7263b4c6cce51f", "target T4 hash");
equal(sha256(read(sourcePaths.vulnerableT2)), sha256(read(sourcePaths.targetT2)), "vulnerable T2 equals target");
equal(sha256(read(sourcePaths.vulnerableT4)), sha256(read(sourcePaths.targetT4)), "vulnerable T4 equals target");
equal(sha256(read(sourcePaths.patchedT2)), "8c767438462ce025af0eb6ccde6d973a173c4ad3d2241f437334a3f82c312b60", "patched T2 hash");
equal(sha256(read(sourcePaths.patchedT4)), "3e9d0ad4f78eb39ea97468215a17bfd63c8229cc4f102337a45f92d4e704eb67", "patched T4 hash");
equal(sha256(read(sourcePaths.vulnerableTest)), "c9bf05d6c3b54aa203cecfd6ecef1e0467ad5293d5a3fdc2c83037ab163951ac", "vulnerable test hash");
equal(sha256(read(sourcePaths.patchedTest)), "385eacfbaa9453bfff6a10d1d091b43eec89182073dd34084532e26d321f454a", "patched test hash");
for (const key of ["targetT2", "targetT4", "vulnerableT2", "vulnerableT4"]) {
  check(text(sourcePaths[key]).includes("(colToken0MinMax_ <= 0) || (colToken0MinMax_ <= 0)"), `${key} vulnerable predicate`);
}
for (const key of ["patchedT2", "patchedT4"]) {
  check(text(sourcePaths[key]).includes("(colToken0MinMax_ <= 0) || (colToken1MinMax_ <= 0)"), `${key} patched predicate`);
  check(!text(sourcePaths[key]).includes("(colToken0MinMax_ <= 0) || (colToken0MinMax_ <= 0)"), `${key} duplicate absent`);
}
const patchedTest = text(sourcePaths.patchedTest);
check(patchedTest.includes("FOUNDRY_INVARIANT_FAIL_ON_REVERT") === false, "fail-on-revert configured by capture, not source fiction");
check(patchedTest.includes("function afterInvariant()") && patchedTest.includes("handler.checkAfterInvariant()"), "afterInvariant hook");
check(patchedTest.includes("ownerWithdraw") && patchedTest.includes("ownerBorrow"), "owner output actions");
check(patchedTest.includes("predictedSupply[config_.bob]") && patchedTest.includes("_assertActorBounds(bob"), "Bob predictive bounds");
check(patchedTest.includes("packedVaultSnapshot") && patchedTest.includes("predictedDexSupplyShares"), "narrow snapshot and predictive share machinery");

const result = json(`${prefix}.json`);
equal(result.revision, "R2", "result revision");
equal([result.routePositive, result.executableNow, result.signedActionJustified, result.fork], [0, 0, false, false], "operational gates");
equal(result.severity, "conditional-low", "result severity");
equal(result.networkPureWorkflow, false, "result purity caveat");
equal(result.reserveShift.vaultT2.extraToken1Raw, "4176321", "result T2 extra spend");
equal(result.reserveShift.vaultT4.extraToken1Raw, "2322669", "result T4 extra spend");
equal(result.callerCategories.unauthorizedRouterCallerGainRaw, "0", "result outsider gain");
equal([result.patchedFocused.totalTests, result.patchedFocused.invariantCallsTotal, result.patchedFocused.afterInvariantChecks], [12, 16384, 4], "result patched counts");
equal(result.regressions.liquidityDuplicateOnly.additiveCoverageClaimed, false, "Liquidity duplicate-only classification");

const compiled = json(`${prefix}-compiled-metadata.json`);
for (const entry of compiled.productionSources) {
  const targetPath = `targets/fluid-contracts-public/${entry.path}`;
  const patchedPath = `remediations/fluid-vaultt2-t4-r2/${entry.path}`;
  equal(read(targetPath).length, entry.targetBytes, `metadata target bytes ${entry.path}`);
  equal(sha256(read(targetPath)), entry.targetSha256, `metadata target hash ${entry.path}`);
  equal(read(patchedPath).length, entry.patchedBytes, `metadata patched bytes ${entry.path}`);
  equal(sha256(read(patchedPath)), entry.patchedSha256, `metadata patched hash ${entry.path}`);
}
for (const entry of [compiled.patchedBuildInfo, compiled.vulnerableBuildInfo, ...compiled.patchedArtifacts, ...compiled.vulnerableArtifacts]) {
  equal(read(entry.path).length, entry.bytes, `compiled bytes ${entry.path}`);
  equal(sha256(read(entry.path)), entry.sha256, `compiled hash ${entry.path}`);
}
const patchedArtifact = json("remediations/fluid-vaultt2-t4-r2/out/fluidVaultT2T4NegativeMaxRemediationR2.t.sol/FluidVaultT2T4NegativeMaxRemediationR2UnitTest.json");
const vulnerableArtifact = json("remediations/fluid-vaultt2-t4-r2-vulnerable/out/fluidVaultT2T4NegativeMaxVulnerableR2.t.sol/FluidVaultT2T4NegativeMaxVulnerableR2Test.json");
for (const artifact of [patchedArtifact, vulnerableArtifact]) {
  equal(artifact.metadata.compiler.version, "0.8.21+commit.d9974bed", "artifact compiler");
  equal(artifact.metadata.settings.optimizer, {enabled: true, runs: 10000000}, "artifact optimizer");
  equal(artifact.metadata.settings.evmVersion, "shanghai", "artifact EVM version");
  equal(Object.keys(artifact.metadata.sources).length, 197, "artifact metadata source count");
}
check(Object.hasOwn(patchedArtifact.metadata.sources, "contracts/protocols/vault/vaultT2/coreModule/mainOperate.sol"), "patched artifact binds T2");
check(Object.hasOwn(patchedArtifact.metadata.sources, "contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol"), "patched artifact binds T4");

const purity = json(`${prefix}-network-purity-deviation.json`);
equal([purity.requestedNetworkAccess, purity.networkAttempted, purity.commandReachedProtocolTests], [false, true, false], "purity deviation facts");
equal([purity.rpcAccess, purity.secretAccess, purity.signedAction, purity.fork, purity.productionMutation], [false, false, false, false, false], "purity non-network safety facts");

const report = text("reports/critical-fluid-vaultt2-t4-smart-collateral-negative-max-r2.md");
check(report.includes("**Signal: 🟠 WATCH — CONDITIONAL LOW"), "report signal");
check(report.includes("VaultT2 and VaultT4 share the same smart-collateral defect"), "report shared defect");
check(report.includes("4.176321") && report.includes("2.322669"), "report reserve-shift economics");
check(report.includes("409/409") && report.includes("duplicate regression evidence"), "report Liquidity duplicate caveat");
check(report.includes("does **not** claim a network-pure current-turn workflow"), "report purity disclosure");
check(report.includes("packed Vault/DEX values are only last-action mutation snapshots"), "report stateful narrowing");

const captureTool = text("tools/capture-critical-fluid-vaultt2-t4-negative-max-r2.js");
check(captureTool.includes("FLUID_R2_NETWORK_ALLOWED: \"false\""), "capture tool network flag");
check(captureTool.includes("FOUNDRY_INVARIANT_FAIL_ON_REVERT: \"true\""), "capture tool fail-on-revert");
check(captureTool.includes("fs.writeFileSync(`${prefix}.stdout.txt`, stdout)") && captureTool.includes("fs.writeFileSync(`${prefix}.stderr.txt`, stderr)"), "capture raw streams");

const manifest = json(`${prefix}-manifest.json`);
equal(manifest.schemaVersion, 3, "manifest schema");
equal(manifest.artifactCount, manifest.artifacts.length, "manifest artifact count");
const manifestPaths = new Set();
for (const artifact of manifest.artifacts) {
  check(!manifestPaths.has(artifact.path), `manifest unique ${artifact.path}`);
  manifestPaths.add(artifact.path);
  equal(read(artifact.path).length, artifact.bytes, `manifest bytes ${artifact.path}`);
  equal(sha256(read(artifact.path)), artifact.sha256, `manifest hash ${artifact.path}`);
}
const aggregate = sha256(Buffer.from(manifest.artifacts.map((artifact) => `${artifact.path}:${artifact.sha256}`).sort().join("\n"), "utf8"));
equal(aggregate, manifest.aggregateSha256, "manifest aggregate");
for (const name of captureNames) {
  check(manifestPaths.has(`${prefix}-${name}.capture.json`), `manifest ${name} capture`);
  check(manifestPaths.has(captures[name].stdout.path), `manifest ${name} stdout`);
  check(manifestPaths.has(captures[name].stderr.path), `manifest ${name} stderr`);
}
for (const required of [
  sourcePaths.targetT2,
  sourcePaths.targetT4,
  sourcePaths.vulnerableT2,
  sourcePaths.vulnerableT4,
  sourcePaths.patchedT2,
  sourcePaths.patchedT4,
  sourcePaths.vulnerableTest,
  sourcePaths.patchedTest,
  "tools/capture-critical-fluid-vaultt2-t4-negative-max-r2.js",
  "tools/validate-critical-fluid-vaultt2-t4-negative-max-r2.js",
  "reports/critical-fluid-vaultt2-t4-smart-collateral-negative-max-r2.md",
  `${prefix}.json`,
  `${prefix}-compiled-metadata.json`,
  `${prefix}-network-purity-deviation.json`
]) check(manifestPaths.has(required), `manifest required ${required}`);

console.log(`PASS ${checks} checks; aggregate ${aggregate}`);
