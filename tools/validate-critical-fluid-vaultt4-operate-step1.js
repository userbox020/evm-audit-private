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

const prefix = "reports/raw/fast/critical-fluid-vaultt4-operate-step1";
const names = ["fmt", "build", "lint", "relevant-vault", "relevant-dex", "relevant-liquidity", "focused"];
const captures = {};

for (const name of names) {
  const capture = json(`${prefix}-${name}.capture.json`);
  captures[name] = capture;
  equal(capture.capture, name, `${name} capture name`);
  equal(capture.cwd, "targets/fluid-contracts-public", `${name} cwd`);
  equal(capture.exitCode, 0, `${name} exit code`);
  equal(capture.signal, null, `${name} signal`);
  equal(capture.spawnError, null, `${name} spawn error`);
  equal(capture.environment.RUN_OTHERS, "false", `${name} RUN_OTHERS`);
  check(name === "fmt" || capture.command.includes("--offline"), `${name} offline command`);
  check(capture.forgeVersion.stdout.includes("forge Version: 1.5.1-stable"), `${name} Forge version`);
  check(capture.solcVersion.stdout.includes("0.8.21+commit.d9974bed"), `${name} solc version`);
  equal(capture.gitHead.stdout.trim(), "a9949b48ba1247d4f478cd0acb40896b5c8bf3f8", `${name} git head`);
  for (const stream of ["stdout", "stderr"]) {
    const bytes = read(capture[stream].path);
    equal(bytes.length, capture[stream].bytes, `${name} ${stream} bytes`);
    equal(sha256(bytes), capture[stream].sha256, `${name} ${stream} hash`);
  }
}

equal(read(captures.fmt.stdout.path).length, 0, "fmt stdout empty");
equal(read(captures.fmt.stderr.path).length, 0, "fmt stderr empty");
check(captures.build.command.includes("--skip test"), "production build skips tests");

const buildOut = text(captures.build.stdout.path);
check(buildOut.includes("Compiling 209 files with Solc 0.8.21"), "production build compile count");
check(buildOut.includes("Compiler run successful with warnings:"), "production build warning-bearing success");
check(captures.build.stderr.bytes > 0, "production build stderr retained");

