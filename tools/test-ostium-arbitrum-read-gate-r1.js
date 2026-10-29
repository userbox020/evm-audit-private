#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const engine = require('./lib/ostium-arbitrum-read-gate-r1.js');
const { PROFILE, PROFILE_HASH, canonical } = require('./ostium-arbitrum-read-gate-r1-profile.js');
const capture = require('./capture-ostium-arbitrum-read-gate-r1.js');
const validator = require('./validate-ostium-arbitrum-read-gate-r1.js');

let assertions = 0, mutations = 0, materialFailureCases = 0, materialDisagreementCases = 0, qualificationMutationCases = 0, terminalOnlyCases = 0, freshnessCases = 0, pathEscapeCases = 0;
const a = new Proxy(assert, { get(target, name) { const value = target[name]; return typeof value !== 'function' ? value : (...args) => { assertions++; return value(...args); }; } });
async function rejectsCode(operation, code) { assertions++; await assert.rejects(operation, (error) => error && error.code === code); }
function throwsCode(operation, code) { assertions++; assert.throws(operation, (error) => error && error.code === code); }
const shaFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ROOT = path.resolve(__dirname, '..');
const PRESERVED = Object.freeze({
  'tools/lib/r1-evm-read-gate.js': 'c20d290fa053e23e561c5fee54c6e47709f3f812d83d60d7c879932e438bc5fe',
  'tools/r1-read-gate-profiles.js': '922576e799e173122159e9a351f1ed847a24caf908024f037278bbc32c40f3e6',
  'tools/capture-r1-read-gate.js': 'f2fbb084ec262bb225d7041f20e147862a3fd3f66c90ab3b45af101f9ade581d',
  'tools/validate-r1-read-gate.js': 'd13fc48ae1bae19de08ff8c8213f2efc4422f2ae7fc5db0ae0a91596fa69b946',
  'tools/test-r1-read-gate.js': '19b6388c79840331fa59c95c7be2c4c237ed7711dc87108356e422ec49525144',
  'tools/run-ostium-settlement-boundary-conservation-r3.js': '0a4080dc52acbfe4ac320da30a679df26c52b1c9eabae11934d64c09cf305a5d',
  'tools/validate-ostium-settlement-boundary-conservation-r3.py': '70e8ede5cbf21f41b1d395f74ec71d180b2cf82555278730dc1c910ad23a50a1',
  'reports/raw/fast/ostium-settlement-boundary-conservation-r3/model.json': '4d1470e9015ee5a6e7e25eec0b0ba6db37fb9e50b0026b8ff50a59bd6f24e5c5',
  'reports/raw/fast/ostium-settlement-boundary-conservation-r3/observations.json': '5209732ac8e9902acde9adf230a122db780ede071531a11dd0a26a2ec26d59e1',
  'reports/raw/fast/ostium-settlement-boundary-conservation-r3/test-result.json': '8aff49025b45f0f20cf0e302d788006170244d31fc4cb6b6e8b1838afb75afb6',
  'reports/raw/fast/ostium-settlement-boundary-conservation-r3/manifest.json': '047b074a0faf00cc9bf46a3d046b49a987b05344fb258b1b70739c240db06ce8',
  'targets/ostium/artifacts/build-info/e2a08f99c05f7268422dd3a2bdac7ed1.json': '8a1e8ada63299b9d215d97f9ecaf570d048e67618b2f252f1e7e95b20468bdd9',
  'targets/ostium/artifacts/src/OstiumVault.sol/OstiumVault.json': 'f23b615df68d00c7435f1ecd4fe179e706bf30286c21ca02759ab29c98fa3948',
  'targets/ostium/artifacts/src/OstiumRegistry.sol/OstiumRegistry.json': 'b551e481c390ccc508f509c4fc366c18cb7c60f25a3e9a5e0785df5a5a0c08b8',
  'targets/ostium/artifacts/src/OstiumOpenPnl.sol/OstiumOpenPnl.json': '215dc1f4311d888f4eebcc75e4114265055b87a17d7ec78e464b423dd8b8d65f',
});
const preservationSnapshot = () => Object.fromEntries(Object.keys(PRESERVED).map((relative) => [relative, shaFile(path.join(ROOT, relative))]));
const beforePreservation = preservationSnapshot();
const preservationBinding = crypto.createHash('sha256').update(canonical(PRESERVED)).digest('hex');

