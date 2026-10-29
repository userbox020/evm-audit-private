#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const base = require('./r1-evm-read-gate.js');

const SCHEMA = 'morpho-pt-27aug2026-post-expiry-r1/capture-v1';
const LIMITS = Object.freeze({ candidates: 4, requests: 256, requestsPerCandidate: 96,
  responseBytes: 16 * 1024 * 1024, responseBytesPerRequest: 2 * 1024 * 1024,
  concurrency: 4, perFamilyConcurrency: 1, requestMs: 10_000, wallMs: 120_000,
  logEntries: 1, artifactBytes: 2 * 1024 * 1024, retries: 0 });
const FATAL = new Set(['LIMITS_INVALID', 'REQUEST_LIMIT', 'CANDIDATE_REQUEST_LIMIT', 'RESPONSE_BYTE_LIMIT', 'BYTE_LIMIT', 'WALL_LIMIT', 'CONCURRENCY_LIMIT', 'FAMILY_CONCURRENCY_LIMIT']);

class GateError extends Error { constructor(code) { super(code); this.name = 'GateError'; this.code = code; } }
function fail(code) { throw new GateError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function hex(value, bytes = null) { return typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/iu.test(value) && (bytes === null || value.length === 2 + bytes * 2); }
function quantity(value) { return typeof value === 'string' && /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/iu.test(value); }
function quantityHex(value) { return `0x${BigInt(value).toString(16)}`; }
function canonical(value) { return base.canonical(value); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function parseHeader(value, expected = null) { try { return base.parseHeader(value, expected); } catch (error) { throw new GateError(error.code || 'HEADER_INVALID'); } }
function sameHeader(a, b) { return canonical(a) === canonical(b); }

function resolveLimits(injected) {
  if (injected === undefined) return { ...LIMITS };
  if (!object(injected)) fail('LIMITS_INVALID');
  for (const key of Object.keys(injected)) if (!own(LIMITS, key)) fail('LIMITS_INVALID');
  const result = { ...LIMITS, ...injected };
  for (const [key, hard] of Object.entries(LIMITS)) {
    const value = result[key];
    if (!Number.isSafeInteger(value) || value < (key === 'retries' ? 0 : 1) || value > hard) fail('LIMITS_INVALID');
  }
  if (result.retries !== 0 || result.perFamilyConcurrency !== 1 || result.candidates < 3 || result.responseBytesPerRequest > result.responseBytes) fail('LIMITS_INVALID');
  return Object.freeze(result);
}

function normalizeCandidate(candidate, index) {
  if (!object(candidate) || typeof candidate.operatorFamily !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,63}$/iu.test(candidate.operatorFamily)) fail('CANDIDATE_AUTHORITY_INVALID');
  const inventoryOrder = candidate.inventoryOrder === undefined ? index : candidate.inventoryOrder;
  const capabilityRank = candidate.capabilityRank === undefined ? 0 : candidate.capabilityRank;
  if (!Number.isSafeInteger(inventoryOrder) || inventoryOrder < 0 || !Number.isSafeInteger(capabilityRank) || capabilityRank < 0 || capabilityRank > 100) fail('CANDIDATE_INVALID');
  const operatorFamily = candidate.operatorFamily.toLowerCase();
  return { source: candidate, operatorFamily, family: operatorFamily, inventoryOrder, capabilityRank, premium: candidate.premium === true, calls: 0 };
}
function rank(rows) { return [...rows].sort((a, b) => b.candidate.capabilityRank - a.candidate.capabilityRank || Number(b.candidate.premium) - Number(a.candidate.premium) || a.candidate.inventoryOrder - b.candidate.inventoryOrder); }
function selectEvidence(rows) {
  const ranked = rank(rows), first = ranked[0], second = ranked.find((row) => row.candidate.operatorFamily !== first?.candidate.operatorFamily);
  if (!first || !second) fail('TWO_OPERATOR_FAMILIES_UNAVAILABLE');
  return [first, second];
}

function validateProfile(profile) {
  if (!object(profile) || profile.chainId !== 1 || !object(profile.pin) || profile.pin.mode !== 'finalized' || !object(profile.candidatePolicy)
    || profile.candidatePolicy.minimum !== 3 || profile.candidatePolicy.maximum !== 4 || profile.candidatePolicy.evidenceFamilies !== 2
    || profile.candidatePolicy.separateBoundaryLocator !== true || profile.candidatePolicy.authoritativeOperatorFamilyRequired !== true
    || !object(profile.boundary) || profile.boundary.requireObservable !== true || profile.boundary.operationScope !== 'boundary'
    || !Number.isSafeInteger(profile.boundary.expiryTimestamp) || !Array.isArray(profile.operations) || profile.operations.length !== 34) fail('PROFILE_INVALID');
  const ids = new Set();
  for (const operation of profile.operations) {
    if (!object(operation) || ids.has(operation.id) || operation.scope !== 'boundary' || !['call', 'code'].includes(operation.kind)
      || !hex(operation.address, 20) || !object(operation.result)) fail('PROFILE_INVALID');
    ids.add(operation.id);
    if (operation.kind === 'call' && !hex(operation.data) || operation.kind === 'code' && operation.result.type !== 'codeSha256Baseline') fail('PROFILE_INVALID');
  }
  for (const id of Object.keys(profile.boundary.transitions)) if (!ids.has(id)) fail('PROFILE_INVALID');
  return true;
}

async function rpc(candidate, method, params, context) {
  try { base.assertRpcRequest(method, params); } catch (error) { throw new GateError(error.code || 'METHOD_FORBIDDEN'); }
  context.budget.begin(candidate); let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new GateError('REQUEST_TIMEOUT')), context.limits.requestMs); });
    let response; try { response = await Promise.race([context.transport(candidate.source, method, params), timeout]); } catch (error) { throw error instanceof GateError ? error : new GateError('RPC_FAILURE'); }
    const result = object(response) && own(response, 'result') ? response.result : response;
    let serialized; try { serialized = JSON.stringify(result); } catch (_) { fail('RPC_RESULT_INVALID'); }
    const actual = Buffer.byteLength(serialized === undefined ? '' : serialized), reported = object(response) && Number.isSafeInteger(response.bytes) ? response.bytes : 0;
    context.budget.addBytes(Math.max(actual, reported)); context.budget.assertWall(); return result;
  } finally { clearTimeout(timer); context.budget.end(candidate); }
}
async function multicallPin(candidate, pin, context) {
  const result = await rpc(candidate, 'eth_call', [{ to: base.MULTICALL3, data: base.GET_BLOCK_NUMBER }, base.eip1898(pin.hash)], context);
  if (!hex(result, 32) || Number(BigInt(result)) !== pin.number) fail('MULTICALL_PIN_MISMATCH');
}