const lintOut = text(captures.lint.stdout.path);
const lintErr = text(captures.lint.stderr.path);
check(lintOut.includes("Compiling 197 files with Solc 0.8.21"), "lint compile count");
check(lintOut.includes("Compiler run successful with warnings:"), "lint compiler success");
equal((lintErr.match(/warning\[divide-before-multiply\]/gu) || []).length, 3, "divide warning count");
equal((lintErr.match(/warning\[unsafe-typecast\]/gu) || []).length, 53, "unsafe cast warning count");
equal((lintErr.match(/warning\[erc20-unchecked-transfer\]/gu) || []).length, 2, "unchecked transfer warning count");
equal((lintErr.match(/error\[/gu) || []).length, 0, "lint error diagnostics");

const focused = text(captures.focused.stdout.path);
const focusedErr = text(captures.focused.stderr.path);
check(focused.includes("Compiling 204 files with Solc 0.8.21"), "focused compile count");
equal((focused.match(/^\[PASS\]/gmu) || []).length, 17, "focused PASS lines");
check(focused.includes("Suite result: ok. 12 passed; 0 failed; 0 skipped"), "12-test unit suite");
check(focused.includes("Suite result: ok. 5 passed; 0 failed; 0 skipped"), "5-test invariant suite");
check(focused.includes("17 tests passed, 0 failed, 0 skipped (17 total tests)"), "focused aggregate");
check(focusedErr.includes("snapshot(): replaced by `snapshotState`") && focusedErr.includes("revertTo(uint256): replaced by `revertToState`"), "deprecated cheatcode notice retained");

const invariantRows = [...focused.matchAll(/^\[PASS\] (invariant_[^(]+)\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)$/gmu)];
equal(invariantRows.length, 4, "invariant property count");
for (const row of invariantRows) equal(row.slice(2).map(Number), [256, 8192, 0], `invariant tuple ${row[1]}`);
equal(invariantRows.reduce((sum, row) => sum + Number(row[3]), 0), 32768, "total invariant calls");

const handlerRows = [...focused.matchAll(/\| FluidVaultT4Step1StateHandler \| ([A-Za-z]+)\s+\| (\d+)\s+\| 0\s+\| 0\s+\|/gu)]
  .map((row) => [row[1], Number(row[2])]);
const handlerCampaign = [
  ["imperfectDeposit", 1660],
  ["imperfectPayback", 1617],
  ["outsiderBorrow", 1677],
  ["perfectDeposit", 1666],
  ["perfectPayback", 1572]
];
equal(handlerRows.length, 20, "four handler call tables");
for (let i = 0; i < 4; i += 1) equal(handlerRows.slice(i * 5, i * 5 + 5), handlerCampaign, `handler campaign ${i}`);
equal(handlerCampaign.reduce((sum, row) => sum + row[1], 0), 8192, "handler calls per campaign");

function namedAll(name) {
  const rows = [...focused.matchAll(new RegExp(`^  ${name}: (-?\\d+)$`, "gmu"))].map((row) => row[1]);
  check(rows.length > 0, `${name} present`);
  return rows;
}

const exactNamed = {
  BOUND_COL_MINTED: "3999997288615966180",
  BOUND_COL_BURNED: "2000000499840452800",
  BOUND_DEBT_MINTED: "400000284676048502",
  BOUND_DEBT_BURNED: "199999500026742726",
  NEGATIVE_TOKEN1_MAX_ACCEPTED: "-1",
  NEGATIVE_TOKEN1_ACTUAL_CONSUMED: "10000001",
  PERFECT_DEPOSIT_TOKEN0_MAX: "100000000000001000001",
  PERFECT_DEPOSIT_TOKEN1_MAX: "100000001",
  PERFECT_BORROW_TOKEN0_MIN: "9999999999997999999",
  PERFECT_BORROW_TOKEN1_MIN: "9999998",
  PERFECT_PAYBACK_TOKEN0_MAX: "5000000000000000001",
  PERFECT_PAYBACK_TOKEN1_MAX: "5000000",
  PERFECT_WITHDRAW_TOKEN0_MIN: "9999999999998999999",
  PERFECT_WITHDRAW_TOKEN1_MIN: "9999999",
  SUPPLY_EXCHANGE_PRICE_BEFORE: "1000000000000",
  SUPPLY_EXCHANGE_PRICE_AFTER: "1008219178082",
  BORROW_EXCHANGE_PRICE_BEFORE: "1000000000000",
  BORROW_EXCHANGE_PRICE_AFTER: "1008219178082",
  SPLIT_WHOLE_COL_SHARE_DELTA: "5967125934697",
  SPLIT_WHOLE_DEBT_SHARE_DELTA: "1650435368769",
  STATEFUL_OUTSIDER_EXPECTED_REVERTS: "1",
  MAX_SUPPLY_PREDICTION_WIDTH: "65536",
  MAX_DEBT_PREDICTION_WIDTH: "319997065856",
  RESERVE_CHECKS: "5"
};
for (const [name, value] of Object.entries(exactNamed)) equal(namedAll(name), [value], `${name} exact value`);
equal(namedAll("ROUNDTRIP_TOKEN0_DECIMALS"), ["18", "18"], "roundtrip token0 decimals");
equal(namedAll("ROUNDTRIP_TOKEN1_DECIMALS"), ["6", "8"], "roundtrip token1 decimals");
equal(namedAll("ROUNDTRIP_TOKEN0_LOSS"), ["2000002", "2000002"], "roundtrip token0 losses");
equal(namedAll("ROUNDTRIP_TOKEN1_LOSS"), ["2", "2"], "roundtrip token1 losses");
equal(namedAll("STATEFUL_ACTION_INDEX"), ["0", "1", "2", "3"], "bootstrap action indices");
equal(namedAll("STATEFUL_ACTION_SUCCESSES"), ["1", "1", "1", "1"], "bootstrap action successes");

const relevantVault = text(captures["relevant-vault"].stdout.path);
check(relevantVault.includes("2 tests passed, 0 failed, 0 skipped (2 total tests)"), "relevant VaultT4 total");
const relevantDex = text(captures["relevant-dex"].stdout.path);
check(relevantDex.includes("15 tests passed, 0 failed, 0 skipped (15 total tests)"), "relevant DEX total");
check(captures["relevant-dex"].command.includes("--ffi"), "relevant DEX local FFI declared");
const relevantLiquidity = text(captures["relevant-liquidity"].stdout.path);
check(relevantLiquidity.includes("409 tests passed, 0 failed, 0 skipped (409 total tests)"), "relevant Liquidity total");

const sourcePath = "targets/fluid-contracts-public/test/foundry/critical/fluidVaultT4OperateStep1.t.sol";
const source = text(sourcePath);
equal(sha256(read(sourcePath)), "18c31fbd386bf1d9f69b491a830bda604cce796691bf5846ac1293987f37c903", "source hash");
for (const marker of [
  "test_imperfectColAndDebtShareLimitsExactBoundaryPlusMinusOne",
  "test_perfectDepositSecondTokenNegativeMaxBypassIsSelfFunded",
  "test_perfectTokenMinMaxExactBoundariesAndOneUnitRejection",
  "test_perfectRoundTripSixEightEighteenDecimalsNoWalletGain",
  "invariant_walletLiquidityAndDexShareGhosts",
  "invariant_predictiveTwoSidedPositionBoundsAndOwnership",
  "invariant_packedSnapshotsAndReservesRemainCoherent"
]) check(source.includes(marker), `source marker ${marker}`);
check(source.includes("mapping(uint256 => uint256) public unexpectedReverts;"), "unexpected revert accounting");
check(source.includes("selector_ == VaultError.FluidVaultError.selector && id_ == VaultErrorTypes.Vault__NotAnOwner"), "exact outsider error tuple");

const productionOperate = text("targets/fluid-contracts-public/contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol");
check(productionOperate.includes("(colToken0MinMax_ <= 0) || (colToken0MinMax_ <= 0)"), "source-confirmed duplicate token0 validation");
check(productionOperate.includes("uint(colToken1MinMax_)"), "signed token1 maximum cast");
const colOperations = text("targets/fluid-contracts-public/contracts/protocols/dex/poolT1/coreModule/core/colOperations.sol");
check(colOperations.includes("token1Amt_ > maxToken1Deposit_") && colOperations.includes("_depositOrPaybackInLiquidity(TOKEN_1, token1Amt_, 0)"), "DEX actual token1 max and transfer path");

const result = json(`${prefix}.json`);
equal(result.revision, "R1", "result revision");
equal(result.target.sourceSha256, sha256(read(sourcePath)), "result source hash");
equal([result.routePositive, result.executableNow, result.signedActionJustified, result.fork], [0, 0, false, false], "operational gates");
equal([result.focused.unitTests, result.focused.invariantAndBootstrapTests, result.focused.totalTests], [12, 5, 17], "result focused counts");
equal([result.focused.invariantProperties, result.focused.invariantRunsEach, result.focused.invariantCallsEach, result.focused.invariantCallsTotal, result.focused.invariantReverts], [4, 256, 8192, 32768, 0], "result invariant counts");
equal(result.stateful.selectorCallsPerCampaign, 8192, "result selector calls");
equal(result.stateful.bootstrapSuccesses, [1, 1, 1, 1, null], "result bootstrap successes");
equal(result.finding.actualToken1Consumed, "10000001", "result validation finding consumption");
equal(result.finding.thirdPartyExtractionDemonstrated, false, "result no third-party extraction");
equal(result.relevantSuites.vaultT4.tests, 2, "result VaultT4 count");
equal(result.relevantSuites.dexConversion.tests, 15, "result DEX count");
equal(result.relevantSuites.liquidityUserModule.tests, 409, "result Liquidity count");
equal([result.lint.divideBeforeMultiplyWarnings, result.lint.unsafeTypecastWarnings, result.lint.erc20UncheckedTransferWarnings, result.lint.errorDiagnostics], [3, 53, 2, 0], "result lint counts");
equal(result.lint.warningFreeClaim, false, "no warning-free claim");

const compiled = json(`${prefix}-compiled-metadata.json`);
equal(compiled.source.sha256, sha256(read(compiled.source.path)), "compiled source hash");
equal(compiled.source.bytes, read(compiled.source.path).length, "compiled source bytes");
equal(compiled.buildInfo.sha256, sha256(read(compiled.buildInfo.path)), "build-info hash");
equal(compiled.buildInfo.bytes, read(compiled.buildInfo.path).length, "build-info bytes");
equal(compiled.artifacts.length, 6, "compiled artifact count");
for (const artifact of compiled.artifacts) {
  const bytes = read(artifact.path);
  equal(bytes.length, artifact.bytes, `artifact bytes ${artifact.path}`);
  equal(sha256(bytes), artifact.sha256, `artifact hash ${artifact.path}`);
}
equal(compiled.requiredProductionSources.length, 18, "required production source count");
const unitArtifact = json("targets/fluid-contracts-public/out/fluidVaultT4OperateStep1.t.sol/FluidVaultT4OperateStep1UnitTest.json");
equal(unitArtifact.metadata.compiler.version, compiled.compiler.artifactMetadataVersion, "artifact compiler version");
equal(unitArtifact.metadata.settings.optimizer, {enabled: true, runs: 10000000}, "artifact optimizer");
equal(unitArtifact.metadata.settings.evmVersion, "shanghai", "artifact EVM version");
equal(Object.keys(unitArtifact.metadata.sources).length, 197, "artifact metadata source count");
for (const productionSource of compiled.requiredProductionSources) {
  const targetPath = `targets/fluid-contracts-public/${productionSource.path}`;
  const bytes = read(targetPath);
  equal(bytes.length, productionSource.bytes, `production source bytes ${productionSource.path}`);
  equal(sha256(bytes), productionSource.sha256, `production source hash ${productionSource.path}`);
  check(Object.hasOwn(unitArtifact.metadata.sources, productionSource.path), `production source in artifact metadata ${productionSource.path}`);
}

const report = text("reports/critical-fluid-vaultt4-operate-token-share-conversion-step1.md");
check(report.includes("**Signal: PASS / ROUTE-NEGATIVE WITHIN TESTED LOCAL SURFACES / LOW INPUT-VALIDATION INCONSISTENCY / DEPLOYMENT UNVERIFIED**"), "report signal");
check(report.includes("FLUID-VT4-I01") && report.includes("10,000,001"), "report finding and evidence");
check(report.includes("32,768") && report.includes("409/409"), "report test evidence");
check(report.includes("3 `divide-before-multiply`, 53 `unsafe-typecast`, and 2 `erc20-unchecked-transfer`"), "report warning disclosure");
check(report.includes("exact solc `0.8.29`") && report.includes("DEPLOYMENT UNVERIFIED"), "report limitations");

const captureTool = text("tools/capture-critical-fluid-vaultt4-operate-step1.js");
check(captureTool.includes("const baseEnv = {RUN_OTHERS: \"false\"};"), "capture tool explicit RUN_OTHERS=false");
check(captureTool.includes("FOUNDRY_INVARIANT_RUNS: \"256\"") && captureTool.includes("FOUNDRY_INVARIANT_DEPTH: \"32\""), "capture invariant settings");
check(captureTool.includes("fs.writeFileSync(`${prefix}.stdout.txt`, stdout)") && captureTool.includes("fs.writeFileSync(`${prefix}.stderr.txt`, stderr)"), "capture tool writes raw streams");

const manifest = json(`${prefix}-manifest.json`);
equal(manifest.schemaVersion, 3, "manifest schema");
equal(manifest.artifactCount, manifest.artifacts.length, "manifest artifact count");
const manifestPaths = new Set();
for (const artifact of manifest.artifacts) {
  check(!manifestPaths.has(artifact.path), `manifest unique path ${artifact.path}`);
  manifestPaths.add(artifact.path);
  const bytes = read(artifact.path);
  equal(bytes.length, artifact.bytes, `manifest bytes ${artifact.path}`);
  equal(sha256(bytes), artifact.sha256, `manifest hash ${artifact.path}`);
}
const aggregate = sha256(Buffer.from(manifest.artifacts.map((artifact) => `${artifact.path}:${artifact.sha256}`).sort().join("\n"), "utf8"));
equal(aggregate, manifest.aggregateSha256, "manifest aggregate");
for (const name of names) {
  check(manifestPaths.has(`${prefix}-${name}.capture.json`), `manifest ${name} capture`);
  check(manifestPaths.has(captures[name].stdout.path), `manifest ${name} stdout`);
  check(manifestPaths.has(captures[name].stderr.path), `manifest ${name} stderr`);
}
for (const required of [
  sourcePath,
  "tools/capture-critical-fluid-vaultt4-operate-step1.js",
  "tools/validate-critical-fluid-vaultt4-operate-step1.js",
  "reports/critical-fluid-vaultt4-operate-token-share-conversion-step1.md",
  `${prefix}.json`,
  `${prefix}-compiled-metadata.json`
]) check(manifestPaths.has(required), `manifest required artifact ${required}`);

console.log(`PASS ${checks} checks; aggregate ${aggregate}`);