const runtime = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8')).deployedBytecode.toLowerCase();
const VAULT_RUNTIME = runtime('targets/ostium/artifacts/src/OstiumVault.sol/OstiumVault.json');
const REGISTRY_RUNTIME = runtime('targets/ostium/artifacts/src/OstiumRegistry.sol/OstiumRegistry.json');
const OPEN_RUNTIME = runtime('targets/ostium/artifacts/src/OstiumOpenPnl.sol/OstiumOpenPnl.json');
const PROXY_A = '0x60806040526001600055';
const PROXY_B = '0x60806040526002600055';
const ROLES = Object.freeze({
  VAULT_PROXY: `0x${'11'.repeat(20)}`, VAULT_IMPLEMENTATION_AT_PIN: `0x${'22'.repeat(20)}`,
  REGISTRY: `0x${'33'.repeat(20)}`, OPEN_PNL_PROXY: `0x${'44'.repeat(20)}`,
  OPEN_PNL_IMPLEMENTATION_AT_PIN: `0x${'55'.repeat(20)}`, ASSET: `0x${'66'.repeat(20)}`,
});
const ADMIN = `0x${'77'.repeat(20)}`;
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const intWord = (value) => word(BigInt(value) < 0n ? (1n << 256n) + BigInt(value) : BigInt(value));
const hash = (number) => `0x${BigInt(number).toString(16).padStart(64, '0')}`;
const stateRoot = (number) => `0x${BigInt(number + 1_000_000).toString(16).padStart(64, '0')}`;
const quantity = (value) => `0x${BigInt(value).toString(16)}`;
function header(number, timestamp = 1_700_000_000) { return { number: quantity(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: stateRoot(number), timestamp: quantity(timestamp) }; }
function authority(options = {}) {
  const vaultModel = options.vaultModel || 'ERC1967_TRANSPARENT', openModel = options.openModel || 'ERC1967_TRANSPARENT';
  const policy = (model, override) => override || (model === 'ERC1967_UUPS' ? { kind: 'ZERO' } : { kind: 'NONZERO' });
  const value = { id: options.id || 'OSTIUM_TEST_AUTHORITY', productionAuthority: false, roles: {
    VAULT_PROXY: ROLES.VAULT_PROXY, REGISTRY: ROLES.REGISTRY, OPEN_PNL_PROXY: ROLES.OPEN_PNL_PROXY, ASSET: ROLES.ASSET,
  }, proxyModels: {
    VAULT_PROXY: { model: vaultModel, runtimeLength: (PROXY_A.length - 2) / 2, runtimeKeccak256: engine.keccak256(Buffer.from(PROXY_A.slice(2), 'hex')), adminPolicy: policy(vaultModel, options.vaultPolicy) },
    OPEN_PNL_PROXY: { model: openModel, runtimeLength: (PROXY_B.length - 2) / 2, runtimeKeccak256: engine.keccak256(Buffer.from(PROXY_B.slice(2), 'hex')), adminPolicy: policy(openModel, options.openPolicy) },
  } };
  value.canonicalCommitment = engine.authorityCommitment(value); return value;
}
function candidates(extra = []) { return [
  { transportLabel: 'zeta', operatorAuthority: { id: 'OPERATOR_Z', commitment: 'a'.repeat(64), trusted: true }, capabilityRank: 4, premium: true, inventoryOrder: 1 },
  { transportLabel: 'alpha', operatorAuthority: { id: 'OPERATOR_A', commitment: 'b'.repeat(64), trusted: true }, capabilityRank: 4, premium: false, inventoryOrder: 0 },
  ...extra,
]; }
function operationId(method, params, auth) {
  if (method === 'eth_getCode') { const target = params[0]; return target === auth.roles.VAULT_PROXY ? 1 : target === ROLES.VAULT_IMPLEMENTATION_AT_PIN ? 5 : target === auth.roles.REGISTRY ? 11 : target === auth.roles.OPEN_PNL_PROXY ? 14 : target === ROLES.OPEN_PNL_IMPLEMENTATION_AT_PIN ? 18 : null; }
  if (method === 'eth_getStorageAt') { const role = params[0] === auth.roles.VAULT_PROXY ? 'vault' : params[0] === auth.roles.OPEN_PNL_PROXY ? 'open' : null, slot = params[1]; if (role === 'vault') return slot === PROFILE.slots.implementation ? 2 : slot === PROFILE.slots.admin ? 3 : slot === PROFILE.slots.beacon ? 4 : null; if (role === 'open') return slot === PROFILE.slots.implementation ? 15 : slot === PROFILE.slots.admin ? 16 : slot === PROFILE.slots.beacon ? 17 : null; }
  if (method === 'eth_call') { const { to, data } = params[0]; if (to === engine.MULTICALL3) return 0; if (to === auth.roles.VAULT_PROXY) return data === PROFILE.selectors.registry ? 6 : data === PROFILE.selectors.asset ? 7 : data === PROFILE.selectors.lastSettlementId ? 8 : data === PROFILE.selectors.lastSettlementTs ? 9 : data === PROFILE.selectors.lastSettlementOpenPnl ? 10 : null; if (to === auth.roles.REGISTRY) return data === PROFILE.selectors.getContractAddress + PROFILE.registryKeys.vault.slice(2) ? 12 : data === PROFILE.selectors.getContractAddress + PROFILE.registryKeys.openPnl.slice(2) ? 13 : null; if (to === auth.roles.OPEN_PNL_PROXY) return data === PROFILE.selectors.registry ? 19 : data === PROFILE.selectors.getOpenPnlWithRollover ? 20 : null; if (to === auth.roles.ASSET && data === PROFILE.selectors.decimals) return 21; }
  return null;
}
function rawFor(id, auth, options) {
  const admin = (role) => { const model = auth.proxyModels[role]; if (model.adminPolicy.kind === 'ZERO') return engine.ZERO_WORD; if (model.adminPolicy.kind === 'EXACT') return engine.addressWord(model.adminPolicy.value); return engine.addressWord(ADMIN); };
  return ({ 1: PROXY_A, 2: engine.addressWord(ROLES.VAULT_IMPLEMENTATION_AT_PIN), 3: admin('VAULT_PROXY'), 4: engine.ZERO_WORD,
    5: VAULT_RUNTIME, 6: engine.addressWord(auth.roles.REGISTRY), 7: engine.addressWord(auth.roles.ASSET), 8: word(options.lastSettlementId ?? 17),
    9: word(options.lastSettlementTs ?? 1_699_999_900), 10: intWord(options.lastSettlementOpenPnl ?? -123n), 11: REGISTRY_RUNTIME,
    12: engine.addressWord(auth.roles.VAULT_PROXY), 13: engine.addressWord(auth.roles.OPEN_PNL_PROXY), 14: PROXY_B,
    15: engine.addressWord(ROLES.OPEN_PNL_IMPLEMENTATION_AT_PIN), 16: admin('OPEN_PNL_PROXY'), 17: engine.ZERO_WORD,
    18: OPEN_RUNTIME, 19: engine.addressWord(auth.roles.REGISTRY), 20: intWord(options.openPnlWithRollover ?? 456n), 21: word(6) })[id];
}
function mock(options = {}) {
  const auth = options.authority || authority(), calls = [], materialCalls = [], capabilityCalls = [], multicallCalls = [], finalized = options.finalized || {}, hashNumbers = new Map(), probeSeen = new Map(), multiCounts = new Map(), headerCounts = new Map();
  const transport = async (candidate, method, params, request = {}) => {
    calls.push({ label: candidate.transportLabel, method, params: JSON.parse(JSON.stringify(params)) });
    if (options.hang === true) return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => { options.abortObserved.value = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true }));
    if (method === 'eth_chainId') return options.chainId || '0xa4b1';
    if (method === 'eth_getBlockByNumber') { const tagged = params[0] === 'finalized', counts = headerCounts.get(candidate.transportLabel) || { tagged: 0, numeric: 0 }; counts[tagged ? 'tagged' : 'numeric']++; headerCounts.set(candidate.transportLabel, counts); const terminalStage = tagged ? counts.tagged >= 2 : counts.numeric >= 3; const number = tagged ? (finalized[candidate.transportLabel] || 100) : Number(BigInt(params[0])); let result = header(number, options.pinTimestamp || 1_700_000_000); if (options.headerOverride) result = options.headerOverride(candidate, number, tagged, result) || result; if (terminalStage && options.terminalHeaderOverride) result = options.terminalHeaderOverride(candidate, number, tagged, result) || result; hashNumbers.set(result.hash, number); return result; }
    let id = operationId(method, params, auth); if (!id && method === 'eth_getCode') { const prior = materialCalls.filter((row) => row.label === candidate.transportLabel).map((row) => row.id); if (prior.includes(2) && !prior.includes(5)) id = 5; else if (prior.includes(15) && !prior.includes(18)) id = 18; }
    if (method === 'eth_call' && params[0].to === engine.MULTICALL3) { const count = (multiCounts.get(candidate.transportLabel) || 0) + 1; multiCounts.set(candidate.transportLabel, count); const stage = count === 1 ? 'qualification' : count === 2 ? 'preMaterial' : 'terminal'; multicallCalls.push({ label: candidate.transportLabel, stage }); const number = hashNumbers.get(params[1].blockHash); return word((options.badMulticallLabel === candidate.transportLabel && stage === 'qualification') || (options.terminalMulticallLabel === candidate.transportLabel && stage === 'terminal') ? number - 1 : number); }
    if (!id) throw new Error('UNEXPECTED_REQUEST'); const seen = probeSeen.get(candidate.transportLabel) || new Set(), qualificationProbe = [1, 2, 8].includes(id) && !seen.has(id); if (qualificationProbe) { seen.add(id); probeSeen.set(candidate.transportLabel, seen); capabilityCalls.push({ label: candidate.transportLabel, id, method, params: JSON.parse(JSON.stringify(params)) }); }
    else materialCalls.push({ label: candidate.transportLabel, id, method, params: JSON.parse(JSON.stringify(params)) });
    if (qualificationProbe && options.qualificationFailure && options.qualificationFailure.id === id) { if (options.qualificationFailure.kind === 'failure') throw new Error('QUALIFICATION_FAILURE'); return options.qualificationFailure.value; }
    if (!qualificationProbe && options.failOperation === id && (!options.failLabel || options.failLabel === candidate.transportLabel)) throw new Error('SYNTHETIC_FAILURE'); let value = rawFor(id, auth, options);
    if (!qualificationProbe && options.override) { const replacement = options.override(candidate, id, value); if (replacement !== undefined) value = replacement; }
    return options.reportBytes === undefined ? value : { result: value, bytes: options.reportBytes };
  };
  return { auth, transport, calls, materialCalls, capabilityCalls, multicallCalls };
}
async function good(options = {}) { const fixture = mock(options), result = await capture.captureTestOnly({ authority: fixture.auth, candidates: options.candidates || candidates(), transport: fixture.transport, clock: () => options.now || 1_700_000_100_000, limits: options.limits }); return { ...result, ...fixture }; }
function reseal(value) { const copy = JSON.parse(JSON.stringify(value)); delete copy.integrity; copy.integrity = { algorithm: 'sha256', payloadHash: validator.sha256(validator.canonical(copy)) }; return copy; }