function decodeRound(value) {
  if (!hex(value) || value.length !== 2 + 5 * 64) fail('ROUND_DATA_INVALID');
  const words = Array.from({ length: 5 }, (_, i) => BigInt(`0x${value.slice(2 + i * 64, 2 + (i + 1) * 64)}`));
  const signed = words[1] >= 1n << 255n ? words[1] - (1n << 256n) : words[1];
  if (signed <= 0n) fail('ROUND_ANSWER_NONPOSITIVE');
  return { roundId: words[0].toString(), answer: signed.toString(), startedAt: words[2].toString(), updatedAt: words[3].toString(), answeredInRound: words[4].toString() };
}
function validateOperationResult(operation, value) {
  const schema = operation.result;
  if (operation.kind === 'code') {
    if (!hex(value) || value === '0x') fail('MATERIAL_CODE_ABSENT');
    const normalized = value.toLowerCase(), bytes = (normalized.length - 2) / 2;
    const sha256 = `0x${crypto.createHash('sha256').update(Buffer.from(normalized.slice(2), 'hex')).digest('hex')}`;
    return { bytes, sha256, baselineMatch: bytes === schema.bytes && sha256 === schema.sha256 };
  }
  if (!hex(value)) fail('MATERIAL_RESULT_INVALID');
  const normalized = value.toLowerCase();
  if (schema.type === 'tupleWords') { if (normalized.length !== 2 + schema.words * 64) fail('TUPLE_RESULT_INVALID'); return normalized; }
  if (schema.type === 'bytesBaseline') { if (normalized.length !== schema.value.length) fail('BASELINE_RESULT_INVALID'); return { raw: normalized, baselineMatch: normalized === schema.value }; }
  if (schema.type === 'roundData') { decodeRound(normalized); return normalized; }
  if (!hex(normalized, 32)) fail('ABI_WORD_INVALID'); const number = BigInt(normalized);
  if (schema.type === 'positiveUint256') { if (number <= 0n) fail('POSITIVE_UINT_REQUIRED'); return normalized; }
  if (schema.type === 'uint256Exact') return { raw: normalized, expectedMatch: number === BigInt(schema.value) };
  if (schema.type === 'bool') { if (number !== 0n && number !== 1n) fail('BOOL_INVALID'); return normalized; }
  fail('RESULT_SCHEMA_UNSUPPORTED');
}
async function executeOperation(candidate, operation, pin, context) {
  const raw = operation.kind === 'call'
    ? await rpc(candidate, 'eth_call', [{ to: operation.address, data: operation.data }, base.eip1898(pin.hash)], context)
    : await rpc(candidate, 'eth_getCode', [operation.address, base.eip1898(pin.hash)], context);
  return validateOperationResult(operation, raw);
}

