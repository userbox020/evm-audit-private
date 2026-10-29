#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gate = require('./analyze-critical-moonwell-composite-oev-deployment-prefilter-step2.js');

let passed = 0;
function test(name, fn) { try { fn(); passed += 1; process.stdout.write(`ok ${passed} - ${name}\n`); } catch (error) { process.stderr.write(`not ok - ${name}: ${error.stack || error.message}\n`); process.exitCode = 1; } }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function rejects(fn, re) { assert.throws(fn, re); }

const bundle = gate.buildBundle(gate.ROOT);
const artifact = bundle.artifact;
const manifest = bundle.manifest;

test('exact source commit and tree authority', () => {
  assert.strictEqual(artifact.authority.source.commit, gate.EXACT_COMMIT);
  assert.strictEqual(artifact.authority.source.tree, gate.EXACT_TREE);
});

test('reviewed wrapper source authority hash', () => {
  assert.strictEqual(artifact.wrapperFingerprint.sourceSha256, gate.WRAPPER_SHA256);
  assert.strictEqual(artifact.authority.source.wrapper.sha256, gate.WRAPPER_SHA256);
});

test('Step1 report raw package exact count and aggregate', () => {
  assert.strictEqual(artifact.authority.step1ReportRawPackage.fileCount, 30);
  assert.match(artifact.authority.step1ReportRawPackage.aggregateSha256, /^[0-9a-f]{64}$/);
});

test('Step1 authority verifies retained checksums', () => {
  assert.strictEqual(gate.verifyStep1Authority().records.length, 30);
});

test('target dirty truth exact pre-existing audit files', () => {
  assert.deepStrictEqual(artifact.authority.targetDirtyTruth.exactUntrackedOnly.map((x) => x.path), gate.DIRTY_EXPECTED);
  assert(artifact.authority.targetDirtyTruth.exactUntrackedOnly.every((x) => x.status === '??'));
});

test('target dirty witnesses are hash-bound', () => {
  assert.strictEqual(artifact.authority.targetDirtyTruth.witnessHashes.length, 3);
  assert(artifact.authority.targetDirtyTruth.witnessHashes.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)));
});

test('constructor has exactly seven ordered arguments', () => {
  assert.strictEqual(artifact.wrapperFingerprint.constructorArgumentCount, 7);
  assert.deepStrictEqual(artifact.wrapperFingerprint.constructorArguments.map((x) => x.parameter), ['_compositeOracle', '_baseFeed', '_owner', '_chainlinkOracle', '_feeRecipient', '_liquidatorFeeBps', '_maxRoundDelay']);
});

test('chainlinkOracle is the only immutable constructor destination', () => {
  const immutable = artifact.wrapperFingerprint.constructorArguments.filter((x) => x.distinction === 'IMMUTABLE');
  assert.deepStrictEqual(immutable.map((x) => x.destination), ['chainlinkOracle']);
});

test('composite and base references are mutable storage not immutable', () => {
  assert.strictEqual(artifact.wrapperFingerprint.constructorArguments[0].distinction, 'MUTABLE_STORAGE_REFERENCE');
  assert.strictEqual(artifact.wrapperFingerprint.constructorArguments[1].distinction, 'MUTABLE_STORAGE_REFERENCE');
});

test('owner and fee parameters have accurate storage distinctions', () => {
  assert.strictEqual(artifact.wrapperFingerprint.constructorArguments[2].distinction, 'PRIVATE_MUTABLE_STORAGE_VIA_TRANSFER_OWNERSHIP');
  assert(artifact.wrapperFingerprint.constructorArguments.slice(4).every((x) => x.distinction === 'MUTABLE_STORAGE'));
});

test('fingerprint is source build-manifest qualified only', () => {
  assert.strictEqual(artifact.wrapperFingerprint.qualification, 'SOURCE_AND_RETAINED_BUILD_MANIFEST_QUALIFIED_ONLY');
  assert.strictEqual(artifact.wrapperFingerprint.retainedCompiledRuntimeBytesPresent, false);
});

test('no exact runtime hash is invented', () => {
  assert.strictEqual(artifact.wrapperFingerprint.exactRuntimeHashClaimed, false);
  assert.strictEqual(artifact.wrapperFingerprint.runtimeHash, null);
});

