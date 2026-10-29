#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 'solana-programdata-temporal-klend-v125-v1';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TARGET_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const SOURCE_COMMIT = 'a08760976f51a3a58c4a0c6ea27b4a0e565bca79';
const SOURCE_TREE = '4e7db43227426d9bd72c3c29c3ece7f9743f1a8a';
const SOURCE_TAG = 'release/v1.25.0';
const PUBLICATION_THRESHOLD_UNIX = 1787071320;
const PUBLICATION_THRESHOLD_UTC = '2026-08-18T16:42:00Z';
const OUTPUT_RELATIVE_PATH = 'reports/raw/fast/solana-kamino-lending-v1.25.0-gate0/programdata-temporal-capture.json';
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_MAX_BYTES = 24 * 1024 * 1024;
const PROGRAM_METADATA_LENGTH = 36;
const PROGRAMDATA_PAYLOAD_OFFSET = 45;
const ELF_HEADER_MIN_LENGTH = 64;
const EM_BPF = 247;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const METHOD_SEQUENCE = Object.freeze([
  'getGenesisHash', 'getSlot', 'getBlockTime', 'getAccountInfo', 'getAccountInfo', 'getBlockTime',
]);

const TOP_KEYS = Object.freeze([
  'schema', 'status', 'chain', 'genesis', 'source', 'finalized', 'program', 'programData',
  'calls', 'safety', 'nonClaims',
]);
const GENESIS_KEYS = Object.freeze(['expected', 'verified']);
const SOURCE_KEYS = Object.freeze([
  'commit', 'tree', 'tag', 'publicationThresholdUnix', 'publicationThresholdUtc',
]);
const FINALIZED_KEYS = Object.freeze(['slot', 'blockTime', 'blockTimeUtc']);
const PROGRAM_KEYS = Object.freeze([
  'address', 'owner', 'executable', 'contextSlot', 'accountBytesBase64',
  'accountBytesLength', 'accountBytesSha256', 'stateTag', 'derivedProgramDataAddress',
]);
const PROGRAMDATA_KEYS = Object.freeze([
  'address', 'owner', 'executable', 'contextSlot', 'accountBytesBase64',
  'accountBytesLength', 'accountBytesSha256', 'stateTag', 'deploymentSlot',
  'deploymentBlockTime', 'deploymentBlockTimeUtc', 'authorityOption', 'authority',
  'payloadOffset', 'payloadLength', 'payloadSha256', 'elf',
]);
const ELF_KEYS = Object.freeze(['magicHex', 'class', 'data', 'identVersion', 'machine', 'version']);
const CALL_KEYS = Object.freeze(['methods', 'successful', 'retries']);
const SAFETY_EXPECTED = Object.freeze({
  singleFamilyObservation: true,
  independenceClaimed: false,
  networkIdentityPersisted: false,
  requestMetadataPersisted: false,
  failureDetailPersisted: false,
  externalResourceListRead: false,
  localConfigurationRead: false,
  capabilityArtifactRead: false,
  sourceFilesRead: false,
  accountBytesRetained: true,
  walletsAccessed: false,
  keysAccessed: false,
  wslInvoked: false,
  cliInvoked: false,
  dependencyAcquisition: false,
  build: false,
  tests: false,
  signing: false,
  simulation: false,
  transactions: false,
  fork: false,
  productionMutation: false,
  fundsMoved: false,
});
const SAFETY_KEYS = Object.freeze(Object.keys(SAFETY_EXPECTED));
const CODES = new Set([
  'ARGS_FORBIDDEN', 'EXEC_ARGV_FORBIDDEN', 'ARTIFACT_MISSING', 'ARTIFACT_NOT_REGULAR',
  'ARTIFACT_TOO_LARGE', 'ARTIFACT_ENCODING', 'ARTIFACT_JSON', 'ARTIFACT_STRUCTURE',
  'ARTIFACT_SCHEMA', 'ARTIFACT_GENESIS', 'ARTIFACT_SOURCE', 'ARTIFACT_FINALIZED', 'ARTIFACT_PROGRAM',
  'ARTIFACT_PROGRAMDATA', 'ARTIFACT_ELF', 'ARTIFACT_CALLS', 'ARTIFACT_SAFETY',
  'ARTIFACT_NONCLAIMS', 'ARTIFACT_FORBIDDEN', 'INTERNAL',
]);

