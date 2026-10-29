#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = 'solana-readonly-capability-v1';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const OUTPUT_RELATIVE_PATH = 'reports/raw/fast/solana-readonly-capability-restoration/capability.json';
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_MAX_BYTES = 64 * 1024;
const METHOD_SEQUENCE = Object.freeze([
  'getGenesisHash',
  'getSlot',
  'getBlockTime',
  'getAccountInfo',
]);

const TOP_LEVEL_KEYS = Object.freeze([
  'schema',
  'status',
  'chain',
  'genesis',
  'finalized',
  'clock',
  'calls',
  'safety',
  'nonClaims',
]);
const GENESIS_KEYS = Object.freeze(['expected', 'verified']);
const FINALIZED_KEYS = Object.freeze(['slot', 'blockTime', 'blockTimeUtc']);
const CLOCK_KEYS = Object.freeze([
  'class',
  'exists',
  'ownerVerified',
  'executable',
  'contextSlot',
  'minContextSlot',
  'minContextSlotSatisfied',
  'dataEncoding',
  'dataCanonical',
]);
const CALL_KEYS = Object.freeze(['methods', 'successful', 'retries']);
const SAFETY_EXPECTED = Object.freeze({
  capabilityOnly: true,
  targetBinding: false,
  targetProgramDataQueried: false,
  targetCensusPerformed: false,
  inventoryRead: false,
  configRead: false,
  externalInputAccepted: false,
  remoteIdentityPersisted: false,
  selectionMetadataPersisted: false,
  failureMetadataPersisted: false,
  transportMetadataPersisted: false,
  accountDataPersisted: false,
  lamportsPersisted: false,
  rentEpochPersisted: false,
  spacePersisted: false,
  redirectsFollowed: false,
  wslInvoked: false,
  solanaCliInvoked: false,
  secretsAccessed: false,
  keysAccessed: false,
  walletsAccessed: false,
  signing: false,
  simulation: false,
  transactions: false,
  fork: false,
  productionMutation: false,
  fundsMoved: false,
});
const SAFETY_KEYS = Object.freeze(Object.keys(SAFETY_EXPECTED));

const VALIDATION_CODES = new Set([
  'ARGS_FORBIDDEN',
  'EXEC_ARGV_FORBIDDEN',
  'ARTIFACT_MISSING',
  'ARTIFACT_NOT_REGULAR',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACT_ENCODING',
  'ARTIFACT_JSON',
  'ARTIFACT_STRUCTURE',
  'ARTIFACT_SCHEMA',
  'ARTIFACT_GENESIS',
  'ARTIFACT_FINALIZED',
  'ARTIFACT_CLOCK',
  'ARTIFACT_CALLS',
  'ARTIFACT_SAFETY',
  'ARTIFACT_NONCLAIMS',
  'ARTIFACT_FORBIDDEN',
  'INTERNAL',
]);

class ValidationError extends Error {
  constructor(code) {
    super(VALIDATION_CODES.has(code) ? code : 'INTERNAL');
    this.name = 'ValidationError';
    this.code = VALIDATION_CODES.has(code) ? code : 'INTERNAL';
  }
}

function invalid(code) {
  throw new ValidationError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

function assertExactKeys(value, expected, code) {
  if (!isPlainObject(value)) invalid(code);
  const actual = Object.keys(value);
  if (actual.length !== expected.length) invalid(code);
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) invalid(code);
  }
}

function requireSafeNonnegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(code);
}

function canonicalUtc(value) {
  requireSafeNonnegativeInteger(value, 'ARTIFACT_FINALIZED');
  const milliseconds = value * 1000;
  if (!Number.isSafeInteger(milliseconds)) invalid('ARTIFACT_FINALIZED');
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) invalid('ARTIFACT_FINALIZED');
  return date.toISOString();
}

function scanForbidden(value) {
  if (Array.isArray(value)) {
    for (const item of value) scanForbidden(item);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/(?:url|domain|hostname|provider)/i.test(key)) invalid('ARTIFACT_FORBIDDEN');
      if (/candidate(?:index|count)/i.test(key)) invalid('ARTIFACT_FORBIDDEN');
      if (/raw(?:error|response)|headers?/i.test(key)) invalid('ARTIFACT_FORBIDDEN');
      if (/endpoint(?:identity|selection|failure)/i.test(key)) invalid('ARTIFACT_FORBIDDEN');
      scanForbidden(item);
    }
    return;
  }
  if (typeof value === 'string') {
    if (/https?:\/\//i.test(value)) invalid('ARTIFACT_FORBIDDEN');
    if (/api\.mainnet|\.solana\.com/i.test(value)) invalid('ARTIFACT_FORBIDDEN');
    if (/rpc_endpoints|graphql_endpoints|base_full_stack|hyperevm_archive/i.test(value)) {
      invalid('ARTIFACT_FORBIDDEN');
    }
  }
}

