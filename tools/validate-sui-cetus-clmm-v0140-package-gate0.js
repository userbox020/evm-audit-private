#!/usr/bin/env node
'use strict';

// Standalone offline validator. It imports no capture implementation and reads only the fixed artifact.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 'sui-cetus-clmm-v0140-package-gate0-v1';
const STATUS = 'PASS_DUAL_FAMILY_PACKAGE_CONSENSUS';
const CHAIN_ID = '35834a8a';
const REJECTED_CHAIN_ID = '4c78adac';
const CANONICAL_PACKAGE_ID = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb';
const CANDIDATE_PACKAGE_ID = '0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3';
const CANDIDATE_BCS_VERSION = '14';
const SOURCE_COMMIT = '925e98f36d6fdf6b59b14d500b3b4fb8d333b458';
const SOURCE_TREE = '3aed61ec06afe4dcff9d05a2c141319b27c05a0a';
const OUTPUT_RELATIVE_PATH = 'reports/raw/fast/sui-cetus-clmm-v0.14.0-gate0/package-consensus-capture.json';
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const MODULE_BYTES_MAX = 16 * 1024 * 1024;
const MAX_MODULES = 128;
const MAX_CALLS = 17;
const CHECKPOINT_AGE_MAX_MS = 120_000n;
const FUTURE_SKEW_MAX_MS = 5_000n;
const LATEST_SPREAD_MAX = 100n;
const METHOD_KEYS = Object.freeze([
  'sui_getChainIdentifier', 'sui_getLatestCheckpointSequenceNumber', 'sui_getCheckpoint',
  'sui_getObject', 'sui_getNormalizedMoveModulesByPackage',
]);
const NON_CLAIMS = Object.freeze([
  'CANDIDATE_IS_NOT_ESTABLISHED_AS_LATEST_UPGRADECAP_IMPLEMENTATION',
  'ACTIVE_POOLS_NOT_ESTABLISHED',
  'SOURCE_RUNTIME_EQUIVALENCE_NOT_ESTABLISHED',
  'DEPENDENCY_RUNTIME_EQUIVALENCE_NOT_ESTABLISHED',
  'TOOLCHAIN_BUILD_REPRODUCIBILITY_NOT_ESTABLISHED',
  'OFFLINE_VALIDATOR_DOES_NOT_REVALIDATE_PROVIDER_FAMILY_INDEPENDENCE',
  'MATERIALITY_NOT_ESTABLISHED',
  'PUBLIC_ROUTE_NOT_ESTABLISHED',
  'VULNERABILITY_NOT_ESTABLISHED',
  'FRESH_V14_SEMANTIC_CHANGE_NOT_ESTABLISHED',
  'NORMALIZED_ABI_IS_INSUFFICIENT_FOR_SEMANTIC_OR_SOURCE_EQUIVALENCE',
]);
const TOP_KEYS = Object.freeze(['schema', 'status', 'capturedAt', 'source', 'chainConsensus', 'endpointHandling',
  'packages', 'normalized', 'agreement', 'calls', 'proofScope', 'safety', 'nonClaims']);
const CAPTURED_KEYS = Object.freeze(['startedTimestampMs', 'startedTimestampUtc', 'completedTimestampMs', 'completedTimestampUtc']);
const SOURCE_KEYS = Object.freeze(['commit', 'tree', 'dependencySourceClosureExists']);
const CHAIN_KEYS = Object.freeze(['network', 'expectedChainIdentifier', 'verifiedChainIdentifier', 'checkpoint',
  'latestSpread', 'latestSpreadMaximum', 'checkpointAgeMaximumMs', 'futureSkewMaximumMs']);
const CHECKPOINT_KEYS = Object.freeze(['sequenceNumber', 'digest', 'epoch', 'timestampMs', 'timestampUtc']);
const ENDPOINT_KEYS = Object.freeze(['considered', 'chainQualified', 'latestQualified', 'checkpointQualified', 'packageComplete', 'selected', 'endpointIdentifiersPersisted',
  'providerIdentifiersPersisted', 'hostnameIdentifiersPersisted']);