class ValidationError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'INTERNAL';
    super(safe);
    this.name = 'ValidationError';
    this.code = safe;
  }
}

function invalid(code) {
  throw new ValidationError(code);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function exactKeys(value, expected, code) {
  if (!isPlainObject(value)) invalid(code);
  const keys = Object.keys(value);
  if (keys.length !== expected.length) invalid(code);
  for (let index = 0; index < expected.length; index += 1) {
    if (keys[index] !== expected[index]) invalid(code);
  }
}

function safeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(code);
  return value;
}

function canonicalUtc(seconds, code) {
  safeInteger(seconds, code);
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) invalid(code);
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) invalid(code);
  return date.toISOString().replace('.000Z', 'Z');
}

function encodeBase58(bytes) {
  const input = Buffer.from(bytes);
  let value = 0n;
  for (const byte of input) value = (value << 8n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leading = 0;
  while (leading < input.length && input[leading] === 0) leading += 1;
  return '1'.repeat(leading) + encoded;
}

function decodeBase58(value, code) {
  if (typeof value !== 'string' || value.length === 0) invalid(code);
  let number = 0n;
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) invalid(code);
    number = number * 58n + BigInt(index);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.push(Number(number & 0xffn));
    number >>= 8n;
  }
  bytes.reverse();
  let leading = 0;
  while (leading < value.length && value[leading] === '1') leading += 1;
  const decoded = Buffer.concat([Buffer.alloc(leading), Buffer.from(bytes)]);
  if (encodeBase58(decoded) !== value) invalid(code);
  return decoded;
}

function decodeCanonicalBase64(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) invalid(code);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid(code);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) invalid(code);
  return bytes;
}

function scanLeaks(value, keyName = '') {
  if (Array.isArray(value)) {
    for (const item of value) scanLeaks(item, keyName);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/(url|host|provider|endpoint|header|raw.?error|transport|inventory)/i.test(key)) {
        invalid('ARTIFACT_FORBIDDEN');
      }
      scanLeaks(item, key);
    }
    return;
  }
  if (typeof value === 'string' && !/accountBytesBase64/i.test(keyName)) {
    if (/https?:\/\//i.test(value)) invalid('ARTIFACT_FORBIDDEN');
    if (/(api\.mainnet|\.solana\.com|provider|endpoint|hostname|raw.?error|retry-after)/i.test(value)) {
      invalid('ARTIFACT_FORBIDDEN');
    }
  }
}

function validateElf(payload, elf) {
  exactKeys(elf, ELF_KEYS, 'ARTIFACT_ELF');
  if (payload.length < ELF_HEADER_MIN_LENGTH) invalid('ARTIFACT_ELF');
  if (payload[0] !== 0x7f || payload[1] !== 0x45 || payload[2] !== 0x4c || payload[3] !== 0x46) {
    invalid('ARTIFACT_ELF');
  }
  if (payload[4] !== 2 || payload[5] !== 1 || payload[6] !== 1) invalid('ARTIFACT_ELF');
  if (payload.readUInt16LE(18) !== EM_BPF || payload.readUInt32LE(20) !== 1) invalid('ARTIFACT_ELF');
  if (
    elf.magicHex !== '7f454c46' || elf.class !== 2 || elf.data !== 1
    || elf.identVersion !== 1 || elf.machine !== EM_BPF || elf.version !== 1
  ) invalid('ARTIFACT_ELF');
}

