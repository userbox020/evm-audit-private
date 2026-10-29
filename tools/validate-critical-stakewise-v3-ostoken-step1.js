#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "stakewise-v3-core-v5.0.1");
const PREFIX = "reports/raw/fast/critical-stakewise-v3-ostoken-step1";
const MANIFEST = `${PREFIX}-manifest.json`;
const SOURCE_CLOSURE = `${PREFIX}-source-closure.json`;
const INVARIANT_FAILURE_CACHE_RELATIVE =
  "cache/invariant/failures/StakeWiseOsTokenStep1InvariantTest/invariant_positionsIndependentOfTransfersAndNoUnrelatedProfit";
const INVARIANT_FAILURE_CACHE = path.join(TARGET, ...INVARIANT_FAILURE_CACHE_RELATIVE.split("/"));
const ENVIRONMENT_STATEMENT = "No endpoint/secret environment values consumed; controlled Foundry profile/run/depth/seed settings were intentionally supplied.";
const rel = (value) => path.join(ROOT, ...value.split("/"));
const read = (value) => fs.readFileSync(rel(value));
const text = (value) => read(value).toString("utf8");
const json = (value) => JSON.parse(text(value));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}

function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}

const specs = [
  {
    name: "focused",
    args: ["test", "--offline", "--match-path", "test/local/StakeWiseOsTokenStep1.t.sol", "--match-contract",
      "StakeWiseOsTokenStep1Test", "--fuzz-runs", "512", "--fuzz-seed", "0x5A17", "-vv"],
    expectedExitCode: 0
  },
  {
    name: "invariant",
    args: ["test", "--offline", "--match-path", "test/local/StakeWiseOsTokenStep1.t.sol", "--match-contract",
      "StakeWiseOsTokenStep1InvariantTest", "--fuzz-seed", "0x5A17", "-vv"],
    controlledEnv: { FOUNDRY_INVARIANT_RUNS: "256", FOUNDRY_INVARIANT_DEPTH: "500" },
    expectedExitCode: 0
  },
  { name: "upstream-multicall", args: ["test", "--offline", "--match-path", "test/Multicall.t.sol", "-v"], expectedExitCode: 0 },
  {
    name: "upstream-vault-ostoken-blocked",
    args: ["test", "--offline", "--match-path", "test/VaultOsToken.t.sol", "-v"],
    expectedExitCode: 1
  },
  { name: "build", args: ["build", "--offline", "--force", "--skip", "test", "--build-info", "--build-info-path", "out/build-info"], expectedExitCode: 0 },
  { name: "harness-build-info", args: ["build", "--offline", "--build-info", "--build-info-path", "out/build-info",
    "test/local/StakeWiseOsTokenStep1.t.sol"], expectedExitCode: 0 },
  { name: "fmt", args: ["fmt", "--check", "test/local/StakeWiseOsTokenStep1.t.sol"], expectedExitCode: 0 }
];
const captureArtifacts = specs.flatMap((spec) => [
  `${PREFIX}-${spec.name}.capture.json`, `${PREFIX}-${spec.name}.stdout.txt`, `${PREFIX}-${spec.name}.stderr.txt`
]);
function buildInfoArtifacts() {
  const directory = path.join(TARGET, "out", "build-info");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
    .map((name) => `targets/stakewise-v3-core-v5.0.1/out/build-info/${name}`);
}

const artifacts = [
  "targets/stakewise-v3-core-v5.0.1/contracts/vaults/ethereum/EthVault.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/vaults/ethereum/EthVaultFactory.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/vaults/modules/VaultOsToken.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/tokens/OsTokenVaultController.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/tokens/OsToken.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/tokens/OsTokenConfig.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/vaults/VaultsRegistry.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/base/Multicall.sol",
  "targets/stakewise-v3-core-v5.0.1/test/local/StakeWiseOsTokenStep1.t.sol",
  "reports/critical-stakewise-v3-ostoken-step1.md",
  `${PREFIX}.json`,
  "tools/validate-critical-stakewise-v3-ostoken-step1.js",
  "coordination/inbox/critical/stakewise-v3-ostoken-step1.json",
  "coordination/handoffs/2026-07-31-critical-stakewise-v3-ostoken-step1.md",
  SOURCE_CLOSURE,
  ...buildInfoArtifacts(),
  ...captureArtifacts
];

