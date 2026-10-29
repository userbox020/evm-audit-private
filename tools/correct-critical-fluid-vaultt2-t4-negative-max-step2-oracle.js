#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./run-critical-fluid-vaultt2-t4-negative-max-step2.js");

const ROOT = path.resolve(__dirname, "..");
const PREFIX = path.join(ROOT, "reports", "raw", "fast", "critical-fluid-vaultt2-t4-negative-max-step2");
const CAPTURE = `${PREFIX}-capture.json`;
const ARCHIVE = `${PREFIX}-capture-pre-oracle.json`;
const CHECK_ONLY = process.argv.includes("--check-only");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function correctedSourceBinding(binding) {
  const output = clone(binding);
  output.runtimeTemplatesAreReferenceArtifactsNotDeployedRuntimeCommitments = true;
  for (const type of ["t2", "t4"]) {
    const row = output.runtimeTemplates[type];
    row.referenceVulnerableTemplateArtifact = row.vulnerableArtifact;
    row.referenceVulnerableTemplateArtifactSha256 = row.vulnerableArtifactSha256;
    row.referenceVulnerableTemplateLogicalBodySha256 = row.vulnerableLogicalBodySha256;
    row.referencePatchedTemplateArtifact = row.patchedArtifact;
    row.referencePatchedTemplateArtifactSha256 = row.patchedArtifactSha256;
    row.referencePatchedTemplateLogicalBodySha256 = row.patchedLogicalBodySha256;
    delete row.vulnerableArtifact;
    delete row.vulnerableArtifactSha256;
    delete row.vulnerableLogicalBodySha256;
    delete row.patchedArtifact;
    delete row.patchedArtifactSha256;
    delete row.patchedLogicalBodySha256;
  }
  return output;
}

function correctedRuntime(runtime) {
  const t2Observed = runtime.t2?.vulnerable ?? runtime.t2?.vulnerableShapedPredicateSignatureObserved ?? 0;
  const t4Observed = runtime.t4?.vulnerable ?? runtime.t4?.vulnerableShapedPredicateSignatureObserved ?? 0;
  const t2Patched = runtime.t2?.patched ?? runtime.t2?.patchedShapedPredicateSignatureObserved ?? 0;
  const t4Patched = runtime.t4?.patched ?? runtime.t4?.patchedShapedPredicateSignatureObserved ?? 0;
  const total = t2Observed + t4Observed;
  return {
    t2: {
      vulnerableShapedPredicateSignatureObserved: t2Observed,
      patchedShapedPredicateSignatureObserved: t2Patched,
      predicateShapeUnknown: runtime.t2?.unknown ?? 0
    },
    t4: {
      vulnerableShapedPredicateSignatureObserved: t4Observed,
      patchedShapedPredicateSignatureObserved: t4Patched,
      predicateShapeUnknown: runtime.t4?.unknown ?? 0
    },
    vulnerableShapedPredicateSignatureObserved: total,
    patchedShapedPredicateSignatureObserved: t2Patched + t4Patched,
    predicateShapeUnknown: (runtime.t2?.unknown ?? 0) + (runtime.t4?.unknown ?? 0),
    deployedOperatePerfectSemanticsBound: 0,
    deployedOperatePerfectSemanticsUnbound: total + t2Patched + t4Patched,
    selectorControlFlowAnchoredProofRetained: false,
    classificationQualification: "vulnerable-shaped predicate signature observed; deployed operatePerfect semantics unbound",
    observedOperateRuntimeCodeCommitmentSha256: null,
    observedOperateRuntimeCodeCommitmentCount: null,
    observedVaultCoreRuntimeCodeCommitmentSha256: null,
    observedVaultCoreRuntimeCodeCommitmentCount: null,
    observedRuntimeCommitmentsRetained: false,
    observedRuntimeCommitmentReason: "The retained capture stored only template-derived logical classifications and unique counts, not actual observed runtime bytes or code hashes; offline correction cannot reconstruct deployed commitments.",
    referenceTemplateHashesAreNotDeployedCommitments: true,
    signatureObservationMethod: "unanchored unique byte-pattern differential against explicitly retained T2/T4 deployment artifacts",
    codeMissing: runtime.codeMissing
  };
}

