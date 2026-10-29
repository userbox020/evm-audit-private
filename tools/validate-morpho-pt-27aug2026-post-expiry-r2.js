#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'morpho-pt-27aug2026-post-expiry-r2/capture-v1';
const PROFILE = 'ethereum-morpho-pt-27aug2026-post-expiry-r1';
const EXPECTED_PROFILE_HASH = '91b3e1a5165000091a1f4e8379f6ec9e38959ee06821caf599f831227a75439c';
const EXPIRY = 1787788800;
const MAX_BYTES = 2 * 1024 * 1024;
const LIMITS = Object.freeze({ candidates: 4, requests: 223, requestsPerCandidate: 88, responseBytes: 16 * 1024 * 1024,
  responseBytesPerRequest: 2 * 1024 * 1024, concurrency: 1, perFamilyConcurrency: 1, requestMs: 10_000,
  wallMs: 120_000, logEntries: 1, artifactBytes: 2 * 1024 * 1024, retries: 0 });
const OPS = Object.freeze([
  ['morpho-market-apx', 'call', 'tuple6'], ['morpho-params-apx', 'call', 'baseline'],
  ['morpho-market-apy-discounted', 'call', 'tuple6'], ['morpho-params-apy-discounted', 'call', 'baseline'],
  ['morpho-market-apy-par', 'call', 'tuple6'], ['morpho-params-apy-par', 'call', 'baseline'],
  ['oracle-price-apx', 'call', 'positive'], ['oracle-price-apy-discounted', 'call', 'positive'], ['oracle-price-apy-par', 'call', 'positive'],
  ['round-apx-wrapper', 'call', 'round'], ['round-apy-wrapper', 'call', 'round'], ['round-apx-inner', 'call', 'round'], ['round-apy-inner', 'call', 'round'],
  ['round-underlying', 'call', 'round'], ['round-quote-discounted', 'call', 'round'], ['round-quote-par', 'call', 'round'],
  ['apx-pt-expiry', 'call', 'expiry'], ['apy-pt-expiry', 'call', 'expiry'],
  ['apx-pt-is-expired', 'call', 'bool'], ['apy-pt-is-expired', 'call', 'bool'], ['apx-yt-is-expired', 'call', 'bool'], ['apy-yt-is-expired', 'call', 'bool'],
  ['runtime-morpho', 'code', 'runtime'], ['runtime-apx-oracle', 'code', 'runtime'], ['runtime-apy-discounted-oracle', 'code', 'runtime'],
  ['runtime-apy-par-oracle', 'code', 'runtime'], ['runtime-apx-wrapper', 'code', 'runtime'], ['runtime-apy-wrapper', 'code', 'runtime'],
  ['runtime-apx-inner', 'code', 'runtime'], ['runtime-apy-inner', 'code', 'runtime'], ['runtime-apx-pt', 'code', 'runtime'], ['runtime-apy-pt', 'code', 'runtime'],
  ['runtime-apx-yt', 'code', 'runtime'], ['runtime-apy-yt', 'code', 'runtime'],
]);
const RUNTIMES = Object.freeze({
  'runtime-morpho': [15623, '0xfd5aa16eea01735e0e33e51e913a27f7d5ed998adc0cec2bf1f9ea368d9e1bdf'],
  'runtime-apx-oracle': [2598, '0x77d3d9cf08882f7b4a75ec0f0b671613d3bdc64a428e2f65ca52aaf3b2868a13'],
  'runtime-apy-discounted-oracle': [2598, '0x8016ec3412e86104edc7ba3c54c273b051a76f09725b427da0c31c9b39ea9f82'],
  'runtime-apy-par-oracle': [2598, '0x607400bb82dd741eb39b6bf817763d257580d2c245e8dc43d5d8d0828e11eafd'],
  'runtime-apx-wrapper': [923, '0x6751e331fcf1d4f73b33f26506dbf6dba5de95c56209601750273fa5e178895b'],
  'runtime-apy-wrapper': [923, '0x117f1336acbb025133de584cb70e51d16beca9a7e8ae014baa5c5368f52a8ee4'],
  'runtime-apx-inner': [951, '0xcacf50327e8f619877c4e9e04decc2da221d59fef0615cec038fac1068a1eda7'],
  'runtime-apy-inner': [951, '0x30dc9484f2544c2cb65fb2262a59a1b401ec3aafd5043073502b13f4013e5e84'],
  'runtime-apx-pt': [5858, '0xe769be83c12cd110b249a594697787eb3f80ead0ca00a84e3e8365ed257178d6'],
  'runtime-apy-pt': [5858, '0x386af811cd521bf67b81d7dedde04e0149a410768f5aecf5841a35694cef1d81'],
  'runtime-apx-yt': [19330, '0xde2050e865c6e51994d3130b7ace422248f0ae253421b082e091926c3d2f039c'],
  'runtime-apy-yt': [19330, '0x000e199cfb83ad9cc8366b927d85bc7f24f206a4c410d564139201fc25928b76'],
});
const PARAM_ADDRESSES = Object.freeze({
  loanToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc',
  apxPt: '0xd28b0d694b8e814fa905a8b480b30691e18396eb', apyPt: '0xee5c7cda577484b70b65c21235ecbd302bb290e2',
  apxOracle: '0x5a25dd4c2fcb3f260407102eff711f54e22d5408', apyDiscountedOracle: '0x2c0a8c81d61529bc08e0a4f780d098c8595c9158',
  apyParOracle: '0x60c98189f7c21540d4a3b8aeade5d5d0aac82aa0',
});
const addressWord = (value) => value.slice(2).padStart(64, '0');
const uintWord = (value) => BigInt(value).toString(16).padStart(64, '0');
const paramsRaw = (collateral, oracle) => `0x${addressWord(PARAM_ADDRESSES.loanToken)}${addressWord(collateral)}${addressWord(oracle)}${addressWord(PARAM_ADDRESSES.irm)}${uintWord(860000000000000000n)}`;
const PARAMS = Object.freeze({
  'morpho-params-apx': paramsRaw(PARAM_ADDRESSES.apxPt, PARAM_ADDRESSES.apxOracle),
  'morpho-params-apy-discounted': paramsRaw(PARAM_ADDRESSES.apyPt, PARAM_ADDRESSES.apyDiscountedOracle),
  'morpho-params-apy-par': paramsRaw(PARAM_ADDRESSES.apyPt, PARAM_ADDRESSES.apyParOracle),
});
const TOP = ['schema', 'profile', 'profileHash', 'chainId', 'generatedAt', 'status', 'pin', 'qualification', 'boundary', 'gates', 'budgets', 'safety', 'integrity'];

