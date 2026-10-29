#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const v1 = require('./analyze-critical-fraxlend-fraxtal-equal-bound-oracle-applicability-gate0-step6.js');

const ROOT = path.resolve(__dirname, '..');
const V1_ID = v1.ID;
const ID = `${V1_ID}-r2`;
const VERSION = '2.0.0';
const VERSION_DISPOSITION = 'R2_REPLACES_V1';
const MODE = v1.MODE;
const STATUS = 'CLOSE_NO_EXACT_MATERIAL_RETAINED_ROW';
const GENERATED_AT = '2026-08-08T00:00:00.000Z';

const OUTPUT_PATHS = Object.freeze({
  artifact: `reports/raw/fast/${ID}.json`,
  manifest: `reports/raw/fast/${ID}-manifest.json`,
  report: `reports/${ID}.md`,
});

const V1_HASHES = Object.freeze({
  [`tools/analyze-${V1_ID}.js`]: '8fd5d73a31c3215f6bc88dcb50af1118864d3ef78634a24ead0220c7f9111a0d',
  [`tools/test-${V1_ID}.js`]: 'b40fcc58d3d3feaec8942fcdee8b369e68dca36789d60f434067c5f46516aaef',
  [`reports/raw/fast/${V1_ID}.json`]: '187b3e0473d9f9f7b775bd170aed72c86a0c0537b4dbce8afb1fd43172da0a3f',
  [`reports/raw/fast/${V1_ID}-manifest.json`]: 'e9a4871b8908397cee3db02ad669af4d71d27d792f61fcaf9e2b24b5fdaad4f8',
  [`reports/${V1_ID}.md`]: 'abbeac8b25512323ad0478002e61325664c9b6ee3960e0240ddf013faa13b67b',
});

const SOURCE_LINE_MAP = Object.freeze({
  oracleTypeEqualsOne: Object.freeze([50]),
  maxOracleDelayReturned: Object.freeze([41]),
  baseTokenReturned: Object.freeze([34]),
  quoteTokenReturned: Object.freeze([35]),
  uniV3PairReturned: Object.freeze([44]),
  twapDurationReturned: Object.freeze([45]),
  decimalsEquals18: Object.freeze([48, 161, 162, 163]),
  getPricesReturned: Object.freeze([143]),
});

const SCANNER_LINE_MAP = Object.freeze({
  ethCallLatest: Object.freeze([234, 235, 236, 237]),
  ethGetCodeLatest: Object.freeze([265, 266, 267, 268]),
  transportFailureCapture: Object.freeze([226, 227, 228, 229, 230, 231]),
  nullConflation: Object.freeze([226, 227, 228, 229, 230, 231, 234, 235, 236, 237, 240, 241, 242, 245, 246, 247, 250, 251, 252]),
  requiredObservationLines: Object.freeze({
    oracleTypeEqualsOne: Object.freeze([468, 472, 482]),
    maxOracleDelayReturned: Object.freeze([468, 473, 483]),
    baseTokenReturned: Object.freeze([500, 516, 522, 523, 524, 525]),
    quoteTokenReturned: Object.freeze([500, 517, 522, 523, 524, 525]),
    uniV3PairReturned: Object.freeze([500, 518, 522, 523, 524, 525]),
    twapDurationReturned: Object.freeze([529, 530]),
    decimalsEquals18: Object.freeze([468, 471, 481]),
    getPricesReturned: Object.freeze([468, 475, 485, 492, 493, 494, 495, 496, 497]),
    runtimeCodeBytes: Object.freeze([468, 469, 479]),
  }),
});

