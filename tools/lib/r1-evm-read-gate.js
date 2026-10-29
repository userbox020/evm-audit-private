#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'r1-evm-read-gate-v1';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const GET_BLOCK_NUMBER = '0x42cbb15c';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const LIMITS = Object.freeze({ candidates: 12, requests: 256, requestsPerCandidate: 96,
  responseBytes: 16 * 1024 * 1024, responseBytesPerRequest: 2 * 1024 * 1024,
  concurrency: 4, perFamilyConcurrency: 1, requestMs: 10_000, wallMs: 120_000,
  logEntries: 256, artifactBytes: 2 * 1024 * 1024, retries: 0 });
const ALLOWED_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getLogs']);
const FORBIDDEN_METHOD = /(?:trace|batch|send|sign|personal|wallet|admin|miner|mining|anvil|hardhat|debug|txpool|state.?override)/iu;

class GateError extends Error { constructor(code) { super(code); this.name = 'GateError'; this.code = code; } }
function fail(code) { throw new GateError(code); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hex(value, bytes = null) { return typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/iu.test(value) && (bytes === null || value.length === 2 + bytes * 2); }
function address(value) { return hex(value, 20); }
function hex32(value) { return hex(value, 32); }
function quantity(value) { return typeof value === 'string' && /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/iu.test(value); }
function quantityHex(value) { return `0x${BigInt(value).toString(16)}`; }
function uint(value, code = 'UINT_INVALID') { if (!quantity(value)) fail(code); const n = Number(BigInt(value)); if (!Number.isSafeInteger(n) || n < 0) fail(code); return n; }
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!object(value)) fail('UNSAFE_SERIALIZATION');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digestPublic(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function eip1898(blockHash) { if (!hex32(blockHash)) fail('PIN_HASH_INVALID'); return { blockHash: blockHash.toLowerCase(), requireCanonical: true }; }
function parseHeader(value, expectedNumber = null) {
  if (!object(value) || !quantity(value.number) || !hex32(value.hash) || !hex32(value.parentHash) || !hex32(value.stateRoot) || !quantity(value.timestamp)) fail('HEADER_INVALID');
  const header = { number: uint(value.number, 'HEADER_NUMBER_INVALID'), hash: value.hash.toLowerCase(), parentHash: value.parentHash.toLowerCase(),
    stateRoot: value.stateRoot.toLowerCase(), timestamp: uint(value.timestamp, 'HEADER_TIMESTAMP_INVALID') };
  if (expectedNumber !== null && header.number !== expectedNumber) fail('PIN_NUMBER_MISMATCH'); return header;
}
function sameHeader(a, b) { return canonical(a) === canonical(b); }

function familyFromHostname(hostname) {
  if (typeof hostname !== 'string' || !hostname || /[^a-z0-9.-]/iu.test(hostname)) fail('CANDIDATE_FAMILY_INVALID');
  const labels = hostname.toLowerCase().replace(/\.$/u, '').split('.').filter(Boolean); if (labels.length < 2) return labels.join('.');
  const suffix = labels.slice(-2).join('.'); return /^(?:co|com|net|org|gov|ac)\.[a-z]{2}$/u.test(suffix) && labels.length >= 3 ? labels.slice(-3).join('.') : suffix;
}
function normalizeCandidate(candidate, index) {
  if (!object(candidate)) fail('CANDIDATE_INVALID'); let hostname = candidate.hostname;
  if (!hostname && typeof candidate.url === 'string') { let url; try { url = new URL(candidate.url); } catch (_) { fail('CANDIDATE_INVALID'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('CANDIDATE_INVALID'); hostname = url.hostname; }
  const inventoryOrder = candidate.inventoryOrder === undefined ? index : candidate.inventoryOrder;
  const capabilityRank = candidate.capabilityRank === undefined ? 0 : candidate.capabilityRank;
  if (!Number.isSafeInteger(inventoryOrder) || inventoryOrder < 0 || !Number.isSafeInteger(capabilityRank) || capabilityRank < 0 || capabilityRank > 100) fail('CANDIDATE_INVALID');
  return { source: candidate, family: familyFromHostname(hostname), inventoryOrder, capabilityRank, premium: candidate.premium === true, calls: 0 };
}
function collectSensitiveStrings(candidates) {
  const values = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || value.length === 0) return; values.add(value);
    try { const url = new URL(value); for (const part of [url.href, url.protocol, url.host, url.hostname, url.port, url.pathname, url.search, url.username, url.password, ...url.searchParams.keys(), ...url.searchParams.values()]) if (part) values.add(part); } catch (_) {}
  };
  const walk = (node, inHeaders = false) => {
    if (typeof node === 'string') return add(node); if (Array.isArray(node)) return node.forEach((item) => walk(item, inHeaders)); if (!object(node)) return;
    for (const [key, item] of Object.entries(node)) { if (inHeaders || /headers?/iu.test(key)) add(key); walk(item, inHeaders || /headers?/iu.test(key)); }
  };
  candidates.forEach((candidate) => walk(candidate)); return values;
}
function assertSanitized(serialized, corpus) {
  if (/(?:https?|wss):\/\//iu.test(serialized) || /"(?:endpoint|provider|hostname|domain|inventory|familyName|familyHash|headers?)"\s*:/iu.test(serialized)) fail('OUTPUT_UNSAFE');
  const lower = serialized.toLowerCase(); for (const item of corpus) if (lower.includes(item.toLowerCase())) fail('OUTPUT_UNSAFE');
}

function resolveLimits(injected) {
  if (injected === undefined) return { ...LIMITS }; if (!object(injected)) fail('LIMITS_INVALID');
  for (const key of Object.keys(injected)) if (!own(LIMITS, key)) fail('LIMITS_INVALID');
  const result = { ...LIMITS, ...injected };
  for (const [key, hard] of Object.entries(LIMITS)) {
    const value = result[key]; if (!Number.isSafeInteger(value) || value < (key === 'retries' ? 0 : 1) || value > hard) fail('LIMITS_INVALID');
  }
  if (result.retries !== 0 || result.perFamilyConcurrency !== 1 || result.responseBytesPerRequest > result.responseBytes) fail('LIMITS_INVALID');
  return Object.freeze(result);
}
function assertEipObject(value) { if (!object(value) || JSON.stringify(Object.keys(value)) !== JSON.stringify(['blockHash', 'requireCanonical']) || !hex32(value.blockHash) || value.requireCanonical !== true) fail('EIP1898_REQUIRED'); }
function assertRpcRequest(method, params) {
  if (typeof method !== 'string' || FORBIDDEN_METHOD.test(method) || !ALLOWED_METHODS.has(method)) fail('METHOD_FORBIDDEN');
  if (!Array.isArray(params) || /"pending"|state.?override/iu.test(JSON.stringify(params))) fail('PARAMS_FORBIDDEN'); let valid = false;
  if (method === 'eth_chainId') valid = params.length === 0;
  else if (method === 'eth_getBlockByNumber') valid = params.length === 2 && params[1] === false && (params[0] === 'finalized' || quantity(params[0]));
  else if (method === 'eth_call') { valid = params.length === 2 && object(params[0]) && JSON.stringify(Object.keys(params[0])) === JSON.stringify(['to', 'data']) && address(params[0].to) && hex(params[0].data); if (valid) assertEipObject(params[1]); }
  else if (method === 'eth_getCode') { valid = params.length === 2 && address(params[0]); if (valid) assertEipObject(params[1]); }
  else if (method === 'eth_getStorageAt') { valid = params.length === 3 && address(params[0]) && hex32(params[1]); if (valid) assertEipObject(params[2]); }
  else if (method === 'eth_getLogs') { const filter = params[0], keys = filter && Object.keys(filter); valid = params.length === 1 && object(filter) && keys.every((key) => ['address', 'blockHash', 'topics'].includes(key)) && keys.includes('address') && keys.includes('blockHash') && address(filter.address) && hex32(filter.blockHash) && (!own(filter, 'topics') || Array.isArray(filter.topics) && filter.topics.every((x) => x === null || hex32(x))); }
  if (!valid) fail('PARAMS_FORBIDDEN'); return true;
}

class Budget {
  constructor({ limits = LIMITS, clock = Date.now } = {}) { this.limits = limits; this.clock = clock; this.started = clock(); this.requests = 0; this.bytes = 0; this.active = 0; this.maxActive = 0; this.familyActive = new Map(); this.maxFamilyActive = 0; }
  assertWall() { if (this.clock() - this.started > this.limits.wallMs) fail('WALL_LIMIT'); }
  begin(candidate) {
    this.assertWall(); if (this.requests + 1 > this.limits.requests) fail('REQUEST_LIMIT'); if (candidate.calls + 1 > this.limits.requestsPerCandidate) fail('CANDIDATE_REQUEST_LIMIT');
    if (this.active + 1 > this.limits.concurrency) fail('CONCURRENCY_LIMIT'); const family = (this.familyActive.get(candidate.family) || 0) + 1; if (family > this.limits.perFamilyConcurrency) fail('FAMILY_CONCURRENCY_LIMIT');
    this.requests++; candidate.calls++; this.active++; this.maxActive = Math.max(this.maxActive, this.active); this.familyActive.set(candidate.family, family); this.maxFamilyActive = Math.max(this.maxFamilyActive, family);
  }
  end(candidate) { this.active = Math.max(0, this.active - 1); this.familyActive.set(candidate.family, Math.max(0, (this.familyActive.get(candidate.family) || 0) - 1)); }
  addBytes(bytes) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.responseBytesPerRequest) fail('RESPONSE_BYTE_LIMIT'); this.bytes += bytes; if (this.bytes > this.limits.responseBytes) fail('BYTE_LIMIT'); }
  summary() { return { requests: this.requests, responseBytes: this.bytes, maxConcurrency: this.maxActive, maxPerFamilyConcurrency: this.maxFamilyActive, elapsedMs: Math.max(0, this.clock() - this.started), retries: 0 }; }
}
async function rpc(candidate, method, params, context) {
  assertRpcRequest(method, params); context.budget.begin(candidate); let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new GateError('REQUEST_TIMEOUT')), context.limits.requestMs); }); let response;
    try { response = await Promise.race([context.transport(candidate.source, method, params), timeout]); } catch (error) { throw error instanceof GateError ? error : new GateError('RPC_FAILURE'); }
    const result = object(response) && own(response, 'result') ? response.result : response; let serialized;
    try { serialized = JSON.stringify(result); } catch (_) { fail('RPC_RESULT_INVALID'); }
    const actual = Buffer.byteLength(serialized === undefined ? '' : serialized), reported = object(response) && Number.isSafeInteger(response.bytes) ? response.bytes : 0;
    context.budget.addBytes(Math.max(actual, reported)); context.budget.assertWall(); return result;
  } finally { clearTimeout(timer); context.budget.end(candidate); }
}
function decodeBlockNumber(value) { if (!hex(value, 32)) fail('MULTICALL_RESULT_INVALID'); const number = Number(BigInt(value)); if (!Number.isSafeInteger(number)) fail('MULTICALL_RESULT_INVALID'); return number; }
async function multicallPin(candidate, pin, context) { const result = await rpc(candidate, 'eth_call', [{ to: MULTICALL3, data: GET_BLOCK_NUMBER }, eip1898(pin.hash)], context); if (decodeBlockNumber(result) !== pin.number) fail('MULTICALL_PIN_MISMATCH'); }

