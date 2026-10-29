#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ID = 'critical-moonwell-composite-oev-deployment-prefilter-step2';
const TARGET_REL = 'targets/moonwell-contracts-4a5a10c-step1';
const TARGET = path.join(ROOT, ...TARGET_REL.split('/'));
const MODE = 'OFFLINE_ONLY_DETERMINISTIC_LOCAL_PROVENANCE_GATE0';
const STATUS = 'CLOSE_NO_EXACT_LOCAL_DEPLOYMENT_CANDIDATE';
const GENERATED_AT = '2026-08-07T00:00:00.000Z';
const EXACT_COMMIT = '4a5a10c0ef64395d7deb1d0c2fcd4d56510b8d3e';
const EXACT_TREE = '84572b0da2e7b0d6b04c249ee78499caf501c95e';
const FALSE_MATCH_ADDRESS = '0xecd80fbc47b1689445a1adfc278bcb41eb9bc766';
const WRAPPER_PATH = `${TARGET_REL}/src/oracles/ChainlinkCompositeOEVWrapper.sol`;
const WRAPPER_SHA256 = '6827d8f0d96fe5148880a71c02bb8464f2e406645c6dba3c27eabd3ec380f688';
const STEP1_REPORT = 'reports/critical-moonwell-composite-oev-liquidation-accounting-step1.md';
const STEP1_REPORT_SHA256 = 'b2550de0147d1c37c534e29e46460852a446cdfdac05406fad1b74de137a4c21';
const STEP1_RAW = 'reports/raw/fast/critical-moonwell-composite-oev-liquidation-accounting-step1';
const STEP1_RESULTS_SHA256 = 'b09b5e1a7ac5aac5e0b0a0fab36ed4ee3514ab776ba3d4b3eee9dffb8a794e46';
const STEP1_SUMS_SHA256 = 'bf2a926ecfda8dc7a36a1d4f7769858f5f9f038ade3a915925b653c8388a0358';
const PHASE0_PATH = 'reports/raw/fast/moonwell-lending-phase0.json';
const PHASE0_SHA256 = 'ec2b2b27bd4584fc595df9bc00c2385bc2c5065d06eb3afb5e4cc4093662009e';

const OUTPUT_PATHS = Object.freeze({
  artifact: `reports/raw/fast/${ID}.json`,
  manifest: `reports/raw/fast/${ID}-manifest.json`,
  report: `reports/${ID}.md`,
});

const DECLARED_SAFE_ROOTS = Object.freeze([
  'src/', 'script/', 'proposals/', 'chains/', 'broadcast/',
  'deployments/', 'deployment/', 'artifacts/', 'out/', 'cache/',
  'deprecated/artifacts/', 'docs/deployment/',
]);

const SECRET_PATTERNS = Object.freeze([
  '.env', '.env.*', 'rpc_endpoints.txt', 'graphql_endpoints.txt',
  'key/keys files', '*.pem', '*keypair*.json',
]);

const DIRTY_EXPECTED = Object.freeze([
  'test/audit/ChainlinkCompositeHAL02MetadataAudit.t.sol',
  'test/audit/CompositeOEVAncientCacheTransitionAudit.t.sol',
  'test/audit/CompositeOEVLendingImpactAudit.t.sol',
]);

const CONSTRUCTOR_DEPENDENCIES = Object.freeze([
  `${TARGET_REL}/lib/openzeppelin-contracts/contracts/access/Ownable.sol`,
  `${TARGET_REL}/lib/openzeppelin-contracts/contracts/security/ReentrancyGuard.sol`,
  `${TARGET_REL}/lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol`,
  `${TARGET_REL}/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol`,
  `${TARGET_REL}/src/oracles/AggregatorV3Interface.sol`,
  `${TARGET_REL}/src/MTokenInterfaces.sol`,
  `${TARGET_REL}/src/EIP20Interface.sol`,
  `${TARGET_REL}/src/interfaces/IChainlinkOracle.sol`,
]);

const CONSTRUCTOR_ARGUMENTS = Object.freeze([
  { index: 1, parameter: '_compositeOracle', type: 'address', destination: 'compositeOracle', distinction: 'MUTABLE_STORAGE_REFERENCE', initialization: 'also seeds cachedCompositePrice/cachedTimestamp through latestRoundData' },
  { index: 2, parameter: '_baseFeed', type: 'address', destination: 'baseFeed', distinction: 'MUTABLE_STORAGE_REFERENCE', initialization: 'also seeds cachedBaseRoundId through latestRoundData' },
  { index: 3, parameter: '_owner', type: 'address', destination: 'Ownable._owner', distinction: 'PRIVATE_MUTABLE_STORAGE_VIA_TRANSFER_OWNERSHIP' },
  { index: 4, parameter: '_chainlinkOracle', type: 'address', destination: 'chainlinkOracle', distinction: 'IMMUTABLE' },
  { index: 5, parameter: '_feeRecipient', type: 'address', destination: 'feeRecipient', distinction: 'MUTABLE_STORAGE' },
  { index: 6, parameter: '_liquidatorFeeBps', type: 'uint16', destination: 'liquidatorFeeBps', distinction: 'MUTABLE_STORAGE' },
  { index: 7, parameter: '_maxRoundDelay', type: 'uint256', destination: 'maxRoundDelay', distinction: 'MUTABLE_STORAGE' },
]);

