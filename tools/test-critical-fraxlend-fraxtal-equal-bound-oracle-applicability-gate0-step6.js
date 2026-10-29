#!/usr/bin/env node
'use strict';

const assert = require('assert');
const gate = require('./analyze-critical-fraxlend-fraxtal-equal-bound-oracle-applicability-gate0-step6.js');

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

const artifact = gate.buildArtifact(gate.ROOT);

test('exact Fraxlend source commit and tree', () => {
  assert.strictEqual(artifact.authority.source.commit, gate.EXACT_COMMIT);
  assert.strictEqual(artifact.authority.source.tree, gate.EXACT_TREE);
});

test('all six authority inputs are hash-bound', () => {
  assert.strictEqual(artifact.authority.inputs.length, 6);
  assert(artifact.authority.inputs.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)));
});

test('generic source hash and exact semantic lines are retained', () => {
  assert.strictEqual(artifact.authority.genericSourceSemantics.sha256, gate.INPUTS.genericSource.sha256);
  assert.deepStrictEqual(artifact.authority.genericSourceSemantics.badDataEqualBoundLines, [143, 156, 157, 158]);
});

test('retained scanner latest-tag and null-conflation limitations are explicit', () => {
  assert.strictEqual(artifact.scope.scannerCallTag, 'latest');
  assert.match(artifact.authority.retainedScannerSemantics.path, /scan-fraxlend-live\.js$/);
  assert.match(artifact.limitations.join(' '), /Null selector observations conflate/);
});

test('Fraxtal inventory is exactly seventeen rows', () => {
  assert.strictEqual(artifact.inventory.rows, 17);
  assert.strictEqual(artifact.inventory.discoveredPairs, 17);
  assert.strictEqual(artifact.rows.length, 17);
});

test('Pair set exactly equals deployer and registry sets', () => {
  assert.strictEqual(artifact.inventory.pairSetEqualsDeployerSet, true);
  assert.strictEqual(artifact.inventory.pairSetEqualsRegistrySet, true);
  assert.strictEqual(new Set(artifact.inventory.exactAddressOrder).size, 17);
});

test('every Pair exchange-rate oracle binds its inspected oracle row', () => {
  assert(artifact.rows.every((x) => /^0x[0-9a-f]{40}$/.test(x.pair) && /^0x[0-9a-f]{40}$/.test(x.oracle)));
});

test('generic fingerprint has eight fail-closed observations', () => {
  assert.deepStrictEqual(artifact.genericApplicabilityGate.requiredObservations, [...gate.GENERIC_REQUIRED_OBSERVATIONS]);
  assert.strictEqual(gate.GENERIC_REQUIRED_OBSERVATIONS.length, 8);
});

test('no retained row has a complete generic fingerprint', () => {
  assert(artifact.rows.every((x) => x.fingerprint.complete === false));
});

test('null ABI probes never become wrong-type proof', () => {
  const healthy = artifact.rows.find((x) => x.classification === 'UNKNOWN');
  const mutated = clone(healthy);
  mutated.getPrices = { isBadData: false, priceLow: '1', priceHigh: '1' };
  const pseudoPair = {
    address: mutated.pair,
    pairName: mutated.pairName,
    market: mutated.listedMarket,
    appVersion: 3,
    isSunset: false,
    asset: mutated.asset,
    collateral: mutated.collateral,
    oracleLabel: mutated.oracleLabel,
    oracle: {
      address: mutated.oracle,
      codeBytes: mutated.oracleCodeBytes,
      name: mutated.oracleName,
      decimals: 18,
      oracleType: null,
      maxOracleDelay: null,
      getPrices: mutated.getPrices,
      exposed: {},
    },
    exchangeRateInfo: { oracle: mutated.oracle },
    derived: { availableAssetAccounting: '1' },
    assetToken: { symbol: 'X', decimals: 18, holderBalance: '1' },
    controls: {},
    borrowLimit: '1',
  };
  assert.strictEqual(gate.classifyPair(pseudoPair).classification, 'UNKNOWN');
});

test('healthy equal bounds alone never prove generic applicability', () => {
  const equalHealthy = artifact.rows.filter((x) => x.getPrices?.isBadData === false && x.getPrices.priceLow === x.getPrices.priceHigh);
  assert(equalHealthy.length > 0);
  assert(equalHealthy.every((x) => x.classification !== 'EXACT_GENERIC_EQUAL_BOUND'));
});