const RESULT_TYPES = new Set(['tupleWords', 'positiveUint256', 'uint256Exact', 'expectedAddress', 'bool', 'storageWord', 'nonemptyCode', 'logs', 'implementationRuntime']);
function validateResultSchema(schema) { if (!object(schema) || !RESULT_TYPES.has(schema.type)) fail('PROFILE_INVALID'); if (schema.type === 'tupleWords' && (!Number.isSafeInteger(schema.words) || schema.words < 1 || schema.words > 32)) fail('PROFILE_INVALID'); if (schema.type === 'uint256Exact' && (!Number.isSafeInteger(schema.value) || schema.value < 0)) fail('PROFILE_INVALID'); if (schema.type === 'expectedAddress' && !address(schema.value)) fail('PROFILE_INVALID'); }
function validateProfile(profile) {
  if (!object(profile) || !/^[a-z0-9-]{3,80}$/u.test(profile.id || '') || !Number.isSafeInteger(profile.version) || profile.version < 1 || !Number.isSafeInteger(profile.chainId) || profile.chainId <= 0 || !object(profile.pin) || profile.pin.mode !== 'finalized' || !Number.isSafeInteger(profile.pin.maxAgeSeconds) || profile.pin.maxAgeSeconds < 1 || !Number.isSafeInteger(profile.pin.futureSkewSeconds) || profile.pin.futureSkewSeconds < 0 || !Array.isArray(profile.operations) || profile.operations.length < 1 || profile.operations.length > 48 || !address(profile.probeAddress)) fail('PROFILE_INVALID');
  const ids = new Set(); for (const operation of profile.operations) { if (!object(operation) || !/^[a-z0-9-]{1,80}$/u.test(operation.id || '') || ids.has(operation.id) || !['call', 'code', 'storage', 'implementationRuntime', 'logs'].includes(operation.kind) || !address(operation.address)) fail('PROFILE_INVALID'); ids.add(operation.id); validateResultSchema(operation.result);
    if (operation.kind === 'call' && !hex(operation.data) || ['storage', 'implementationRuntime'].includes(operation.kind) && !hex32(operation.slot) || operation.kind === 'logs' && operation.topics && (!Array.isArray(operation.topics) || operation.topics.some((x) => x !== null && !hex32(x)))) fail('PROFILE_INVALID');
    if (operation.kind === 'code' && operation.result.type !== 'nonemptyCode' || operation.kind === 'storage' && operation.result.type !== 'storageWord' || operation.kind === 'logs' && operation.result.type !== 'logs' || operation.kind === 'implementationRuntime' && operation.result.type !== 'implementationRuntime') fail('PROFILE_INVALID'); }
  if (profile.boundary) { if (!Number.isSafeInteger(profile.boundary.expiryTimestamp) || !Array.isArray(profile.boundary.operations) || !profile.boundary.operations.length || profile.boundary.operations.some((id) => !ids.has(id)) || !object(profile.boundary.transitions)) fail('PROFILE_INVALID'); }
  return true;
}
function validateOperationResult(operation, value) {
  const schema = operation.result;
  if (!hex(value)) fail('MATERIAL_RESULT_INVALID'); const normalized = value.toLowerCase();
  if (schema.type === 'nonemptyCode') { if (normalized === '0x') fail('MATERIAL_CODE_ABSENT'); return normalized; }
  if (schema.type === 'storageWord') { if (!hex(normalized, 32)) fail('STORAGE_WORD_INVALID'); return normalized; }
  if (schema.type === 'tupleWords') { if (normalized.length !== 2 + schema.words * 64) fail('TUPLE_RESULT_INVALID'); return normalized; }
  if (!hex(normalized, 32)) fail('ABI_WORD_INVALID'); const number = BigInt(normalized);
  if (schema.type === 'positiveUint256') { if (number <= 0n) fail('POSITIVE_UINT_REQUIRED'); return normalized; }
  if (schema.type === 'uint256Exact') { if (number !== BigInt(schema.value)) fail('UINT_EXACT_MISMATCH'); return normalized; }
  if (schema.type === 'bool') { if (number !== 0n && number !== 1n) fail('BOOL_INVALID'); return normalized; }
  if (schema.type === 'expectedAddress') { if (!/^0x0{24}[0-9a-f]{40}$/u.test(normalized) || `0x${normalized.slice(-40)}` !== schema.value.toLowerCase()) fail('ADDRESS_WORD_MISMATCH'); return normalized; }
  fail('RESULT_SCHEMA_UNSUPPORTED');
}
function normalizeLogs(value, pin, operation, limits) {
  if (!Array.isArray(value) || value.length > limits.logEntries) fail('LOG_RESULT_INVALID'); const logs = value.map((row) => {
    if (!object(row) || !address(row.address) || row.address.toLowerCase() !== operation.address.toLowerCase() || !hex32(row.blockHash) || row.blockHash.toLowerCase() !== pin.hash || uint(row.blockNumber, 'LOG_RESULT_INVALID') !== pin.number || !hex32(row.transactionHash) || !quantity(row.transactionIndex) || !quantity(row.logIndex) || !Array.isArray(row.topics) || row.topics.some((topic) => !hex32(topic)) || !hex(row.data) || row.removed === true) fail('LOG_RESULT_INVALID');
    return { address: row.address.toLowerCase(), blockHash: row.blockHash.toLowerCase(), blockNumber: quantityHex(pin.number), transactionHash: row.transactionHash.toLowerCase(), transactionIndex: quantityHex(BigInt(row.transactionIndex)), logIndex: quantityHex(BigInt(row.logIndex)), topics: row.topics.map((topic) => topic.toLowerCase()), data: row.data.toLowerCase(), removed: false };
  }).sort((a, b) => Number(BigInt(a.logIndex) - BigInt(b.logIndex)) || a.transactionHash.localeCompare(b.transactionHash));
  if (operation.knownPositive === true && logs.length < (operation.minCount || 1)) fail('ANCHORED_LOG_REQUIRED'); return logs;
}
function implementationAddress(word) { if (!hex(word, 32) || !/^0x0{24}[0-9a-f]{40}$/iu.test(word)) fail('IMPLEMENTATION_SLOT_INVALID'); const result = `0x${word.slice(-40)}`.toLowerCase(); if (result === `0x${'0'.repeat(40)}`) fail('IMPLEMENTATION_SLOT_INVALID'); return result; }
async function executeOperation(candidate, operation, pin, context) {
  let value;
  if (operation.kind === 'call') value = await rpc(candidate, 'eth_call', [{ to: operation.address, data: operation.data }, eip1898(pin.hash)], context);
  else if (operation.kind === 'code') value = await rpc(candidate, 'eth_getCode', [operation.address, eip1898(pin.hash)], context);
  else if (operation.kind === 'storage') value = await rpc(candidate, 'eth_getStorageAt', [operation.address, operation.slot, eip1898(pin.hash)], context);
  else if (operation.kind === 'implementationRuntime') { const storage = validateOperationResult({ result: { type: 'storageWord' } }, await rpc(candidate, 'eth_getStorageAt', [operation.address, operation.slot, eip1898(pin.hash)], context)); const implementation = implementationAddress(storage); const code = validateOperationResult({ result: { type: 'nonemptyCode' } }, await rpc(candidate, 'eth_getCode', [implementation, eip1898(pin.hash)], context)); return { implementation, code }; }
  else { const filter = { address: operation.address, blockHash: pin.hash }; if (operation.topics) filter.topics = operation.topics; return normalizeLogs(await rpc(candidate, 'eth_getLogs', [filter], context), pin, operation, context.limits); }
  return validateOperationResult(operation, value);
}
function transitionValue(operation, value) { if (operation.result.type !== 'bool') return value; return BigInt(value) === 1n; }
function enforceTimestampExpectation(profile, operation, value, pin) { const transition = profile.boundary?.transitions?.[operation.id]; if (!transition) return; const expected = pin.timestamp < profile.boundary.expiryTimestamp ? transition.pre : transition.post; if (transitionValue(operation, value) !== expected) fail('BOUNDARY_TRANSITION_MISMATCH'); }

