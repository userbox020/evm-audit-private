#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const target = path.join(root, "targets", "stakewise-v3-core-v5.0.1");
const rel = (file) => path.join(root, ...file.split("/"));
const read = (file) => fs.readFileSync(rel(file));
const text = (file) => read(file).toString("utf8");
const json = (file) => JSON.parse(text(file));
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const prefix = "reports/raw/fast/critical-stakewise-v3-eth-exitqueue-step1";
const manifestPath = `${prefix}-manifest.json`;
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}

function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}

const captureSpecs = [
  {
    name: "focused",
    args: ["test", "--match-contract", "StakeWiseEthExitQueueStep1Test", "--fuzz-runs", "512", "-vv"],
    expectedExitCode: 0,
    env: {}
  },
  {
    name: "invariant",
    args: ["test", "--match-contract", "StakeWiseEthExitQueueStep1InvariantTest", "-vv"],
    expectedExitCode: 0,
    env: {}
  },
  {
    name: "upstream-multicall",
    args: ["test", "--match-path", "test/Multicall.t.sol", "-vv"],
    expectedExitCode: 0,
    env: {}
  },
  {
    name: "upstream-queue-blocked",
    args: ["test", "--match-path", "test/VaultEnterExit.t.sol", "-vv"],
    expectedExitCode: 1,
    env: {}
  },
  {
    name: "build",
    args: ["build", "--offline", "--force", "--skip", "test"],
    expectedExitCode: 0,
    env: {}
  },
  {
    name: "fmt",
    args: ["fmt", "--check", "test/local/StakeWiseEthExitQueueStep1.t.sol"],
    expectedExitCode: 0,
    env: {}
  }
];

const captureArtifacts = [];
for (const spec of captureSpecs) {
  captureArtifacts.push(`${prefix}-${spec.name}.capture.json`);
  captureArtifacts.push(`${prefix}-${spec.name}.stdout.txt`);
  captureArtifacts.push(`${prefix}-${spec.name}.stderr.txt`);
}

const artifacts = [
  "contracts/vaults/ethereum/EthVault.sol",
  "contracts/vaults/modules/VaultEthStaking.sol",
  "contracts/vaults/modules/VaultEnterExit.sol",
  "contracts/vaults/modules/VaultState.sol",
  "contracts/libraries/ExitQueue.sol"
].map((file) => `targets/stakewise-v3-core-v5.0.1/${file}`).concat([
  "targets/stakewise-v3-core-v5.0.1/test/local/StakeWiseEthExitQueueStep1.t.sol",
  "reports/critical-stakewise-v3-eth-exitqueue-step1.md",
  `${prefix}.json`,
  "tools/validate-critical-stakewise-v3-eth-exitqueue-step1.js",
  ...captureArtifacts
]);

const supplementalArtifacts = [
  "reports/raw/fast/critical-stakewise-v3-eth-exitqueue-step1-validator.json",
  "coordination/inbox/critical/stakewise-v3-eth-exitqueue-step1.json",
  "coordination/handoffs/2026-07-30-critical-stakewise-v3-step1.md"
];

if (process.argv[2] === "--capture" && (process.argv.length === 3 || process.argv.length === 4)) {
  const selectedName = process.argv[3] || null;
  if (selectedName && !captureSpecs.some((spec) => spec.name === selectedName)) {
    throw new Error(`unknown capture ${selectedName}`);
  }
  const forgeVersion = cp.execFileSync("forge", ["--version"], { cwd: target, encoding: "utf8" }).trim();
  for (const spec of captureSpecs) {
    if (selectedName && spec.name !== selectedName) continue;
    const result = cp.spawnSync("forge", spec.args, {
      cwd: target,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...spec.env }
    });
    const stdout = Buffer.from(result.stdout || "", "utf8");
    const stderr = Buffer.from(result.stderr || "", "utf8");
    const stdoutPath = `${prefix}-${spec.name}.stdout.txt`;
    const stderrPath = `${prefix}-${spec.name}.stderr.txt`;
    fs.writeFileSync(rel(stdoutPath), stdout);
    fs.writeFileSync(rel(stderrPath), stderr);
    const capture = {
      schemaVersion: 1,
      capture: spec.name,
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
      environmentOverrides: spec.env,
      stdout: { path: stdoutPath, bytes: stdout.length, sha256: sha256(stdout) },
      stderr: { path: stderrPath, bytes: stderr.length, sha256: sha256(stderr) }
    };
    fs.writeFileSync(rel(`${prefix}-${spec.name}.capture.json`), `${JSON.stringify(capture, null, 2)}\n`, "utf8");
    if (result.status !== spec.expectedExitCode || result.error) {
      throw new Error(`${spec.name} exit ${result.status}, expected ${spec.expectedExitCode}`);
    }
    console.log(`CAPTURED ${spec.name}: exit ${result.status}, stdout ${stdout.length}, stderr ${stderr.length}`);
  }
  process.exit(0);
}

