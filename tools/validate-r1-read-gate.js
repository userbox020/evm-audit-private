#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'r1-evm-read-gate-v1';
const MAX_BYTES = 2 * 1024 * 1024;
const LIMITS = Object.freeze({ candidates: 12, requests: 256, requestsPerCandidate: 96, responseBytes: 16 * 1024 * 1024,
  responseBytesPerRequest: 2 * 1024 * 1024, concurrency: 4, perFamilyConcurrency: 1, requestMs: 10_000,
  wallMs: 120_000, logEntries: 256, artifactBytes: 2 * 1024 * 1024, retries: 0 });
const EXPECTED_PROFILE_HASH = 'b82dff5bc4c80f888f5d7d8c3cf6cc1d19ab4de73f491463d278c044339e82f1';
const EXPIRY = 1787788800;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const call = (id, address, data, result) => ({ id, kind: 'call', address, data, result });
// Independent complete copy of the sole Phase-1 public profile. Arbitrum/Ostium
// is deliberately absent and therefore cannot validate as evidence.
const EXPECTED_PROFILE = Object.freeze({ id: 'ethereum-morpho-apyusd-pt-boundary', version: 1, chainId: 1,
  probeAddress: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', pin: { mode: 'finalized', maxAgeSeconds: 3600, futureSkewSeconds: 60 },
  boundary: { expiryTimestamp: EXPIRY,
    operations: ['morpho-market-apyusd-discounted', 'morpho-oracle-price-discounted', 'morpho-oracle-price-par', 'pt-expiry', 'pt-is-expired'],
    transitions: { 'pt-is-expired': { pre: false, post: true } } },
  operations: [
    { id: 'morpho-runtime', kind: 'code', address: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', result: { type: 'nonemptyCode' } },
    call('morpho-market-apyusd-discounted', '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', `0x50d8db4e${'62878115c6ee109c256237eb6daef589d006258202682d2e210cad3bb19e0f09'}`, { type: 'tupleWords', words: 6 }),
    call('morpho-oracle-price-discounted', '0x2c0a8c81d61529bc08e0a4f780d098c8595c9158', '0xa035b1fe', { type: 'positiveUint256' }),
    call('morpho-oracle-price-par', '0x60c98189f7c21540d4a3b8aeade5d5d0aac82aa0', '0xa035b1fe', { type: 'positiveUint256' }),
    call('pt-expiry', '0xee5c7cda577484b70b65c21235ecbd302bb290e2', '0xe184c9be', { type: 'uint256Exact', value: EXPIRY }),
    call('pt-is-expired', '0xee5c7cda577484b70b65c21235ecbd302bb290e2', '0x2f13b60c', { type: 'bool' }),
    call('apyusd-asset', '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a', '0x38d52e0f', { type: 'expectedAddress', value: '0x98a878b1cd98131b271883b390f68d2c90674665' }),
    call('receipt-paused', '0x9bf51f33955ec70f87c4b5c49441815589043237', '0x5c975abb', { type: 'bool' }),
    call('curve-get-dy-int128', '0xe41be7b340f7c2eda4da1e99b42ee1b228b526b7', `0x5e0d443f${word(1)}${word(0)}${word(10n ** 18n)}`, { type: 'positiveUint256' }),
    { id: 'apyusd-runtime', kind: 'code', address: '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a', result: { type: 'nonemptyCode' } },
    { id: 'receipt-runtime', kind: 'code', address: '0x9bf51f33955ec70f87c4b5c49441815589043237', result: { type: 'nonemptyCode' } },
  ], runtimeEquality: { mode: 'cross-family-exact', operations: ['morpho-runtime', 'apyusd-runtime', 'receipt-runtime'] } });
const TOP_KEYS = ['schema', 'profile', 'profileHash', 'chainId', 'generatedAt', 'status', 'pin', 'qualification', 'observations', 'boundary', 'readiness', 'budgets', 'safety', 'integrity'];

class ValidationError extends Error { constructor(code) { super(code); this.name = 'ValidationError'; this.code = code; } }
function check(value, code) { if (!value) throw new ValidationError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, code) { check(object(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys), code); }
function uint(value, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function hex(value, bytes = null) { return typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/u.test(value) && (bytes === null || value.length === 2 + bytes * 2); }
function canonical(value) { if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; check(object(value), 'SERIALIZATION'); return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function validateHeader(header, code = 'HEADER') { exact(header, ['number', 'hash', 'parentHash', 'stateRoot', 'timestamp'], `${code}_SCHEMA`); check(uint(header.number) && header.number > 0 && hex(header.hash, 32) && hex(header.parentHash, 32) && hex(header.stateRoot, 32) && uint(header.timestamp), `${code}_VALUE`); }
function validateResult(schema, value) {
  check(hex(value), 'RESULT_HEX');
  if (schema.type === 'nonemptyCode') return check(value !== '0x', 'RESULT_CODE');
  if (schema.type === 'storageWord') return check(hex(value, 32), 'RESULT_STORAGE');
  if (schema.type === 'tupleWords') return check(value.length === 2 + schema.words * 64, 'RESULT_TUPLE');
  check(hex(value, 32), 'RESULT_WORD'); const number = BigInt(value);
  if (schema.type === 'positiveUint256') check(number > 0n, 'RESULT_POSITIVE');
  else if (schema.type === 'uint256Exact') check(number === BigInt(schema.value), 'RESULT_EXACT');
  else if (schema.type === 'bool') check(number === 0n || number === 1n, 'RESULT_BOOL');
  else if (schema.type === 'expectedAddress') check(/^0x0{24}[0-9a-f]{40}$/u.test(value) && `0x${value.slice(-40)}` === schema.value, 'RESULT_ADDRESS');
  else throw new ValidationError('RESULT_SCHEMA');
}
function validateObservations(rows, operations, code) {
  check(Array.isArray(rows) && rows.length === operations.length, `${code}_COUNT`);
  for (let i = 0; i < operations.length; i++) { const row = rows[i], operation = operations[i]; exact(row, ['id', 'kind', 'value'], `${code}_SCHEMA`); check(row.id === operation.id && row.kind === operation.kind, `${code}_IDENTITY`); validateResult(operation.result, row.value); }
}
function noUnsafeMaterial(text, value) {
  check(!/(?:https?|wss):\/\//iu.test(text), 'UNSAFE_URL'); check(!/\b(?:authorization|bearer|api[_-]?key|credential|private[_-]?key)\b/iu.test(text), 'UNSAFE_SECRET'); check(!/(?:^|["\s])(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:["\s]|$)/iu.test(text), 'UNSAFE_DOMAIN');
  const forbidden = /(?:endpoint|provider|hostname|domain|inventory|familyname|familyhash|rawresponse|headers?)/iu, permitted = new Set(['endpointMaterialPersisted', 'endpointMaterialHashed']);
  (function walk(node) { if (Array.isArray(node)) return node.forEach(walk); if (!object(node)) return; for (const [key, item] of Object.entries(node)) { check(permitted.has(key) || !forbidden.test(key), 'UNSAFE_KEY'); walk(item); } }(value));
}

function validateArtifact(value, { now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  check(digest(canonical(EXPECTED_PROFILE)) === EXPECTED_PROFILE_HASH, 'VALIDATOR_PROFILE_CONSTANT');
  exact(value, TOP_KEYS, 'TOP_SCHEMA'); check(value.schema === SCHEMA && value.profile === EXPECTED_PROFILE.id && value.profileHash === EXPECTED_PROFILE_HASH && value.chainId === 1, 'PROFILE');
  noUnsafeMaterial(JSON.stringify(value), value);
  const generated = Date.parse(value.generatedAt); check(Number.isFinite(generated) && new Date(generated).toISOString() === value.generatedAt && generated <= now + 60_000 && generated >= now - maxAgeMs, 'GENERATED_AT'); check(value.status === 'PASS', 'STATUS');
  validateHeader(value.pin, 'PIN'); const nowSeconds = Math.floor(now / 1000); check(value.pin.timestamp >= nowSeconds - EXPECTED_PROFILE.pin.maxAgeSeconds && value.pin.timestamp <= nowSeconds + EXPECTED_PROFILE.pin.futureSkewSeconds, 'PIN_FRESHNESS');
  exact(value.qualification, ['candidatesEvaluated', 'qualifiedCandidates', 'distinctHeuristicFamilies', 'selectionRule', 'selectedCount', 'commonFinalizedAgreement', 'terminalRecheck'], 'QUALIFICATION_SCHEMA');
  check(uint(value.qualification.candidatesEvaluated, 12) && value.qualification.candidatesEvaluated >= 2 && uint(value.qualification.qualifiedCandidates, value.qualification.candidatesEvaluated) && value.qualification.qualifiedCandidates >= 2 && uint(value.qualification.distinctHeuristicFamilies, value.qualification.qualifiedCandidates) && value.qualification.distinctHeuristicFamilies >= 2 && value.qualification.selectionRule === 'CAPABILITY_PREMIUM_INVENTORY_ORDER' && value.qualification.selectedCount === 2 && value.qualification.commonFinalizedAgreement === true && value.qualification.terminalRecheck === true, 'QUALIFICATION_VALUE');
  validateObservations(value.observations, EXPECTED_PROFILE.operations, 'OBSERVATION'); check(value.readiness === null, 'READINESS');
  exact(value.boundary, ['expiryTimestamp', 'readiness', 'preBlock', 'postBlock', 'preObservations', 'postObservations'], 'BOUNDARY_SCHEMA'); check(value.boundary.expiryTimestamp === EXPIRY, 'BOUNDARY_EXPIRY');
  const boundaryOps = EXPECTED_PROFILE.boundary.operations.map((id) => EXPECTED_PROFILE.operations.find((operation) => operation.id === id));
  if (value.boundary.readiness === 'NOT_YET_OBSERVABLE') check(value.pin.timestamp < EXPIRY && value.boundary.preBlock === null && value.boundary.postBlock === null && value.boundary.preObservations === null && value.boundary.postObservations === null, 'BOUNDARY_PREMATURE');
  else { check(value.boundary.readiness === 'OBSERVABLE', 'BOUNDARY_STATUS'); validateHeader(value.boundary.preBlock, 'BOUNDARY_PRE'); validateHeader(value.boundary.postBlock, 'BOUNDARY_POST'); check(value.boundary.postBlock.number === value.boundary.preBlock.number + 1 && value.boundary.postBlock.parentHash === value.boundary.preBlock.hash && value.boundary.preBlock.timestamp < EXPIRY && value.boundary.postBlock.timestamp >= EXPIRY && value.boundary.postBlock.number <= value.pin.number, 'BOUNDARY_LINKAGE'); validateObservations(value.boundary.preObservations, boundaryOps, 'BOUNDARY_PRE_OBSERVATION'); validateObservations(value.boundary.postObservations, boundaryOps, 'BOUNDARY_POST_OBSERVATION'); const preExpired = value.boundary.preObservations.find((row) => row.id === 'pt-is-expired').value, postExpired = value.boundary.postObservations.find((row) => row.id === 'pt-is-expired').value; check(BigInt(preExpired) === 0n && BigInt(postExpired) === 1n, 'BOUNDARY_TRANSITION'); }
  exact(value.budgets, ['limits', 'used'], 'BUDGET_SCHEMA'); check(JSON.stringify(Object.keys(value.budgets.limits)) === JSON.stringify(Object.keys(LIMITS)), 'LIMIT_SCHEMA');
  for (const [key, hard] of Object.entries(LIMITS)) check(uint(value.budgets.limits[key], hard) && (key === 'retries' || value.budgets.limits[key] >= 1), 'LIMIT_VALUE'); check(value.budgets.limits.retries === 0 && value.budgets.limits.perFamilyConcurrency === 1 && value.budgets.limits.responseBytesPerRequest <= value.budgets.limits.responseBytes, 'LIMIT_POLICY');
  exact(value.budgets.used, ['requests', 'responseBytes', 'maxConcurrency', 'maxPerFamilyConcurrency', 'elapsedMs', 'retries'], 'USED_SCHEMA'); const used = value.budgets.used, limits = value.budgets.limits; check(uint(used.requests, limits.requests) && used.requests > 0 && uint(used.responseBytes, limits.responseBytes) && uint(used.maxConcurrency, limits.concurrency) && used.maxConcurrency >= 1 && used.maxPerFamilyConcurrency === 1 && uint(used.elapsedMs, limits.wallMs) && used.retries === 0, 'USED_VALUE');
  exact(value.safety, ['readOnly', 'eip1898Canonical', 'multicallPinValidated', 'batches', 'traces', 'pendingState', 'stateOverrides', 'retries', 'signing', 'mutation', 'endpointMaterialPersisted', 'endpointMaterialHashed', 'oneShotMarker'], 'SAFETY_SCHEMA'); check(JSON.stringify(value.safety) === JSON.stringify({ readOnly: true, eip1898Canonical: true, multicallPinValidated: true, batches: false, traces: false, pendingState: false, stateOverrides: false, retries: 0, signing: false, mutation: false, endpointMaterialPersisted: false, endpointMaterialHashed: false, oneShotMarker: false }), 'SAFETY_VALUE');
  exact(value.integrity, ['algorithm', 'payloadHash'], 'INTEGRITY_SCHEMA'); check(value.integrity.algorithm === 'sha256' && /^[0-9a-f]{64}$/u.test(value.integrity.payloadHash), 'INTEGRITY_VALUE'); const payload = { ...value }; delete payload.integrity; check(digest(canonical(payload)) === value.integrity.payloadHash, 'INTEGRITY_MISMATCH'); return value;
}
function parseSerialized(serialized, options = {}) { check(typeof serialized === 'string' && Buffer.byteLength(serialized) <= MAX_BYTES && serialized.endsWith('\n'), 'SERIALIZED'); let value; try { value = JSON.parse(serialized); } catch (_) { throw new ValidationError('JSON'); } check(`${JSON.stringify(value, null, 2)}\n` === serialized, 'CANONICAL_JSON'); return validateArtifact(value, options); }
function validateFile(filePath, { fsOps = fs, ...options } = {}) {
  check(typeof filePath === 'string' && path.isAbsolute(filePath), 'PATH'); let pathStat; try { pathStat = fsOps.lstatSync(filePath); } catch (_) { throw new ValidationError('MISSING'); } check(pathStat.isFile() && !pathStat.isSymbolicLink() && pathStat.size <= MAX_BYTES, 'FILE');
  let fd; try { fd = fsOps.openSync(filePath, 'r'); const before = fsOps.fstatSync(fd); check(before.isFile() && before.size === pathStat.size && before.dev === pathStat.dev && before.ino === pathStat.ino, 'FILE_IDENTITY'); const bytes = fsOps.readFileSync(fd); const after = fsOps.fstatSync(fd); check(Buffer.isBuffer(bytes) && bytes.length === before.size && before.size === after.size && before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs, 'FILE_CHANGED'); let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { throw new ValidationError('UTF8'); } return parseSerialized(text, options); } catch (error) { if (error instanceof ValidationError) throw error; throw new ValidationError('FILE_READ'); } finally { if (fd !== undefined) try { fsOps.closeSync(fd); } catch (_) {} }
}

if (require.main === module) { try { if (process.argv.length !== 3) throw new ValidationError('ARGS'); validateFile(path.resolve(process.argv[2])); process.stdout.write('R1_READ_GATE_VALID\n'); } catch (error) { process.stderr.write(`R1_READ_GATE_INVALID_${error instanceof ValidationError ? error.code : 'INTERNAL'}\n`); process.exitCode = 1; } }

module.exports = { SCHEMA, MAX_BYTES, EXPECTED_PROFILE_HASH, EXPECTED_PROFILE, ValidationError, canonical, digest, noUnsafeMaterial, validateArtifact, parseSerialized, validateFile };