const PACKAGES_KEYS = Object.freeze(['canonical', 'candidate']);
const PACKAGE_KEYS = Object.freeze(['objectId', 'objectVersion', 'digest', 'ownerKind', 'storageRebate', 'previousTransaction', 'bcs']);
const BCS_KEYS = Object.freeze(['dataType', 'packageId', 'packageVersion', 'moduleMap', 'typeOriginTable', 'linkageTable']);
const MODULE_KEYS = Object.freeze(['bytesBase64', 'decodedLength', 'sha256']);
const NORMALIZED_CAPTURED_KEYS = Object.freeze(['captured', 'supplementalOnly', 'packageId', 'moduleCount', 'moduleNames', 'modules']);
const NORMALIZED_ABSENT_KEYS = Object.freeze(['captured', 'supplementalOnly', 'packageId']);
const AGREEMENT_KEYS = Object.freeze(['twoIndependentInventoryFamilies', 'checkpointExact', 'canonicalObjectIdentityExact',
  'canonicalPackageBcsExact', 'candidateObjectIdentityExact', 'candidatePackageBcsExact', 'normalizedNamesEqualCandidateModuleMap']);
const CALL_KEYS = Object.freeze(['total', 'methodCounts', 'retries', 'fallbacks', 'packageFamilyReplacements', 'normalizedFallbacks']);
const PROOF_KEYS = Object.freeze(['validatorRevalidatesProviderFamilyIndependence', 'inventoryFamilyClassificationProcessOnly',
  'packageObjectAndBcsConsensusOnly', 'normalizedPayloadSupplementalOnly']);
const SAFETY_EXPECTED = Object.freeze({ inventoryReadInProcess: true, inventoryValuesPersisted: false,
  endpointValuesPersisted: false, providerNamesPersisted: false, rawResponsesPersisted: false,
  rawErrorsPersisted: false, retries: false, childProcesses: false, keysAccessed: false, signing: false,
  transactions: false, productionMutation: false, fundsMoved: false });
const SAFETY_KEYS = Object.freeze(Object.keys(SAFETY_EXPECTED));
const CODES = new Set(['ARGS_FORBIDDEN', 'EXEC_ARGV_FORBIDDEN', 'ARTIFACT_MISSING', 'ARTIFACT_NOT_REGULAR',
  'ARTIFACT_TOO_LARGE', 'ARTIFACT_ENCODING', 'ARTIFACT_JSON', 'ARTIFACT_STRUCTURE', 'ARTIFACT_SCHEMA',
  'ARTIFACT_CAPTURE_TIME', 'ARTIFACT_SOURCE', 'ARTIFACT_CHAIN', 'ARTIFACT_CHECKPOINT',
  'ARTIFACT_ENDPOINT_HANDLING', 'ARTIFACT_PACKAGE', 'ARTIFACT_MODULE_MAP', 'ARTIFACT_TYPE_ORIGIN',
  'ARTIFACT_LINKAGE', 'ARTIFACT_NORMALIZED', 'ARTIFACT_AGREEMENT', 'ARTIFACT_CALLS',
  'ARTIFACT_PROOF_SCOPE', 'ARTIFACT_SAFETY', 'ARTIFACT_NONCLAIMS', 'ARTIFACT_FORBIDDEN', 'INTERNAL']);
