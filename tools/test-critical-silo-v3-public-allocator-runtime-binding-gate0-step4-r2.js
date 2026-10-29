#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gate = require('./analyze-critical-silo-v3-public-allocator-runtime-binding-gate0-step4-r2.js');

let passed = 0;
function test(name, fn) { try { fn(); passed += 1; process.stdout.write(`ok ${passed} - ${name}\n`); } catch (error) { process.stderr.write(`not ok - ${name}: ${error.stack || error.message}\n`); process.exitCode = 1; } }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function rejects(fn, re) { assert.throws(fn, re); }
function readJson(p) { return JSON.parse(fs.readFileSync(path.join(gate.ROOT, ...p.split('/')))); }

const bundle = gate.buildBundle(gate.ROOT);
const artifact = bundle.artifact;
const manifest = bundle.manifest;

test('positive exact factory reconstruction all seven', () => {
  assert.deepStrictEqual(artifact.factoryRows.map((x) => x.chainId), [1, 56, 146, 5000, 8453, 42161, 57073]);
  assert(artifact.factoryRows.every((x) => x.exactRuntimeBound && x.reconstructedRuntime.bytes === 2492 && x.reconstructedRuntime.exactByteHashMatch));
});

test('exact expected reconstructed hashes all seven', () => {
  assert.deepStrictEqual(artifact.factoryRows.map((x) => x.reconstructedRuntime.keccak256), gate.FACTORIES.map((x) => x.runtimeHash));
});

test('exact broadcast hashes and provenance split', () => {
  assert.deepStrictEqual(artifact.factoryRows.map((x) => x.broadcast.sha256), gate.FACTORIES.map((x) => x.sha256));
  assert.deepStrictEqual(artifact.provenance.priorStep2ManifestBoundFactoryChains, [1, 56, 8453, 42161]);
  assert.deepStrictEqual(artifact.provenance.newlyR2BoundFactoryChains, [146, 5000, 57073]);
});

test('receipt address status and log exact all seven', () => {
  assert(artifact.factoryRows.every((x) => x.receipt.matchedByTransactionHash && x.receipt.status === '0x1' && x.receipt.contractAddress === x.transaction.contractAddress && x.receipt.moduleLogExact));
});

test('transaction input chain and address exact all seven', () => {
  assert(artifact.factoryRows.every((x) => x.transaction.type === 'CREATE' && x.transaction.inputBytes === 9179));
  assert.deepStrictEqual(artifact.factoryRows.map((x) => x.transaction.contractAddress), gate.FACTORIES.map((x) => x.address));
});

test('library and module exact all seven', () => {
  assert(artifact.factoryRows.every((x) => x.library.exactInConstructorRuntime && x.moduleImmutable.additionalContractsExact && x.moduleImmutable.receiptLogExact));
  assert.deepStrictEqual(artifact.factoryRows.map((x) => x.library.address), gate.FACTORIES.map((x) => x.library));
  assert.deepStrictEqual(artifact.factoryRows.map((x) => x.moduleImmutable.address), gate.FACTORIES.map((x) => x.module));
});

test('layout and immutable patches exact', () => {
  assert(artifact.factoryRows.every((x) => x.constructorRuntimeLayout.offset === 0x6d && x.constructorRuntimeLayout.length === 0x09bc && x.constructorRuntimeLayout.directiveExact));
  assert(artifact.factoryRows.every((x) => JSON.stringify(x.moduleImmutable.patchOffsets) === JSON.stringify([0x99, 0x2d6]) && x.moduleImmutable.patchLength === 32));
});

test('Standard JSON 54 literal sources/settings/library', () => {
  const standard = readJson(gate.STANDARD_JSON_PATH);
  assert.strictEqual(gate.validateStandardJsonObject(standard), true);
  assert.strictEqual(artifact.provenance.standardJson.sha256, gate.STANDARD_JSON_SHA256);
});

test('Standard JSON source omission rejected', () => {
  const x = readJson(gate.STANDARD_JSON_PATH); delete x.sources[Object.keys(x.sources)[0]];
  rejects(() => gate.validateStandardJsonObject(x), /source count/);
});