async function qualify(candidate, profile, context) {
  try {
    const chain = await rpc(candidate, 'eth_chainId', [], context); if (!quantity(chain) || Number(BigInt(chain)) !== profile.chainId) fail('CHAIN_ID_MISMATCH');
    const finalized = parseHeader(await rpc(candidate, 'eth_getBlockByNumber', ['finalized', false], context));
    const exact = parseHeader(await rpc(candidate, 'eth_getBlockByNumber', [quantityHex(finalized.number), false], context), finalized.number);
    if (!sameHeader(finalized, exact)) fail('FINALIZED_EXACT_MISMATCH'); await multicallPin(candidate, exact, context);
    return { candidate, finalized: exact, ok: true };
  } catch (error) { if (FATAL.has(error.code)) throw error; return { candidate, ok: false, code: error.code || 'RPC_FAILURE' }; }
}
async function establishCommonPin(rows, context) {
  const heights = [...new Set(rows.map((row) => row.finalized.number))].sort((a, b) => b - a);
  for (const height of heights) {
    const observed = [];
    for (const row of rows.filter((item) => item.finalized.number >= height)) {
      try { observed.push({ ...row, pin: parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(height), false], context), height) }); } catch (error) { if (FATAL.has(error.code)) throw error; }
    }
    const groups = new Map();
    for (const row of observed) { const key = canonical(row.pin), group = groups.get(key) || []; group.push(row); groups.set(key, group); }
    const agreed = [...groups.values()].filter((group) => new Set(group.map((row) => row.candidate.operatorFamily)).size >= 2)
      .sort((a, b) => b.length - a.length || Math.min(...a.map((x) => x.candidate.inventoryOrder)) - Math.min(...b.map((x) => x.candidate.inventoryOrder)))[0];
    if (agreed) return { pin: agreed[0].pin, rows: agreed };
  }
  fail('COMMON_FINALIZED_PIN_UNAVAILABLE');
}
function assertFresh(profile, pin, nowMs) { const now = Math.floor(nowMs / 1000); if (pin.timestamp < now - profile.pin.maxAgeSeconds) fail('PIN_STALE'); if (pin.timestamp > now + profile.pin.futureSkewSeconds) fail('PIN_FUTURE'); }