function invariant(value, message) { if (!value) throw new Error(message); }
function rel(root, p) { return path.join(root, ...p.split('/')); }
function read(root, p) { return fs.readFileSync(rel(root, p)); }
function json(root, p) { return JSON.parse(read(root, p).toString('utf8')); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function aggregate(records) { return sha256(Buffer.from(records.map((x) => `${x.sha256}  ${x.path}\n`).join(''))); }
function hashRecord(root, p, role) { const b = read(root, p); return { path: p, role, bytes: b.length, sha256: sha256(b) }; }
function git(args, options = {}) { return execFileSync('git', args, { cwd: TARGET, encoding: 'utf8', ...options }).replace(/\r\n/g, '\n'); }
function lines(body) { return body.split(/\r?\n/); }
function normalize(p) { return p.replace(/\\/g, '/'); }

function isSecretPath(p) {
  const parts = normalize(p).toLowerCase().split('/');
  const base = parts[parts.length - 1];
  return base === '.env' || base.startsWith('.env.') || base === 'rpc_endpoints.txt' ||
    base === 'graphql_endpoints.txt' || base.endsWith('.pem') ||
    base.includes('keypair') && base.endsWith('.json') ||
    /(^|[._-])(?:key|keys|private[-_]?key|secret[-_]?key|signing[-_]?key)([._-]|$)/.test(base);
}

function isSafeTrackedPath(p) {
  const n = normalize(p);
  return DECLARED_SAFE_ROOTS.some((root) => n.startsWith(root)) || n.endsWith('/moonwell-lending-phase0.json') || n === 'moonwell-lending-phase0.json';
}

function listStep1Package(root = ROOT) {
  const base = rel(root, STEP1_RAW);
  const raw = fs.readdirSync(base, { withFileTypes: true });
  invariant(raw.every((x) => x.isFile()), 'Step1 raw package contains unexpected non-file');
  return [STEP1_REPORT, ...raw.map((x) => `${STEP1_RAW}/${x.name}`).sort()];
}

function verifyStep1Authority(root = ROOT) {
  const records = listStep1Package(root).map((p) => hashRecord(root, p, 'immutable-step1-authority-package'));
  const byPath = new Map(records.map((x) => [x.path, x]));
  invariant(records.length === 30, 'Step1 exact report/raw package file count');
  invariant(byPath.get(STEP1_REPORT).sha256 === STEP1_REPORT_SHA256, 'Step1 report authority hash drift');
  invariant(byPath.get(`${STEP1_RAW}/results.json`).sha256 === STEP1_RESULTS_SHA256, 'Step1 results authority hash drift');
  invariant(byPath.get(`${STEP1_RAW}/SHA256SUMS.txt`).sha256 === STEP1_SUMS_SHA256, 'Step1 checksums authority hash drift');
  const sums = read(root, `${STEP1_RAW}/SHA256SUMS.txt`).toString('utf8');
  for (const record of records.filter((x) => x.path !== `${STEP1_RAW}/SHA256SUMS.txt`)) {
    if (record.path.startsWith(`${STEP1_RAW}/`)) {
      invariant(sums.includes(`${record.sha256}  ${record.path}`), `Step1 checksum package omission/drift: ${record.path}`);
    }
  }
  return { records, fileCount: records.length, aggregateSha256: aggregate(records), retainedChecksumInventoryReportSha256: '3514b115a16c3c40d83bacf5b3144cabb9d6bd58182c5f5dc041bec04e1113aa', currentReportSha256: STEP1_REPORT_SHA256, retainedChecksumInventoryMatchesCurrentReport: false };
}

function verifySourceIdentity() {
  const head = git(['rev-parse', 'HEAD']).trim();
  const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
  invariant(head === EXACT_COMMIT && tree === EXACT_TREE, 'exact target commit/tree drift');
  const wrapper = hashRecord(ROOT, WRAPPER_PATH, 'reviewed-wrapper-source');
  invariant(wrapper.sha256 === WRAPPER_SHA256, 'reviewed wrapper source hash drift');
  return { commit: head, tree, wrapper };
}

function verifyDirtyTruth(root = ROOT) {
  const output = git(['status', '--short', '--untracked-files=all']);
  const rows = lines(output).filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: normalize(line.slice(3)) }));
  invariant(same(rows.map((x) => x.path), DIRTY_EXPECTED) && rows.every((x) => x.status === '??'), 'target dirty truth drift');
  const records = rows.map((x) => hashRecord(root, `${TARGET_REL}/${x.path}`, 'pre-existing-untracked-audit-witness'));
  return { trackedDiffEmpty: true, stagedDiffEmpty: true, exactUntrackedOnly: rows, witnessHashes: records, aggregateSha256: aggregate(records) };
}

function trackedInventory() {
  const tracked = lines(git(['ls-files'])).filter(Boolean).sort();
  const safe = tracked.filter(isSafeTrackedPath);
  const exclusions = tracked.filter((p) => isSafeTrackedPath(p) && isSecretPath(p));
  const files = safe.filter((p) => !isSecretPath(p));
  invariant(files.every(isSafeTrackedPath) && files.every((p) => !isSecretPath(p)), 'unsafe tracked search inventory');
  return { trackedCount: tracked.length, safeBeforeExclusionCount: safe.length, files, exclusions };
}

function grepOccurrences(body, pathName) {
  const patterns = [
    ['exactContractName', /ChainlinkCompositeOEVWrapper/g],
    ['exactConstruction', /new\s+ChainlinkCompositeOEVWrapper\s*\(/g],
    ['candidateCompositeOevName', /[A-Z0-9_]*COMPOSITE[A-Z0-9_]*OEV[A-Z0-9_]*WRAPPER[A-Z0-9_]*/g],
    ['falseMatchAddress', /0xECd80fBc47b1689445a1AdFC278bCB41eb9bC766/gi],
    ['feedWiring', /setFeed\s*\(/g],
  ];
  const out = [];
  lines(body).forEach((line, index) => {
    for (const [kind, re] of patterns) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line)) !== null) {
        out.push({ path: pathName, line: index + 1, kind, token: match[0] });
        if (match[0].length === 0) break;
      }
    }
  });
  return out;
}