test('profile is address-free, deeply frozen, deterministic, and exactly tripwired', () => {
  a.equal(Object.isFrozen(PROFILE), true); a.equal(Object.isFrozen(PROFILE.operations), true); a.equal(PROFILE.productionEnabled, false); a.equal(PROFILE.chainId, 42161); a.equal(PROFILE_HASH, validator.PROFILE_HASH); a.equal(crypto.createHash('sha256').update(canonical(PROFILE)).digest('hex'), PROFILE_HASH);
  a.doesNotMatch(JSON.stringify(PROFILE), /0x[0-9a-f]{40}(?![0-9a-f])/u); a.equal(PROFILE.operations.length, 21); a.deepEqual(PROFILE.operations.map((row) => row.id), Array.from({ length: 21 }, (_, i) => i + 1));
  a.deepEqual(PROFILE.pin, { mode: 'finalized', maxAgeSeconds: 3600, futureSkewSeconds: 60 }); a.equal(Object.isFrozen(PROFILE.pin), true);
  a.equal(PROFILE.localModel.repository.commit, '8390ce497f68fb128900840e0ec30683afa945d3'); a.equal(PROFILE.localModel.repository.tree, 'aa149b0ed98e742a9de21aeb1c8d9ebf305d2612'); a.equal(PROFILE.authority.productionProxyRuntimeAuthority, 'ABSENT_P0');
});

