'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = 'reports/raw/fast/cap-current-reserve-callback-calltarget-gate1-r3';
const CAPTURE_PATH = `${RAW_DIR}/capture.json`;
const EXPECTED_PATH = `${RAW_DIR}/expected-edge-manifest.json`;
const CORRECTION_PATH = `${RAW_DIR}/review-correction.json`;
const REPORT_PATH = 'reports/critical-cap-current-reserve-callback-calltarget-gate1-r3-final-review-correction.md';
const INBOX_PATH = 'coordination/inbox/critical/20260820-critical-cap-current-reserve-callback-calltarget-gate1-r3-reviewed.json';
const HANDOFF_PATH = 'coordination/handoffs/20260820-critical-cap-current-reserve-callback-calltarget-gate1-r3-reviewed.md';
const BUILDER_PATH = 'tools/build-cap-current-reserve-callback-calltarget-gate1-r3-final-review-correction.js';
const TEST_PATH = 'tools/test-cap-current-reserve-callback-calltarget-gate1-r3-final-review-correction.js';
const ZERO = '0x0000000000000000000000000000000000000000';

function absolute(relativePath) {
  return path.join(ROOT, ...relativePath.split('/'));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(absolute(relativePath), 'utf8'));
}

function writeText(relativePath, value) {
  fs.writeFileSync(absolute(relativePath), value, 'utf8');
}

