'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const scanner = require('../scan-basalt-x');
const { FACTORY, DOLOMITE, GM, ZERO, HANDLERS, STATE_ADDRESSES, STATE_BOOLS, STATE_UINTS, analyticalEquity, signedWei, collectBasaltX } = scanner;
const address = n => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
const hash = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const OWNER = address(10), MANAGER = address(11), BOOK = address(12), MATH = address(13);
const CORE = [address(100), address(101), address(102)], STATE = [address(200), address(201), address(202)], ISO = [address(300), address(301), address(302)];
const E18 = 10n ** 18n;
function fixture(count = 1) {
  const pin = { chainId: '42161', blockNumber: 999, blockHash: hash(999) }, calls = [];
  const runtimes = Object.fromEntries([FACTORY, DOLOMITE, GM, MATH, ...CORE, ...STATE].map(a => [a, { sourceRuntime: '0x600100' }]));
  const bindings = { ...pin, runtimes, factoryAuthority: { owner: OWNER, protocolManager: MANAGER, initialCoreAddressBook: BOOK } };
  const data = { count, uninitialized: new Set(), handlers: {}, balances: { gm: { sign: true, value: String(2n * E18) }, wbtc: { sign: false, value: '100000000' } }, physical: String(2n * E18), ownerCode: '0x', gmPrice: String(3n * E18), wbtcPrice: String(7n * 10n ** 28n) };
  const ctx = {
    pin, bindings,
    provider: {
      async getNetwork() { return { chainId: 42161n }; },
      async getBlock(n) { assert.equal(n, pin.blockNumber); return { number: n, hash: hash(n) }; },
      async getCode(a, n) { assert.equal(n, pin.blockNumber); return a === OWNER ? data.ownerCode : runtimes[a]?.sourceRuntime ?? '0x600100'; },
      async getStorage() { throw new Error('unexpected proxy storage'); },
    },
    contracts: { async read(q) {
      calls.push(q); assert.deepEqual(q.pin, pin);
      let value;
      if (q.target === FACTORY) {
        switch (q.method) {
          case 'owner': value = OWNER; break;
          case 'protocolManager': value = MANAGER; break;
          case 'initialCoreAddressBook': value = BOOK; break;
          case 'addressBookCooldownEndsAt': value = '100'; break;
          case 'nextTokenId': value = String(data.count); break;
          case 'vaultByTokenId': value = CORE[Number(q.args[0]) - 1]; break;
          case 'ownerOf': value = OWNER; break;
          case 'tokenIdByVault': value = String(CORE.indexOf(q.args[0]) + 1); break;
          case 'ownerOfVault': value = OWNER; break;
        }
      } else if (CORE.includes(q.target)) {
        const i = CORE.indexOf(q.target), uninitialized = data.uninitialized.has(i);
        if (q.method === 'initialized') value = !uninitialized;
        else if (q.method === 'FACTORY') value = uninitialized ? ZERO : FACTORY;
        else if (q.method === 'basaltMath') value = uninitialized ? ZERO : MATH;
        else if (q.method === 'basaltState') value = uninitialized ? ZERO : STATE[i];
        else if (q.method === 'accountedCapital') value = '30';
        else if (HANDLERS.includes(q.method)) value = data.handlers[q.method] ?? ZERO;
        else if (q.method === 'handlerProposal') value = { oldHandler: ZERO, newHandler: ZERO, exists: false };
        else if (q.method === 'basaltAddressesProposal') value = { newBasaltMath: ZERO, newBasaltState: ZERO, exists: false };
      } else if (STATE.includes(q.target)) {
        const i = STATE.indexOf(q.target);
        if (q.method === 'vaultCoreClone') value = CORE[i];
        else if (q.method === 'dolomiteIsolationVault') value = ISO[i];
        else if (STATE_ADDRESSES.includes(q.method)) value = ZERO;
        else if (STATE_BOOLS.includes(q.method)) value = false;
        else if (STATE_UINTS.includes(q.method)) value = '0';
      } else if (q.target === DOLOMITE) {
        if (q.method === 'getMarketPrice') value = { value: Number(q.args[0]) === 32 ? data.gmPrice : data.wbtcPrice };
        else if (q.method === 'getAccountWei') {
          assert.equal(q.args[0].number, '100'); assert.ok(ISO.includes(q.args[0].owner));
          value = Number(q.args[1]) === 32 ? data.balances.gm : data.balances.wbtc;
        }
      } else if (q.target === GM && q.method === 'balanceOf') value = data.physical;
      assert.notEqual(value, undefined, `${q.target}:${q.method}`);
      return { ...pin, target: q.target, complete: true, truncated: false, value };
    } },
  };
  return { ctx, calls, data };
}
function intercept(f, method, change) {
  const original = f.ctx.contracts.read;
  f.ctx.contracts.read = async q => q.method === method ? change(await original(q), q) : original(q);
}
async function incomplete(f, pattern) {
  const r = await collectBasaltX(f.ctx);
  assert.equal(r.coverage.snapshotComplete, false); assert.equal(r.coverage.complete, false);
  assert.equal(r.classSemantics.exact, false); assert.equal(r.eligibility, 'UNKNOWN');
  assert.equal(r.policyQualified, false); assert.equal(r.pipeline.wired, false);
  assert.match(r.coverage.errors.join('\n'), pattern); return r;
}

