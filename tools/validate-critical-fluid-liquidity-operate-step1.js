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

const prefix = "reports/raw/fast/critical-fluid-liquidity-operate-step1";
const captureNames = ["fmt", "lint", "focused", "existing-liquidity", "existing-ftoken", "existing-ftoken-invariant"];
const captures = {};

for (const name of captureNames) {
  const capturePath = `${prefix}-${name}.capture.json`;
  const capture = json(capturePath);
  captures[name] = capture;
  equal(capture.capture, name, `${name} capture name`);
  equal(capture.cwd, "targets/fluid-contracts-public", `${name} cwd`);
  equal(capture.exitCode, 0, `${name} exit code`);
  equal(capture.signal, null, `${name} signal`);
  equal(capture.spawnError, null, `${name} spawn error`);
  equal(capture.environment.RUN_OTHERS, "false", `${name} RUN_OTHERS`);
  check(capture.command.includes("--offline") || name === "fmt", `${name} offline command`);
  check(capture.forgeVersion.stdout.includes("forge Version: 1.5.1-stable"), `${name} Forge version`);
  check(capture.solcVersion.stdout.includes("0.8.21+commit.d9974bed") || name === "fmt", `${name} solc version`);
  for (const stream of ["stdout", "stderr"]) {
    const bytes = read(capture[stream].path);
    equal(bytes.length, capture[stream].bytes, `${name} ${stream} bytes`);
    equal(sha256(bytes), capture[stream].sha256, `${name} ${stream} hash`);
  }
}

const fmtOut = read(captures.fmt.stdout.path);
const fmtErr = read(captures.fmt.stderr.path);
equal(fmtOut.length, 0, "fmt stdout empty");
equal(fmtErr.length, 0, "fmt stderr empty");

const focused = text(captures.focused.stdout.path);
const focusedErr = read(captures.focused.stderr.path);
equal(focusedErr.length, 0, "focused stderr empty");
equal((focused.match(/^\[PASS\]/gmu) || []).length, 24, "focused PASS lines");
check(focused.includes("Suite result: ok. 18 passed; 0 failed; 0 skipped"), "18-test unit suite");
check(focused.includes("Suite result: ok. 6 passed; 0 failed; 0 skipped"), "6-test invariant suite");
check(focused.includes("Ran 2 test suites") && focused.includes("24 tests passed, 0 failed, 0 skipped (24 total tests)"), "focused aggregate");
check(focused.includes("testFuzz_bigMathExactErrorDirectionAndCanonicalIdempotence(uint256) (runs: 256"), "256-case BigMath fuzz");

const invariantRows = [...focused.matchAll(/^\[PASS\] invariant_[^(]+\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)$/gmu)];
equal(invariantRows.length, 4, "focused invariant property count");
for (const row of invariantRows) equal(row.slice(1).map(Number), [1000, 50000, 0], "focused invariant run/call/revert tuple");
equal(invariantRows.reduce((sum, row) => sum + Number(row[2]), 0), 200000, "focused total invariant calls");

const counterRows = [...focused.matchAll(/COUNTER_ACTION_INDEX: (\d+)\s+COUNTER_ACTION_SUCCESSES: (\d+)\s+COUNTER_ACTION_EXPECTED_REVERTS: (\d+)/gu)]
  .map((row) => row.slice(1).map(Number));
equal(counterRows, [
  [0, 1, 0], [1, 0, 1], [2, 1, 0], [3, 0, 1], [4, 1, 0], [5, 1, 0],
  [6, 1, 0], [7, 1, 0], [8, 1, 0], [9, 1, 0], [10, 0, 1]
], "counter action matrix");

const stateRows = [...focused.matchAll(/STATEFUL_ACTION_INDEX: (\d+)\s+STATEFUL_ACTION_SUCCESSES: (\d+)/gu)]
  .map((row) => row.slice(1).map(Number));