function sha256(buffer) {
  return `0x${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function fileCommitment(relativePath) {
  const bytes = fs.readFileSync(absolute(relativePath));
  return { path: relativePath, bytes: bytes.length, sha256: sha256(bytes) };
}

function compareIds(expectedRows, observedRows) {
  const expected = new Set(expectedRows.map((row) => row.edgeId));
  const observed = new Set(observedRows.map((row) => row.edgeId));
  const expectedById = new Map(expectedRows.map((row) => [row.edgeId, row]));
  const observedById = new Map(observedRows.map((row) => [row.edgeId, row]));
  assert.equal(expected.size, expectedRows.length, 'expected edge IDs must be unique');
  assert.equal(observed.size, observedRows.length, 'observed edge IDs must be unique');
  const intersection = [...expected].filter((edgeId) => observed.has(edgeId));
  const fieldMismatchedIntersectionEdgeIds = intersection.filter((edgeId) => {
    const expectedRow = expectedById.get(edgeId);
    const observedRow = observedById.get(edgeId);
    return JSON.stringify(expectedRow.receiverPropagation) !== JSON.stringify(observedRow.receiverPropagation);
  });
  return {
    expectedCount: expected.size,
    observedCount: observed.size,
    absentCount: [...expected].filter((edgeId) => !observed.has(edgeId)).length,
    extraCount: [...observed].filter((edgeId) => !expected.has(edgeId)).length,
    intersectionCount: intersection.length,
    intersectionEdgeIds: intersection.sort(),
    fieldMismatchedIntersectionCount: fieldMismatchedIntersectionEdgeIds.length,
    fieldMismatchedIntersectionEdgeIds: fieldMismatchedIntersectionEdgeIds.sort(),
  };
}

function buildModel() {
  const capture = readJson(CAPTURE_PATH);
  const expected = readJson(EXPECTED_PATH);
  const testResult = readJson(`${RAW_DIR}/test-result.json`);
  const comparison = compareIds(expected.rows, capture.observedEdgeLedger);
  const mismatchIds = [...new Set(capture.edgeClosure.comparison.mismatched.map((item) => item.edgeId))].sort();
  const unanchoredExpectedRows = expected.rows.filter((row) => row.sourceAnchor?.anchored === false).length;
  const expectedNullTargetRows = expected.rows.filter((row) => row.target === null).length;
  const disabledZeroRows = capture.observedEdgeLedger.filter(
    (row) => row.bindingStatus === 'DISABLED_ZERO' && row.target === ZERO,
  );
  const unresolvedTypedImmutables = capture.runtimeSourceBinding.compilerReferences.flatMap((record) =>
    (record.immutables || [])
      .filter((item) => item.typedResolved === false && /^contract /.test(item.typeString || ''))
      .map((item) => ({
        runtimeRecord: record.target,
        declaration: item.declaration,
        typeString: item.typeString,
        occurrenceCount: item.occurrences.length,
        rawWordsReconciled:
          item.occurrences.length > 0 &&
          new Set(item.occurrences.map((occurrence) => occurrence.rawBytes)).size === 1,
      })),
  );
  const unresolvedRuntimeRecords = new Set(unresolvedTypedImmutables.map((item) => item.runtimeRecord));
  const unresolvedLinks = capture.runtimeSourceBinding.compilerReferences.flatMap((record) =>
    (record.links || []).filter((item) => item.decoded !== true || !item.typedValue),
  );
  const incompleteIndexedMarketState = capture.vaultV2CurrentConfiguration.flatMap((entry) =>
    entry.indexedAdapterMarketState.filter((item) => item.complete !== true || item.marketIds === null),
  );
  const allocatorSentinelValuesCapturedAndAgreed = capture.vaultV2CurrentConfiguration.every((entry) =>
    entry.config.allocatorRelevant.allocatorSentinelState.every((item) => item.twoFamilyAgreement === true),
  );
  const perMarketAllocationValuesCapturedAndAgreed = capture.vaultV2CurrentConfiguration.every((entry) =>
    entry.config.allocatorRelevant.perIdAllocation.every((item) => item.twoFamilyAgreement === true),
  );

  assert.equal(capture.status, 'UNKNOWN_FAIL_CLOSED');
  assert.equal(comparison.expectedCount, capture.edgeClosure.comparison.expectedCount);
  assert.equal(comparison.observedCount, capture.edgeClosure.comparison.observedCount);
  assert.equal(comparison.absentCount, capture.edgeClosure.comparison.absent.length);
  assert.equal(comparison.extraCount, capture.edgeClosure.comparison.extra.length);
  assert.deepEqual(comparison.fieldMismatchedIntersectionEdgeIds, comparison.intersectionEdgeIds);
  assert.deepEqual(mismatchIds, comparison.fieldMismatchedIntersectionEdgeIds);
  assert.equal(comparison.expectedCount, 168);
  assert.equal(comparison.observedCount, 43);
  assert.equal(comparison.absentCount, 154);
  assert.equal(comparison.extraCount, 29);
  assert.equal(comparison.intersectionCount, 14);
  assert.equal(unanchoredExpectedRows, 73);
  assert.equal(expectedNullTargetRows, 8);
  assert.equal(disabledZeroRows.length, 4);
  assert.equal(unresolvedTypedImmutables.length, 14);
  assert.equal(unresolvedRuntimeRecords.size, 4);
  assert.ok(unresolvedTypedImmutables.every((item) => item.rawWordsReconciled));
  assert.equal(unresolvedLinks.length, 0);
  assert.equal(incompleteIndexedMarketState.length, 2);
  assert.equal(allocatorSentinelValuesCapturedAndAgreed, true);
  assert.equal(perMarketAllocationValuesCapturedAndAgreed, true);
  assert.equal(testResult.status, 'PASS');
  assert.equal(testResult.suites, 13);
  assert.equal(testResult.assertions, 86);
  assert.equal(capture.chain.allReadsPinnedByBlockHash, true);
  assert.equal(capture.qualification.independentFamilyKeys, true);
  assert.equal(capture.gates.economics, 'UNOPENED');
  assert.equal(capture.gates.fork, false);
  assert.equal(capture.gates.signing, false);

  return {
    capture,
    expected,
    testResult,
    comparison,
    mismatchIds,
    unanchoredExpectedRows,
    expectedNullTargetRows,
    disabledZeroRows,
    unresolvedTypedImmutables,
    unresolvedRuntimeRecords,
    unresolvedLinks,
    incompleteIndexedMarketState,
    allocatorSentinelValuesCapturedAndAgreed,
    perMarketAllocationValuesCapturedAndAgreed,
  };
}

function buildReport(model) {
  const { comparison } = model;
  return `# Final review correction overlay — Cap Gate1 R3

Date: 2026-08-20  
Claim: \`critical/cap-current-reserve-callback-calltarget-gate1\`

## Authority and disposition

This file and the sibling \`review-correction.json\` are an immutable correction overlay. They do not alter R1, R2, R3, their raw artifacts, manifests, inboxes, handoffs, or capture tools. The canonical status remains \`UNKNOWN_FAIL_CLOSED\`; the independent final-review verdict is \`APPROVE_UNKNOWN_WITH_CORRECTIONS\`. **Stop/rotate.**

R1/R2 reports, corrections, inboxes, handoffs, and all embedded \`FINAL\`, canonical, \`NEGATIVE\`, close, or next-action instructions are superseded and non-authoritative. Existing R3 statements corrected here are also non-authoritative where they conflict with this overlay. Hash commitments are recorded in the machine-readable overlay.

## Corrected inventory interpretation

The expected ${comparison.expectedCount}/observed ${comparison.observedCount} comparison is not one-for-one. Offline recomputation gives absent ${comparison.absentCount}, extra ${comparison.extraCount}, and intersection ${comparison.intersectionCount}; all ${comparison.intersectionCount} intersecting IDs are field-mismatched. The expected candidate inventory is only partially source-anchored: \`expectedEdgeManifestSourceDerived=false\`, \`allExpectedRowsSourceAnchored=false\`, \`unanchoredExpectedRows=${model.unanchoredExpectedRows}\`, and \`expectedNullTargetRows=${model.expectedNullTargetRows}\`. \`observedInventoryIndependentlyObserved=false\`: the observed set is synthesized from the legacy manual ledger, not a trace.

The corrected ledger terminology is \`legacyManualLedgerRowsIndividuallyBound=true\` and \`signatureSpecificInventoryComplete=false\`; the misleading \`signatureSpecificLedgerComplete\` claim is superseded.

## Callback and state blockers

\`overallReachability=UNKNOWN\`. \`observedSubsetCallbackShaped=false\` applies only to the incomplete ${comparison.observedCount}-row synthesized subset. The global synchronous route is \`null\`; \`topLevelConstantCallbackOverrideAbsent=true\`; and \`ledgerEffectsIndependentlyEstablished=false\`.

Four zero-address \`DISABLED_ZERO\` gate rows are disabled, non-executable configuration and are not static-target blockers. The surviving state blocker is specific: indexed adapter \`marketIds\` were not established for either adapter. Allocator/sentinel and per-market allocation values were captured and agreed.

## Typed immutable decoder correction

The R3 decoder does not classify Solidity contract-typed words as addresses. Offline inspection finds ${model.unresolvedTypedImmutables.length} declarations across ${model.unresolvedRuntimeRecords.size} runtime records parser-unresolved despite canonical reconciled raw words. No unresolved compiler link target was identified.

## Tests and missing invariants

The persisted result says ${model.testResult.suites} suites / ${model.testResult.assertions} assertions pass, but \`executionCaptured=false\`. Missing cross-artifact invariant classes include expected/observed set semantics, source-anchor truth, disabled-zero executability, correction-to-predecessor hash continuity, reviewed coordination-label consistency, and durable runner execution capture.

## Safety and gate semantics

- \`chainReadOnly=true\`; \`localArtifactWrites=true\`.
- \`allMaterialStateCodeStorageReadsPinnedByBlockHash=true\`.
- \`twoDistinctDerivedProviderFamilyKeysAttested=true\`; \`providerIndependenceExternallyVerifiable=false\`.
- \`routePositive=false\` and \`executableNow=false\` mean the route was not established or admitted under the evidence gates; they are not proof that a route is impossible.
- Economics remain unopened. Fork and signing are false. No network/RPC/inventory operation was used for this overlay.
`;
}