test('Standard JSON optimizer mutation rejected', () => {
  const x = readJson(gate.STANDARD_JSON_PATH); x.settings.optimizer.runs = 201;
  rejects(() => gate.validateStandardJsonObject(x), /optimizer/);
});

test('Standard JSON Cancun viaIR metadata mutation rejected', () => {
  for (const mutate of [x => { x.settings.evmVersion = 'paris'; }, x => { x.settings.viaIR = true; }, x => { x.settings.metadata.bytecodeHash = 'none'; }]) {
    const x = readJson(gate.STANDARD_JSON_PATH); mutate(x); rejects(() => gate.validateStandardJsonObject(x), /EVM\/viaIR|IPFS metadata/);
  }
});

test('Standard JSON library mutation rejected', () => {
  const x = readJson(gate.STANDARD_JSON_PATH); x.settings.libraries['silo-vaults/contracts/SiloVaultsFactory.sol'].SiloVaultFactoryActionsLib = `0x${'11'.repeat(20)}`;
  rejects(() => gate.validateStandardJsonObject(x), /library setting/);
});

function mutatedBroadcast(chainId, mutate) {
  const expected = gate.FACTORIES.find((x) => x.chainId === chainId);
  const body = readJson(expected.path); mutate(body, expected); return () => gate.reconstructFactory(gate.ROOT, expected, body);
}

test('receipt status mutation rejected', () => {
  rejects(mutatedBroadcast(1, (x, e) => { x.receipts.find((r) => r.transactionHash.toLowerCase() === e.txHash).status = '0x0'; }), /receipt status\/address/);
});

test('receipt contract address mutation rejected', () => {
  rejects(mutatedBroadcast(56, (x, e) => { x.receipts.find((r) => r.transactionHash.toLowerCase() === e.txHash).contractAddress = `0x${'22'.repeat(20)}`; }), /receipt status\/address/);
});

test('receipt module log mutation rejected', () => {
  rejects(mutatedBroadcast(146, (x, e) => { x.receipts.find((r) => r.transactionHash.toLowerCase() === e.txHash).logs[0].data = '0x00'; }), /module receipt log/);
});

test('transaction input mutation rejected', () => {
  rejects(mutatedBroadcast(5000, (x) => { const t = x.transactions.find((r) => r.contractName === 'SiloVaultsFactory'); const i = 2 + (0x6d + 1000) * 2; const replacement = t.transaction.input.slice(i, i + 2) === '00' ? '01' : '00'; t.transaction.input = `${t.transaction.input.slice(0, i)}${replacement}${t.transaction.input.slice(i + 2)}`; }), /reconstructed runtime hash|linked library|immutable template/);
});

test('library mutation rejected explicitly', () => {
  rejects(mutatedBroadcast(8453, (x) => { const t = x.transactions.find((r) => r.contractName === 'SiloVaultsFactory'); t.transaction.input = t.transaction.input.replace(gate.FACTORIES.find((r) => r.chainId === 8453).library.slice(2), '33'.repeat(20)); }), /linked library/);
});

test('module additionalContracts mutation rejected', () => {
  rejects(mutatedBroadcast(42161, (x) => { x.transactions.find((r) => r.contractName === 'SiloVaultsFactory').additionalContracts[0].address = `0x${'44'.repeat(20)}`; }), /module additionalContracts/);
});

test('constructor layout mutation rejected', () => {
  rejects(mutatedBroadcast(57073, (x) => { const t = x.transactions.find((r) => r.contractName === 'SiloVaultsFactory'); const i = 2 + 0x50 * 2; t.transaction.input = `${t.transaction.input.slice(0, i)}00${t.transaction.input.slice(i + 2)}`; }), /layout directive/);
});

test('expected reconstructed hash mutation rejected', () => {
  const expected = clone(gate.FACTORIES[0]); expected.runtimeHash = `0x${'55'.repeat(32)}`;
  rejects(() => gate.reconstructFactory(gate.ROOT, expected, readJson(expected.path)), /reconstructed runtime hash/);
});

test('v1 files remain byte-identical', () => {
  assert.strictEqual(gate.verifyV1(gate.ROOT).length, 5);
  assert.deepStrictEqual(gate.verifyV1(gate.ROOT).map((x) => x.sha256), Object.values(gate.V1_HASHES));
});