class ValidationError extends Error { constructor(code) { super(code); this.name = 'ValidationError'; this.code = code; } }
function check(value, code) { if (!value) throw new ValidationError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, code) { check(object(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys), code); }
function uint(value, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function hex(value, bytes = null) { return typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/u.test(value) && (bytes === null || value.length === 2 + bytes * 2); }
function canonical(value) { if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; check(object(value), 'SERIALIZATION'); return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function header(value, code) { exact(value, ['number', 'hash', 'parentHash', 'stateRoot', 'timestamp'], `${code}_SCHEMA`); check(uint(value.number) && value.number > 0 && hex(value.hash, 32) && hex(value.parentHash, 32) && hex(value.stateRoot, 32) && uint(value.timestamp), `${code}_VALUE`); }
function round(value) {
  check(hex(value) && value.length === 2 + 5 * 64, 'ROUND'); const words = Array.from({ length: 5 }, (_, i) => BigInt(`0x${value.slice(2 + i * 64, 2 + (i + 1) * 64)}`));
  const answer = words[1] >= 1n << 255n ? words[1] - (1n << 256n) : words[1]; check(answer > 0n, 'ROUND_ANSWER');
  return { roundId: words[0], answer, startedAt: words[2], updatedAt: words[3], answeredInRound: words[4] };
}
function validateValue(id, type, value) {
  if (type === 'tuple6') return check(hex(value) && value.length === 2 + 6 * 64, 'VALUE_TUPLE');
  if (type === 'baseline') { exact(value, ['raw', 'baselineMatch'], 'VALUE_BASELINE_SCHEMA'); const expected = PARAMS[id]; check(hex(value.raw, 160) && typeof value.baselineMatch === 'boolean' && typeof expected === 'string' && value.baselineMatch === (value.raw === expected), 'VALUE_BASELINE'); return; }
  if (type === 'round') return void round(value);
  if (type === 'runtime') { exact(value, ['bytes', 'sha256', 'baselineMatch'], 'VALUE_RUNTIME_SCHEMA'); const expected = RUNTIMES[id]; check(uint(value.bytes) && /^0x[0-9a-f]{64}$/u.test(value.sha256) && typeof value.baselineMatch === 'boolean' && value.baselineMatch === (value.bytes === expected[0] && value.sha256 === expected[1]), 'VALUE_RUNTIME'); return; }
  if (type === 'expiry') { exact(value, ['raw', 'expectedMatch'], 'VALUE_EXPIRY_SCHEMA'); check(hex(value.raw, 32) && typeof value.expectedMatch === 'boolean' && value.expectedMatch === (BigInt(value.raw) === BigInt(EXPIRY)), 'VALUE_EXPIRY'); return; }
  check(hex(value, 32), 'VALUE_WORD'); const n = BigInt(value); if (type === 'positive') check(n > 0n, 'VALUE_POSITIVE'); else if (type === 'bool') check(n === 0n || n === 1n, 'VALUE_BOOL'); else check(false, 'VALUE_TYPE');
}
function observations(rows, code) {
  check(Array.isArray(rows) && rows.length === OPS.length, `${code}_COUNT`);
  for (let i = 0; i < OPS.length; i++) { const row = rows[i], expected = OPS[i]; exact(row, ['id', 'kind', 'value'], `${code}_SCHEMA`); check(row.id === expected[0] && row.kind === expected[1], `${code}_ORDER`); validateValue(expected[0], expected[2], row.value); }
}
function map(rows) { return new Map(rows.map((row) => [row.id, row.value])); }
function raw(value) { return BigInt(object(value) ? value.raw : value); }
function recompute(block, rows, side) {
  const values = map(rows), one = 1000000000000000000n, time = BigInt(block.timestamp), linear = time >= BigInt(EXPIRY) ? one : one - ((BigInt(EXPIRY) - time) * 200000000000000000n) / 31536000n;
  const r = {}; for (const id of ['apx-wrapper', 'apy-wrapper', 'apx-inner', 'apy-inner', 'underlying', 'quote-discounted', 'quote-par']) r[id] = round(values.get(`round-${id}`));
  const expected = { apx: r['apx-wrapper'].answer * r.underlying.answer / r['quote-discounted'].answer,
    apyDiscounted: r['apy-wrapper'].answer * r.underlying.answer / r['quote-discounted'].answer,
    apyPar: r['apy-wrapper'].answer * r.underlying.answer / r['quote-par'].answer };
  return { timestamp: block.timestamp, expectedLinearAnswer: linear.toString(), rounds: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([x, y]) => [x, y.toString()]))])),
    expectedOraclePrices: Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, v.toString()])),
    wrapperFormulaExact: r['apx-wrapper'].answer === linear && r['apy-wrapper'].answer === linear,
    innerFormulaExact: r['apx-inner'].answer === linear && r['apy-inner'].answer === linear,
    wrapperTimestampExact: r['apx-wrapper'].updatedAt === time && r['apy-wrapper'].updatedAt === time,
    innerTimestampExact: r['apx-inner'].updatedAt === 0n && r['apy-inner'].updatedAt === 0n,
    noFutureExternalFeed: ['underlying', 'quote-discounted', 'quote-par'].every((id) => r[id].updatedAt <= time),
    oraclePriceFormulaExact: raw(values.get('oracle-price-apx')) === expected.apx && raw(values.get('oracle-price-apy-discounted')) === expected.apyDiscounted && raw(values.get('oracle-price-apy-par')) === expected.apyPar,
    expiryGetterMatch: ['apx-pt-expiry', 'apy-pt-expiry'].every((id) => values.get(id).expectedMatch === true),
    expiryTransitionMatch: ['apx-pt-is-expired', 'apy-pt-is-expired', 'apx-yt-is-expired', 'apy-yt-is-expired'].every((id) => (raw(values.get(id)) === 1n) === (side === 'post')),
    marketParamsBaselineMatch: ['morpho-params-apx', 'morpho-params-apy-discounted', 'morpho-params-apy-par'].every((id) => values.get(id).baselineMatch === true),
    runtimeIdentityBaselineMatch: rows.filter((row) => row.kind === 'code').every((row) => row.value.baselineMatch === true) };
}
function deriveAnalysis(preBlock, preRows, postBlock, postRows) {
  const pre = recompute(preBlock, preRows, 'pre'), post = recompute(postBlock, postRows, 'post');
  const observedBoundaryArithmeticMatch = pre.wrapperFormulaExact && pre.innerFormulaExact && pre.oraclePriceFormulaExact
    && post.wrapperFormulaExact && post.innerFormulaExact && post.oraclePriceFormulaExact;
  const wrapperTimestampExact = pre.wrapperTimestampExact && post.wrapperTimestampExact;
  const innerTimestampExact = pre.innerTimestampExact && post.innerTimestampExact;
  const noFutureExternalFeed = pre.noFutureExternalFeed && post.noFutureExternalFeed;
  const expiryTransitionMatch = pre.expiryTransitionMatch && post.expiryTransitionMatch;
  return { pre, post, observedBoundaryArithmeticMatch, wrapperTimestampExact, innerTimestampExact, noFutureExternalFeed,
    expiryTransitionMatch, temporalSemanticMatch: wrapperTimestampExact && innerTimestampExact && noFutureExternalFeed && expiryTransitionMatch,
    runtimeIdentityBaselineMatch: pre.runtimeIdentityBaselineMatch && post.runtimeIdentityBaselineMatch,
    marketParamsBaselineMatch: pre.marketParamsBaselineMatch && post.marketParamsBaselineMatch,
    expiryGetterMatch: pre.expiryGetterMatch && post.expiryGetterMatch, sourceRuntimeBinding: 'unknown', formulaMatch: 'unknown',
    extraExpiryDiscontinuityObserved: 'unknown' };
}
function noUnsafe(text, value) {
  check(!/(?:https?|wss):\/\//iu.test(text) && !/\b(?:authorization|bearer|api[_-]?key|credential|private[_-]?key)\b/iu.test(text), 'UNSAFE');
  const forbidden = /(?:endpoint|provider|hostname|domain|inventory|operatorFamily|familyName|familyHash|headers?)/iu, allowed = new Set(['endpointMaterialPersisted', 'endpointMaterialHashed', 'authoritativeOperatorFamilyMetadata', 'distinctQualifiedOperatorFamilies', 'evidenceFamilyCount', 'twoAuthoritativeOperatorFamilies']);
  (function walk(node) { if (Array.isArray(node)) return node.forEach(walk); if (!object(node)) return; for (const [key, item] of Object.entries(node)) { check(allowed.has(key) || !forbidden.test(key), 'UNSAFE_KEY'); walk(item); } }(value));
}

function validateArtifact(value, { now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  exact(value, TOP, 'TOP'); check(value.schema === SCHEMA && value.profile === PROFILE && value.profileHash === EXPECTED_PROFILE_HASH && value.chainId === 1 && value.status === 'PASS', 'IDENTITY'); noUnsafe(JSON.stringify(value), value);
  const generated = Date.parse(value.generatedAt); check(Number.isFinite(generated) && new Date(generated).toISOString() === value.generatedAt && generated <= now + 60000 && generated >= now - maxAgeMs, 'GENERATED_AT');
  header(value.pin, 'PIN'); const nowSec = Math.floor(now / 1000); check(value.pin.timestamp >= nowSec - 3600 && value.pin.timestamp <= nowSec + 60, 'PIN_FRESHNESS');
  exact(value.qualification, ['candidatesEvaluated', 'qualifiedCandidates', 'authoritativeOperatorFamilyMetadata', 'distinctQualifiedOperatorFamilies', 'evidenceFamilyCount', 'separateBoundaryLocatorUsed', 'selectionRule', 'commonFinalizedAgreement', 'terminalPinAndBoundaryRecheck'], 'QUALIFICATION_SCHEMA');
  check(uint(value.qualification.candidatesEvaluated, 4) && value.qualification.candidatesEvaluated >= 3 && uint(value.qualification.qualifiedCandidates, value.qualification.candidatesEvaluated) && value.qualification.qualifiedCandidates >= 3
    && value.qualification.authoritativeOperatorFamilyMetadata === true && uint(value.qualification.distinctQualifiedOperatorFamilies, value.qualification.qualifiedCandidates) && value.qualification.distinctQualifiedOperatorFamilies >= 2
    && value.qualification.evidenceFamilyCount === 2 && value.qualification.separateBoundaryLocatorUsed === true && value.qualification.selectionRule === 'CAPABILITY_PREMIUM_INVENTORY_ORDER'
    && value.qualification.commonFinalizedAgreement === true && value.qualification.terminalPinAndBoundaryRecheck === true, 'QUALIFICATION');
  exact(value.boundary, ['expiryTimestamp', 'readiness', 'preBlock', 'postBlock', 'preObservations', 'postObservations', 'analysis'], 'BOUNDARY_SCHEMA'); check(value.boundary.expiryTimestamp === EXPIRY && value.boundary.readiness === 'OBSERVED_FINALIZED', 'BOUNDARY_STATUS');
  header(value.boundary.preBlock, 'PRE'); header(value.boundary.postBlock, 'POST'); check(value.boundary.postBlock.number === value.boundary.preBlock.number + 1 && value.boundary.postBlock.parentHash === value.boundary.preBlock.hash && value.boundary.preBlock.timestamp < EXPIRY && value.boundary.postBlock.timestamp >= EXPIRY && value.boundary.postBlock.number <= value.pin.number, 'BOUNDARY_LINK');
  observations(value.boundary.preObservations, 'PRE_OBSERVATIONS'); observations(value.boundary.postObservations, 'POST_OBSERVATIONS');
  const analysis = deriveAnalysis(value.boundary.preBlock, value.boundary.preObservations, value.boundary.postBlock, value.boundary.postObservations);
  check(canonical(value.boundary.analysis) === canonical(analysis), 'ANALYSIS');
  exact(value.gates, ['deployedOracleBoundaryObserved', 'protocolAccountingFlaw', 'routePositive', 'executableNow', 'economicsOpened', 'signedActionJustified', 'forkJustified'], 'GATES_SCHEMA'); check(canonical(value.gates) === canonical({ deployedOracleBoundaryObserved: true, protocolAccountingFlaw: 'unknown', routePositive: 'unknown', executableNow: 'unknown', economicsOpened: false, signedActionJustified: false, forkJustified: false }), 'GATES');
  exact(value.budgets, ['limits', 'used'], 'BUDGET_SCHEMA'); check(canonical(value.budgets.limits) === canonical(LIMITS), 'LIMITS'); exact(value.budgets.used, ['requests', 'responseBytes', 'maxConcurrency', 'maxPerFamilyConcurrency', 'elapsedMs', 'retries', 'maxCandidateRequests'], 'USED_SCHEMA');
  const used = value.budgets.used; check(uint(used.requests, LIMITS.requests) && used.requests > 0 && uint(used.responseBytes, LIMITS.responseBytes) && uint(used.maxConcurrency, LIMITS.concurrency) && used.maxConcurrency >= 1 && used.maxPerFamilyConcurrency === 1 && uint(used.elapsedMs, LIMITS.wallMs) && used.retries === 0 && uint(used.maxCandidateRequests, LIMITS.requestsPerCandidate), 'USED');
  exact(value.safety, ['readOnly', 'eip1898Canonical', 'twoAuthoritativeOperatorFamilies', 'separateBoundaryLocator', 'multicallPinValidated', 'boundaryTerminalRecheck', 'batches', 'traces', 'pendingState', 'stateOverrides', 'retries', 'signing', 'transaction', 'productionMutation', 'endpointMaterialPersisted', 'endpointMaterialHashed', 'oneShotPublicationRequired'], 'SAFETY_SCHEMA');
  check(canonical(value.safety) === canonical({ readOnly: true, eip1898Canonical: true, twoAuthoritativeOperatorFamilies: true, separateBoundaryLocator: true, multicallPinValidated: true, boundaryTerminalRecheck: true, batches: false, traces: false, pendingState: false, stateOverrides: false, retries: 0, signing: false, transaction: false, productionMutation: false, endpointMaterialPersisted: false, endpointMaterialHashed: false, oneShotPublicationRequired: true }), 'SAFETY');
  exact(value.integrity, ['algorithm', 'payloadHash'], 'INTEGRITY_SCHEMA'); check(value.integrity.algorithm === 'sha256' && /^[0-9a-f]{64}$/u.test(value.integrity.payloadHash), 'INTEGRITY'); const payload = { ...value }; delete payload.integrity; check(digest(canonical(payload)) === value.integrity.payloadHash, 'INTEGRITY_MISMATCH'); return value;
}
function parseSerialized(serialized, options = {}) { check(typeof serialized === 'string' && Buffer.byteLength(serialized) <= MAX_BYTES && serialized.endsWith('\n'), 'SERIALIZED'); let value; try { value = JSON.parse(serialized); } catch (_) { throw new ValidationError('JSON'); } check(`${JSON.stringify(value, null, 2)}\n` === serialized, 'CANONICAL_JSON'); return validateArtifact(value, options); }
function validateFile(filePath, { fsOps = fs, ...options } = {}) {
  check(typeof filePath === 'string' && path.isAbsolute(filePath), 'PATH'); let stat; try { stat = fsOps.lstatSync(filePath); } catch (_) { throw new ValidationError('MISSING'); } check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES, 'FILE');
  let fd; try { fd = fsOps.openSync(filePath, 'r'); const before = fsOps.fstatSync(fd), bytes = fsOps.readFileSync(fd), after = fsOps.fstatSync(fd); check(Buffer.isBuffer(bytes) && before.isFile() && bytes.length === before.size && before.size === after.size && before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs, 'FILE_CHANGED'); let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { throw new ValidationError('UTF8'); } return parseSerialized(text, options); } finally { if (fd !== undefined) try { fsOps.closeSync(fd); } catch (_) {} }
}

if (require.main === module) { try { if (process.argv.length !== 3) throw new ValidationError('ARGS'); validateFile(path.resolve(process.argv[2])); process.stdout.write('MORPHO_PT_POST_EXPIRY_R2_VALID\n'); } catch (error) { process.stderr.write(`MORPHO_PT_POST_EXPIRY_R2_INVALID_${error instanceof ValidationError ? error.code : 'INTERNAL'}\n`); process.exitCode = 1; } }

module.exports = { SCHEMA, PROFILE, EXPECTED_PROFILE_HASH, EXPIRY, LIMITS, OPS, RUNTIMES, PARAMS, ValidationError, canonical, digest, round, recompute, deriveAnalysis, validateArtifact, parseSerialized, validateFile };