test('direct wrapper dependencies are all hash-bound', () => {
  assert.strictEqual(artifact.wrapperFingerprint.directDependencies.length, gate.CONSTRUCTOR_DEPENDENCIES.length);
  assert.deepStrictEqual(artifact.wrapperFingerprint.directDependencies.map((x) => x.path), [...gate.CONSTRUCTOR_DEPENDENCIES]);
});

test('declared safe roots are exact and bounded', () => {
  assert.deepStrictEqual(artifact.search.localTracked.declaredSafeRoots, [...gate.DECLARED_SAFE_ROOTS]);
  assert.strictEqual(artifact.search.globalAbsenceClaimed, false);
});

test('search completeness exact tracked inventory order', () => {
  const inventory = gate.trackedInventory();
  assert.strictEqual(gate.validateSearchCompleteness(artifact.search.localTracked, inventory), true);
});

test('search count decrement mutation rejected', () => {
  const x = clone(artifact.search.localTracked); x.searchedFileCount -= 1;
  rejects(() => gate.validateSearchCompleteness(x, gate.trackedInventory()), /file count/);
});

test('search order mutation rejected', () => {
  const x = clone(artifact.search.localTracked); [x.records[0], x.records[1]] = [x.records[1], x.records[0]];
  rejects(() => gate.validateSearchCompleteness(x, gate.trackedInventory()), /exact order/);
});

test('exact construction count mutation rejected', () => {
  const x = clone(artifact.search.localTracked); x.exactConstructionCount = 1;
  rejects(() => gate.validateSearchCompleteness(x, gate.trackedInventory()), /unexpected exact wrapper construction/);
});

test('secret pattern classifier excludes env variants', () => {
  for (const p of ['.env', 'x/.env.local', 'src/.env.production']) assert.strictEqual(gate.isSecretPath(p), true);
});

test('secret pattern classifier excludes endpoint inventories', () => {
  assert.strictEqual(gate.isSecretPath('rpc_endpoints.txt'), true);
  assert.strictEqual(gate.isSecretPath('x/graphql_endpoints.txt'), true);
});

test('secret pattern classifier excludes PEM keypair and private key names', () => {
  for (const p of ['x/a.pem', 'x/deployer-keypair.json', 'x/private_key.txt', 'x/signing-key.json', 'x/key.json', 'x/keys.txt']) assert.strictEqual(gate.isSecretPath(p), true);
});

test('safe-root classifier rejects undeclared test and arbitrary roots', () => {
  assert.strictEqual(gate.isSafeTrackedPath('test/unit/X.t.sol'), false);
  assert.strictEqual(gate.isSafeTrackedPath('random/file.json'), false);
});

test('Git refs history and object evidence exact counts', () => {
  assert.strictEqual(artifact.search.git.refs.count, 3);
  assert.strictEqual(artifact.search.git.history.commitCount, 1);
  assert.strictEqual(artifact.search.git.objects.count, 1317);
  assert.deepStrictEqual(artifact.search.git.objects.typeCounts, { commit: 1, tree: 295, blob: 1021, tag: 0 });
});

test('tracked Git object search is bounded to safe roots', () => {
  assert.deepStrictEqual(artifact.search.git.trackedObjectSearch.roots, [...gate.DECLARED_SAFE_ROOTS]);
  assert.strictEqual(artifact.search.git.trackedObjectSearch.secretPatternsEnforced, true);
  assert.strictEqual(artifact.search.git.trackedObjectSearch.searchedBlobCount, artifact.search.git.objects.safeNamedBlobCount);
});

test('all Step1 and phase0 retained artifacts were searched', () => {
  assert.strictEqual(artifact.search.retainedArtifacts.searchedFileCount, 31);
  assert.strictEqual(artifact.search.totalLocalFilesSearched, artifact.search.localTracked.searchedFileCount + 31);
  assert.strictEqual(artifact.search.retainedArtifacts.paths.at(-1), gate.PHASE0_PATH);
});

