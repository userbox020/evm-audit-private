#!/usr/bin/env node
'use strict';

const assert = require('assert');
const gate = require('./analyze-critical-derive-v2-settlement-order-materiality-envelope-gate0-step3.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok ${passed} - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

const U = gate.UNIT;
const Q = gate.CASH_QUANTUM;
const artifact = gate.buildArtifact();
const favorable = { b: 400_000n * U, S: 400_000n * U, B: 400_000n * U, params: gate.PARAMS.intended };
const threshold = 1_000n * U;

test('REPORT-SCHEMA v2 identity and revision are canonical', () => {
  assert.strictEqual(artifact.schemaVersion, 2);
  assert.strictEqual(artifact.claimId, gate.CLAIM_ID);
  assert.strictEqual(artifact.claimRevision, 4);
  assert.deepStrictEqual(artifact.supersedes, []);
});

test('published axes are canonical', () => {
  assert.deepStrictEqual(
    [artifact.reportStatus, artifact.axes.evidenceStage, artifact.axes.validityOutcome, artifact.axes.noveltyOutcome, artifact.axes.deploymentDisposition, artifact.axes.accessDisposition, artifact.axes.routeDisposition, artifact.axes.signal],
    ['PUBLISHED', 'SOURCE-CONFIRMED', 'VALID', 'UNKNOWN', 'UNBOUND', 'NOT-REQUESTED', 'UNKNOWN', 'final'],
  );
});

test('exact target commit and tree are pinned', () => {
  assert.strictEqual(artifact.authority.commit, gate.EXACT_COMMIT);
  assert.strictEqual(artifact.authority.tree, gate.EXACT_TREE);
});

test('six authority roots are hash-bound', () => {
  assert.strictEqual(artifact.authority.inputs.length, 6);
  assert(artifact.authority.inputs.every((x) => /^[0-9a-f]{64}$/.test(x.sha256) && x.bytes > 0));
});

test('FixedPointMathLib is an exact authority input', () => {
  const row = artifact.authority.inputs.find((x) => x.role === 'fixedPointMathLib');
  assert(row);
  assert.strictEqual(row.sha256, '3c1bc3f088c0e5f1cd1a75c0ac18d7c96d18500f11cae8fc3067885c712836e8');
});

test('exact exp coefficient reproduces known EVM vector', () => {
  assert.strictEqual(gate.interestFactor(7n * gate.DAY, 160_000_000_000_000_000n), 3_073_205_794_798_734n);
});

test('intended rates at 50, 80 and 100 percent utilization are exact', () => {
  assert.strictEqual(gate.borrowRate(10_000n, 5_000n, gate.PARAMS.intended), 60_000_000_000_000_000n);
  assert.strictEqual(gate.borrowRate(10_000n, 8_000n, gate.PARAMS.intended), 84_000_000_000_000_000n);
  assert.strictEqual(gate.borrowRate(10_000n, 20_000n, gate.PARAMS.intended), 223_000_000_000_000_000n);
});

test('utilization is capped and zero-safe', () => {
  assert.strictEqual(gate.utilization(1n, 2n), U);
  assert.strictEqual(gate.utilization(0n, 2n), 0n);
  assert.strictEqual(gate.utilization(2n, 0n), 0n);
});

test('ceilDiv cash quantum is exact', () => {
  assert.strictEqual(gate.ceilDiv(0n, Q), 0n);
  assert.strictEqual(gate.ceilDiv(Q, Q), 1n);
  assert.strictEqual(gate.ceilDiv(Q + 1n, Q), 2n);
});

test('Step1 liability reduction is exact', () => {
  assert.strictEqual(artifact.step1Reproduction.liabilityReduction, '125457288093656000');
  assert.strictEqual(artifact.step1Reproduction.baselineFactor, '712590783931847');
  assert.strictEqual(artifact.step1Reproduction.attackedFactor, '696908622920140');
});

test('Step1 external six-decimal wallet delta is exact', () => {
  assert.strictEqual(artifact.step1Reproduction.externalWalletGain, '125458000000000000');
  assert.strictEqual(artifact.step1Reproduction.baselineExternalRepayment, '8005700727000000000000');
  assert.strictEqual(artifact.step1Reproduction.attackedExternalRepayment, '8005575269000000000000');
});

test('Step1 internal cash dust is separated and exact', () => {
  assert.strictEqual(artifact.step1Reproduction.baselineInternalCashDust, '728545224000');
  assert.strictEqual(artifact.step1Reproduction.attackedInternalCashDust, '16638880000');
  assert.strictEqual(artifact.step1Reproduction.internalCashDustDeltaAttackedMinusBaseline, '-711906344000');
});

test('external wallet plus dust equals exact total controlled wealth', () => {
  const x = artifact.step1Reproduction;
  assert.strictEqual(BigInt(x.externalWalletGain) + BigInt(x.internalCashDustDeltaAttackedMinusBaseline), BigInt(x.liabilityReduction));
  assert.strictEqual(x.totalControlledWealthGain, x.liabilityReduction);
});

test('six-decimal rounding deviation is below one raw unit', () => {
  const x = artifact.step1Reproduction;
  const deviation = BigInt(x.externalWalletGain) - BigInt(x.liabilityReduction);
  assert(deviation >= -(Q - 1n) && deviation <= Q - 1n);
});

test('zero N has zero liability and wallet gain', () => {
  const row = gate.settlementDelta({ b: 8_000n * U, S: 10_000n * U, B: 8_000n * U, N: 0n, t: 86_401n, params: gate.PARAMS.step1Fixture });
  assert.strictEqual(row.liabilityReduction, 0n);
  assert.strictEqual(row.externalWalletGain, 0n);
});

test('attacked rate never drops below min rate', () => {
  for (const N of [0n, 1n, U, 1_000n * U, 10n ** 40n]) {
    const row = gate.settlementDelta({ b: 8_000n * U, S: 10_000n * U, B: 8_000n * U, N, t: gate.DAY, params: gate.PARAMS.intended });
    assert(row.attackedRate >= gate.PARAMS.intended.minRate);
  }
});

test('liability gain is monotonic nondecreasing in N', () => {
  const gains = [0n, U, 100n * U, 1_000n * U, 10_000n * U, 1_000_000n * U].map((N) => gate.settlementDelta({ b: 8_000n * U, S: 10_000n * U, B: 8_000n * U, N, t: gate.DAY, params: gate.PARAMS.intended }).liabilityReduction);
  for (let i = 1; i < gains.length; i++) assert(gains[i] >= gains[i - 1]);
});

test('every finite N sample is below infinity envelope', () => {
  const upper = BigInt(artifact.monotonicEnvelope.infinity.liabilityReductionUpperBound);
  assert(artifact.monotonicEnvelope.rows.every((x) => BigInt(x.liabilityReduction) <= upper));
});

test('gain is monotonic in actor debt b', () => {
  const input = { S: 400_000n * U, B: 400_000n * U, N: 1_000_000n * U, t: gate.DAY, params: gate.PARAMS.intended };
  const gains = [100_000n, 200_000n, 400_000n].map((b) => gate.settlementDelta({ ...input, b: b * U }).liabilityReduction);
  assert(gains[0] <= gains[1] && gains[1] <= gains[2]);
  assert.strictEqual(artifact.universalDomainProof.gainMonotoneInActorDebt.proved, true);
});

test('borrow rate is monotonic in utilization', () => {
  const rates = [0n, 200_000n, 340_000n, 400_000n, 800_000n].map((B) => gate.borrowRate(400_000n, B, gate.PARAMS.intended));
  for (let i = 1; i < rates.length; i++) assert(rates[i] >= rates[i - 1]);
  assert.strictEqual(artifact.universalDomainProof.rateMonotoneInUtilization.proved, true);
});

test('util cap makes every B at or above S share maximum baseline rate', () => {
  for (const B of [400_000n, 500_000n, 1_000_000n]) assert.strictEqual(gate.borrowRate(400_000n, B, gate.PARAMS.intended), 223_000_000_000_000_000n);
  assert.strictEqual(artifact.universalDomainProof.utilizationCap.proved, true);
});

test('B=b and S=B is a representative capped-util state', () => {
  assert.strictEqual(gate.utilization(400_000n * U, 400_000n * U), U);
  assert.match(artifact.universalDomainProof.utilizationCap.reason, /representative/);
});

test('N infinity minimizes attack rate to minRate', () => {
  assert.strictEqual(artifact.universalDomainProof.lossEnvelope.proved, true);
  assert.strictEqual(artifact.materialityDomain.primaryRows[1].attackedRate, artifact.parameters.intended.minRate);
});

test('materiality threshold pivots at one million capital', () => {
  assert.strictEqual(gate.materialityThreshold(20_000n * U), 1_000n * U);
  assert.strictEqual(gate.materialityThreshold(1_000_000n * U), 1_000n * U);
  assert.strictEqual(gate.materialityThreshold(2_000_000n * U), 2_000n * U);
});

test('capital below pivot is maximized at pivot and below $1000', () => {
  const proof = artifact.universalDomainProof.capitalAtOrBelowPivot;
  assert.strictEqual(proof.proved, true);
  assert(BigInt(proof.pivotRoundingUpperBound) < 1_000n * U);
});

test('capital above pivot has constant 2.225398bps gain ratio', () => {
  const proof = artifact.universalDomainProof.capitalAtOrAbovePivot;
  assert.strictEqual(proof.liabilityGainBps18, '2225398222881584000');
  assert(BigInt(proof.liabilityGainBps18) < BigInt(proof.thresholdBps18));
  const pivot = artifact.materialityDomain.primaryRows[1];
  const ceiling = artifact.materialityDomain.primaryRows[2];
  assert.strictEqual(BigInt(pivot.liabilityReductionUpperBound) * BigInt(ceiling.capital), BigInt(ceiling.liabilityReductionUpperBound) * BigInt(pivot.capital));
});

test('intended primary one-day domain is nonpositive even with free N', () => {
  const intended = artifact.materialityDomain.primaryRows.filter((x) => x.name.startsWith('intended'));
  assert(intended.every((x) => x.roundingConservativePassesStrictly === false));
  assert.strictEqual(artifact.boundedAssessments.boundedOneDayEconomics.status, 'PASS');
  assert.strictEqual(artifact.boundedAssessments.boundedOneDayEconomics.result, 'nonpositive');
});

test('constructor maxima sensitivity remains separate and can pass', () => {
  const maxima = artifact.materialityDomain.primaryRows.filter((x) => x.name.startsWith('constructor-maxima'));
  assert(maxima.some((x) => x.liabilityPassesStrictly));
  assert.match(artifact.parameters.warning, /not intended or deployed/);
});

test('intended and maxima one-day upper bounds are exact', () => {
  assert.strictEqual(artifact.materialityDomain.primaryRows[1].liabilityReductionUpperBound, '222539822288158400000');
  assert.strictEqual(artifact.materialityDomain.primaryRows[4].liabilityReductionUpperBound, '5547468468648023200000');
});

test('liability time crossings are exact first strict seconds', () => {
  for (const [input, t] of [[favorable, 387_795n], [{ ...favorable, params: gate.PARAMS.constructorMaxima }, 15_733n]]) {
    assert(gate.infiniteLossBound({ ...input, t }).liabilityReductionUpperBound > threshold);
    assert(gate.infiniteLossBound({ ...input, t: t - 1n }).liabilityReductionUpperBound <= threshold);
  }
});

test('external wallet time crossings are exact first strict seconds', () => {
  for (const [input, t] of [[favorable, 387_795n], [{ ...favorable, params: gate.PARAMS.constructorMaxima }, 15_733n]]) {
    assert(gate.infiniteLossBound({ ...input, t }).externalWalletGainExact > threshold);
    assert(gate.infiniteLossBound({ ...input, t: t - 1n }).externalWalletGainExact <= threshold);
  }
});

test('five-day liability N crossing is exact', () => {
  const N = BigInt(artifact.crossings.intendedFiveDay.liabilityFirstLossN);
  const input = { ...favorable, t: 5n * gate.DAY };
  assert.strictEqual(N, 1_136_279_991_480_119_097_126_870n);
  assert(gate.settlementDelta({ ...input, N }).liabilityReduction > threshold);
  assert(gate.settlementDelta({ ...input, N: N - 1n }).liabilityReduction <= threshold);
});

test('five-day external wallet N crossing is exact', () => {
  const N = BigInt(artifact.crossings.intendedFiveDay.externalWalletFirstLossN);
  const input = { ...favorable, t: 5n * gate.DAY };
  assert.strictEqual(N, 1_136_279_991_837_322_249_500_164n);
  assert(gate.settlementDelta({ ...input, N }).externalWalletGain > threshold);
  assert(gate.settlementDelta({ ...input, N: N - 1n }).externalWalletGain <= threshold);
});

test('actorOwnsLosingSideOnly charges N and is nonpositive', () => {
  const row = artifact.lifecycle.pnlFundingRequirement.actorOwnsLosingSideOnly;
  assert(BigInt(row.netBeforeOtherCosts) < 0n);
  assert.strictEqual(row.result, 'nonpositive');
});

test('coalitionBothSides does not automatically charge N', () => {
  const row = artifact.lifecycle.pnlFundingRequirement.coalitionBothSides;
  assert.strictEqual(row.NAutomaticallyCharged, false);
  assert.strictEqual(row.disposition, 'UNKNOWN');
  assert.strictEqual(row.result, 'inconclusive');
  assert.deepStrictEqual(row.unresolved, ['fees', 'margin', 'funding', 'market exposure', 'opportunity cost', 'position unwind']);
});

test('third-party distinct-borrower witness remains retained', () => {
  assert.strictEqual(artifact.lifecycle.pnlFundingRequirement.actorFundedRequiredBySource, false);
  assert.match(artifact.lifecycle.pnlFundingRequirement.witness, /distinct from both Perp counterparties/);
});

test('zero-cost and global economics remain separate', () => {
  assert.strictEqual(artifact.economics.optimisticUpperBound.costs, 0);
  assert.strictEqual(artifact.economics.conservative.net, null);
  assert.strictEqual(artifact.evidence.economics.status, 'UNKNOWN');
  assert.strictEqual(artifact.evidence.economics.result, 'inconclusive');
});

test('evidence taxonomy uses canonical status and result pairs', () => {
  assert.deepStrictEqual(Object.keys(artifact.evidence), ['sourceExact', 'buildVerified', 'localSemantic', 'deploymentProvenance', 'runtimeAttested', 'reachability', 'economics', 'reproducibility', 'review']);
  assert.deepStrictEqual([artifact.evidence.sourceExact.status, artifact.evidence.sourceExact.result], ['PASS', 'n/a']);
  assert.deepStrictEqual([artifact.evidence.buildVerified.status, artifact.evidence.buildVerified.result], ['BLOCKED', 'inconclusive']);
  assert.deepStrictEqual([artifact.evidence.localSemantic.status, artifact.evidence.localSemantic.result], ['PASS', 'supports']);
  assert.deepStrictEqual([artifact.evidence.reproducibility.status, artifact.evidence.reproducibility.result], ['PASS', 'n/a']);
  for (const key of ['deploymentProvenance', 'runtimeAttested']) assert.deepStrictEqual([artifact.evidence[key].status, artifact.evidence[key].result], ['UNKNOWN', 'n/a']);
  assert.deepStrictEqual([artifact.evidence.review.status, artifact.evidence.review.result], ['PASS', 'n/a']);
  assert.strictEqual(artifact.evidence.review.assessor, 'oracle-derive-v2-materiality-gate0-step3-20260808');
  assert.match(artifact.evidence.review.rationale, /revision 3/i);
  for (const key of ['reachability', 'economics']) assert.deepStrictEqual([artifact.evidence[key].status, artifact.evidence[key].result], ['UNKNOWN', 'inconclusive']);
  assert(Object.values(artifact.evidence).every((x) => Array.isArray(x.assumptions) && x.assessor && x.assessedAt && Array.isArray(x.artifacts) && typeof x.rationale === 'string'));
});

test('impactPath records supported loss paths not attacker gain', () => {
  assert(artifact.gates.impactPath.every((x) => ['victim-loss', 'protocol-loss'].includes(x.type) && x.supported === 'true'));
  assert(artifact.gates.impactPath.every((x) => typeof x.invariant === 'string' && Array.isArray(x.evidence)));
  assert(!artifact.gates.impactPath.some((x) => /gain/.test(x.type)));
});

test('stale chain-957 JSON is context only', () => {
  assert(artifact.deploymentContext.chain957JsonFilesPresent > 0);
  assert.strictEqual(artifact.deploymentContext.currentDeploymentEvidence, false);
});

test('bounded duplicate screen finds no independent duplicate', () => {
  assert.strictEqual(artifact.duplicateScreen.predecessorMatch, true);
  assert.deepStrictEqual(artifact.duplicateScreen.independentDuplicateMatches, []);
});

test('classification is scoped close-rotate profit prioritization', () => {
  assert.match(artifact.classification, /^CLOSE_ROTATE\//);
  assert.match(artifact.classificationScope, /not route-negative and not protocol-wide/);
  assert.strictEqual(artifact.nextAction, 'CLOSE_ROTATE');
});

test('route execution signing and fork remain fail-closed', () => {
  assert.strictEqual(artifact.gates.routePositive, 'unknown');
  assert.strictEqual(artifact.gates.executableNow, 'unknown');
  assert.strictEqual(artifact.gates.signedActionJustified, false);
  assert.deepStrictEqual(artifact.gates.fork, { justified: false, chainId: null, blockNumber: null, blockHash: null, stateRoot: null, finality: null, snapshotHash: null, syntheticChanges: [], signedAction: false });
});

test('severity uses the full canonical structure', () => {
  assert.deepStrictEqual(Object.keys(artifact.severity), ['rating', 'framework', 'confidence', 'maxCredibleSupportedImpact', 'attackerGain', 'attackerCost', 'victimLoss', 'protocolLoss', 'operationalImpact', 'uncertainty', 'rationale']);
  assert.strictEqual(artifact.severity.rating, 'LOW');
  assert.strictEqual(artifact.severity.confidence, 'LOW');
  assert(Array.isArray(artifact.severity.uncertainty));
});

test('offline safety flags remain false', () => {
  for (const key of ['networkAttempted', 'rpcAttempted', 'protectedFilesRead', 'signingAttempted', 'transactionAttempted']) assert.strictEqual(artifact[key], false, key);
});

test('validator rejects nonpublished variants after Oracle approval', () => {
  const nonpublished = clone(artifact);
  nonpublished.reportStatus = 'DRAFT';
  assert.throws(() => gate.validateArtifact(nonpublished), /published schema/);
  const inconsistentSignal = clone(artifact);
  inconsistentSignal.axes.signal = 'draft';
  assert.throws(() => gate.validateArtifact(inconsistentSignal), /published schema/);
  const inconsistentReview = clone(artifact);
  inconsistentReview.evidence.review.status = 'UNKNOWN';
  assert.throws(() => gate.validateArtifact(inconsistentReview), /published review taxonomy/);
});

test('validator rejects route promotion', () => {
  const mutated = clone(artifact);
  mutated.gates.routePositive = 'true';
  assert.throws(() => gate.validateArtifact(mutated), /canonical safety gates/);
});

test('validator rejects coalition N auto-charge', () => {
  const mutated = clone(artifact);
  mutated.lifecycle.pnlFundingRequirement.coalitionBothSides.NAutomaticallyCharged = true;
  assert.throws(() => gate.validateArtifact(mutated), /coalition qualification/);
});

test('validator accepts generated artifact', () => {
  assert.strictEqual(gate.validateArtifact(artifact), true);
});

if (!process.exitCode) process.stdout.write(`# ${passed} tests passed\n`);
