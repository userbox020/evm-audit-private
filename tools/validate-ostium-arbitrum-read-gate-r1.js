#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'ostium-arbitrum-read-gate-r1-artifact/v1';
const PROFILE_HASH = 'f3120c3a69b4fc885fa341cb02f0ae50111f5a9338ee04be2121ddf5d5c66e7e';
const TEMP_ROOT = path.resolve(String.raw`C:\Users\MiPC\AppData\Local\Temp\opencode`);
const MAX_FILE_BYTES = 256 * 1024;
const LIMITS = Object.freeze({ candidates: 8, requests: 256, requestsPerCandidate: 64, responseBytes: 32 * 1024 * 1024,
  responseBytesPerRequest: 2 * 1024 * 1024, requestMs: 10_000, wallMs: 120_000, concurrency: 4,
  perOperatorConcurrency: 1, artifactBytes: 256 * 1024, retries: 0 });
const RUNTIMES = Object.freeze({
  VAULT_IMPLEMENTATION_AT_PIN: Object.freeze({ length: 19458, keccak256: '0x1bd515c60cb848674f139d52bce3e9b8790f16751629369d3a7662c3e9f6bf1f' }),
  REGISTRY: Object.freeze({ length: 3175, keccak256: '0x57eecf2cb6dd034155b67edbbe8d6ed1c7c2b75ca2d3b6f184e8245177b51fe9' }),
  OPEN_PNL_IMPLEMENTATION_AT_PIN: Object.freeze({ length: 4381, keccak256: '0xfbfabb38b4c57a1fa633e307dfc432ed48943007b1882050d58af53d73e6e8a0' }),
});
const ROLES = Object.freeze(['VAULT_PROXY', 'VAULT_IMPLEMENTATION_AT_PIN', 'REGISTRY', 'OPEN_PNL_PROXY', 'OPEN_PNL_IMPLEMENTATION_AT_PIN', 'ASSET']);
const LINKS = Object.freeze([
  Object.freeze({ from: 'VAULT_PROXY', relation: 'REGISTRY', to: 'REGISTRY' }),
  Object.freeze({ from: 'VAULT_PROXY', relation: 'ASSET', to: 'ASSET' }),
  Object.freeze({ from: 'REGISTRY', relation: 'VAULT', to: 'VAULT_PROXY' }),
  Object.freeze({ from: 'REGISTRY', relation: 'OPEN_PNL', to: 'OPEN_PNL_PROXY' }),
  Object.freeze({ from: 'OPEN_PNL_PROXY', relation: 'REGISTRY', to: 'REGISTRY' }),
]);
const key = (value) => `0x${Buffer.from(value, 'utf8').toString('hex').padEnd(64, '0')}`;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const call = (id, role, selector, result, extra = {}) => ({ id, role, method: 'eth_call', selector, ...extra, result });
const EXPECTED_PROFILE = Object.freeze({
  schema: 'ostium-arbitrum-read-gate-r1-profile/v1', id: 'ostium-arbitrum-read-gate-r1', version: 1,
  productionEnabled: false, chainId: 42161,
  pin: { mode: 'finalized', maxAgeSeconds: 3600, futureSkewSeconds: 60 },
  slots: { implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103', beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' },
  selectors: { registry: '0x7b103999', asset: '0x38d52e0f', lastSettlementId: '0x39598fae', lastSettlementTs: '0x5ae45c26', lastSettlementOpenPnl: '0xaa8c9b6a', getContractAddress: '0x0d2020dd', getOpenPnlWithRollover: '0x807949e9', decimals: '0x313ce567' },
  registryKeys: { vault: key('vault'), openPnl: key('openPnl') },
  runtimes: { VAULT_IMPLEMENTATION_AT_PIN: { ...RUNTIMES.VAULT_IMPLEMENTATION_AT_PIN }, REGISTRY: { ...RUNTIMES.REGISTRY }, OPEN_PNL_IMPLEMENTATION_AT_PIN: { ...RUNTIMES.OPEN_PNL_IMPLEMENTATION_AT_PIN } },
  authority: { productionProxyRuntimeAuthority: 'ABSENT_P0', VAULT_IMPLEMENTATION_AT_PIN: 'R3_BEHAVIORAL_AND_BUILD', REGISTRY: 'BUILD_CLOSURE_ONLY', OPEN_PNL_IMPLEMENTATION_AT_PIN: 'BUILD_CLOSURE_ONLY' },
  localModel: {
    repository: { commit: '8390ce497f68fb128900840e0ec30683afa945d3', tree: 'aa149b0ed98e742a9de21aeb1c8d9ebf305d2612' },
    compiler: { version: '0.8.24', longVersion: '0.8.24+commit.e11b9ed9', executableSha256: '580ee56b61bbcaad953117e1e4a0874d90e6af5cb4ce4359571d7da25f6620e9', optimizerEnabled: true, optimizerRuns: 200, viaIR: true, evmVersion: 'paris' },
    buildInfo: { path: 'targets/ostium/artifacts/build-info/e2a08f99c05f7268422dd3a2bdac7ed1.json', sha256: '8a1e8ada63299b9d215d97f9ecaf570d048e67618b2f252f1e7e95b20468bdd9' },
    artifacts: {
      VAULT_IMPLEMENTATION_AT_PIN: { path: 'targets/ostium/artifacts/src/OstiumVault.sol/OstiumVault.json', sha256: 'f23b615df68d00c7435f1ecd4fe179e706bf30286c21ca02759ab29c98fa3948' },
      REGISTRY: { path: 'targets/ostium/artifacts/src/OstiumRegistry.sol/OstiumRegistry.json', sha256: 'b551e481c390ccc508f509c4fc366c18cb7c60f25a3e9a5e0785df5a5a0c08b8' },
      OPEN_PNL_IMPLEMENTATION_AT_PIN: { path: 'targets/ostium/artifacts/src/OstiumOpenPnl.sol/OstiumOpenPnl.json', sha256: '215dc1f4311d888f4eebcc75e4114265055b87a17d7ec78e464b423dd8b8d65f' },
    },
    sources: { 'src/OstiumVault.sol': '9aefa6ed131cdaf6360c5330980b5e04a36f345b499aa26d79cdebb0da2d1805', 'src/interfaces/IOstiumVault.sol': '5eec4cb334f8c78837afbd539abf60309adc896abf246c2cbdf4cf35b32cf3d0', 'src/OstiumRegistry.sol': 'd9502b0fbec84f84170da544d1661dca558aeed7d255105fe5ee1e63bd5f7270', 'src/interfaces/IOstiumRegistry.sol': '0ce2452ebef81f2cc35c8c317cbe49c6712709a72990217675e808a6dba33a76', 'src/OstiumOpenPnl.sol': '5f70c63f31b9fa065f42e4149ed57920a937bf4ddf1d4952eec174b3884ff850', 'src/interfaces/IOstiumOpenPnl.sol': '937cd8437e6f4508e399ff59425d76711f62af40fec3cac42ffdba367a1fa34e' },
    astTripwires: ['OstiumVault', 'tryNewSettlement', '_getOpenPnlDelta', '_executeAsyncDepositWithdraw', '_applyMMCashflow', 'mmDeposit', 'mmWithdraw'],
  },
  roles: [...ROLES],
  operations: [
    { id: 1, role: 'VAULT_PROXY', method: 'eth_getCode', result: 'proxyCode' },
    { id: 2, role: 'VAULT_PROXY', method: 'eth_getStorageAt', slot: 'implementation', result: 'roleAddress:VAULT_IMPLEMENTATION_AT_PIN' },
    { id: 3, role: 'VAULT_PROXY', method: 'eth_getStorageAt', slot: 'admin', result: 'proxyAdmin' },
    { id: 4, role: 'VAULT_PROXY', method: 'eth_getStorageAt', slot: 'beacon', result: 'zeroWord' },
    { id: 5, role: 'VAULT_IMPLEMENTATION_AT_PIN', method: 'eth_getCode', result: 'runtime:VAULT_IMPLEMENTATION_AT_PIN' },
    call(6, 'VAULT_PROXY', 'registry', 'roleAddress:REGISTRY'), call(7, 'VAULT_PROXY', 'asset', 'roleAddress:ASSET'),
    call(8, 'VAULT_PROXY', 'lastSettlementId', 'uint32:lastSettlementId'), call(9, 'VAULT_PROXY', 'lastSettlementTs', 'uint32:lastSettlementTs'),
    call(10, 'VAULT_PROXY', 'lastSettlementOpenPnl', 'int256:lastSettlementOpenPnl'),
    { id: 11, role: 'REGISTRY', method: 'eth_getCode', result: 'runtime:REGISTRY' },
    call(12, 'REGISTRY', 'getContractAddress', 'roleAddress:VAULT_PROXY', { key: 'vault' }),
    call(13, 'REGISTRY', 'getContractAddress', 'roleAddress:OPEN_PNL_PROXY', { key: 'openPnl' }),
    { id: 14, role: 'OPEN_PNL_PROXY', method: 'eth_getCode', result: 'proxyCode' },
    { id: 15, role: 'OPEN_PNL_PROXY', method: 'eth_getStorageAt', slot: 'implementation', result: 'roleAddress:OPEN_PNL_IMPLEMENTATION_AT_PIN' },
    { id: 16, role: 'OPEN_PNL_PROXY', method: 'eth_getStorageAt', slot: 'admin', result: 'proxyAdmin' },
    { id: 17, role: 'OPEN_PNL_PROXY', method: 'eth_getStorageAt', slot: 'beacon', result: 'zeroWord' },
    { id: 18, role: 'OPEN_PNL_IMPLEMENTATION_AT_PIN', method: 'eth_getCode', result: 'runtime:OPEN_PNL_IMPLEMENTATION_AT_PIN' },
    call(19, 'OPEN_PNL_PROXY', 'registry', 'roleAddress:REGISTRY'), call(20, 'OPEN_PNL_PROXY', 'getOpenPnlWithRollover', 'int256:openPnlWithRollover'),
    call(21, 'ASSET', 'decimals', 'uint8Exact:6'),
  ],
});
const TOP_KEYS = Object.freeze(['schema', 'profileHash', 'status', 'productionEnabled', 'chainId', 'generatedAt', 'authority', 'pin', 'qualification', 'roles', 'links', 'sentinels', 'assetDecimals', 'budgets', 'safety', 'claims', 'integrity']);
const PROXY_CATEGORIES = new Set(['TEST_MODEL_ERC1967_TRANSPARENT_ADMIN_NONZERO', 'TEST_MODEL_ERC1967_TRANSPARENT_ADMIN_EXACT', 'TEST_MODEL_ERC1967_UUPS_ADMIN_ZERO', 'TEST_MODEL_ERC1967_UUPS_ADMIN_EXACT']);