test('import and default CLI perform no provider discovery, protected IO or publishing', () => {
  const filename = path.resolve(__dirname, '../scan-basalt-x.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: { exports: {} }, require() { throw new Error('unexpected import'); }, process: { stdout: { write() { throw new Error('import IO'); } } } });
  const cli = spawnSync(process.execPath, [filename], { encoding: 'utf8', timeout: 10000 });
  assert.equal(cli.status, 0); assert.equal(cli.stderr, ''); assert.equal(cli.stdout, '');
});

test('source guards use the actual embedded BasaltMath and mutable core/state source', () => {
  const base = path.resolve(__dirname, '../../reports/raw/fast/basalt-deep-dive-20260921');
  const bundle = JSON.parse(fs.readFileSync(path.join(base, 'handlers/managerHandler.json'), 'utf8'));
  const math = bundle.sources['src/pure/BasaltMath.sol'].content;
  assert.ok(math.includes('return wbtcPriceE28 / 1e10;'));
  assert.ok(math.includes('Math.mulDiv(gmCollateralE18, gmPriceUsdE18, 1e18)'));
  assert.ok(math.includes('Math.mulDiv(wbtcDebtE8, wbtcPriceUsdE18, 1e8)'));
  const reader = bundle.sources['src/libraries/DolomiteReader.sol'].content;
  assert.ok(reader.includes('gmAccountWei.sign && gmAccountWei.value > 0'));
  assert.ok(reader.includes('!wbtcAccountWei.sign && wbtcAccountWei.value > 0'));
  assert.ok(bundle.sources['src/libraries/OracleGuard.sol'].content.includes('requireSequencerUp'));
  const factory = fs.readFileSync(path.join(base, 'src/src__core__VaultCoreNftFactory.sol'), 'utf8');
  const core = fs.readFileSync(path.join(base, 'src/src__core__VaultCore.sol'), 'utf8');
  const state = fs.readFileSync(path.join(base, 'src/src__core__VaultState.sol'), 'utf8');
  assert.ok(factory.includes('tokenId = ++nextTokenId;'));
  assert.ok(core.includes('bool public initialized;')); assert.ok(!scanner.ABI.join('\n').includes('initiazlied'));
  assert.ok(core.includes('_replaceHandler')); assert.ok(core.includes('basaltState ='));
  for (const getter of [...STATE_ADDRESSES, ...STATE_BOOLS, ...STATE_UINTS]) assert.match(state, new RegExp(`public ${getter};`));
});

test('signed Wei preserves debt and normalizes either signed zero to unsigned ZERO', () => {
  assert.deepEqual(signedWei({ sign: false, value: '0' }), { sign: true, value: '0', signed: '0', kind: 'ZERO' });
  assert.equal(signedWei([false, '7']).signed, '-7');
  assert.equal(signedWei([true, '7']).signed, '7');
  assert.throws(() => signedWei({ sign: 'false', value: '7' }), /invalid bool/);
});

test('analytical equity uses E18 GM, E8 WBTC, E28 prices and never clamps negatives', () => {
  const r = analyticalEquity({ gmWei: [true, String(2n * E18)], wbtcWei: [false, '100000000'], gmPriceE18: 3n * E18, wbtcPriceE28: 7n * 10n ** 28n });
  assert.equal(r.wbtcPriceE18, String(7n * E18));
  assert.equal(r.signedGmUsdE18, String(6n * E18));
  assert.equal(r.signedWbtcUsdE18, String(-7n * E18));
  assert.equal(r.analyticalEquityUsdE18, String(-E18));
  assert.ok(BigInt(r.signedRawWbtcValuationProduct) < 0n);
  assert.equal(r.isProtocolNav, false); assert.equal(r.clamped, false); assert.equal(r.conservationEstablished, false);
});

test('price conversion floors first and signed magnitude valuations truncate toward zero', () => {
  const r = analyticalEquity({ gmWei: [false, '1'], wbtcWei: [true, '1'], gmPriceE18: E18 - 1n, wbtcPriceE28: 10000000000n * 99999999n + 9999999999n });
  assert.equal(r.wbtcPriceE18, '99999999');
  assert.equal(r.signedGmUsdE18, '0'); assert.equal(r.signedWbtcUsdE18, '0'); assert.equal(r.analyticalEquityUsdE18, '0');
  assert.equal(r.signedRawGmValuationProduct, String(-(E18 - 1n)));
});

test('physical GM never adds a second copy of Dolomite account collateral', () => {
  const input = { gmWei: [true, E18], wbtcWei: [true, '0'], gmPriceE18: E18, wbtcPriceE28: '0' };
  const r = analyticalEquity({ ...input, physicalGmBalances: [{ amountE18: String(1000n * E18) }] });
  assert.equal(r.analyticalEquityUsdE18, String(E18)); assert.equal(r.physicalGmAddedToAccountEquity, false);
});

test('zero minted is valid empty enumeration, never inferred failed or COVERED', async () => {
  const f = fixture(0), r = await collectBasaltX(f.ctx);
  assert.deepEqual(r.coverage.errors, []); assert.equal(r.coverage.enumerationComplete, true); assert.equal(r.coverage.snapshotComplete, true);
  assert.deepEqual(r.vaults, []); assert.ok(!f.calls.some(q => q.method === 'vaultByTokenId' || q.method === 'getAccountWei'));
  assert.equal(r.coverage.complete, false); assert.equal(r.policyQualified, false); assert.equal(r.classSemantics.exact, false);
});

test('one-based inclusive enumeration preserves NFT owner/core/state/isolation association', async () => {
  const f = fixture(3), r = await collectBasaltX(f.ctx);
  assert.deepEqual(r.coverage.errors, []); assert.equal(r.coverage.snapshotComplete, true);
  assert.deepEqual(f.calls.filter(q => q.method === 'vaultByTokenId').map(q => q.args[0]), [1, 2, 3]);
  assert.deepEqual(r.vaults.map(v => [v.tokenId, v.owner, v.core, v.basaltState, v.isolationVault]), CORE.map((c, i) => [String(i + 1), OWNER, c, STATE[i], ISO[i]]));
  assert.equal(r.vaults[0].valuation.analyticalEquityUsdE18, String(-E18));
  assert.equal(r.policyQualified, false); assert.equal(r.pipeline.wired, false); assert.equal(r.liveAdmission, false);
  assert.equal(r.routePositive, 'unknown'); assert.doesNotThrow(() => JSON.stringify(r));
});

test('failed middle vault remains in place; later state and balances cannot shift token IDs', async () => {
  const f = fixture(3);
  intercept(f, 'basaltState', (r, q) => { if (q.target === CORE[1]) throw new Error('middle state read failed'); return r; });
  const r = await incomplete(f, /BASALT_VAULT_READ_FAILED/);
  assert.equal(r.vaults.length, 3); assert.equal(r.vaults[1].tokenId, '2'); assert.equal(r.vaults[1].core, CORE[1]); assert.equal(r.vaults[1].status, 'UNKNOWN');
  assert.equal(r.vaults[2].tokenId, '3'); assert.equal(r.vaults[2].basaltState, STATE[2]); assert.equal(r.vaults[2].isolationVault, ISO[2]);
});

test('uninitialized minted core is retained without calling a zero state address', async () => {
  const f = fixture(3); f.data.uninitialized.add(1);
  const r = await collectBasaltX(f.ctx);
  assert.deepEqual(r.coverage.errors, []); assert.equal(r.vaults[1].status, 'UNINITIALIZED_SNAPSHOT_ONLY'); assert.equal(r.vaults[1].exposure, 'UNKNOWN');
  assert.equal(r.vaults[1].basaltState, ZERO); assert.equal(r.vaults[2].basaltState, STATE[2]);
  assert.ok(f.calls.every(q => q.target !== ZERO));
  assert.ok(f.calls.some(q => q.target === CORE[1] && q.method === 'initialized'));
});

test('handlers come from mutable current core slots; unknown source and contract-owner hints confer no permission', async () => {
  const f = fixture(); f.data.handlers.withdrawHandler = address(400); f.data.handlers.asyncRecoveryHandler = address(401); f.data.ownerCode = '0x6000';
  const r = await collectBasaltX(f.ctx), row = r.vaults[0];
  assert.deepEqual(r.coverage.errors, []);
  assert.equal(row.handlers.withdrawHandler, address(400)); assert.equal(row.handlerBindings.withdrawHandler.status, 'UNKNOWN');
  assert.equal(row.ownerCodeHint.hasCode, true); assert.equal(row.ownerCodeHint.confersPublicPermission, false);
  assert.equal(row.publicPermission, 'UNKNOWN'); assert.equal(row.handlerSemantics, 'UNKNOWN');
  assert.ok(!f.calls.some(q => q.target === BOOK)); assert.equal(r.coverage.complete, false); assert.equal(r.classSemantics.exact, false);
});

test('state pending/deadline/fee/HWM/finalized fields are observed, never treated as immediately redeemable NAV', async () => {
  const f = fixture();
  for (const method of ['depositState', 'pendingDepositDeadline', 'managerAccruedFeeUsdE18', 'highWaterMarkProfitUsdE18', 'lastFinalizedNavUsdE18']) intercept(f, method, r => ({ ...r, value: method === 'depositState' ? '1' : '123' }));
  const r = await collectBasaltX(f.ctx), row = r.vaults[0];
  assert.deepEqual(r.coverage.errors, []); assert.equal(row.allActionsIdle, false); assert.equal(row.state.lastFinalizedNavUsdE18, '123');
  assert.equal(row.valuation.isProtocolNav, false); assert.equal(row.valuation.conservationEstablished, false);
});

test('unknown handler source is a semantic gap, but a failed handler code read also invalidates capture', async () => {
  const f = fixture(), handler = address(400), original = f.ctx.provider.getCode;
  f.data.handlers.withdrawHandler = handler;
  f.ctx.provider.getCode = async (a, n) => { if (a === handler) throw new Error('handler code read failed'); return original(a, n); };
  await incomplete(f, /BASALT_VAULT_READ_FAILED/);
});

test('Dolomite account 100 uses market 32 GM and market 4 WBTC with exact tuple ABIs', async () => {
  const f = fixture(); await collectBasaltX(f.ctx);
  assert.deepEqual(f.calls.filter(q => q.method === 'getAccountWei').map(q => [q.args[0], q.args[1]]), [[{ owner: ISO[0], number: '100' }, 32], [{ owner: ISO[0], number: '100' }, 4]]);
  assert.ok(scanner.ABI.includes('function getMarketPrice(uint256) view returns ((uint256 value))'));
  assert.ok(scanner.ABI.includes('function getAccountWei((address owner,uint256 number) account,uint256 market) view returns ((bool sign,uint256 value))'));
});

test('zero isolation is retained as a scoped observation, not absence of all exposure', async () => {
  const f = fixture(); intercept(f, 'dolomiteIsolationVault', r => ({ ...r, value: ZERO }));
  const r = await collectBasaltX(f.ctx);
  assert.equal(r.coverage.snapshotComplete, true); assert.equal(r.vaults[0].isolationVault, ZERO); assert.equal(r.vaults[0].valuation.exposure, 'UNKNOWN');
  assert.ok(!f.calls.some(q => q.method === 'getAccountWei'));
});

test('wrong pin/chain, truncated envelopes and failed required valuation reads never complete snapshots', async () => {
  for (const change of [r => ({ ...r, blockHash: hash(0) }), r => ({ ...r, chainId: '1' }), r => ({ ...r, truncated: true }), r => ({ ...r, overflow: true }), () => { throw new Error('valuation read failed'); }]) {
    const f = fixture(); intercept(f, 'getAccountWei', change);
    await incomplete(f, /wrong pin\/chain|incomplete\/overflow|BASALT_VAULT_READ_FAILED/);
  }
  const f = fixture(); f.ctx.provider.getNetwork = async () => ({ chainId: 1n }); await incomplete(f, /wrong provider chain/);
});

test('factory authority, runtime binding, state back-reference and reverse NFT mismatches fail closed', async () => {
  const a = fixture(); a.ctx.bindings.factoryAuthority.protocolManager = OWNER; await incomplete(a, /authority mismatch/);
  const b = fixture(); delete b.ctx.bindings.runtimes[CORE[0]]; await incomplete(b, /source runtime/);
  const c = fixture(); intercept(c, 'vaultCoreClone', r => ({ ...r, value: CORE[1] })); await incomplete(c, /back-reference/);
  const d = fixture(); intercept(d, 'tokenIdByVault', r => ({ ...r, value: '2' })); await incomplete(d, /reverse association/);
});

test('EIP1167 clone byte equality does not replace implementation source binding', async () => {
  const f = fixture(), impl = address(500);
  f.ctx.bindings.runtimes[CORE[0]].sourceRuntime = `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  await incomplete(f, /source runtime/);
  f.ctx.bindings.runtimes[impl] = { sourceRuntime: '0x600100' };
  const r = await collectBasaltX(f.ctx); assert.deepEqual(r.coverage.errors, []); assert.equal(r.coverage.snapshotComplete, true);
});

test('declared mutable proxy implementation is checked at the same fixed pin', async () => {
  const f = fixture(), impl = address(501), slot = hash(99);
  f.ctx.bindings.runtimes[MATH].proxy = { implementation: impl, slot };
  f.ctx.bindings.runtimes[impl] = { sourceRuntime: '0x600100' };
  f.ctx.provider.getStorage = async (a, s, n) => { assert.equal(a, MATH); assert.equal(s, slot); assert.equal(n, 999); return hash(0); };
  await incomplete(f, /proxy implementation mismatch/);
});

test('caps, malformed action state and final reorg cannot produce exact coverage', async () => {
  const a = fixture(3); a.ctx.caps = { maxVaults: 2 }; await incomplete(a, /vault cap/);
  const b = fixture(); b.ctx.caps = { maxReads: 5 }; await incomplete(b, /read cap/);
  const c = fixture(); intercept(c, 'withdrawState', r => ({ ...r, value: '2' })); await incomplete(c, /unknown action state/);
  const d = fixture(); let reads = 0;
  d.ctx.provider.getBlock = async n => ({ number: n, hash: ++reads > 1 ? hash(0) : hash(n) }); await incomplete(d, /pin hash\/reorg/);
});

test('default inputs remain UNKNOWN with no implicit IO or admission', async () => {
  const r = await collectBasaltX(); assert.equal(r.coverage.complete, false); assert.equal(r.policyQualified, false); assert.equal(r.eligibility, 'UNKNOWN'); assert.equal(r.pipeline.wired, false);
});

function privateFailure(label) {
  const sentinels = ['MESSAGE', 'CODE', 'STACK', 'BODY', 'HEADER', 'CALLDATA', 'CAUSE'].map(k => `FAKE_BASALT_${label}_${k}_SECRET`);
  const failure = new Error(`https://fake.invalid/rpc?token=${sentinels[0]}`);
  failure.code = sentinels[1]; failure.stack = sentinels[2]; failure.body = sentinels[3];
  failure.headers = { Authorization: sentinels[4] }; failure.data = { calldata: sentinels[5] };
  failure.cause = { message: sentinels[6], body: { headers: failure.headers, data: failure.data } };
  return { failure, sentinels };
}
function assertPrivateFailure(result, secret, stage) {
  const json = JSON.stringify(result);
  for (const sentinel of secret.sentinels) assert.equal(json.includes(sentinel), false, 'dependency diagnostic leaked');
  assert.match(result.coverage.errors.join('\n'), new RegExp(stage));
  assert.equal(result.coverage.snapshotComplete, false); assert.equal(result.coverage.complete, false);
  assert.equal(result.classSemantics.exact, false); assert.equal(result.eligibilityComplete, false);
  assert.equal(result.policyQualified, false); assert.equal(result.pipeline.wired, false); assert.equal(result.liveAdmission, false);
}

test('privacy: provider/contracts binding failures expose only fixed capture codes', async () => {
  for (const dependency of ['provider', 'contracts']) {
    const f = fixture(), secret = privateFailure(dependency);
    if (dependency === 'provider') f.ctx.provider.getCode = async () => { throw secret.failure; };
    else intercept(f, 'protocolManager', () => { throw secret.failure; });
    const r = await collectBasaltX(f.ctx);
    assertPrivateFailure(r, secret, 'BASALT_CAPTURE_FAILED');
    assert.deepEqual(r.coverage.errors, ['BASALT_CAPTURE_FAILED']);
  }
});

test('privacy: failed middle vault and valuation error envelopes retain associations without payloads', async () => {
  for (const mode of ['throw', 'envelope']) {
    const f = fixture(3), secret = privateFailure(`VAULT_${mode}`);
    if (mode === 'throw') intercept(f, 'basaltState', (r, q) => { if (q.target === CORE[1]) throw secret.failure; return r; });
    else intercept(f, 'getAccountWei', (r, q) => q.args[0].owner === ISO[1] ? { ...r, error: secret.failure } : r);
    const r = await collectBasaltX(f.ctx);
    assertPrivateFailure(r, secret, 'BASALT_VAULT_READ_FAILED');
    assert.equal(r.vaults[1].tokenId, '2'); assert.equal(r.vaults[1].core, CORE[1]); assert.equal(r.vaults[1].status, 'UNKNOWN');
    assert.equal(r.vaults[2].tokenId, '3'); assert.equal(r.vaults[2].basaltState, STATE[2]); assert.equal(r.vaults[2].status, 'SNAPSHOT_ONLY');
    if (mode === 'throw') assert.deepEqual(r.vaults[1].errors, ['BASALT_VAULT_READ_FAILED']);
  }
});

test('privacy: terminal pin errors retain partial data and serialize no dependency diagnostics', async () => {
  const f = fixture(), secret = privateFailure('TERMINAL'), original = f.ctx.provider.getBlock;
  let pinReads = 0;
  f.ctx.provider.getBlock = async n => { if (++pinReads > 1) throw secret.failure; return original(n); };
  const r = await collectBasaltX(f.ctx);
  assertPrivateFailure(r, secret, 'BASALT_FINAL_PIN_FAILED');
  assert.equal(r.vaults[0].status, 'SNAPSHOT_ONLY'); assert.equal(r.coverage.errors.at(-1), 'BASALT_FINAL_PIN_FAILED');
});

test('privacy: only private branding permits allowlisted detail, never forged or mutable error fields', async () => {
  const forged = new Error('wrong pin/chain'); forged.name = 'ObserverValidationError'; forged.code = 'wrong pin/chain';
  const unreadable = new Proxy({}, { get() { throw new Error('FAKE_BASALT_ERROR_PROPERTY_READ'); } });
  for (const failure of [forged, unreadable, 'FAKE_BASALT_THROWN_STRING_SECRET']) {
    const f = fixture(); f.ctx.provider.getCode = async () => { throw failure; };
    const r = await collectBasaltX(f.ctx);
    assert.deepEqual(r.coverage.errors, ['BASALT_CAPTURE_FAILED']); assert.equal(r.coverage.snapshotComplete, false);
  }
  let branded;
  try { signedWei({ sign: 'not-a-boolean', value: '1' }); } catch (e) { branded = e; }
  const secret = privateFailure('TAMPERED_BRAND');
  for (const key of ['message', 'code', 'stack', 'body', 'headers', 'data', 'cause']) branded[key] = secret.failure[key];
  const f = fixture(); f.ctx.provider.getCode = async () => { throw branded; };
  const r = await collectBasaltX(f.ctx);
  assertPrivateFailure(r, secret, 'BASALT_CAPTURE_FAILED');
  assert.deepEqual(r.coverage.errors, ['BASALT_CAPTURE_FAILED: invalid bool']);
});

test('privacy: pin reconstruction ignores URL/header/body/error metadata and toJSON hooks', async () => {
  const f = fixture(), secret = privateFailure('PIN_METADATA'), expected = { ...f.ctx.pin };
  f.ctx.pin = { ...expected, url: secret.failure.message, headers: secret.failure.headers, body: secret.failure.body, error: secret.failure, toJSON() { return secret.sentinels[6]; } };
  const r = await collectBasaltX(f.ctx), json = JSON.stringify(r);
  assert.deepEqual(r.pin, expected); assert.deepEqual(Object.keys(r.pin), ['chainId', 'blockNumber', 'blockHash']);
  for (const sentinel of secret.sentinels) assert.equal(json.includes(sentinel), false, 'unknown pin metadata leaked');
  assert.equal(r.coverage.snapshotComplete, true);
});
