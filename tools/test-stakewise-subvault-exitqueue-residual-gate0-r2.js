#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports", "raw", "fast", "stakewise-subvault-exitqueue-residual-gate0-r2");
const CAPTURE = path.join(ROOT, "reports", "raw", "fast", "stakewise-subvault-exitqueue-residual-gate0", "capture.json");
const EXPECTED_CAPTURE = "51aa5cdb9082231a03029a8ad937316c92f01263fa70745be578306b2df3cc1f";
const VERDICT = "GATE0_R2_CLOSED_FIXED_NO_RESIDUAL_NO_LIVE_COMPOSITION";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
let assertions = 0;
function ok(value, code) { assertions++; if (!value) throw new Error(code); }
function json(name) { return JSON.parse(fs.readFileSync(path.join(OUT, name), "utf8")); }

function main() {
  ok(process.argv.length === 2, "ARGV"); const acquisition = json("acquisition.json"), build = json("build.json"), adjudication = json("adjudication.json"), gitBindings = json("source-git-bindings.json"); const suites = [];
  ok(sha256(fs.readFileSync(CAPTURE)) === EXPECTED_CAPTURE, "CAPTURE"); ok(adjudication.status === VERDICT && adjudication.supersession.supersedesGate0ForSignalAdjudicationOnly, "VERDICT"); ok(!adjudication.supersession.historyAndMaterialStateRecaptured, "NO_RECAPTURE"); suites.push("parent immutability and supersession");
  ok(build.counterfactuals.length === 2, "PROFILE_ROWS"); for (const row of build.counterfactuals) { ok(row.deployedOptimizerRuns === 200 && row.counterfactualOptimizerRuns === 120, "PROFILE_VALUES"); ok(row.exactAt200 && !row.exactAt120, "PROFILE_DISCRIMINATION"); } suites.push("Gnosis optimizer 120-vs-200 discrimination");
  ok(adjudication.runtimeClosure.unmatchedRows === 25 && adjudication.runtimeClosure.ethereumRows === 13 && adjudication.runtimeClosure.gnosisRows === 12, "ROW_COUNTS"); ok(acquisition.sourceAuthorityRecords === 17 && acquisition.uniqueRuntimeFamilies === 16, "FAMILY_COUNTS"); ok(adjudication.runtimeClosure.duplicateProjectedRows === 8, "DUPLICATES"); const proxyRows = adjudication.runtimeClosure.rows.filter((x) => x.codeKeccak256 === "0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b"); ok(proxyRows.length === 8 && proxyRows.every((x) => x.contractName === "ERC1967Proxy" && x.exact), "PROXY_FAMILY"); suites.push("duplicate code-family projection");
  ok(adjudication.runtimeClosure.materialSignalR2Rows === 12 && adjudication.runtimeClosure.materialSignalR2RowsExact === 12, "MATERIAL_ROWS"); ok(acquisition.materialAuthorityRecords === 10, "MATERIAL_AUTHORITIES"); ok(adjudication.runtimeClosure.materialSignalGraphExact && adjudication.runtimeClosure.allGraphExact, "GRAPH_EXACTNESS"); ok(adjudication.runtimeClosure.allGraphExactRows === 98, "ALL_GRAPH_ROWS"); suites.push("material-signal and all-graph projection");
  ok(adjudication.correctedCoverageModel.rows.length === 4 && adjudication.correctedCoverageModel.materialDeficits === 0, "COVERAGE_ROWS"); const eth = adjudication.correctedCoverageModel.rows.find((x) => x.chain === "ethereum" && x.parent === "0x34284c27a2304132af751b0dec5bba2cf98ed039"); ok(eth.schedulableStakedAssets === "5029939744110394816321", "STAKED_ASSETS"); ok(BigInt(eth.correctedCoverageAssets) === BigInt(eth.activeExitPositionAssets) + BigInt(eth.parentWithdrawableAssets) + BigInt(eth.schedulableStakedAssets), "COVERAGE_FORMULA"); ok(eth.correctedCoveragePass && BigInt(eth.correctedCoverageSurplus) > 0n, "NO_DEFICIT"); suites.push("still-staked asset coverage");
  ok(adjudication.gnosisPatchIdentity.rows.length === 2 && adjudication.gnosisPatchIdentity.counterfactual120Mismatch, "PATCH_ROWS"); for (const row of adjudication.gnosisPatchIdentity.rows) { ok(row.currentPatchExactR2 && !row.usesPredecessor, "CURRENT_PATCH"); ok(row.parentImplementationExactOptimizer200 && row.registryImplementationExactOptimizer200, "PATCH_IMPLS"); } ok(adjudication.gnosisPatchIdentity.parentFactoryImmutable === "0x45ea1d8cb97fd04e064f92eb56305610900928dc", "FACTORY_IMMUTABLE"); suites.push("exact Gnosis patch identity");
  ok(build.records.length === 17 && build.records.every((x) => x.exact), "BUILD_RECORDS"); for (const row of acquisition.records) { const runtime = fs.readFileSync(path.join(ROOT, ...row.runtime.authorityPath.split("/")), "utf8").trim(); ok(keccak256(runtime) === row.runtime.keccak256, `RUNTIME_${row.address}`); } ok(build.uniqueRuntimeFamiliesExact === 16, "UNIQUE_EXACT"); suites.push("runtime authority hashes and exact rebuilds");
  ok(adjudication.positions.active === 14 && adjudication.positions.lineagesResolved === 14, "POSITIONS"); ok(adjudication.positions.activeOneTicketBoundaries === 0 && !adjudication.positions.liveClaimPerformed, "ZERO_BOUNDARY"); ok(adjudication.positions.rows.every((x) => x.lineageResolved && !x.oneTicketBoundary && !x.liveClaimPerformed), "POSITION_ROWS"); ok(adjudication.gates.routePositive === false && adjudication.gates.executableNow === false && adjudication.gates.forkJustified === false, "GATES"); suites.push("active positions, zero boundary, and no live claim");
  ok(gitBindings.status === "PASS" && gitBindings.uniqueSourceBlobs === 150, "SOURCE_BLOBS"); ok(gitBindings.officialGitBlobBound === 150 && gitBindings.explorerOnlyButRuntimeRebuildExact === 0, "GIT_BINDINGS"); suites.push("official Git and dependency source bindings");
  const output = { schemaVersion: 1, testId: "stakewise-subvault-exitqueue-residual-gate0-r2", generatedAt: new Date().toISOString(), status: "PASS", suites: suites.length, assertions, coverage: suites, networkReads: 0, rpcReads: 0, historyReads: 0, stateReads: 0, fork: false, signing: false, transactions: false };
  const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`); fs.writeFileSync(path.join(OUT, "tests.json"), bytes); console.log(JSON.stringify({ status: output.status, suites: output.suites, assertions: output.assertions, testsSha256: sha256(bytes) }));
}

try { main(); } catch (error) { console.error(JSON.stringify({ status: "FAIL", code: String(error.message || "FAILURE"), assertions })); process.exitCode = 1; }
