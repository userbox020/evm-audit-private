"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const analyzer = require("./analyze-critical-symbiotic-vaultv2-named-deployment-step3.js");
const { minimumDonation, firstProfitableEqualDepositCount, offsetAndVirtualShares, residualRestart, sha256 } = analyzer._test;

function loadCapture() {
  const bytes = fs.readFileSync(analyzer.CAPTURE_PATH);
  return { bytes, capture: JSON.parse(bytes.toString("utf8")) };
}
function loadHistory() {
  const bytes = fs.readFileSync(analyzer.HISTORY_PATH);
  return { bytes, history: JSON.parse(bytes.toString("utf8")) };
}

test("Step1 BigInt formulas reproduce the V=1 candidate", () => {
  assert.equal(minimumDonation(1000n, 1n, 1n), 1999n);
  assert.equal(firstProfitableEqualDepositCount(1n, 1n), 3n);
});

test("6-decimal one-token example exposes the exact virtual-share barrier", () => {
  const model = offsetAndVirtualShares("6");
  assert.equal(model.offset, 12n);
  assert.equal(model.virtualShares, 1_000_000_000_000n);
  assert.equal(minimumDonation(1_000_000n, model.virtualShares, 1n), 1_999_999_999_999_999_999n);
  assert.equal(firstProfitableEqualDepositCount(model.virtualShares, 1n), 2_000_000_000_001n);
});

test("effective pending fees block the fee-free closed form", () => {
  const { capture } = loadCapture();
  const row = structuredClone(capture.enumeration.entities.find((candidate) => candidate.exactVaultV2));
  row.configuration.totalSupply = "1";
  row.configuration.pendingFeeShares = "1";
  row.configuration.getAccrueInterest.managementFeeShares = "1";
  const analyzed = analyzer.analyzeCandidate(row);
  assert.equal(analyzed.accrueInterest.effectivePendingFeeShares, true);
  assert.equal(analyzed.feeFreeStep1ClosedFormPermitted, false);
  assert.match(analyzed.feeFormulaCaveat, /forbidden/);
});

test("nonzero incumbents block sole-attacker economics", () => {
  const { capture } = loadCapture();
  const row = structuredClone(capture.enumeration.entities.find((candidate) => candidate.exactVaultV2));
  row.configuration.totalSupply = "100";
  row.configuration.totalAssets = "100";
  row.configuration.getAccrueInterest.newTotalAssets = "100";
  const analyzed = analyzer.analyzeCandidate(row);
  assert.equal(analyzed.conservativeStateClass, "NONZERO_INCUMBENT_SUPPLY");
  assert.equal(analyzed.feeFreeStep1ClosedFormPermitted, false);
  assert.match(analyzed.incumbentFormulaCaveat, /forbidden/);
});

test("residual restart uses residual+1 only for V=1", () => {
  const v1 = residualRestart(2500n, 1n);
  assert.equal(v1.minimumDepositForOneShareRaw, "2501");
  assert.equal(v1.residualPlusOneShortcutApplicable, true);
  const vLarge = residualRestart(1_000_000n, 1_000_000_000_000n);
  assert.equal(vLarge.minimumDepositForOneShareRaw, "1");
  assert.equal(vLarge.residualPlusOneShortcutApplicable, false);
  assert.equal(vLarge.residualPlusOneRaw, null);
});

test("malformed capture and candidate count changes fail closed", () => {
  const { capture } = loadCapture();
  const wrongSchema = structuredClone(capture);
  wrongSchema.schema = "wrong";
  assert.throws(() => analyzer.analyzeCapture(wrongSchema), /CAPTURE_IDENTITY_MISMATCH/);
  const wrongCount = structuredClone(capture);
  wrongCount.classification.exactVaultV2Entities = 22;
  assert.throws(() => analyzer.analyzeCapture(wrongCount), /CLASSIFICATION_COUNT_MISMATCH/);
  const missingCandidate = structuredClone(capture);
  missingCandidate.enumeration.entities.find((row) => row.exactVaultV2).exactVaultV2 = false;
  assert.throws(() => analyzer.analyzeCapture(missingCandidate), /CANDIDATE_COUNT_MISMATCH/);
});

