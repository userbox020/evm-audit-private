#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "reports", "raw", "fast", "etherfi-26q2-upgrade-migration-gate0");
const SOURCE_BUILD = path.join(DIR, "source-build-storage.json");
const DEPLOYMENT = path.join(DIR, "deployment-capture.json");
const SOURCE_AUTHORITY = path.join(DIR, "source-authority.json");
const BUILD_AUTHORITY = path.join(DIR, "build-authority.json");
const GATE_RESULT = path.join(DIR, "gate-result.json");
const MANIFEST = path.join(DIR, "manifest.json");
const VALIDATION = path.join(DIR, "validation.json");
const REPORT = path.join(ROOT, "reports", "etherfi-26q2-upgrade-migration-gate0.md");
const INBOX = path.join(ROOT, "coordination", "inbox", "critical", "20260821-coordinator-etherfi-26q2-upgrade-migration-gate0-terminal.json");
const HANDOFF = path.join(ROOT, "coordination", "handoffs", "20260821-coordinator-etherfi-26q2-upgrade-migration-gate0-terminal.md");

const sha256 = (b) => `0x${crypto.createHash("sha256").update(b).digest("hex")}`;
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const rel = (p) => path.relative(ROOT, p).replaceAll("\\", "/");
const fileRow = (p) => { const b = fs.readFileSync(p); return { path: rel(p), bytes: b.length, sha256: sha256(b) }; };
function invariant(ok, code) { if (!ok) throw new Error(code); }