async function locateBoundary(locator, pin, expiry, context) {
  let low = 1, high = pin.number;
  while (low < high) {
    const middle = Math.floor((low + high) / 2), header = parseHeader(await rpc(locator.candidate, 'eth_getBlockByNumber', [quantityHex(middle), false], context), middle);
    if (header.timestamp >= expiry) high = middle; else low = middle + 1;
  }
  return low;
}
function observationMap(rows) { return new Map(rows.map((row) => [row.id, row.value])); }
function rawWord(value) { return BigInt(object(value) && typeof value.raw === 'string' ? value.raw : value); }
function expectedLinear(timestamp, profile) {
  const one = BigInt(profile.formula.one), maturity = BigInt(profile.boundary.expiryTimestamp), time = BigInt(timestamp);
  if (time >= maturity) return one;
  return one - ((maturity - time) * BigInt(profile.formula.baseDiscountPerYear)) / BigInt(profile.formula.secondsPerYear);
}
function analyzeBlock(header, observations, profile, side) {
  const rows = observationMap(observations), linear = expectedLinear(header.timestamp, profile);
  const rounds = Object.fromEntries(['apx-wrapper', 'apy-wrapper', 'apx-inner', 'apy-inner', 'underlying', 'quote-discounted', 'quote-par']
    .map((id) => [id, decodeRound(rows.get(`round-${id}`))]));
  const wrapperFormulaExact = BigInt(rounds['apx-wrapper'].answer) === linear && BigInt(rounds['apy-wrapper'].answer) === linear;
  const innerFormulaExact = BigInt(rounds['apx-inner'].answer) === linear && BigInt(rounds['apy-inner'].answer) === linear;
  const wrapperTimestampExact = BigInt(rounds['apx-wrapper'].updatedAt) === BigInt(header.timestamp) && BigInt(rounds['apy-wrapper'].updatedAt) === BigInt(header.timestamp);
  const innerTimestampExact = BigInt(rounds['apx-inner'].updatedAt) === 0n && BigInt(rounds['apy-inner'].updatedAt) === 0n;
  const noFutureExternalFeed = ['underlying', 'quote-discounted', 'quote-par'].every((id) => BigInt(rounds[id].updatedAt) <= BigInt(header.timestamp));
  const underlying = BigInt(rounds.underlying.answer), discountedQuote = BigInt(rounds['quote-discounted'].answer), parQuote = BigInt(rounds['quote-par'].answer);
  const expected = { apx: (BigInt(rounds['apx-wrapper'].answer) * underlying) / discountedQuote,
    apyDiscounted: (BigInt(rounds['apy-wrapper'].answer) * underlying) / discountedQuote,
    apyPar: (BigInt(rounds['apy-wrapper'].answer) * underlying) / parQuote };
  const oraclePriceFormulaExact = rawWord(rows.get('oracle-price-apx')) === expected.apx
    && rawWord(rows.get('oracle-price-apy-discounted')) === expected.apyDiscounted
    && rawWord(rows.get('oracle-price-apy-par')) === expected.apyPar;
  const expiryGetterMatch = ['apx-pt-expiry', 'apy-pt-expiry'].every((id) => object(rows.get(id)) && rows.get(id).expectedMatch === true);
  const expectedExpired = side === 'post';
  const expiryTransitionMatch = ['apx-pt-is-expired', 'apy-pt-is-expired', 'apx-yt-is-expired', 'apy-yt-is-expired']
    .every((id) => (rawWord(rows.get(id)) === 1n) === expectedExpired);
  const marketParamsBaselineMatch = ['morpho-params-apx', 'morpho-params-apy-discounted', 'morpho-params-apy-par']
    .every((id) => object(rows.get(id)) && rows.get(id).baselineMatch === true);
  const runtimeIdentityBaselineMatch = observations.filter((row) => row.kind === 'code').every((row) => row.value.baselineMatch === true);
  return { timestamp: header.timestamp, expectedLinearAnswer: linear.toString(), rounds, expectedOraclePrices: Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, v.toString()])),
    wrapperFormulaExact, innerFormulaExact, wrapperTimestampExact, innerTimestampExact, noFutureExternalFeed,
    oraclePriceFormulaExact, expiryGetterMatch, expiryTransitionMatch, marketParamsBaselineMatch, runtimeIdentityBaselineMatch };
}