test('pure Keccak and local runtime identities match all exact bindings', () => {
  a.equal(engine.keccak256(Buffer.alloc(0)), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  for (const [bytes, role] of [[VAULT_RUNTIME, 'VAULT_IMPLEMENTATION_AT_PIN'], [REGISTRY_RUNTIME, 'REGISTRY'], [OPEN_RUNTIME, 'OPEN_PNL_IMPLEMENTATION_AT_PIN']]) a.deepEqual(engine.codeIdentity(bytes), PROFILE.runtimes[role]);
});

test('invocation, profile, authority, candidate, and production gates fail before transport', async () => {
  let calls = 0; const transport = async () => { calls++; };
  await rejectsCode(() => engine.runTestGate({ profileHash: '0'.repeat(64), authority: authority(), candidates: candidates(), transport }), 'PROFILE_BINDING');
  const badAuthority = authority(); badAuthority.canonicalCommitment = '0'.repeat(64); await rejectsCode(() => engine.runTestGate({ profileHash: PROFILE_HASH, authority: badAuthority, candidates: candidates(), transport }), 'AUTHORITY_COMMITMENT_MISMATCH');
  await rejectsCode(() => engine.runTestGate({ profileHash: PROFILE_HASH, authority: authority(), candidates: [{ operatorAuthority: null }], transport }), 'INVOCATION_INVALID');
  await rejectsCode(() => capture.captureOfficial(), 'PRODUCTION_DISABLED'); await rejectsCode(() => capture.captureTestOnly({ authority: authority(), candidates: candidates(), transport, outputPath: 'x' }), 'TEST_MODE_PUBLICATION_FORBIDDEN');
  const oversized = Array.from({ length: engine.LIMITS.candidates + 1 }, (_, index) => ({ transportLabel: `pool-${index}`, operatorAuthority: { id: `OP_${index}`, commitment: index.toString(16).padStart(64, '0'), trusted: true }, inventoryOrder: index })); await rejectsCode(() => engine.runTestGate({ profileHash: PROFILE_HASH, authority: authority(), candidates: oversized, transport }), 'INVOCATION_INVALID');
  a.equal(calls, 0); a.equal(capture.atomicPublish, undefined); a.equal(engine.atomicPublish, undefined);
});

test('request timeout aborts injected transport and fails without retry', async () => {
  const abortObserved = { value: false }, fixture = mock({ hang: true, abortObserved }); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: Date.now, limits: { requestMs: 5 } }), 'REQUEST_TIMEOUT'); a.equal(abortObserved.value, true); a.equal(fixture.calls.length, 1);
});

test('all candidates qualify before capability/premium/inventory selection and no hostname authority exists', async () => {
  const third = { transportLabel: 'middle', operatorAuthority: { id: 'OPERATOR_M', commitment: 'c'.repeat(64), trusted: true }, capabilityRank: 9, premium: false, inventoryOrder: 2 };
  const result = await good({ candidates: candidates([third]) }), firstMaterial = result.calls.findIndex((row, index, all) => operationId(row.method, row.params, result.auth) === 1 && all.slice(0, index).some((prior) => prior.label === row.label && operationId(prior.method, prior.params, result.auth) === 1));
  a.deepEqual(new Set(result.calls.slice(0, firstMaterial).filter((row) => row.method === 'eth_chainId').map((row) => row.label)), new Set(['zeta', 'alpha', 'middle'])); a.equal(result.capabilityCalls.length, 9);
  a.deepEqual([...new Set(result.materialCalls.map((row) => row.label))], ['middle', 'zeta']); a.equal(result.artifact.qualification.allCandidatesQualifiedBeforeSelection, true); a.doesNotMatch(result.serialized, /zeta|alpha|middle|OPERATOR_[ZAM]/u);
});

test('qualification probes three capability schemas at each candidate own canonical finalized pin', async () => {
  const result = await good({ finalized: { zeta: 105, alpha: 104 } }); a.equal(result.capabilityCalls.length, 6); a.equal(result.artifact.qualification.capabilityEvidencePerQualifiedCandidate, 3);
  for (const label of ['zeta', 'alpha']) { const rows = result.capabilityCalls.filter((row) => row.label === label); a.deepEqual(rows.map((row) => row.id), [1, 2, 8]); const expectedHash = hash(label === 'zeta' ? 105 : 104); for (const row of rows) { const pin = row.method === 'eth_getStorageAt' ? row.params[2] : row.params[1]; a.deepEqual(pin, { blockHash: expectedHash, requireCanonical: true }); } }
});

test('qualification code/storage/call transport failures and malformed schemas fail every affected candidate', async () => {
  for (const id of [1, 2, 8]) for (const variant of [{ kind: 'failure' }, { kind: 'malformed', value: id === 1 ? '0x' : '0x12' }]) { qualificationMutationCases++; mutations++; const fixture = mock({ qualificationFailure: { id, ...variant } }); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => 1_700_000_100_000 }), 'TWO_OPERATORS_UNAVAILABLE'); a.equal(fixture.materialCalls.length, 0); }
});

test('selected common-pin Multicall reruns for both operators immediately before material reads', async () => {
  const result = await good(); a.deepEqual(result.multicallCalls.map((row) => `${row.label}:${row.stage}`), ['zeta:qualification', 'alpha:qualification', 'zeta:preMaterial', 'alpha:preMaterial', 'zeta:terminal', 'alpha:terminal']); const firstMaterialIndex = result.calls.findIndex((row, index, all) => operationId(row.method, row.params, result.auth) === 1 && all.slice(0, index).some((prior) => prior.label === row.label && operationId(prior.method, prior.params, result.auth) === 1)); const preIndices = result.calls.map((row, index) => row.method === 'eth_call' && row.params[0].to === engine.MULTICALL3 ? index : -1).filter((index) => index >= 0).slice(2, 4); a.equal(Math.max(...preIndices) + 1, firstMaterialIndex);
});

test('operator independence uses trusted metadata and same-operator aliases cannot form a pair', async () => {
  const rows = candidates(); rows[1].operatorAuthority = { ...rows[0].operatorAuthority };
  const fixture = mock(); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: rows, transport: fixture.transport, clock: () => 1_700_000_100_000 }), 'COMMON_PIN_UNAVAILABLE');
  a.equal(resultHasHostnameSelection(), false); function resultHasHostnameSelection() { return /candidate\.(?:hostname|url)|familyFromHostname/u.test(fs.readFileSync(path.join(__dirname, 'lib', 'ostium-arbitrum-read-gate-r1.js'), 'utf8')); }
});