function correctedHistory(history) {
  const basePrimaryComplete = history.logUniverseComplete === true;
  const secondaryAttempted = (history.logQueriesSecondary || 0) > 0;
  return {
    primaryFamilyOperateLogRowsObserved: history.eventCount,
    primaryFamilyUniqueTransactionsObserved: history.uniqueTransactions,
    primaryFamilyScanCompleted: basePrimaryComplete,
    primaryFamilyScanQualification: basePrimaryComplete
      ? "primary-family scan completed; cross-family completeness/agreement unavailable"
      : "primary-family scan partial or unavailable",
    crossFamilyCompletenessAgreement: null,
    crossFamilyCompletenessClaimed: false,
    secondaryFamilyScan: {
      attempted: secondaryAttempted,
      queries: history.logQueriesSecondary || 0,
      failedMinimumRanges: history.failedMinimumRangesSecondary || 0,
      disposition: secondaryAttempted
        ? "query budget exhausted, failed ranges, or otherwise did not establish completeness/agreement"
        : "not completed"
    },
    stoppedReason: history.stoppedReason,
    transactionsFetched: history.transactionsFetched,
    directTransactionObservations: history.directTransactions,
    indirectTransactionObservations: history.indirectTransactions,
    traceTransactionsAttempted: history.traceTransactionsAttempted,
    traceTransactionsWithTargetCalldataObserved: history.traceTransactionsResolved,
    traceInnerCallSuccessProven: false,
    traceObservationsMayIncludeRevertedInnerCalls: history.traceTransactionsAttempted > 0,
    successfulLogOperateLinkageProven: false,
    transactionLevelOperatePerfectDecodes: history.decodedOperatePerfect,
    transactionLevelOperateDecodes: history.decodedOperate,
    unresolvedProcessedLogRows: history.unresolvedEventCalls,
    transactionLevelPerfectDepositToken1MaxObservations: clone(history.perfectDeposits),
    transactionLevelDecodedCallerCategories: clone(history.callerCategories),
    negativeCallerAuthorityObservations: clone(history.negativeCallerAuthority),
    negativeActualSpend: clone(history.negativeActualSpend),
    exactPreCallReplays: history.exactPreCallReplays,
    exactPreCallReplayMatchesActual: history.exactPreCallReplayMatchesActual,
    exactOverspendObservations: history.exactOverspendObservations,
    overspendRaw: null,
    overspendReason: history.overspendReason,
    fromBlock: history.fromBlock,
    toBlock: history.toBlock,
    primaryQueries: history.logQueriesPrimary || 0,
    primaryFailedMinimumRanges: history.failedMinimumRangesPrimary || 0,
    inputDecodeCompleteness: "bounded-partial",
    rawTransactionsPersisted: false,
    rawLogsPersisted: false,
    callerIdentitiesPersisted: false
  };
}

