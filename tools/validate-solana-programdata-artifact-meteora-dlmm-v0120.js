#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 'solana-programdata-artifact-meteora-dlmm-v0120-v1';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TARGET_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const SOURCE_COMMIT = '2f540c2107988e0f97efa5917100bb912c96c17a';
const SOURCE_TREE = '3dda23884a725a2a7f6e754197414d6af6bc9daf';
const LOCAL_ARTIFACT_RELATIVE_PATH = 'targets/meteora-dlmm-sdk-2f540c21/artifacts/lb_clmm.so';
const LOCAL_ARTIFACT_LENGTH = 2078488;
const LOCAL_ARTIFACT_SHA256 = '2bbc929a4d7fbe8e8266bae88cd9f4d5da6db42719326c2e24a58244c6a6d77b';
const LOCAL_ARTIFACT_GIT_BLOB_SHA1 = '2876a05235c541661fd2ec85928979969e70c3dd';
const OUTPUT_RELATIVE_PATH = 'reports/raw/fast/solana-meteora-dlmm-v0.12.0-gate0/programdata-artifact-binding-capture.json';
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const OUTPUT_MAX_BYTES = 24 * 1024 * 1024;
const PROGRAM_METADATA_LENGTH = 36;
const PROGRAMDATA_PAYLOAD_OFFSET = 45;
const ELF_HEADER_MIN_LENGTH = 64;
const EM_BPF = 247;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const METHOD_SEQUENCE = Object.freeze([
  'getGenesisHash', 'getSlot', 'getBlockTime', 'getAccountInfo', 'getAccountInfo', 'getBlockTime',
]);
const NON_CLAIMS = Object.freeze([
  'SOURCE_RUNTIME_EQUIVALENCE_NOT_ESTABLISHED',
  'DEPLOYED_V0120_SOURCE_IDENTITY_NOT_ESTABLISHED',
  'PROVIDER_INDEPENDENCE_NOT_ESTABLISHED',
  'VULNERABILITY_OR_EXPLOITABILITY_NOT_ESTABLISHED',
]);
const TOP_KEYS = Object.freeze([
  'schema', 'status', 'chain', 'genesis', 'source', 'localArtifact', 'finalized', 'program',
  'programData', 'binding', 'calls', 'safety', 'nonClaims',
]);
const GENESIS_KEYS = Object.freeze(['expected', 'verified']);
const SOURCE_KEYS = Object.freeze(['commit', 'tree']);
const LOCAL_KEYS = Object.freeze(['path', 'length', 'sha256', 'gitBlobSha1']);
const FINALIZED_KEYS = Object.freeze(['slot', 'blockTime', 'blockTimeUtc']);
const PROGRAM_KEYS = Object.freeze([
  'address', 'owner', 'executable', 'contextSlot', 'accountBytesBase64', 'accountBytesLength',
  'accountBytesSha256', 'stateTag', 'derivedProgramDataAddress',
]);
const PROGRAMDATA_KEYS = Object.freeze([
  'address', 'owner', 'executable', 'contextSlot', 'accountBytesBase64', 'accountBytesLength',
  'accountBytesSha256', 'stateTag', 'lastModifiedSlot', 'lastModifiedBlockTime',
  'lastModifiedBlockTimeUtc', 'authorityOption', 'authority', 'payloadOffset', 'elf',
]);
const ELF_KEYS = Object.freeze(['magicHex', 'class', 'data', 'identVersion', 'machine', 'version']);
const BINDING_KEYS = Object.freeze([
  'allocatedPayloadLength', 'allocatedPayloadSha256', 'artifactPrefixLength', 'artifactPrefixSha256',
  'artifactPrefixGitBlobSha1', 'paddingLength', 'paddingAllZero',
]);
const CALL_KEYS = Object.freeze(['methods', 'successful', 'retries', 'fallbacks']);
const SAFETY_EXPECTED = Object.freeze({
  singleEndpointFamilyObservation: true,
  endpointIdentityPersisted: false,
  providerIdentityPersisted: false,
  rawErrorsPersisted: false,
  externalInventoryRead: false,
  exactLocalArtifactOnly: true,
  accountBytesRetained: true,
  keysAccessed: false,
  commandsExecuted: false,
  dependencyAcquisition: false,
  build: false,
  binaryExecution: false,
  disassembly: false,
  signing: false,
  transactions: false,
  productionMutation: false,
  fundsMoved: false,
});
const SAFETY_KEYS = Object.freeze(Object.keys(SAFETY_EXPECTED));
const CODES = new Set([
  'ARGS_FORBIDDEN', 'EXEC_ARGV_FORBIDDEN', 'ARTIFACT_MISSING', 'ARTIFACT_NOT_REGULAR',
  'ARTIFACT_TOO_LARGE', 'ARTIFACT_ENCODING', 'ARTIFACT_JSON', 'ARTIFACT_STRUCTURE',
  'ARTIFACT_SCHEMA', 'ARTIFACT_GENESIS', 'ARTIFACT_SOURCE', 'LOCAL_ARTIFACT_NOT_REGULAR',
  'LOCAL_ARTIFACT_SYMLINK', 'LOCAL_ARTIFACT_LENGTH', 'LOCAL_ARTIFACT_SHA256',
  'LOCAL_ARTIFACT_GIT_BLOB', 'LOCAL_ARTIFACT_READ', 'ARTIFACT_FINALIZED', 'ARTIFACT_PROGRAM',
  'ARTIFACT_PROGRAMDATA', 'ARTIFACT_ELF', 'ARTIFACT_BINDING', 'ARTIFACT_CALLS',
  'ARTIFACT_SAFETY', 'ARTIFACT_NONCLAIMS', 'ARTIFACT_FORBIDDEN', 'INTERNAL',
]);
class ValidationError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'INTERNAL';
    super(safe); this.name = 'ValidationError'; this.code = safe;
  }
}
function invalid(code) { throw new ValidationError(code); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function gitBlobSha1(bytes) {
  return crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`, 'utf8')).update(bytes).digest('hex');
}
function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}
function exactKeys(value, expected, code) {
  if (!isPlainObject(value)) invalid(code);
  const keys = Object.keys(value);
  if (keys.length !== expected.length) invalid(code);
  for (let index = 0; index < expected.length; index += 1) if (keys[index] !== expected[index]) invalid(code);
}
function safeInteger(value, code) { if (!Number.isSafeInteger(value) || value < 0) invalid(code); return value; }
function canonicalUtc(seconds, code) {
  safeInteger(seconds, code);
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) invalid(code);
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) invalid(code);
  return date.toISOString().replace('.000Z', 'Z');
}
function encodeBase58(bytes) {
  const input = Buffer.from(bytes); let value = 0n;
  for (const byte of input) value = (value << 8n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) { encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded; value /= 58n; }
  let leading = 0; while (leading < input.length && input[leading] === 0) leading += 1;
  return '1'.repeat(leading) + encoded;
}
function decodeBase58(value, code) {
  if (typeof value !== 'string' || value.length === 0) invalid(code);
  let number = 0n;
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character); if (index < 0) invalid(code);
    number = number * 58n + BigInt(index);
  }
  const bytes = []; while (number > 0n) { bytes.push(Number(number & 0xffn)); number >>= 8n; }
  bytes.reverse(); let leading = 0; while (leading < value.length && value[leading] === '1') leading += 1;
  const decoded = Buffer.concat([Buffer.alloc(leading), Buffer.from(bytes)]);
  if (encodeBase58(decoded) !== value) invalid(code);
  return decoded;
}
function decodeCanonicalBase64(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid(code);
  const bytes = Buffer.from(value, 'base64'); if (bytes.toString('base64') !== value) invalid(code); return bytes;
}
function scanLeaks(value, keyName = '') {
  if (Array.isArray(value)) { for (const item of value) scanLeaks(item, keyName); return; }
  if (isPlainObject(value)) { for (const [key, item] of Object.entries(value)) scanLeaks(item, key); return; }
  if (typeof value === 'string' && keyName !== 'accountBytesBase64') {
    if (/https?:\/\//i.test(value) || /(api\.mainnet|\.solana\.com|retry-after|raw.?error|hostname)/i.test(value)) invalid('ARTIFACT_FORBIDDEN');
  }
}
function preflightLocalArtifact({ workspaceRoot = WORKSPACE_ROOT, fsOps = fs } = {}) {
  const root = path.resolve(workspaceRoot);
  const artifactPath = path.resolve(root, LOCAL_ARTIFACT_RELATIVE_PATH);
  const relative = path.relative(root, artifactPath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) invalid('LOCAL_ARTIFACT_NOT_REGULAR');
  let rootReal; let parentReal; let stat; let descriptor;
  try {
    rootReal = fsOps.realpathSync(root);
    const parent = path.dirname(artifactPath);
    const parentStat = fsOps.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) invalid('LOCAL_ARTIFACT_SYMLINK');
    parentReal = fsOps.realpathSync(parent);
    const parentRelative = path.relative(rootReal, parentReal);
    if (parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) invalid('LOCAL_ARTIFACT_NOT_REGULAR');
    stat = fsOps.lstatSync(artifactPath);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    invalid('LOCAL_ARTIFACT_NOT_REGULAR');
  }
  if (stat.isSymbolicLink()) invalid('LOCAL_ARTIFACT_SYMLINK');
  if (!stat.isFile()) invalid('LOCAL_ARTIFACT_NOT_REGULAR');
  if (stat.size !== LOCAL_ARTIFACT_LENGTH) invalid('LOCAL_ARTIFACT_LENGTH');
  try {
    descriptor = fsOps.openSync(artifactPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fsOps.fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== stat.size || (stat.ino && opened.ino !== stat.ino)) invalid('LOCAL_ARTIFACT_NOT_REGULAR');
    const bytes = fsOps.readFileSync(descriptor);
    const after = fsOps.fstatSync(descriptor);
    if (after.size !== opened.size || (opened.ino && after.ino !== opened.ino)) invalid('LOCAL_ARTIFACT_READ');
    fsOps.closeSync(descriptor); descriptor = undefined;
    if (bytes.length !== LOCAL_ARTIFACT_LENGTH) invalid('LOCAL_ARTIFACT_LENGTH');
    if (sha256(bytes) !== LOCAL_ARTIFACT_SHA256) invalid('LOCAL_ARTIFACT_SHA256');
    if (gitBlobSha1(bytes) !== LOCAL_ARTIFACT_GIT_BLOB_SHA1) invalid('LOCAL_ARTIFACT_GIT_BLOB');
    return bytes;
  } catch (error) {
    if (descriptor !== undefined) { try { fsOps.closeSync(descriptor); } catch (_) { /* fixed cleanup */ } }
    if (error instanceof ValidationError) throw error;
    invalid('LOCAL_ARTIFACT_READ');
  }
}
function validateElf(payload, elf) {
  exactKeys(elf, ELF_KEYS, 'ARTIFACT_ELF');
  if (payload.length < ELF_HEADER_MIN_LENGTH || payload[0] !== 0x7f || payload[1] !== 0x45
    || payload[2] !== 0x4c || payload[3] !== 0x46 || payload[4] !== 2 || payload[5] !== 1
    || payload[6] !== 1 || payload.readUInt16LE(18) !== EM_BPF || payload.readUInt32LE(20) !== 1) invalid('ARTIFACT_ELF');
  if (elf.magicHex !== '7f454c46' || elf.class !== 2 || elf.data !== 1 || elf.identVersion !== 1
    || elf.machine !== EM_BPF || elf.version !== 1) invalid('ARTIFACT_ELF');
}
function validateArtifact(artifact, options = {}) {
  const localArtifactBytes = preflightLocalArtifact(options);
  scanLeaks(artifact);
  exactKeys(artifact, TOP_KEYS, 'ARTIFACT_STRUCTURE');
  if (artifact.schema !== SCHEMA || artifact.status !== 'PASS_ARTIFACT_PREFIX_ZERO_PADDING_BOUND'
    || artifact.chain !== 'solana-mainnet') invalid('ARTIFACT_SCHEMA');
  exactKeys(artifact.genesis, GENESIS_KEYS, 'ARTIFACT_GENESIS');
  if (artifact.genesis.expected !== MAINNET_GENESIS || artifact.genesis.verified !== MAINNET_GENESIS) invalid('ARTIFACT_GENESIS');
  exactKeys(artifact.source, SOURCE_KEYS, 'ARTIFACT_SOURCE');
  if (artifact.source.commit !== SOURCE_COMMIT || artifact.source.tree !== SOURCE_TREE) invalid('ARTIFACT_SOURCE');
  exactKeys(artifact.localArtifact, LOCAL_KEYS, 'ARTIFACT_SOURCE');
  if (artifact.localArtifact.path !== LOCAL_ARTIFACT_RELATIVE_PATH || artifact.localArtifact.length !== LOCAL_ARTIFACT_LENGTH
    || artifact.localArtifact.sha256 !== LOCAL_ARTIFACT_SHA256 || artifact.localArtifact.gitBlobSha1 !== LOCAL_ARTIFACT_GIT_BLOB_SHA1) invalid('ARTIFACT_SOURCE');
  exactKeys(artifact.finalized, FINALIZED_KEYS, 'ARTIFACT_FINALIZED');
  safeInteger(artifact.finalized.slot, 'ARTIFACT_FINALIZED'); safeInteger(artifact.finalized.blockTime, 'ARTIFACT_FINALIZED');
  if (artifact.finalized.blockTimeUtc !== canonicalUtc(artifact.finalized.blockTime, 'ARTIFACT_FINALIZED')) invalid('ARTIFACT_FINALIZED');
  exactKeys(artifact.program, PROGRAM_KEYS, 'ARTIFACT_PROGRAM');
  if (artifact.program.address !== TARGET_PROGRAM || artifact.program.owner !== UPGRADEABLE_LOADER
    || artifact.program.executable !== true || artifact.program.stateTag !== 2) invalid('ARTIFACT_PROGRAM');
  safeInteger(artifact.program.contextSlot, 'ARTIFACT_PROGRAM');
  if (artifact.program.contextSlot < artifact.finalized.slot) invalid('ARTIFACT_PROGRAM');
  const programBytes = decodeCanonicalBase64(artifact.program.accountBytesBase64, 'ARTIFACT_PROGRAM');
  if (programBytes.length !== PROGRAM_METADATA_LENGTH || artifact.program.accountBytesLength !== programBytes.length
    || artifact.program.accountBytesSha256 !== sha256(programBytes) || programBytes.readUInt32LE(0) !== 2) invalid('ARTIFACT_PROGRAM');
  const linkedBytes = programBytes.subarray(4, 36); const linkedAddress = encodeBase58(linkedBytes);
  if (linkedBytes.length !== 32 || decodeBase58(linkedAddress, 'ARTIFACT_PROGRAM').length !== 32
    || artifact.program.derivedProgramDataAddress !== linkedAddress) invalid('ARTIFACT_PROGRAM');
  exactKeys(artifact.programData, PROGRAMDATA_KEYS, 'ARTIFACT_PROGRAMDATA');
  if (artifact.programData.address !== linkedAddress || artifact.programData.owner !== UPGRADEABLE_LOADER
    || artifact.programData.executable !== false || artifact.programData.stateTag !== 3) invalid('ARTIFACT_PROGRAMDATA');
  safeInteger(artifact.programData.contextSlot, 'ARTIFACT_PROGRAMDATA');
  if (artifact.programData.contextSlot < artifact.finalized.slot) invalid('ARTIFACT_PROGRAMDATA');
  const programDataBytes = decodeCanonicalBase64(artifact.programData.accountBytesBase64, 'ARTIFACT_PROGRAMDATA');
  if (programDataBytes.length < PROGRAMDATA_PAYLOAD_OFFSET + ELF_HEADER_MIN_LENGTH
    || artifact.programData.accountBytesLength !== programDataBytes.length
    || artifact.programData.accountBytesSha256 !== sha256(programDataBytes) || programDataBytes.readUInt32LE(0) !== 3) invalid('ARTIFACT_PROGRAMDATA');
  const stateSlotBig = programDataBytes.readBigUInt64LE(4);
  if (stateSlotBig > BigInt(Number.MAX_SAFE_INTEGER)) invalid('ARTIFACT_PROGRAMDATA');
  const stateSlot = Number(stateSlotBig);
  if (artifact.programData.lastModifiedSlot !== stateSlot || stateSlot > artifact.programData.contextSlot) invalid('ARTIFACT_PROGRAMDATA');
  const authorityOption = programDataBytes[12];
  if ((authorityOption !== 0 && authorityOption !== 1) || artifact.programData.authorityOption !== authorityOption) invalid('ARTIFACT_PROGRAMDATA');
  let authority = null;
  if (authorityOption === 0) {
    for (let index = 13; index < 45; index += 1) if (programDataBytes[index] !== 0) invalid('ARTIFACT_PROGRAMDATA');
  } else {
    authority = encodeBase58(programDataBytes.subarray(13, 45));
    if (decodeBase58(authority, 'ARTIFACT_PROGRAMDATA').length !== 32) invalid('ARTIFACT_PROGRAMDATA');
  }
  if (artifact.programData.authority !== authority || artifact.programData.payloadOffset !== PROGRAMDATA_PAYLOAD_OFFSET) invalid('ARTIFACT_PROGRAMDATA');
  safeInteger(artifact.programData.lastModifiedBlockTime, 'ARTIFACT_PROGRAMDATA');
  if (artifact.programData.lastModifiedBlockTimeUtc !== canonicalUtc(artifact.programData.lastModifiedBlockTime, 'ARTIFACT_PROGRAMDATA')) invalid('ARTIFACT_PROGRAMDATA');
  const payload = programDataBytes.subarray(PROGRAMDATA_PAYLOAD_OFFSET); validateElf(payload, artifact.programData.elf);
  exactKeys(artifact.binding, BINDING_KEYS, 'ARTIFACT_BINDING');
  if (payload.length < LOCAL_ARTIFACT_LENGTH || artifact.binding.allocatedPayloadLength !== payload.length
    || artifact.binding.allocatedPayloadSha256 !== sha256(payload)) invalid('ARTIFACT_BINDING');
  const prefix = payload.subarray(0, LOCAL_ARTIFACT_LENGTH); const padding = payload.subarray(LOCAL_ARTIFACT_LENGTH);
  if (!prefix.equals(localArtifactBytes) || artifact.binding.artifactPrefixLength !== LOCAL_ARTIFACT_LENGTH
    || artifact.binding.artifactPrefixSha256 !== sha256(prefix) || artifact.binding.artifactPrefixSha256 !== LOCAL_ARTIFACT_SHA256
    || artifact.binding.artifactPrefixGitBlobSha1 !== gitBlobSha1(prefix)
    || artifact.binding.artifactPrefixGitBlobSha1 !== LOCAL_ARTIFACT_GIT_BLOB_SHA1
    || artifact.binding.paddingLength !== padding.length || artifact.binding.paddingAllZero !== true) invalid('ARTIFACT_BINDING');
  for (const byte of padding) if (byte !== 0) invalid('ARTIFACT_BINDING');
  exactKeys(artifact.calls, CALL_KEYS, 'ARTIFACT_CALLS');
  if (!Array.isArray(artifact.calls.methods) || artifact.calls.methods.length !== METHOD_SEQUENCE.length) invalid('ARTIFACT_CALLS');
  for (let index = 0; index < METHOD_SEQUENCE.length; index += 1) if (artifact.calls.methods[index] !== METHOD_SEQUENCE[index]) invalid('ARTIFACT_CALLS');
  if (artifact.calls.successful !== 6 || artifact.calls.retries !== 0 || artifact.calls.fallbacks !== 0) invalid('ARTIFACT_CALLS');
  exactKeys(artifact.safety, SAFETY_KEYS, 'ARTIFACT_SAFETY');
  for (const key of SAFETY_KEYS) if (artifact.safety[key] !== SAFETY_EXPECTED[key]) invalid('ARTIFACT_SAFETY');
  if (!Array.isArray(artifact.nonClaims) || artifact.nonClaims.length !== NON_CLAIMS.length) invalid('ARTIFACT_NONCLAIMS');
  for (let index = 0; index < NON_CLAIMS.length; index += 1) if (artifact.nonClaims[index] !== NON_CLAIMS[index]) invalid('ARTIFACT_NONCLAIMS');
  return true;
}
function validateSerializedArtifact(text, options = {}) {
  if (typeof text !== 'string') invalid('ARTIFACT_ENCODING');
  if (Buffer.byteLength(text, 'utf8') > OUTPUT_MAX_BYTES) invalid('ARTIFACT_TOO_LARGE');
  if (text.charCodeAt(0) === 0xfeff || text.includes('\u0000')) invalid('ARTIFACT_ENCODING');
  let artifact; try { artifact = JSON.parse(text); } catch (_) { invalid('ARTIFACT_JSON'); }
  validateArtifact(artifact, options);
  if (text !== `${JSON.stringify(artifact, null, 2)}\n`) invalid('ARTIFACT_ENCODING');
  return artifact;
}
function validateFixedArtifact({ workspaceRoot = WORKSPACE_ROOT, fsOps = fs } = {}) {
  const artifactPath = path.resolve(workspaceRoot, OUTPUT_RELATIVE_PATH);
  let stat; try { stat = fsOps.lstatSync(artifactPath); }
  catch (error) { if (error && error.code === 'ENOENT') invalid('ARTIFACT_MISSING'); invalid('ARTIFACT_NOT_REGULAR'); }
  if (!stat.isFile() || stat.isSymbolicLink()) invalid('ARTIFACT_NOT_REGULAR');
  if (!Number.isSafeInteger(stat.size) || stat.size > OUTPUT_MAX_BYTES) invalid('ARTIFACT_TOO_LARGE');
  let bytes; try { bytes = fsOps.readFileSync(artifactPath); } catch (_) { invalid('ARTIFACT_NOT_REGULAR'); }
  const text = bytes.toString('utf8'); if (!Buffer.from(text, 'utf8').equals(bytes)) invalid('ARTIFACT_ENCODING');
  return validateSerializedArtifact(text, { workspaceRoot, fsOps });
}
function main() {
  try {
    if (process.argv.slice(2).length !== 0) invalid('ARGS_FORBIDDEN');
    if (process.execArgv.length !== 0) invalid('EXEC_ARGV_FORBIDDEN');
    validateFixedArtifact();
    process.stdout.write(`VALIDATION_OK ${OUTPUT_RELATIVE_PATH}\n`);
  } catch (error) {
    const code = error instanceof ValidationError ? error.code : 'INTERNAL';
    process.stderr.write(`VALIDATION_FAILED_${code}\n`); process.exitCode = 1;
  }
}
if (require.main === module) main();

module.exports = {
  BASE58_ALPHABET, ELF_HEADER_MIN_LENGTH, EM_BPF, LOCAL_ARTIFACT_GIT_BLOB_SHA1,
  LOCAL_ARTIFACT_LENGTH, LOCAL_ARTIFACT_RELATIVE_PATH, LOCAL_ARTIFACT_SHA256, MAINNET_GENESIS,
  METHOD_SEQUENCE, NON_CLAIMS, OUTPUT_MAX_BYTES, OUTPUT_RELATIVE_PATH, PROGRAMDATA_PAYLOAD_OFFSET,
  PROGRAM_METADATA_LENGTH, SAFETY_EXPECTED, SCHEMA, SOURCE_COMMIT, SOURCE_TREE, TARGET_PROGRAM,
  UPGRADEABLE_LOADER, ValidationError, canonicalUtc, decodeBase58, encodeBase58, gitBlobSha1,
  preflightLocalArtifact, sha256, validateArtifact, validateFixedArtifact, validateSerializedArtifact,
};
