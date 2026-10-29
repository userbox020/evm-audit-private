#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const producer = require('./run-critical-valantis-stex-profit-trigger.js');
const h = require('./capture-critical-valantis-stex-khype-deployment-economics-step2s.js');

const A = Object.freeze({
  stex: '0x1111111111111111111111111111111111111111',
  withdrawal: '0x2222222222222222222222222222222222222222',
  manager: '0x3333333333333333333333333333333333333333',
  accountantProxy: '0x4444444444444444444444444444444444444444',
  pool: '0x5555555555555555555555555555555555555555',
  kHYPE: '0x6666666666666666666666666666666666666666',
  WHYPE: '0x7777777777777777777777777777777777777777',
  fee: '0x8888888888888888888888888888888888888888',
  lens: '0x9999999999999999999999999999999999999999'
});
const WORD = value => BigInt(value).toString(16).padStart(64, '0');
const UINT = value => `0x${WORD(value)}`;
const ADDRESS = value => `0x${'0'.repeat(24)}${value.slice(2).toLowerCase()}`;
const TUPLE = values => `0x${values.map(WORD).join('')}`;
const HEADER = (number, hashByte = 'ab') => ({
  number: `0x${BigInt(number).toString(16)}`, hash: `0x${hashByte.repeat(32)}`,
  stateRoot: `0x${'cd'.repeat(32)}`, timestamp: `0x${(1700000000n + BigInt(number)).toString(16)}`
});

class FixtureRpc {
  constructor(fixture) { this.fixture = fixture; this.networkCalls = 0; this.methods = []; this.headerIndex = 0; }
  async call(method, params) {
    this.networkCalls += 1;
    this.methods.push(method);
    if (this.fixture.malformedAt === this.networkCalls) throw new h.CaptureError('RPC_SCHEMA', 'INVALID_RESPONSE_SCHEMA');
    if (method === 'eth_chainId') return '0x3e7';
    if (method === 'eth_getBlockByNumber') return this.fixture.headers[Math.min(this.headerIndex++, this.fixture.headers.length - 1)];
    if (method !== 'eth_call') throw new Error('UNEXPECTED_METHOD');
    return this.ethCall(params[0]);
  }
  async batch(entries) {
    this.networkCalls += 1;
    this.methods.push('BATCH');
    if (this.fixture.batchMalformed) throw new h.CaptureError('RPC_SCHEMA', 'INVALID_BATCH_RESPONSE');
    return entries.map(entry => this.ethCall(entry.params[0]));
  }
  ethCall(call) {
    const selector = call.data.slice(2, 10);
    if (selector === h.SELECTOR.stexPaused) return UINT(this.fixture.paused ? 1 : 0);
    if (selector === h.SELECTOR.stexWithdrawal) return ADDRESS(A.withdrawal);
    if (selector === h.SELECTOR.withdrawalManager) return ADDRESS(A.manager);
    if (selector === h.SELECTOR.withdrawalAccountant) return ADDRESS(A.accountantProxy);
    if (selector === h.SELECTOR.pendingCount) return UINT(this.fixture.rows.length);
    if (selector === h.SELECTOR.pendingIdAt) {
      const index = Number(BigInt(`0x${call.data.slice(-64)}`));
      return UINT(this.fixture.rows[index].id);
    }
    if (selector === h.SELECTOR.withdrawalRequests) {
      const id = BigInt(`0x${call.data.slice(-64)}`).toString();
      const row = this.fixture.rows.find(item => String(item.id) === id);
      return TUPLE([row.hype, row.khype, 0, 0, 1]);
    }
    if (selector === h.SELECTOR.kHypeToHype) {
      const khype = BigInt(`0x${call.data.slice(-64)}`).toString();
      return UINT(this.fixture.rows.find(item => String(item.khype) === khype).current);
    }
    if (selector === h.SELECTOR.poolReserves) return TUPLE([500, this.fixture.liquidity.reserve]);
    if (selector === h.SELECTOR.balanceOf) return UINT(this.fixture.liquidity.balance);
    if (selector === h.SELECTOR.poolManagerFees) return TUPLE([1, this.fixture.liquidity.managerFee]);
    if (selector === h.SELECTOR.poolProtocolFee1) return UINT(this.fixture.liquidity.protocolFee);
    if (selector === h.SELECTOR.pendingToken1) return UINT(this.fixture.liquidity.pending);
    if (selector === h.SELECTOR.claimableToken1) return UINT(this.fixture.liquidity.claimable);
    throw new Error(`UNEXPECTED_SELECTOR_${selector}`);
  }
}

function fixture(overrides = {}) {
  return {
    paused: false,
    rows: [],
    headers: [HEADER(10), HEADER(10)],
    liquidity: { reserve: 1000, balance: 900, managerFee: 10, protocolFee: 5, pending: 20, claimable: 5 },
    ...overrides
  };
}

