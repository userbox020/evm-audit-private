#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./run-critical-fluid-vaultt2-t4-negative-max-step2.js");

const ROOT = path.resolve(__dirname, "..");
const PREFIX = "reports/raw/fast/critical-fluid-vaultt2-t4-negative-max-step2";
const rel = value => path.join(ROOT, ...value.split("/"));
const read = value => fs.readFileSync(rel(value));
const text = value => read(value).toString("utf8");
const json = value => JSON.parse(text(value));
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;

function check(condition, message) {
  checks++;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}

function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

const capture = json(`${PREFIX}-capture.json`);
const predecessor = json(`${PREFIX}-capture-pre-oracle.json`);
const result = json(`${PREFIX}.json`);
const partial = json(`${PREFIX}-partial-r5.json`);
for (const object of [capture, predecessor, result, partial]) {
  runner.assertNoLeaks(object);
  checks++;
}

equal(capture.schemaVersion, 2, "corrected capture schema");
equal(capture.classification, "CONDITIONAL-LOW/VULNERABLE-SHAPED-PREDICATE-SIGNATURE-OBSERVED/DEPLOYED-OPERATEPERFECT-SEMANTICS-UNBOUND/HISTORY-INCOMPLETE/CALLER-FUNDED/NO-OUTSIDER-THEFT", "corrected classification");
equal([capture.routePositive, capture.executableNow, capture.signedActionJustified, capture.fork], [0, 0, false, false], "corrected gates");
equal(capture.oracleCorrection.offlineOnly, true, "oracle correction offline");
equal([capture.oracleCorrection.networkReads, capture.oracleCorrection.rpcReads, capture.oracleCorrection.fork, capture.oracleCorrection.signing], [0, 0, false, false], "oracle safety");
equal(capture.oracleCorrection.predecessorPath, `${PREFIX}-capture-pre-oracle.json`, "predecessor path");
equal(sha256(read(`${PREFIX}-capture-pre-oracle.json`)), capture.oracleCorrection.predecessorSha256, "predecessor hash");
equal(capture.oracleCorrection.predecessorSha256, "b1dda208643a233300009fdbe59befe836bbd724622b255226e5828ee1910dce", "predecessor exact hash");
equal(predecessor.classification, "CONDITIONAL-LOW/CURRENT-AFFECTED-RUNTIME/NO-NEGATIVE-SENTINEL-IN-DECODABLE-HISTORY/CALLER-FUNDED/NO-OUTSIDER-THEFT", "predecessor preserved");

equal([capture.aggregate.chainsPinned, capture.aggregate.chainsTerminalExact, capture.aggregate.twoFamilyPinnedChains], [6, 6, 4], "pin aggregate");
equal([capture.aggregate.vaultT2, capture.aggregate.vaultT4, capture.aggregate.vaultT2T4], [84, 44, 128], "vault aggregate");
equal([
  capture.aggregate.vulnerableShapedPredicateSignatureObserved,
  capture.aggregate.patchedShapedPredicateSignatureObserved,
  capture.aggregate.predicateShapeUnknown,
  capture.aggregate.deployedOperatePerfectSemanticsBound,
  capture.aggregate.deployedOperatePerfectSemanticsUnbound
], [128, 0, 0, 0, 128], "runtime qualification aggregate");
equal([
  capture.aggregate.primaryFamilyOperateLogRowsObserved,
  capture.aggregate.transactionLevelOperatePerfectDecodes,
  capture.aggregate.primaryFamilyScanCompletedChains,
  capture.aggregate.crossFamilyCompletenessAgreementChains,
  capture.aggregate.completeInputDecodeChains
], [4378, 99, 1, 0, 0], "history qualification aggregate");
equal(capture.aggregate.transactionLevelPerfectDepositToken1MaxObservations, {
  negative: 0,
  minusOne: 0,
  int256Min: 0,
  zero: 0,
  positive: 37
}, "transaction-level token1 observations");
equal(capture.aggregate.exactOverspendObservations, 0, "no overspend observation");