class ValidationError extends Error {
  constructor(code) { const safe = CODES.has(code) ? code : 'INTERNAL'; super(safe); this.name = 'ValidationError'; this.code = safe; }
}
function invalid(code) { throw new ValidationError(code); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function isPlainObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)); }
function exactKeys(value, keys, code) {
  if (!isPlainObject(value)) invalid(code); const actual = Object.keys(value); if (actual.length !== keys.length) invalid(code);
  for (let index = 0; index < keys.length; index += 1) if (actual[index] !== keys[index]) invalid(code);
}
function decimalU64(value, code) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) invalid(code);
  const parsed = BigInt(value); if (parsed > 18446744073709551615n) invalid(code); return parsed;
}
function safeCount(value, min, max, code) { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(code); return value; }
function objectId(value) { return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value); }
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeBase58(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null; let number = 0n;
  for (const character of value) { const digit = BASE58_ALPHABET.indexOf(character); if (digit < 0) return null; number = number * 58n + BigInt(digit); }
  const bytes = []; while (number > 0n) { bytes.push(Number(number & 255n)); number >>= 8n; } bytes.reverse();
  let leading = 0; while (leading < value.length && value[leading] === '1') leading += 1;
  return Buffer.concat([Buffer.alloc(leading), Buffer.from(bytes)]);
}
function digest(value) { const bytes = decodeBase58(value); return Boolean(bytes && bytes.length === 32); }
function canonicalUtc(milliseconds, code) {
  const value = decimalU64(milliseconds, code); if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(code);
  const date = new Date(Number(value)); if (!Number.isFinite(date.getTime())) invalid(code); return date.toISOString();
}
function decodeBase64(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid(code);
  const bytes = Buffer.from(value, 'base64'); if (bytes.toString('base64') !== value) invalid(code); return bytes;
}
function scanLeaks(value, keyName = '') {
  if (Array.isArray(value)) { for (const item of value) scanLeaks(item, keyName); return; }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/https?:\/\//i.test(key) || /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i.test(key)
        || /^(?:endpoint|url|hostname|domain|provider|credential|authorization|api[-_]?key|rawResponse|rawError)$/i.test(key)) invalid('ARTIFACT_FORBIDDEN');
      scanLeaks(item, key);
    }
    return;
  }
  if (typeof value !== 'string') return;
  if (/https?:\/\//i.test(value) || /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i.test(value)
    || /(?:authorization|bearer|api[-_]?key)\s*[:=]/i.test(value)) invalid('ARTIFACT_FORBIDDEN');
  if (/^(?:endpoint|url|hostname|domain|provider|credential|authorization|api[-_]?key|rawResponse|rawError)$/i.test(keyName)) invalid('ARTIFACT_FORBIDDEN');
}
function validateTypeOrigins(value) {
  if (!Array.isArray(value) || value.length > 100_000) invalid('ARTIFACT_TYPE_ORIGIN');
  for (const entry of value) {
    exactKeys(entry, ['module_name', 'datatype_name', 'package'], 'ARTIFACT_TYPE_ORIGIN');
    if (typeof entry.module_name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.module_name)
      || typeof entry.datatype_name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.datatype_name)
      || !objectId(entry.package)) invalid('ARTIFACT_TYPE_ORIGIN');
  }
}
function validateLinkage(value) {
  if (!isPlainObject(value) || Object.keys(value).length > 10_000) invalid('ARTIFACT_LINKAGE');
  const keys = Object.keys(value); const sorted = [...keys].sort();
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== sorted[index] || !objectId(keys[index])) invalid('ARTIFACT_LINKAGE'); const entry = value[keys[index]];
    if (!isPlainObject(entry)) invalid('ARTIFACT_LINKAGE'); const fields = Object.keys(entry);
    if (fields.length !== 2 || fields[0] !== 'upgraded_id' || fields[1] !== 'upgraded_version') invalid('ARTIFACT_LINKAGE');
    if (!objectId(entry.upgraded_id)) invalid('ARTIFACT_LINKAGE'); decimalU64(entry.upgraded_version, 'ARTIFACT_LINKAGE');
  }
}
function validatePackage(value, expectedId, expectedVersion = null) {
  exactKeys(value, PACKAGE_KEYS, 'ARTIFACT_PACKAGE');
  if (value.objectId !== expectedId || value.ownerKind !== 'Immutable' || !digest(value.digest)
    || !digest(value.previousTransaction)) invalid('ARTIFACT_PACKAGE');
  decimalU64(value.objectVersion, 'ARTIFACT_PACKAGE'); decimalU64(value.storageRebate, 'ARTIFACT_PACKAGE');
  exactKeys(value.bcs, BCS_KEYS, 'ARTIFACT_PACKAGE');
  if (value.bcs.dataType !== 'package' || value.bcs.packageId !== expectedId) invalid('ARTIFACT_PACKAGE');
  decimalU64(value.bcs.packageVersion, 'ARTIFACT_PACKAGE'); if (expectedVersion !== null && value.bcs.packageVersion !== expectedVersion) invalid('ARTIFACT_PACKAGE');
  if (!isPlainObject(value.bcs.moduleMap)) invalid('ARTIFACT_MODULE_MAP'); const names = Object.keys(value.bcs.moduleMap); const sorted = [...names].sort();
  if (names.length === 0 || names.length > MAX_MODULES) invalid('ARTIFACT_MODULE_MAP'); let total = 0;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]; if (name !== sorted[index] || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) invalid('ARTIFACT_MODULE_MAP');
    const entry = value.bcs.moduleMap[name]; exactKeys(entry, MODULE_KEYS, 'ARTIFACT_MODULE_MAP'); const bytes = decodeBase64(entry.bytesBase64, 'ARTIFACT_MODULE_MAP');
    total += bytes.length; if (total > MODULE_BYTES_MAX || entry.decodedLength !== bytes.length
      || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || entry.sha256 !== sha256(bytes)) invalid('ARTIFACT_MODULE_MAP');
  }
  validateTypeOrigins(value.bcs.typeOriginTable); validateLinkage(value.bcs.linkageTable); return names;
}
function validateJsonTree(value, depth = 0) {
  if (depth > 64) invalid('ARTIFACT_NORMALIZED');
  if (Array.isArray(value)) { for (const item of value) validateJsonTree(item, depth + 1); return; }
  if (isPlainObject(value)) {
    const keys = Object.keys(value); const sorted = [...keys].sort(); for (let index = 0; index < keys.length; index += 1) {
      if (keys[index] !== sorted[index] || ['__proto__', 'prototype', 'constructor'].includes(keys[index])) invalid('ARTIFACT_NORMALIZED');
      validateJsonTree(value[keys[index]], depth + 1);
    } return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  invalid('ARTIFACT_NORMALIZED');
}
function validateArtifact(artifact) {
  scanLeaks(artifact); exactKeys(artifact, TOP_KEYS, 'ARTIFACT_STRUCTURE');
  if (artifact.schema !== SCHEMA || artifact.status !== STATUS) invalid('ARTIFACT_SCHEMA');
  exactKeys(artifact.capturedAt, CAPTURED_KEYS, 'ARTIFACT_CAPTURE_TIME');
  const started = decimalU64(artifact.capturedAt.startedTimestampMs, 'ARTIFACT_CAPTURE_TIME');
  const completed = decimalU64(artifact.capturedAt.completedTimestampMs, 'ARTIFACT_CAPTURE_TIME');
  if (completed < started || artifact.capturedAt.startedTimestampUtc !== canonicalUtc(artifact.capturedAt.startedTimestampMs, 'ARTIFACT_CAPTURE_TIME')
    || artifact.capturedAt.completedTimestampUtc !== canonicalUtc(artifact.capturedAt.completedTimestampMs, 'ARTIFACT_CAPTURE_TIME')) invalid('ARTIFACT_CAPTURE_TIME');
  exactKeys(artifact.source, SOURCE_KEYS, 'ARTIFACT_SOURCE'); if (artifact.source.commit !== SOURCE_COMMIT || artifact.source.tree !== SOURCE_TREE
    || artifact.source.dependencySourceClosureExists !== true) invalid('ARTIFACT_SOURCE');
  exactKeys(artifact.chainConsensus, CHAIN_KEYS, 'ARTIFACT_CHAIN');
  if (artifact.chainConsensus.network !== 'sui-mainnet' || artifact.chainConsensus.expectedChainIdentifier !== CHAIN_ID
    || artifact.chainConsensus.verifiedChainIdentifier !== CHAIN_ID || artifact.chainConsensus.verifiedChainIdentifier === REJECTED_CHAIN_ID
    || artifact.chainConsensus.latestSpreadMaximum !== String(LATEST_SPREAD_MAX)
    || artifact.chainConsensus.checkpointAgeMaximumMs !== String(CHECKPOINT_AGE_MAX_MS)
    || artifact.chainConsensus.futureSkewMaximumMs !== String(FUTURE_SKEW_MAX_MS)) invalid('ARTIFACT_CHAIN');
  const spread = decimalU64(artifact.chainConsensus.latestSpread, 'ARTIFACT_CHAIN'); if (spread > LATEST_SPREAD_MAX) invalid('ARTIFACT_CHAIN');
  exactKeys(artifact.chainConsensus.checkpoint, CHECKPOINT_KEYS, 'ARTIFACT_CHECKPOINT'); const checkpoint = artifact.chainConsensus.checkpoint;
  decimalU64(checkpoint.sequenceNumber, 'ARTIFACT_CHECKPOINT'); decimalU64(checkpoint.epoch, 'ARTIFACT_CHECKPOINT'); const checkpointTime = decimalU64(checkpoint.timestampMs, 'ARTIFACT_CHECKPOINT');
  if (!digest(checkpoint.digest) || checkpoint.timestampUtc !== canonicalUtc(checkpoint.timestampMs, 'ARTIFACT_CHECKPOINT')
    || checkpointTime > completed + FUTURE_SKEW_MAX_MS || completed > checkpointTime && completed - checkpointTime > CHECKPOINT_AGE_MAX_MS) invalid('ARTIFACT_CHECKPOINT');
  exactKeys(artifact.endpointHandling, ENDPOINT_KEYS, 'ARTIFACT_ENDPOINT_HANDLING');
  const handling = artifact.endpointHandling; safeCount(handling.considered, 2, 3, 'ARTIFACT_ENDPOINT_HANDLING');
  safeCount(handling.chainQualified, 2, handling.considered, 'ARTIFACT_ENDPOINT_HANDLING');
  safeCount(handling.latestQualified, 2, handling.chainQualified, 'ARTIFACT_ENDPOINT_HANDLING');
  safeCount(handling.checkpointQualified, 2, handling.latestQualified, 'ARTIFACT_ENDPOINT_HANDLING');
  safeCount(handling.packageComplete, 2, 3, 'ARTIFACT_ENDPOINT_HANDLING');
  if (handling.selected !== 2
    || artifact.endpointHandling.endpointIdentifiersPersisted !== false || artifact.endpointHandling.providerIdentifiersPersisted !== false
    || artifact.endpointHandling.hostnameIdentifiersPersisted !== false) invalid('ARTIFACT_ENDPOINT_HANDLING');
  exactKeys(artifact.packages, PACKAGES_KEYS, 'ARTIFACT_PACKAGE'); const canonicalNames = validatePackage(artifact.packages.canonical, CANONICAL_PACKAGE_ID);
  const candidateNames = validatePackage(artifact.packages.candidate, CANDIDATE_PACKAGE_ID, CANDIDATE_BCS_VERSION);
  const normalizedCaptured = artifact.normalized && artifact.normalized.captured === true;
  exactKeys(artifact.normalized, normalizedCaptured ? NORMALIZED_CAPTURED_KEYS : NORMALIZED_ABSENT_KEYS, 'ARTIFACT_NORMALIZED');
  if (artifact.normalized.supplementalOnly !== true || artifact.normalized.packageId !== CANDIDATE_PACKAGE_ID
    || artifact.normalized.captured !== normalizedCaptured) invalid('ARTIFACT_NORMALIZED');
  if (normalizedCaptured) {
    if (artifact.normalized.moduleCount !== candidateNames.length || !Array.isArray(artifact.normalized.moduleNames)
      || artifact.normalized.moduleNames.length !== candidateNames.length) invalid('ARTIFACT_NORMALIZED');
    for (let index = 0; index < candidateNames.length; index += 1) if (artifact.normalized.moduleNames[index] !== candidateNames[index]) invalid('ARTIFACT_NORMALIZED');
    if (!isPlainObject(artifact.normalized.modules) || Object.keys(artifact.normalized.modules).length !== candidateNames.length) invalid('ARTIFACT_NORMALIZED');
    for (let index = 0; index < candidateNames.length; index += 1) if (Object.keys(artifact.normalized.modules)[index] !== candidateNames[index]) invalid('ARTIFACT_NORMALIZED');
    validateJsonTree(artifact.normalized.modules); if (Buffer.byteLength(JSON.stringify(artifact.normalized.modules), 'utf8') > RESPONSE_MAX_BYTES) invalid('ARTIFACT_NORMALIZED');
  }
  exactKeys(artifact.agreement, AGREEMENT_KEYS, 'ARTIFACT_AGREEMENT');
  for (const key of AGREEMENT_KEYS.slice(0, -1)) if (artifact.agreement[key] !== true) invalid('ARTIFACT_AGREEMENT');
  if (artifact.agreement.normalizedNamesEqualCandidateModuleMap !== (normalizedCaptured ? true : null)) invalid('ARTIFACT_AGREEMENT');
  exactKeys(artifact.calls, CALL_KEYS, 'ARTIFACT_CALLS'); exactKeys(artifact.calls.methodCounts, METHOD_KEYS, 'ARTIFACT_CALLS');
  const counts = artifact.calls.methodCounts; for (const key of METHOD_KEYS) safeCount(counts[key], 0, MAX_CALLS, 'ARTIFACT_CALLS');
  if (counts.sui_getChainIdentifier !== handling.considered
    || counts.sui_getLatestCheckpointSequenceNumber !== handling.chainQualified
    || counts.sui_getCheckpoint !== handling.latestQualified
    || counts.sui_getChainIdentifier + counts.sui_getLatestCheckpointSequenceNumber + counts.sui_getCheckpoint > 9
    || ![4, 6].includes(counts.sui_getObject) || counts.sui_getNormalizedMoveModulesByPackage < 1
    || counts.sui_getNormalizedMoveModulesByPackage > 2) invalid('ARTIFACT_CALLS');
  const packageAttempts = counts.sui_getObject / 2;
  if (handling.checkpointQualified > counts.sui_getCheckpoint || handling.packageComplete > packageAttempts
    || packageAttempts > handling.checkpointQualified) invalid('ARTIFACT_CALLS');
  const sum = METHOD_KEYS.reduce((total, key) => total + counts[key], 0); if (artifact.calls.total !== sum || sum > MAX_CALLS || sum < 11
    || artifact.calls.retries !== 0 || ![0, 1].includes(artifact.calls.packageFamilyReplacements)
    || ![0, 1].includes(artifact.calls.normalizedFallbacks)
    || artifact.calls.fallbacks !== artifact.calls.packageFamilyReplacements + artifact.calls.normalizedFallbacks
    || (counts.sui_getObject === 6) !== (artifact.calls.packageFamilyReplacements === 1)
    || (counts.sui_getNormalizedMoveModulesByPackage === 2) !== (artifact.calls.normalizedFallbacks === 1)
    || !normalizedCaptured && (counts.sui_getNormalizedMoveModulesByPackage !== 2 || artifact.calls.normalizedFallbacks !== 1)) invalid('ARTIFACT_CALLS');
  exactKeys(artifact.proofScope, PROOF_KEYS, 'ARTIFACT_PROOF_SCOPE');
  if (artifact.proofScope.validatorRevalidatesProviderFamilyIndependence !== false || artifact.proofScope.inventoryFamilyClassificationProcessOnly !== true
    || artifact.proofScope.packageObjectAndBcsConsensusOnly !== true || artifact.proofScope.normalizedPayloadSupplementalOnly !== true) invalid('ARTIFACT_PROOF_SCOPE');
  exactKeys(artifact.safety, SAFETY_KEYS, 'ARTIFACT_SAFETY'); for (const key of SAFETY_KEYS) if (artifact.safety[key] !== SAFETY_EXPECTED[key]) invalid('ARTIFACT_SAFETY');
  if (!Array.isArray(artifact.nonClaims) || artifact.nonClaims.length !== NON_CLAIMS.length) invalid('ARTIFACT_NONCLAIMS');
  for (let index = 0; index < NON_CLAIMS.length; index += 1) if (artifact.nonClaims[index] !== NON_CLAIMS[index]) invalid('ARTIFACT_NONCLAIMS');
  // The two module sets need not be equal; this gate compares each package independently.
  if (canonicalNames.length < 1) invalid('ARTIFACT_MODULE_MAP'); return true;
}
function validateSerializedArtifact(text) {
  if (typeof text !== 'string') invalid('ARTIFACT_ENCODING'); if (Buffer.byteLength(text, 'utf8') > OUTPUT_MAX_BYTES) invalid('ARTIFACT_TOO_LARGE');
  if (text.charCodeAt(0) === 0xfeff || text.includes('\u0000')) invalid('ARTIFACT_ENCODING'); let artifact;
  try { artifact = JSON.parse(text); } catch (_) { invalid('ARTIFACT_JSON'); } validateArtifact(artifact);
  if (text !== `${JSON.stringify(artifact, null, 2)}\n`) invalid('ARTIFACT_ENCODING'); return artifact;
}
function validateFixedArtifact({ workspaceRoot = WORKSPACE_ROOT, fsOps = fs } = {}) {
  const root = path.resolve(workspaceRoot); const artifactPath = path.resolve(root, OUTPUT_RELATIVE_PATH); const relative = path.relative(root, artifactPath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) invalid('ARTIFACT_NOT_REGULAR');
  let stat; try { stat = fsOps.lstatSync(artifactPath); } catch (error) { if (error && error.code === 'ENOENT') invalid('ARTIFACT_MISSING'); invalid('ARTIFACT_NOT_REGULAR'); }
  if (!stat.isFile() || stat.isSymbolicLink()) invalid('ARTIFACT_NOT_REGULAR'); if (!Number.isSafeInteger(stat.size) || stat.size > OUTPUT_MAX_BYTES) invalid('ARTIFACT_TOO_LARGE');
  let bytes; try { bytes = fsOps.readFileSync(artifactPath); } catch (_) { invalid('ARTIFACT_NOT_REGULAR'); }
  const text = bytes.toString('utf8'); if (!Buffer.from(text, 'utf8').equals(bytes)) invalid('ARTIFACT_ENCODING'); return validateSerializedArtifact(text);
}
function main() {
  try { if (process.argv.slice(2).length !== 0) invalid('ARGS_FORBIDDEN'); if (process.execArgv.length !== 0) invalid('EXEC_ARGV_FORBIDDEN');
    validateFixedArtifact(); process.stdout.write(`VALIDATION_OK ${OUTPUT_RELATIVE_PATH}\n`);
  } catch (error) { const code = error instanceof ValidationError ? error.code : 'INTERNAL'; process.stderr.write(`VALIDATION_FAILED_${code}\n`); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { CANONICAL_PACKAGE_ID, CANDIDATE_BCS_VERSION, CANDIDATE_PACKAGE_ID, CHAIN_ID, CODES,
  METHOD_KEYS, NON_CLAIMS, OUTPUT_MAX_BYTES, OUTPUT_RELATIVE_PATH, REJECTED_CHAIN_ID, RESPONSE_MAX_BYTES,
  SCHEMA, SOURCE_COMMIT, SOURCE_TREE, STATUS, ValidationError, canonicalUtc, decodeBase58, sha256, validateArtifact,
  validateFixedArtifact, validateSerializedArtifact };