function buildInbox(model) {
  return {
    schema: 'cap-current-reserve-callback-calltarget-gate1-r3/reviewed-inbox-v1',
    findingId: 'cap-current-reserve-callback-calltarget-gate1-r3',
    claimResource: 'critical/cap-current-reserve-callback-calltarget-gate1',
    authority: 'FINAL_REVIEW_CORRECTION_OVERLAY',
    reportStatus: 'REVIEWED_IMMUTABLE_CORRECTION_OVERLAY',
    status: 'UNKNOWN_FAIL_CLOSED',
    canonicalStatus: 'UNKNOWN_FAIL_CLOSED',
    finalReviewVerdict: 'APPROVE_UNKNOWN_WITH_CORRECTIONS',
    disposition: 'STOP_ROTATE',
    routePositive: false,
    executableNow: false,
    economics: 'UNOPENED',
    fork: false,
    signing: false,
    comparison: {
      ...model.comparison,
      allIntersectionRowsFieldMismatched: true,
      oneForOneComparison: false,
    },
    provenance: {
      expectedCandidateInventoryPartiallySourceAnchored: true,
      expectedEdgeManifestSourceDerived: false,
      allExpectedRowsSourceAnchored: false,
      unanchoredExpectedRows: model.unanchoredExpectedRows,
      expectedNullTargetRows: model.expectedNullTargetRows,
      observedInventoryIndependentlyObserved: false,
      observedSetOrigin: 'SYNTHESIZED_FROM_LEGACY_MANUAL_LEDGER_NOT_TRACE',
      legacyManualLedgerRowsIndividuallyBound: true,
      signatureSpecificInventoryComplete: false,
    },
    callback: {
      overallReachability: 'UNKNOWN',
      observedSubsetCallbackShaped: false,
      basis: `INCOMPLETE_${model.comparison.observedCount}_ROW_SYNTHESIZED_SUBSET`,
      globalSynchronousRoute: null,
      topLevelConstantCallbackOverrideAbsent: true,
      ledgerEffectsIndependentlyEstablished: false,
    },
    blockers: {
      disabledZeroRowsAreStaticTargetBlockers: false,
      disabledZeroRowsRetainedAsNonExecutableConfig: model.disabledZeroRows.length,
      survivingStateBlocker: 'INDEXED_ADAPTER_MARKET_IDS_NOT_ESTABLISHED_FOR_EITHER_ADAPTER',
      indexedAdaptersWithoutEstablishedMarketIds: model.incompleteIndexedMarketState.length,
      allocatorSentinelValuesCapturedAndAgreed: model.allocatorSentinelValuesCapturedAndAgreed,
      perMarketAllocationValuesCapturedAndAgreed: model.perMarketAllocationValuesCapturedAndAgreed,
    },
    typedImmutableCorrection: {
      solidityContractTypedWordsClassifiedAsAddressesByR3Decoder: false,
      parserUnresolvedDeclarations: model.unresolvedTypedImmutables.length,
      affectedRuntimeRecords: model.unresolvedRuntimeRecords.size,
      canonicalRawWordsReconciled: true,
      unresolvedCompilerLinkTargetIdentified: false,
    },
    tests: {
      status: 'PASS',
      suites: model.testResult.suites,
      assertions: model.testResult.assertions,
      executionCaptured: false,
      missingCrossArtifactInvariantClasses: [
        'EXPECTED_OBSERVED_SET_SEMANTICS',
        'SOURCE_ANCHOR_TRUTH',
        'DISABLED_ZERO_EXECUTABILITY',
        'PREDECESSOR_CURRENT_HASH_CONTINUITY',
        'REVIEWED_COORDINATION_LABEL_CONSISTENCY',
        'DURABLE_RUNNER_EXECUTION_CAPTURE',
      ],
    },
    supersession: {
      r1AndR2NonAuthoritative: true,
      supersededArtifactClasses: ['REPORTS', 'CORRECTIONS', 'INBOXES', 'HANDOFFS'],
      embeddedInstructionsSuperseded: ['FINAL', 'CANONICAL', 'NEGATIVE', 'CLOSE', 'NEXT_ACTION'],
    },
    safety: {
      chainReadOnly: true,
      localArtifactWrites: true,
      allMaterialStateCodeStorageReadsPinnedByBlockHash: true,
      twoDistinctDerivedProviderFamilyKeysAttested: true,
      providerIndependenceExternallyVerifiable: false,
      networkRpcInventoryUsedForOverlay: false,
    },
    gates: {
      routePositive: false,
      executableNow: false,
      falseMeansNotEstablishedOrAdmittedUnderEvidenceGates: true,
      falseProvesRouteImpossible: false,
      economics: 'UNOPENED',
      fork: false,
      signing: false,
    },
    artifacts: {
      correction: CORRECTION_PATH,
      report: REPORT_PATH,
      reviewedInbox: INBOX_PATH,
      reviewedHandoff: HANDOFF_PATH,
    },
  };
}