function transform(source) {
  const output = clone(source);
  output.schemaVersion = 2;
  output.classification = "CONDITIONAL-LOW/VULNERABLE-SHAPED-PREDICATE-SIGNATURE-OBSERVED/DEPLOYED-OPERATEPERFECT-SEMANTICS-UNBOUND/HISTORY-INCOMPLETE/CALLER-FUNDED/NO-OUTSIDER-THEFT";
  output.oracleCorrection = {
    offlineOnly: true,
    correctedAt: "2026-07-30",
    predecessorPath: "reports/raw/fast/critical-fluid-vaultt2-t4-negative-max-step2-capture-pre-oracle.json",
    predecessorSha256: hash(fs.readFileSync(ARCHIVE)),
    networkReads: 0,
    rpcReads: 0,
    fork: false,
    signing: false,
    correction: "Runtime observations downgraded to unanchored vulnerable-shaped signatures; history counts qualified as transaction-level decode/trace observations and cross-family completeness removed."
  };
  output.sourceBinding = correctedSourceBinding(source.sourceBinding);
  output.aggregate = {
    chainsRequested: source.aggregate.chainsRequested,
    chainsPinned: source.aggregate.chainsPinned,
    chainsTerminalExact: source.aggregate.chainsTerminalExact,
    twoFamilyPinnedChains: source.aggregate.twoFamilyPinnedChains,
    backendIndependenceClaimed: false,
    vaultT2: source.aggregate.vaultT2,
    vaultT4: source.aggregate.vaultT4,
    vaultT2T4: source.aggregate.vaultT2T4,
    vulnerableShapedPredicateSignatureObserved: source.aggregate.affectedDuplicatedPredicate,
    patchedShapedPredicateSignatureObserved: source.aggregate.remediatedPredicate,
    predicateShapeUnknown: source.aggregate.unknownRuntime,
    deployedOperatePerfectSemanticsBound: 0,
    deployedOperatePerfectSemanticsUnbound: source.aggregate.vaultT2T4,
    primaryFamilyOperateLogRowsObserved: source.aggregate.operateEvents,
    transactionLevelOperatePerfectDecodes: source.aggregate.decodedOperatePerfect,
    transactionLevelPerfectDepositToken1MaxObservations: {
      negative: source.aggregate.perfectDepositNegative,
      minusOne: source.aggregate.perfectDepositMinusOne,
      int256Min: source.aggregate.perfectDepositInt256Min,
      zero: source.aggregate.perfectDepositZero,
      positive: source.aggregate.perfectDepositPositive
    },
    exactOverspendObservations: source.aggregate.exactOverspendObservations,
    primaryFamilyScanCompletedChains: source.aggregate.historyLogCompleteChains,
    crossFamilyCompletenessAgreementChains: 0,
    completeInputDecodeChains: 0
  };
  output.chains = source.chains.map(chain => {
    const row = clone(chain);
    row.vaults.runtime = correctedRuntime(chain.vaults.runtime);
    row.history = correctedHistory(chain.history);
    row.current.accountSpecificAbilityReason = "Vulnerable-shaped predicate signature observed; deployed operatePerfect semantics and account-specific invocation remain unbound.";
    return row;
  });
  output.conclusion = {
    permissionlessOutsiderProfitOrForcedThirdPartyLoss: false,
    callerFundedSourceAndIntegrationImpact: true,
    exactHistoricalOverspendEstablished: false,
    severity: "conditional-low",
    deploymentExposure: "vulnerable-shaped-predicate-signature-observed-semantics-unbound",
    currentExactAffectedRuntimeClaimed: false,
    strictCaveat: "Zero observed negative sentinels is limited to retained transaction-level decodes. Trace observations may include reverted inner calls, cross-family history completeness is unavailable, and deployed operatePerfect semantics are unbound."
  };
  runner.assertNoLeaks(output);
  return output;
}

if (!fs.existsSync(ARCHIVE)) {
  if (CHECK_ONLY) throw new Error("PRE_ORACLE_ARCHIVE_MISSING");
  fs.copyFileSync(CAPTURE, ARCHIVE);
}
const source = readJson(ARCHIVE);
const corrected = transform(source);
const expected = `${JSON.stringify(corrected, null, 2)}\n`;
if (CHECK_ONLY) {
  if (!fs.existsSync(CAPTURE) || fs.readFileSync(CAPTURE, "utf8") !== expected) throw new Error("ORACLE_CORRECTION_CHECK_ONLY_MISMATCH");
  console.log(`PASS oracle correction check-only; predecessor ${corrected.oracleCorrection.predecessorSha256}`);
} else {
  fs.writeFileSync(CAPTURE, expected, "utf8");
  console.log(`CORRECTED offline; predecessor ${corrected.oracleCorrection.predecessorSha256}`);
}

module.exports = { correctedHistory, correctedRuntime, correctedSourceBinding, transform };