function searchLocalTracked(root = ROOT, inventory = trackedInventory()) {
  const records = [];
  const hits = [];
  for (const targetPath of inventory.files) {
    const workspacePath = `${TARGET_REL}/${targetPath}`;
    const body = read(root, workspacePath);
    records.push({ path: workspacePath, role: 'declared-safe-local-search', bytes: body.length, sha256: sha256(body) });
    if (!body.includes(0)) hits.push(...grepOccurrences(body.toString('utf8'), targetPath));
  }
  const exactConstructions = hits.filter((x) => x.kind === 'exactConstruction');
  return {
    declaredSafeRoots: [...DECLARED_SAFE_ROOTS],
    trackedFilesTotal: inventory.trackedCount,
    safeFilesBeforeExclusion: inventory.safeBeforeExclusionCount,
    searchedFileCount: records.length,
    searchedFilesAggregateSha256: aggregate(records),
    excludedSecretPaths: inventory.exclusions,
    excludedSecretPatterns: [...SECRET_PATTERNS],
    records,
    occurrenceCount: hits.length,
    exactConstructionCount: exactConstructions.length,
    hits,
  };
}

function searchRetainedArtifacts(root, step1) {
  const paths = [...step1.records.map((x) => x.path), PHASE0_PATH];
  invariant(new Set(paths).size === paths.length && paths.length === 31, 'retained artifact search inventory');
  const records = [], hits = [];
  for (const p of paths) {
    invariant(!isSecretPath(p), `retained artifact secret exclusion: ${p}`);
    const body = read(root, p);
    records.push({ path: p, role: 'retained-authority/artifact-search', bytes: body.length, sha256: sha256(body) });
    if (!body.includes(0)) hits.push(...grepOccurrences(body.toString('utf8'), p));
  }
  const phase = json(root, PHASE0_PATH);
  const marketRows = Array.isArray(phase.marketRows) ? phase.marketRows : [];
  const exactAddressRows = marketRows.filter((x) => String(x?.feed?.address || '').toLowerCase() === FALSE_MATCH_ADDRESS);
  const exactNameRows = hits.filter((x) => x.path === PHASE0_PATH && (x.kind === 'exactContractName' || x.kind === 'candidateCompositeOevName'));
  return {
    paths,
    searchedFileCount: records.length,
    searchedFilesAggregateSha256: aggregate(records),
    records,
    occurrenceCount: hits.length,
    hits,
    phase0ListedMarketRowsChecked: marketRows.filter((x) => x.listed === true).length,
    phase0ExactFalseMatchFeedAddressRowCount: exactAddressRows.length,
    phase0ExactFalseMatchFeedAddressRows: exactAddressRows.map((x) => ({ chain: x.chain, chainId: x.chainId, chainlinkOracle: x.oracle, mToken: x.mToken, mSymbol: x.mSymbol, underlying: x.underlying, underlyingSymbol: x.underlyingSymbol, listed: x.listed, feedAddress: x.feed.address })),
    phase0ExactWrapperNameRows: exactNameRows.length,
  };
}

function gitEvidence() {
  const refs = lines(git(['for-each-ref', '--format=%(refname) %(objectname)'])).filter(Boolean).sort();
  const history = lines(git(['log', '--all', '--format=%H %T %P'])).filter(Boolean);
  const objectLines = lines(git(['rev-list', '--all', '--objects'])).filter(Boolean);
  const checkInput = objectLines.map((x) => x.split(' ')[0]).join('\n') + '\n';
  const checked = lines(git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: checkInput })).filter(Boolean);
  const types = { commit: 0, tree: 0, blob: 0, tag: 0 };
  checked.forEach((line) => { const type = line.split(' ')[1]; if (Object.hasOwn(types, type)) types[type] += 1; });
  const typeByOid = new Map(checked.map((line) => { const fields = line.split(' '); return [fields[0], fields[1]]; }));
  const named = objectLines.map((line) => { const i = line.indexOf(' '); const oid = i < 0 ? line : line.slice(0, i); return { oid, type: typeByOid.get(oid), path: i < 0 ? null : line.slice(i + 1) }; });
  const objectSecretExclusions = named.filter((x) => x.path && isSafeTrackedPath(x.path) && isSecretPath(x.path)).map((x) => x.path);
  const safeNamedObjects = named.filter((x) => x.path && isSafeTrackedPath(x.path) && !isSecretPath(x.path));
  const safeNamedBlobs = safeNamedObjects.filter((x) => x.type === 'blob');
  invariant(history.length === 1 && refs.length === 3, 'local Git refs/history count drift');
  invariant(objectLines.length === 1317 && same(types, { commit: 1, tree: 295, blob: 1021, tag: 0 }), 'local Git object evidence count drift');
  invariant(history[0].startsWith(`${EXACT_COMMIT} ${EXACT_TREE}`), 'local Git history identity drift');

  const commits = history.map((x) => x.split(' ')[0]);
  const grepArgs = ['grep', '-I', '-n', '-E', '-e', 'ChainlinkCompositeOEVWrapper|COMPOSITE[_A-Z0-9]*OEV[_A-Z0-9]*WRAPPER|ecd80fbc47b1689445a1adfc278bcb41eb9bc766'];
  grepArgs.push(...commits, '--', ...DECLARED_SAFE_ROOTS.map((x) => x.slice(0, -1)), ...objectSecretExclusions.map((x) => `:(exclude)${x}`));
  const result = spawnSync('git', grepArgs, { cwd: TARGET, encoding: 'utf8' });
  invariant(result.status === 0 || result.status === 1, `tracked object grep failed: ${result.stderr || result.status}`);
  const grepRows = lines((result.stdout || '').replace(/\r\n/g, '\n')).filter(Boolean);
  invariant(grepRows.every((x) => !isSecretPath((x.split(':')[1] || ''))), 'secret path entered object grep results');
  return {
    refs: { count: refs.length, rows: refs, aggregateSha256: sha256(Buffer.from(refs.map((x) => `${x}\n`).join(''))) },
    history: { commitCount: history.length, rows: history, aggregateSha256: sha256(Buffer.from(history.map((x) => `${x}\n`).join(''))) },
    objects: { count: objectLines.length, typeCounts: types, safeNamedObjectCount: safeNamedObjects.length, safeNamedBlobCount: safeNamedBlobs.length, secretExclusionCount: objectSecretExclusions.length, secretExclusions: objectSecretExclusions, inventoryAggregateSha256: sha256(Buffer.from(objectLines.map((x) => `${x}\n`).join(''))), checkedAggregateSha256: sha256(Buffer.from(checked.map((x) => `${x}\n`).join(''))) },
    trackedObjectSearch: { commitCount: commits.length, searchedBlobCount: safeNamedBlobs.length, matchLineCount: grepRows.length, lines: grepRows, roots: [...DECLARED_SAFE_ROOTS], secretPatternsEnforced: true, exactSecretPathExclusionsApplied: objectSecretExclusions },
  };
}