test('bad-data unequal bounds exactly contradict generic source semantics', () => {
  const row = artifact.rows.find((x) => x.pair === gate.BAD_DATA_CONTRADICTION_PAIR);
  assert(row);
  assert.strictEqual(row.oracle, gate.BAD_DATA_CONTRADICTION_ORACLE);
  assert.strictEqual(row.getPrices.isBadData, true);
  assert.notStrictEqual(row.getPrices.priceLow, row.getPrices.priceHigh);
  assert.strictEqual(row.badDataEqualBoundContradiction, true);
  assert.strictEqual(row.classification, 'WRONG_TYPE');
});

test('bad-data equal-bound mutation removes exact contradiction', () => {
  const prices = { isBadData: true, priceLow: '123', priceHigh: '123' };
  assert.strictEqual(gate.hasBadDataEqualBoundContradiction({ getPrices: prices }), false);
});

test('healthy unequal bounds do not contradict generic source', () => {
  const prices = { isBadData: false, priceLow: '123', priceHigh: '124' };
  assert.strictEqual(gate.hasBadDataEqualBoundContradiction({ getPrices: prices }), false);
});

test('classification counts are one wrong type and sixteen unknown', () => {
  assert.deepStrictEqual(artifact.genericApplicabilityGate.classificationCounts, { UNKNOWN: 16, WRONG_TYPE: 1 });
});

test('no exact generic retained row is promoted', () => {
  assert.strictEqual(artifact.genericApplicabilityGate.classificationCounts.EXACT_GENERIC_EQUAL_BOUND || 0, 0);
});

test('five rows have exactly zero historical Pair cash', () => {
  assert.strictEqual(artifact.economicsGate.historicalZeroCashRows, 5);
  assert.strictEqual(artifact.rows.filter((x) => x.materiality.historicalZeroCash).length, 5);
});

test('known bad-data inverse row retains exact raw and display cash only', () => {
  const row = artifact.rows.find((x) => x.pair === gate.BAD_DATA_CONTRADICTION_PAIR);
  assert.strictEqual(row.materiality.availableAssetRaw, '52951616752517336');
  assert.strictEqual(row.materiality.availableAssetDisplay, '0.052951616752517336');
  assert.strictEqual(row.materiality.assetSymbol, 'sfrxETH');
  assert.strictEqual(row.materiality.cashToPoolFairTvlRatio, null);
});

test('no USD price pool ratio or exit is invented', () => {
  assert.strictEqual(artifact.economicsGate.exactComparableUsdValuationRows, 0);
  assert.strictEqual(artifact.economicsGate.retainedCashToPoolRatioRows, 0);
  assert.strictEqual(artifact.economicsGate.retainedExitEvidenceRows, 0);
  assert(artifact.rows.every((x) => x.materiality.cashToPoolFairTvlRatio === null && x.materiality.exitLiquidityRetained === false));
});

test('ratio ten positive and ratio one negative source witnesses remain separate', () => {
  assert(BigInt(artifact.economicsGate.sourceLocalRatio10CoalitionNetRaw18) > 0n);
  assert(BigInt(artifact.economicsGate.sourceLocalRatio1CoalitionNetRaw18) < 0n);
  assert.strictEqual(artifact.economicsGate.currentEconomicsAssessed, false);
});

function exactMaterialCandidate() {
  return {
    classification: 'EXACT_GENERIC_EQUAL_BOUND',
    fingerprint: { complete: true },
    runtimeBinding: { disposition: 'EXACT', immutableValuesExact: true },
    materiality: {
      poolRuntimeRetained: true,
      poolLiquidityRetained: true,
      poolTickDistributionRetained: true,
      exitLiquidityRetained: true,
      conservativeNetEconomics: '1',
    },
  };
}

test('complete exact material candidate admits only for review', () => {
  const row = exactMaterialCandidate();
  assert.strictEqual(gate.evaluateAdmission(row), true);
  assert.strictEqual(gate.deriveStatus([row]), 'ADMIT_EXACT_MATERIAL_ROW_FOR_REVIEW');
});

test('missing exact runtime binding blocks admission', () => {
  const row = exactMaterialCandidate(); row.runtimeBinding.disposition = 'UNKNOWN_RUNTIME_SOURCE_CONTINUITY';
  assert.strictEqual(gate.evaluateAdmission(row), false);
});

test('missing exact immutables block admission', () => {
  const row = exactMaterialCandidate(); row.runtimeBinding.immutableValuesExact = false;
  assert.strictEqual(gate.evaluateAdmission(row), false);
});

test('missing pool tick distribution blocks admission', () => {
  const row = exactMaterialCandidate(); row.materiality.poolTickDistributionRetained = false;
  assert.strictEqual(gate.evaluateAdmission(row), false);
});

test('missing exit liquidity blocks admission', () => {
  const row = exactMaterialCandidate(); row.materiality.exitLiquidityRetained = false;
  assert.strictEqual(gate.evaluateAdmission(row), false);
});