equal(capture.sourceBinding.runtimeTemplatesAreReferenceArtifactsNotDeployedRuntimeCommitments, true, "reference templates qualified");
for (const type of ["t2", "t4"]) {
  const row = capture.sourceBinding.runtimeTemplates[type];
  check(row.referenceVulnerableTemplateArtifactSha256.length === 64, `${type} vulnerable reference hash`);
  check(row.referencePatchedTemplateArtifactSha256.length === 64, `${type} patched reference hash`);
  check(!Object.hasOwn(row, "vulnerableLogicalBodySha256"), `${type} old ambiguous key absent`);
}

equal(capture.reconciliation.resumed, true, "resume retained");
equal([capture.reconciliation.retainedChains, capture.reconciliation.retainedTerminalExactChains, capture.reconciliation.newlyQueriedChains], [5, 5, 1], "resume counts");
equal(sha256(read(`${PREFIX}-partial-r5.json`)), capture.reconciliation.partialArtifactSha256, "partial hash");
equal(partial.completedChains, 5, "partial rows");

const expected = {
  bnb: { pin: "113018569", hash: "0x790f472b9b9c8cb18035ff6f73bd0d04e0493d2962f9801a0f881240c182d50c", families: 2, t2: 4, t4: 1 },
  plasma: { pin: "28478081", hash: "0xe9f0f279918ecfbc343582009853c39f3ec0676572a825facd16842b87514d14", families: 1, t2: 14, t4: 1 },
  polygon: { pin: "91142326", hash: "0xcf9e17007b62a2a0a7f7dee80a6cddcfcfd12318ee549c3cb3de138e04faa697", families: 1, t2: 4, t4: 2 },
  base: { pin: "49314028", hash: "0x177e893d2126ce80d173e1b90a8f2d7e5aa391a71773abadf821449b860510da", families: 2, t2: 10, t4: 3 },
  arbitrum: { pin: "489304616", hash: "0xcbc31430ddf812280dcd3f7d4408b4827fce4349f83328870cbf6b1e1275e6f9", families: 2, t2: 18, t4: 11 },
  ethereum: { pin: "25645981", hash: "0x2ba4ec81c0fedcbca6760580716617abac5c8a941137175baf43aeb25fafac95", families: 2, t2: 34, t4: 26 }
};
equal(capture.chains.map(row => row.chain), Object.keys(expected), "chain order");
for (const chain of capture.chains) {
  const row = expected[chain.chain];
  equal([chain.pin.number, chain.pin.hash, chain.pin.familiesObserved], [row.pin, row.hash, row.families], `${chain.chain} pin`);
  equal(chain.pin.terminalRecheck.exactNumberHashMatched, true, `${chain.chain} terminal`);
  equal([chain.vaults.t2, chain.vaults.t4], [row.t2, row.t4], `${chain.chain} vault count`);
  const runtime = chain.vaults.runtime;
  equal([
    runtime.vulnerableShapedPredicateSignatureObserved,
    runtime.patchedShapedPredicateSignatureObserved,
    runtime.predicateShapeUnknown,
    runtime.deployedOperatePerfectSemanticsBound,
    runtime.deployedOperatePerfectSemanticsUnbound
  ], [row.t2 + row.t4, 0, 0, 0, row.t2 + row.t4], `${chain.chain} runtime qualification`);
  equal(runtime.selectorControlFlowAnchoredProofRetained, false, `${chain.chain} no anchored proof`);
  equal([
    runtime.observedOperateRuntimeCodeCommitmentSha256,
    runtime.observedOperateRuntimeCodeCommitmentCount,
    runtime.observedVaultCoreRuntimeCodeCommitmentSha256,
    runtime.observedVaultCoreRuntimeCodeCommitmentCount,
    runtime.observedRuntimeCommitmentsRetained
  ], [null, null, null, null, false], `${chain.chain} actual commitment nulls`);
  equal(runtime.referenceTemplateHashesAreNotDeployedCommitments, true, `${chain.chain} template qualification`);
  equal(chain.vaults.linkage.liquidityMatched, row.t2 + row.t4, `${chain.chain} liquidity link`);
  equal(chain.vaults.linkage.factoryMatched, row.t2 + row.t4, `${chain.chain} factory link`);
  equal(chain.current.liquidityStatus, "1", `${chain.chain} liquidity status`);
  equal(chain.history.crossFamilyCompletenessAgreement, null, `${chain.chain} cross-family null`);
  equal(chain.history.crossFamilyCompletenessClaimed, false, `${chain.chain} no completeness claim`);
  equal(chain.history.successfulLogOperateLinkageProven, false, `${chain.chain} no event-call success linkage`);
  equal(chain.history.traceInnerCallSuccessProven, false, `${chain.chain} trace success unproven`);
  equal(chain.history.transactionLevelPerfectDepositToken1MaxObservations.negative, 0, `${chain.chain} zero negative observation`);
  equal(chain.history.exactOverspendObservations, 0, `${chain.chain} overspend observations`);
  equal(chain.history.overspendRaw, null, `${chain.chain} overspend null`);
}

