#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { PROFILE, PROFILE_HASH, canonical } = require('../ostium-arbitrum-read-gate-r1-profile.js');

const SCHEMA = 'ostium-arbitrum-read-gate-r1-artifact/v1';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const GET_BLOCK_NUMBER = '0x42cbb15c';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const LIMITS = Object.freeze({ candidates: 8, requests: 256, requestsPerCandidate: 64, responseBytes: 32 * 1024 * 1024,
  responseBytesPerRequest: 2 * 1024 * 1024, requestMs: 10_000, wallMs: 120_000, concurrency: 4,
  perOperatorConcurrency: 1, artifactBytes: 256 * 1024, retries: 0 });
const ALLOWED_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call']);
const FORBIDDEN = /(?:trace|batch|pending|send|sign|personal|wallet|admin|miner|mining|debug|txpool|anvil|hardhat|state.?override)/iu;
const MASK64 = (1n << 64n) - 1n;
const KECCAK_ROUNDS = Object.freeze([
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]);
const KECCAK_ROTATION = Object.freeze([0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]);

class GateError extends Error { constructor(code) { super(code); this.name = 'GateError'; this.code = code; } }
function fail(code) { throw new GateError(code); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hex(value, bytes = null) { return typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/u.test(value) && (bytes === null || value.length === 2 + bytes * 2); }
function address(value) { return hex(value, 20); }
function hex32(value) { return hex(value, 32); }
function quantity(value) { return typeof value === 'string' && /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/u.test(value); }
function quantityHex(value) { return `0x${BigInt(value).toString(16)}`; }
function asSafeUint(value, code) { if (!quantity(value)) fail(code); const number = Number(BigInt(value)); if (!Number.isSafeInteger(number) || number < 0) fail(code); return number; }
function rotate64(value, shift) { if (shift === 0) return value & MASK64; const bits = BigInt(shift); return ((value << bits) | (value >> (64n - bits))) & MASK64; }
function keccakPermutation(state) {
  for (const round of KECCAK_ROUNDS) {
    const c = Array(5), d = Array(5), b = Array(25);
    for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotate64(c[(x + 1) % 5], 1);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK64;
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotate64(state[x + 5 * y], KECCAK_ROTATION[x + 5 * y]);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) state[x + 5 * y] = (b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y])) & MASK64;
    state[0] ^= round;
  }
}
function keccak256(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes); const rate = 136, paddedLength = Math.ceil((bytes.length + 1) / rate) * rate;
  const padded = Buffer.alloc(paddedLength); bytes.copy(padded); padded[bytes.length] = 0x01; padded[padded.length - 1] |= 0x80;
  const state = Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane++) { let value = 0n; for (let byte = 0; byte < 8; byte++) value |= BigInt(padded[offset + lane * 8 + byte]) << BigInt(byte * 8); state[lane] ^= value; }
    keccakPermutation(state);
  }
  const output = Buffer.alloc(32); for (let lane = 0; lane < 4; lane++) for (let byte = 0; byte < 8; byte++) output[lane * 8 + byte] = Number((state[lane] >> BigInt(byte * 8)) & 0xffn);
  return `0x${output.toString('hex')}`;
}
function sha256Public(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function parseHeader(value, expectedNumber = null) {
  if (!object(value) || !quantity(value.number) || !hex32(value.hash) || !hex32(value.parentHash) || !hex32(value.stateRoot) || !quantity(value.timestamp)) fail('HEADER_INVALID');
  const result = { number: asSafeUint(value.number, 'HEADER_NUMBER_INVALID'), hash: value.hash, parentHash: value.parentHash,
    stateRoot: value.stateRoot, timestamp: asSafeUint(value.timestamp, 'HEADER_TIMESTAMP_INVALID') };
  if (expectedNumber !== null && result.number !== expectedNumber) fail('HEADER_NUMBER_MISMATCH'); return result;
}
function eip1898(hashValue) { if (!hex32(hashValue)) fail('PIN_INVALID'); return { blockHash: hashValue, requireCanonical: true }; }
function addressWord(value) { if (!address(value)) fail('AUTHORITY_ADDRESS_INVALID'); return `0x${'0'.repeat(24)}${value.slice(2)}`; }
function decodeAddressWord(value, code = 'ABI_ADDRESS_INVALID') { if (!hex(value, 32) || !/^0x0{24}[0-9a-f]{40}$/u.test(value)) fail(code); return `0x${value.slice(-40)}`; }
function decodeUint32(value, code = 'ABI_UINT32_INVALID') { if (!hex(value, 32)) fail(code); const number = BigInt(value); if (number > 0xffffffffn) fail(code); return Number(number); }
function decodeUint8Exact(value, expected) { if (!hex(value, 32) || BigInt(value) !== BigInt(expected)) fail('ABI_UINT8_EXACT_MISMATCH'); return expected; }
function decodeInt256(value, code = 'ABI_INT256_INVALID') { if (!hex(value, 32)) fail(code); const raw = BigInt(value), sign = 1n << 255n; return raw >= sign ? raw - (1n << 256n) : raw; }
function codeIdentity(value) { if (!hex(value) || value === '0x') fail('CODE_INVALID'); const bytes = Buffer.from(value.slice(2), 'hex'); return { length: bytes.length, keccak256: keccak256(bytes) }; }

function collectSensitiveStrings(candidates) {
  const values = new Set(), add = (value) => { if (typeof value !== 'string' || !value) return; values.add(value); try { const url = new URL(value); for (const part of [url.href, url.protocol, url.host, url.hostname, url.port, url.pathname, url.search, url.username, url.password, ...url.searchParams.keys(), ...url.searchParams.values()]) if (part) values.add(part); } catch (_) {} };
  const walk = (node, headers = false) => { if (typeof node === 'string') return add(node); if (Array.isArray(node)) return node.forEach((item) => walk(item, headers)); if (!object(node)) return; for (const [key, item] of Object.entries(node)) { if (headers || /headers?/iu.test(key)) add(key); walk(item, headers || /headers?/iu.test(key)); } };
  candidates.forEach((candidate) => walk(candidate)); return values;
}
function assertSanitized(serialized, corpus, authority) {
  if (/(?:https?|wss):\/\//iu.test(serialized) || /0x[0-9a-f]{40}(?![0-9a-f])/u.test(serialized)
      || /"(?:endpoint|url|uri|domain|hostname|provider|operator|family|inventory|credential|headers?|token|raw|implementationWord|adminWord|bytecode)"\s*:/iu.test(serialized)) fail('OUTPUT_UNSAFE');
  const lower = serialized.toLowerCase(); for (const item of corpus) if (lower.includes(item.toLowerCase())) fail('OUTPUT_UNSAFE');
  for (const value of Object.values(authority.roles)) if (lower.includes(value.toLowerCase())) fail('OUTPUT_UNSAFE');
}

const ROOT_ROLES = Object.freeze(['VAULT_PROXY', 'REGISTRY', 'OPEN_PNL_PROXY', 'ASSET']);
function normalizeAuthority(authority) {
  if (!object(authority) || authority.productionAuthority !== false || !/^[A-Z0-9_]{3,64}$/u.test(authority.id || '') || !object(authority.roles) || !object(authority.proxyModels)) fail('AUTHORITY_INVALID');
  if (JSON.stringify(Object.keys(authority.roles)) !== JSON.stringify(ROOT_ROLES)) fail('AUTHORITY_ROLES_INVALID');
  const roles = {}; for (const role of ROOT_ROLES) { const value = authority.roles[role]; if (!address(value)) fail('AUTHORITY_ADDRESS_INVALID'); roles[role] = value; }
  if (new Set(Object.values(roles)).size !== ROOT_ROLES.length) fail('AUTHORITY_ROLE_COLLISION');
  const proxyModels = {};
  for (const role of ['VAULT_PROXY', 'OPEN_PNL_PROXY']) {
    const model = authority.proxyModels[role]; if (!object(model) || !['ERC1967_TRANSPARENT', 'ERC1967_UUPS'].includes(model.model)
        || !Number.isSafeInteger(model.runtimeLength) || model.runtimeLength <= 0 || !/^0x[0-9a-f]{64}$/u.test(model.runtimeKeccak256 || '')
        || !object(model.adminPolicy) || !['ZERO', 'NONZERO', 'EXACT'].includes(model.adminPolicy.kind)) fail('PROXY_MODEL_INVALID');
    if (model.model === 'ERC1967_TRANSPARENT' && model.adminPolicy.kind === 'ZERO' || model.model === 'ERC1967_UUPS' && model.adminPolicy.kind === 'NONZERO') fail('PROXY_ADMIN_POLICY_INVALID');
    let exact = null; if (model.adminPolicy.kind === 'EXACT') { if (!address(model.adminPolicy.value)) fail('PROXY_ADMIN_POLICY_INVALID'); exact = model.adminPolicy.value; }
    proxyModels[role] = { model: model.model, runtimeLength: model.runtimeLength, runtimeKeccak256: model.runtimeKeccak256,
      adminPolicy: { kind: model.adminPolicy.kind, value: exact } };
  }
  return { id: authority.id, productionAuthority: false, chainId: PROFILE.chainId, roles, proxyModels };
}
function authorityCommitment(authority) { return sha256Public(canonical(normalizeAuthority(authority))); }
function validateAuthority(authority) { const normalized = normalizeAuthority(authority), commitment = authorityCommitment(normalized); if (authority.canonicalCommitment !== commitment) fail('AUTHORITY_COMMITMENT_MISMATCH'); return { ...normalized, canonicalCommitment: commitment }; }

function resolveLimits(injected) {
  if (injected === undefined) return { ...LIMITS }; if (!object(injected)) fail('LIMITS_INVALID'); for (const key of Object.keys(injected)) if (!own(LIMITS, key)) fail('LIMITS_INVALID'); const result = { ...LIMITS, ...injected };
  for (const [key, hard] of Object.entries(LIMITS)) if (!Number.isSafeInteger(result[key]) || result[key] < (key === 'retries' ? 0 : 1) || result[key] > hard) fail('LIMITS_INVALID');
  if (result.retries !== 0 || result.perOperatorConcurrency !== 1 || result.responseBytesPerRequest > result.responseBytes) fail('LIMITS_INVALID'); return Object.freeze(result);
}
function normalizeCandidate(candidate, index) {
  if (!object(candidate) || !object(candidate.operatorAuthority) || candidate.operatorAuthority.trusted !== true
      || !/^[A-Z0-9_]{2,64}$/u.test(candidate.operatorAuthority.id || '') || !/^[0-9a-f]{64}$/u.test(candidate.operatorAuthority.commitment || '')) fail('CANDIDATE_OPERATOR_INVALID');
  const inventoryOrder = candidate.inventoryOrder === undefined ? index : candidate.inventoryOrder, capabilityRank = candidate.capabilityRank === undefined ? 0 : candidate.capabilityRank;
  if (!Number.isSafeInteger(inventoryOrder) || inventoryOrder < 0 || !Number.isSafeInteger(capabilityRank) || capabilityRank < 0 || capabilityRank > 100) fail('CANDIDATE_INVALID');
  return { source: candidate, operatorKey: `${candidate.operatorAuthority.id}:${candidate.operatorAuthority.commitment}`,
    inventoryOrder, capabilityRank, premium: candidate.premium === true, calls: 0 };
}
function assertRpc(method, params) {
  if (!ALLOWED_METHODS.has(method) || FORBIDDEN.test(method) || !Array.isArray(params) || /pending|state.?override/iu.test(JSON.stringify(params))) fail('METHOD_FORBIDDEN'); let valid = false;
  if (method === 'eth_chainId') valid = params.length === 0;
  else if (method === 'eth_getBlockByNumber') valid = params.length === 2 && params[1] === false && (params[0] === 'finalized' || quantity(params[0]));
  else if (method === 'eth_getCode') valid = params.length === 2 && address(params[0]) && object(params[1]) && JSON.stringify(Object.keys(params[1])) === JSON.stringify(['blockHash', 'requireCanonical']) && hex32(params[1].blockHash) && params[1].requireCanonical === true;
  else if (method === 'eth_getStorageAt') valid = params.length === 3 && address(params[0]) && hex32(params[1]) && object(params[2]) && JSON.stringify(Object.keys(params[2])) === JSON.stringify(['blockHash', 'requireCanonical']) && hex32(params[2].blockHash) && params[2].requireCanonical === true;
  else if (method === 'eth_call') valid = params.length === 2 && object(params[0]) && JSON.stringify(Object.keys(params[0])) === JSON.stringify(['to', 'data']) && address(params[0].to) && hex(params[0].data) && object(params[1]) && JSON.stringify(Object.keys(params[1])) === JSON.stringify(['blockHash', 'requireCanonical']) && hex32(params[1].blockHash) && params[1].requireCanonical === true;
  if (!valid) fail('PARAMS_FORBIDDEN');
}
class Budget {
  constructor(limits, clock) { this.limits = limits; this.clock = clock; this.started = clock(); this.requests = 0; this.bytes = 0; this.active = 0; this.maxActive = 0; this.operatorActive = new Map(); this.maxOperatorActive = 0; }
  wall() { if (this.clock() - this.started > this.limits.wallMs) fail('WALL_LIMIT'); }
  begin(candidate) { this.wall(); if (this.requests + 1 > this.limits.requests) fail('REQUEST_LIMIT'); if (candidate.calls + 1 > this.limits.requestsPerCandidate) fail('CANDIDATE_REQUEST_LIMIT'); if (this.active + 1 > this.limits.concurrency) fail('CONCURRENCY_LIMIT'); const active = (this.operatorActive.get(candidate.operatorKey) || 0) + 1; if (active > this.limits.perOperatorConcurrency) fail('OPERATOR_CONCURRENCY_LIMIT'); this.requests++; candidate.calls++; this.active++; this.maxActive = Math.max(this.maxActive, this.active); this.operatorActive.set(candidate.operatorKey, active); this.maxOperatorActive = Math.max(this.maxOperatorActive, active); }
  end(candidate) { this.active--; this.operatorActive.set(candidate.operatorKey, Math.max(0, (this.operatorActive.get(candidate.operatorKey) || 0) - 1)); }
  add(bytes) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.responseBytesPerRequest) fail('RESPONSE_BYTE_LIMIT'); this.bytes += bytes; if (this.bytes > this.limits.responseBytes) fail('BYTE_LIMIT'); }
  summary() { return { requests: this.requests, responseBytes: this.bytes, maxConcurrency: this.maxActive, maxPerOperatorConcurrency: this.maxOperatorActive, elapsedMs: Math.max(0, this.clock() - this.started), retries: 0 }; }
}
async function rpc(candidate, method, params, context) {
  assertRpc(method, params); context.budget.begin(candidate); let timer; const controller = new AbortController();
  try { const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GateError('REQUEST_TIMEOUT')); }, context.limits.requestMs); }); let response; try { response = await Promise.race([context.transport(candidate.source, method, params, { signal: controller.signal }), timeout]); } catch (error) { throw error instanceof GateError ? error : new GateError('RPC_FAILURE'); }
    const result = object(response) && own(response, 'result') ? response.result : response; let encoded; try { encoded = JSON.stringify(result); } catch (_) { fail('RPC_RESULT_INVALID'); } const actual = Buffer.byteLength(encoded === undefined ? '' : encoded), reported = object(response) && Number.isSafeInteger(response.bytes) ? response.bytes : 0; context.budget.add(Math.max(actual, reported)); context.budget.wall(); return result;
  } finally { clearTimeout(timer); context.budget.end(candidate); }
}
async function multicall(candidate, pin, context) { const value = await rpc(candidate, 'eth_call', [{ to: MULTICALL3, data: GET_BLOCK_NUMBER }, eip1898(pin.hash)], context); if (!hex(value, 32) || BigInt(value) !== BigInt(pin.number)) fail('MULTICALL_PIN_MISMATCH'); }
const FATAL = new Set(['LIMITS_INVALID', 'REQUEST_LIMIT', 'CANDIDATE_REQUEST_LIMIT', 'RESPONSE_BYTE_LIMIT', 'BYTE_LIMIT', 'WALL_LIMIT', 'CONCURRENCY_LIMIT', 'OPERATOR_CONCURRENCY_LIMIT', 'REQUEST_TIMEOUT']);
async function qualify(candidate, context) {
  try { if (asSafeUint(await rpc(candidate, 'eth_chainId', [], context), 'CHAIN_ID_INVALID') !== PROFILE.chainId) fail('CHAIN_ID_MISMATCH'); const tagged = parseHeader(await rpc(candidate, 'eth_getBlockByNumber', ['finalized', false], context)); const exact = parseHeader(await rpc(candidate, 'eth_getBlockByNumber', [quantityHex(tagged.number), false], context), tagged.number); if (canonical(tagged) !== canonical(exact)) fail('FINALIZED_REREAD_MISMATCH'); await multicall(candidate, exact, context); const block = eip1898(exact.hash);
    codeIdentity(await rpc(candidate, 'eth_getCode', [context.authority.roles.VAULT_PROXY, block], context));
    if (!hex(await rpc(candidate, 'eth_getStorageAt', [context.authority.roles.VAULT_PROXY, PROFILE.slots.implementation, block], context), 32)) fail('QUALIFICATION_STORAGE_SCHEMA');
    if (!hex(await rpc(candidate, 'eth_call', [{ to: context.authority.roles.VAULT_PROXY, data: PROFILE.selectors.lastSettlementId }, block], context), 32)) fail('QUALIFICATION_CALL_SCHEMA');
    return { candidate, finalized: exact, ok: true, capabilityEvidence: 3 }; }
  catch (error) { if (FATAL.has(error.code)) throw error; return { candidate, ok: false, code: error instanceof GateError ? error.code : 'RPC_FAILURE' }; }
}
async function commonPin(rows, context) {
  if (rows.length < 2) fail('TWO_OPERATORS_UNAVAILABLE'); const heights = [...new Set(rows.map((row) => row.finalized.number))].sort((a, b) => b - a);
  for (const height of heights) { const observations = []; for (const row of rows.filter((item) => item.finalized.number >= height)) { try { observations.push({ ...row, pin: parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(height), false], context), height) }); } catch (error) { if (FATAL.has(error.code)) throw error; } }
    const groups = new Map(); for (const row of observations) { const key = canonical(row.pin), group = groups.get(key) || []; group.push(row); groups.set(key, group); }
    const agreed = [...groups.values()].filter((group) => new Set(group.map((row) => row.candidate.operatorKey)).size >= 2).sort((a, b) => b.length - a.length || Math.min(...a.map((x) => x.candidate.inventoryOrder)) - Math.min(...b.map((x) => x.candidate.inventoryOrder)))[0]; if (agreed) return { pin: agreed[0].pin, rows: agreed };
  } fail('COMMON_PIN_UNAVAILABLE');
}
function selectOperators(rows) { const ranked = [...rows].sort((a, b) => b.candidate.capabilityRank - a.candidate.capabilityRank || Number(b.candidate.premium) - Number(a.candidate.premium) || a.candidate.inventoryOrder - b.candidate.inventoryOrder); const first = ranked[0], second = ranked.find((row) => row.candidate.operatorKey !== first?.candidate.operatorKey); if (!first || !second) fail('TWO_OPERATORS_UNAVAILABLE'); return [first, second]; }
function operationParams(operation, targets, pin) { const target = targets[operation.role], block = eip1898(pin.hash); if (!address(target)) fail('DYNAMIC_TARGET_UNRESOLVED'); if (operation.method === 'eth_getCode') return [target, block]; if (operation.method === 'eth_getStorageAt') return [target, PROFILE.slots[operation.slot], block]; let data = PROFILE.selectors[operation.selector]; if (operation.key) data += PROFILE.registryKeys[operation.key].slice(2); return [{ to: target, data }, block]; }
async function material(candidate, authority, pin, context) { const values = [], targets = { ...authority.roles }; for (const operation of PROFILE.operations) { const result = await rpc(candidate, operation.method, operationParams(operation, targets, pin), context); if (!hex(result)) fail(`OP_${operation.id}_MALFORMED`); values.push(result); if (operation.id === 2) targets.VAULT_IMPLEMENTATION_AT_PIN = decodeAddressWord(result, 'VAULT_IMPLEMENTATION_DYNAMIC_INVALID'); if (operation.id === 15) targets.OPEN_PNL_IMPLEMENTATION_AT_PIN = decodeAddressWord(result, 'OPEN_PNL_IMPLEMENTATION_DYNAMIC_INVALID'); } return values; }
function proxyCategory(model) { return `TEST_MODEL_${model.model}_ADMIN_${model.adminPolicy.kind}`; }
function validateProxy(role, codeValue, adminWord, beaconWord, authority) {
  const model = authority.proxyModels[role], identity = codeIdentity(codeValue); if (identity.length !== model.runtimeLength || identity.keccak256 !== model.runtimeKeccak256) fail(`${role}_RUNTIME_MISMATCH`);
  const admin = decodeAddressWord(adminWord, `${role}_ADMIN_INVALID`); if (model.adminPolicy.kind === 'ZERO' && admin !== ZERO_ADDRESS || model.adminPolicy.kind === 'NONZERO' && admin === ZERO_ADDRESS || model.adminPolicy.kind === 'EXACT' && admin !== model.adminPolicy.value) fail(`${role}_ADMIN_POLICY_MISMATCH`); if (beaconWord !== ZERO_WORD) fail(`${role}_BEACON_NONZERO`); return { identity, category: proxyCategory(model) };
}
function project(raw, authority, pin) {
  if (!Array.isArray(raw) || raw.length !== 21) fail('OPERATION_COUNT'); const by = (id) => raw[id - 1];
  const vaultProxy = validateProxy('VAULT_PROXY', by(1), by(3), by(4), authority), openProxy = validateProxy('OPEN_PNL_PROXY', by(14), by(16), by(17), authority);
  decodeAddressWord(by(2), 'VAULT_IMPLEMENTATION_DYNAMIC_INVALID'); decodeAddressWord(by(15), 'OPEN_PNL_IMPLEMENTATION_DYNAMIC_INVALID');
  const vaultRuntime = codeIdentity(by(5)), registryRuntime = codeIdentity(by(11)), openRuntime = codeIdentity(by(18));
  for (const [role, identity] of [['VAULT_IMPLEMENTATION_AT_PIN', vaultRuntime], ['REGISTRY', registryRuntime], ['OPEN_PNL_IMPLEMENTATION_AT_PIN', openRuntime]]) if (identity.length !== PROFILE.runtimes[role].length || identity.keccak256 !== PROFILE.runtimes[role].keccak256) fail(`${role}_RUNTIME_MISMATCH`);
  const expectedLinks = [[6, 'REGISTRY'], [7, 'ASSET'], [12, 'VAULT_PROXY'], [13, 'OPEN_PNL_PROXY'], [19, 'REGISTRY']]; for (const [id, role] of expectedLinks) if (decodeAddressWord(by(id)) !== authority.roles[role]) fail(`ROLE_LINK_${id}_MISMATCH`);
  const lastSettlementId = decodeUint32(by(8)), lastSettlementTs = decodeUint32(by(9)); if (lastSettlementTs > pin.timestamp) fail('LAST_SETTLEMENT_TS_FUTURE');
  const lastSettlementOpenPnl = decodeInt256(by(10)).toString(), openPnlWithRollover = decodeInt256(by(20)).toString(); decodeUint8Exact(by(21), 6);
  return {
    roles: [
      { role: 'VAULT_PROXY', category: vaultProxy.category, codeLength: vaultProxy.identity.length, codeKeccak256: vaultProxy.identity.keccak256 },
      { role: 'VAULT_IMPLEMENTATION_AT_PIN', category: 'R3_BEHAVIORAL_AND_BUILD', codeLength: vaultRuntime.length, codeKeccak256: vaultRuntime.keccak256 },
      { role: 'REGISTRY', category: 'DIRECT_BUILD_CLOSURE_ONLY', codeLength: registryRuntime.length, codeKeccak256: registryRuntime.keccak256 },
      { role: 'OPEN_PNL_PROXY', category: openProxy.category, codeLength: openProxy.identity.length, codeKeccak256: openProxy.identity.keccak256 },
      { role: 'OPEN_PNL_IMPLEMENTATION_AT_PIN', category: 'BUILD_CLOSURE_ONLY', codeLength: openRuntime.length, codeKeccak256: openRuntime.keccak256 },
      { role: 'ASSET', category: 'LINKED_ASSET_DECIMALS_6', codeLength: null, codeKeccak256: null },
    ],
    links: [
      { from: 'VAULT_PROXY', relation: 'REGISTRY', to: 'REGISTRY' }, { from: 'VAULT_PROXY', relation: 'ASSET', to: 'ASSET' },
      { from: 'REGISTRY', relation: 'VAULT', to: 'VAULT_PROXY' }, { from: 'REGISTRY', relation: 'OPEN_PNL', to: 'OPEN_PNL_PROXY' },
      { from: 'OPEN_PNL_PROXY', relation: 'REGISTRY', to: 'REGISTRY' },
    ],
    sentinels: { lastSettlementId: String(lastSettlementId), lastSettlementTs: String(lastSettlementTs), lastSettlementOpenPnl, openPnlWithRollover },
    assetDecimals: 6,
  };
}
async function terminal(selected, pin, context) { for (const row of selected) { const finalized = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', ['finalized', false], context)); if (finalized.number < pin.number) fail('TERMINAL_FINALITY'); const exact = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(pin.number), false], context), pin.number); if (canonical(exact) !== canonical(pin)) fail('TERMINAL_HEADER_MISMATCH'); await multicall(row.candidate, pin, context); } }

async function runTestGate({ profileHash, authority: rawAuthority, candidates, transport, clock = Date.now, limits: injectedLimits } = {}) {
  if (profileHash !== PROFILE_HASH || PROFILE.productionEnabled !== false) fail('PROFILE_BINDING'); const limits = resolveLimits(injectedLimits), authority = validateAuthority(rawAuthority);
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > limits.candidates || typeof transport !== 'function') fail('INVOCATION_INVALID'); const corpus = collectSensitiveStrings(candidates), normalized = candidates.map(normalizeCandidate), budget = new Budget(limits, clock), context = { limits, budget, transport, authority };
  const qualification = []; for (const candidate of normalized) qualification.push(await qualify(candidate, context)); const passing = qualification.filter((row) => row.ok), common = await commonPin(passing, context), selected = selectOperators(common.rows);
  const nowSeconds = Math.floor(clock() / 1000); if (common.pin.timestamp < nowSeconds - PROFILE.pin.maxAgeSeconds) fail('PIN_STALE'); if (common.pin.timestamp > nowSeconds + PROFILE.pin.futureSkewSeconds) fail('PIN_FUTURE');
  for (const row of selected) await multicall(row.candidate, common.pin, context);
  const raw = []; for (const row of selected) raw.push(await material(row.candidate, authority, common.pin, context)); if (canonical(raw[0]) !== canonical(raw[1])) fail('RAW_CROSS_OPERATOR_MISMATCH'); const projection = project(raw[0], authority, common.pin); await terminal(selected, common.pin, context);
  const payload = { schema: SCHEMA, profileHash: PROFILE_HASH, status: 'PASS_TEST_ONLY', productionEnabled: false, chainId: PROFILE.chainId, generatedAt: new Date(clock()).toISOString(), authority: { id: authority.id, canonicalCommitment: authority.canonicalCommitment }, pin: common.pin,
    qualification: { candidatesEvaluated: normalized.length, qualifiedCandidates: passing.length, capabilityEvidencePerQualifiedCandidate: 3, distinctOperators: new Set(passing.map((row) => row.candidate.operatorKey)).size, selectionRule: 'CAPABILITY_PREMIUM_INVENTORY_ORDER', selectedOperators: 2, allCandidatesQualifiedBeforeSelection: true, selectedCommonPinMulticallBeforeMaterial: true, replacementAfterMaterialFailure: false, terminalRecheck: true },
    ...projection, budgets: { limits: { ...limits }, used: budget.summary() },
    safety: { offlineOnly: true, injectedTestTransportOnly: true, productionTransportPresent: false, productionPublishable: false, readOnly: true, eip1898Canonical: true, retries: 0, batches: false, traces: false, logs: false, pending: false, stateOverrides: false, signing: false, broadcasts: false, mutation: false, funds: false, endpointMaterialPersisted: false, endpointMaterialHashed: false },
    claims: { finality: 'RPC_FINALIZED_TAG_ONLY', productionProxyRuntimeAuthority: 'ABSENT_P0', vaultAuthority: 'R3_BEHAVIORAL_AND_BUILD', registryAuthority: 'BUILD_CLOSURE_ONLY', openPnlAuthority: 'BUILD_CLOSURE_ONLY' } };
  const publicText = `${JSON.stringify(payload, null, 2)}\n`; assertSanitized(publicText, corpus, authority); const artifact = { ...payload, integrity: { algorithm: 'sha256', payloadHash: sha256Public(canonical(payload)) } }, serialized = `${JSON.stringify(artifact, null, 2)}\n`; assertSanitized(serialized, corpus, authority); if (Buffer.byteLength(serialized) > limits.artifactBytes) fail('ARTIFACT_BYTE_LIMIT'); return { artifact, serialized };
}

module.exports = { SCHEMA, PROFILE_HASH, MULTICALL3, GET_BLOCK_NUMBER, ZERO_ADDRESS, ZERO_WORD, LIMITS, ALLOWED_METHODS,
  GateError, canonical, keccak256, sha256Public, parseHeader, eip1898, addressWord, decodeAddressWord, decodeUint32,
  decodeInt256, codeIdentity, collectSensitiveStrings, authorityCommitment, resolveLimits, assertRpc, runTestGate };