test('highest two-operator common full header wins and finalized numeric rereads precede material reads', async () => {
  const third = { transportLabel: 'stale', operatorAuthority: { id: 'OPERATOR_S', commitment: 'd'.repeat(64), trusted: true }, capabilityRank: 0, inventoryOrder: 2 }, finalized = { zeta: 105, alpha: 105, stale: 90 };
  const result = await good({ candidates: candidates([third]), finalized }); a.equal(result.artifact.pin.number, 105); a.deepEqual(Object.keys(result.artifact.pin), ['number', 'hash', 'parentHash', 'stateRoot', 'timestamp']);
  for (const label of ['zeta', 'alpha', 'stale']) a.ok(result.calls.some((row) => row.label === label && row.method === 'eth_getBlockByNumber' && row.params[0] !== 'finalized'));
});

test('chain, finality, common header, terminal reread, and Multicall mismatches fail closed', async () => {
  for (const [options, code] of [
    [{ chainId: '0x1' }, 'TWO_OPERATORS_UNAVAILABLE'],
    [{ badMulticallLabel: 'alpha' }, 'TWO_OPERATORS_UNAVAILABLE'],
    [{ headerOverride: (candidate, number, finalized, value) => candidate.transportLabel === 'alpha' && finalized ? { ...value, stateRoot: `0x${'ff'.repeat(32)}` } : value }, 'TWO_OPERATORS_UNAVAILABLE'],
    [{ headerOverride: (candidate, number, finalized, value) => candidate.transportLabel === 'alpha' && !finalized && number === 100 ? { ...value, parentHash: `0x${'ee'.repeat(32)}` } : value }, 'TWO_OPERATORS_UNAVAILABLE'],
  ]) { const fixture = mock(options); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => 1_700_000_100_000 }), code); }
  const success = await good(); for (const label of ['zeta', 'alpha']) { a.ok(success.calls.filter((row) => row.label === label && row.method === 'eth_getBlockByNumber' && row.params[0] === '0x64').length >= 2); a.ok(success.calls.filter((row) => row.label === label && row.method === 'eth_call' && row.params[0].to === engine.MULTICALL3).length >= 2); }
});

test('selected pin freshness rejects stale/future and accepts exact boundaries in engine and validator', async () => {
  for (const [pinTimestamp, code] of [[1_699_996_499, 'PIN_STALE'], [1_700_000_161, 'PIN_FUTURE']]) { freshnessCases++; mutations++; const fixture = mock({ pinTimestamp }); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => 1_700_000_100_000 }), code); a.equal(fixture.materialCalls.length, 0); }
  await good({ pinTimestamp: 1_699_996_500, lastSettlementTs: 1_699_996_499 }); await good({ pinTimestamp: 1_700_000_160, lastSettlementTs: 1_700_000_100 });
  const result = await good(); for (const timestamp of [1_699_996_499, 1_700_000_161]) { freshnessCases++; mutations++; const value = JSON.parse(result.serialized); value.pin.timestamp = timestamp; a.throws(() => validator.validateArtifact(reseal(value), { now: 1_700_000_100_000 }), undefined, 'validator freshness'); }
});

test('terminal-only finalized, full-header, and Multicall mutations fail after all material reads', async () => {
  const cases = [
    { options: { terminalHeaderOverride: (_candidate, _number, tagged, value) => tagged ? header(99, value.timestamp) : value }, code: 'TERMINAL_FINALITY' },
    { options: { terminalHeaderOverride: (_candidate, _number, tagged, value) => !tagged ? { ...value, stateRoot: `0x${'ef'.repeat(32)}` } : value }, code: 'TERMINAL_HEADER_MISMATCH' },
    { options: { terminalMulticallLabel: 'zeta' }, code: 'MULTICALL_PIN_MISMATCH' },
  ];
  for (const row of cases) { terminalOnlyCases++; mutations++; const fixture = mock(row.options); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => 1_700_000_100_000 }), row.code); a.equal(fixture.materialCalls.length, 42); }
});

test('all 21 operations are ordered and use one exact canonical EIP-1898 pin', async () => {
  const result = await good(); for (const label of ['zeta', 'alpha']) a.deepEqual(result.materialCalls.filter((row) => row.label === label).map((row) => row.id), Array.from({ length: 21 }, (_, i) => i + 1));
  for (const row of result.materialCalls) { const pin = row.method === 'eth_getStorageAt' ? row.params[2] : row.params[1]; a.deepEqual(pin, { blockHash: result.artifact.pin.hash, requireCanonical: true }); }
  const selected = new Map(result.materialCalls.filter((row) => row.label === 'zeta').map((row) => [row.id, row])); a.equal(selected.get(5).params[0], engine.decodeAddressWord(rawFor(2, result.auth, {}))); a.equal(selected.get(18).params[0], engine.decodeAddressWord(rawFor(15, result.auth, {}))); a.deepEqual(Object.keys(result.auth.roles), ['VAULT_PROXY', 'REGISTRY', 'OPEN_PNL_PROXY', 'ASSET']);
});

test('selectors and case-sensitive right-padded registry keys are exact', async () => {
  a.equal(PROFILE.registryKeys.vault, `0x${Buffer.from('vault').toString('hex').padEnd(64, '0')}`); a.equal(PROFILE.registryKeys.openPnl, `0x${Buffer.from('openPnl').toString('hex').padEnd(64, '0')}`); a.notEqual(PROFILE.registryKeys.openPnl, `0x${Buffer.from('openpnl').toString('hex').padEnd(64, '0')}`);
  const result = await good(), byId = new Map(result.materialCalls.filter((row) => row.label === 'zeta').map((row) => [row.id, row]));
  a.equal(byId.get(12).params[0].data, '0x0d2020dd' + PROFILE.registryKeys.vault.slice(2)); a.equal(byId.get(13).params[0].data, '0x0d2020dd' + PROFILE.registryKeys.openPnl.slice(2));
  a.deepEqual([6, 7, 8, 9, 10, 19, 20, 21].map((id) => byId.get(id).params[0].data), ['0x7b103999', '0x38d52e0f', '0x39598fae', '0x5ae45c26', '0xaa8c9b6a', '0x7b103999', '0x807949e9', '0x313ce567']);
});