test('nonpositive conservative net blocks admission', () => {
  for (const value of ['0', '-1']) {
    const row = exactMaterialCandidate(); row.materiality.conservativeNetEconomics = value;
    assert.strictEqual(gate.evaluateAdmission(row), false);
  }
});

test('all retained rows fail admission', () => {
  assert(artifact.rows.every((x) => gate.evaluateAdmission(x) === false && x.admitted === false));
  assert.strictEqual(artifact.admission.admittedRows.length, 0);
});

test('Gate0 deterministically closes and rotates', () => {
  assert.strictEqual(gate.deriveStatus(artifact.rows), gate.STATUS);
  assert.strictEqual(artifact.status, gate.STATUS);
  assert.strictEqual(artifact.nextAction, 'CLOSE_ROTATE');
});

test('historical unpinned evidence cannot establish current execution', () => {
  assert.strictEqual(artifact.scope.blockPinned, false);
  assert.strictEqual(artifact.scope.finalityEstablished, false);
  assert.strictEqual(artifact.scope.currentStateClaimed, false);
  assert.strictEqual(artifact.executableNow, 'unknown');
});

test('canonical route and evidence axes remain fail-closed', () => {
  assert.strictEqual(artifact.localSemantic.status, 'PASS');
  assert.strictEqual(artifact.reachability.status, 'UNKNOWN');
  assert.strictEqual(artifact.economics.status, 'UNKNOWN');
  assert.strictEqual(artifact.routePositive, 'unknown');
  assert.strictEqual(artifact.routeDisposition, 'UNKNOWN');
});

test('network fork signing transaction and protected access remain false', () => {
  for (const key of ['networkAttempted', 'rpcAttempted', 'protectedFilesRead', 'buildPerformed', 'forgeInvoked', 'packageManagerInvoked', 'signingAttempted', 'transactionAttempted', 'stateMutationAttempted']) {
    assert.strictEqual(artifact[key], false, key);
  }
  assert.strictEqual(artifact.fork, false);
  assert.strictEqual(artifact.signedActionJustified, false);
});

test('artifact validator rejects false exact promotion', () => {
  const mutated = clone(artifact);
  mutated.rows[0].classification = 'EXACT_GENERIC_EQUAL_BOUND';
  assert.throws(() => gate.validateArtifactData(mutated), /false exact generic promotion|classification counts/);
});

test('artifact validator rejects false admission', () => {
  const mutated = clone(artifact);
  mutated.admission.admitted = true;
  assert.throws(() => gate.validateArtifactData(mutated), /artifact admission/);
});

test('artifact validator rejects invented ratio', () => {
  const mutated = clone(artifact);
  mutated.rows[0].materiality.cashToPoolFairTvlRatio = 10;
  assert.throws(() => gate.validateArtifactData(mutated), /invented cash\/pool ratio/);
});

test('formatUnits is exact for eighteen and six decimals', () => {
  assert.strictEqual(gate.formatUnits('52951616752517336', 18), '0.052951616752517336');
  assert.strictEqual(gate.formatUnits('20053198', 6), '20.053198');
  assert.strictEqual(gate.formatUnits('0', 18), '0');
});

test('persisted output manifest is deterministic and self-excluding', () => {
  const manifest = gate.buildManifest(gate.ROOT);
  assert.strictEqual(gate.validateManifestData(manifest), true);
  assert.strictEqual(manifest.manifestSelfHashExcluded, true);
  assert(!manifest.exactPathOrder.includes(gate.OUTPUT_PATHS.manifest));
  assert.strictEqual(new Set(manifest.exactPathOrder).size, manifest.fileCount);
});

test('manifest binds tool test artifact report and six inputs', () => {
  const manifest = gate.buildManifest(gate.ROOT);
  assert.strictEqual(manifest.fileCount, 10);
  assert.deepStrictEqual(manifest.exactPathOrder.slice(0, 4), [
    `tools/analyze-${gate.ID}.js`,
    `tools/test-${gate.ID}.js`,
    gate.OUTPUT_PATHS.artifact,
    gate.OUTPUT_PATHS.report,
  ]);
});

test('manifest duplicate mutation is rejected', () => {
  const manifest = gate.buildManifest(gate.ROOT);
  const mutated = clone(manifest);
  mutated.exactPathOrder[1] = mutated.exactPathOrder[0];
  mutated.files[1].path = mutated.files[0].path;
  assert.throws(() => gate.validateManifestData(mutated), /duplicate path/);
});

if (!process.exitCode) process.stdout.write(`# ${passed} tests passed\n`);
