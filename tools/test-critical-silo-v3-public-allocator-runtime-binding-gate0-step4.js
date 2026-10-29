#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gate = require('./analyze-critical-silo-v3-public-allocator-runtime-binding-gate0-step4.js');

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
function rejects(fn, pattern) { assert.throws(fn, pattern); }

const bundle = gate.buildBundle(path.resolve(__dirname, '..'));
const baseArtifact = bundle.artifact;
const baseManifest = bundle.manifest;

test('deterministic bundle rebuild', () => {
  const again = gate.buildBundle(path.resolve(__dirname, '..'));
  assert(bundle.reportBytes.equals(again.reportBytes));
  assert(bundle.artifactBytes.equals(again.artifactBytes));
  assert(bundle.manifestBytes.equals(again.manifestBytes));
});

test('seven retained chains in exact order', () => {
  assert.deepStrictEqual(baseArtifact.chains.map((x) => x.chainId), [1, 56, 146, 5000, 8453, 42161, 57073]);
});

test('six retained vault rows split BNB and Arbitrum', () => {
  assert.strictEqual(baseArtifact.vaults.length, 6);
  assert.strictEqual(baseArtifact.vaults.filter((x) => x.chainId === 56).length, 2);
  assert.strictEqual(baseArtifact.vaults.filter((x) => x.chainId === 42161).length, 4);
});

test('chain pin mutation rejected', () => {
  const x = clone(baseArtifact); x.chains[0].pin.hash = `0x${'00'.repeat(32)}`;
  rejects(() => gate.validateArtifactData(x), /pin drift/);
});

test('PublicAllocator address drift rejected', () => {
  const x = clone(baseArtifact); x.chains[1].publicAllocator.address = `0x${'11'.repeat(20)}`;
  rejects(() => gate.validateArtifactData(x), /PublicAllocator drift/);
});

test('PublicAllocator runtime drift rejected', () => {
  const x = clone(baseArtifact); x.chains[2].publicAllocator.runtimeKeccak256 = `0x${'22'.repeat(32)}`;
  rejects(() => gate.validateArtifactData(x), /PublicAllocator drift/);
});

test('factory address drift rejected', () => {
  const x = clone(baseArtifact); x.chains[3].factory.address = `0x${'33'.repeat(20)}`;
  rejects(() => gate.validateArtifactData(x), /factory drift/);
});

test('factory runtime drift rejected', () => {
  const x = clone(baseArtifact); x.chains[4].factory.runtimeKeccak256 = `0x${'44'.repeat(32)}`;
  rejects(() => gate.validateArtifactData(x), /factory drift/);
});

test('vault address drift rejected', () => {
  const x = clone(baseArtifact); x.vaults[0].vault = `0x${'55'.repeat(20)}`;
  rejects(() => gate.validateArtifactData(x), /vault drift/);
});

test('vault runtime drift rejected', () => {
  const x = clone(baseArtifact); x.vaults[1].runtimeHash = `0x${'66'.repeat(32)}`;
  rejects(() => gate.validateArtifactData(x), /vault drift/);
});

test('factory false exact promotion rejected', () => {
  const x = clone(baseArtifact); x.chains[0].factory.binding = 'EXACT';
  rejects(() => gate.validateArtifactData(x), /factory false promotion/);
});

test('vault false exact promotion rejected', () => {
  const x = clone(baseArtifact); x.vaults[0].runtimeBinding = 'EXACT';
  rejects(() => gate.validateArtifactData(x), /vault false promotion/);
});

test('aggregate exact binding false promotion rejected', () => {
  const x = clone(baseArtifact); x.runtimeBinding.factory.exactBoundChains = 7;
  rejects(() => gate.validateArtifactData(x), /false promotion|status derivation/);
});

test('missing factory compiler/settings/artifact/library/immutable closure derives blocked', () => {
  const runtime = clone(baseArtifact.runtimeBinding);
  runtime.factory.compilerAvailable = false;
  runtime.factory.settingsClosureAvailable = false;
  runtime.factory.deterministicCompiledRuntimeAvailable = false;
  runtime.factory.librariesResolved = false;
  runtime.factory.immutableReferencesAvailable = false;
  assert.strictEqual(gate.deriveStatus(runtime), gate.STATUS);
});

test('missing vault settings/artifact/library/immutable closure derives blocked', () => {
  const runtime = clone(baseArtifact.runtimeBinding);
  runtime.vault.settingsClosureAvailable = false;
  runtime.vault.deterministicCompiledRuntimeAvailable = false;
  runtime.vault.librariesResolved = false;
  runtime.vault.immutableReferencesAvailable = false;
  runtime.vault.immutableValuesResolved = false;
  assert.strictEqual(gate.deriveStatus(runtime), gate.STATUS);
});