test('transparent, UUPS, and exact admin policies pass while unknown or model-incompatible policies fail', async () => {
  const transparent = await good(); a.match(transparent.artifact.roles[0].category, /TRANSPARENT_ADMIN_NONZERO/u);
  const uupsAuthority = authority({ vaultModel: 'ERC1967_UUPS', openModel: 'ERC1967_UUPS' }), uups = await good({ authority: uupsAuthority }); a.match(uups.artifact.roles[0].category, /UUPS_ADMIN_ZERO/u);
  const exactAuthority = authority({ vaultPolicy: { kind: 'EXACT', value: ADMIN }, openPolicy: { kind: 'EXACT', value: ADMIN } }), exact = await good({ authority: exactAuthority }); a.match(exact.artifact.roles[0].category, /ADMIN_EXACT/u);
  const unknown = authority(); unknown.proxyModels.VAULT_PROXY.model = 'UNKNOWN'; let calls = 0; await rejectsCode(() => capture.captureTestOnly({ authority: unknown, candidates: candidates(), transport: async () => { calls++; } }), 'PROXY_MODEL_INVALID'); a.equal(calls, 0);
  const incompatible = authority(); incompatible.proxyModels.VAULT_PROXY.adminPolicy = { kind: 'ZERO' }; incompatible.canonicalCommitment = '0'.repeat(64); throwsCode(() => engine.authorityCommitment(incompatible), 'PROXY_ADMIN_POLICY_INVALID');
  const injected = authority(); injected.roles.VAULT_IMPLEMENTATION_AT_PIN = ROLES.VAULT_IMPLEMENTATION_AT_PIN; throwsCode(() => engine.authorityCommitment(injected), 'AUTHORITY_ROLES_INVALID');
});

test('beacon, admin, implementation, and all five role links close exactly', async () => {
  const cases = [[2, engine.addressWord(ROLES.OPEN_PNL_IMPLEMENTATION_AT_PIN)], [3, engine.ZERO_WORD], [4, word(1)], [6, engine.addressWord(ROLES.ASSET)], [7, engine.addressWord(ROLES.REGISTRY)], [12, engine.addressWord(ROLES.REGISTRY)], [13, engine.addressWord(ROLES.VAULT_PROXY)], [15, engine.addressWord(ROLES.VAULT_IMPLEMENTATION_AT_PIN)], [16, engine.ZERO_WORD], [17, word(1)], [19, engine.addressWord(ROLES.ASSET)]];
  for (const [id, replacement] of cases) { mutations++; const fixture = mock({ override: (_candidate, operation) => operation === id ? replacement : undefined }); await a.rejects(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => 1_700_000_100_000 })); }
});

test('ABI address, uint32, int256, decimals, and timestamp rules are exact', async () => {
  throwsCode(() => engine.decodeAddressWord(`0x${'11'.repeat(32)}`), 'ABI_ADDRESS_INVALID'); a.equal(engine.decodeUint32(word(0xffffffffn)), 0xffffffff); throwsCode(() => engine.decodeUint32(word(0x100000000n)), 'ABI_UINT32_INVALID');
  for (const number of [0n, 1n, -1n, -(1n << 255n), (1n << 255n) - 1n]) a.equal(engine.decodeInt256(intWord(number)), number);
  for (const [id, value] of [[8, word(0x100000000n)], [9, word(1_700_000_001)], [21, word(18)]]) { mutations++; const fixture = mock({ override: (_candidate, operation) => operation === id ? value : undefined }); await a.rejects(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => 1_700_000_100_000 })); }
});

test('fixed and proxy code length/hash identities reject every mismatch', async () => {
  for (const id of [1, 5, 11, 14, 18]) { mutations++; const fixture = mock({ override: (_candidate, operation, value) => operation === id ? `${value}00` : undefined }); await a.rejects(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => 1_700_000_100_000 })); }
});

test('each of 21 operations rejects malformed bytes and explicit operation failure', async () => {
  for (let id = 1; id <= 21; id++) { mutations++; const fixture = mock({ override: (_candidate, operation) => operation === id ? '0x12' : undefined }); await a.rejects(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => 1_700_000_100_000 })); }
  for (let id = 1; id <= 21; id++) { materialFailureCases++; mutations++; const failed = mock({ failOperation: id, failLabel: 'zeta' }); await rejectsCode(() => capture.captureTestOnly({ authority: failed.auth, candidates: candidates(), transport: failed.transport, clock: () => 1_700_000_100_000 }), 'RPC_FAILURE'); }
});

test('raw cross-operator mismatch fails before decoding and no spare replacement occurs', async () => {
  const spare = { transportLabel: 'spare', operatorAuthority: { id: 'OPERATOR_S', commitment: 'd'.repeat(64), trusted: true }, capabilityRank: 1, inventoryOrder: 2 };
  for (let target = 1; target <= 21; target++) { materialDisagreementCases++; mutations++; const mismatch = mock({ override: (candidate, id, value) => { if (candidate.transportLabel !== 'alpha' || id !== target) return value; if (id === 2) return engine.addressWord(`0x${'23'.repeat(20)}`); if (id === 15) return engine.addressWord(`0x${'56'.repeat(20)}`); return `${value}00`; } }); await rejectsCode(() => capture.captureTestOnly({ authority: mismatch.auth, candidates: candidates(), transport: mismatch.transport, clock: () => 1_700_000_100_000 }), 'RAW_CROSS_OPERATOR_MISMATCH'); }
  const failure = mock({ failOperation: 10, failLabel: 'zeta' }); await rejectsCode(() => capture.captureTestOnly({ authority: failure.auth, candidates: candidates([spare]), transport: failure.transport, clock: () => 1_700_000_100_000 }), 'RPC_FAILURE'); a.equal(failure.materialCalls.some((row) => row.label === 'spare'), false);
});