equal(stateRows, Array.from({length: 10}, (_, index) => [index, 1]), "stateful bootstrap success matrix");
const named = (name) => {
  const match = focused.match(new RegExp(`${name}: (\\d+)`, "u"));
  check(match !== null, `${name} present`);
  return match[1];
};
equal(named("STATEFUL_OUTSIDER_EXPECTED_REVERTS"), "1", "outsider exact expected revert count");
equal(named("PREDICTED_SUPPLY_LOWER"), "999999999975", "supply lower");
equal(named("PREDICTED_SUPPLY_UPPER"), "1000000000003", "supply upper");
equal(named("PREDICTED_DEBT_LOWER"), "0", "debt lower");
equal(named("PREDICTED_DEBT_UPPER"), "6", "debt upper");
equal(named("PACKED_PREDICTION_CHECKS"), "9", "prediction checks");
equal(named("MAX_SUPPLY_PREDICTION_WIDTH"), "28", "supply prediction width");
equal(named("MAX_DEBT_PREDICTION_WIDTH"), "6", "debt prediction width");

const existingLiquidity = text(captures["existing-liquidity"].stdout.path);
check(existingLiquidity.includes("Ran 56 test suites") && existingLiquidity.includes("409 tests passed, 0 failed, 0 skipped (409 total tests)"), "existing Liquidity total");
const existingFToken = text(captures["existing-ftoken"].stdout.path);
check(existingFToken.includes("Ran 3 test suites") && existingFToken.includes("56 tests passed, 0 failed, 0 skipped (56 total tests)"), "existing fToken total");
const existingInvariant = text(captures["existing-ftoken-invariant"].stdout.path);
const existingInvariantRows = [...existingInvariant.matchAll(/^\[PASS\] invariant_[^(]+\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)$/gmu)];
equal(existingInvariantRows.length, 5, "existing fToken invariant count");
for (const row of existingInvariantRows) equal(row.slice(1).map(Number), [64, 4096, 0], "existing fToken invariant tuple");
equal(existingInvariantRows.reduce((sum, row) => sum + Number(row[2]), 0), 20480, "existing fToken invariant calls");