if (process.argv[2] === "--write-manifest" && process.argv.length === 3) {
  const records = artifacts.map((artifactPath) => {
    const bytes = read(artifactPath);
    return { path: artifactPath, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const aggregateSha256 = sha256(
    Buffer.from(records.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8")
  );
  const manifest = {
    schemaVersion: 4,
    findingId: "stakewise-v3-eth-exitqueue-step1-r2",
    algorithm: "sha256",
    aggregateConstruction: "sha256(sorted(path + ':' + sha256).join('\\n'))",
    artifactCount: records.length,
    aggregateSha256,
    artifacts: records
  };
  fs.writeFileSync(rel(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`WROTE ${records.length} artifacts; aggregate ${aggregateSha256}`);
  process.exit(0);
}

check(process.argv.length === 2, "usage: no args, --capture, or --write-manifest");
equal(cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim(),
  "fc70cbe1b3d41bc5f78434830d837aa270ca33bc", "exact target commit");
equal(cp.execFileSync("git", ["describe", "--tags", "--exact-match"], { cwd: target, encoding: "utf8" }).trim(),
  "v5.0.1", "exact target tag");
const submodules = cp.execFileSync("git", ["submodule", "status", "--recursive"], { cwd: target, encoding: "utf8" });
check(submodules.trim().length > 0, "recursive dependencies present");
check(!submodules.split(/\r?\n/u).some((line) => /^[-+]/u.test(line)), "recursive dependencies exact");
cp.execFileSync("git", ["diff", "--exit-code", "--", "contracts", "test/VaultEnterExit.t.sol", "test/Multicall.t.sol"],
  { cwd: target, stdio: "ignore" });
check(true, "production and upstream tests unchanged");

const foundry = text("targets/stakewise-v3-core-v5.0.1/foundry.toml");
for (const marker of ['solc = "0.8.26"', 'evm_version = "cancun"', "optimizer = true", "optimizer_runs = 200", "via_ir = true", "bytecode_hash = 'none'"]) {
  check(foundry.includes(marker), `foundry setting ${marker}`);
}

const source = text("targets/stakewise-v3-core-v5.0.1/test/local/StakeWiseEthExitQueueStep1.t.sol");
for (const marker of [
  "test_repeatableOneTicketOrphansLaterBurnAtTwoThreeFourAssetsPerTicket",
  "test_exitQueueSegmentFloorResidualLocksOneWeiSeparatelyFromTicketOrphan",
  "test_adminRescueDoesNotCleanOneTicketLockedLiability",
  "test_statefulHandlerTracksReplacementTicketAndLiveLiability",
  "test_distinctRequestCallbackReachesTransferGuardAndPreservesSecondClaim",
  "test_sameRequestReentryFailsAtDeletedRequestAndCaughtOuterPaysExactlyOnce",
  "newTicket = request.ticket + exited", "unavailableAssets", "function stake", "function unstake",
  "test_partialCheckpointClaimCreatesExactReplacement", "test_wrongReceiverTimestampAndOverIndex",
  "test_underIndexFailsClosedAndRepeatedClaim", "test_publicMulticallPreservesOrdering",
  "test_boundedOsTokenCrossCheck", "testFuzz_depositCeilVsFloor", "testFuzz_sameTimestampSplitPartialCheckpoint",
  "invariant_totalSharesEqualBalancesQueuedSecurityAndFeeHolders",
  "invariant_accountedAssetsUnclaimedAndModeledSurplusEqualRawBalance",
  "invariant_activeClaimLiabilitiesNeverExceedUnclaimedAssets"
]) check(source.includes(marker), `harness marker ${marker}`);
check(!source.includes("vm.etch"), "no runtime replacement");
check(!source.includes("createSelectFork"), "no fork");
check(!source.includes("envString"), "no environment read");

const captures = {};
for (const spec of captureSpecs) {
  const capture = json(`${prefix}-${spec.name}.capture.json`);
  captures[spec.name] = capture;
  equal(capture.capture, spec.name, `${spec.name} capture name`);
  equal([capture.expectedExitCode, capture.exitCode, capture.signal, capture.spawnError],
    [spec.expectedExitCode, spec.expectedExitCode, null, null], `${spec.name} exact exit`);
  check(capture.forgeVersion.includes("forge Version: 1.5.1-stable"), `${spec.name} Forge version`);
  equal([capture.compiler, capture.evmVersion, capture.optimizer, capture.optimizerRuns, capture.viaIR],
    ["solc 0.8.26", "cancun", true, 200, true], `${spec.name} compiler settings`);
  for (const stream of ["stdout", "stderr"]) {
    const bytes = read(capture[stream].path);
    equal(bytes.length, capture[stream].bytes, `${spec.name} ${stream} bytes`);
    equal(sha256(bytes), capture[stream].sha256, `${spec.name} ${stream} hash`);
  }
}

const focused = text(captures.focused.stdout.path) + text(captures.focused.stderr.path);
check(focused.includes("24 tests passed, 0 failed, 0 skipped (24 total tests)"), "focused 24/24 parsed");
const fuzzRows = [...focused.matchAll(/^\[PASS\] testFuzz[^\n]+\(runs: (\d+),/gmu)];
equal(fuzzRows.length, 2, "two focused fuzz properties parsed");
for (const row of fuzzRows) equal(Number(row[1]), 512, "focused fuzz runs parsed");
for (const testName of [
  "test_repeatableOneTicketOrphansLaterBurnAtTwoThreeFourAssetsPerTicket",
  "test_exitQueueSegmentFloorResidualLocksOneWeiSeparatelyFromTicketOrphan",
  "test_adminRescueDoesNotCleanOneTicketLockedLiability",
  "test_statefulHandlerTracksReplacementTicketAndLiveLiability",
  "test_distinctRequestCallbackReachesTransferGuardAndPreservesSecondClaim"
]) check(focused.includes(`[PASS] ${testName}`), `focused output ${testName}`);

const invariant = text(captures.invariant.stdout.path) + text(captures.invariant.stderr.path);
check(invariant.includes("4 tests passed, 0 failed, 0 skipped (4 total tests)"), "invariant 4/4 parsed");
const invariantRows = [...invariant.matchAll(/^\[PASS\] invariant_[^(]+\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)$/gmu)];
equal(invariantRows.length, 4, "four invariant rows parsed");
for (const row of invariantRows) equal(row.slice(1).map(Number), [256, 128000, 0], "invariant tuple parsed");
equal(invariantRows.reduce((sum, row) => sum + Number(row[2]), 0), 512000, "invariant calls parsed");
for (const selector of ["claim", "deposit", "donate", "force", "queue", "stake", "unstake", "update"]) {
  check(invariant.includes(`| StakeWiseExitQueueHandler | ${selector}`), `invariant selector ${selector}`);
}

const multicall = text(captures["upstream-multicall"].stdout.path) + text(captures["upstream-multicall"].stderr.path);
check(multicall.includes("10 tests passed, 0 failed, 0 skipped (10 total tests)"), "upstream Multicall 10/10 parsed");
const blocked = text(captures["upstream-queue-blocked"].stdout.path) + text(captures["upstream-queue-blocked"].stderr.path);
check(blocked.includes("environment variable \"MAINNET_RPC_URL\" not found"), "upstream queue setup blocker parsed");
check(blocked.includes("0 tests passed, 1 failed, 0 skipped"), "upstream queue zero executed parsed");
const build = text(captures.build.stdout.path) + text(captures.build.stderr.path);
check(build.includes("Compiling 258 files with Solc 0.8.26"), "build file/compiler count parsed");
check(build.includes("Compiler run successful"), "build success parsed");
equal(read(captures.fmt.stdout.path).length + read(captures.fmt.stderr.path).length, 0, "format output empty");

const result = json(`${prefix}.json`);
equal(result.classification,
  "LOW/REPEATABLE-ONE-TICKET-ORPHAN/LIABILITY-FREE-LOCKED-UNCLAIMED-ASSETS/NO-PROFITABLE-EXTRACTION/DEPLOYMENT-UNVERIFIED",
  "classification");
equal([result.gates.sourcePrimitive, result.gates.localUserLossPrimitive, result.gates.localRoutePositive,
  result.gates.routePositive, result.gates.executableNow, result.gates.signedActionJustified, result.gates.fork],
  [1, 1, 0, 0, 0, false, false], "corrected gates");
equal([result.repeatableFixture.cumulativeOrphanTickets, result.repeatableFixture.cumulativeLockedUnclaimedAssets,
  result.repeatableFixture.lockedRequestLiability], [3, 9, 0], "repeatable exact totals");
equal(result.repeatableFixture.ownerlessBurnDeltas,
  { queuedShares: -3, totalShares: -3, totalAssets: -9, unclaimedAssets: 9 }, "ownerless deltas");
equal([result.segmentFloorFixture.checkpointTickets, result.segmentFloorFixture.checkpointAssets,
  result.segmentFloorFixture.aggregateResidual], [3, 5, 1], "segment-floor fixture");
equal([result.execution.focused.passed, result.execution.focused.total, result.execution.focused.fuzzCases],
  [24, 24, 1024], "focused result counts");
equal([result.execution.invariants.passed, result.execution.invariants.total,
  result.execution.invariants.totalCalls, result.execution.invariants.reverts],
  [4, 4, 512000, 0], "invariant result counts");
equal([result.execution.upstreamNonforkMulticall.passed, result.execution.upstreamNonforkMulticall.total],
  [10, 10], "upstream result counts");
equal([result.execution.upstreamForkBoundVaultEnterExit.executed,
  result.execution.upstreamForkBoundVaultEnterExit.setupBlocked,
  result.execution.upstreamForkBoundVaultEnterExit.routeNegativeEvidence],
  [0, true, false], "blocked upstream result");
equal([result.build.files, result.build.compiler, result.build.evmVersion, result.build.optimizerRuns,
  result.build.viaIR, result.build.passed], [258, "solc 0.8.26", "cancun", 200, true, true], "build result binding");
equal([result.network.rpcUsed, result.network.forkUsed, result.network.networkUsed,
  result.network.secretsRead, result.network.signedTransactions], [false, false, false, false, false], "network purity");

const report = text("reports/critical-stakewise-v3-eth-exitqueue-step1.md");
for (const marker of [
  "LOW / REPEATABLE ONE-TICKET ORPHAN", "It is not pool-favoring", "2 + 3 + 4 = 9",
  "fractional residual is less than one wei per segment", "no lifetime bound", "transfer guard itself",
  "ticket `0 -> 4`", "24/24", "1,024", "512,000", "10/10", "0 tests executed", "258",
  "sourcePrimitive=1", "localUserLossPrimitive=1", "routePositive=0", "signedActionJustified=false"
]) check(report.includes(marker), `report marker ${marker}`);

for (const [index, artifactPath] of artifacts.entries()) {
  const value = text(artifactPath);
  check(!/[ \t]+$/gmu.test(value), `no trailing whitespace ${artifactPath}`);
  check(!/-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH KEY)-----/giu.test(value), `no private key ${artifactPath}`);
  if (index >= 5 && !captureArtifacts.includes(artifactPath)) {
    check(!/(?:https?|wss?):\/\//giu.test(value), `no authored URL ${artifactPath}`);
  }
}
for (const artifactPath of supplementalArtifacts) {
  const value = text(artifactPath);
  check(!/[ \t]+$/gmu.test(value), `no trailing whitespace ${artifactPath}`);
  check(!/-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH KEY)-----/giu.test(value), `no private key ${artifactPath}`);
  check(!/(?:https?|wss?):\/\//giu.test(value), `no URL ${artifactPath}`);
}

const manifest = json(manifestPath);
equal([manifest.schemaVersion, manifest.artifactCount], [4, artifacts.length], "manifest header");
const seen = new Set();
for (const row of manifest.artifacts) {
  check(!seen.has(row.path), `unique manifest path ${row.path}`);
  seen.add(row.path);
  const bytes = read(row.path);
  equal(bytes.length, row.bytes, `manifest bytes ${row.path}`);
  equal(sha256(bytes), row.sha256, `manifest hash ${row.path}`);
}
for (const artifactPath of artifacts) check(seen.has(artifactPath), `manifest closure ${artifactPath}`);
const aggregate = sha256(Buffer.from(manifest.artifacts.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8"));
equal(aggregate, manifest.aggregateSha256, "manifest aggregate");

console.log(JSON.stringify({ status: "PASS", checks, artifactCount: artifacts.length,
  aggregateSha256: manifest.aggregateSha256, classification: result.classification }));