class ValidationError extends Error { constructor(code) { super(code); this.name = 'ValidationError'; this.code = code; } }
function check(value, code) { if (!value) throw new ValidationError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, code) { check(object(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys), code); }
function uint(value, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function hex(value, bytes = null) { return typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/u.test(value) && (bytes === null || value.length === 2 + bytes * 2); }
function canonical(value) { if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; check(object(value), 'SERIALIZATION'); return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function parseDecimal(value, signed, code) { check(typeof value === 'string' && (signed ? /^-?(?:0|[1-9]\d*)$/u : /^(?:0|[1-9]\d*)$/u).test(value), code); try { return BigInt(value); } catch (_) { throw new ValidationError(code); } }
function validateHeader(value) { exact(value, ['number', 'hash', 'parentHash', 'stateRoot', 'timestamp'], 'PIN_SCHEMA'); check(uint(value.number) && value.number > 0 && hex(value.hash, 32) && hex(value.parentHash, 32) && hex(value.stateRoot, 32) && uint(value.timestamp), 'PIN_VALUE'); }
function noForbidden(value) {
  const text = JSON.stringify(value); check(!/(?:https?|wss):\/\//iu.test(text) && !/0x[0-9a-f]{40}(?![0-9a-f])/u.test(text), 'FORBIDDEN_VALUE');
  check(!/(?:^|["\s])(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:["\s]|$)/iu.test(text), 'FORBIDDEN_DOMAIN');
  const forbidden = /(?:endpoint|url|uri|domain|hostname|provider|operator|family|inventory|credential|headers?|token|raw|implementationword|adminword|bytecode)/iu;
  const approved = new Set(['distinctOperators', 'selectedOperators', 'perOperatorConcurrency', 'maxPerOperatorConcurrency', 'endpointMaterialPersisted', 'endpointMaterialHashed']);
  (function walk(node) { if (Array.isArray(node)) return node.forEach(walk); if (!object(node)) return; for (const [name, item] of Object.entries(node)) { check(!forbidden.test(name) || approved.has(name), 'FORBIDDEN_KEY'); walk(item); } }(value));
}
function validateArtifact(value, { now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  check(sha256(canonical(EXPECTED_PROFILE)) === PROFILE_HASH, 'VALIDATOR_PROFILE_DRIFT'); exact(value, TOP_KEYS, 'TOP_SCHEMA'); noForbidden(value);
  check(value.schema === SCHEMA && value.profileHash === PROFILE_HASH && value.status === 'PASS_TEST_ONLY' && value.productionEnabled === false && value.chainId === 42161, 'IDENTITY');
  const generated = Date.parse(value.generatedAt); check(Number.isFinite(generated) && new Date(generated).toISOString() === value.generatedAt && generated <= now + 60_000 && generated >= now - maxAgeMs, 'GENERATED_AT');
  exact(value.authority, ['id', 'canonicalCommitment'], 'AUTHORITY_SCHEMA'); check(/^[A-Z0-9_]{3,64}$/u.test(value.authority.id) && /^[0-9a-f]{64}$/u.test(value.authority.canonicalCommitment), 'AUTHORITY_VALUE'); validateHeader(value.pin);
  check(value.pin.timestamp >= Math.floor(generated / 1000) - EXPECTED_PROFILE.pin.maxAgeSeconds && value.pin.timestamp <= Math.floor(generated / 1000) + EXPECTED_PROFILE.pin.futureSkewSeconds, 'PIN_FRESHNESS');
  exact(value.qualification, ['candidatesEvaluated', 'qualifiedCandidates', 'capabilityEvidencePerQualifiedCandidate', 'distinctOperators', 'selectionRule', 'selectedOperators', 'allCandidatesQualifiedBeforeSelection', 'selectedCommonPinMulticallBeforeMaterial', 'replacementAfterMaterialFailure', 'terminalRecheck'], 'QUALIFICATION_SCHEMA');
  check(uint(value.qualification.candidatesEvaluated, LIMITS.candidates) && value.qualification.candidatesEvaluated >= 2 && uint(value.qualification.qualifiedCandidates, value.qualification.candidatesEvaluated) && value.qualification.qualifiedCandidates >= 2 && value.qualification.capabilityEvidencePerQualifiedCandidate === 3 && uint(value.qualification.distinctOperators, value.qualification.qualifiedCandidates) && value.qualification.distinctOperators >= 2 && value.qualification.selectionRule === 'CAPABILITY_PREMIUM_INVENTORY_ORDER' && value.qualification.selectedOperators === 2 && value.qualification.allCandidatesQualifiedBeforeSelection === true && value.qualification.selectedCommonPinMulticallBeforeMaterial === true && value.qualification.replacementAfterMaterialFailure === false && value.qualification.terminalRecheck === true, 'QUALIFICATION_VALUE');
  check(Array.isArray(value.roles) && value.roles.length === ROLES.length, 'ROLES_COUNT'); for (let i = 0; i < ROLES.length; i++) { const row = value.roles[i]; exact(row, ['role', 'category', 'codeLength', 'codeKeccak256'], 'ROLE_SCHEMA'); check(row.role === ROLES[i], 'ROLE_ORDER'); if (row.role === 'VAULT_PROXY' || row.role === 'OPEN_PNL_PROXY') check(PROXY_CATEGORIES.has(row.category) && uint(row.codeLength) && row.codeLength > 0 && /^0x[0-9a-f]{64}$/u.test(row.codeKeccak256), 'PROXY_ROLE'); else if (row.role === 'ASSET') check(row.category === 'LINKED_ASSET_DECIMALS_6' && row.codeLength === null && row.codeKeccak256 === null, 'ASSET_ROLE'); else { const expected = RUNTIMES[row.role], category = row.role === 'VAULT_IMPLEMENTATION_AT_PIN' ? 'R3_BEHAVIORAL_AND_BUILD' : row.role === 'REGISTRY' ? 'DIRECT_BUILD_CLOSURE_ONLY' : 'BUILD_CLOSURE_ONLY'; check(row.category === category && row.codeLength === expected.length && row.codeKeccak256 === expected.keccak256, 'FIXED_RUNTIME_ROLE'); } }
  check(JSON.stringify(value.links) === JSON.stringify(LINKS), 'LINKS'); exact(value.sentinels, ['lastSettlementId', 'lastSettlementTs', 'lastSettlementOpenPnl', 'openPnlWithRollover'], 'SENTINELS_SCHEMA'); const settlementId = parseDecimal(value.sentinels.lastSettlementId, false, 'SETTLEMENT_ID'), settlementTs = parseDecimal(value.sentinels.lastSettlementTs, false, 'SETTLEMENT_TS'), min = -(1n << 255n), max = (1n << 255n) - 1n; check(settlementId <= 0xffffffffn && settlementTs <= 0xffffffffn && settlementTs <= BigInt(value.pin.timestamp), 'SENTINEL_UINT32'); for (const name of ['lastSettlementOpenPnl', 'openPnlWithRollover']) { const number = parseDecimal(value.sentinels[name], true, 'SENTINEL_INT256'); check(number >= min && number <= max, 'SENTINEL_INT256'); } check(value.assetDecimals === 6, 'ASSET_DECIMALS');
  exact(value.budgets, ['limits', 'used'], 'BUDGETS_SCHEMA'); check(JSON.stringify(Object.keys(value.budgets.limits)) === JSON.stringify(Object.keys(LIMITS)), 'LIMIT_KEYS'); for (const [name, hard] of Object.entries(LIMITS)) check(uint(value.budgets.limits[name], hard) && (name === 'retries' || value.budgets.limits[name] >= 1), 'LIMIT_VALUE'); check(value.budgets.limits.retries === 0 && value.budgets.limits.perOperatorConcurrency === 1 && value.budgets.limits.responseBytesPerRequest <= value.budgets.limits.responseBytes, 'LIMIT_POLICY'); exact(value.budgets.used, ['requests', 'responseBytes', 'maxConcurrency', 'maxPerOperatorConcurrency', 'elapsedMs', 'retries'], 'BUDGET_USED_SCHEMA'); const used = value.budgets.used, limits = value.budgets.limits; check(uint(used.requests, limits.requests) && used.requests > 0 && uint(used.responseBytes, limits.responseBytes) && uint(used.maxConcurrency, limits.concurrency) && used.maxConcurrency >= 1 && used.maxPerOperatorConcurrency === 1 && uint(used.elapsedMs, limits.wallMs) && used.retries === 0, 'BUDGET_USED');
  exact(value.safety, ['offlineOnly', 'injectedTestTransportOnly', 'productionTransportPresent', 'productionPublishable', 'readOnly', 'eip1898Canonical', 'retries', 'batches', 'traces', 'logs', 'pending', 'stateOverrides', 'signing', 'broadcasts', 'mutation', 'funds', 'endpointMaterialPersisted', 'endpointMaterialHashed'], 'SAFETY_SCHEMA'); check(JSON.stringify(value.safety) === JSON.stringify({ offlineOnly: true, injectedTestTransportOnly: true, productionTransportPresent: false, productionPublishable: false, readOnly: true, eip1898Canonical: true, retries: 0, batches: false, traces: false, logs: false, pending: false, stateOverrides: false, signing: false, broadcasts: false, mutation: false, funds: false, endpointMaterialPersisted: false, endpointMaterialHashed: false }), 'SAFETY_VALUE');
  exact(value.claims, ['finality', 'productionProxyRuntimeAuthority', 'vaultAuthority', 'registryAuthority', 'openPnlAuthority'], 'CLAIMS_SCHEMA'); check(JSON.stringify(value.claims) === JSON.stringify({ finality: 'RPC_FINALIZED_TAG_ONLY', productionProxyRuntimeAuthority: 'ABSENT_P0', vaultAuthority: 'R3_BEHAVIORAL_AND_BUILD', registryAuthority: 'BUILD_CLOSURE_ONLY', openPnlAuthority: 'BUILD_CLOSURE_ONLY' }), 'CLAIMS_VALUE');
  exact(value.integrity, ['algorithm', 'payloadHash'], 'INTEGRITY_SCHEMA'); check(value.integrity.algorithm === 'sha256' && /^[0-9a-f]{64}$/u.test(value.integrity.payloadHash), 'INTEGRITY_VALUE'); const payload = { ...value }; delete payload.integrity; check(sha256(canonical(payload)) === value.integrity.payloadHash, 'INTEGRITY_MISMATCH'); return value;
}
function parseSerialized(serialized, options = {}) { check(typeof serialized === 'string' && Buffer.byteLength(serialized) <= MAX_FILE_BYTES && serialized.endsWith('\n'), 'SERIALIZED'); let value; try { value = JSON.parse(serialized); } catch (_) { throw new ValidationError('JSON'); } check(`${JSON.stringify(value, null, 2)}\n` === serialized, 'CANONICAL_JSON'); return validateArtifact(value, options); }
function validateFile(filePath, { fsOps = fs, ...options } = {}) {
  check(typeof filePath === 'string' && path.isAbsolute(filePath), 'PATH'); const resolved = path.resolve(filePath), lexicalParent = path.dirname(resolved); let realRoot, realParent;
  try { realRoot = fsOps.realpathSync(TEMP_ROOT); realParent = fsOps.realpathSync(lexicalParent); } catch (_) { throw new ValidationError('PATH_REALPATH'); }
  const fold = (value) => process.platform === 'win32' ? value.toLowerCase() : value, below = (parent, child) => fold(child) === fold(parent) || fold(child).startsWith(`${fold(parent)}${path.sep}`);
  check(below(TEMP_ROOT, lexicalParent) && below(realRoot, realParent), 'PATH_ROOT'); const relative = path.relative(TEMP_ROOT, lexicalParent); let cursor = TEMP_ROOT;
  try { for (const part of ['', ...(relative ? relative.split(path.sep) : [])]) { if (part) cursor = path.join(cursor, part); const stat = fsOps.lstatSync(cursor); check(!stat.isSymbolicLink() && !(typeof stat.isReparsePoint === 'function' && stat.isReparsePoint()), 'PATH_ANCESTOR_LINK'); } } catch (error) { if (error instanceof ValidationError) throw error; throw new ValidationError('PATH_ANCESTOR'); }
  let lstat; try { lstat = fsOps.lstatSync(resolved); } catch (_) { throw new ValidationError('MISSING'); } check(lstat.isFile() && !lstat.isSymbolicLink() && !(typeof lstat.isReparsePoint === 'function' && lstat.isReparsePoint()) && lstat.size <= MAX_FILE_BYTES, 'FILE'); let fd;
  try { fd = fsOps.openSync(resolved, 'r'); const before = fsOps.fstatSync(fd); check(before.dev === lstat.dev && before.ino === lstat.ino && before.size === lstat.size, 'FILE_IDENTITY'); const bytes = fsOps.readFileSync(fd); const after = fsOps.fstatSync(fd); check(bytes.length === before.size && before.size === after.size && before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs, 'FILE_CHANGED'); return parseSerialized(new TextDecoder('utf-8', { fatal: true }).decode(bytes), options); } catch (error) { if (error instanceof ValidationError) throw error; throw new ValidationError('FILE_READ'); } finally { if (fd !== undefined) try { fsOps.closeSync(fd); } catch (_) {} }
}

if (require.main === module) { try { if (process.argv.length !== 3) throw new ValidationError('ARGS'); validateFile(path.resolve(process.argv[2])); process.stdout.write('OSTIUM_ARBITRUM_READ_GATE_R1_VALID_TEST_ARTIFACT\n'); } catch (error) { process.stderr.write(`OSTIUM_ARBITRUM_READ_GATE_R1_INVALID_${error instanceof ValidationError ? error.code : 'INTERNAL'}\n`); process.exitCode = 1; } }

module.exports = { SCHEMA, PROFILE_HASH, EXPECTED_PROFILE, LIMITS, TEMP_ROOT, ValidationError, canonical, sha256, noForbidden, validateArtifact, parseSerialized, validateFile };