const lintOut = text(captures.lint.stdout.path);
const lintErr = text(captures.lint.stderr.path);
check(lintOut.includes("Compiling 108 files with Solc 0.8.21"), "lint compile count");
check(lintOut.includes("Compiler run successful!"), "lint compile success");
equal((lintErr.match(/warning\[unsafe-typecast\]/gu) || []).length, 48, "retained lint warnings");
equal((lintErr.match(/error\[/gu) || []).length, 0, "no lint error diagnostics");

const sourcePath = "targets/fluid-contracts-public/test/foundry/critical/fluidLiquidityOperateStep1.t.sol";
const source = text(sourcePath);
equal(sha256(read(sourcePath)), "e610c182633914fcfc5c40365a9184081d8b36604c283e62b16718df8b34c76d", "source hash");
check(source.includes("mapping(uint256 => uint256) public unexpectedReverts;"), "unexpected revert counter");
check(source.includes("selector_ == expected_.selector") && source.includes("id_ == expected_.id") && source.includes("stringHash_ == expected_.stringHash"), "exact revert tuple checks");
check(!source.includes("console2"), "no uncaptured console2 path");
check(source.includes("predictedProtocolSupplyLower") && source.includes("_scaleLower") && source.includes("_roundingBound"), "predictive ghost machinery");
check(source.includes("lastPackedTotalSnapshot") && source.includes("packed totals changed without handler action"), "snapshot detection machinery");
check(source.includes("ghostFDepositRequestedAssets") && source.includes("ghostFRedeemActualAssets"), "requested/actual fToken ghosts");
check(source.includes("1_010_000_000_001") && source.includes("1_020_100_000_001"), "nested floor exact values");
check(source.includes("keccak256(type(FluidLiquidityUserModuleMainnet).runtimeCode)"), "Mainnet runtime codehash assertion");
check(!/vm\.etch\s*\(/u.test(source), "no vm.etch invocation");

const upstreamInvariant = text("targets/fluid-contracts-public/test/foundry/lending/big-test/fTokenInvariant.t.sol");
check(upstreamInvariant.includes("for (uint256 i = 0; i > users.length; i++)"), "upstream empty-loop caveat bound");
check(upstreamInvariant.includes("assertEq(token.decimals(), token.decimals())"), "upstream tautology caveat bound");

const result = json(`${prefix}.json`);
equal(result.revision, "R3", "result revision");
equal(result.target.sourceSha256, sha256(read(sourcePath)), "result source hash");
equal([result.routePositive, result.executableNow, result.signedActionJustified, result.fork], [0, 0, false, false], "operational gates");
equal([result.focused.unitTests, result.focused.stateInvariantAndCounterTests, result.focused.totalTests], [18, 6, 24], "result focused counts");
equal([result.focused.invariantProperties, result.focused.invariantRunsEach, result.focused.invariantCallsEach, result.focused.invariantCallsTotal, result.focused.invariantReverts], [4, 1000, 50000, 200000, 0], "result invariant counts");
equal(result.statefulDeterministic.counterSuccesses, counterRows.map((row) => row[1]), "result counter successes");
equal(result.statefulDeterministic.counterExpectedReverts, counterRows.map((row) => row[2]), "result counter reverts");
equal(result.statefulDeterministic.bootstrapSuccesses.slice(0, 10), stateRows.map((row) => row[1]), "result state successes");
equal(result.statefulDeterministic.maximumSupplyPredictionWidth, "28", "result supply width");
equal(result.statefulDeterministic.maximumDebtPredictionWidth, "6", "result debt width");
equal(result.existingSuites.liquidity.tests, 409, "result Liquidity count");
equal(result.existingSuites.fToken.tests, 56, "result fToken count");
equal(result.existingSuites.fTokenInvariant.callsTotal, 20480, "result fToken invariant calls");
equal(result.lint.unsafeTypecastWarnings, 48, "result warning count");
equal(result.lint.warningFreeClaim, false, "no warning-free claim");

const compiled = json(`${prefix}-compiled-metadata.json`);
equal(compiled.source.sha256, sha256(read(compiled.source.path)), "compiled source hash");
equal(compiled.source.bytes, read(compiled.source.path).length, "compiled source bytes");
equal(compiled.buildInfo.sha256, sha256(read(compiled.buildInfo.path)), "build-info hash");
equal(compiled.buildInfo.bytes, read(compiled.buildInfo.path).length, "build-info bytes");
equal(compiled.artifacts.length, 12, "compiled artifact count");
for (const artifact of compiled.artifacts) {
  const bytes = read(artifact.path);
  equal(bytes.length, artifact.bytes, `artifact bytes ${artifact.path}`);
  equal(sha256(bytes), artifact.sha256, `artifact hash ${artifact.path}`);
}

const report = text("reports/critical-fluid-liquidity-operate-callback-packed-accounting-step1.md");
check(report.includes("**Signal: PASS / ROUTE-NEGATIVE WITHIN TESTED LOCAL SURFACES / DEPLOYMENT UNVERIFIED**"), "report signal");
check(report.includes("200,000") && report.includes("20,480"), "report call counts");
check(report.includes("i > users.length") && report.includes("token.decimals() == token.decimals()"), "report upstream caveats");
check(report.includes("48 `unsafe-typecast` warnings"), "report warning disclosure");

const oldSummaries = [
  `${prefix}-forge.txt`, `${prefix}-lint.txt`, `${prefix}-existing-liquidity.txt`,
  `${prefix}-existing-ftoken.txt`, `${prefix}-existing-ftoken-invariant.txt`
];
for (const file of oldSummaries) check(!fs.existsSync(rel(...file.split("/"))), `stale prose summary absent: ${file}`);

const captureTool = text("tools/capture-critical-fluid-liquidity-operate-step1.js");
check(captureTool.includes("env: {RUN_OTHERS: \"false\""), "capture tool explicit RUN_OTHERS=false");
check(captureTool.includes("fs.writeFileSync(`${prefix}.stdout.txt`, stdout)"), "capture tool writes raw stdout bytes");
check(captureTool.includes("fs.writeFileSync(`${prefix}.stderr.txt`, stderr)"), "capture tool writes raw stderr bytes");

const manifest = json(`${prefix}-manifest.json`);
equal(manifest.schemaVersion, 3, "manifest schema");
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
check(manifestPaths.has(captures.focused.stdout.path) && manifestPaths.has(captures.focused.stderr.path), "manifest includes focused streams");
check(manifestPaths.has(`${prefix}.json`) && manifestPaths.has(`${prefix}-compiled-metadata.json`), "manifest includes result and compiled metadata");

console.log(`PASS ${checks} checks; aggregate ${aggregate}`);