async function captureBoundary(profile, evidence, locator, pin, context) {
  const number = await locateBoundary(locator, pin, profile.boundary.expiryTimestamp, context), perFamily = [];
  for (const row of evidence) {
    const pre = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(number - 1), false], context), number - 1);
    const post = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(number), false], context), number);
    if (post.parentHash !== pre.hash || pre.timestamp >= profile.boundary.expiryTimestamp || post.timestamp < profile.boundary.expiryTimestamp) fail('BOUNDARY_HEADER_INVALID');
    await multicallPin(row.candidate, pre, context); await multicallPin(row.candidate, post, context);
    const preObservations = [], postObservations = [];
    for (const operation of profile.operations) {
      preObservations.push({ id: operation.id, kind: operation.kind, value: await executeOperation(row.candidate, operation, pre, context) });
      postObservations.push({ id: operation.id, kind: operation.kind, value: await executeOperation(row.candidate, operation, post, context) });
    }
    perFamily.push({ pre, post, preObservations, postObservations });
  }
  if (canonical(perFamily[0]) !== canonical(perFamily[1])) fail('BOUNDARY_CROSS_FAMILY_DISAGREEMENT');
  const result = perFamily[0], preAnalysis = analyzeBlock(result.pre, result.preObservations, profile, 'pre'), postAnalysis = analyzeBlock(result.post, result.postObservations, profile, 'post');
  const observedBoundaryArithmeticMatch = preAnalysis.wrapperFormulaExact && preAnalysis.innerFormulaExact && preAnalysis.oraclePriceFormulaExact
    && postAnalysis.wrapperFormulaExact && postAnalysis.innerFormulaExact && postAnalysis.oraclePriceFormulaExact;
  const runtimeIdentityBaselineMatch = preAnalysis.runtimeIdentityBaselineMatch && postAnalysis.runtimeIdentityBaselineMatch;
  const marketParamsBaselineMatch = preAnalysis.marketParamsBaselineMatch && postAnalysis.marketParamsBaselineMatch;
  const expiryGetterMatch = preAnalysis.expiryGetterMatch && postAnalysis.expiryGetterMatch;
  const wrapperTimestampExact = preAnalysis.wrapperTimestampExact && postAnalysis.wrapperTimestampExact;
  const innerTimestampExact = preAnalysis.innerTimestampExact && postAnalysis.innerTimestampExact;
  const noFutureExternalFeed = preAnalysis.noFutureExternalFeed && postAnalysis.noFutureExternalFeed;
  const expiryTransitionMatch = preAnalysis.expiryTransitionMatch && postAnalysis.expiryTransitionMatch;
  const temporalSemanticMatch = wrapperTimestampExact && innerTimestampExact && noFutureExternalFeed && expiryTransitionMatch;
  return { ...result, analysis: { pre: preAnalysis, post: postAnalysis, observedBoundaryArithmeticMatch,
    wrapperTimestampExact, innerTimestampExact, noFutureExternalFeed, expiryTransitionMatch, temporalSemanticMatch,
    runtimeIdentityBaselineMatch, marketParamsBaselineMatch, expiryGetterMatch, sourceRuntimeBinding: 'unknown',
    formulaMatch: 'unknown', extraExpiryDiscontinuityObserved: 'unknown' } };
}
async function terminalRecheck(evidence, pin, boundary, context) {
  for (const row of evidence) {
    const finalized = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', ['finalized', false], context)); if (finalized.number < pin.number) fail('TERMINAL_FINALITY_RECHECK_FAILED');
    const exactPin = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(pin.number), false], context), pin.number); if (!sameHeader(exactPin, pin)) fail('TERMINAL_PIN_RECHECK_FAILED'); await multicallPin(row.candidate, pin, context);
    for (const expected of [boundary.pre, boundary.post]) { const exact = parseHeader(await rpc(row.candidate, 'eth_getBlockByNumber', [quantityHex(expected.number), false], context), expected.number); if (!sameHeader(exact, expected)) fail('TERMINAL_BOUNDARY_RECHECK_FAILED'); await multicallPin(row.candidate, expected, context); }
  }
}