function exactLine(body, number, expected, label) {
  const value = lines(body)[number - 1];
  invariant(value && value.includes(expected), `${label} exact line drift: ${number}`);
  return { line: number, text: value.trim() };
}

function falseMatchBinding(root = ROOT) {
  const chainPath = `${TARGET_REL}/chains/10.json`;
  const mip14Path = `${TARGET_REL}/proposals/mips/mip-x14/mip-x14.sol`;
  const mip56Path = `${TARGET_REL}/proposals/mips/mip-x56/mip-x56.sol`;
  const chainBody = read(root, chainPath).toString('utf8');
  const chain = json(root, chainPath);
  const entry = chain.find((x) => x.name === 'CHAINLINK_WEETH_USD_COMPOSITE_OEV_WRAPPER');
  invariant(entry && String(entry.addr).toLowerCase() === FALSE_MATCH_ADDRESS, 'false-match exact chain address drift');
  const m14 = read(root, mip14Path).toString('utf8');
  const m56 = read(root, mip56Path).toString('utf8');
  const construction = [132, 133, 134, 135, 136, 137, 138, 140, 141, 142, 143].map((n) => exactLine(m14, n, n === 132 ? 'new ChainlinkCompositeOracle' : n === 141 ? 'CHAINLINK_WEETH_USD_COMPOSITE_OEV_WRAPPER' : '', 'MIP-X14 construction'));
  const validation = [296, 297, 298, 299, 300, 303, 304, 305, 306, 307, 308, 310, 311, 312, 313, 315, 316, 317, 318].map((n) => exactLine(m14, n, n === 296 ? 'ChainlinkCompositeOracle' : n === 298 ? 'CHAINLINK_WEETH_USD_COMPOSITE_OEV_WRAPPER' : '', 'MIP-X14 validation'));
  const untouched = [21, 22, 23, 24, 25, 26, 27, 28].map((n) => exactLine(m56, n, n === 27 ? 'feeds and raw aggregators are left untouched' : '', 'MIP-X56 notice'));
  return {
    candidateName: entry.name,
    address: String(entry.addr).toLowerCase(),
    chainEntry: { path: chainPath, lines: [exactLine(chainBody, 178, '0xECd80fBc47b1689445a1AdFC278bCB41eb9bC766', 'chains/10 address'), exactLine(chainBody, 180, entry.name, 'chains/10 name')] },
    construction: { path: mip14Path, contractType: 'ChainlinkCompositeOracle', lines: construction },
    validation: { path: mip14Path, castType: 'ChainlinkCompositeOracle', lines: validation },
    mipX56: { path: mip56Path, leavesCompositeWrappedFeedsUntouched: true, lines: untouched, inferenceToReviewedWrapper: false },
    classification: 'EXCLUDED_WRONG_CONTRACT_TYPE',
    exactReviewedWrapper: false,
    unresolvedAddressOrTypeEvidence: false,
  };
}

function evaluateCandidate(candidate) {
  if (candidate.classification === 'EXCLUDED_WRONG_CONTRACT_TYPE' && candidate.unresolvedAddressOrTypeEvidence === false) return 'EXCLUDED_WRONG_CONTRACT_TYPE';
  const address = /^0x[0-9a-fA-F]{40}$/.test(candidate.address || '');
  const byteIdentity = candidate.creationPreimageExact === true || candidate.runtimeEvidence === 'BYTE_FOR_BYTE_EXACT' || candidate.runtimeEvidence === 'IMMUTABLE_NORMALIZED_EXACT';
  const constructor = Array.isArray(candidate.constructorValues) && candidate.constructorValues.length === 7 && candidate.constructorValues.every((x) => typeof x === 'string' && x.length > 0);
  const wiring = candidate.chainlinkOracleFeedWiringExact === true && candidate.listedCollateralMarketConsumptionExact === true && candidate.wiredSymbolMatchesCollateralUnderlying === true;
  if (address && byteIdentity && constructor && wiring && candidate.reviewedFingerprintExact === true) return 'EXACT_DEPLOYMENT_CANDIDATE';
  if (candidate.unresolvedAddressOrTypeEvidence === true || address && candidate.excluded !== true) return 'AMBIGUOUS_LOCAL_CANDIDATE';
  return 'INSUFFICIENT_NON_CANDIDATE_EVIDENCE';
}

function deriveStatus(candidates) {
  const classes = candidates.map(evaluateCandidate);
  if (classes.includes('EXACT_DEPLOYMENT_CANDIDATE')) return 'PASS_EXACT_DEPLOYMENT_CANDIDATE_ADMIT';
  if (classes.includes('AMBIGUOUS_LOCAL_CANDIDATE')) return 'BLOCKED_AMBIGUOUS_LOCAL_CANDIDATE';
  return STATUS;
}

