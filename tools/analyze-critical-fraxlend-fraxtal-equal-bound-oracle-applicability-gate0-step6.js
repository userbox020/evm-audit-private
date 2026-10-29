#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ID = 'critical-fraxlend-fraxtal-equal-bound-oracle-applicability-gate0-step6';
const MODE = 'OFFLINE_RETAINED_EVIDENCE_ONLY';
const STATUS = 'CLOSE_NO_EXACT_MATERIAL_RETAINED_ROW';
const GENERATED_AT = '2026-08-08T00:00:00.000Z';
const TARGET_REL = 'targets/fraxlend';
const TARGET = path.join(ROOT, ...TARGET_REL.split('/'));
const EXACT_COMMIT = '2bed49d4dcc6702d92dede825c3424893517d841';
const EXACT_TREE = 'fe1b3354cd55bcc53aef490800c9dde7bc31c038';

const INPUTS = Object.freeze({
  retainedScan: {
    path: 'reports/raw/fast/fraxlend-live.json',
    sha256: '116dbe06d00f722e0c967646354e9b6c0f67fb5b68549bf6a682343e9d054c40',
  },
  step5Screen: {
    path: 'reports/raw/fast/fraxlend-bad-oracle-deployment-step5-screen.json',
    sha256: 'a299498ec92cd99127f516ddc2dc01bd1b259aa156cb11a6a0e09db571816b28',
  },
  step4Report: {
    path: 'reports/critical-fraxlend-bad-oracle-real-univ3-manipulation-economics-step4.md',
    sha256: '6d3ca9623a40cf774f200e2a448f281fea6bcf518b61715ccfd2567bc4c81436',
  },
  step5Report: {
    path: 'reports/critical-fraxlend-bad-oracle-deployment-binding-step5.md',
    sha256: 'a0703920b296ceb0b5031d7d10cff26b7d7752d41438362343667fc5a1891412',
  },
  genericSource: {
    path: `${TARGET_REL}/src/contracts/oracles/dual-oracles/DualOracleChainlinkUniV3.sol`,
    sha256: '485f4a8e21bdfed5086d068a0c6a65fe6b7d083bffc316623ff212c5767632c6',
  },
  retainedScanner: {
    path: `${TARGET_REL}/scan-fraxlend-live.js`,
    sha256: 'c0a5f11c88b7b277ec298ac38aa06325ba5082ed1568dff86e5ecfc008a5492b',
  },
});

const OUTPUT_PATHS = Object.freeze({
  artifact: `reports/raw/fast/${ID}.json`,
  manifest: `reports/raw/fast/${ID}-manifest.json`,
  report: `reports/${ID}.md`,
});

const GENERIC_REQUIRED_OBSERVATIONS = Object.freeze([
  'oracleTypeEqualsOne',
  'maxOracleDelayReturned',
  'baseTokenReturned',
  'quoteTokenReturned',
  'uniV3PairReturned',
  'twapDurationReturned',
  'decimalsEquals18',
  'getPricesReturned',
]);

const BAD_DATA_CONTRADICTION_PAIR = '0xb71e4829e81f72f7f36a0d858e58109f5948a713';
const BAD_DATA_CONTRADICTION_ORACLE = '0x42805079ed5ff38c0a5a47f38c83f96d348609aa';

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function workspacePath(root, relPath) {
  return path.join(root, ...relPath.split('/'));
}

function read(root, relPath) {
  return fs.readFileSync(workspacePath(root, relPath));
}