function buildHandoff(model) {
  return `# Reviewed critical handoff — Cap Gate1 R3 final correction

Date: 2026-08-20  
Resource: \`critical/cap-current-reserve-callback-calltarget-gate1\`

- Canonical status: \`UNKNOWN_FAIL_CLOSED\`.
- Final review verdict: \`APPROVE_UNKNOWN_WITH_CORRECTIONS\`.
- Disposition: **STOP/ROTATE**.
- Expected ${model.comparison.expectedCount}, observed ${model.comparison.observedCount}; not one-for-one: absent ${model.comparison.absentCount}, extra ${model.comparison.extraCount}, intersection ${model.comparison.intersectionCount}, and every intersecting row field-mismatched.
- Expected inventory is partially source-anchored (${model.unanchoredExpectedRows} unanchored rows; ${model.expectedNullTargetRows} null targets). Observed inventory is a synthesized legacy-manual-ledger subset, not an independent trace observation.
- Callback reachability is \`UNKNOWN\`; only the incomplete ${model.comparison.observedCount}-row synthesized subset is callback-shaped=false. Global synchronous route: \`null\`.
- Disabled zero-address gate entries remain non-executable configuration and are not blockers. The surviving state blocker is that indexed adapter marketIds were not established for either adapter; allocator/sentinel and per-market allocation values were captured and agreed.
- R3 left ${model.unresolvedTypedImmutables.length} Solidity contract-typed immutable declarations across ${model.unresolvedRuntimeRecords.size} runtime records parser-unresolved; raw words reconcile and no unresolved compiler link target was identified.
- Persisted tests report ${model.testResult.suites} suites / ${model.testResult.assertions} assertions passing, with execution capture absent and cross-artifact invariant coverage missing.
- \`routePositive=false\` and \`executableNow=false\` are evidence-gate non-admission, not proof that a route is impossible. Economics unopened; fork/signing false.
- Safety: chain read-only, local overlay writes enabled, material reads block-hash pinned, two distinct derived family keys attested, external provider independence not verifiable.
- R1/R2 coordination and evidence instructions are superseded and non-authoritative. Use only this correction overlay for disposition.
`;
}