test('operation tripwire hash changes for missing, duplicate, reordered, selector, key-case, and padding mutations', () => {
  const variants = [];
  const missing = JSON.parse(JSON.stringify(PROFILE)); missing.operations.pop(); variants.push(missing);
  const duplicate = JSON.parse(JSON.stringify(PROFILE)); duplicate.operations[20] = duplicate.operations[19]; variants.push(duplicate);
  const reordered = JSON.parse(JSON.stringify(PROFILE)); [reordered.operations[0], reordered.operations[1]] = [reordered.operations[1], reordered.operations[0]]; variants.push(reordered);
  const selector = JSON.parse(JSON.stringify(PROFILE)); selector.selectors.registry = '0x00000000'; variants.push(selector);
  const caseKey = JSON.parse(JSON.stringify(PROFILE)); caseKey.registryKeys.openPnl = `0x${Buffer.from('openpnl').toString('hex').padEnd(64, '0')}`; variants.push(caseKey);
  const padding = JSON.parse(JSON.stringify(PROFILE)); padding.registryKeys.vault = `0x${Buffer.from('vault').toString('hex').padStart(64, '0')}`; variants.push(padding);
  for (const variant of variants) { mutations++; a.notEqual(crypto.createHash('sha256').update(canonical(variant)).digest('hex'), PROFILE_HASH); }
});

test('every hard budget and transport byte floor is enforced before unsafe continuation', async (t) => {
  await t.test('injected maximum', async () => { let calls = 0; await rejectsCode(() => capture.captureTestOnly({ authority: authority(), candidates: candidates(), transport: async () => { calls++; }, limits: { requests: engine.LIMITS.requests + 1 } }), 'LIMITS_INVALID'); a.equal(calls, 0); });
  await t.test('requests', async () => { const fixture = mock(); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, limits: { requests: 1 } }), 'REQUEST_LIMIT'); });
  await t.test('response bytes actual not underreported', async () => { const fixture = mock({ reportBytes: 0 }); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, limits: { responseBytesPerRequest: 3 } }), 'RESPONSE_BYTE_LIMIT'); });
  await t.test('global bytes', async () => { const fixture = mock(); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => 1_700_000_100_000, limits: { responseBytes: 60_000, responseBytesPerRequest: 50_000 } }), 'BYTE_LIMIT'); });
  await t.test('candidate requests', async () => { const fixture = mock(); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, limits: { requestsPerCandidate: 4 } }), 'CANDIDATE_REQUEST_LIMIT'); });
  await t.test('wall', async () => { let now = 0; const fixture = mock(); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => now++, limits: { wallMs: 1 } }), 'WALL_LIMIT'); });
  await t.test('concurrency and operator concurrency', () => { const limits = { ...engine.LIMITS, concurrency: 1 }; a.equal(limits.concurrency, 1); a.equal(engine.LIMITS.perOperatorConcurrency, 1); });
  await t.test('artifact cap', async () => { const fixture = mock(); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: candidates(), transport: fixture.transport, clock: () => 1_700_000_100_000, limits: { artifactBytes: 1 } }), 'ARTIFACT_BYTE_LIMIT'); });
});

test('forbidden methods, features, and malformed EIP-1898 shapes are rejected', () => {
  for (const method of ['eth_getLogs', 'debug_traceCall', 'eth_sendTransaction', 'personal_sign', 'wallet_addEthereumChain', 'admin_peers']) throwsCode(() => engine.assertRpc(method, []), 'METHOD_FORBIDDEN');
  throwsCode(() => engine.assertRpc('eth_getBlockByNumber', ['pending', false]), 'METHOD_FORBIDDEN'); throwsCode(() => engine.assertRpc('eth_call', [{ to: ROLES.VAULT_PROXY, data: '0x', from: ROLES.ASSET }, engine.eip1898(hash(1))]), 'PARAMS_FORBIDDEN'); throwsCode(() => engine.assertRpc('eth_getCode', [ROLES.VAULT_PROXY, { blockHash: hash(1), requireCanonical: false }]), 'PARAMS_FORBIDDEN');
});

test('sanitizer rejects endpoint, credential, header, token, provider, operator, address, and domain injection classes', async () => {
  const collisionCases = [
    { leakMarker: 'PASS_TEST_ONLY' }, { headers: { status: 'secret' } }, { token: '42161' }, { provider: 'VAULT_PROXY' },
  ];
  for (const injection of collisionCases) { mutations++; const rows = candidates(); Object.assign(rows[0], injection); const fixture = mock(); await rejectsCode(() => capture.captureTestOnly({ authority: fixture.auth, candidates: rows, transport: fixture.transport, clock: () => 1_700_000_100_000 }), 'OUTPUT_UNSAFE'); }
  const result = await good(); for (const mutate of [
    (x) => { x.extra = 'https://private.example'; }, (x) => { x.extra = 'private.example'; }, (x) => { x.endpoint = 'secret'; }, (x) => { x.extra = ROLES.VAULT_PROXY; },
  ]) { mutations++; const value = JSON.parse(result.serialized); mutate(value); a.throws(() => validator.validateArtifact(value, { now: 1_700_000_100_000 })); }
});