function readJson(root, relPath) {
  return JSON.parse(read(root, relPath).toString('utf8'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function hashRecord(root, relPath, role) {
  const bytes = read(root, relPath);
  return { path: relPath, role, bytes: bytes.length, sha256: sha256(bytes) };
}

function normalizeAddress(value) {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function isAddress(value) {
  return /^0x[0-9a-f]{40}$/.test(normalizeAddress(value) || '');
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || !Number.isInteger(decimals) || decimals < 0) return null;
  const negative = String(raw).startsWith('-');
  const digits = (negative ? String(raw).slice(1) : String(raw)).padStart(decimals + 1, '0');
  if (decimals === 0) return `${negative ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function sourceIdentity() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: TARGET, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: TARGET, encoding: 'utf8' }).trim();
  invariant(commit === EXACT_COMMIT, 'exact Fraxlend commit drift');
  invariant(tree === EXACT_TREE, 'exact Fraxlend tree drift');
  const trackedDiff = execFileSync('git', ['diff', '--name-only'], { cwd: TARGET, encoding: 'utf8' }).trim();
  const stagedDiff = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: TARGET, encoding: 'utf8' }).trim();
  invariant(trackedDiff === '', 'Fraxlend tracked worktree drift');
  invariant(stagedDiff === '', 'Fraxlend staged worktree drift');
  return { commit, tree, trackedDiffEmpty: true, stagedDiffEmpty: true };
}

function verifyInputs(root = ROOT) {
  return Object.entries(INPUTS).map(([name, item]) => {
    const record = hashRecord(root, item.path, name);
    invariant(record.sha256 === item.sha256, `${name} authority hash drift`);
    return record;
  });
}

function genericFingerprint(oracle) {
  const exposed = oracle?.exposed || {};
  const observations = {
    oracleTypeEqualsOne: String(oracle?.oracleType ?? '') === '1',
    maxOracleDelayReturned: oracle?.maxOracleDelay !== null && oracle?.maxOracleDelay !== undefined,
    baseTokenReturned: isAddress(exposed.BASE_TOKEN),
    quoteTokenReturned: isAddress(exposed.QUOTE_TOKEN),
    uniV3PairReturned: isAddress(exposed.UNI_V3_PAIR_ADDRESS),
    twapDurationReturned: exposed.TWAP_DURATION !== null && exposed.TWAP_DURATION !== undefined && BigInt(exposed.TWAP_DURATION) > 0n,
    decimalsEquals18: oracle?.decimals === 18,
    getPricesReturned: oracle?.getPrices && typeof oracle.getPrices.isBadData === 'boolean' && oracle.getPrices.priceLow !== null && oracle.getPrices.priceHigh !== null,
  };
  invariant(Object.keys(observations).every((x) => GENERIC_REQUIRED_OBSERVATIONS.includes(x)), 'generic fingerprint observation drift');
  return {
    observations,
    passedCount: Object.values(observations).filter(Boolean).length,
    requiredCount: GENERIC_REQUIRED_OBSERVATIONS.length,
    complete: Object.values(observations).every(Boolean),
    nullProbeAmbiguity: 'retained scanner maps both call failure/revert and transport failure to null',
  };
}

function hasBadDataEqualBoundContradiction(oracle) {
  const prices = oracle?.getPrices;
  return prices?.isBadData === true && String(prices.priceLow) !== String(prices.priceHigh);
}

function familyHint(pair) {
  const joined = `${pair.oracleLabel || ''} ${pair.oracle?.name || ''}`.toLowerCase();
  if (joined.includes('exponential')) return 'EXPONENTIAL_PRICE_ORACLE';
  if (joined.includes('inverse')) return 'INVERSE_ORACLE_ADAPTER';
  if (joined.includes('api3')) return 'API3_REDSTONE_ORACLE';
  if (joined.includes('merkle')) return 'FPI_MERKLE_ORACLE_ADAPTER';
  if (joined.includes('redstone') || joined.includes('redstone')) return 'REDSTONE_ORACLE_FAMILY';
  return 'UNKNOWN_FAMILY';
}

function classifyPair(pair) {
  invariant(isAddress(pair.address), 'invalid Pair address');
  invariant(pair.oracle && isAddress(pair.oracle.address), `missing oracle address for ${pair.address}`);
  invariant(normalizeAddress(pair.exchangeRateInfo?.oracle) === normalizeAddress(pair.oracle.address), `Pair/oracle binding mismatch for ${pair.address}`);
  invariant(Number.isInteger(pair.oracle.codeBytes) && pair.oracle.codeBytes > 0, `missing oracle code for ${pair.address}`);

  const fingerprint = genericFingerprint(pair.oracle);
  const contradiction = hasBadDataEqualBoundContradiction(pair.oracle);
  const runtimeBinding = {
    runtimeBytesRetained: false,
    runtimeHashRetained: false,
    verifiedSourceIdentityRetained: false,
    compilerSettingsRetained: false,
    immutableValuesExact: false,
    disposition: 'UNKNOWN_RUNTIME_SOURCE_CONTINUITY',
  };

  let classification = 'UNKNOWN';
  let rationale = 'No runtime bytecode/hash, exact verified source identity, compiler/settings, or immutable configuration is retained; null ABI probes cannot safely prove absence.';
  if (contradiction) {
    classification = 'WRONG_TYPE';
    rationale = 'A successful getPrices observation returned badData=true with unequal bounds, which contradicts exact DualOracleChainlinkUniV3 bad-data semantics.';
  }

  const cashRaw = String(pair.derived?.availableAssetAccounting ?? '');
  invariant(/^\d+$/.test(cashRaw), `invalid retained Pair cash for ${pair.address}`);
  if (pair.assetToken?.holderBalance !== null && pair.assetToken?.holderBalance !== undefined) {
    invariant(String(pair.assetToken.holderBalance) === cashRaw, `retained cash/accounting mismatch for ${pair.address}`);
  }
  const historicalZeroCash = BigInt(cashRaw) === 0n;
  const materiality = {
    availableAssetRaw: cashRaw,
    assetSymbol: pair.assetToken?.symbol ?? null,
    assetDecimals: pair.assetToken?.decimals ?? null,
    availableAssetDisplay: formatUnits(cashRaw, pair.assetToken?.decimals),
    historicalZeroCash,
    cashDisposition: historicalZeroCash ? 'NONMATERIAL_ZERO_AT_RETAINED_OBSERVATION' : 'UNKNOWN_NO_COMPARABLE_PRICE',
    uniV3PoolAddress: pair.oracle?.exposed?.UNI_V3_PAIR_ADDRESS ?? null,
    poolRuntimeRetained: false,
    poolLiquidityRetained: false,
    poolTickDistributionRetained: false,
    cashToPoolFairTvlRatio: null,
    exitLiquidityRetained: false,
    conservativeNetEconomics: null,
    economicsDisposition: historicalZeroCash ? 'HISTORICAL_ZERO_CASH_SCREEN' : 'UNKNOWN',
  };

  const exactGenericEqualBound = classification === 'EXACT_GENERIC_EQUAL_BOUND';
  const materialPositive = materiality.conservativeNetEconomics !== null && BigInt(materiality.conservativeNetEconomics) > 0n;
  const admission = exactGenericEqualBound && fingerprint.complete && runtimeBinding.disposition === 'EXACT' && materialPositive && materiality.exitLiquidityRetained;

  return {
    pair: normalizeAddress(pair.address),
    pairName: pair.pairName,
    listedMarket: pair.market,
    appListed: pair.appVersion !== null,
    sunset: pair.isSunset,
    asset: normalizeAddress(pair.asset),
    collateral: normalizeAddress(pair.collateral),
    oracle: normalizeAddress(pair.oracle.address),
    oracleLabel: pair.oracleLabel,
    oracleName: pair.oracle.name,
    oracleCodeBytes: pair.oracle.codeBytes,
    familyHint: familyHint(pair),
    getPrices: pair.oracle.getPrices,
    fingerprint,
    badDataEqualBoundContradiction: contradiction,
    runtimeBinding,
    classification,
    rationale,
    controls: pair.controls,
    borrowLimit: pair.borrowLimit,
    materiality,
    admitted: admission,
  };
}

function exactAddressSet(values) {
  return [...new Set(values.map(normalizeAddress))].sort();
}

function validateInventory(chain) {
  invariant(chain.chainId === 252 && chain.chain === 'fraxtal', 'Fraxtal chain identity');
  invariant(chain.discoveredPairs === 17 && chain.pairs.length === 17, 'retained Fraxtal Pair count');
  invariant(chain.deployers.length === 1 && chain.registries.length === 1, 'retained Fraxtal deployer/registry count');
  invariant(String(chain.deployers[0].deployedPairsLength) === '17', 'deployer Pair count');
  invariant(String(chain.registries[0].deployedPairsLength) === '17', 'registry Pair count');
  const pairSet = exactAddressSet(chain.pairs.map((x) => x.address));
  const deployerSet = exactAddressSet(chain.deployers[0].deployedPairs);
  const registrySet = exactAddressSet(chain.registries[0].deployedPairs);
  invariant(JSON.stringify(pairSet) === JSON.stringify(deployerSet), 'Pair/deployer inventory set mismatch');
  invariant(JSON.stringify(pairSet) === JSON.stringify(registrySet), 'Pair/registry inventory set mismatch');
  return { pairSet, deployerSet, registrySet };
}

function countBy(rows, key) {
  return rows.reduce((out, row) => {
    const value = row[key];
    out[value] = (out[value] || 0) + 1;
    return out;
  }, {});
}

function evaluateAdmission(row) {
  return row.classification === 'EXACT_GENERIC_EQUAL_BOUND' &&
    row.fingerprint?.complete === true &&
    row.runtimeBinding?.disposition === 'EXACT' &&
    row.runtimeBinding?.immutableValuesExact === true &&
    row.materiality?.poolRuntimeRetained === true &&
    row.materiality?.poolLiquidityRetained === true &&
    row.materiality?.poolTickDistributionRetained === true &&
    row.materiality?.exitLiquidityRetained === true &&
    row.materiality?.conservativeNetEconomics !== null &&
    BigInt(row.materiality.conservativeNetEconomics) > 0n;
}

function deriveStatus(rows) {
  return rows.some(evaluateAdmission) ? 'ADMIT_EXACT_MATERIAL_ROW_FOR_REVIEW' : STATUS;
}

function validateArtifactData(artifact) {
  invariant(artifact.schemaVersion === 1 && artifact.findingId === ID, 'artifact identity');
  invariant(artifact.inventory.rows === 17 && artifact.rows.length === 17, 'artifact row count');
  invariant(new Set(artifact.rows.map((x) => x.pair)).size === 17, 'duplicate Pair row');
  invariant(artifact.rows.every((x) => x.oracle && x.pair), 'missing Pair/oracle row binding');
  const counts = countBy(artifact.rows, 'classification');
  invariant((counts.EXACT_GENERIC_EQUAL_BOUND || 0) === 0, 'false exact generic promotion');
  invariant((counts.WRONG_TYPE || 0) === 1 && (counts.UNKNOWN || 0) === 16, 'classification counts');
  invariant(artifact.rows.filter((x) => x.badDataEqualBoundContradiction).length === 1, 'bad-data contradiction count');
  const contradiction = artifact.rows.find((x) => x.pair === BAD_DATA_CONTRADICTION_PAIR);
  invariant(contradiction && contradiction.oracle === BAD_DATA_CONTRADICTION_ORACLE && contradiction.classification === 'WRONG_TYPE', 'known contradiction binding');
  invariant(artifact.rows.filter((x) => x.materiality.historicalZeroCash).length === 5, 'historical zero-cash count');
  invariant(artifact.rows.every((x) => x.materiality.cashToPoolFairTvlRatio === null), 'invented cash/pool ratio');
  invariant(artifact.rows.every((x) => x.materiality.exitLiquidityRetained === false), 'invented exit evidence');
  invariant(artifact.rows.every((x) => evaluateAdmission(x) === false && x.admitted === false), 'false row admission');
  invariant(artifact.status === deriveStatus(artifact.rows) && artifact.status === STATUS, 'artifact status');
  invariant(artifact.admission.admitted === false && artifact.admission.networkRunnerAdmitted === false, 'artifact admission');
  invariant(artifact.routePositive === 'unknown' && artifact.executableNow === 'unknown', 'canonical gates');
  invariant(artifact.signedActionJustified === false && artifact.fork === false, 'unsafe action gate');
  return true;
}

function buildArtifact(root = ROOT) {
  const inputRecords = verifyInputs(root);
  const scan = readJson(root, INPUTS.retainedScan.path);
  const step5 = readJson(root, INPUTS.step5Screen.path);
  const chain = scan.chains?.fraxtal;
  const sets = validateInventory(chain);
  invariant(step5.registryCoverage?.fraxtal?.complete === false, 'Step5 Fraxtal coverage limitation drift');
  invariant(step5.exactGenericDualOracleChainlinkUniV3Matches === 0, 'Step5 generic-match count drift');

  const pairByAddress = new Map(chain.pairs.map((x) => [normalizeAddress(x.address), x]));
  const registryOrder = chain.registries[0].deployedPairs.map(normalizeAddress);
  const rows = registryOrder.map((address) => classifyPair(pairByAddress.get(address)));
  const classificationCounts = countBy(rows, 'classification');
  const familyHintCounts = countBy(rows, 'familyHint');
  const source = sourceIdentity();

  const artifact = {
    schemaVersion: 1,
    findingId: ID,
    generatedAt: GENERATED_AT,
    mode: MODE,
    status: deriveStatus(rows),
    signal: 'CLOSE_ROTATE_RETAINED_GATE0_NO_EXACT_MATERIAL_ROW',
    scope: {
      chain: 'fraxtal',
      chainId: 252,
      retainedObservationStartedAt: scan.startedAt,
      retainedObservationCompletedAt: scan.completedAt,
      retainedBlockNumberLabel: chain.blockNumber,
      retainedBlockTimestampLabel: chain.blockTimestamp,
      blockPinned: false,
      finalityEstablished: false,
      currentStateClaimed: false,
      scannerCallTag: 'latest',
      warning: 'The scanner recorded a block label but issued material eth_call and eth_getCode reads at latest; this is historical unpinned single-provider evidence.',
    },
    authority: {
      source,
      inputs: inputRecords,
      genericSourceSemantics: {
        path: INPUTS.genericSource.path,
        sha256: INPUTS.genericSource.sha256,
        requiredGetterLines: [34, 35, 38, 39, 41, 44, 45, 49, 50],
        badDataEqualBoundLines: [143, 156, 157, 158],
        invariant: 'isBadData == true implies priceLow == priceHigh',
      },
      retainedScannerSemantics: {
        path: INPUTS.retainedScanner.path,
        sha256: INPUTS.retainedScanner.sha256,
        latestCallLines: [234, 235, 236, 237],
        nullConflationLines: [225, 226, 227, 228, 229, 230, 231, 245, 246, 247, 255, 256, 257],
        oracleProbeLines: [466, 468, 469, 470, 471, 472, 473, 474, 475, 477, 492, 493, 494, 495, 496, 497, 500, 518, 529, 530],
      },
    },
    inventory: {
      rows: rows.length,
      configuredPairs: chain.configuredPairs,
      discoveredPairs: chain.discoveredPairs,
      deployerAddress: normalizeAddress(chain.deployers[0].address),
      registryAddress: normalizeAddress(chain.registries[0].address),
      pairSetEqualsDeployerSet: JSON.stringify(sets.pairSet) === JSON.stringify(sets.deployerSet),
      pairSetEqualsRegistrySet: JSON.stringify(sets.pairSet) === JSON.stringify(sets.registrySet),
      exactAddressOrder: registryOrder,
    },
    genericApplicabilityGate: {
      requiredObservations: [...GENERIC_REQUIRED_OBSERVATIONS],
      exactRuntimeSourceBindingRequired: true,
      exactImmutableConfigurationRequired: true,
      equalBoundsAloneNeverSufficient: true,
      badDataUnequalBoundsIsExactSourceContradiction: true,
      nullProbeResultNeverProvesWrongType: true,
      classificationCounts,
      familyHintCounts,
    },
    economicsGate: {
      sourceLocalRatio10CoalitionNetRaw18: '465596752303199498958294',
      sourceLocalRatio1CoalitionNetRaw18: '-6625655914958958605215845',
      retainedPoolLiquidityRows: 0,
      retainedCashToPoolRatioRows: 0,
      retainedExitEvidenceRows: 0,
      historicalZeroCashRows: rows.filter((x) => x.materiality.historicalZeroCash).length,
      exactComparableUsdValuationRows: 0,
      currentEconomicsAssessed: false,
      rule: 'Do not infer positivity from Pair cash alone; require exact pool runtime/configuration, tick distribution, manipulation/unwind costs, liquidation ordering, prices, exit liquidity, fees, gas, and conservative positive net.',
    },
    rows,
    admission: {
      admitted: rows.some(evaluateAdmission),
      admittedRows: rows.filter(evaluateAdmission).map((x) => x.pair),
      networkRunnerAdmitted: false,
      fixedBlockCaptureAdmitted: false,
      localForkAdmitted: false,
      reason: 'Zero retained rows have exact generic runtime/source/configuration binding plus material positive economics and exit evidence.',
    },
    localSemantic: { status: 'PASS', result: 'supports', rationale: 'Step3/Step4 exact source semantics remain retained; this Gate0 does not re-run them.' },
    reachability: { status: 'UNKNOWN', result: 'inconclusive', rationale: 'No exact applicable Fraxtal runtime/configuration row survives retained admission.' },
    economics: { status: 'UNKNOWN', result: 'inconclusive', rationale: 'No retained Fraxtal pool/tick/price/exit evidence supports current conservative net economics.' },
    reproducibility: { status: 'PASS', result: 'supports', rationale: 'Deterministic offline analyzer over hash-bound retained artifacts.' },
    evidenceStage: 'HISTORICAL_UNPINNED_RETAINED_GATE0',
    validityOutcome: 'NEEDS-CLARIFICATION',
    noveltyOutcome: 'N/A',
    deploymentDisposition: 'NO_EXACT_MATERIAL_RETAINED_ROW',
    accessDisposition: 'NOT_REQUESTED_OFFLINE_ONLY',
    routeDisposition: 'UNKNOWN',
    routePositive: 'unknown',
    executableNow: 'unknown',
    impactPath: [
      { type: 'victim-loss', supported: 'unknown', rationale: 'Source-local lender loss is conditional; Fraxtal applicability is not established.' },
      { type: 'protocol-loss', supported: 'unknown', rationale: 'Fraxtal deployed route and current economics are not established.' },
    ],
    signedActionJustified: false,
    fork: false,
    economicsAssessed: false,
    networkAttempted: false,
    rpcAttempted: false,
    protectedFilesRead: false,
    buildPerformed: false,
    forgeInvoked: false,
    packageManagerInvoked: false,
    signingAttempted: false,
    transactionAttempted: false,
    stateMutationAttempted: false,
    nextAction: 'CLOSE_ROTATE',
    reopenOnlyOn: [
      'reviewed fixed-block runtime bytecode and exact source/build/immutable binding for a Fraxtal Pair oracle',
      'an exact DualOracleChainlinkUniV3 equal-bound row with material Pair-cash/pool-liquidity geometry',
      'conservative positive manipulation/unwind/liquidation/exit economics above the program materiality threshold',
    ],
    limitations: [
      'Retained Fraxtal state is historical, unpinned, non-finality-bound, and single-provider.',
      'The scanner stores code length, not runtime bytes or runtime hash.',
      'Null selector observations conflate contract call failure/revert with RPC/transport failure.',
      'Oracle names and app labels are family hints only, never exact source identity.',
      'No retained Fraxtal UniV3 pool runtime, immutable configuration, liquidity/tick distribution, USD valuation, or exit route is available.',
      'This result is not a global absence claim and does not refute the source-local generic finding.',
    ],
  };
  validateArtifactData(artifact);
  return artifact;
}

function validateManifestData(manifest) {
  invariant(manifest.schemaVersion === 1 && manifest.findingId === ID, 'manifest identity');
  invariant(manifest.manifestSelfHashExcluded === true, 'manifest self-hash rule');
  invariant(manifest.fileCount === manifest.files.length, 'manifest file count');
  invariant(manifest.exactPathOrder.length === manifest.files.length, 'manifest exact order/count');
  invariant(new Set(manifest.exactPathOrder).size === manifest.fileCount, 'manifest duplicate path');
  invariant(JSON.stringify(manifest.exactPathOrder) === JSON.stringify(manifest.files.map((x) => x.path)), 'manifest deterministic exact order');
  invariant(!manifest.exactPathOrder.includes(OUTPUT_PATHS.manifest), 'manifest self path included');
  return true;
}

function buildManifest(root = ROOT) {
  const order = [
    `tools/analyze-${ID}.js`,
    `tools/test-${ID}.js`,
    OUTPUT_PATHS.artifact,
    OUTPUT_PATHS.report,
    ...Object.values(INPUTS).map((x) => x.path),
  ];
  const files = order.map((p) => hashRecord(root, p, p.startsWith('tools/') ? 'gate-tool' : p === OUTPUT_PATHS.artifact ? 'gate-artifact' : p === OUTPUT_PATHS.report ? 'gate-report' : 'authority-input'));
  const manifest = {
    schemaVersion: 1,
    findingId: ID,
    generatedAt: GENERATED_AT,
    mode: MODE,
    manifestSelfHashExcluded: true,
    exactPathOrder: order,
    fileCount: files.length,
    files,
    aggregateSha256: sha256(Buffer.from(files.map((x) => `${x.sha256}  ${x.path}\n`).join(''))),
    metadata: {
      sourceCommit: EXACT_COMMIT,
      sourceTree: EXACT_TREE,
      chainId: 252,
      retainedRows: 17,
      exactGenericRows: 0,
      admittedRows: 0,
      networkAttempted: false,
      rpcAttempted: false,
      signedActionJustified: false,
    },
  };
  validateManifestData(manifest);
  return manifest;
}

function writeOutputs(root = ROOT) {
  const artifact = buildArtifact(root);
  fs.writeFileSync(workspacePath(root, OUTPUT_PATHS.artifact), jsonBytes(artifact));
  const manifest = buildManifest(root);
  fs.writeFileSync(workspacePath(root, OUTPUT_PATHS.manifest), jsonBytes(manifest));
  return { artifact, manifest };
}

if (require.main === module) {
  const output = writeOutputs(ROOT);
  process.stdout.write(`${JSON.stringify({ ok: true, findingId: ID, status: output.artifact.status, rows: output.artifact.rows.length, classifications: output.artifact.genericApplicabilityGate.classificationCounts, admittedRows: output.artifact.admission.admittedRows.length, artifact: OUTPUT_PATHS.artifact, manifest: OUTPUT_PATHS.manifest }, null, 2)}\n`);
}

module.exports = {
  ROOT,
  ID,
  MODE,
  STATUS,
  GENERATED_AT,
  TARGET_REL,
  EXACT_COMMIT,
  EXACT_TREE,
  INPUTS,
  OUTPUT_PATHS,
  GENERIC_REQUIRED_OBSERVATIONS,
  BAD_DATA_CONTRADICTION_PAIR,
  BAD_DATA_CONTRADICTION_ORACLE,
  formatUnits,
  genericFingerprint,
  hasBadDataEqualBoundContradiction,
  familyHint,
  classifyPair,
  validateInventory,
  evaluateAdmission,
  deriveStatus,
  verifyInputs,
  validateArtifactData,
  buildArtifact,
  validateManifestData,
  buildManifest,
  writeOutputs,
};