test('all 53 broadcast files searched in exact order', () => {
  const paths = gate.listRunLatest(gate.ROOT);
  assert.strictEqual(paths.length, 53);
  assert.deepStrictEqual(paths, [...paths].sort());
  assert.strictEqual(new Set(paths).size, 53);
});

test('six vault preimages absent and zero deep-bound rows', () => {
  assert.strictEqual(artifact.vaultRows.length, 6);
  assert(artifact.vaultRows.every((x) => x.addressOccurrencesInBroadcasts === 0 && !x.creationTransactionPresent && !x.creationCalldataOrInitCodePresent && !x.deployedBytePreimagePresent && !x.immutableClosurePresent && !x.deepBound));
  assert.strictEqual(artifact.vaultSearch.deepBoundRows, 0);
});

test('false vault exact promotion rejected', () => {
  const x = clone(artifact); x.vaultRows[0].exactRuntimeBound = true;
  rejects(() => gate.validateArtifactData(x), /vault rows\/deep binding/);
});

test('factory settings are not inherited as vault closure', () => {
  const x = clone(artifact); x.runtimeBinding.vault.compilerSettingsClosureInheritedFromFactory = true;
  rejects(() => gate.validateArtifactData(x), /inherited closure/);
});

test('factory blockers removed and exact count seven', () => {
  assert.strictEqual(artifact.runtimeBinding.factory.exactBoundChains, 7);
  assert.deepStrictEqual(artifact.runtimeBinding.factory.blockers, []);
});

test('status admission and gates fail closed on vault binding', () => {
  assert.strictEqual(gate.deriveStatus(artifact.runtimeBinding), gate.STATUS);
  assert.strictEqual(artifact.admission.admitted, false);
  assert.deepStrictEqual(artifact.gates, { routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: false, fork: false, economics: 'UNASSESSED' });
});

test('dirty provenance and no build/network/state/coordination', () => {
  assert.strictEqual(artifact.dirtyTargetObserved, true);
  for (const key of ['networkAttempted', 'forgeInvoked', 'buildPerformed', 'packageManagerInvoked', 'stateReadOrMutationAttempted', 'coordinationWritten']) assert.strictEqual(artifact[key], false);
});

test('manifest exact order no omission or duplicates', () => {
  assert.strictEqual(manifest.fileCount, manifest.files.length);
  assert.deepStrictEqual(manifest.exactPathOrder, manifest.files.map((x) => x.path));
  assert.strictEqual(new Set(manifest.exactPathOrder).size, manifest.fileCount);
  assert.strictEqual(gate.validateManifestData(manifest), true);
});

test('manifest omission rejected', () => {
  const x = clone(manifest); x.files.pop();
  rejects(() => gate.validateManifestData(x), /path order\/count/);
});

test('manifest order mutation rejected', () => {
  const x = clone(manifest); [x.files[0], x.files[1]] = [x.files[1], x.files[0]];
  rejects(() => gate.validateManifestData(x, manifest), /path order\/count|deterministic binding/);
});

test('manifest duplicate rejected', () => {
  const x = clone(manifest); x.files[1].path = x.files[0].path; x.exactPathOrder[1] = x.exactPathOrder[0];
  rejects(() => gate.validateManifestData(x), /duplicate path/);
});

test('manifest hash mutation rejected', () => {
  const x = clone(manifest); x.files[0].sha256 = '66'.repeat(32);
  rejects(() => gate.validateManifestData(x), /aggregate/);
});

test('report byte binding mutation detected', () => {
  const changed = Buffer.concat([bundle.reportBytes, Buffer.from('x')]);
  assert.notStrictEqual(gate.sha256(changed), artifact.reportBinding.sha256);
});

test('immutable no-replace generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-r2-'));
  try { fs.writeFileSync(path.join(dir, 'x'), 'v1'); rejects(() => gate.writeNoReplace(dir, [['x', Buffer.from('r2')]]), /refuses existing output/); assert.strictEqual(fs.readFileSync(path.join(dir, 'x'), 'utf8'), 'v1'); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

if (!process.exitCode) process.stdout.write(`PASS tests=${passed} factoryExact=7 vaultExact=0 status=${gate.STATUS} admission=false\n`);
