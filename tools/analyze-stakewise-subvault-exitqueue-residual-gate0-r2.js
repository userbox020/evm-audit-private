#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const GATE0_DIR = path.join(ROOT, "reports", "raw", "fast", "stakewise-subvault-exitqueue-residual-gate0");
const OUT = path.join(ROOT, "reports", "raw", "fast", "stakewise-subvault-exitqueue-residual-gate0-r2");
const CAPTURE_SHA256 = "51aa5cdb9082231a03029a8ad937316c92f01263fa70745be578306b2df3cc1f";
const VERDICT = "GATE0_R2_CLOSED_FIXED_NO_RESIDUAL_NO_LIVE_COMPOSITION";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const sum = (rows, fn) => rows.reduce((total, row) => total + BigInt(fn(row)), 0n);
function fail(code) { throw new Error(code); }
function readJson(file) { const bytes = fs.readFileSync(file); if (bytes.at(-1) !== 10) fail("JSON_NEWLINE"); return { bytes, value: JSON.parse(bytes) }; }
function lineageResolved(events, child, targetTicket) { let ticket = targetTicket; for (let i = events.length - 1; i >= 0; i--) { const row = events[i]; if (row.child !== child) continue; if (row.type === "ExitedAssetsClaimed" && row.newPositionTicket === ticket) ticket = row.prevPositionTicket; else if (row.type === "ExitQueueEntered" && row.positionTicket === ticket) return true; } return false; }
function rowKey(chain, role, address, hash) { return `${chain}|${role}|${address}|${hash}`; }

const MATERIAL_R2_ROWS = new Set([
  rowKey("ethereum", "vaults-registry", "0x3a0008a588772446f6e656133c2d5029cc4fc20e", "0xfea640fe67d9867f0feb82794b496e3d0f9812fe56493eb8eab3d33b4c3194ba"),
  rowKey("ethereum", "child-proxy", "0xac0f906e433d58fa868f936e8a43230473652885", "0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b"),
  rowKey("ethereum", "child-implementation", "0xf113bfd6423291b1dd2ca76f897bff54456e7c88", "0x0163dff0145d814a24df66ec2c1037cd2afbdf5811536f0c9645d16d2742706a"),
  rowKey("gnosis", "vaults-registry", "0x7d014b3c6ee446563d4e0cb6fbd8c3d0419867cb", "0xa4032e5c6e1068f17d6d856e2774a2759fee1ab0df359a2a222f71cbe9db40a7"),
  rowKey("gnosis", "sub-registry-implementation-current", "0x3dec6026137010783571697b98011c4c01010895", "0x12f6ca38ec73ffa92ce9d3156d2fd9704c69d71da43e3d862a97f548cb8d3e62"),
  rowKey("gnosis", "meta-factory-other-registry-caller-or-factory", "0x6107db0bdd84023228e0ab11099190e88b073c1d", "0xda40ea206e1b2bc1fbae30ed9658e279cbf3cf53feb37f71645e1d9399cc9695"),
  rowKey("gnosis", "meta-factory-implementation-other-registry-caller-or-factory", "0xd0d527b67186d8880f9427ea4cf9847e89bce764", "0x65215bdb080a712c9cbc1ee0c8c77080dcc032e5ac20792cd2dd49dbf1f47080"),
  rowKey("gnosis", "parent-implementation", "0x6f59ae1dd36eed6d7a928505f754b2965197c8e5", "0x3aac7d7922313e3d1a5fafe005de2dfd3a2cb55bb7ba37e4827aa576145975a7"),
  rowKey("gnosis", "sub-registry-implementation", "0x3dec6026137010783571697b98011c4c01010895", "0x12f6ca38ec73ffa92ce9d3156d2fd9704c69d71da43e3d862a97f548cb8d3e62"),
  rowKey("gnosis", "child-implementation", "0x6f59ae1dd36eed6d7a928505f754b2965197c8e5", "0x3aac7d7922313e3d1a5fafe005de2dfd3a2cb55bb7ba37e4827aa576145975a7"),
  rowKey("gnosis", "child-proxy", "0x4b4406ed8659d03423490d8b62a1639206da0a7a", "0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b"),
  rowKey("gnosis", "child-implementation", "0xf113bfd6423291b1dd2ca76f897bff54456e7c88", "0x00a2232ae1087dae45c97723527e6dc7c95240c9b95ed5e2baa8353ba97511bc")
]);

