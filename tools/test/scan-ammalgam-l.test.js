'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const m = require('../lib/ammalgam-l-math');
const scanner = require('../scan-ammalgam-l');
const { FACTORY, HISTORICAL_IMPLEMENTATION: IMPL, LIBRARIES, ZERO, collectAmmalgamL } = scanner;
const address = n => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
const hash = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const PAIR = address(30), BEACON = address(31), AUTH = address(32), ALICE = address(33), BOB = address(34), X = address(10), Y = address(20);
const TOKENS = Array.from({ length: 6 }, (_, i) => address(40 + i));
const zero = () => ['0', '0', '0', '0', '0', '0'];
function fixture() {
  const pin = { chainId: '1', blockNumber: 13, blockHash: hash(13) }, calls = [], logsCalled = [];
  const runtimes = Object.fromEntries([FACTORY, BEACON, PAIR, IMPL, ...Object.values(LIBRARIES), ...TOKENS].map(a => [a, { sourceRuntime: '0x600100' }]));
  runtimes[IMPL] = { sourceRuntime: `0x${Object.values(LIBRARIES).map(a => `73${a.slice(2)}50`).join('')}00`, sourceKind: 'PairBlockedBorrowLiquidity' };
  const bindings = { ...pin, runtimes, factoryAuthority: { feeToSetter: AUTH }, beaconAuthority: { owner: AUTH } };
  const env = value => ({ ...pin, target: FACTORY, complete: true, truncated: false, value });
  const event = (target, name, index, args) => ({ address: target, event: name, blockNumber: 10, blockHash: hash(10), transactionHash: hash(100 + index), index, removed: false, args });
  const logs = {
    [FACTORY]: [event(FACTORY, 'PairCreated', 0, { tokenX: X, tokenY: Y, pair: PAIR, allPairsLength: '1' })],
    [TOKENS[3]]: [event(TOKENS[3], 'Transfer', 1, { from: ZERO, to: ALICE, value: '1' }), event(TOKENS[3], 'Transfer', 2, { from: ALICE, to: BOB, value: '1' })],
    [TOKENS[4]]: [], [TOKENS[5]]: [],
  };
  const data = { assets: ['1000', '100', '100', '10', '10', '10'], rawShares: ['100', '100', '100', '100', '100', '100'], accruedShares: ['110', '110', '110', '100', '100', '100'], balances: { [ALICE]: zero(), [BOB]: ['11', '0', '0', '1', '0', '0'] }, fragile: '0', external: '0', pairShares: '0', count: '1' };
  const ctx = {
    pin, bindings, factoryCreation: { blockNumber: 5, blockHash: hash(5) }, caps: { blockChunkSize: 2 },
    provider: {
      async getNetwork() { return { chainId: 1n }; },
      async getBlock(n) { return { number: n, hash: hash(n) }; },
      async getCode(a, n) { if (a === FACTORY && n < 5 || TOKENS.slice(3).includes(a) && n < 10) return '0x'; return runtimes[a]?.sourceRuntime ?? '0x'; },
      async getStorage(a, slot, n) { assert.equal(a, PAIR); assert.equal(n, pin.blockNumber); return `0x${'0'.repeat(24)}${(slot === scanner.IMPLEMENTATION_SLOT ? IMPL : BEACON).slice(2)}`; },
    },
    contracts: { async read(q) {
      calls.push(q); assert.deepEqual(q.pin, pin);
      let value;
      if (q.target === FACTORY) {
        if (q.method === 'pairBeacon') value = BEACON;
        else if (q.method === 'feeToSetter') value = AUTH;
        else if (q.method === 'allPairsLength') value = data.count;
        else if (q.method === 'allPairs') { assert.equal(q.args[0], 0); value = PAIR; }
        else if (q.method === 'getPair') value = PAIR;
      } else if (q.target === BEACON) value = q.method === 'owner' ? AUTH : IMPL;
      else if (q.target === PAIR) {
        if (q.method === 'underlyingTokens') value = [X, Y];
        else if (q.method === 'tokens') value = TOKENS[Number(q.args[0])];
        else if (q.method === 'totalAssetsAndShares') value = { allAssets: data.assets, allShares: q.args[0] ? data.accruedShares : data.rawShares };
        else if (q.method === 'getReserves') value = ['400', '500', '1'];
        else if (q.method === 'externalLiquidity') value = data.external;
        else if (q.method === 'fragileLiquidityShares') value = data.fragile;
      } else if (TOKENS.includes(q.target)) {
        if (q.method === 'owner') value = PAIR;
        else if (q.method === 'totalSupply') value = data.accruedShares[TOKENS.indexOf(q.target)];
        else if (q.method === 'balanceOf') value = q.args[0] === PAIR ? q.target === TOKENS[0] ? data.pairShares : '0' : data.balances[q.args[0]]?.[TOKENS.indexOf(q.target)] ?? '0';
      }
      assert.notEqual(value, undefined, `${q.target}:${q.method}`);
      return { ...env(value), target: q.target };
    } },
    async logReader(q) { logsCalled.push(q); return { ...env(undefined), target: q.target, fromBlock: q.fromBlock, toBlock: q.toBlock, logs: (logs[q.target] ?? []).filter(l => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock) }; },
  };
  return { ctx, calls, logsCalled, data, logs };
}
async function incomplete(f, pattern) {
  const r = await collectAmmalgamL(f.ctx);
  assert.equal(r.coverage.snapshotComplete, false);
  assert.equal(r.coverage.complete, false); assert.equal(r.classSemantics.exact, false);
  assert.equal(r.eligibilityComplete, false); assert.equal(r.eligibility, 'UNKNOWN');
  assert.match(r.coverage.errors.join('\n'), pattern); return r;
}
function intercept(f, method, change) {
  const original = f.ctx.contracts.read;
  f.ctx.contracts.read = async q => q.method === method ? change(await original(q), q) : original(q);
}