const FATAL = new Set(['LIMITS_INVALID', 'REQUEST_LIMIT', 'CANDIDATE_REQUEST_LIMIT', 'RESPONSE_BYTE_LIMIT', 'BYTE_LIMIT', 'WALL_LIMIT', 'CONCURRENCY_LIMIT', 'FAMILY_CONCURRENCY_LIMIT']);
async function qualifyCandidate(candidate, profile, context) {
  try { if (uint(await rpc(candidate, 'eth_chainId', [], context), 'CHAIN_ID_INVALID') !== profile.chainId) fail('CHAIN_ID_MISMATCH'); const finalized = parseHeader(await rpc(candidate, 'eth_getBlockByNumber', ['finalized', false], context)); const exact = parseHeader(await rpc(candidate, 'eth_getBlockByNumber', [quantityHex(finalized.number), false], context), finalized.number); if (!sameHeader(finalized, exact)) fail('FINALIZED_EXACT_MISMATCH'); await multicallPin(candidate, exact, context); return { candidate, finalized: exact, ok: true }; }
  catch (error) { if (FATAL.has(error.code)) throw error; return { candidate, ok: false, code: error instanceof GateError ? error.code : 'RPC_FAILURE' }; }
}
async function establishCommonPin(qualified, context) {
  if (qualified.length < 2) fail('TWO_FAMILIES_UNAVAILABLE'); const heights = [...new Set(qualified.map((row) => row.finalized.number))].sort((a, b) => b - a);
  for (const height of heights) {
    const observed = [];
    for (const row of qualified.filter((item) => item.finalized.number >= height)) { try { observed.push({ ...row, pin: parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(height), false], context), height) }); } catch (error) { if (FATAL.has(error.code)) throw error; } }
    const groups = new Map(); for (const row of observed) { const key = canonical(row.pin), list = groups.get(key) || []; list.push(row); groups.set(key, list); }
    const agreed = [...groups.values()].filter((group) => new Set(group.map((row) => row.candidate.family)).size >= 2).sort((a, b) => b.length - a.length || Math.min(...a.map((x) => x.candidate.inventoryOrder)) - Math.min(...b.map((x) => x.candidate.inventoryOrder)))[0];
    if (agreed) return { pin: agreed[0].pin, rows: agreed };
  }
  fail('COMMON_FINALIZED_PIN_UNAVAILABLE');
}
function rankCandidates(rows) { return [...rows].sort((a, b) => b.candidate.capabilityRank - a.candidate.capabilityRank || Number(b.candidate.premium) - Number(a.candidate.premium) || a.candidate.inventoryOrder - b.candidate.inventoryOrder); }
function selectTwo(rows) { const ranked = rankCandidates(rows), first = ranked[0], second = ranked.find((row) => row.candidate.family !== first?.candidate.family); if (!first || !second) fail('TWO_FAMILIES_UNAVAILABLE'); return [first, second]; }
function assertFresh(profile, pin, nowMs) { const now = Math.floor(nowMs / 1000); if (pin.timestamp < now - profile.pin.maxAgeSeconds) fail('PIN_STALE'); if (pin.timestamp > now + profile.pin.futureSkewSeconds) fail('PIN_FUTURE'); }