test('phase0 listed markets were checked for candidate feed evidence', () => {
  assert.strictEqual(artifact.search.retainedArtifacts.phase0ListedMarketRowsChecked, 35);
  assert.strictEqual(artifact.search.retainedArtifacts.phase0ExactFalseMatchFeedAddressRowCount, 1);
  assert.strictEqual(artifact.search.retainedArtifacts.phase0ExactWrapperNameRows, 0);
});

test('cached phase0 wiring binds false address to listed mweETH but not exact type', () => {
  const wiring = artifact.candidates.rows[0].cachedPhase0Wiring;
  assert.strictEqual(wiring.retainedCachedArtifactOnly, true);
  assert.strictEqual(wiring.currentStateOrEconomicsClaimed, false);
  assert.strictEqual(wiring.exactFeedAddressRowCount, 1);
  assert.deepStrictEqual(wiring.rows.map((x) => [x.chainId, x.mSymbol, x.underlyingSymbol, x.listed]), [[10, 'mweETH', 'weETH', true]]);
  assert.strictEqual(wiring.rows[0].feedAddress.toLowerCase(), gate.FALSE_MATCH_ADDRESS);
});

test('false match exact address derived locally', () => {
  assert.strictEqual(artifact.candidates.rows[0].address, gate.FALSE_MATCH_ADDRESS);
  assert.strictEqual(artifact.candidates.rows[0].candidateName, 'CHAINLINK_WEETH_USD_COMPOSITE_OEV_WRAPPER');
});

test('false match construction is exact ChainlinkCompositeOracle', () => {
  const row = artifact.candidates.rows[0];
  assert.strictEqual(row.construction.contractType, 'ChainlinkCompositeOracle');
  assert(row.construction.lines.some((x) => x.line === 132 && x.text.includes('new ChainlinkCompositeOracle')));
});

test('false match validation casts exact wrong type', () => {
  const row = artifact.candidates.rows[0];
  assert.strictEqual(row.validation.castType, 'ChainlinkCompositeOracle');
  assert(row.validation.lines.some((x) => x.line === 296 && x.text.includes('ChainlinkCompositeOracle')));
});

test('false match binds exact source files and line ranges', () => {
  const row = artifact.candidates.rows[0];
  assert.strictEqual(row.chainEntry.path, `${gate.TARGET_REL}/chains/10.json`);
  assert.deepStrictEqual(row.chainEntry.lines.map((x) => x.line), [178, 180]);
  assert.strictEqual(row.construction.path, `${gate.TARGET_REL}/proposals/mips/mip-x14/mip-x14.sol`);
});

test('false match classification is excluded wrong contract type', () => {
  assert.strictEqual(gate.evaluateCandidate(artifact.candidates.rows[0]), 'EXCLUDED_WRONG_CONTRACT_TYPE');
  assert.strictEqual(artifact.candidates.rows[0].classification, 'EXCLUDED_WRONG_CONTRACT_TYPE');
});

test('MIP-X56 untouched statement does not infer reviewed wrapper', () => {
  const m = artifact.candidates.rows[0].mipX56;
  assert.strictEqual(m.leavesCompositeWrappedFeedsUntouched, true);
  assert.strictEqual(m.inferenceToReviewedWrapper, false);
  assert(m.lines.some((x) => x.line === 27 && x.text.includes('left untouched')));
});

function exactCandidate() {
  return {
    address: '0x1111111111111111111111111111111111111111',
    creationPreimageExact: true,
    runtimeEvidence: null,
    constructorValues: ['a', 'b', 'c', 'd', 'e', '100', '60'],
    chainlinkOracleFeedWiringExact: true,
    listedCollateralMarketConsumptionExact: true,
    wiredSymbolMatchesCollateralUnderlying: true,
    reviewedFingerprintExact: true,
    unresolvedAddressOrTypeEvidence: false,
  };
}

test('candidate promotes only with complete exact evidence', () => {
  assert.strictEqual(gate.evaluateCandidate(exactCandidate()), 'EXACT_DEPLOYMENT_CANDIDATE');
  assert.strictEqual(gate.deriveStatus([exactCandidate()]), 'PASS_EXACT_DEPLOYMENT_CANDIDATE_ADMIT');
});

test('byte-for-byte runtime alternative can promote', () => {
  const x = exactCandidate(); x.creationPreimageExact = false; x.runtimeEvidence = 'BYTE_FOR_BYTE_EXACT';
  assert.strictEqual(gate.evaluateCandidate(x), 'EXACT_DEPLOYMENT_CANDIDATE');
});