function invariant(value, message) { if (!value) throw new Error(message); }
function workspacePath(root, relPath) { return path.join(root, ...relPath.split('/')); }
function read(root, relPath) { return fs.readFileSync(workspacePath(root, relPath)); }
function readJson(root, relPath) { return JSON.parse(read(root, relPath).toString('utf8')); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function aggregate(records) { return sha256(Buffer.from(records.map((x) => `${x.sha256}  ${x.path}\n`).join(''))); }
function hashRecord(root, relPath, role) { const bytes = read(root, relPath); return { path: relPath, role, bytes: bytes.length, sha256: sha256(bytes) }; }

function verifyV1(root = ROOT) {
  return Object.entries(V1_HASHES).map(([relPath, expected]) => {
    const record = hashRecord(root, relPath, 'immutable-v1-predecessor');
    invariant(record.sha256 === expected, `v1 immutability drift: ${relPath}`);
    return record;
  });
}

function verifyOriginalInputs(root = ROOT) {
  return Object.entries(v1.INPUTS).map(([name, item]) => {
    const record = hashRecord(root, item.path, `original-authority-${name}`);
    invariant(record.sha256 === item.sha256, `original authority hash drift: ${name}`);
    return record;
  });
}

function exactClassificationCounts() {
  return { EXACT_GENERIC_EQUAL_BOUND: 0, WRONG_TYPE: 1, UNKNOWN: 16 };
}

function buildArtifact(root = ROOT) {
  const immutableV1Files = verifyV1(root);
  const originalAuthorityInputs = verifyOriginalInputs(root);
  const artifact = v1.buildArtifact(root);
  artifact.schemaVersion = 2;
  artifact.version = VERSION;
  artifact.findingId = ID;
  artifact.generatedAt = GENERATED_AT;
  artifact.versionMetadata = {
    disposition: VERSION_DISPOSITION,
    predecessorFindingId: V1_ID,
    v1Preservation: 'V1_PACKAGE_BYTE_IDENTICAL',
    immutableNoReplace: true,
    immutableV1Files,
    immutableV1AggregateSha256: aggregate(immutableV1Files),
  };
  artifact.authority.originalSixInputs = originalAuthorityInputs;
  artifact.authority.genericSourceSemantics.requiredGetterLines = JSON.parse(JSON.stringify(SOURCE_LINE_MAP));
  artifact.authority.genericSourceSemantics.badDataEqualBoundLines = [143, 154, 156, 157, 158];
  artifact.authority.retainedScannerSemantics = {
    path: v1.INPUTS.retainedScanner.path,
    sha256: v1.INPUTS.retainedScanner.sha256,
    ...JSON.parse(JSON.stringify(SCANNER_LINE_MAP)),
  };
  artifact.genericApplicabilityGate.classificationCounts = exactClassificationCounts();
  artifact.gates = {
    routePositive: 'unknown',
    executableNow: 'unknown',
    signedActionJustified: false,
    fork: false,
    economics: 'UNASSESSED',
  };
  artifact.targetEdited = false;
  artifact.stateReadOrMutationAttempted = false;
  artifact.coordinationWritten = false;
  artifact.nextAction = 'CLOSE_ROTATE';
  artifact.status = STATUS;
  validateArtifactData(artifact);
  return artifact;
}

function validateArtifactData(artifact) {
  invariant(artifact.schemaVersion === 2 && artifact.version === VERSION && artifact.findingId === ID, 'R2 artifact identity');
  invariant(artifact.versionMetadata?.disposition === VERSION_DISPOSITION, 'R2 replacement metadata');
  invariant(artifact.versionMetadata?.predecessorFindingId === V1_ID && artifact.versionMetadata?.v1Preservation === 'V1_PACKAGE_BYTE_IDENTICAL', 'R2 predecessor metadata');
  invariant(artifact.versionMetadata?.immutableNoReplace === true, 'R2 immutable no-replace metadata');
  invariant(artifact.versionMetadata?.immutableV1Files?.length === 5, 'R2 predecessor file count');
  invariant(artifact.versionMetadata.immutableV1AggregateSha256 === aggregate(artifact.versionMetadata.immutableV1Files), 'R2 predecessor aggregate');
  invariant(artifact.authority?.inputs?.length === 6 && artifact.authority?.originalSixInputs?.length === 6, 'original six authority inputs');
  invariant(same(artifact.authority.genericSourceSemantics.requiredGetterLines, SOURCE_LINE_MAP), 'exact generic source-line map');
  invariant(same(artifact.authority.genericSourceSemantics.badDataEqualBoundLines, [143, 154, 156, 157, 158]), 'exact bad-data source lines');
  const scanner = artifact.authority.retainedScannerSemantics;
  invariant(scanner.path === v1.INPUTS.retainedScanner.path && scanner.sha256 === v1.INPUTS.retainedScanner.sha256, 'scanner authority binding');
  invariant(same(scanner.ethCallLatest, SCANNER_LINE_MAP.ethCallLatest), 'scanner eth_call latest lines');
  invariant(same(scanner.ethGetCodeLatest, SCANNER_LINE_MAP.ethGetCodeLatest), 'scanner eth_getCode latest lines');
  invariant(same(scanner.transportFailureCapture, SCANNER_LINE_MAP.transportFailureCapture), 'scanner transport failure lines');
  invariant(same(scanner.nullConflation, SCANNER_LINE_MAP.nullConflation) && scanner.nullConflation.includes(237), 'scanner null conflation lines');
  invariant(same(scanner.requiredObservationLines, SCANNER_LINE_MAP.requiredObservationLines), 'scanner observation line map');
  invariant(artifact.inventory.rows === 17 && artifact.rows.length === 17 && new Set(artifact.rows.map((x) => x.pair)).size === 17, 'exact seventeen rows');
  invariant(same(artifact.genericApplicabilityGate.classificationCounts, exactClassificationCounts()), 'exact classification counts');
  invariant(artifact.rows.filter((x) => x.classification === 'EXACT_GENERIC_EQUAL_BOUND').length === 0, 'false exact row');
  invariant(artifact.rows.filter((x) => x.classification === 'WRONG_TYPE').length === 1, 'wrong-type count');
  invariant(artifact.rows.filter((x) => x.classification === 'UNKNOWN').length === 16, 'unknown count');
  invariant(artifact.rows.every((x) => x.admitted === false) && artifact.admission.admitted === false && artifact.admission.admittedRows.length === 0, 'false admission');
  invariant(artifact.status === STATUS && artifact.nextAction === 'CLOSE_ROTATE', 'R2 close/rotate status');
  invariant(artifact.routePositive === 'unknown' && artifact.executableNow === 'unknown', 'route/executable gates');
  invariant(artifact.signedActionJustified === false && artifact.fork === false && artifact.economicsAssessed === false, 'signing/fork/economics gates');
  invariant(same(artifact.gates, { routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: false, fork: false, economics: 'UNASSESSED' }), 'canonical R2 gates');
  invariant(artifact.scope.blockPinned === false && artifact.scope.scannerCallTag === 'latest' && /single-provider/.test(artifact.scope.warning), 'historical unpinned latest single-provider caveat');
  invariant(artifact.limitations.some((x) => /Null selector observations conflate/.test(x)), 'null conflation caveat');
  invariant(artifact.limitations.some((x) => /not a global absence claim/.test(x) && /does not refute/.test(x)), 'no global absence/source refutation caveat');
  for (const key of ['networkAttempted', 'rpcAttempted', 'protectedFilesRead', 'buildPerformed', 'forgeInvoked', 'packageManagerInvoked', 'signingAttempted', 'transactionAttempted', 'stateMutationAttempted', 'targetEdited', 'stateReadOrMutationAttempted', 'coordinationWritten']) invariant(artifact[key] === false, `offline safety gate: ${key}`);
  return true;
}

function renderReport(artifact) {
  return Buffer.from([
    '# Fraxlend Fraxtal Equal-Bound Oracle Applicability Gate0 Step6-R2', '',
    'Date: 2026-08-08', '',
    `Version disposition: \`${VERSION_DISPOSITION}\` (immutable v1 package preserved byte-identically).`, '',
    `Status: **${STATUS}**  `,
    'Next action: **CLOSE_ROTATE**.', '',
    '## Corrected source-line authority', '',
    'The eight claimed generic observations now map only to their actual source authority:', '',
    '- `oracleTypeEqualsOne`: `DualOracleChainlinkUniV3.sol:50`',
    '- `maxOracleDelayReturned`: `:41`',
    '- `baseTokenReturned`: `:34`',
    '- `quoteTokenReturned`: `:35`',
    '- `uniV3PairReturned`: `:44`',
    '- `twapDurationReturned`: `:45`',
    '- `decimalsEquals18`: constant `:48` and `decimals()` `:161-163`',
    '- `getPricesReturned`: `:143`', '',
    'The bad-data equal-bound semantics are bound at `:143,154,156-158`. No unrelated Chainlink address or name declarations are presented as required getter authority.', '',
    'The retained scanner authority explicitly binds `eth_call(..., "latest")` at `scan-fraxlend-live.js:234-237`, including failure-to-`null` line 237, and `eth_getCode(..., "latest")` plus code-length/error handling at `:265-268`. The artifact also binds the complete transport/null propagation and each retained generic observation probe line map.', '',
    '## Retained classification and conclusion', '',
    '- exact generic equal-bound rows: `0`',
    '- wrong-type rows: `1`',
    '- unknown rows: `16`',
    '- admitted rows: `0`', '',
    'The retained deployer, registry, and inspected Pair inventory remains exactly 17 rows. The sole wrong-type row is Pair `0xb71e4829e81f72f7f36a0d858e58109f5948a713`, oracle `0x42805079ed5ff38c0a5a47f38c83f96d348609aa`, whose successful retained `getPrices()` returned bad data with unequal bounds. The other 16 rows remain unknown; null probes do not prove absence or wrong type.', '',
    '## Evidence boundary', '',
    'The retained scan is historical, unpinned, non-finality-bound, uses `latest`, and is single-provider. It stores code length rather than runtime bytes/hash. Call failure/revert and RPC/transport failure can both become `null`. No current route or execution claim follows.', '',
    '- `routePositive="unknown"`; `executableNow="unknown"`',
    '- `signedActionJustified=false`; `fork=false`',
    '- economics: `UNASSESSED`; `economicsAssessed=false`',
    '- no target, state, or coordination edit; no network, RPC, build, package manager, signing, or transaction was attempted', '',
    '**Close/rotate Gate0.** This is not a global Fraxtal deployment-absence claim and does not refute the source-local generic finding. Reopen only with reviewed fixed-block runtime/source/build/immutable binding and conservative positive material economics.', '',
  ].join('\n'));
}

function manifestPaths() {
  return [
    `tools/analyze-${ID}.js`,
    `tools/test-${ID}.js`,
    OUTPUT_PATHS.artifact,
    OUTPUT_PATHS.report,
    ...Object.keys(V1_HASHES),
    ...Object.values(v1.INPUTS).map((x) => x.path),
  ];
}

function roleFor(relPath) {
  if (relPath === `tools/analyze-${ID}.js` || relPath === `tools/test-${ID}.js`) return 'r2-gate-tool';
  if (relPath === OUTPUT_PATHS.artifact) return 'r2-gate-artifact';
  if (relPath === OUTPUT_PATHS.report) return 'r2-gate-report';
  if (Object.hasOwn(V1_HASHES, relPath)) return 'immutable-v1-predecessor';
  return 'original-authority-input';
}

function buildBundle(root = ROOT) {
  const artifact = buildArtifact(root);
  const reportBytes = renderReport(artifact);
  artifact.reportBinding = { path: OUTPUT_PATHS.report, bytes: reportBytes.length, sha256: sha256(reportBytes) };
  validateArtifactData(artifact);
  const artifactBytes = jsonBytes(artifact);
  const paths = manifestPaths();
  invariant(new Set(paths).size === paths.length, 'manifest duplicate path');
  invariant(!paths.includes(OUTPUT_PATHS.manifest), 'manifest self path included');
  const memory = new Map([[OUTPUT_PATHS.artifact, artifactBytes], [OUTPUT_PATHS.report, reportBytes]]);
  const files = paths.map((relPath) => {
    const bytes = memory.get(relPath) || read(root, relPath);
    return { path: relPath, role: roleFor(relPath), bytes: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = {
    schemaVersion: 2,
    version: VERSION,
    findingId: ID,
    generatedAt: GENERATED_AT,
    mode: MODE,
    versionDisposition: VERSION_DISPOSITION,
    algorithm: 'sha256',
    manifestSelfHashExcluded: true,
    immutableNoReplaceGeneration: true,
    predecessorReplacementPolicy: 'NO_REPLACE',
    exactPathOrder: paths,
    fileCount: files.length,
    files,
    aggregateSha256: aggregate(files),
    metadata: {
      sourceCommit: v1.EXACT_COMMIT,
      sourceTree: v1.EXACT_TREE,
      chainId: 252,
      retainedRows: 17,
      exactGenericRows: 0,
      wrongTypeRows: 1,
      unknownRows: 16,
      admittedRows: 0,
      immutableV1Files: 5,
      originalAuthorityInputs: 6,
      immutableV1AggregateSha256: aggregate(files.filter((x) => x.role === 'immutable-v1-predecessor')),
      networkAttempted: false,
      rpcAttempted: false,
      signedActionJustified: false,
      fork: false,
      economics: 'UNASSESSED',
      targetEdited: false,
      stateReadOrMutationAttempted: false,
      coordinationWritten: false,
    },
  };
  validateManifestData(manifest);
  return { artifact, artifactBytes, reportBytes, manifest, manifestBytes: jsonBytes(manifest) };
}

function validateManifestData(manifest, expected) {
  invariant(manifest.schemaVersion === 2 && manifest.version === VERSION && manifest.findingId === ID, 'R2 manifest identity');
  invariant(manifest.versionDisposition === VERSION_DISPOSITION, 'manifest replacement metadata');
  invariant(manifest.manifestSelfHashExcluded === true && manifest.immutableNoReplaceGeneration === true && manifest.predecessorReplacementPolicy === 'NO_REPLACE', 'manifest self-exclusion/no-replace');
  invariant(manifest.fileCount === manifest.files.length && manifest.exactPathOrder.length === manifest.files.length, 'manifest file count');
  invariant(same(manifest.exactPathOrder, manifest.files.map((x) => x.path)), 'manifest exact order');
  invariant(same(manifest.exactPathOrder, manifestPaths()), 'manifest expected path order');
  invariant(new Set(manifest.exactPathOrder).size === manifest.fileCount, 'manifest duplicate path');
  invariant(!manifest.exactPathOrder.includes(OUTPUT_PATHS.manifest), 'manifest self path included');
  invariant(manifest.fileCount === 15, 'manifest exact file count');
  invariant(manifest.files.filter((x) => x.role === 'immutable-v1-predecessor').length === 5, 'manifest v1 predecessor count');
  invariant(manifest.files.filter((x) => x.role === 'original-authority-input').length === 6, 'manifest original authority count');
  invariant(manifest.metadata.immutableV1Files === 5 && manifest.metadata.originalAuthorityInputs === 6, 'manifest authority metadata counts');
  invariant(manifest.metadata.retainedRows === 17 && manifest.metadata.exactGenericRows === 0 && manifest.metadata.wrongTypeRows === 1 && manifest.metadata.unknownRows === 16 && manifest.metadata.admittedRows === 0, 'manifest conclusion counts');
  invariant(manifest.metadata.targetEdited === false && manifest.metadata.stateReadOrMutationAttempted === false && manifest.metadata.coordinationWritten === false, 'manifest target/state/coordination safety');
  invariant(manifest.aggregateSha256 === aggregate(manifest.files), 'manifest aggregate');
  invariant(manifest.metadata.immutableV1AggregateSha256 === aggregate(manifest.files.filter((x) => x.role === 'immutable-v1-predecessor')), 'manifest v1 aggregate');
  for (const record of manifest.files.filter((x) => x.role === 'immutable-v1-predecessor')) invariant(record.sha256 === V1_HASHES[record.path], `manifest v1 hash: ${record.path}`);
  if (expected) invariant(same(manifest, expected), 'manifest deterministic deep equality');
  return true;
}

function validateBundle(root = ROOT) {
  const expected = buildBundle(root);
  const persistedArtifact = readJson(root, OUTPUT_PATHS.artifact);
  const persistedManifest = readJson(root, OUTPUT_PATHS.manifest);
  invariant(same(persistedArtifact, expected.artifact), 'persisted artifact deep equality');
  invariant(same(persistedManifest, expected.manifest), 'persisted manifest deep equality');
  invariant(read(root, OUTPUT_PATHS.artifact).equals(expected.artifactBytes), 'persisted artifact byte equality');
  invariant(read(root, OUTPUT_PATHS.manifest).equals(expected.manifestBytes), 'persisted manifest byte equality');
  invariant(read(root, OUTPUT_PATHS.report).equals(expected.reportBytes), 'persisted report byte equality');
  validateArtifactData(persistedArtifact);
  validateManifestData(persistedManifest, expected.manifest);
  for (const record of persistedManifest.files) {
    const bytes = read(root, record.path);
    invariant(bytes.length === record.bytes && sha256(bytes) === record.sha256, `manifest file drift: ${record.path}`);
  }
  return { artifact: persistedArtifact, manifest: persistedManifest };
}

function writeNoReplace(root, entries) {
  for (const [relPath] of entries) invariant(!fs.existsSync(workspacePath(root, relPath)), `immutable generation refuses existing output: ${relPath}`);
  for (const [relPath, bytes] of entries) fs.writeFileSync(workspacePath(root, relPath), bytes, { flag: 'wx' });
}

function generate(root = ROOT) {
  const bundle = buildBundle(root);
  writeNoReplace(root, [[OUTPUT_PATHS.report, bundle.reportBytes], [OUTPUT_PATHS.artifact, bundle.artifactBytes], [OUTPUT_PATHS.manifest, bundle.manifestBytes]]);
  return bundle;
}

function main() {
  const args = process.argv.slice(2);
  invariant(args.length <= 1 && (args.length === 0 || args[0] === '--check-only'), 'usage: analyzer [--check-only]');
  if (args[0] === '--check-only') {
    const result = validateBundle(ROOT);
    process.stdout.write(`PASS ${ID} check-only files=${result.manifest.fileCount} aggregate=${result.manifest.aggregateSha256}\n`);
  } else {
    const result = generate(ROOT);
    process.stdout.write(`WROTE ${ID} files=3 manifestFiles=${result.manifest.fileCount} aggregate=${result.manifest.aggregateSha256}\n`);
  }
}

if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`FAIL ${error.message}\n`); process.exitCode = 1; } }

module.exports = {
  GENERATED_AT, ID, MODE, OUTPUT_PATHS, ROOT, SCANNER_LINE_MAP, SOURCE_LINE_MAP, STATUS, VERSION, VERSION_DISPOSITION, V1_HASHES, V1_ID,
  aggregate, buildArtifact, buildBundle, exactClassificationCounts, generate, manifestPaths, renderReport, sha256, validateArtifactData,
  validateBundle, validateManifestData, verifyOriginalInputs, verifyV1, writeNoReplace,
};