function writeSourceClosure() {
  const sources = new Set();
  const buildInfos = buildInfoArtifacts();
  for (const artifactPath of buildInfos) {
    const value = json(artifactPath);
    for (const source of Object.keys((value.input && value.input.sources) || {})) sources.add(source.replaceAll("\\", "/"));
  }
  fs.writeFileSync(rel(SOURCE_CLOSURE), `${JSON.stringify({
    schemaVersion: 1,
    sourceTag: "v5.0.1",
    sourceCommit: "fc70cbe1b3d41bc5f78434830d837aa270ca33bc",
    compiler: "solc 0.8.26",
    buildInfoFiles: buildInfos,
    sourceCount: sources.size,
    sources: [...sources].sort()
  }, null, 2)}\n`, "utf8");
}

function sanitizedChildEnv(spec) {
  const inheritedKeys = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE",
    "LOCALAPPDATA", "APPDATA", "HOME"];
  const env = {};
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.FOUNDRY_PROFILE = "default";
  return { ...env, ...(spec.controlledEnv || {}) };
}

function clearExactInvariantFailureCache() {
  const existedBeforeCapture = fs.existsSync(INVARIANT_FAILURE_CACHE);
  let removedExactFile = false;
  if (existedBeforeCapture) {
    const stat = fs.lstatSync(INVARIANT_FAILURE_CACHE);
    if (!stat.isFile()) throw new Error(`refusing non-file invariant cache path: ${INVARIANT_FAILURE_CACHE_RELATIVE}`);
    fs.unlinkSync(INVARIANT_FAILURE_CACHE);
    removedExactFile = true;
  }
  return {
    path: INVARIANT_FAILURE_CACHE_RELATIVE,
    existedBeforeCapture,
    removedExactFile,
    broadDeletePerformed: false,
    existsAfterExactCleanup: fs.existsSync(INVARIANT_FAILURE_CACHE)
  };
}

function capture() {
  const forgeVersion = cp.execFileSync("forge", ["--version"], { cwd: TARGET, encoding: "utf8" }).trim();
  for (const spec of specs) {
    const invariantCacheHygiene = spec.name === "invariant" ? clearExactInvariantFailureCache() : null;
    const result = cp.spawnSync("forge", spec.args, {
      cwd: TARGET,
      encoding: "utf8",
      env: sanitizedChildEnv(spec),
      maxBuffer: 64 * 1024 * 1024
    });
    const stdout = Buffer.from(result.stdout || "", "utf8");
    const stderr = Buffer.from(result.stderr || "", "utf8");
    const stdoutPath = `${PREFIX}-${spec.name}.stdout.txt`;
    const stderrPath = `${PREFIX}-${spec.name}.stderr.txt`;
    fs.writeFileSync(rel(stdoutPath), stdout);
    fs.writeFileSync(rel(stderrPath), stderr);
    const combinedOutput = `${result.stdout || ""}${result.stderr || ""}`;
    if (spec.name === "invariant") {
      invariantCacheHygiene.existsAfterCapture = fs.existsSync(INVARIANT_FAILURE_CACHE);
      invariantCacheHygiene.staleWarningPresent = /cache[\\/]invariant[\\/]failures|was ignored because test contract bytecode has changed/iu.test(combinedOutput);
      if (invariantCacheHygiene.staleWarningPresent) throw new Error("invariant capture contains stale-cache warning");
    }
    fs.writeFileSync(rel(`${PREFIX}-${spec.name}.capture.json`), `${JSON.stringify({
      schemaVersion: 1,
      capture: spec.name,
      capturedAt: new Date().toISOString(),
      command: `forge ${spec.args.join(" ")}`,
      cwd: "targets/stakewise-v3-core-v5.0.1",
      expectedExitCode: spec.expectedExitCode,
      exitCode: result.status,
      signal: result.signal,
      spawnError: result.error ? String(result.error.message || result.error) : null,
      forgeVersion,
      compiler: "solc 0.8.26",
      evmVersion: "cancun",
      optimizer: true,
      optimizerRuns: 200,
      viaIR: true,
      networkReads: 0,
      rpcReads: 0,
      forkCreated: false,
      fuzzSeed: spec.name === "focused" || spec.name === "invariant" ? "0x5A17" : null,
      invariantRuns: spec.name === "invariant" ? 256 : null,
      invariantDepth: spec.name === "invariant" ? 500 : null,
      endpointOrSecretEnvironmentValuesConsumed: 0,
      controlledFoundrySettings: {
        profile: "default",
        runs: spec.name === "invariant" ? 256 : null,
        depth: spec.name === "invariant" ? 500 : null,
        seed: spec.name === "focused" || spec.name === "invariant" ? "0x5A17" : null
      },
      environmentStatement: ENVIRONMENT_STATEMENT,
      invariantFailureCacheHygiene: invariantCacheHygiene,
      stdout: { path: stdoutPath, bytes: stdout.length, sha256: sha256(stdout) },
      stderr: { path: stderrPath, bytes: stderr.length, sha256: sha256(stderr) }
    }, null, 2)}\n`, "utf8");
    if (result.status !== spec.expectedExitCode || result.error) {
      throw new Error(`${spec.name} exit ${result.status}, expected ${spec.expectedExitCode}`);
    }
  }
  writeSourceClosure();
}