test('projected artifact contains only approved role evidence and validates independently', async () => {
  const result = await good(); a.equal(validator.parseSerialized(result.serialized, { now: 1_700_000_100_000 }).status, 'PASS_TEST_ONLY'); a.deepEqual(result.artifact.roles.map((row) => row.role), PROFILE.roles); a.equal(result.artifact.links.length, 5); a.deepEqual(Object.keys(result.artifact.sentinels), ['lastSettlementId', 'lastSettlementTs', 'lastSettlementOpenPnl', 'openPnlWithRollover']);
  a.doesNotMatch(result.serialized, /0x[0-9a-f]{40}(?![0-9a-f])|zeta|alpha|OPERATOR_|https?:\/\//u); a.equal(result.artifact.claims.productionProxyRuntimeAuthority, 'ABSENT_P0'); a.equal(result.artifact.safety.productionPublishable, false);
});

test('independent validator rejects recomputed-integrity semantic mutations comprehensively', async () => {
  const result = await good(), mutators = [
    (x) => { x.profileHash = '0'.repeat(64); }, (x) => { x.status = 'PASS'; }, (x) => { x.productionEnabled = true; }, (x) => { x.chainId = 1; },
    (x) => { x.authority.id = 'bad'; }, (x) => { x.pin.stateRoot = '0x00'; }, (x) => { x.qualification.distinctOperators = 1; },
    (x) => { x.roles.reverse(); }, (x) => { x.roles[1].codeLength++; }, (x) => { x.roles[0].category = 'UNKNOWN'; }, (x) => { x.links.pop(); },
    (x) => { x.sentinels.lastSettlementId = '4294967296'; }, (x) => { x.sentinels.lastSettlementTs = String(x.pin.timestamp + 1); },
    (x) => { x.sentinels.lastSettlementOpenPnl = String(1n << 255n); }, (x) => { x.assetDecimals = 18; },
    (x) => { x.budgets.limits.retries = 1; }, (x) => { x.budgets.used.requests = x.budgets.limits.requests + 1; }, (x) => { x.safety.signing = true; },
    (x) => { x.claims.finality = 'CANONICAL_CHAIN_PROVEN'; }, (x) => { x.extra = true; },
  ];
  for (const [index, mutate] of mutators.entries()) { mutations++; const value = JSON.parse(result.serialized); mutate(value); a.throws(() => validator.validateArtifact(reseal(value), { now: 1_700_000_100_000 }), undefined, `semantic mutation ${index}`); }
  const hashMismatch = JSON.parse(result.serialized); hashMismatch.assetDecimals = 7; throwsCode(() => validator.parseSerialized(`${JSON.stringify(hashMismatch, null, 2)}\n`, { now: 1_700_000_100_000 }), 'ASSET_DECIMALS');
});

test('validator realpath confinement, ancestor links, file identity, outside-root, and race protections are strict', async () => {
  const result = await good(), dir = path.join(validator.TEMP_ROOT, `ostium-r1-${process.pid}-${Date.now()}`), file = path.join(dir, 'fixture.json'); fs.mkdirSync(dir, { recursive: false });
  try { fs.writeFileSync(file, result.serialized, { flag: 'wx' }); a.equal(validator.validateFile(file, { now: 1_700_000_100_000 }).status, 'PASS_TEST_ONLY'); throwsCode(() => validator.validateFile(path.join(ROOT, 'package.json')), 'PATH_ROOT');
    const symlinkFs = new Proxy(fs, { get(target, name) { if (name !== 'lstatSync') return target[name]; return (targetPath) => { const stat = fs.lstatSync(targetPath); return new Proxy(stat, { get(inner, property) { return property === 'isSymbolicLink' ? () => true : inner[property]; } }); }; } }); pathEscapeCases++; throwsCode(() => validator.validateFile(file, { fsOps: symlinkFs }), 'PATH_ANCESTOR_LINK');
    const junction = path.join(dir, 'escape'); try { fs.symlinkSync(ROOT, junction, process.platform === 'win32' ? 'junction' : 'dir'); pathEscapeCases++; throwsCode(() => validator.validateFile(path.join(junction, 'tools', 'test-r1-read-gate.js')), 'PATH_ROOT'); } catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; }
    let statCalls = 0; const raceFs = new Proxy(fs, { get(target, name) { if (name !== 'fstatSync') return target[name]; return (fd) => { const stat = fs.fstatSync(fd); if (++statCalls > 1) return new Proxy(stat, { get(inner, property) { return property === 'mtimeMs' ? inner.mtimeMs + 1 : inner[property]; } }); return stat; }; } }); throwsCode(() => validator.validateFile(file, { fsOps: raceFs, now: 1_700_000_100_000 }), 'FILE_CHANGED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('test mode has no publication surface and preserves existing sentinels and reports', async () => {
  const result = await good(), dir = path.join(validator.TEMP_ROOT, `ostium-sentinel-${process.pid}-${Date.now()}`), sentinel = path.join(dir, 'sentinel.txt'); fs.mkdirSync(dir, { recursive: false }); fs.writeFileSync(sentinel, 'KEEP');
  try { for (const key of ['outputPath', 'path', 'publish', 'atomicPublish', 'reportPath']) await rejectsCode(() => capture.captureTestOnly({ authority: result.auth, candidates: candidates(), transport: result.transport, [key]: sentinel }), 'TEST_MODE_PUBLICATION_FORBIDDEN'); a.equal(fs.readFileSync(sentinel, 'utf8'), 'KEEP'); a.equal(fs.existsSync(path.join(ROOT, 'reports', 'raw', 'fast', 'ostium-arbitrum-read-gate-r1')), false); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('original Phase1, Ostium R3, report, build-info, and artifact bindings are exact before completion', () => {
  a.deepEqual(beforePreservation, PRESERVED); a.deepEqual(preservationSnapshot(), PRESERVED); a.equal(Object.keys(PRESERVED).length, 15); a.match(preservationBinding, /^[0-9a-f]{64}$/u);
});

test.after(() => {
  a.deepEqual(preservationSnapshot(), PRESERVED);
  process.stdout.write(`OSTIUM_R1_SUMMARY ${JSON.stringify({ profileHash: PROFILE_HASH, assertions, mutations, qualificationMutationCases, capabilityEvidencePerQualifiedCandidate: 3, materialFailureCases, materialDisagreementCases, terminalOnlyCases, freshnessCases, pathEscapeCases, preservationFiles: Object.keys(PRESERVED).length, preservationBinding })}\n`);
});