async function boundaryEvidence(profile, selected, pin, context) {
  if (!profile.boundary) return null; const expiry = profile.boundary.expiryTimestamp;
  if (pin.timestamp < expiry) return { expiryTimestamp: expiry, readiness: 'NOT_YET_OBSERVABLE', preBlock: null, postBlock: null, preObservations: null, postObservations: null };
  let low = 1, high = pin.number;
  while (low < high) { const middle = Math.floor((low + high) / 2), block = parseHeader(await rpc(selected[0].candidate, 'eth_getBlockByNumber', [quantityHex(middle), false], context), middle); if (block.timestamp >= expiry) high = middle; else low = middle + 1; }
  if (low <= 0 || low > pin.number) fail('BOUNDARY_ADJACENT_UNAVAILABLE'); const perFamily = [];
  for (const row of selected) {
    const pre = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(low - 1), false], context), low - 1);
    const post = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(low), false], context), low);
    if (post.parentHash !== pre.hash || pre.timestamp >= expiry || post.timestamp < expiry) fail('BOUNDARY_HEADER_INVALID');
    await multicallPin(row.candidate, pre, context); await multicallPin(row.candidate, post, context);
    const preObservations = [], postObservations = [];
    for (const id of profile.boundary.operations) { const operation = profile.operations.find((item) => item.id === id); const preValue = await executeOperation(row.candidate, operation, pre, context), postValue = await executeOperation(row.candidate, operation, post, context); enforceTimestampExpectation(profile, operation, preValue, pre); enforceTimestampExpectation(profile, operation, postValue, post); preObservations.push({ id, kind: operation.kind, value: preValue }); postObservations.push({ id, kind: operation.kind, value: postValue }); }
    perFamily.push({ pre, post, preObservations, postObservations });
  }
  if (canonical(perFamily[0]) !== canonical(perFamily[1])) fail('BOUNDARY_CROSS_FAMILY_DISAGREEMENT');
  return { expiryTimestamp: expiry, readiness: 'OBSERVABLE', preBlock: perFamily[0].pre, postBlock: perFamily[0].post, preObservations: perFamily[0].preObservations, postObservations: perFamily[0].postObservations };
}
async function terminalRecheck(selected, pin, context) { for (const row of selected) { const finalized = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', ['finalized', false], context)); if (finalized.number < pin.number) fail('TERMINAL_FINALITY_RECHECK_FAILED'); const exact = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(pin.number), false], context), pin.number); if (!sameHeader(exact, pin)) fail('TERMINAL_PIN_RECHECK_FAILED'); await multicallPin(row.candidate, pin, context); } }

async function runProfileGate({ profile, candidates, transport, clock = Date.now, limits: injectedLimits } = {}) {
  validateProfile(profile); const limits = resolveLimits(injectedLimits); if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > limits.candidates || typeof transport !== 'function') fail('INVOCATION_INVALID');
  const corpus = collectSensitiveStrings(candidates), normalized = candidates.map(normalizeCandidate), budget = new Budget({ limits, clock }), context = { transport, budget, limits };
  const qualification = []; for (const candidate of normalized) qualification.push(await qualifyCandidate(candidate, profile, context));
  const passing = qualification.filter((row) => row.ok), common = await establishCommonPin(passing, context), selected = selectTwo(common.rows);
  assertFresh(profile, common.pin, clock()); const boundary = await boundaryEvidence(profile, selected, common.pin, context), families = [];
  for (const row of selected) { await multicallPin(row.candidate, common.pin, context); const observations = []; for (const operation of profile.operations) { const value = await executeOperation(row.candidate, operation, common.pin, context); enforceTimestampExpectation(profile, operation, value, common.pin); observations.push({ id: operation.id, kind: operation.kind, value }); } families.push(observations); }
  if (canonical(families[0]) !== canonical(families[1])) fail('CROSS_FAMILY_DISAGREEMENT'); await terminalRecheck(selected, common.pin, context);
  const profileHash = digestPublic(canonical(profile)); const payload = { schema: SCHEMA, profile: profile.id, profileHash, chainId: profile.chainId, generatedAt: new Date(clock()).toISOString(), status: 'PASS', pin: common.pin,
    qualification: { candidatesEvaluated: normalized.length, qualifiedCandidates: passing.length, distinctHeuristicFamilies: new Set(passing.map((row) => row.candidate.family)).size, selectionRule: 'CAPABILITY_PREMIUM_INVENTORY_ORDER', selectedCount: 2, commonFinalizedAgreement: true, terminalRecheck: true },
    observations: families[0], boundary, readiness: null,
    budgets: { limits: { ...limits }, used: budget.summary() },
    safety: { readOnly: true, eip1898Canonical: true, multicallPinValidated: true, batches: false, traces: false, pendingState: false, stateOverrides: false, retries: 0, signing: false, mutation: false, endpointMaterialPersisted: false, endpointMaterialHashed: false, oneShotMarker: false } };
  const publicSerialized = `${JSON.stringify(payload, null, 2)}\n`; assertSanitized(publicSerialized, corpus);
  const artifact = { ...payload, integrity: { algorithm: 'sha256', payloadHash: digestPublic(canonical(payload)) } }, serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  assertSanitized(serialized, corpus); if (Buffer.byteLength(serialized) > limits.artifactBytes) fail('ARTIFACT_BYTE_LIMIT'); return { artifact, serialized };
}
async function runTestGate(options = {}) { return runProfileGate(options); }

function atomicPublish(serialized, outputPath, { fsOps = fs } = {}) {
  if (typeof serialized !== 'string' || !serialized.endsWith('\n') || typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) fail('PUBLICATION_INVALID');
  const parent = path.dirname(outputPath); let parentBefore; try { parentBefore = fsOps.lstatSync(parent); } catch (_) { fail('PUBLICATION_PARENT_INVALID'); }
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) fail('PUBLICATION_PARENT_INVALID'); if (fsOps.existsSync(outputPath)) fail('OUTPUT_EXISTS');
  const temp = path.join(parent, `.${path.basename(outputPath)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`); let fd = null, committed = false;
  const sameParent = () => { const current = fsOps.lstatSync(parent); return current.isDirectory() && !current.isSymbolicLink() && current.dev === parentBefore.dev && current.ino === parentBefore.ino; };
  try {
    fd = fsOps.openSync(temp, 'wx', 0o600); fsOps.writeFileSync(fd, serialized, 'utf8'); fsOps.fsyncSync(fd); fsOps.closeSync(fd); fd = null;
    if (!sameParent()) fail('PUBLICATION_PARENT_CHANGED'); if (fsOps.existsSync(outputPath)) fail('OUTPUT_EXISTS'); fsOps.linkSync(temp, outputPath); committed = true;
  } catch (error) {
    if (fd !== null) try { fsOps.closeSync(fd); } catch (_) {} try { if (fsOps.existsSync(temp)) fsOps.unlinkSync(temp); } catch (_) {}
    if (error instanceof GateError) throw error; if (error && error.code === 'EEXIST') fail('OUTPUT_EXISTS'); fail('PUBLICATION_FAILED');
  }
  // The hard link is the commit point. All following cleanup is best-effort and
  // may only touch the uniquely owned staging path, never the committed output.
  if (committed) { try { fsOps.unlinkSync(temp); } catch (_) {} try { const dir = fsOps.openSync(parent, 'r'); try { fsOps.fsyncSync(dir); } finally { fsOps.closeSync(dir); } } catch (_) {} }
  return outputPath;
}

module.exports = { SCHEMA, MULTICALL3, GET_BLOCK_NUMBER, IMPLEMENTATION_SLOT, LIMITS, ALLOWED_METHODS, GateError, Budget,
  canonical, digestPublic, eip1898, parseHeader, familyFromHostname, collectSensitiveStrings, resolveLimits, assertRpcRequest,
  validateOperationResult, normalizeLogs, rankCandidates, selectTwo, runTestGate, atomicPublish };