function collectSensitiveStrings(candidates) {
  const values = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || value.length < 4) return;
    values.add(value.toLowerCase());
    try {
      const parsed = new URL(value);
      for (const part of [parsed.href, parsed.host, parsed.hostname, parsed.username, parsed.password, parsed.pathname, parsed.search,
        ...parsed.searchParams.keys(), ...parsed.searchParams.values()]) if (part && part.length >= 4) values.add(part.toLowerCase());
    } catch (_) {}
  };
  (function walk(value) {
    if (typeof value === 'string') return add(value);
    if (Array.isArray(value)) return value.forEach(walk);
    if (!object(value)) return;
    for (const item of Object.values(value)) walk(item);
  }(candidates));
  return values;
}
function assertSanitized(serialized, candidates) {
  if (/(?:https?|wss):\/\//iu.test(serialized) || /"(?:endpoint|provider|hostname|domain|inventory|operatorFamily|headers?)"\s*:/iu.test(serialized)) fail('OUTPUT_UNSAFE');
  const lower = serialized.toLowerCase();
  for (const value of collectSensitiveStrings(candidates)) if (lower.includes(value)) fail('OUTPUT_UNSAFE');
}

async function runGate({ profile, candidates, transport, clock = Date.now, limits: injectedLimits } = {}) {
  validateProfile(profile); const limits = resolveLimits(injectedLimits);
  if (!Array.isArray(candidates) || candidates.length < profile.candidatePolicy.minimum || candidates.length > Math.min(profile.candidatePolicy.maximum, limits.candidates) || typeof transport !== 'function') fail('INVOCATION_INVALID');
  const normalized = candidates.map(normalizeCandidate), budget = new base.Budget({ limits, clock }), context = { transport, budget, limits };
  const qualification = []; for (const candidate of normalized) qualification.push(await qualify(candidate, profile, context));
  const passing = qualification.filter((row) => row.ok); if (passing.length < 3) fail('THREE_QUALIFIED_CANDIDATES_REQUIRED');
  const common = await establishCommonPin(passing, context); assertFresh(profile, common.pin, clock());
  if (common.pin.timestamp < profile.boundary.expiryTimestamp) fail('POST_EXPIRY_NOT_FINALIZED');
  const evidence = selectEvidence(common.rows), evidenceCandidates = new Set(evidence.map((row) => row.candidate));
  const locator = rank(passing).find((row) => !evidenceCandidates.has(row.candidate)); if (!locator) fail('BOUNDARY_LOCATOR_UNAVAILABLE');
  const boundary = await captureBoundary(profile, evidence, locator, common.pin, context); await multicallPin(evidence[0].candidate, common.pin, context); await multicallPin(evidence[1].candidate, common.pin, context);
  await terminalRecheck(evidence, common.pin, boundary, context);
  const used = budget.summary(), maxCandidateRequests = Math.max(...normalized.map((row) => row.calls));
  const payload = { schema: SCHEMA, profile: profile.id, profileHash: digest(canonical(profile)), chainId: 1, generatedAt: new Date(clock()).toISOString(), status: 'PASS', pin: common.pin,
    qualification: { candidatesEvaluated: normalized.length, qualifiedCandidates: passing.length, authoritativeOperatorFamilyMetadata: true,
      distinctQualifiedOperatorFamilies: new Set(passing.map((row) => row.candidate.operatorFamily)).size, evidenceFamilyCount: 2, separateBoundaryLocatorUsed: true,
      selectionRule: 'CAPABILITY_PREMIUM_INVENTORY_ORDER', commonFinalizedAgreement: true, terminalPinAndBoundaryRecheck: true },
    boundary: { expiryTimestamp: profile.boundary.expiryTimestamp, readiness: 'OBSERVED_FINALIZED', preBlock: boundary.pre, postBlock: boundary.post,
      preObservations: boundary.preObservations, postObservations: boundary.postObservations, analysis: boundary.analysis },
    gates: { deployedOracleBoundaryObserved: true, protocolAccountingFlaw: 'unknown', routePositive: 'unknown', executableNow: 'unknown', economicsOpened: false, signedActionJustified: false, forkJustified: false },
    budgets: { limits: { ...limits }, used: { ...used, maxCandidateRequests } },
    safety: { readOnly: true, eip1898Canonical: true, twoAuthoritativeOperatorFamilies: true, separateBoundaryLocator: true, multicallPinValidated: true,
      boundaryTerminalRecheck: true, batches: false, traces: false, pendingState: false, stateOverrides: false, retries: 0, signing: false, transaction: false,
      productionMutation: false, endpointMaterialPersisted: false, endpointMaterialHashed: false, oneShotPublicationRequired: true } };
  const publicSerialized = `${JSON.stringify(payload, null, 2)}\n`; assertSanitized(publicSerialized, candidates);
  const artifact = { ...payload, integrity: { algorithm: 'sha256', payloadHash: digest(canonical(payload)) } }, serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  assertSanitized(serialized, candidates); if (Buffer.byteLength(serialized) > limits.artifactBytes) fail('ARTIFACT_BYTE_LIMIT');
  return { artifact, serialized };
}

module.exports = { SCHEMA, LIMITS, GateError, canonical, digest, resolveLimits, normalizeCandidate, validateProfile, decodeRound, validateOperationResult, expectedLinear, analyzeBlock, collectSensitiveStrings, assertSanitized, runGate };