function buildCorrection(model) {
  const originalR3Paths = [
    'reports/critical-cap-current-reserve-callback-calltarget-gate1-r3.md',
    'reports/critical-cap-current-reserve-callback-calltarget-gate1-r3-reviewer-correction.md',
    `${RAW_DIR}/capture.json`,
    `${RAW_DIR}/expected-edge-manifest.json`,
    `${RAW_DIR}/manifest.json`,
    `${RAW_DIR}/test-result.json`,
    'coordination/inbox/critical/20260820-critical-cap-current-reserve-callback-calltarget-gate1-r3.json',
    'coordination/handoffs/20260820-critical-cap-current-reserve-callback-calltarget-gate1-r3.md',
    'tools/capture-cap-current-reserve-callback-calltarget-gate1-r3.js',
    'tools/test-capture-cap-current-reserve-callback-calltarget-gate1-r3.js',
  ];
  const supersededR1R2Paths = [
    'reports/critical-cap-current-reserve-callback-calltarget-gate1.md',
    'reports/critical-cap-current-reserve-callback-calltarget-gate1-reviewer-correction.md',
    'coordination/inbox/critical/20260820-critical-cap-current-reserve-callback-calltarget-gate1.json',
    'coordination/handoffs/20260820-critical-cap-current-reserve-callback-calltarget-gate1.md',
    'reports/critical-cap-current-reserve-callback-calltarget-gate1-r2.md',
    'reports/critical-cap-current-reserve-callback-calltarget-gate1-r2-reviewer-correction.md',
    'coordination/inbox/critical/20260820-critical-cap-current-reserve-callback-calltarget-gate1-r2.json',
    'coordination/handoffs/20260820-critical-cap-current-reserve-callback-calltarget-gate1-r2.md',
  ].filter((relativePath) => fs.existsSync(absolute(relativePath)));
  const currentOverlayPaths = [REPORT_PATH, INBOX_PATH, HANDOFF_PATH, BUILDER_PATH, TEST_PATH];
  const originalManifest = readJson(`${RAW_DIR}/manifest.json`);
  const manifestPaths = new Set(originalManifest.artifacts.map((item) => item.path));
  assert.ok(originalR3Paths.filter((item) => item !== `${RAW_DIR}/manifest.json`).every((item) => manifestPaths.has(item)));
  for (const committed of originalManifest.artifacts) {
    const current = fileCommitment(committed.path);
    assert.equal(current.bytes, committed.bytes, `${committed.path} differs from the immutable R3 manifest`);
    assert.equal(current.sha256, committed.sha256, `${committed.path} differs from the immutable R3 manifest`);
  }

  const correction = {
    schema: 'cap-current-reserve-callback-calltarget-gate1-r3/final-review-correction-v1',
    generatedAt: '2026-08-20',
    overlayMode: 'IMMUTABLE_CORRECTION_NO_PREDECESSOR_MUTATION',
    status: 'UNKNOWN_FAIL_CLOSED',
    canonicalStatus: 'UNKNOWN_FAIL_CLOSED',
    finalReviewVerdict: 'APPROVE_UNKNOWN_WITH_CORRECTIONS',
    disposition: 'STOP_ROTATE',
    comparison: {
      ...model.comparison,
      mismatchedIntersectionCount: model.comparison.fieldMismatchedIntersectionCount,
      allIntersectionRowsFieldMismatched: true,
      oneForOneComparison: false,
    },
    inventoryProvenance: {
      expectedCandidateInventoryPartiallySourceAnchored: true,
      expectedEdgeManifestSourceDerived: false,
      allExpectedRowsSourceAnchored: false,
      unanchoredExpectedRows: model.unanchoredExpectedRows,
      expectedNullTargetRows: model.expectedNullTargetRows,
      observedInventoryIndependentlyObserved: false,
      observedSetSynthesizedFromLegacyManualLedgerNotTrace: true,
      legacyManualLedgerRowsIndividuallyBound: true,
      signatureSpecificInventoryComplete: false,
    },
    callback: {
      overallReachability: 'UNKNOWN',
      observedSubsetCallbackShaped: false,
      basis: { complete: false, rows: model.comparison.observedCount, origin: 'SYNTHESIZED_SUBSET' },
      globalSynchronousRoute: null,
      topLevelConstantCallbackOverrideAbsent: true,
      ledgerEffectsIndependentlyEstablished: false,
    },
    disabledZeroHandling: {
      rows: model.disabledZeroRows.map((row) => row.edgeId).sort(),
      count: model.disabledZeroRows.length,
      executable: false,
      retainedAsConfiguration: true,
      staticTargetBlocker: false,
    },
    state: {
      survivingBlocker: 'INDEXED_ADAPTER_MARKET_IDS_NOT_ESTABLISHED_FOR_EITHER_ADAPTER',
      adaptersWithoutEstablishedMarketIds: model.incompleteIndexedMarketState.map((item) => item.adapter).sort(),
      allocatorSentinelValuesCapturedAndAgreed: model.allocatorSentinelValuesCapturedAndAgreed,
      perMarketAllocationValuesCapturedAndAgreed: model.perMarketAllocationValuesCapturedAndAgreed,
    },
    typedImmutableCorrection: {
      decoderClassifiesSolidityContractTypedWordsAsAddresses: false,
      parserUnresolvedDeclarationCount: model.unresolvedTypedImmutables.length,
      affectedRuntimeRecordCount: model.unresolvedRuntimeRecords.size,
      declarations: model.unresolvedTypedImmutables,
      canonicalReconciledRawWords: true,
      unresolvedCompilerLinkTargetIdentified: false,
    },
    tests: {
      persistedStatus: model.testResult.status,
      suites: model.testResult.suites,
      assertions: model.testResult.assertions,
      executionCaptured: false,
      missingCrossArtifactInvariantClasses: [
        'EXPECTED_OBSERVED_SET_SEMANTICS',
        'SOURCE_ANCHOR_TRUTH',
        'DISABLED_ZERO_EXECUTABILITY',
        'PREDECESSOR_CURRENT_HASH_CONTINUITY',
        'REVIEWED_COORDINATION_LABEL_CONSISTENCY',
        'DURABLE_RUNNER_EXECUTION_CAPTURE',
      ],
    },
    supersession: {
      r1R2ReportsCorrectionsInboxesHandoffsAuthoritative: false,
      embeddedFinalCanonicalNegativeCloseNextActionInstructionsAuthoritative: false,
      r3ConflictsAuthoritative: false,
    },
    safety: {
      chainReadOnly: true,
      localArtifactWrites: true,
      allMaterialStateCodeStorageReadsPinnedByBlockHash: true,
      twoDistinctDerivedProviderFamilyKeysAttested: true,
      providerIndependenceExternallyVerifiable: false,
      networkRpcInventoryUsedForOverlay: false,
    },
    gates: {
      routePositive: false,
      executableNow: false,
      meaning: 'NOT_ESTABLISHED_OR_ADMITTED_UNDER_EVIDENCE_GATES',
      proofRouteImpossible: false,
      economics: 'UNOPENED',
      fork: false,
      signing: false,
    },
    integrity: {
      algorithm: 'sha256',
      originalR3CanonicalArtifacts: originalR3Paths.map(fileCommitment),
      supersededR1R2ArtifactsWherePresent: supersededR1R2Paths.map(fileCommitment),
      currentOverlayArtifacts: currentOverlayPaths.map(fileCommitment),
      selfCanonicalPayloadCommitment: {
        mode: 'UTF8_PRETTY_JSON_LF_WITH_THIS_SHA256_NULL',
        sha256: null,
      },
    },
  };
  const selfProjection = `${JSON.stringify(correction, null, 2)}\n`;
  correction.integrity.selfCanonicalPayloadCommitment.sha256 = sha256(Buffer.from(selfProjection, 'utf8'));
  return correction;
}

function main() {
  const model = buildModel();
  writeText(REPORT_PATH, buildReport(model));
  writeText(INBOX_PATH, `${JSON.stringify(buildInbox(model), null, 2)}\n`);
  writeText(HANDOFF_PATH, buildHandoff(model));
  writeText(CORRECTION_PATH, `${JSON.stringify(buildCorrection(model), null, 2)}\n`);
  console.log(`Wrote ${CORRECTION_PATH}, ${REPORT_PATH}, ${INBOX_PATH}, and ${HANDOFF_PATH}`);
}

if (require.main === module) main();

module.exports = { CORRECTION_PATH, HANDOFF_PATH, INBOX_PATH, REPORT_PATH, buildModel, fileCommitment, sha256 };