const base = capture.chains.find(row => row.chain === "base");
equal([base.history.primaryFamilyOperateLogRowsObserved, base.history.primaryFamilyUniqueTransactionsObserved], [4378, 3874], "Base primary observations");
equal(base.history.primaryFamilyScanCompleted, true, "Base primary completed");
equal(base.history.primaryFamilyScanQualification, "primary-family scan completed; cross-family completeness/agreement unavailable", "Base qualification wording");
equal(base.history.secondaryFamilyScan.attempted, true, "Base secondary attempted");
equal([base.history.secondaryFamilyScan.queries, base.history.secondaryFamilyScan.failedMinimumRanges], [150, 73], "Base secondary exhaustion");
check(base.history.secondaryFamilyScan.disposition.includes("did not establish completeness/agreement"), "Base secondary disposition");
equal([base.history.transactionsFetched, base.history.directTransactionObservations, base.history.indirectTransactionObservations], [400, 216, 184], "Base transaction observations");
equal([base.history.traceTransactionsAttempted, base.history.traceTransactionsWithTargetCalldataObserved], [50, 50], "Base trace observations");
equal(base.history.traceObservationsMayIncludeRevertedInnerCalls, true, "Base reverted trace caveat");
equal([base.history.transactionLevelOperatePerfectDecodes, base.history.transactionLevelOperateDecodes, base.history.unresolvedProcessedLogRows], [99, 196, 192], "Base decode observations");
equal(base.history.transactionLevelDecodedCallerCategories, {directEoa: 83, contractIntegration: 16, knownLocalIntegrationContract: 0, unresolved: 0}, "Base caller observations");
for (const chain of capture.chains.filter(row => row.chain !== "base")) equal(chain.history.primaryFamilyScanCompleted, false, `${chain.chain} primary incomplete`);

equal(result.schemaVersion, 3, "result schema");
equal(result.classification, capture.classification, "result classification");
equal([result.routePositive, result.executableNow, result.signedActionJustified, result.fork], [0, 0, false, false], "result gates");
equal([
  result.runtimeObservation.vulnerableShapedPredicateSignatureObserved,
  result.runtimeObservation.deployedOperatePerfectSemanticsBound,
  result.runtimeObservation.deployedOperatePerfectSemanticsUnbound
], [128, 0, 128], "result runtime qualification");
equal(result.runtimeObservation.observedOperateRuntimeCodeCommitmentSha256, null, "result actual operate commitment null");
equal(result.runtimeObservation.observedVaultCoreRuntimeCodeCommitmentSha256, null, "result actual core commitment null");
equal(result.history.transactionLevelPerfectDepositToken1MaxObservations, {negative: 0, minusOne: 0, int256Min: 0, zero: 0, positive: 37}, "result token1 observations");
equal(result.history.transactionLevelDecodedCallerCategories, {directEoa: 83, contractIntegration: 16, knownLocalIntegrationContract: 0, unresolved: 0}, "result caller observations");
equal([result.history.traceInnerCallSuccessProven, result.history.successfulLogOperateLinkageProven], [false, false], "result trace/log qualification");
equal(result.history.exactOverspendRaw, null, "result overspend null");
equal(result.current, {
  uniqueDexPoolsByChainSum: 88,
  smartCollateralEnabledPoolsByChainSum: 83,
  smartCollateralDisabledPoolsByChainSum: 5,
  swapAndArbitragePausedPoolsByChainSum: 13,
  nativeToken1Vaults: 22,
  erc20Token1Vaults: 106,
  liquidityNormalChains: 6
}, "result current context");