function validateSearchCompleteness(search, inventory) {
  invariant(search.searchedFileCount === inventory.files.length, 'search completeness file count');
  invariant(same(search.records.map((x) => x.path), inventory.files.map((x) => `${TARGET_REL}/${x}`)), 'search completeness exact order');
  invariant(search.exactConstructionCount === 0, 'unexpected exact wrapper construction in declared local files');
  invariant(search.excludedSecretPaths.every(isSecretPath), 'secret exclusion classification');
  return true;
}

function makeCore(root = ROOT) {
  const step1 = verifyStep1Authority(root);
  const source = verifySourceIdentity();
  const dirty = verifyDirtyTruth(root);
  const inventory = trackedInventory();
  const localSearch = searchLocalTracked(root, inventory);
  validateSearchCompleteness(localSearch, inventory);
  const retainedArtifactSearch = searchRetainedArtifacts(root, step1);
  const gitProof = gitEvidence();
  const falseMatch = falseMatchBinding(root);
  falseMatch.cachedPhase0Wiring = { retainedCachedArtifactOnly: true, currentStateOrEconomicsClaimed: false, exactFeedAddressRowCount: retainedArtifactSearch.phase0ExactFalseMatchFeedAddressRowCount, rows: retainedArtifactSearch.phase0ExactFalseMatchFeedAddressRows };
  const candidates = [falseMatch];
  invariant(deriveStatus(candidates) === STATUS, 'derived close status');
  const phase0 = hashRecord(root, PHASE0_PATH, 'cached-read-only-phase0-artifact');
  invariant(phase0.sha256 === PHASE0_SHA256, 'moonwell-lending-phase0 authority hash drift');
  const phase = json(root, PHASE0_PATH);
  invariant(phase.thresholds.materialUsd === 10000 && phase.summary.routePositive === 0 && phase.summary.executableNow === false, 'phase0 threshold/gates drift');
  const dependencies = CONSTRUCTOR_DEPENDENCIES.map((p) => hashRecord(root, p, 'wrapper-direct-constructor/source-dependency'));
  return {
    schema: ID,
    schemaVersion: 1,
    version: '1.0.0',
    generatedAt: GENERATED_AT,
    mode: MODE,
    findingId: ID,
    scopeBoundary: 'Only the declared local tracked/worktree roots, the exact retained Step1 package/phase0 artifact, and objects reachable from local Git refs were searched. No global filesystem or deployed-chain absence claim is made.',
    authority: { step1ReportRawPackage: step1, source, targetDirtyTruth: dirty },
    wrapperFingerprint: {
      contract: 'ChainlinkCompositeOEVWrapper',
      sourcePath: WRAPPER_PATH,
      sourceSha256: WRAPPER_SHA256,
      sourceCommit: EXACT_COMMIT,
      sourceTree: EXACT_TREE,
      solidity: '0.8.19',
      directDependencies: dependencies,
      constructorArguments: CONSTRUCTOR_ARGUMENTS,
      constructorArgumentCount: 7,
      qualification: 'SOURCE_AND_RETAINED_BUILD_MANIFEST_QUALIFIED_ONLY',
      retainedBuildManifest: { compilerInputs: 528, artifactJsonFiles: 632, aggregateSha256: '066e25c29d596c1158f2f11aa94e5eba2917a08d356713427f64015cec05ed1d', sourceHashRecordedByStep1: WRAPPER_SHA256 },
      retainedCompiledRuntimeBytesPresent: false,
      exactRuntimeHashClaimed: false,
      runtimeHash: null,
      warning: 'No retained compiled ChainlinkCompositeOEVWrapper runtime bytes/build artifact remains in the declared local scope; no exact runtime hash is invented.',
    },
    search: { localTracked: localSearch, retainedArtifacts: retainedArtifactSearch, totalLocalFilesSearched: localSearch.searchedFileCount + retainedArtifactSearch.searchedFileCount, git: gitProof, exclusionsAppliedBeforeRead: true, secretPatterns: [...SECRET_PATTERNS], globalAbsenceClaimed: false },
    candidates: { total: candidates.length, exact: 0, excludedWrongType: 1, ambiguous: 0, rows: candidates },
    promotionRule: {
      required: ['address', 'creation/runtime preimage or byte-for-byte/immutable-normalized deployed runtime evidence', 'all exact seven constructor/immutable values', 'exact ChainlinkOracle feed wiring', 'exact listed collateral mToken consumption with matching underlying symbol'],
      rejectedAlone: ['name', 'selector', 'source shape', 'address without resolved type/bytes', 'MIP-X56 untouched statement'],
    },
    phase0: { path: PHASE0_PATH, sha256: phase0.sha256, retainedCachedArtifactOnly: true, materialUsdThreshold: 10000, routePositive: 0, executableNow: false },
    economics: { assessed: false, sourceWitnessUsd: 100, materialUsdThreshold: 10000, belowThreshold: true, currentDeploymentEconomics: false, wording: 'The retained source witness is $100, below the cached $10,000 material threshold; it is not current deployment economics.' },
    routePositive: 'unknown',
    executableNow: 'unknown',
    signedActionJustified: false,
    fork: false,
    economicsAssessed: false,
    networkAttempted: false,
    rpcAttempted: false,
    buildPerformed: false,
    forgeInvoked: false,
    packageManagerInvoked: false,
    signingAttempted: false,
    transactionAttempted: false,
    stateReadOrMutationAttempted: false,
    protectedFilesRead: false,
    coordinationReadOrWritten: false,
    status: STATUS,
    admission: { networkRunnerAdmitted: false, admitted: false, reason: STATUS },
    nextAction: 'CLOSE_ROTATE',
    reopenCondition: 'Retained exact deployment address plus creation/runtime byte evidence, all seven constructor values, and exact ChainlinkOracle-to-listed-collateral-market wiring becomes available for offline verification.',
  };
}

