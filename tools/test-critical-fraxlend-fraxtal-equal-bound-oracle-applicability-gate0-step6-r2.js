#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gate = require('./analyze-critical-fraxlend-fraxtal-equal-bound-oracle-applicability-gate0-step6-r2.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`ok ${passed} - ${name}\n`); }
  catch (error) { process.stderr.write(`not ok - ${name}: ${error.stack || error.message}\n`); process.exitCode = 1; }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function rootPath(relPath) { return path.join(gate.ROOT, ...relPath.split('/')); }
function readJson(relPath) { return JSON.parse(fs.readFileSync(rootPath(relPath), 'utf8')); }

const bundle = gate.buildBundle(gate.ROOT);
const artifact = bundle.artifact;
const manifest = bundle.manifest;
const persistedArtifact = readJson(gate.OUTPUT_PATHS.artifact);
const persistedManifest = readJson(gate.OUTPUT_PATHS.manifest);

test('R2 replacement metadata preserves immutable v1', () => {
  assert.strictEqual(artifact.versionMetadata.disposition, 'R2_REPLACES_V1');
  assert.strictEqual(artifact.versionMetadata.predecessorFindingId, gate.V1_ID);
  assert.strictEqual(artifact.versionMetadata.v1Preservation, 'V1_PACKAGE_BYTE_IDENTICAL');
  assert.strictEqual(artifact.versionMetadata.immutableNoReplace, true);
});

test('all five v1 predecessor hashes remain byte-identical', () => {
  const records = gate.verifyV1(gate.ROOT);
  assert.strictEqual(records.length, 5);
  assert.deepStrictEqual(records.map((x) => x.sha256), Object.values(gate.V1_HASHES));
  assert.strictEqual(artifact.versionMetadata.immutableV1AggregateSha256, gate.aggregate(records));
});