const fixtures = json(`${PREFIX}-offline-fixtures.capture.json`);
equal([fixtures.exitCode, fixtures.timedOut, fixtures.network, fixtures.endpointInventoryAccess], [0, false, false, false], "fixture capture");
equal(text(fixtures.stdout.path), "PASS 62 offline fixture checks; counted 99 local manifest files; classified 2 explicitly retained deployment artifacts\n", "fixture wording");
equal(read(fixtures.stderr.path).length, 0, "fixture stderr");

const runnerSource = text("tools/run-critical-fluid-vaultt2-t4-negative-max-step2.js");
check(runnerSource.includes("observedOperateRuntimeCodeCommitmentSha256"), "runner future actual operate commitment");
check(runnerSource.includes("observedVaultCoreRuntimeCodeCommitmentSha256"), "runner future actual core commitment");
check(runnerSource.includes("traceObservationsMayIncludeRevertedInnerCalls"), "runner trace qualification");
check(!runnerSource.includes("CURRENT-AFFECTED-RUNTIME"), "runner current exact affected wording absent");
const correctionSource = text("tools/correct-critical-fluid-vaultt2-t4-negative-max-step2-oracle.js");
check(correctionSource.includes("ORACLE_CORRECTION_CHECK_ONLY_MISMATCH"), "correction check-only");

const report = text("reports/critical-fluid-vaultt2-t4-negative-max-step2.md");
check(report.includes("**Signal: 🟠 WATCH — CONDITIONAL LOW / VULNERABLE-SHAPED"), "report signal");
check(report.includes("deployed `operatePerfect` semantics claim"), "report runtime downgrade");
check(report.includes("primary-family scan completed, but cross-family completeness/agreement is unavailable"), "report Base family correction");
check(report.includes("Trace-derived calldata may include reverted inner calls"), "report trace correction");
check(report.includes("not proven one-to-one successful LogOperate-linked calls"), "report event linkage correction");
check(report.includes("counts all 99 files but runtime-shape classification is asserted only for the two explicitly retained deployment artifacts"), "report fixture correction");
check(report.includes("Actual observed runtime bytes/code hashes were not retained"), "report commitment null");
check(report.includes("null**, not zero"), "report overspend null");

const finalRun = json(`${PREFIX}-run-r6-resume.capture.json`);
equal([finalRun.exitCode, finalRun.timedOut, finalRun.spawnError], [0, false, null], "retained final network capture");
for (const stream of ["stdout", "stderr"]) {
  equal(read(finalRun[stream].path).length, finalRun[stream].bytes, `final ${stream} bytes`);
  equal(sha256(read(finalRun[stream].path)), finalRun[stream].sha256, `final ${stream} hash`);
}

const manifest = json(`${PREFIX}-manifest.json`);
equal(manifest.schemaVersion, 3, "manifest schema");
equal(manifest.artifactCount, manifest.artifacts.length, "manifest count");
const paths = new Set();
for (const artifact of manifest.artifacts) {
  check(!paths.has(artifact.path), `manifest unique ${artifact.path}`);
  paths.add(artifact.path);
  equal(read(artifact.path).length, artifact.bytes, `manifest bytes ${artifact.path}`);
  equal(sha256(read(artifact.path)), artifact.sha256, `manifest hash ${artifact.path}`);
}
const aggregate = sha256(Buffer.from(manifest.artifacts.map(artifact => `${artifact.path}:${artifact.sha256}`).sort().join("\n"), "utf8"));
equal(aggregate, manifest.aggregateSha256, "manifest aggregate");
for (const required of [
  `${PREFIX}-capture.json`, `${PREFIX}-capture-pre-oracle.json`, `${PREFIX}-partial-r5.json`,
  `${PREFIX}-offline-fixtures.capture.json`, `${PREFIX}.json`,
  "reports/critical-fluid-vaultt2-t4-negative-max-step2.md",
  "tools/run-critical-fluid-vaultt2-t4-negative-max-step2.js",
  "tools/correct-critical-fluid-vaultt2-t4-negative-max-step2-oracle.js",
  "tools/generate-critical-fluid-vaultt2-t4-negative-max-step2-package.js",
  "tools/validate-critical-fluid-vaultt2-t4-negative-max-step2.js"
]) check(paths.has(required), `manifest required ${required}`);

console.log(`PASS ${checks} checks; aggregate ${aggregate}`);