function renderReport(core) {
  const s = core.search.localTracked;
  const g = core.search.git;
  return Buffer.from([
    '# Moonwell cached-high composite OEV deployment-provenance Gate0', '',
    `Mode: \`${MODE}\`  `,
    `Status: **${core.status}**  `,
    'Network runner admitted: `false`; next action: `CLOSE_ROTATE`.', '',
    '## Decision', '',
    'The deterministic offline declared-local search found no exact deployment candidate for the reviewed `ChainlinkCompositeOEVWrapper`. The one address-bearing name match is conclusively the wrong contract type. This closes only the declared local tracked/history/artifact scope; it is not a global filesystem or deployed-chain absence claim.', '',
    'An exact candidate would require an address, creation/runtime preimage or byte-for-byte/immutable-normalized runtime evidence, all seven constructor/immutable values, exact `ChainlinkOracle` feed wiring, and consumption by a listed collateral mToken whose underlying symbol matches that wiring. A name, selector, or source shape cannot promote a candidate.', '',
    '## Source/build fingerprint', '',
    `Reviewed source: \`${WRAPPER_PATH}\` at commit \`${EXACT_COMMIT}\`, tree \`${EXACT_TREE}\`, SHA-256 \`${WRAPPER_SHA256}\`. The seven arguments are \`_compositeOracle\`, \`_baseFeed\`, \`_owner\`, \`_chainlinkOracle\`, \`_feeRecipient\`, \`_liquidatorFeeBps\`, and \`_maxRoundDelay\`. Only \`chainlinkOracle\` is immutable; the other destinations are storage (including Ownable private owner storage).`, '',
    'Fingerprint qualification is `SOURCE_AND_RETAINED_BUILD_MANIFEST_QUALIFIED_ONLY`. Step1 retained the 528-input/632-artifact manifest aggregate, but no compiled wrapper runtime bytes or build artifact remains in the declared scope. Therefore no exact runtime hash is claimed or invented.', '',
    '## Exact false-match exclusion', '',
    `\`chains/10.json:178-180\` assigns \`CHAINLINK_WEETH_USD_COMPOSITE_OEV_WRAPPER\` to \`${FALSE_MATCH_ADDRESS}\`. MIP-X14 \`132-143\` constructs that entry with \`new ChainlinkCompositeOracle\`; lines \`296-318\` cast and validate it as \`ChainlinkCompositeOracle\`. The cached phase0 artifact records that address as the \`weETH\` feed consumed by listed \`mweETH\` at \`0xb8051464c8c92209c92f3a4cd9c73746c4c3cfb3\`; this is cached wiring evidence only and does not change the exact wrong type. Classification: **EXCLUDED_WRONG_CONTRACT_TYPE**.`, '',
    'MIP-X56 lines `21-28` state that composite-wrapped feeds and raw aggregators are left untouched. This does not infer or establish the reviewed wrapper.', '',
    '## Search accounting and exclusions', '',
    `Searched ${s.searchedFileCount} tracked files under only the declared roots (${s.declaredSafeRoots.map((x) => `\`${x}\``).join(', ')}), with aggregate SHA-256 \`${s.searchedFilesAggregateSha256}\`; also searched all ${core.search.retainedArtifacts.searchedFileCount} retained Step1/phase0 artifact files. Exact reviewed-wrapper source constructions: ${s.exactConstructionCount}. Recorded tracked-local occurrence rows: ${s.occurrenceCount}. Phase0 listed market rows checked: ${core.search.retainedArtifacts.phase0ListedMarketRowsChecked}.`, '',
    `Local Git evidence: ${g.refs.count} refs, ${g.history.commitCount} commit, ${g.objects.count} reachable object rows (${g.objects.typeCounts.commit} commit, ${g.objects.typeCounts.tree} trees, ${g.objects.typeCounts.blob} blobs), ${g.trackedObjectSearch.searchedBlobCount} safe named blobs searched, and ${g.trackedObjectSearch.matchLineCount} matched object-search lines. The search covers objects reachable from declared local refs only.`, '',
    `Secret patterns were excluded before content reads: ${SECRET_PATTERNS.map((x) => `\`${x}\``).join(', ')}. Local excluded paths: ${s.excludedSecretPaths.length}; object excluded paths: ${g.objects.secretExclusionCount}. Protected files were not read.`, '',
    'The exact Step1 report/raw package (30 files), wrapper/dependencies, all chain JSON/proposals/scripts and retained deployment/build/fork artifacts in declared roots, cached `moonwell-lending-phase0.json`, target dirty witnesses, and generated tool/report/artifact are hash-bound by the manifest.', '',
    '## Economics and gates', '',
    '- The retained source witness is `$100`, below the cached `$10,000` material threshold; it is not current deployment economics.',
    '- `routePositive="unknown"`; `executableNow="unknown"`; economics unassessed.',
    '- `signedActionJustified=false`; `fork=false`; network/RPC/signing/transaction/state attempts all false.',
    '- No build, Forge, package manager, protected file, or coordination access was used.', '',
  ].join('\n'));
}

function validateArtifactData(a) {
  invariant(a.schema === ID && a.schemaVersion === 1 && a.mode === MODE, 'artifact schema/mode');
  invariant(a.authority.source.commit === EXACT_COMMIT && a.authority.source.tree === EXACT_TREE && a.authority.source.wrapper.sha256 === WRAPPER_SHA256, 'artifact source authority');
  invariant(a.authority.step1ReportRawPackage.fileCount === 30, 'artifact Step1 package count');
  invariant(a.wrapperFingerprint.constructorArgumentCount === 7 && same(a.wrapperFingerprint.constructorArguments, CONSTRUCTOR_ARGUMENTS), 'artifact seven constructor arguments/distinctions');
  invariant(a.wrapperFingerprint.qualification === 'SOURCE_AND_RETAINED_BUILD_MANIFEST_QUALIFIED_ONLY' && !a.wrapperFingerprint.retainedCompiledRuntimeBytesPresent && !a.wrapperFingerprint.exactRuntimeHashClaimed && a.wrapperFingerprint.runtimeHash === null, 'artifact qualified-only fingerprint');
  invariant(a.search.exclusionsAppliedBeforeRead && !a.search.globalAbsenceClaimed && a.search.localTracked.exactConstructionCount === 0, 'artifact search completeness/scope');
  invariant(a.search.retainedArtifacts.searchedFileCount === 31 && a.search.totalLocalFilesSearched === a.search.localTracked.searchedFileCount + 31, 'artifact retained artifact search completeness');
  invariant(a.candidates.total === 1 && a.candidates.exact === 0 && a.candidates.excludedWrongType === 1 && a.candidates.ambiguous === 0, 'artifact candidate counts');
  invariant(a.candidates.rows[0].address === FALSE_MATCH_ADDRESS && a.candidates.rows[0].classification === 'EXCLUDED_WRONG_CONTRACT_TYPE' && !a.candidates.rows[0].unresolvedAddressOrTypeEvidence, 'artifact exact false match');
  invariant(a.candidates.rows[0].cachedPhase0Wiring.exactFeedAddressRowCount === 1 && a.candidates.rows[0].cachedPhase0Wiring.rows[0].listed === true && a.candidates.rows[0].cachedPhase0Wiring.rows[0].underlyingSymbol === 'weETH' && !a.candidates.rows[0].cachedPhase0Wiring.currentStateOrEconomicsClaimed, 'artifact cached false-match wiring');
  invariant(deriveStatus(a.candidates.rows) === STATUS && a.status === STATUS, 'artifact status derivation');
  invariant(a.economics.sourceWitnessUsd === 100 && a.economics.materialUsdThreshold === 10000 && a.economics.belowThreshold && !a.economics.currentDeploymentEconomics, 'artifact witness/threshold boundary');
  invariant(a.routePositive === 'unknown' && a.executableNow === 'unknown' && a.signedActionJustified === false && a.fork === false && a.economicsAssessed === false, 'artifact gates');
  for (const key of ['networkAttempted', 'rpcAttempted', 'buildPerformed', 'forgeInvoked', 'packageManagerInvoked', 'signingAttempted', 'transactionAttempted', 'stateReadOrMutationAttempted', 'protectedFilesRead', 'coordinationReadOrWritten']) invariant(a[key] === false, `artifact safety flag: ${key}`);
  invariant(a.admission.admitted === false && a.admission.networkRunnerAdmitted === false && a.nextAction === 'CLOSE_ROTATE', 'artifact admission/action');
  return true;
}

function roleFor(p, core) {
  if (p.startsWith('tools/')) return 'tool';
  if (p === OUTPUT_PATHS.artifact) return 'artifact';
  if (p === OUTPUT_PATHS.report) return 'report';
  if (core.authority.step1ReportRawPackage.records.some((x) => x.path === p)) return 'immutable-step1-authority-package';
  if (p === PHASE0_PATH) return 'cached-read-only-phase0-artifact';
  if (CONSTRUCTOR_DEPENDENCIES.includes(p)) return 'wrapper-direct-constructor/source-dependency';
  if (core.authority.targetDirtyTruth.witnessHashes.some((x) => x.path === p)) return 'pre-existing-untracked-audit-witness';
  return 'declared-safe-local-search';
}

function manifestInputPaths(core) {
  const groups = [
    [`tools/analyze-${ID}.js`, `tools/test-${ID}.js`, OUTPUT_PATHS.artifact, OUTPUT_PATHS.report],
    core.authority.step1ReportRawPackage.records.map((x) => x.path),
    [PHASE0_PATH],
    [...CONSTRUCTOR_DEPENDENCIES],
    core.authority.targetDirtyTruth.witnessHashes.map((x) => x.path),
    core.search.localTracked.records.map((x) => x.path),
  ];
  const out = [], seen = new Set();
  for (const p of groups.flat()) { if (!seen.has(p)) { seen.add(p); out.push(p); } }
  return out;
}

function buildBundle(root = ROOT) {
  const core = makeCore(root);
  const reportBytes = renderReport(core);
  const artifact = { ...core, reportBinding: { path: OUTPUT_PATHS.report, bytes: reportBytes.length, sha256: sha256(reportBytes) } };
  validateArtifactData(artifact);
  const artifactBytes = jsonBytes(artifact);
  const paths = manifestInputPaths(core);
  invariant(new Set(paths).size === paths.length, 'manifest duplicate input path');
  const memory = new Map([[OUTPUT_PATHS.artifact, artifactBytes], [OUTPUT_PATHS.report, reportBytes]]);
  const files = paths.map((p) => { const b = memory.get(p) || read(root, p); return { path: p, role: roleFor(p, core), bytes: b.length, sha256: sha256(b) }; });
  const manifest = {
    schema: `${ID}-manifest`, schemaVersion: 1, version: '1.0.0', generatedAt: GENERATED_AT, mode: MODE, findingId: ID,
    algorithm: 'sha256', manifestSelfHashExcluded: true, immutableNoReplaceGeneration: true,
    metadata: {
      status: STATUS, admission: false, exactCandidateCount: 0, excludedWrongTypeCount: 1, ambiguousCandidateCount: 0,
      sourceCommit: EXACT_COMMIT, sourceTree: EXACT_TREE, wrapperSourceSha256: WRAPPER_SHA256,
      step1PackageFileCount: core.authority.step1ReportRawPackage.fileCount, step1PackageAggregateSha256: core.authority.step1ReportRawPackage.aggregateSha256,
      localSearchFileCount: core.search.localTracked.searchedFileCount, localSearchAggregateSha256: core.search.localTracked.searchedFilesAggregateSha256,
      gitRefCount: core.search.git.refs.count, gitRefAggregateSha256: core.search.git.refs.aggregateSha256,
      gitCommitCount: core.search.git.history.commitCount, gitHistoryAggregateSha256: core.search.git.history.aggregateSha256,
      gitObjectCount: core.search.git.objects.count, gitObjectTypeCounts: core.search.git.objects.typeCounts,
      gitObjectInventoryAggregateSha256: core.search.git.objects.inventoryAggregateSha256,
      gitObjectCheckedAggregateSha256: core.search.git.objects.checkedAggregateSha256,
      objectSearchSafeNamedCount: core.search.git.objects.safeNamedObjectCount,
      objectSearchSafeBlobCount: core.search.git.objects.safeNamedBlobCount,
      retainedArtifactSearchFileCount: core.search.retainedArtifacts.searchedFileCount,
      retainedArtifactSearchAggregateSha256: core.search.retainedArtifacts.searchedFilesAggregateSha256,
      secretLocalExclusionCount: core.search.localTracked.excludedSecretPaths.length,
      secretObjectExclusionCount: core.search.git.objects.secretExclusionCount,
      reportSha256: artifact.reportBinding.sha256,
    },
    exactPathOrder: paths, fileCount: files.length, files, aggregateSha256: aggregate(files),
  };
  return { reportBytes, artifact, artifactBytes, manifest, manifestBytes: jsonBytes(manifest) };
}

function validateManifestData(m, expected) {
  invariant(m.schema === `${ID}-manifest` && m.schemaVersion === 1 && m.mode === MODE, 'manifest schema/mode');
  invariant(m.metadata.status === STATUS && m.metadata.admission === false && m.metadata.exactCandidateCount === 0 && m.metadata.excludedWrongTypeCount === 1 && m.metadata.ambiguousCandidateCount === 0, 'manifest outcome metadata');
  invariant(m.metadata.sourceCommit === EXACT_COMMIT && m.metadata.sourceTree === EXACT_TREE && m.metadata.wrapperSourceSha256 === WRAPPER_SHA256, 'manifest source metadata');
  invariant(m.metadata.step1PackageFileCount === 30 && m.metadata.localSearchFileCount > 0 && m.metadata.retainedArtifactSearchFileCount === 31 && m.metadata.gitObjectCount === 1317, 'manifest package/search/object counts');
  invariant(m.fileCount === m.files.length && same(m.exactPathOrder, m.files.map((x) => x.path)), 'manifest exact order/count');
  invariant(new Set(m.exactPathOrder).size === m.exactPathOrder.length, 'manifest duplicate path');
  invariant(m.aggregateSha256 === aggregate(m.files), 'manifest aggregate hash');
  if (expected) invariant(same(m, expected), 'manifest deterministic metadata/order/hash');
  return true;
}

function validateBundle(root = ROOT) {
  const expected = buildBundle(root);
  const reportBytes = read(root, OUTPUT_PATHS.report);
  const artifactBytes = read(root, OUTPUT_PATHS.artifact);
  const manifestBytes = read(root, OUTPUT_PATHS.manifest);
  invariant(reportBytes.equals(expected.reportBytes), 'report bytes drift');
  invariant(artifactBytes.equals(expected.artifactBytes), 'artifact bytes drift');
  invariant(manifestBytes.equals(expected.manifestBytes), 'manifest bytes drift');
  const artifact = JSON.parse(artifactBytes), manifest = JSON.parse(manifestBytes);
  validateArtifactData(artifact); validateManifestData(manifest, expected.manifest);
  invariant(artifact.reportBinding.bytes === reportBytes.length && artifact.reportBinding.sha256 === sha256(reportBytes), 'artifact report byte binding');
  for (const row of manifest.files) { const b = read(root, row.path); invariant(b.length === row.bytes && sha256(b) === row.sha256, `manifest file drift: ${row.path}`); }
  return { artifact, manifest };
}

function writeNoReplace(root, entries) {
  for (const [p] of entries) invariant(!fs.existsSync(rel(root, p)), `immutable generation refuses existing output: ${p}`);
  for (const [p, bytes] of entries) fs.writeFileSync(rel(root, p), bytes, { flag: 'wx' });
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
    process.stdout.write(`PASS ${ID} check-only status=${result.artifact.status} searched=${result.artifact.search.localTracked.searchedFileCount} objects=${result.artifact.search.git.objects.count} files=${result.manifest.fileCount} aggregate=${result.manifest.aggregateSha256}\n`);
  } else {
    const result = generate(ROOT);
    process.stdout.write(`WROTE ${ID} files=3 status=${result.artifact.status} searched=${result.artifact.search.localTracked.searchedFileCount} objects=${result.artifact.search.git.objects.count} manifestFiles=${result.manifest.fileCount} aggregate=${result.manifest.aggregateSha256}\n`);
  }
}

if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`FAIL ${error.message}\n`); process.exitCode = 1; } }

module.exports = { CONSTRUCTOR_ARGUMENTS, CONSTRUCTOR_DEPENDENCIES, DECLARED_SAFE_ROOTS, DIRTY_EXPECTED, EXACT_COMMIT, EXACT_TREE, FALSE_MATCH_ADDRESS, ID, MODE, OUTPUT_PATHS, PHASE0_PATH, ROOT, SECRET_PATTERNS, STATUS, STEP1_RAW, STEP1_REPORT, TARGET_REL, WRAPPER_PATH, WRAPPER_SHA256, aggregate, buildBundle, deriveStatus, evaluateCandidate, falseMatchBinding, generate, gitEvidence, isSecretPath, isSafeTrackedPath, listStep1Package, searchLocalTracked, searchRetainedArtifacts, sha256, trackedInventory, validateArtifactData, validateBundle, validateManifestData, validateSearchCompleteness, verifyDirtyTruth, verifySourceIdentity, verifyStep1Authority, writeNoReplace };