test('immutable-normalized runtime alternative can promote', () => {
  const x = exactCandidate(); x.creationPreimageExact = false; x.runtimeEvidence = 'IMMUTABLE_NORMALIZED_EXACT';
  assert.strictEqual(gate.evaluateCandidate(x), 'EXACT_DEPLOYMENT_CANDIDATE');
});

test('address without resolved type evidence is ambiguous', () => {
  const x = { address: '0x2222222222222222222222222222222222222222', unresolvedAddressOrTypeEvidence: true };
  assert.strictEqual(gate.evaluateCandidate(x), 'AMBIGUOUS_LOCAL_CANDIDATE');
  assert.strictEqual(gate.deriveStatus([x]), 'BLOCKED_AMBIGUOUS_LOCAL_CANDIDATE');
});

test('name and selector alone never promote', () => {
  const x = { name: 'ChainlinkCompositeOEVWrapper', selector: '0x12345678', sourceShape: true, unresolvedAddressOrTypeEvidence: false };
  assert.strictEqual(gate.evaluateCandidate(x), 'INSUFFICIENT_NON_CANDIDATE_EVIDENCE');
});

test('missing byte evidence prevents exact promotion', () => {
  const x = exactCandidate(); x.creationPreimageExact = false;
  assert.notStrictEqual(gate.evaluateCandidate(x), 'EXACT_DEPLOYMENT_CANDIDATE');
});

test('all seven constructor values required for promotion', () => {
  const x = exactCandidate(); x.constructorValues.pop();
  assert.notStrictEqual(gate.evaluateCandidate(x), 'EXACT_DEPLOYMENT_CANDIDATE');
});

test('exact ChainlinkOracle feed wiring required for promotion', () => {
  const x = exactCandidate(); x.chainlinkOracleFeedWiringExact = false;
  assert.notStrictEqual(gate.evaluateCandidate(x), 'EXACT_DEPLOYMENT_CANDIDATE');
});

test('listed collateral market consumption required for promotion', () => {
  const x = exactCandidate(); x.listedCollateralMarketConsumptionExact = false;
  assert.notStrictEqual(gate.evaluateCandidate(x), 'EXACT_DEPLOYMENT_CANDIDATE');
});

test('wired symbol must match listed collateral underlying', () => {
  const x = exactCandidate(); x.wiredSymbolMatchesCollateralUnderlying = false;
  assert.notStrictEqual(gate.evaluateCandidate(x), 'EXACT_DEPLOYMENT_CANDIDATE');
});

test('reviewed fingerprint exactness required for promotion', () => {
  const x = exactCandidate(); x.reviewedFingerprintExact = false;
  assert.notStrictEqual(gate.evaluateCandidate(x), 'EXACT_DEPLOYMENT_CANDIDATE');
});

test('all excluded candidates deterministically close', () => {
  assert.strictEqual(gate.deriveStatus(artifact.candidates.rows), gate.STATUS);
  assert.strictEqual(artifact.status, 'CLOSE_NO_EXACT_LOCAL_DEPLOYMENT_CANDIDATE');
});

test('source witness is below threshold and not current economics', () => {
  assert.strictEqual(artifact.economics.sourceWitnessUsd, 100);
  assert.strictEqual(artifact.economics.materialUsdThreshold, 10000);
  assert.strictEqual(artifact.economics.belowThreshold, true);
  assert.strictEqual(artifact.economics.currentDeploymentEconomics, false);
  assert.match(artifact.economics.wording, /not current deployment economics/);
});

test('route executable economics signing and fork gates fail closed', () => {
  assert.strictEqual(artifact.routePositive, 'unknown');
  assert.strictEqual(artifact.executableNow, 'unknown');
  assert.strictEqual(artifact.economicsAssessed, false);
  assert.strictEqual(artifact.signedActionJustified, false);
  assert.strictEqual(artifact.fork, false);
});

test('network runner admission false and close rotate', () => {
  assert.strictEqual(artifact.admission.networkRunnerAdmitted, false);
  assert.strictEqual(artifact.admission.admitted, false);
  assert.strictEqual(artifact.nextAction, 'CLOSE_ROTATE');
});