test("analysis and report rendering are deterministic and route-conservative", () => {
  const { bytes, capture } = loadCapture();
  const { bytes: historyBytes, history } = loadHistory();
  assert.equal(sha256(bytes), analyzer.CAPTURE_SHA256);
  assert.equal(sha256(historyBytes), analyzer.HISTORY_SHA256);
  const first = analyzer.analyzeCapture(capture, { historyArtifact: history,
    historySha256: analyzer.HISTORY_SHA256 });
  const second = analyzer.analyzeCapture(structuredClone(capture), {
    historyArtifact: structuredClone(history), historySha256: analyzer.HISTORY_SHA256
  });
  assert.deepEqual(first, second);
  assert.equal(analyzer.renderMarkdown(first), analyzer.renderMarkdown(second));
  assert.equal(first.counts.exactCandidates, 23);
  assert.equal(first.counts.permissionlessDepositAdvertised, 19);
  assert.equal(first.counts.routePositiveEstablished, 0);
  assert.equal(first.counts.economicsUnknownPermissionlessCandidates, 19);
  assert.equal(first.counts.permissionlessBlockedAtPin, 4);
  assert.equal(first.counts.historyCaptureEligible, 0);
  assert.equal(first.counts.historyEvidence.onlyInitializationDepositObserved, 2);
  assert.equal(first.counts.historyEvidence.promotedFurtherEconomicsWork, 0);
  assert.equal(first.recommendation.decision, "CLOSE/ROTATE AS TRIAGE DEPRIORITIZATION");
  assert.ok(first.candidates.every((row) => row.routePositive === "unknown"
    && row.routePositiveEstablished === false && row.promotionPassed === false));
  assert.ok(first.candidates.every((row) => row.assetSemantics.requiredForFormula
    === "STANDARD_EXACT_TRANSFER_NONREBASING_ASSET_REQUIRED"));
});

test("history artifact mutation and incomplete coverage fail closed", () => {
  const { bytes, history } = loadHistory();
  assert.throws(() => analyzer.validateHistoryArtifact(history, sha256(Buffer.concat([bytes, Buffer.from(" ")]))),
    /HISTORY_HASH_MISMATCH/);
  const incomplete = structuredClone(history);
  incomplete.candidates[0].logCoverage.adaptiveRangeStats.byTopic.Deposit.noSkippedRange = false;
  assert.throws(() => analyzer.validateHistoryArtifact(incomplete), /HISTORY_CANDIDATE_GATE_MISMATCH/);
  const wrongPin = structuredClone(history);
  wrongPin.sourceCapture.fixedBlock.hash = `0x${"00".repeat(32)}`;
  assert.throws(() => analyzer.validateHistoryArtifact(wrongPin), /HISTORY_GATE_MISMATCH/);
});

test("exact bounded history derives initialization-only closeout", () => {
  const { history } = loadHistory();
  const validated = analyzer.validateHistoryArtifact(history);
  assert.equal(validated.counts.candidates, 2);
  assert.equal(validated.counts.onlyInitializationDepositObserved, 2);
  assert.equal(validated.counts.zeroShareDepositObserved, 0);
  assert.equal(validated.counts.laterDepositAfterInitializationObserved, 0);
  assert.equal(validated.counts.transferAfterInitialMintObserved, 0);
  assert.equal(validated.counts.postPositiveZeroSupplyWindowObserved, 0);
  assert.equal(validated.counts.splitRunObserved, 0);
  for (const evidence of Object.values(validated.byAddress)) {
    assert.equal(evidence.classification, "ONLY_INITIALIZATION_DEPOSIT_OBSERVED");
    assert.equal(evidence.sameCallerOwnerIsSoleHolder, true);
    assert.equal(evidence.soleHolderConcentrationBps, "10000");
    assert.equal(evidence.establishedExternalVictimFlow, false);
    assert.equal(evidence.holderAcquirability, "unknown");
    assert.equal(evidence.futureVictimFlow, "unknown");
    assert.equal(evidence.routePositive, "unknown");
    assert.equal(evidence.promotionPassed, false);
  }
});

test("hypothetical zero-share or later deposit promotes only further economics", () => {
  const { history } = loadHistory();
  const zeroShare = structuredClone(history.candidates[0]);
  zeroShare.events.deposits[0].shares = "0";
  const zeroEvidence = analyzer.deriveHistoryCandidateEvidence(zeroShare);
  assert.equal(zeroEvidence.zeroShareDepositObserved, true);
  assert.equal(zeroEvidence.promotesFurtherEconomicsWork, true);
  assert.equal(zeroEvidence.routePositive, "unknown");
  assert.equal(zeroEvidence.promotionPassed, false);

  const later = structuredClone(history.candidates[0]);
  const second = structuredClone(later.events.deposits[0]);
  second.blockNumber = (BigInt(second.blockNumber) + 1n).toString();
  second.logIndex = (BigInt(second.logIndex) + 1n).toString();
  second.transactionHash = `0x${"ef".repeat(32)}`;
  later.events.deposits.push(second);
  const laterEvidence = analyzer.deriveHistoryCandidateEvidence(later);
  assert.equal(laterEvidence.laterDepositAfterInitializationObserved, true);
  assert.equal(laterEvidence.promotesFurtherEconomicsWork, true);
  assert.equal(laterEvidence.establishedExternalVictimFlow, false);
  assert.equal(laterEvidence.routePositive, "unknown");
});