function validateArtifact(artifact) {
  scanForbidden(artifact);
  assertExactKeys(artifact, TOP_LEVEL_KEYS, 'ARTIFACT_STRUCTURE');

  if (artifact.schema !== SCHEMA || artifact.status !== 'PASS' || artifact.chain !== 'mainnet') {
    invalid('ARTIFACT_SCHEMA');
  }

  assertExactKeys(artifact.genesis, GENESIS_KEYS, 'ARTIFACT_GENESIS');
  if (artifact.genesis.expected !== MAINNET_GENESIS || artifact.genesis.verified !== MAINNET_GENESIS) {
    invalid('ARTIFACT_GENESIS');
  }

  assertExactKeys(artifact.finalized, FINALIZED_KEYS, 'ARTIFACT_FINALIZED');
  requireSafeNonnegativeInteger(artifact.finalized.slot, 'ARTIFACT_FINALIZED');
  requireSafeNonnegativeInteger(artifact.finalized.blockTime, 'ARTIFACT_FINALIZED');
  if (artifact.finalized.blockTimeUtc !== canonicalUtc(artifact.finalized.blockTime)) {
    invalid('ARTIFACT_FINALIZED');
  }

  assertExactKeys(artifact.clock, CLOCK_KEYS, 'ARTIFACT_CLOCK');
  if (
    artifact.clock.class !== 'Clock'
    || artifact.clock.exists !== true
    || artifact.clock.ownerVerified !== true
    || artifact.clock.executable !== false
    || artifact.clock.minContextSlotSatisfied !== true
    || artifact.clock.dataEncoding !== 'base64'
    || artifact.clock.dataCanonical !== true
  ) {
    invalid('ARTIFACT_CLOCK');
  }
  requireSafeNonnegativeInteger(artifact.clock.contextSlot, 'ARTIFACT_CLOCK');
  requireSafeNonnegativeInteger(artifact.clock.minContextSlot, 'ARTIFACT_CLOCK');
  if (artifact.clock.minContextSlot !== artifact.finalized.slot) invalid('ARTIFACT_CLOCK');
  if (artifact.clock.contextSlot < artifact.clock.minContextSlot) invalid('ARTIFACT_CLOCK');

  assertExactKeys(artifact.calls, CALL_KEYS, 'ARTIFACT_CALLS');
  if (!Array.isArray(artifact.calls.methods) || artifact.calls.methods.length !== METHOD_SEQUENCE.length) {
    invalid('ARTIFACT_CALLS');
  }
  for (let index = 0; index < METHOD_SEQUENCE.length; index += 1) {
    if (artifact.calls.methods[index] !== METHOD_SEQUENCE[index]) invalid('ARTIFACT_CALLS');
  }
  if (artifact.calls.successful !== 4 || artifact.calls.retries !== 0) invalid('ARTIFACT_CALLS');

  assertExactKeys(artifact.safety, SAFETY_KEYS, 'ARTIFACT_SAFETY');
  for (const key of SAFETY_KEYS) {
    if (artifact.safety[key] !== SAFETY_EXPECTED[key]) invalid('ARTIFACT_SAFETY');
  }

  if (
    !Array.isArray(artifact.nonClaims)
    || artifact.nonClaims.length !== 1
    || artifact.nonClaims[0] !== 'CAPABILITY_ONLY_NO_TARGET_BINDING'
  ) {
    invalid('ARTIFACT_NONCLAIMS');
  }
  return true;
}

function validateSerializedArtifact(text) {
  if (typeof text !== 'string') invalid('ARTIFACT_ENCODING');
  if (Buffer.byteLength(text, 'utf8') > ARTIFACT_MAX_BYTES) invalid('ARTIFACT_TOO_LARGE');
  if (text.charCodeAt(0) === 0xfeff || text.includes('\u0000')) invalid('ARTIFACT_ENCODING');
  let artifact;
  try {
    artifact = JSON.parse(text);
  } catch (_) {
    invalid('ARTIFACT_JSON');
  }
  validateArtifact(artifact);
  if (text !== `${JSON.stringify(artifact, null, 2)}\n`) invalid('ARTIFACT_ENCODING');
  return artifact;
}

function validateFixedArtifact({ fsOps = fs, workspaceRoot = WORKSPACE_ROOT } = {}) {
  const artifactPath = path.resolve(workspaceRoot, OUTPUT_RELATIVE_PATH);
  let stat;
  try {
    stat = fsOps.lstatSync(artifactPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') invalid('ARTIFACT_MISSING');
    invalid('ARTIFACT_NOT_REGULAR');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) invalid('ARTIFACT_NOT_REGULAR');
  if (!Number.isSafeInteger(stat.size) || stat.size > ARTIFACT_MAX_BYTES) invalid('ARTIFACT_TOO_LARGE');
  let bytes;
  try {
    bytes = fsOps.readFileSync(artifactPath);
  } catch (_) {
    invalid('ARTIFACT_NOT_REGULAR');
  }
  if (!Buffer.isBuffer(bytes)) invalid('ARTIFACT_ENCODING');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) invalid('ARTIFACT_ENCODING');
  return validateSerializedArtifact(text);
}

function main() {
  try {
    if (process.argv.slice(2).length !== 0) invalid('ARGS_FORBIDDEN');
    if (process.execArgv.length !== 0) invalid('EXEC_ARGV_FORBIDDEN');
    validateFixedArtifact();
    process.stdout.write(`VALIDATION_OK ${OUTPUT_RELATIVE_PATH}\n`);
  } catch (error) {
    const code = error instanceof ValidationError ? error.code : 'INTERNAL';
    process.stderr.write(`VALIDATION_FAILED_${code}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ARTIFACT_MAX_BYTES,
  MAINNET_GENESIS,
  METHOD_SEQUENCE,
  OUTPUT_RELATIVE_PATH,
  SAFETY_EXPECTED,
  SCHEMA,
  ValidationError,
  validateArtifact,
  validateFixedArtifact,
  validateSerializedArtifact,
};