test('import and default CLI never resolve providers, files, or live publishing', () => {
  const mathCode = fs.readFileSync(path.resolve(__dirname, '../lib/ammalgam-l-math.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(mathCode, { module });
  const scannerCode = fs.readFileSync(path.resolve(__dirname, '../scan-ammalgam-l.js'), 'utf8');
  vm.runInNewContext(scannerCode, { module: { exports: {} }, require(p) { assert.equal(p, './lib/ammalgam-l-math'); return module.exports; }, process: { stdout: { write() { throw new Error('import IO'); } } } });
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../scan-ammalgam-l.js')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(cli.status, 0); assert.equal(cli.stderr, ''); assert.equal(cli.stdout, '');
});

test('math guards are checked against cached Solidity, including share-rounding and penalty order', () => {
  const dir = path.resolve(__dirname, '../../reports/raw/fast/ammalgam-deep-dive-20260921/src-verified/pairImpl/contracts');
  const token = fs.readFileSync(path.join(dir, 'tokens/TokenController.sol'), 'utf8');
  const pair = fs.readFileSync(path.join(dir, 'AmmalgamPair.sol'), 'utf8');
  const liq = fs.readFileSync(path.join(dir, 'libraries/Liquidation.sol'), 'utf8');
  const partial = fs.readFileSync(path.join(dir, 'libraries/PartialLiquidations.sol'), 'utf8');
  assert.ok(token.includes('FIRST_DEBT_TOKEN <= i'));
  assert.ok(token.includes('fragileLiquidityShares, rawTotalAssets(DEPOSIT_L), totalShares(DEPOSIT_L), ROUNDING_UP'));
  assert.ok(token.indexOf('mintPenalties(affectedAccount') < token.indexOf('updateTokenController(', token.indexOf('mintPenalties(affectedAccount')));
  assert.ok(pair.indexOf('accrueSaturationPenaltiesAndInterest(borrower') < pair.indexOf('getInputParams(borrower, false)'));
  assert.ok(pair.includes('Convert.toShares(depositToTransferInAssets, _totalAssets, _totalShares, ROUNDING_UP)'));
  assert.ok(liq.includes('sqrtPriceMaxInQ72, sqrtPriceMinInQ72'));
  assert.ok(liq.includes('Math.sqrt(inputParams.sqrtPriceMinInQ72 * inputParams.sqrtPriceMaxInQ72)'));
  assert.ok(partial.includes('if (loopMem.includedTranches == loopMem.satArrayLength)'));
  assert.ok(partial.includes('netSeizedLAssets * EXPECTED_SATURATION_LTV_MAG2 / MAG2'));
});

test('asset conversions floor deposits, ceil ALL debt indices including BORROW_L', () => {
  assert.equal(m.toAssets('1', '1', '3', false), 0n);
  assert.equal(m.toAssets('1', '1', '3', true), 1n);
  assert.deepEqual(m.userAssets(['1', '1', '1', '1', '1', '1'], ['1', '1', '1', '1', '1', '1'], ['3', '3', '3', '3', '3', '3']), [0n, 0n, 0n, 1n, 1n, 1n]);
  assert.equal(m.toAssets('7', '0', '0', true), 7n);
  assert.equal(m.toAssets('7', '999', '0'), 7n);
});

test('snapshot uses accrued share totals (lazy fees), staged L floors, RAW fragile basis', () => {
  const r = m.snapshotAccounting({ accruedAssets: ['1000', '0', '0', '10', '0', '0'], accruedShares: ['110', '0', '0', '10', '0', '0'], rawAssets: ['100', '0', '0', '10', '0', '0'], rawShares: ['3', '0', '0', '10', '0', '0'], balances: ['11', '0', '0', '1', '0', '0'], pairHeldDepositLShares: '1', externalLiquidity: '20', fragileShares: '1' });
  assert.equal(r.userAssets[0], '100');
  assert.equal(r.stagedL, '9');
  assert.equal(r.activeL, '1001');
  assert.equal(r.fragileDeduction, '32'); // floor(ceil(100/3)*95/100)
  assert.equal(r.activeAfterFragile, '969');
  assert.equal(r.eligibility, 'UNKNOWN');
});

test('staged L zero-share branch and uint underflows match source guards', () => {
  const input = { accruedAssets: ['10', '0', '0', '0', '0', '0'], accruedShares: zero(), rawAssets: ['10', '0', '0', '0', '0', '0'], rawShares: zero(), balances: zero(), pairHeldDepositLShares: '2', externalLiquidity: '0', fragileShares: '0' };
  assert.equal(m.snapshotAccounting(input).stagedL, '2');
  assert.equal(m.snapshotAccounting(input).activeL, '8');
  assert.throws(() => m.snapshotAccounting({ ...input, pairHeldDepositLShares: '11' }), /underflow/);
  assert.throws(() => m.snapshotAccounting({ ...input, accruedAssets: ['1', '0', '0', '2', '0', '0'] }), /underflow/);
  assert.throws(() => m.snapshotAccounting({ ...input, fragileShares: '100' }), /FragileLiquidity/);
});

test('HARD premium is seized/repaid multiplier, not bonus, and zero repay is infinite', () => {
  for (const [ltv, expected] of [[6000, 0], [6001, 6], [7499, 9993], [7500, 10000], [9000, 11111]]) assert.equal(m.hardPremium(ltv), BigInt(expected));
  assert.equal(m.hardActualPremium('0', '0'), m.MAX);
  assert.equal(m.hardActualPremium('3', '4'), 13334n);
});

test('HARD intentionally swaps price bounds and chooses the correct debt direction', () => {
  const a = ['0', '0', '100', '0', '100', '0'];
  const r = m.hardNet(a, m.Q72 / 2n, m.Q72 * 2n);
  assert.equal(r.debt, '50'); assert.equal(r.collateral, '200'); assert.equal(r.netDebtX, true);
  const raw = m.lSides(a, m.Q72 / 2n, m.Q72 * 2n);
  assert.equal(raw.borrowX, 200n); assert.equal(raw.depositY, 50n);
  const premium = m.hardSlicePremium(a, '1000', m.Q72 / 2n, m.Q72 * 2n);
  assert.equal(premium.debtWithSlippage, '53'); assert.equal(premium.premiumIsBonus, false);
  assert.throws(() => m.hardSlicePremium(a, '50', m.Q72 / 2n, m.Q72 * 2n), /MaxSlippage/);
});

test('directional partial tranches: zero repay and full slice exact; partial geometry UNKNOWN', () => {
  const input = { tranches: [{ satInLAssets: '10', satRelativeToL: '100' }, { satInLAssets: '10', satRelativeToL: '100' }], lastTranche: 3, userAssetAmounts: ['1', '2', '3', '4', '5', '6'], netRepaidL: '1', netSeizedL: '0', netDebtX: true };
  assert.equal(m.partialTranches({ ...input, netRepaidL: '0' }).status, 'SOURCE_EXACT_ZERO_REPAY');
  assert.deepEqual(m.partialTranches({ ...input, netRepaidL: '100' }).amounts, input.userAssetAmounts);
  const partial = m.partialTranches(input);
  assert.equal(partial.status, 'UNKNOWN'); assert.equal(partial.includedTranches, 1); assert.equal(partial.boundaryTick, 100);
  assert.equal(m.partialTranches({ ...input, netDebtX: false }).boundaryTick, 75);
});

test('saturation premiums floor assets then CEIL shares and cap actual remaining balances', () => {
  assert.equal(m.saturationPremium('9999'), 0n); assert.equal(m.saturationPremium('10009'), 0n); assert.equal(m.saturationPremium('10010'), 1n);
  const r = m.saturationSeized({ depositAssets: ['10000', '10000', '1'], ratioBips: '10010', remainingShares: ['10', '1', '10'], rawAssets: ['2', '2', '2'], rawShares: ['3', '3', '3'] });
  assert.deepEqual(r.seizedAssets, ['1', '1', '0']);
  assert.deepEqual(r.seizedShares, ['2', '1', '0']);
  assert.equal(r.eligibility, 'UNKNOWN'); assert.equal(r.requiredMissingInputs.length, 2);
});

test('LEVERAGE standalone arithmetic uses geometric sqrt, deposit floor and repay ceil', () => {
  assert.equal(m.sqrt('15'), 3n);
  const r = m.leverageProjection({ assets: ['100000', '0', '0', '99100', '0', '0'], sqrtMin: m.Q72 / 2n, sqrtMax: m.Q72 * 2n });
  assert.equal(r.averageSqrtPrice, String(m.Q72)); assert.equal(r.depositL, '100000'); assert.equal(r.borrowL, '99100');
  assert.equal(r.premiumValueL, '10'); assert.equal(r.repayL, '10990'); assert.equal(r.seizedL, '11000');
  assert.equal(r.badDebt, false); assert.deepEqual(r.amounts, ['11000', '0', '0', '10990', '0', '0']);
  assert.equal(r.eligibilityComplete, false);
  const uneven = m.leverageProjection({ assets: ['100000', '0', '1', '99100', '1', '0'], sqrtMin: m.Q72, sqrtMax: m.Q72 });
  assert.equal(uneven.amounts[2], '0'); // floor(1 * seizedL / depositL)
  assert.equal(uneven.amounts[4], '1'); // ceil(1 * repayL / borrowL)
});

test('LEVERAGE threshold/revert, bad-debt and extreme zero-repay branches are not profit claims', () => {
  const common = { sqrtMin: m.Q72, sqrtMax: m.Q72 };
  assert.equal(m.leverageProjection({ ...common, assets: ['100000', '0', '0', '99010', '0', '0'] }).status, 'SOURCE_REVERT');
  const bad = m.leverageProjection({ ...common, assets: ['1000', '0', '0', '2000', '0', '0'] });
  assert.equal(bad.badDebt, true); assert.equal(bad.repayL, '899'); assert.equal(bad.seizedL, '1000');
  const extreme = m.leverageProjection({ ...common, assets: ['1000', '0', '0', '200000', '0', '0'] });
  assert.equal(extreme.repayL, '0'); assert.equal(extreme.badDebt, true); assert.equal(extreme.eligibility, 'UNKNOWN');
  assert.throws(() => m.leverageProjection({ ...common, assets: ['0', '0', '0', '11', '0', '0'] }), /division by zero/);
});

test('no borrow in the view only predicts pre-transition no-op; penalties keep eligibility UNKNOWN', () => {
  const r = m.accountBranches(zero());
  assert.equal(r.preTransitionNoBorrowWouldNoop, true); assert.equal(r.eligibility, 'UNKNOWN'); assert.equal(r.eligibilityComplete, false);
  for (const branch of ['HARD', 'SATURATION', 'LEVERAGE']) assert.equal(r[branch].status, 'UNKNOWN');
});

test('factory enumeration and debt transfers find both parties without ANY Borrow event, including index 3 only', async () => {
  const f = fixture(), r = await collectAmmalgamL(f.ctx);
  assert.deepEqual(r.coverage.errors, []); assert.equal(r.coverage.enumerationComplete, true); assert.equal(r.coverage.snapshotComplete, true);
  assert.deepEqual(r.pairs[0].accounts.map(a => a.account), [ALICE, BOB]);
  assert.equal(r.pairs[0].accounts[1].accounting.userAssets[3], '1');
  assert.equal(r.pairs[0].accounts[1].accounting.userAssets[0], '100');
  assert.equal(r.pairs[0].accounts[0].branches.preTransitionNoBorrowWouldNoop, true);
  assert.deepEqual(r.pairs[0].tokens, TOKENS);
  assert.equal(r.pairs[0].snapshot.receiptSupplyIsStoredSharesAuthority, false);
  assert.equal(r.pairs[0].snapshot.rawTotals.shares[0], '100');
  assert.equal(r.pairs[0].receiptTokenSupplies[0], '110');
  assert.ok(f.logsCalled.every(q => q.event === 'Transfer' || q.event === 'PairCreated'));
  for (const token of TOKENS.slice(3)) assert.deepEqual(f.logsCalled.filter(q => q.target === token).map(q => [q.fromBlock, q.toBlock]), [[10, 11], [12, 13]]);
  assert.equal(r.coverage.complete, false); assert.equal(r.classSemantics.exact, false); assert.equal(r.eligibilityComplete, false);
  assert.equal(r.pipeline.wired, false); assert.equal(r.liveAdmission, false); assert.equal(r.routePositive, 'unknown');
  assert.doesNotThrow(() => JSON.stringify(r));
});

test('zero-current-debt still retains transfer participants and cannot claim liquidation completeness', async () => {
  const f = fixture(); f.data.balances[BOB] = zero();
  const r = await collectAmmalgamL(f.ctx);
  assert.equal(r.coverage.snapshotComplete, true); assert.equal(r.pairs[0].accounts.length, 2);
  assert.equal(r.eligibility, 'UNKNOWN'); assert.equal(r.coverage.complete, false);
});

test('duplicate events dedup without losing logical range proof; conflicting duplicates fail', async () => {
  const a = fixture(); a.logs[TOKENS[3]].push({ ...a.logs[TOKENS[3]][0] });
  const ok = await collectAmmalgamL(a.ctx); assert.equal(ok.coverage.snapshotComplete, true); assert.equal(ok.coverage.duplicateEvents, 1);
  const b = fixture(); b.logs[TOKENS[3]].push({ ...b.logs[TOKENS[3]][0], args: { from: ZERO, to: AUTH, value: '1' } });
  await incomplete(b, /conflicting duplicate/);
});

test('unknown or too-late creation bounds and archive/history gaps never mean no debt', async () => {
  const a = fixture(); delete a.ctx.factoryCreation;
  await incomplete(a, /unknown creation/);
  const b = fixture(); b.ctx.factoryCreation.blockNumber = 6; b.ctx.factoryCreation.blockHash = hash(6);
  await incomplete(b, /omits prior history/);
  const c = fixture(), original = c.ctx.provider.getCode;
  c.ctx.provider.getCode = async (a, n) => { if (a === TOKENS[3] && n === 9) throw new Error('archive missing'); return original(a, n); };
  await incomplete(c, /AMMALGAM_PAIR_READ_FAILED/);
});

test('missing log ranges/truncation/caps and failed user reads cannot complete snapshots', async () => {
  const a = fixture(); a.ctx.caps.maxChunks = 1; await incomplete(a, /missing chunks/);
  const b = fixture(), logs = b.ctx.logReader; b.ctx.logReader = async q => ({ ...await logs(q), toBlock: q.toBlock - 1 }); await incomplete(b, /missing range/);
  const c = fixture(); intercept(c, 'balanceOf', r => ({ ...r, truncated: true })); await incomplete(c, /incomplete\/overflow/);
  const d = fixture(); intercept(d, 'balanceOf', () => { throw new Error('account read failed'); }); await incomplete(d, /AMMALGAM_PAIR_READ_FAILED/);
  const e = fixture(); e.ctx.caps.maxUsers = 1; await incomplete(e, /user cap/);
  const f = fixture(); f.ctx.caps.maxReads = 5; await incomplete(f, /read cap/);
  const g = fixture(); g.data.count = '2'; g.ctx.caps.maxPairs = 1; await incomplete(g, /pair cap/);
});

test('wrong chain/pin, source kind and mismatched cached implementation remain UNKNOWN', async () => {
  const a = fixture(); a.ctx.provider.getNetwork = async () => ({ chainId: 10n }); await incomplete(a, /wrong provider chain/);
  const b = fixture(); intercept(b, 'totalAssetsAndShares', r => ({ ...r, blockHash: hash(0) })); await incomplete(b, /wrong pin\/chain/);
  const c = fixture(); c.ctx.bindings.runtimes[IMPL].sourceKind = 'AmmalgamPair'; await incomplete(c, /source kind/);
  const d = fixture(), storage = d.ctx.provider.getStorage;
  d.ctx.provider.getStorage = async (a, s, n) => s === scanner.IMPLEMENTATION_SLOT ? `0x${'0'.repeat(24)}${AUTH.slice(2)}` : storage(a, s, n);
  await incomplete(d, /reinitialization\/static fallback/);
});

test('pair identity and runtime/library/authority bindings are independently checked', async () => {
  const a = fixture(); intercept(a, 'getPair', r => ({ ...r, value: AUTH })); await incomplete(a, /getPair mismatch/);
  const b = fixture(), original = b.ctx.provider.getCode;
  b.ctx.provider.getCode = async (a, n) => a === LIBRARIES.Validation ? '0x600200' : original(a, n); await incomplete(b, /runtime binding mismatch/);
  const c = fixture(); c.ctx.bindings.factoryAuthority.feeToSetter = BOB; await incomplete(c, /authority binding/);
  const d = fixture(); d.ctx.bindings.blockHash = hash(0); await incomplete(d, /wrong pin\/chain/);
});

test('fixed-pin log identity and final reorg checks are fail-closed', async () => {
  const a = fixture(); a.logs[TOKENS[3]][0].blockHash = hash(9); await incomplete(a, /history\/hash/);
  const b = fixture(), original = b.ctx.provider.getBlock; let pinReads = 0;
  b.ctx.provider.getBlock = async n => n === 13 && ++pinReads > 1 ? { number: n, hash: hash(0) } : original(n);
  await incomplete(b, /pin reorg/);
});

test('default context, unsafe numbers and zero denominators do not invent complete semantics', async () => {
  const r = await collectAmmalgamL(); assert.equal(r.coverage.snapshotComplete, false); assert.equal(r.eligibility, 'UNKNOWN');
  assert.throws(() => m.u(Number.MAX_SAFE_INTEGER + 1), /unsafe/);
  assert.throws(() => m.mulDiv(1, 1, 0), /division by zero/);
});

function privateFailure(label) {
  const sentinels = ['MESSAGE', 'CODE', 'STACK', 'BODY', 'HEADER', 'CALLDATA', 'CAUSE'].map(k => `FAKE_AMMALGAM_${label}_${k}_SECRET`);
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
  assert.equal(result.pipeline.wired, false); assert.equal(result.liveAdmission, false);
}

test('privacy: provider binding and contracts binding errors expose only fixed capture codes', async () => {
  for (const dependency of ['provider', 'contracts']) {
    const f = fixture(), secret = privateFailure(dependency);
    if (dependency === 'provider') f.ctx.provider.getCode = async () => { throw secret.failure; };
    else intercept(f, 'pairBeacon', () => { throw secret.failure; });
    const r = await collectAmmalgamL(f.ctx);
    assertPrivateFailure(r, secret, 'AMMALGAM_CAPTURE_FAILED');
    assert.deepEqual(r.coverage.errors, ['AMMALGAM_CAPTURE_FAILED']);
  }
});

test('privacy: pair/account read failures preserve partial rows without dependency payloads', async () => {
  for (const stage of ['PAIR', 'ACCOUNT']) {
    const f = fixture(), secret = privateFailure(stage);
    if (stage === 'PAIR') intercept(f, 'getReserves', () => { throw secret.failure; });
    else intercept(f, 'balanceOf', (r, q) => { if (q.args[0] === ALICE) throw secret.failure; return r; });
    const r = await collectAmmalgamL(f.ctx);
    assertPrivateFailure(r, secret, `AMMALGAM_${stage}_READ_FAILED`);
    assert.equal(r.pairs.length, 1); assert.equal(r.pairs[0].pair, PAIR);
    if (stage === 'PAIR') assert.deepEqual(r.pairs[0].errors, ['AMMALGAM_PAIR_READ_FAILED']);
    else {
      assert.equal(r.pairs[0].accounts[0].error, 'AMMALGAM_ACCOUNT_READ_FAILED');
      assert.equal(r.pairs[0].accounts[0].status, 'UNKNOWN');
      assert.equal(r.pairs[0].accounts[1].status, 'SNAPSHOT_ONLY');
    }
  }
});

test('privacy: logreader errors and error envelopes never serialize nested diagnostics', async () => {
  for (const mode of ['throw', 'envelope']) {
    const f = fixture(), secret = privateFailure(`LOG_${mode}`), original = f.ctx.logReader;
    f.ctx.logReader = async q => {
      if (q.target !== TOKENS[3]) return original(q);
      if (mode === 'throw') throw secret.failure;
      return { ...await original(q), error: secret.failure };
    };
    const r = await collectAmmalgamL(f.ctx);
    assertPrivateFailure(r, secret, 'AMMALGAM_LOG_CHUNK_FAILED');
    assert.equal(r.coverage.logChunks, 11);
  }
});

test('privacy: terminal pin failure keeps observations incomplete and drops error properties', async () => {
  const f = fixture(), secret = privateFailure('TERMINAL'), original = f.ctx.provider.getBlock;
  let pinReads = 0;
  f.ctx.provider.getBlock = async n => { if (n === 13 && ++pinReads > 1) throw secret.failure; return original(n); };
  const r = await collectAmmalgamL(f.ctx);
  assertPrivateFailure(r, secret, 'AMMALGAM_FINAL_PIN_FAILED');
  assert.equal(r.pairs[0].accounts.length, 2);
  assert.equal(r.coverage.errors.at(-1), 'AMMALGAM_FINAL_PIN_FAILED');
});

test('privacy: forged local error labels and hostile error getters cannot supply validation detail', async () => {
  const forged = new Error('wrong pin/chain'); forged.name = 'ObserverValidationError'; forged.code = 'wrong pin/chain';
  const unreadable = new Proxy({}, { get() { throw new Error('FAKE_AMMALGAM_ERROR_PROPERTY_READ'); } });
  for (const failure of [forged, unreadable, 'FAKE_AMMALGAM_THROWN_STRING_SECRET']) {
    const f = fixture(); f.ctx.provider.getCode = async () => { throw failure; };
    const r = await collectAmmalgamL(f.ctx);
    assert.deepEqual(r.coverage.errors, ['AMMALGAM_CAPTURE_FAILED']);
    assert.equal(r.coverage.snapshotComplete, false);
  }
});

test('privacy: pin output whitelists only validated chain/block/hash, never unknown metadata', async () => {
  const f = fixture(), secret = privateFailure('PIN_METADATA');
  const expected = { ...f.ctx.pin };
  f.ctx.pin = { ...expected, url: secret.failure.message, headers: secret.failure.headers, body: secret.failure.body, error: secret.failure, toJSON() { return secret.sentinels[6]; } };
  const r = await collectAmmalgamL(f.ctx), json = JSON.stringify(r);
  assert.deepEqual(r.pin, expected); assert.deepEqual(Object.keys(r.pin), ['chainId', 'blockNumber', 'blockHash']);
  for (const sentinel of secret.sentinels) assert.equal(json.includes(sentinel), false, 'unknown pin metadata leaked');
  assert.equal(r.coverage.snapshotComplete, true);
});