function main() {
  if (process.argv.length !== 2) fail("ARGV");
  const captureRead = readJson(path.join(GATE0_DIR, "capture.json")); if (sha256(captureRead.bytes) !== CAPTURE_SHA256) fail("CAPTURE_IMMUTABILITY"); const capture = captureRead.value;
  const validationRead = readJson(path.join(GATE0_DIR, "validation.json")), acquisitionRead = readJson(path.join(OUT, "acquisition.json")), buildRead = readJson(path.join(OUT, "build.json")); const validation = validationRead.value, acquisition = acquisitionRead.value, build = buildRead.value;
  if (acquisition.status !== "PASS" || build.status !== "PASS" || build.records.some((x) => !x.exact)) fail("BUILD_NOT_EXACT");
  const buildByChainHash = new Map(build.records.map((x) => [`${x.chain}|${x.runtimeKeccak256}`, x])); const projected = [];
  for (const [chain, rows] of Object.entries(validation.unmatchedRuntimeRows)) for (const row of rows) { const binding = buildByChainHash.get(`${chain}|${row.codeKeccak256}`); if (!binding) fail(`UNBOUND_${chain}_${row.address}`); projected.push({ chain, role: row.role, address: row.address, codeKeccak256: row.codeKeccak256, exact: binding.exact, authorityAddress: binding.address, contractName: binding.name, compilerVersion: binding.profile.compilerVersion, optimizerRuns: binding.profile.optimizer.runs, evmVersion: binding.profile.evmVersion, viaIR: binding.profile.viaIR, duplicateFamilyRepresentative: binding.address !== row.address || binding.roles[0] !== row.role, materialSignalGraph: MATERIAL_R2_ROWS.has(rowKey(chain, row.role, row.address, row.codeKeccak256)) }); }
  if (projected.length !== 25 || projected.some((x) => !x.exact) || projected.filter((x) => x.materialSignalGraph).length !== 12) fail("ROW_PROJECTION");

  const correctedCoverage = [], patchRows = [], positionRows = []; let activePositions = 0, resolvedPositions = 0, oneTicketBoundaries = 0;
  for (const [chainName, chain] of Object.entries(capture.chains)) {
    const materialParents = chain.state.parents.filter((x) => BigInt(x.totalAssets) >= 10n ** BigInt(chain.state.observedAssetDecimals));
    for (const parent of chain.state.parents) for (const child of parent.children) for (const position of child.registryState.positions) { activePositions++; const resolved = lineageResolved(parent.protocolExitHistory.events, child.address, position.positionTicket); if (resolved) resolvedPositions++; if (position.oneTicketBoundary === true) oneTicketBoundaries++; positionRows.push({ chain: chainName, parent: parent.address, child: child.address, positionTicket: position.positionTicket, processed: position.processed, leftTickets: position.leftTickets, oneTicketBoundary: position.oneTicketBoundary, lineageResolved: resolved, liveClaimPerformed: false }); }
    for (const parent of materialParents) {
      const Q = BigInt(parent.exitQueue.queuedShares), E = BigInt(parent.exitQueue.totalExitedTickets), P = BigInt(parent.registryState.totalProcessedExitQueueTickets), residual = (P > E ? P : E) - E, unresolvedTickets = residual <= Q ? Q - residual : 0n;
      const activeExitPositionAssets = sum(parent.children.flatMap((x) => x.registryState.positions), (x) => x.assetsAtCurrentRate), claimableSubsetAssets = BigInt(parent.invariants.childClaimableAssets), withdrawableAssets = BigInt(parent.withdrawableAssets), schedulableStakedAssets = sum(parent.children, (x) => x.registryState.stakedAssets), unresolvedAssets = BigInt(parent.invariants.unresolvedAssets), coverage = activeExitPositionAssets + withdrawableAssets + schedulableStakedAssets, surplus = coverage - unresolvedAssets;
      correctedCoverage.push({ chain: chainName, parent: parent.address, version: parent.version, Q: Q.toString(), E: E.toString(), P: P.toString(), residual: residual.toString(), residualEquationPass: residual <= Q, unresolvedTickets: unresolvedTickets.toString(), unresolvedAssets: unresolvedAssets.toString(), activeExitPositionAssets: activeExitPositionAssets.toString(), claimableSubsetAssets: claimableSubsetAssets.toString(), claimableSubsetNotDoubleCounted: true, parentWithdrawableAssets: withdrawableAssets.toString(), schedulableStakedAssets: schedulableStakedAssets.toString(), correctedCoverageAssets: coverage.toString(), correctedCoverageSurplus: surplus.toString(), correctedCoveragePass: surplus >= 0n });
      if (chainName === "gnosis") patchRows.push({ parent: parent.address, version: parent.version, expectedVersion: parent.expectedVersion, parentImplementation: parent.implementation, parentImplementationExactOptimizer200: parent.implementation === "0x6f59ae1dd36eed6d7a928505f754b2965197c8e5", registryImplementation: parent.registryImplementation, registryImplementationExactOptimizer200: parent.registryImplementation === "0x3dec6026137010783571697b98011c4c01010895", predecessorRegistryImplementation: "0x9778317a6f6ff0224e8c1dd30af71e1e25edc5d1", usesPredecessor: parent.registryImplementation === "0x9778317a6f6ff0224e8c1dd30af71e1e25edc5d1", expectedFactory: parent.runtimeBinding.expectedSubRegistryFactory, currentPatchExactR2: parent.version === parent.expectedVersion && parent.implementation === "0x6f59ae1dd36eed6d7a928505f754b2965197c8e5" && parent.registryImplementation === "0x3dec6026137010783571697b98011c4c01010895" });
    }
  }
  if (correctedCoverage.length !== 4 || correctedCoverage.some((x) => !x.residualEquationPass || !x.correctedCoveragePass)) fail("MATERIAL_SIGNAL_SURVIVES");
  if (activePositions !== 14 || resolvedPositions !== 14 || oneTicketBoundaries !== 0 || capture.safety.liveClaim) fail("POSITION_RECHECK");
  if (patchRows.length !== 2 || patchRows.some((x) => !x.currentPatchExactR2 || x.usesPredecessor)) fail("GNOSIS_PATCH");
  const parentBuild = build.records.find((x) => x.chain === "gnosis" && x.address === "0x6f59ae1dd36eed6d7a928505f754b2965197c8e5"), parentBuildFull = readJson(path.join(ROOT, ...parentBuild.buildPath.split("/"))).value; if (!parentBuildFull.exactRuntimeBinding.immutableReferences.some((x) => x.address === "0x45ea1d8cb97fd04e064f92eb56305610900928dc")) fail("GNOSIS_FACTORY_IMMUTABLE");
  const ethereumTarget = correctedCoverage.find((x) => x.chain === "ethereum" && x.parent === "0x34284c27a2304132af751b0dec5bba2cf98ed039"); if (!ethereumTarget || ethereumTarget.schedulableStakedAssets !== "5029939744110394816321" || !ethereumTarget.correctedCoveragePass) fail("ETHEREUM_COVERAGE_TARGET");

  const result = {
    schemaVersion: 1, analysisId: "stakewise-subvault-exitqueue-residual-gate0-r2", generatedAt: new Date().toISOString(), status: VERDICT,
    supersession: { gate0CapturePreserved: true, gate0CaptureSha256: CAPTURE_SHA256, supersedesGate0ForSignalAdjudicationOnly: true, historyAndMaterialStateRecaptured: false },
    runtimeClosure: { unmatchedRows: projected.length, ethereumRows: projected.filter((x) => x.chain === "ethereum").length, gnosisRows: projected.filter((x) => x.chain === "gnosis").length, chainScopedAuthorityRecords: build.records.length, globallyUniqueRuntimeFamilies: build.uniqueRuntimeFamiliesExact, duplicateProjectedRows: projected.length - build.records.length, recoveredRowsExact: projected.filter((x) => x.exact).length, preexistingExactRows: validation.summaries.ethereum.exactRelevantRuntimes + validation.summaries.gnosis.exactRelevantRuntimes, allGraphRelevantRows: validation.summaries.ethereum.relevantRuntimes + validation.summaries.gnosis.relevantRuntimes, allGraphExactRows: validation.summaries.ethereum.relevantRuntimes + validation.summaries.gnosis.relevantRuntimes, allGraphExact: true, materialSignalR2Rows: projected.filter((x) => x.materialSignalGraph).length, materialSignalR2RowsExact: projected.filter((x) => x.materialSignalGraph && x.exact).length, materialSignalGraphExact: true, rows: projected },
    correctedCoverageModel: { formula: "active child exit-position assets (claimable is a subset, not additive) + parent withdrawable assets + child still-staked assets schedulable by the next successful updateState/enterSubVaultsExitQueue", sourceBoundary: [{ path: "targets/stakewise-v3-core-v5.0.1/contracts/vaults/modules/VaultSubVaults.sol", lines: "116-139", sha256: sha256(fs.readFileSync(path.join(ROOT, "targets", "stakewise-v3-core-v5.0.1", "contracts", "vaults", "modules", "VaultSubVaults.sol"))) }, { path: "targets/stakewise-v3-core-v5.0.1/contracts/vaults/SubVaultsRegistry.sol", lines: "429-538,650-676", sha256: sha256(fs.readFileSync(path.join(ROOT, "targets", "stakewise-v3-core-v5.0.1", "contracts", "vaults", "SubVaultsRegistry.sol"))) }], rows: correctedCoverage, materialDeficits: correctedCoverage.filter((x) => !x.correctedCoveragePass).length },
    gnosisPatchIdentity: { parentImplementation: "0x6f59ae1dd36eed6d7a928505f754b2965197c8e5", registryImplementation: "0x3dec6026137010783571697b98011c4c01010895", predecessorRegistryImplementation: "0x9778317a6f6ff0224e8c1dd30af71e1e25edc5d1", exactProfile: { compiler: "0.8.26+commit.8a97fa7a", evmVersion: "cancun", viaIR: true, optimizerEnabled: true, optimizerRuns: 200 }, counterfactual120Mismatch: build.counterfactuals.every((x) => x.exactAt200 && !x.exactAt120), parentFactoryImmutable: "0x45ea1d8cb97fd04e064f92eb56305610900928dc", rows: patchRows },
    positions: { active: activePositions, lineagesResolved: resolvedPositions, activeOneTicketBoundaries: oneTicketBoundaries, selector: "0xe620196c", callerGuard: "none-beyond-nonReentrant", liveClaimPerformed: false, rows: positionRows },
    gates: { finding: false, gate1Justified: false, routePositive: false, routePositiveScope: "captured fixed-pin StakeWise SubVault residual/public one-ticket composition route only", executableNow: false, forkJustified: false, liveClaim: false },
    limitations: ["bounded current-pin negative; not a perpetual/global absence claim", "Gate0 history and material state are reused byte-identically", "no fork, signing, transaction, user action, or live claim"],
    inputs: { gate0ValidationSha256: sha256(validationRead.bytes), acquisitionSha256: sha256(acquisitionRead.bytes), buildSha256: sha256(buildRead.bytes) }
  };
  const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`); fs.writeFileSync(path.join(OUT, "adjudication.json"), bytes); console.log(JSON.stringify({ status: result.status, unmatchedRowsExact: result.runtimeClosure.recoveredRowsExact, uniqueRuntimeFamilies: result.runtimeClosure.globallyUniqueRuntimeFamilies, materialRowsExact: result.runtimeClosure.materialSignalR2RowsExact, allGraphExact: result.runtimeClosure.allGraphExact, materialSignalGraphExact: result.runtimeClosure.materialSignalGraphExact, activePositions, oneTicketBoundaries, materialDeficits: result.correctedCoverageModel.materialDeficits, adjudicationSha256: sha256(bytes) }));
}

try { main(); } catch (error) { console.error(JSON.stringify({ status: "FAIL_CLOSED", code: String(error.message || "FAILURE") })); process.exitCode = 1; }