function manifestRecords() {
  return artifacts.map((artifactPath) => {
    const bytes = read(artifactPath);
    return { path: artifactPath, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

if (process.argv[2] === "--capture" && process.argv.length === 3) {
  capture();
  process.stdout.write("CAPTURED LOCAL-ONLY OSTOKEN STEP1; NO NETWORK/RPC/FORK\n");
  process.exit(0);
}

if (process.argv[2] === "--write-manifest" && process.argv.length === 3) {
  const records = manifestRecords();
  const aggregateSha256 = sha256(Buffer.from(records.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8"));
  fs.writeFileSync(rel(MANIFEST), `${JSON.stringify({
    schemaVersion: 1,
    findingId: "stakewise-v3-ostoken-step1",
    status: "CONDITIONAL_STRUCTURAL_FEE_DEBT_UNDERCHARGE_LOCAL_ROUTE_POSITIVE_DEPLOYMENT_UNVERIFIED",
    algorithm: "sha256",
    aggregateConstruction: "sha256(sorted(path + ':' + sha256).join('\\n'))",
    artifactCount: records.length,
    aggregateSha256,
    artifacts: records
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`WROTE ${records.length} artifacts; aggregate ${aggregateSha256}\n`);
  process.exit(0);
}

check(process.argv.length === 2, "usage: no args, --capture, or --write-manifest");
equal(cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8" }).trim(),
  "fc70cbe1b3d41bc5f78434830d837aa270ca33bc", "exact target commit");
equal(cp.execFileSync("git", ["describe", "--tags", "--exact-match"], { cwd: TARGET, encoding: "utf8" }).trim(),
  "v5.0.1", "exact target tag");
cp.execFileSync("git", ["diff", "--exit-code", "--", "contracts", "test/VaultOsToken.t.sol", "test/Multicall.t.sol"],
  { cwd: TARGET, stdio: "ignore" });
check(true, "production and upstream tests unchanged");
equal(json("reports/raw/fast/critical-stakewise-v3-eth-exitqueue-step1-manifest.json").aggregateSha256,
  "6b4b08afd330f5d7f94465bf79c66d09070c361c23d2a71403ea877d3fdf7050", "exit-queue Step1 immutable");
equal(json("reports/raw/fast/critical-stakewise-v3-eth-exitqueue-step2-manifest.json").aggregateSha256,
  "3e46957ed1380734d9fa2293e2d710dbf3cd11ea9a2efff252225ac693829361", "exit-queue Step2 immutable");

const foundry = text("targets/stakewise-v3-core-v5.0.1/foundry.toml");
for (const marker of ['solc = "0.8.26"', 'evm_version = "cancun"', "optimizer = true", "optimizer_runs = 200",
  "via_ir = true", "bytecode_hash = 'none'"]) check(foundry.includes(marker), `foundry setting ${marker}`);

const harness = text("targets/stakewise-v3-core-v5.0.1/test/local/StakeWiseOsTokenStep1.t.sol");
for (const marker of [
  "test_alternateReceiverTransferBurnAttributionAndAtomicRollback",
  "test_twoOwnersReceiversPartialFullRepeatedBurnAndTransfers", "test_zeroTinyMaxAndConversionBoundaries",
  "test_controllerFeeUpdateLazySyncAndExactTreasuryAccounting",
  "test_controllerUpdateBeforeVsAfterMintAndBurnNoFreeDebtReduction",
  "test_depositAndMintAlternateReceiverAndFailureRollback", "test_updateStateAndDepositAndMintOrderAndRollback",
  "test_multicallSenderOrderingAndPayableReuseImpossible",
  "test_maxLtvQueueAndDonateHealthRollbackThenBurnAllowsMutation",
  "test_donorChargedRewardCollateralAndForcedBalanceNotFree",
  "test_tinyControllerFloorNoZeroAssetSuccessfulShareMintOrBurn",
  "test_feeGapExactOneTwoTenUpdatesAndIndependentReference",
  "test_feeGapDirectExtraMintAgainstFairLiabilityAfterTenUpdates",
  "test_feeGapExtraMintRepeatableWithChargedCollateralHeadroom",
  "test_feeGapSplitFivePositionsAndSyncCadenceBounds",
  "test_feeGapRealisticHorizonAndExtremePermittedFeeReferenceBounds",
  "testFuzz_twoOwnerReceiverTransferBurnExactDeltas", "testFuzz_feeResidualBound",
  "invariant_controllerSharesEqualSupply", "invariant_successfulMintBurnExactDeltas",
  "invariant_positionsIndependentOfTransfersAndNoUnrelatedProfit", "invariant_positionLiabilityResidualBounded",
  "invariant_effectiveOperationCountersAndCaughtRollback", "operationCounts", "caughtRollbackViolation",
  "new OsTokenVaultController", "new OsToken(", "new OsTokenConfig", "new VaultsRegistry", "new EthVault(",
  "new EthVaultFactory", "vm.computeCreateAddress", "cumulativeTreasuryFeeShares", "residualGhost"
]) check(harness.includes(marker), `harness marker ${marker}`);
for (const forbidden of ["createSelectFork", "vm.env", "vm.etch", "MAINNET_RPC_URL"]) {
  check(!harness.includes(forbidden), `harness excludes ${forbidden}`);
}

const captures = {};
for (const spec of specs) {
  const captureRow = json(`${PREFIX}-${spec.name}.capture.json`);
  captures[spec.name] = captureRow;
  equal([captureRow.capture, captureRow.expectedExitCode, captureRow.exitCode, captureRow.signal, captureRow.spawnError],
    [spec.name, spec.expectedExitCode, spec.expectedExitCode, null, null], `${spec.name} exact exit`);
  check(captureRow.forgeVersion.includes("forge Version: 1.5.1-stable"), `${spec.name} Forge version`);
  equal([captureRow.compiler, captureRow.evmVersion, captureRow.optimizer, captureRow.optimizerRuns, captureRow.viaIR],
    ["solc 0.8.26", "cancun", true, 200, true], `${spec.name} compiler settings`);
  equal([captureRow.networkReads, captureRow.rpcReads, captureRow.forkCreated], [0, 0, false], `${spec.name} local only`);
  equal([captureRow.endpointOrSecretEnvironmentValuesConsumed, captureRow.environmentStatement],
    [0, ENVIRONMENT_STATEMENT], `${spec.name} precise environment statement`);
  equal(captureRow.controlledFoundrySettings,
    { profile: "default", runs: spec.name === "invariant" ? 256 : null,
      depth: spec.name === "invariant" ? 500 : null,
      seed: spec.name === "focused" || spec.name === "invariant" ? "0x5A17" : null },
    `${spec.name} controlled Foundry settings`);
  for (const stream of ["stdout", "stderr"]) {
    const bytes = read(captureRow[stream].path);
    equal([bytes.length, sha256(bytes)], [captureRow[stream].bytes, captureRow[stream].sha256],
      `${spec.name} ${stream} binding`);
  }
}

const focused = text(captures.focused.stdout.path) + text(captures.focused.stderr.path);
check(focused.includes("18 passed; 0 failed; 0 skipped"), "focused 18/18");
const fuzzRows = [...focused.matchAll(/^\[PASS\] testFuzz[^\n]+\(runs: (\d+),/gmu)];
equal(fuzzRows.length, 2, "two fuzz properties");
equal(fuzzRows.map((row) => Number(row[1])).reduce((sum, value) => sum + value, 0), 1024, "1,024 fuzz runs");

const invariant = text(captures.invariant.stdout.path) + text(captures.invariant.stderr.path);
const cacheHygiene = captures.invariant.invariantFailureCacheHygiene;
equal([cacheHygiene.path, cacheHygiene.removedExactFile, cacheHygiene.broadDeletePerformed,
  cacheHygiene.existsAfterExactCleanup, cacheHygiene.existsAfterCapture, cacheHygiene.staleWarningPresent],
  [INVARIANT_FAILURE_CACHE_RELATIVE, cacheHygiene.existedBeforeCapture, false, false, false, false],
  "exact invariant failure-cache hygiene");
check(!/cache[\\/]invariant[\\/]failures|was ignored because test contract bytecode has changed/iu.test(invariant),
  "fresh invariant output has no stale-cache warning");
check(invariant.includes("5 passed; 0 failed; 0 skipped"), "invariants 5/5");
const invariantRows = [...invariant.matchAll(/^\[PASS\] invariant_[^(]+\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)$/gmu)];
equal(invariantRows.length, 5, "five invariant rows");
for (const row of invariantRows) equal(row.slice(1).map(Number), [256, 128000, 0], "invariant tuple");
equal(invariantRows.reduce((sum, row) => sum + Number(row[2]), 0), 640000, "aggregate invariant calls");
for (const selector of ["burn", "deposit", "donate", "mint", "multicallMintBurn", "queue", "transfer", "update", "warp"]) {
  check(invariant.includes(`| StakeWiseOsTokenHandler | ${selector}`), `handler selector ${selector}`);
}
const counterNames = ["effective_attempted", "effective_succeeded", "effective_caught_reverts", "effective_precondition_skips"];
const counterRows = Object.fromEntries(counterNames.map((name) => [name,
  [...invariant.matchAll(new RegExp(`^  ${name}: (\\d+)$`, "gmu"))].map((row) => Number(row[1]))]));
for (const name of counterNames) equal(counterRows[name].length, 5, `${name} emitted once per campaign`);
for (let i = 0; i < 5; ++i) {
  equal(counterRows.effective_attempted[i], counterRows.effective_succeeded[i]
    + counterRows.effective_caught_reverts[i] + counterRows.effective_precondition_skips[i], `counter partition ${i}`);
}
for (const name of ["success_mint", "success_burn", "success_transfer", "success_update", "success_queue", "success_donate",
  "success_multicall"]) {
  const values = [...invariant.matchAll(new RegExp(`^  ${name}: (\\d+)$`, "gmu"))].map((row) => Number(row[1]));
  equal(values.length, 5, `${name} emitted once per campaign`);
  check(values.every((value) => value > 0), `${name} effective nonzero`);
}

const multicall = text(captures["upstream-multicall"].stdout.path) + text(captures["upstream-multicall"].stderr.path);
check(multicall.includes("10 passed; 0 failed; 0 skipped"), "upstream Multicall 10/10");
const blocked = text(captures["upstream-vault-ostoken-blocked"].stdout.path)
  + text(captures["upstream-vault-ostoken-blocked"].stderr.path);
check(blocked.includes('environment variable "MAINNET_RPC_URL" not found'), "VaultOsToken env blocker");
check(blocked.includes("0 passed; 1 failed; 0 skipped"), "VaultOsToken zero executed");
const build = text(captures.build.stdout.path) + text(captures.build.stderr.path);
check(build.includes("Compiling 258 files with Solc 0.8.26"), "build 258 files");
check(build.includes("Compiler run successful"), "build success");
equal(read(captures.fmt.stdout.path).length + read(captures.fmt.stderr.path).length, 0, "format clean");

const result = json(`${PREFIX}.json`);
equal(result.classification,
  "CONDITIONAL/STRUCTURAL-FEE-DEBT-UNDERCHARGE/LOCAL-DIRECT-EXTRA-MINT-ROUTE-POSITIVE/DEPLOYMENT-UNVERIFIED",
  "classification");
equal([result.feeGap.oneUpdate.unmatchedSupplyShares, result.feeGap.twoUpdates.unmatchedSupplyShares],
  ["11", "1683359986533142"], "one/two update fee gaps");
equal([result.evidence.focusedTests, result.evidence.fuzzRuns, result.evidence.invariants,
  result.evidence.invariantCallsAggregate, result.evidence.handlerSelectors, result.evidence.upstreamVaultOsTokenExecuted,
  result.evidence.buildFiles], [18, 1024, 5, 640000, 9, 0, 258], "evidence counts");
equal(result.feeGap.tenUpdates.unmatchedSupplyShares, "77634523687917358", "ten-update fee gap");
equal(result.directExtraMint.extraShares, "77634523687917358", "direct extra shares");
equal(result.directExtraMint.extraControllerDebtAssets, "183789151273036805", "extra debt assets");
equal([result.evidence.effectiveCounters.attempted, result.evidence.effectiveCounters.succeeded,
  result.evidence.effectiveCounters.caughtReverts, result.evidence.effectiveCounters.preconditionSkips],
  counterNames.map((name) => counterRows[name].reduce((sum, value) => sum + value, 0)), "effective counter totals");
equal(result.evidence.effectiveCounters.perCampaign.attempted, counterRows.effective_attempted, "attempted campaigns");
equal(result.evidence.effectiveCounters.perCampaign.succeeded, counterRows.effective_succeeded, "succeeded campaigns");
equal(result.evidence.effectiveCounters.perCampaign.caughtReverts, counterRows.effective_caught_reverts, "caught campaigns");
equal(result.evidence.effectiveCounters.perCampaign.preconditionSkips, counterRows.effective_precondition_skips, "skip campaigns");
equal([result.gates.sourcePrimitive, result.gates.localRoutePositive, result.gates.routePositive,
  result.gates.executableNow, result.gates.signedActionJustified, result.gates.fork], [1, 1, 0, 0, false, false], "gates");
equal([result.networkReads, result.rpcReads, result.endpointOrSecretEnvironmentValuesConsumed,
  result.blockedEnvironmentLookupAttempts, result.liveCaptureExecuted], [0, 0, 0, 1, false],
  "no live reads or endpoint/secret environment values and one fail-closed environment lookup");
equal([result.environmentStatement, result.controlledFoundrySettings],
  [ENVIRONMENT_STATEMENT, { profile: "default", invariantRuns: 256, invariantDepth: 500, fuzzSeed: "0x5A17" }],
  "raw precise environment statement and controlled settings");
equal(result.evidence.invariantFailureCacheHygiene,
  { path: INVARIANT_FAILURE_CACHE_RELATIVE, exactFileOnly: true, existedBeforeFreshCapture: false,
    removedExactFile: false, broadDeletePerformed: false, existsAfterFreshCapture: false, staleWarningPresent: false },
  "raw clean invariant-cache evidence");

const report = text("reports/critical-stakewise-v3-ostoken-step1.md");
for (const marker of ["STRUCTURAL FEE-DEBT UNDERCHARGE", "77634523687917358", "183789151273036805",
  "640,000", "10/10", "zero upstream tests executed", "258", "sourcePrimitive=1", ENVIRONMENT_STATEMENT]) {
  check(report.includes(marker), `report marker ${marker}`);
}
const inbox = json("coordination/inbox/critical/stakewise-v3-ostoken-step1.json");
equal([inbox.status, inbox.routePositive, inbox.executableNow, inbox.signedActionJustified, inbox.fork],
  ["conditional-structural-fee-debt-undercharge-local-route-positive-deployment-unverified", 0, 0, false, false], "inbox gates");
const handoff = text("coordination/handoffs/2026-07-31-critical-stakewise-v3-ostoken-step1.md");
check(handoff.includes("640,000") && handoff.includes("MAINNET_RPC_URL") && handoff.includes("1/1/0/0")
  && handoff.includes(ENVIRONMENT_STATEMENT), "handoff evidence");
const closure = json(SOURCE_CLOSURE);
equal([closure.sourceTag, closure.sourceCommit, closure.compiler],
  ["v5.0.1", "fc70cbe1b3d41bc5f78434830d837aa270ca33bc", "solc 0.8.26"], "source closure identity");
check(closure.sourceCount >= 259 && closure.sources.includes("test/local/StakeWiseOsTokenStep1.t.sol"), "full harness closure");
equal(closure.buildInfoFiles, buildInfoArtifacts(), "build-info closure binding");

const manifest = json(MANIFEST);
const expectedRecords = manifestRecords();
equal(manifest.artifacts, expectedRecords, "manifest records exact");
equal(manifest.aggregateSha256,
  sha256(Buffer.from(expectedRecords.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8")),
  "manifest aggregate");
equal([manifest.status, manifest.artifactCount],
  ["CONDITIONAL_STRUCTURAL_FEE_DEBT_UNDERCHARGE_LOCAL_ROUTE_POSITIVE_DEPLOYMENT_UNVERIFIED", artifacts.length],
  "manifest status/count");

for (const value of artifacts.filter((item) => item.endsWith(".json"))) {
  JSON.parse(text(value));
  check(true, `valid JSON ${value}`);
}
for (const value of artifacts.filter((item) => /\.(?:js|json|md|sol|txt)$/u.test(item) && !item.includes("/out/build-info/"))) {
  const content = text(value);
  check(!/[ \t]+$/gmu.test(content), `no trailing whitespace ${value}`);
  check(content.length === 0 || content.endsWith("\n"), `final newline ${value}`);
}
for (const value of [`${PREFIX}.json`, ...captureArtifacts, "coordination/inbox/critical/stakewise-v3-ostoken-step1.json"]) {
  const content = text(value);
  check(!/(?:https?|wss?):\/\//iu.test(content), `${value} has no URL`);
  check(!/seed phrase|private key|authorization: bearer|x-api-key/iu.test(content), `${value} has no secret marker`);
}

process.stdout.write(`${JSON.stringify({
  status: "CONDITIONAL_LOCAL_ROUTE_POSITIVE",
  checks,
  focusedTests: 18,
  fuzzRuns: 1024,
  invariantCalls: 640000,
  upstreamMulticall: 10,
  upstreamVaultOsTokenExecuted: 0,
  buildFiles: 258,
  artifactCount: artifacts.length,
  aggregateSha256: manifest.aggregateSha256,
  sourcePrimitive: 1,
  localRoutePositive: 1,
  routePositive: 0,
  executableNow: 0,
  signedActionJustified: false,
  fork: false,
  networkReads: 0,
  rpcReads: 0
}, null, 2)}\n`);