test('unchanged v1 tests pass as read-only check', () => {
  const testPath = rootPath(`tools/test-${gate.V1_ID}.js`);
  const output = execFileSync(process.execPath, [testPath], { cwd: gate.ROOT, encoding: 'utf8' });
  assert.match(output, /# 38 tests passed/);
  assert.deepStrictEqual(gate.verifyV1(gate.ROOT).map((x) => x.sha256), Object.values(gate.V1_HASHES));
});

test('all original six authority inputs are rebound', () => {
  const records = gate.verifyOriginalInputs(gate.ROOT);
  assert.strictEqual(records.length, 6);
  assert.strictEqual(artifact.authority.inputs.length, 6);
  assert.deepStrictEqual(artifact.authority.originalSixInputs, records);
});

test('exact source-line map has only eight claimed observations', () => {
  assert.deepStrictEqual(artifact.authority.genericSourceSemantics.requiredGetterLines, gate.SOURCE_LINE_MAP);
  assert.deepStrictEqual(Object.keys(artifact.authority.genericSourceSemantics.requiredGetterLines), [
    'oracleTypeEqualsOne', 'maxOracleDelayReturned', 'baseTokenReturned', 'quoteTokenReturned',
    'uniV3PairReturned', 'twapDurationReturned', 'decimalsEquals18', 'getPricesReturned',
  ]);
});

test('decimals and getPrices source lines are exact', () => {
  const lines = artifact.authority.genericSourceSemantics.requiredGetterLines;
  assert.deepStrictEqual(lines.decimalsEquals18, [48, 161, 162, 163]);
  assert.deepStrictEqual(lines.getPricesReturned, [143]);
  assert.deepStrictEqual(artifact.authority.genericSourceSemantics.badDataEqualBoundLines, [143, 154, 156, 157, 158]);
  assert(!JSON.stringify(lines).match(/\b38\b|\b39\b|\b49\b/));
});

test('source-line map mutation is rejected', () => {
  for (const mutate of [
    (x) => { x.authority.genericSourceSemantics.requiredGetterLines.decimalsEquals18 = [48]; },
    (x) => { x.authority.genericSourceSemantics.requiredGetterLines.getPricesReturned = []; },
    (x) => { x.authority.genericSourceSemantics.requiredGetterLines.unrelatedChainlink = [38, 39]; },
    (x) => { x.authority.genericSourceSemantics.badDataEqualBoundLines = [143, 156, 157, 158]; },
  ]) {
    const mutated = clone(artifact); mutate(mutated);
    assert.throws(() => gate.validateArtifactData(mutated), /source-line map|bad-data source lines/);
  }
});

test('scanner latest authority includes eth_call and eth_getCode', () => {
  const scanner = artifact.authority.retainedScannerSemantics;
  assert.deepStrictEqual(scanner.ethCallLatest, [234, 235, 236, 237]);
  assert.deepStrictEqual(scanner.ethGetCodeLatest, [265, 266, 267, 268]);
  assert.deepStrictEqual(scanner.transportFailureCapture, [226, 227, 228, 229, 230, 231]);
});

test('scanner null conflation explicitly binds line 237 and propagation', () => {
  const scanner = artifact.authority.retainedScannerSemantics;
  assert(scanner.nullConflation.includes(237));
  assert.deepStrictEqual(scanner.nullConflation, gate.SCANNER_LINE_MAP.nullConflation);
  assert.deepStrictEqual(scanner.requiredObservationLines, gate.SCANNER_LINE_MAP.requiredObservationLines);
});

test('scanner source-line mutations are rejected', () => {
  for (const mutate of [
    (x) => { x.authority.retainedScannerSemantics.ethGetCodeLatest.pop(); },
    (x) => { x.authority.retainedScannerSemantics.ethCallLatest = [234, 235, 236]; },
    (x) => { x.authority.retainedScannerSemantics.nullConflation = x.authority.retainedScannerSemantics.nullConflation.filter((n) => n !== 237); },
    (x) => { x.authority.retainedScannerSemantics.requiredObservationLines.getPricesReturned.pop(); },
  ]) {
    const mutated = clone(artifact); mutate(mutated);
    assert.throws(() => gate.validateArtifactData(mutated), /scanner/);
  }
});

test('persisted R2 artifact exactly deep-equals regeneration', () => {
  assert.deepStrictEqual(persistedArtifact, artifact);
  assert.strictEqual(fs.readFileSync(rootPath(gate.OUTPUT_PATHS.artifact)).equals(bundle.artifactBytes), true);
});

test('persisted artifact mutation cannot equal regeneration', () => {
  const mutated = clone(persistedArtifact);
  mutated.authority.genericSourceSemantics.requiredGetterLines.decimalsEquals18.pop();
  assert.notDeepStrictEqual(mutated, gate.buildArtifact(gate.ROOT));
  assert.throws(() => gate.validateArtifactData(mutated), /source-line map/);
});

test('exact seventeen rows and unchanged conclusion', () => {
  assert.strictEqual(artifact.rows.length, 17);
  assert.strictEqual(new Set(artifact.rows.map((x) => x.pair)).size, 17);
  assert.deepStrictEqual(artifact.genericApplicabilityGate.classificationCounts, {
    EXACT_GENERIC_EQUAL_BOUND: 0, WRONG_TYPE: 1, UNKNOWN: 16,
  });
  assert.strictEqual(artifact.admission.admittedRows.length, 0);
});

test('false classification or admission mutation is rejected', () => {
  const exact = clone(artifact); exact.rows[0].classification = 'EXACT_GENERIC_EQUAL_BOUND';
  assert.throws(() => gate.validateArtifactData(exact), /false exact row/);
  const admitted = clone(artifact); admitted.admission.admitted = true;
  assert.throws(() => gate.validateArtifactData(admitted), /false admission/);
});

test('close rotate and fail-closed gates remain exact', () => {
  assert.strictEqual(artifact.status, 'CLOSE_NO_EXACT_MATERIAL_RETAINED_ROW');
  assert.strictEqual(artifact.nextAction, 'CLOSE_ROTATE');
  assert.deepStrictEqual(artifact.gates, {
    routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: false,
    fork: false, economics: 'UNASSESSED',
  });
  assert.strictEqual(artifact.economicsAssessed, false);
});

test('historical latest single-provider and null caveats remain', () => {
  assert.strictEqual(artifact.scope.blockPinned, false);
  assert.strictEqual(artifact.scope.scannerCallTag, 'latest');
  assert.match(artifact.scope.warning, /historical unpinned single-provider/);
  assert.match(artifact.limitations.join(' '), /Null selector observations conflate/);
});

test('no global absence or source refutation is claimed', () => {
  assert.match(artifact.limitations.join(' '), /not a global absence claim and does not refute/);
  assert.match(bundle.reportBytes.toString('utf8'), /not a global Fraxtal deployment-absence claim and does not refute/);
});

test('network build RPC fork signing and transaction remain false', () => {
  for (const key of ['networkAttempted', 'rpcAttempted', 'protectedFilesRead', 'buildPerformed', 'forgeInvoked', 'packageManagerInvoked', 'signingAttempted', 'transactionAttempted', 'stateMutationAttempted', 'targetEdited', 'stateReadOrMutationAttempted', 'coordinationWritten']) assert.strictEqual(artifact[key], false, key);
  assert.strictEqual(artifact.fork, false);
  assert.strictEqual(artifact.signedActionJustified, false);
});

test('persisted R2 manifest exactly deep-equals regeneration', () => {
  assert.deepStrictEqual(persistedManifest, manifest);
  assert.strictEqual(fs.readFileSync(rootPath(gate.OUTPUT_PATHS.manifest)).equals(bundle.manifestBytes), true);
});

test('manifest aggregate is exactly recomputed', () => {
  assert.strictEqual(manifest.aggregateSha256, gate.aggregate(manifest.files));
  assert.strictEqual(gate.validateManifestData(manifest), true);
});

test('manifest exact order binds R2, v1, then six inputs', () => {
  assert.strictEqual(manifest.fileCount, 15);
  assert.deepStrictEqual(manifest.exactPathOrder, gate.manifestPaths());
  assert.deepStrictEqual(manifest.exactPathOrder.slice(4, 9), Object.keys(gate.V1_HASHES));
  assert.strictEqual(manifest.files.filter((x) => x.role === 'original-authority-input').length, 6);
});

test('manifest has no duplicate and excludes itself', () => {
  assert.strictEqual(new Set(manifest.exactPathOrder).size, manifest.fileCount);
  assert(!manifest.exactPathOrder.includes(gate.OUTPUT_PATHS.manifest));
  assert.strictEqual(manifest.manifestSelfHashExcluded, true);
  assert.strictEqual(manifest.immutableNoReplaceGeneration, true);
  assert.strictEqual(manifest.predecessorReplacementPolicy, 'NO_REPLACE');
});

test('manifest aggregate mutation is rejected', () => {
  const mutated = clone(manifest); mutated.files[0].sha256 = '00'.repeat(32);
  assert.throws(() => gate.validateManifestData(mutated), /manifest aggregate/);
});

test('manifest order mutation is rejected', () => {
  const mutated = clone(manifest);
  [mutated.files[0], mutated.files[1]] = [mutated.files[1], mutated.files[0]];
  assert.throws(() => gate.validateManifestData(mutated), /exact order/);
});

test('manifest duplicate mutation is rejected', () => {
  const mutated = clone(manifest);
  mutated.exactPathOrder[1] = mutated.exactPathOrder[0];
  mutated.files[1].path = mutated.files[0].path;
  assert.throws(() => gate.validateManifestData(mutated), /expected path order|duplicate path/);
});

test('manifest self-inclusion mutation is rejected', () => {
  const mutated = clone(manifest);
  mutated.exactPathOrder[0] = gate.OUTPUT_PATHS.manifest;
  mutated.files[0].path = gate.OUTPUT_PATHS.manifest;
  assert.throws(() => gate.validateManifestData(mutated), /expected path order|self path included/);
});

test('manifest v1 hash mutation is rejected after aggregate recompute', () => {
  const mutated = clone(manifest);
  const row = mutated.files.find((x) => x.role === 'immutable-v1-predecessor');
  row.sha256 = '11'.repeat(32);
  mutated.aggregateSha256 = gate.aggregate(mutated.files);
  mutated.metadata.immutableV1AggregateSha256 = gate.aggregate(mutated.files.filter((x) => x.role === 'immutable-v1-predecessor'));
  assert.throws(() => gate.validateManifestData(mutated), /manifest v1 hash/);
});

test('persisted manifest mutation cannot equal regeneration', () => {
  const mutated = clone(persistedManifest); mutated.metadata.unknownRows = 15;
  assert.notDeepStrictEqual(mutated, gate.buildBundle(gate.ROOT).manifest);
  assert.throws(() => gate.validateManifestData(mutated), /conclusion counts/);
});

test('immutable no-replace refuses replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fraxlend-r2-'));
  try {
    fs.writeFileSync(path.join(dir, 'immutable'), 'v1');
    assert.throws(() => gate.writeNoReplace(dir, [['immutable', Buffer.from('r2')]]), /refuses existing output/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'immutable'), 'utf8'), 'v1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('check-only validates persisted bundle and every bound hash', () => {
  const checked = gate.validateBundle(gate.ROOT);
  assert.deepStrictEqual(checked.artifact, artifact);
  assert.deepStrictEqual(checked.manifest, manifest);
});

if (!process.exitCode) process.stdout.write(`PASS tests=${passed} rows=17 exact=0 wrong=1 unknown=16 admitted=0 status=${gate.STATUS}\n`);