function validateArtifact(artifact) {
  scanLeaks(artifact);
  exactKeys(artifact, TOP_KEYS, 'ARTIFACT_STRUCTURE');
  if (artifact.schema !== SCHEMA || artifact.status !== 'PASS' || artifact.chain !== 'mainnet') {
    invalid('ARTIFACT_SCHEMA');
  }

  exactKeys(artifact.genesis, GENESIS_KEYS, 'ARTIFACT_GENESIS');
  if (artifact.genesis.expected !== MAINNET_GENESIS || artifact.genesis.verified !== MAINNET_GENESIS) {
    invalid('ARTIFACT_GENESIS');
  }

  exactKeys(artifact.source, SOURCE_KEYS, 'ARTIFACT_SOURCE');
  if (
    artifact.source.commit !== SOURCE_COMMIT || artifact.source.tree !== SOURCE_TREE
    || artifact.source.tag !== SOURCE_TAG
    || artifact.source.publicationThresholdUnix !== PUBLICATION_THRESHOLD_UNIX
    || artifact.source.publicationThresholdUtc !== PUBLICATION_THRESHOLD_UTC
  ) invalid('ARTIFACT_SOURCE');

  exactKeys(artifact.finalized, FINALIZED_KEYS, 'ARTIFACT_FINALIZED');
  safeInteger(artifact.finalized.slot, 'ARTIFACT_FINALIZED');
  safeInteger(artifact.finalized.blockTime, 'ARTIFACT_FINALIZED');
  if (artifact.finalized.blockTimeUtc !== canonicalUtc(artifact.finalized.blockTime, 'ARTIFACT_FINALIZED')) {
    invalid('ARTIFACT_FINALIZED');
  }

  exactKeys(artifact.program, PROGRAM_KEYS, 'ARTIFACT_PROGRAM');
  if (
    artifact.program.address !== TARGET_PROGRAM || artifact.program.owner !== UPGRADEABLE_LOADER
    || artifact.program.executable !== true || artifact.program.stateTag !== 2
  ) invalid('ARTIFACT_PROGRAM');
  safeInteger(artifact.program.contextSlot, 'ARTIFACT_PROGRAM');
  if (artifact.program.contextSlot < artifact.finalized.slot) invalid('ARTIFACT_PROGRAM');
  const programBytes = decodeCanonicalBase64(artifact.program.accountBytesBase64, 'ARTIFACT_PROGRAM');
  if (
    programBytes.length !== PROGRAM_METADATA_LENGTH
    || artifact.program.accountBytesLength !== programBytes.length
    || artifact.program.accountBytesSha256 !== sha256(programBytes)
    || programBytes.readUInt32LE(0) !== 2
  ) invalid('ARTIFACT_PROGRAM');
  const linkedBytes = programBytes.subarray(4, 36);
  const linkedAddress = encodeBase58(linkedBytes);
  if (linkedBytes.length !== 32 || decodeBase58(linkedAddress, 'ARTIFACT_PROGRAM').length !== 32) {
    invalid('ARTIFACT_PROGRAM');
  }
  if (artifact.program.derivedProgramDataAddress !== linkedAddress) invalid('ARTIFACT_PROGRAM');

  exactKeys(artifact.programData, PROGRAMDATA_KEYS, 'ARTIFACT_PROGRAMDATA');
  if (
    artifact.programData.address !== linkedAddress || artifact.programData.owner !== UPGRADEABLE_LOADER
    || artifact.programData.executable !== false || artifact.programData.stateTag !== 3
  ) invalid('ARTIFACT_PROGRAMDATA');
  safeInteger(artifact.programData.contextSlot, 'ARTIFACT_PROGRAMDATA');
  if (artifact.programData.contextSlot < artifact.finalized.slot) invalid('ARTIFACT_PROGRAMDATA');
  const programDataBytes = decodeCanonicalBase64(artifact.programData.accountBytesBase64, 'ARTIFACT_PROGRAMDATA');
  if (
    programDataBytes.length < PROGRAMDATA_PAYLOAD_OFFSET + ELF_HEADER_MIN_LENGTH
    || artifact.programData.accountBytesLength !== programDataBytes.length
    || artifact.programData.accountBytesSha256 !== sha256(programDataBytes)
    || programDataBytes.readUInt32LE(0) !== 3
  ) invalid('ARTIFACT_PROGRAMDATA');
  const slotBig = programDataBytes.readBigUInt64LE(4);
  if (slotBig > BigInt(Number.MAX_SAFE_INTEGER)) invalid('ARTIFACT_PROGRAMDATA');
  const deploymentSlot = Number(slotBig);
  if (artifact.programData.deploymentSlot !== deploymentSlot || deploymentSlot > artifact.programData.contextSlot) {
    invalid('ARTIFACT_PROGRAMDATA');
  }
  const authorityOption = programDataBytes[12];
  if ((authorityOption !== 0 && authorityOption !== 1) || artifact.programData.authorityOption !== authorityOption) {
    invalid('ARTIFACT_PROGRAMDATA');
  }
  const authority = authorityOption === 1 ? encodeBase58(programDataBytes.subarray(13, 45)) : null;
  if (authorityOption === 1 && decodeBase58(authority, 'ARTIFACT_PROGRAMDATA').length !== 32) {
    invalid('ARTIFACT_PROGRAMDATA');
  }
  if (artifact.programData.authority !== authority) invalid('ARTIFACT_PROGRAMDATA');
  if (artifact.programData.payloadOffset !== PROGRAMDATA_PAYLOAD_OFFSET) invalid('ARTIFACT_PROGRAMDATA');
  const payload = programDataBytes.subarray(PROGRAMDATA_PAYLOAD_OFFSET);
  if (artifact.programData.payloadLength !== payload.length || artifact.programData.payloadSha256 !== sha256(payload)) {
    invalid('ARTIFACT_PROGRAMDATA');
  }
  safeInteger(artifact.programData.deploymentBlockTime, 'ARTIFACT_PROGRAMDATA');
  if (artifact.programData.deploymentBlockTime < PUBLICATION_THRESHOLD_UNIX) invalid('ARTIFACT_PROGRAMDATA');
  if (
    artifact.programData.deploymentBlockTimeUtc
    !== canonicalUtc(artifact.programData.deploymentBlockTime, 'ARTIFACT_PROGRAMDATA')
  ) invalid('ARTIFACT_PROGRAMDATA');
  validateElf(payload, artifact.programData.elf);

  exactKeys(artifact.calls, CALL_KEYS, 'ARTIFACT_CALLS');
  if (!Array.isArray(artifact.calls.methods) || artifact.calls.methods.length !== METHOD_SEQUENCE.length) {
    invalid('ARTIFACT_CALLS');
  }
  for (let index = 0; index < METHOD_SEQUENCE.length; index += 1) {
    if (artifact.calls.methods[index] !== METHOD_SEQUENCE[index]) invalid('ARTIFACT_CALLS');
  }
  if (artifact.calls.successful !== 6 || artifact.calls.retries !== 0) invalid('ARTIFACT_CALLS');

  exactKeys(artifact.safety, SAFETY_KEYS, 'ARTIFACT_SAFETY');
  for (const key of SAFETY_KEYS) {
    if (artifact.safety[key] !== SAFETY_EXPECTED[key]) invalid('ARTIFACT_SAFETY');
  }
  if (
    !Array.isArray(artifact.nonClaims) || artifact.nonClaims.length !== 1
    || artifact.nonClaims[0] !== 'SINGLE_FAMILY_TEMPORAL_PLAUSIBILITY_ONLY_RUNTIME_UNBOUND'
  ) invalid('ARTIFACT_NONCLAIMS');
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

function validateFixedArtifact({ workspaceRoot = WORKSPACE_ROOT, fsOps = fs } = {}) {
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

if (require.main === module) main();

module.exports = {
  ARTIFACT_MAX_BYTES, BASE58_ALPHABET, ELF_HEADER_MIN_LENGTH, EM_BPF, MAINNET_GENESIS,
  METHOD_SEQUENCE, OUTPUT_RELATIVE_PATH, PROGRAMDATA_PAYLOAD_OFFSET, PROGRAM_METADATA_LENGTH,
  PUBLICATION_THRESHOLD_UNIX, PUBLICATION_THRESHOLD_UTC, SAFETY_EXPECTED, SCHEMA,
  SOURCE_COMMIT, SOURCE_TAG, SOURCE_TREE, TARGET_PROGRAM, UPGRADEABLE_LOADER,
  ValidationError, canonicalUtc, decodeBase58, encodeBase58, sha256, validateArtifact,
  validateFixedArtifact, validateSerializedArtifact,
};