async function run(value) {
  const rpc = new FixtureRpc(value);
  const artifact = await producer.runTrigger({ rpc, seeds: A, sourceCurrent: 'PASS', now: () => 1700000000000 });
  assert.equal(producer.validateArtifact(artifact), true);
  assert.equal(artifact.safety.networkCalls, rpc.networkCalls);
  assert.ok(rpc.networkCalls < 60);
  assert.equal(rpc.methods.some(method => /send|transaction|sign|fork/i.test(method)), false);
  assert.equal(/https?:\/\/|authorization\s*:|bearer\s|api[_-]?key|rpc_endpoints|\.env\b/i.test(JSON.stringify(artifact)), false);
  return { artifact, rpc };
}

test('paused is blocked without request or liquidity reads', async () => {
  const { artifact, rpc } = await run(fixture({ paused: true }));
  assert.equal(artifact.trigger.status, 'BLOCKED_PAUSED');
  assert.equal(artifact.liquidity.status, 'NOT_RUN');
  assert.equal(rpc.methods.includes('BATCH'), false);
});

test('zero pending is blocked', async () => {
  const { artifact } = await run(fixture());
  assert.equal(artifact.trigger.status, 'BLOCKED_NO_PENDING');
  assert.equal(artifact.trigger.pendingCount, 0);
});

test('nonpositive gap is blocked and liquidity is not read', async () => {
  const rows = [{ id: 4, hype: 100, khype: 90, current: 90 }];
  const { artifact, rpc } = await run(fixture({ rows }));
  assert.equal(artifact.trigger.status, 'BLOCKED_NONPOSITIVE_GAP');
  assert.equal(artifact.trigger.totalGapRaw, '-10');
  assert.equal(artifact.liquidity.status, 'NOT_RUN');
  assert.equal(rpc.methods.includes('BATCH'), false);
});

test('positive gap conditionally reads liquidity and emits gross-only economics', async () => {
  const rows = [{ id: 7, hype: 100, khype: 100, current: 130 }];
  const { artifact, rpc } = await run(fixture({ rows }));
  assert.equal(artifact.trigger.status, 'POSITIVE');
  assert.equal(artifact.requests[0].gapRaw, '30');
  assert.equal(rpc.methods.filter(method => method === 'BATCH').length, 1);
  assert.deepEqual(artifact.liquidity, {
    status: 'COMPLETE', whypeBalanceRaw: '900', whypeReserveRaw: '1000',
    liabilityHaircutRaw: '40', conservativeAvailableRaw: '860'
  });
  assert.equal(artifact.economics.status, 'TRIGGER_POSITIVE_GROSS_ONLY');
  assert.equal(artifact.economics.grossCeilingRaw, '30');
  assert.equal(artifact.economics.conservativeNetRaw, null);
});

test('block drift downgrades otherwise complete trigger to incomplete', async () => {
  const { artifact } = await run(fixture({ headers: [HEADER(10, 'aa'), HEADER(11, 'bb')] }));
  assert.equal(artifact.blockWindow.stable, false);
  assert.equal(artifact.trigger.status, 'INCOMPLETE');
});

test('malformed RPC produces truthful schema-valid incomplete output', async () => {
  const { artifact } = await run(fixture({ malformedAt: 1 }));
  assert.equal(artifact.trigger.status, 'INCOMPLETE');
  assert.equal(artifact.chainId, null);
});

test('pending row cap rejects 17 rows before enumeration', async () => {
  const rows = Array.from({ length: 17 }, (_, id) => ({ id, hype: 1, khype: id + 1, current: 2 }));
  const { artifact, rpc } = await run(fixture({ rows }));
  assert.equal(artifact.trigger.status, 'INCOMPLETE');
  assert.equal(artifact.trigger.pendingCount, 17);
  assert.deepEqual(artifact.requests, []);
  assert.ok(rpc.networkCalls < 10);
});

test('worst-case 16 active rows remains below network cap with one liquidity batch', async () => {
  const rows = Array.from({ length: 16 }, (_, id) => ({ id, hype: 1, khype: id + 1, current: 2 }));
  const { artifact, rpc } = await run(fixture({ rows }));
  assert.equal(artifact.trigger.status, 'POSITIVE');
  assert.equal(artifact.requests.length, 16);
  assert.equal(rpc.networkCalls, 57);
});

test('strict transport rejects malformed RPC response without retry', async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    const bytes = Buffer.from('{}');
    return { redirected: false, status: 200, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes };
  };
  const rpc = producer.createRpcTransport({ fetchImpl, now: () => 1 });
  await assert.rejects(rpc.call('eth_chainId', []), error => error && error.code === 'INVALID_RESPONSE_SCHEMA');
  assert.equal(fetches, 1);
  assert.equal(rpc.networkCalls, 1);
});