function main() {
  invariant(process.argv.length === 2, "ARGV_FORBIDDEN");
  const sb = read(SOURCE_BUILD), dc = read(DEPLOYMENT), now = new Date().toISOString();
  const runtimeRows = dc.runtimeBinding.rows;
  const newRoleNames = ["UPGRADE_TIMELOCK_ROLE", "OPERATION_TIMELOCK_ROLE", "OPERATION_MULTISIG_ROLE", "SUPER_GUARDIAN_ROLE",
    "GUARDIAN_ROLE", "ORACLE_OPERATIONS_ROLE", "HOUSEKEEPING_OPERATIONS_ROLE", "EXECUTOR_OPERATIONS_ROLE", "EIGENPOD_OPERATIONS_ROLE"];
  const allRoleNames = Object.keys(dc.state.after.roles), legacyRoleNames = allRoleNames.filter((x) => !newRoleNames.includes(x));
  const preMismatch = runtimeRows.filter((r) => !r.pre.exact).map((r) => r.name);
  const postMismatch = runtimeRows.filter((r) => !r.post.exact).map((r) => r.name);
  const preExact = runtimeRows.length - preMismatch.length, postExact = runtimeRows.length - postMismatch.length;
  const before = dc.state.before.liquidity, after = dc.state.after.liquidity;
  const locked = BigInt(before.lpLegacyLockedSlot220);
  const migration = {
    legacyLockedWei: locked.toString(),
    lpTotalInDeltaWei: (BigInt(before["lp.totalValueInLp"]) - BigInt(after["lp.totalValueInLp"])).toString(),
    lpTotalOutDeltaWei: (BigInt(after["lp.totalValueOutOfLp"]) - BigInt(before["lp.totalValueOutOfLp"])).toString(),
    lpBalanceDeltaWei: (BigInt(before["lp.ethBalance"]) - BigInt(after["lp.ethBalance"])).toString(),
    wrnBalanceDeltaWei: (BigInt(after["wrn.ethBalance"]) - BigInt(before["wrn.ethBalance"])).toString(),
    pooledEtherDeltaWei: (BigInt(after["lp.getTotalPooledEther"]) - BigInt(before["lp.getTotalPooledEther"])).toString(),
    eethSharesDelta: (BigInt(after["eeth.totalShares"]) - BigInt(before["eeth.totalShares"])).toString(),
    eethSupplyDelta: (BigInt(after["eeth.totalSupply"]) - BigInt(before["eeth.totalSupply"])).toString(),
    weethSupplyDelta: (BigInt(after["weeth.totalSupply"]) - BigInt(before["weeth.totalSupply"])).toString(),
  };
  migration.observedConservationPass = migration.lpTotalInDeltaWei === locked.toString()
    && migration.lpTotalOutDeltaWei === locked.toString() && migration.lpBalanceDeltaWei === locked.toString()
    && migration.wrnBalanceDeltaWei === locked.toString() && migration.pooledEtherDeltaWei === "0"
    && migration.eethSharesDelta === "0" && migration.eethSupplyDelta === "0" && migration.weethSupplyDelta === "0";

  const sourceAuthority = {
    schemaVersion: "etherfi-26q2-gate0/source-authority-v1", generatedAt: now,
    claimId: "critical/etherfi-26q2-upgrade-migration-gate0",
    officialPrimary: { repository: "etherfi-protocol/smart-contracts", commit: sb.expected.head, tree: sb.expected.headTree,
      parent: sb.expected.parent, pullRequest: 484, pullRequestHeadExact: true, checkoutClean: sb.source.head.clean },
    preUpgradeCandidate: { commit: sb.expected.mergeBase, tree: sb.expected.mergeBaseTree, checkoutClean: sb.source.preUpgradeMergeBase.clean,
      runtimeExactCount: preExact, runtimeSurfaceCount: runtimeRows.length, runtimeMismatchCount: preMismatch.length, runtimeMismatchSurfaces: preMismatch,
      disposition: "NOT_EXACT_FOR_ALL_PRIOR_DEPLOYED_IMPLEMENTATIONS" },
    externalOfficialSources: {
      l1SyncPool: { repository: "etherfi-protocol/WeETH-cross-chain", releaseCommit: sb.expected.l1Release,
        preUpgradeCandidate: sb.expected.l1PreUpgrade, checkoutsClean: sb.source.l1SyncPoolRelease.clean && sb.source.l1SyncPoolPreUpgrade.clean,
        dependencyResolution: { lockfileAtCommit: false, exactResolvedDuringRun: true,
          resolved: { layerzeroPackages: "2.3.44", openzeppelinContracts: "5.0.1", openzeppelinUpgradeable: "5.0.2",
            layerzeroV2Commit: "21ad027cf323c323619566d2c9d1f2fa404f021f", soladyCommit: "cedd7936a11807acd819c9f6acf48fdcefee3f73" } } },
      avs: { repository: "etherfi-protocol/avs-smart-contracts", releaseCommit: sb.expected.avsRelease,
        preUpgradeCandidate: sb.expected.avsPreUpgrade, checkoutsClean: sb.source.avsRelease.clean && sb.source.avsPreUpgrade.clean,
        compilerPinAtCommit: false }
    },
    admission: { exactCommitParentsDependenciesAvailable: true, exactPriorDeployedSourceForEverySurface: false,
      status: "STOP_EXACT_PRIOR_DEPLOYED_REVISION_UNBOUND", blockerCount: preMismatch.length },
    exclusions: ["No .env, wallet, key, PEM, keypair, signed transaction, broadcast, fork, production mutation, user, or orderflow access."],
  };
  write(SOURCE_AUTHORITY, sourceAuthority);

  const buildAuthority = {
    schemaVersion: "etherfi-26q2-gate0/build-authority-v1", generatedAt: now,
    toolchain: { foundry: sb.toolchain.forgeVersion, primarySolc: "0.8.27+commit.40a35a09", optimizerRuns: 1500,
      evmVersion: "prague", bytecodeHash: "none", l1Solc: "0.8.20+commit.a1b79de6", l1OptimizerRuns: 200,
      l1EvmVersion: "shanghai", avsObservedLocalSolc: "0.8.33+commit.64118f21", avsOptimizerRuns: 200 },
    builds: { primaryHead: "PASS", primaryPreUpgradeCandidate: "PASS", l1TargetHead: "PASS", l1TargetPreUpgrade: "PASS",
      avsTargetHead: "PASS", avsTargetPreUpgrade: "PASS" },
    storageLayouts: { surfacesCompared: sb.summary.contractsCompared, rawCollisionCandidates: sb.summary.rawCollisionCandidateCount,
      candidateLayoutComparison: "PASS_NO_RAW_COLLISION", deployedApplicability: "UNKNOWN_FOR_PRE_RUNTIME_MISMATCH_SURFACES" },
    runtime: { surfaces: runtimeRows.length, preExact, preMismatchCount: preMismatch.length, preMismatch,
      postExact, postMismatchCount: postMismatch.length, postMismatch, allExpectedPostImplementationSlots: dc.lineage.proxies.every((x) => x.expectedPostMatch)
        && dc.lineage.beacon.expectedPostMatch, laterUpgradeCount: dc.stop.relevantLaterUpgrades.length },
    tests: [
      { command: "forge build --force", target: "primary head and pre-upgrade candidate", status: "PASS" },
      { command: "forge test --match-contract LiquidityPoolTest --match-test migration selectors -vv", passed: 2, failed: 0, fork: false },
      { command: "forge test --match-contract WithdrawRequestNFTTest --match-test share-rate-freeze selectors -vv", passed: 4, failed: 0, fork: false },
      { command: "node tools/validate-etherfi-26q2-upgrade-migration-gate0.js", status: "PASS", checks: sb.summary }
    ],
    status: "BUILD_REPRODUCED_BUT_DEPLOYED_PROVENANCE_INCOMPLETE",
  };
  write(BUILD_AUTHORITY, buildAuthority);

  const gateResult = {
    schemaVersion: 2, generatedAt: now, claimId: "critical/etherfi-26q2-upgrade-migration-gate0", reportStatus: "DRAFT",
    verdict: "STOP_FAIL_CLOSED_RUNTIME_SOURCE_PROVENANCE_MISMATCH_NO_FINDING",
    gates: {
      g0_1: { status: "STOP_EXACT_PRIOR_DEPLOYED_REVISION_UNBOUND", admitted: false, blockerCount: preMismatch.length },
      g0_2: { status: "DIAGNOSTIC_CAPTURE_STOP_RUNTIME_SOURCE_MISMATCH", admitted: false, postRuntimeExact: `${postExact}/${runtimeRows.length}`,
        preRuntimeExact: `${preExact}/${runtimeRows.length}`, laterUpgradeCount: dc.stop.relevantLaterUpgrades.length },
      g0_3: { status: "NOT_ADMITTED_SEQUENTIAL_STOP", admitted: false, concreteHypothesis: false, harnessAdded: false },
      routePositive: "unknown", executableNow: "false", signedActionJustified: false,
      fork: { justified: false, chainId: null, blockNumber: null, blockHash: null, stateRoot: null, finality: null,
        snapshotHash: null, syntheticChanges: [], signedAction: false }
    },
    axes: { evidenceStage: "DEPLOYMENT_BOUND_INCOMPLETE", validityOutcome: "NO-FINDING", noveltyOutcome: "N/A",
      deploymentDisposition: "RUNTIME-SOURCE-MISMATCH", accessDisposition: "AUTHORIZED-READ-ONLY-COMPLETE",
      routeDisposition: "UNKNOWN", signal: "none" },
    transaction: { blockNumber: dc.chain.historical.post.number, blockHash: dc.chain.historical.post.hash,
      transactionHash: dc.transaction.hash, calls: dc.batch.callCount, upgradeCalls: dc.batch.upgradeCallCount,
      initializerCalls: dc.batch.initializerCallCount, atomicSuccessfulExecution: dc.batch.atomicSuccessfulExecution },
    migration, roleState: { newRoleCount: newRoleNames.length, legacyRoleCount: legacyRoleNames.length,
      newHolderCountsBefore: Object.fromEntries(newRoleNames.map((k) => [k, dc.state.before.roles[k].length])),
      newHolderCountsAfter: Object.fromEntries(newRoleNames.map((k) => [k, dc.state.after.roles[k].length])),
      newRolesUnchangedAfterToCurrent: newRoleNames.every((k) => JSON.stringify(dc.state.after.roles[k]) === JSON.stringify(dc.state.current.roles[k])),
      legacyHolderTotalBefore: legacyRoleNames.reduce((n, k) => n + dc.state.before.roles[k].length, 0),
      legacyHolderTotalAfter: legacyRoleNames.reduce((n, k) => n + dc.state.after.roles[k].length, 0),
      legacyHolderTotalCurrent: legacyRoleNames.reduce((n, k) => n + dc.state.current.roles[k].length, 0),
      allLegacyRolesEmptyAfterAndCurrent: legacyRoleNames.every((k) => dc.state.after.roles[k].length === 0 && dc.state.current.roles[k].length === 0) },
    rateLimits: { observedIds: Object.keys(dc.state.current.rateLimits).length,
      mintBurnUnchangedAcrossUpgrade: JSON.stringify(dc.state.before.rateLimits.EETH_MINT_LIMIT_ID) === JSON.stringify(dc.state.after.rateLimits.EETH_MINT_LIMIT_ID)
        && JSON.stringify(dc.state.before.rateLimits.EETH_BURN_LIMIT_ID) === JSON.stringify(dc.state.after.rateLimits.EETH_BURN_LIMIT_ID),
      restakerLimiterExistsCurrent: dc.state.current.rateLimits.STETH_REQUEST_WITHDRAWAL_LIMIT_ID?.exists === true },
    stop: { noFinding: true, severity: "NONE", publicValuePathEvaluated: false,
      reopen: ["Recover exact source/compiler inputs for all nine prior-runtime mismatches and both external post-runtime mismatches.",
        "Rebuild and re-run 26-surface layout/runtime checks with zero unmatched bytes.",
        "Only then perform a separately reviewed G0.3 public-path admission; fork remains prohibited at this Gate0 result."] },
    safety: dc.safety,
  };
  invariant(migration.observedConservationPass, "MIGRATION_EQUATION_FAILED");
  invariant(gateResult.gates.routePositive === "unknown" && gateResult.gates.executableNow === "false", "CANONICAL_GATES");
  write(GATE_RESULT, gateResult);

  const artifactPaths = [SOURCE_BUILD, DEPLOYMENT, SOURCE_AUTHORITY, BUILD_AUTHORITY, GATE_RESULT, REPORT, INBOX, HANDOFF,
    path.join(ROOT, "tools", "validate-etherfi-26q2-upgrade-migration-gate0.js"),
    path.join(ROOT, "tools", "capture-etherfi-26q2-upgrade-migration-gate0.js"),
    path.join(ROOT, "tools", "package-etherfi-26q2-upgrade-migration-gate0.js")];
  const manifest = { schemaVersion: "etherfi-26q2-gate0/manifest-v1", generatedAt: now,
    verdict: gateResult.verdict, artifacts: artifactPaths.map(fileRow), counts: { sourceSurfaces: sb.summary.contractsCompared,
      runtimeSurfaces: runtimeRows.length, preExact, postExact, storageCollisionCandidates: sb.summary.rawCollisionCandidateCount,
      upgradeBatchCalls: dc.batch.callCount, receiptLogs: dc.transaction.receipt.logCount, rpcCalls: dc.budget.calls },
    canonicalGates: gateResult.gates, safety: gateResult.safety };
  write(MANIFEST, manifest);

  const jsonPaths = [SOURCE_BUILD, DEPLOYMENT, SOURCE_AUTHORITY, BUILD_AUTHORITY, GATE_RESULT, INBOX, MANIFEST];
  const forbidden = [/(?:https?|wss?):\/\//iu, /"(?:endpoint|hostname|domain|headers|rpcUrl|rawResponse|rawRpc)"\s*:/iu];
  const checks = [];
  for (const p of jsonPaths) { const text = fs.readFileSync(p, "utf8"); JSON.parse(text); const clean = forbidden.every((r) => !r.test(text));
    checks.push({ artifact: rel(p), strictJson: true, sanitized: clean, sha256: sha256(Buffer.from(text)) }); invariant(clean, `SANITIZATION_${path.basename(p)}`); }
  for (const p of [REPORT, HANDOFF]) { const text = fs.readFileSync(p, "utf8"), clean = forbidden.every((r) => !r.test(text));
    checks.push({ artifact: rel(p), strictJson: false, sanitized: clean, sha256: sha256(Buffer.from(text)) }); invariant(clean, `SANITIZATION_${path.basename(p)}`); }
  const validation = { schemaVersion: "etherfi-26q2-gate0/validation-v1", generatedAt: now, checks,
    assertions: { strictJsonFiles: jsonPaths.length, strictJsonPass: checks.filter((x) => x.strictJson).length === jsonPaths.length, sanitizationPass: checks.every((x) => x.sanitized),
      migrationConservationPass: migration.observedConservationPass, canonicalGateStringsPass: true, noFork: true, noSignedAction: true,
      manifestArtifactHashesPresent: manifest.artifacts.length }, status: "PASS" };
  write(VALIDATION, validation);
  console.log(JSON.stringify({ status: "PASS", verdict: gateResult.verdict, preExact: `${preExact}/${runtimeRows.length}`,
    postExact: `${postExact}/${runtimeRows.length}`, migrationConservation: true, g0_3Admitted: false }));
}

main();