test('dirty target truth is required', () => {
  const x = clone(baseArtifact); x.dirtyTargetObserved = false;
  rejects(() => gate.validateArtifactData(x), /dirty-state truth/);
});

test('network Forge and package manager remain false', () => {
  for (const field of ['networkAttempted', 'forgeInvoked', 'packageManagerInvoked']) {
    const x = clone(baseArtifact); x[field] = true;
    rejects(() => gate.validateArtifactData(x), /offline invocation truth/);
  }
});

test('operational gates are unknown/false and economics unassessed', () => {
  const x = clone(baseArtifact); x.gates.routePositive = true;
  rejects(() => gate.validateArtifactData(x), /gates invalid/);
});

test('historical authorization cannot be promoted current/global', () => {
  const x = clone(baseArtifact); x.vaults[2].historicalAuthorizationObservation.currentOrGlobal = true;
  rejects(() => gate.validateArtifactData(x), /historical authorization scope promoted/);
});

test('authorization runner admission rejected while blocked', () => {
  const x = clone(baseArtifact); x.admission.admitted = true;
  rejects(() => gate.validateArtifactData(x), /runner admitted/);
});

test('authority hash mutation rejected', () => {
  const x = clone(baseArtifact);
  x.authorityHashes.retained[0].sha256 = '00'.repeat(32);
  rejects(() => gate.validateArtifactData(x), /retained authority hash invalid/);
});

test('Step2 retained row address mutation rejected', () => {
  const root = path.resolve(__dirname, '..');
  const step2 = JSON.parse(fs.readFileSync(path.join(root, 'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2.json')));
  step2.chains.find((x) => x.chainId === 56).deployments.factory = `0x${'77'.repeat(20)}`;
  rejects(() => gate.verifyStep2Rows(step2), /factory address drift/);
});

test('Step2 retained row runtime mutation rejected', () => {
  const root = path.resolve(__dirname, '..');
  const step2 = JSON.parse(fs.readFileSync(path.join(root, 'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2.json')));
  step2.chains.find((x) => x.chainId === 42161).vaults[0].runtime.codeKeccak256 = `0x${'88'.repeat(32)}`;
  rejects(() => gate.verifyStep2Rows(step2), /vault runtime drift/);
});

test('manifest metadata target pin mutation rejected', () => {
  const x = clone(baseManifest); x.metadata.targetCommit = '00'.repeat(20);
  rejects(() => gate.validateManifestData(x), /target\/status metadata/);
});

test('manifest chain pin hash mutation rejected', () => {
  const x = clone(baseManifest); x.metadata.chainPinsSha256 = '99'.repeat(32);
  rejects(() => gate.validateManifestData(x), /chain pin metadata/);
});

test('manifest file hash mutation rejected by aggregate', () => {
  const x = clone(baseManifest); x.files[0].sha256 = 'aa'.repeat(32);
  rejects(() => gate.validateManifestData(x), /aggregate invalid/);
});

test('manifest order mutation rejected', () => {
  const x = clone(baseManifest); [x.files[0], x.files[1]] = [x.files[1], x.files[0]];
  rejects(() => gate.validateManifestData(x), /file order/);
});

test('manifest duplicate path rejected', () => {
  const x = clone(baseManifest); x.files[1].path = x.files[0].path;
  rejects(() => gate.validateManifestData(x), /file order|duplicate/);
});

test('report byte mutation breaks artifact binding', () => {
  const mutated = Buffer.concat([bundle.reportBytes, Buffer.from('mutation')]);
  assert.notStrictEqual(gate.sha256(mutated), baseArtifact.reportBinding.sha256);
  assert.notStrictEqual(mutated.length, baseArtifact.reportBinding.bytes);
});

test('immutable no-replace generation refuses existing output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-step4-'));
  try {
    fs.writeFileSync(path.join(dir, 'already'), 'retained');
    rejects(() => gate.writeNoReplace(dir, [['already', Buffer.from('replacement')]]), /refuses existing output/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'already'), 'utf8'), 'retained');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status and CLOSE_ROTATE are fail-closed', () => {
  assert.strictEqual(baseArtifact.status, gate.STATUS);
  assert.strictEqual(baseArtifact.nextAction, 'CLOSE_ROTATE');
  assert.strictEqual(baseArtifact.runtimeBinding.runtimeMismatchClaimed, false);
});

if (!process.exitCode) process.stdout.write(`PASS tests=${passed} status=${baseArtifact.status} admission=${baseArtifact.admission.admitted}\n`);