test('no build network RPC package manager signing tx state or coordination', () => {
  for (const key of ['networkAttempted', 'rpcAttempted', 'buildPerformed', 'forgeInvoked', 'packageManagerInvoked', 'signingAttempted', 'transactionAttempted', 'stateReadOrMutationAttempted', 'protectedFilesRead', 'coordinationReadOrWritten']) assert.strictEqual(artifact[key], false);
});

test('artifact validator rejects false exact count promotion', () => {
  const x = clone(artifact); x.candidates.exact = 1;
  rejects(() => gate.validateArtifactData(x), /candidate counts/);
});

test('artifact validator rejects admission mutation', () => {
  const x = clone(artifact); x.admission.admitted = true;
  rejects(() => gate.validateArtifactData(x), /admission/);
});

test('manifest metadata binds source package search and Git evidence', () => {
  assert.strictEqual(manifest.metadata.sourceCommit, gate.EXACT_COMMIT);
  assert.strictEqual(manifest.metadata.step1PackageFileCount, 30);
  assert.strictEqual(manifest.metadata.localSearchFileCount, artifact.search.localTracked.searchedFileCount);
  assert.strictEqual(manifest.metadata.retainedArtifactSearchFileCount, 31);
  assert.strictEqual(manifest.metadata.gitObjectCount, 1317);
});

test('manifest exact order count and no duplicates', () => {
  assert.strictEqual(manifest.fileCount, manifest.files.length);
  assert.deepStrictEqual(manifest.exactPathOrder, manifest.files.map((x) => x.path));
  assert.strictEqual(new Set(manifest.exactPathOrder).size, manifest.fileCount);
});

test('manifest includes tool artifact report and excludes self hash', () => {
  assert.deepStrictEqual(manifest.exactPathOrder.slice(0, 4), [`tools/analyze-${gate.ID}.js`, `tools/test-${gate.ID}.js`, gate.OUTPUT_PATHS.artifact, gate.OUTPUT_PATHS.report]);
  assert.strictEqual(manifest.manifestSelfHashExcluded, true);
  assert(!manifest.exactPathOrder.includes(gate.OUTPUT_PATHS.manifest));
});

test('manifest order mutation rejected', () => {
  const x = clone(manifest); [x.files[0], x.files[1]] = [x.files[1], x.files[0]];
  rejects(() => gate.validateManifestData(x, manifest), /exact order|deterministic/);
});

test('manifest duplicate path rejected', () => {
  const x = clone(manifest); x.exactPathOrder[1] = x.exactPathOrder[0]; x.files[1].path = x.files[0].path;
  rejects(() => gate.validateManifestData(x), /duplicate path/);
});

test('manifest omission rejected', () => {
  const x = clone(manifest); x.files.pop();
  rejects(() => gate.validateManifestData(x), /exact order\/count/);
});

test('manifest hash mutation rejected', () => {
  const x = clone(manifest); x.files[0].sha256 = '11'.repeat(32);
  rejects(() => gate.validateManifestData(x), /aggregate hash/);
});

test('report bytes exactly bound by artifact and manifest metadata', () => {
  assert.strictEqual(gate.sha256(bundle.reportBytes), artifact.reportBinding.sha256);
  assert.strictEqual(manifest.metadata.reportSha256, artifact.reportBinding.sha256);
});

test('report byte mutation is detected', () => {
  assert.notStrictEqual(gate.sha256(Buffer.concat([bundle.reportBytes, Buffer.from('x')])), artifact.reportBinding.sha256);
});

test('immutable no-replace output generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonwell-gate0-'));
  try {
    fs.writeFileSync(path.join(dir, 'x'), 'original');
    rejects(() => gate.writeNoReplace(dir, [['x', Buffer.from('replacement')]]), /refuses existing output/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'x'), 'utf8'), 'original');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

if (!process.exitCode) process.stdout.write(`PASS tests=${passed} status=${artifact.status} candidates=${artifact.candidates.total} exact=${artifact.candidates.exact} excluded=${artifact.candidates.excludedWrongType} searched=${artifact.search.localTracked.searchedFileCount} objects=${artifact.search.git.objects.count}\n`);
