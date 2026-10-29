#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const h = require('./capture-critical-valantis-stex-khype-deployment-economics-step2s.js');

const CLAIM = 'critical/stex-profit-trigger-producer';
const WORKSPACE = path.resolve(__dirname, '..');
const OUTPUT = path.join(WORKSPACE, 'reports', 'monitor', 'stex-profit-trigger.json');
const OFFICIAL_RPC = 'https://rpc.hyperliquid.xyz/evm';
const SCHEMA = 'stex-profit-trigger/v1';
const EVIDENCE_CLASS = 'SCREENING_ONLY_OFFICIAL_LATEST_REORGABLE';
const MAX_NETWORK_CALLS = 59;
const MAX_ROWS = 16;
const DEADLINE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const TOP_KEYS = Object.freeze(['schema', 'generatedAt', 'chainId', 'evidenceClass', 'blockWindow', 'trigger', 'requests', 'liquidity', 'economics', 'gates', 'safety']);
const GATE_KEYS = Object.freeze(['triggerObserved', 'sourceCurrent', 'runtimeReachability', 'economicsComplete', 'liquidityExit', 'conservativeNetPositive', 'keylessForkJustified']);
const ECONOMICS_KEYS = Object.freeze(['status', 'capitalRaw', 'grossCeilingRaw', 'feesRaw', 'gasRaw', 'carryRaw', 'exitHaircutRaw', 'uncertaintyRaw', 'conservativeNetRaw', 'netBps', 'capacityRaw']);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && h.stable(Object.keys(value).sort()) === h.stable([...keys].sort());
}

function unsigned(value) { return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value); }
function signed(value) { return typeof value === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(value); }
function nullableUnsigned(value) { return value === null || unsigned(value); }
function nullableSigned(value) { return value === null || signed(value); }
function hash32(value) { return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value); }
function gate(value) { return ['PASS', 'FAIL', 'UNKNOWN'].includes(value); }

function validateHeader(value, nullable) {
  return exactKeys(value, ['number', 'hash', 'timestamp'])
    && ((nullable && value.number === null && value.hash === null && value.timestamp === null)
      || (unsigned(value.number) && hash32(value.hash) && unsigned(value.timestamp)));
}

function validateArtifact(value) {
  try {
    if (!exactKeys(value, TOP_KEYS) || value.schema !== SCHEMA || value.evidenceClass !== EVIDENCE_CLASS
        || typeof value.generatedAt !== 'string' || new Date(value.generatedAt).toISOString() !== value.generatedAt
        || !(value.chainId === null || value.chainId === 999)) return false;
    if (!exactKeys(value.blockWindow, ['before', 'after', 'stable'])
        || !validateHeader(value.blockWindow.before, true) || !validateHeader(value.blockWindow.after, true)
        || ![true, false, null].includes(value.blockWindow.stable)) return false;
    const trigger = value.trigger;
    if (!exactKeys(trigger, ['status', 'paused', 'pendingCount', 'activeRows', 'positiveGap', 'totalGapRaw'])
        || !['INCOMPLETE', 'BLOCKED_PAUSED', 'BLOCKED_NO_PENDING', 'BLOCKED_NONPOSITIVE_GAP', 'POSITIVE'].includes(trigger.status)
        || !(trigger.paused === null || typeof trigger.paused === 'boolean')
        || !(trigger.pendingCount === null || Number.isInteger(trigger.pendingCount) && trigger.pendingCount >= 0)
        || !(trigger.activeRows === null || Number.isInteger(trigger.activeRows) && trigger.activeRows >= 0 && trigger.activeRows <= MAX_ROWS)
        || !(trigger.positiveGap === null || typeof trigger.positiveGap === 'boolean')
        || !nullableSigned(trigger.totalGapRaw)) return false;
    if (!Array.isArray(value.requests) || value.requests.length > MAX_ROWS) return false;
    const ids = new Set();
    for (const request of value.requests) {
      if (!exactKeys(request, ['id', 'kHYPEAmountRaw', 'fixedHypeAmountRaw', 'currentHypeValueRaw', 'gapRaw'])
          || !unsigned(request.id) || ids.has(request.id) || !unsigned(request.kHYPEAmountRaw)
          || !unsigned(request.fixedHypeAmountRaw) || !unsigned(request.currentHypeValueRaw)
          || !signed(request.gapRaw)) return false;
      ids.add(request.id);
    }
    if (trigger.activeRows !== null && trigger.activeRows !== value.requests.length) return false;
    const liquidity = value.liquidity;
    if (!exactKeys(liquidity, ['status', 'whypeBalanceRaw', 'whypeReserveRaw', 'liabilityHaircutRaw', 'conservativeAvailableRaw'])
        || !['NOT_RUN', 'INCOMPLETE', 'COMPLETE'].includes(liquidity.status)
        || ![liquidity.whypeBalanceRaw, liquidity.whypeReserveRaw, liquidity.liabilityHaircutRaw, liquidity.conservativeAvailableRaw].every(nullableUnsigned)) return false;
    if (liquidity.status === 'NOT_RUN' && [liquidity.whypeBalanceRaw, liquidity.whypeReserveRaw, liquidity.liabilityHaircutRaw, liquidity.conservativeAvailableRaw].some(item => item !== null)) return false;
    if (liquidity.status === 'COMPLETE' && [liquidity.whypeBalanceRaw, liquidity.whypeReserveRaw, liquidity.liabilityHaircutRaw, liquidity.conservativeAvailableRaw].some(item => item === null)) return false;
    const economics = value.economics;
    if (!exactKeys(economics, ECONOMICS_KEYS)
        || !['NOT_RUN', 'INCOMPLETE', 'NEGATIVE', 'TRIGGER_POSITIVE_GROSS_ONLY'].includes(economics.status)
        || ![economics.capitalRaw, economics.grossCeilingRaw, economics.feesRaw, economics.gasRaw, economics.carryRaw, economics.exitHaircutRaw, economics.uncertaintyRaw, economics.capacityRaw].every(nullableUnsigned)
        || !nullableSigned(economics.conservativeNetRaw) || !nullableSigned(economics.netBps)) return false;
    if (!exactKeys(value.gates, GATE_KEYS) || !Object.values(value.gates).every(gate)) return false;
    if (!exactKeys(value.safety, ['networkCalls', 'automaticRetries', 'transactions', 'signing', 'broadcast'])
        || !Number.isInteger(value.safety.networkCalls) || value.safety.networkCalls < 0 || value.safety.networkCalls >= 60
        || value.safety.automaticRetries !== 0 || value.safety.transactions !== 0
        || value.safety.signing !== false || value.safety.broadcast !== false) return false;
    const serialized = JSON.stringify(value);
    return !/(?:https?:\/\/|authorization\s*:|bearer\s|api[_-]?key|rpc_endpoints|\.env\b)/i.test(serialized);
  } catch (_) { return false; }
}

function emptyHeader() { return { number: null, hash: null, timestamp: null }; }
function emptyLiquidity(status = 'NOT_RUN') {
  return { status, whypeBalanceRaw: null, whypeReserveRaw: null, liabilityHaircutRaw: null, conservativeAvailableRaw: null };
}
function emptyEconomics(status = 'NOT_RUN') {
  return {
    status, capitalRaw: null, grossCeilingRaw: null, feesRaw: null, gasRaw: null, carryRaw: null,
    exitHaircutRaw: null, uncertaintyRaw: null, conservativeNetRaw: null, netBps: null, capacityRaw: null
  };
}

function baseArtifact(now, sourceCurrent = 'UNKNOWN') {
  return {
    schema: SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    chainId: null,
    evidenceClass: EVIDENCE_CLASS,
    blockWindow: { before: emptyHeader(), after: emptyHeader(), stable: null },
    trigger: { status: 'INCOMPLETE', paused: null, pendingCount: null, activeRows: null, positiveGap: null, totalGapRaw: null },
    requests: [],
    liquidity: emptyLiquidity(),
    economics: emptyEconomics(),
    gates: {
      triggerObserved: 'UNKNOWN', sourceCurrent, runtimeReachability: 'UNKNOWN', economicsComplete: 'FAIL',
      liquidityExit: 'UNKNOWN', conservativeNetPositive: 'UNKNOWN', keylessForkJustified: 'UNKNOWN'
    },
    safety: { networkCalls: 0, automaticRetries: 0, transactions: 0, signing: false, broadcast: false }
  };
}

function normalizedHeader(raw) {
  const header = h.parseHeader(raw);
  return { number: BigInt(header.number).toString(), hash: header.hash, timestamp: BigInt(header.timestamp).toString() };
}

function createRpcTransport(options = {}) {
  const endpoint = h.validateEndpoint(options.endpoint || OFFICIAL_RPC);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const deadline = now() + (options.deadlineMs || DEADLINE_MS);
  if (typeof fetchImpl !== 'function') throw new h.CaptureError('CAPTURE', 'FETCH_UNAVAILABLE');
  let nextId = 0;
  let networkCalls = 0;

  async function send(entries) {
    if (!Array.isArray(entries) || entries.length === 0) throw new h.CaptureError('RPC_SCHEMA', 'EMPTY_REQUEST');
    if (networkCalls >= MAX_NETWORK_CALLS) throw new h.CaptureError('CAPS', 'NETWORK_CALL_CAP');
    if (now() >= deadline) throw new h.CaptureError('CAPS', 'WALL_CLOCK_CAP');
    const requests = entries.map(entry => {
      h.assertRpcAllowed(entry.method);
      nextId += 1;
      return { jsonrpc: '2.0', id: nextId, method: entry.method, params: entry.params };
    });
    networkCalls += 1;
    const controller = new AbortController();
    const requestDeadline = Math.min(deadline, now() + REQUEST_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(), Math.max(1, requestDeadline - now()));
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requests.length === 1 ? requests[0] : requests),
        redirect: 'error', signal: controller.signal
      });
      const body = await h.readBoundedResponse(response, { signal: controller.signal, deadlineMs: requestDeadline, now });
      if (requests.length === 1) return [h.validateRpcResponse(body, requests[0].id)];
      if (!Array.isArray(body) || body.length !== requests.length) throw new h.CaptureError('RPC_SCHEMA', 'INVALID_BATCH_RESPONSE');
      const byId = new Map();
      for (const item of body) {
        if (!item || !Number.isInteger(item.id) || byId.has(item.id)) throw new h.CaptureError('RPC_SCHEMA', 'INVALID_BATCH_RESPONSE');
        byId.set(item.id, item);
      }
      return requests.map(request => {
        if (!byId.has(request.id)) throw new h.CaptureError('RPC_SCHEMA', 'INVALID_BATCH_RESPONSE');
        return h.validateRpcResponse(byId.get(request.id), request.id);
      });
    } catch (error) {
      if (error instanceof h.CaptureError) throw error;
      throw new h.CaptureError('RPC_READ', 'BOUNDED_TRANSPORT_FAILURE');
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    call: async (method, params) => (await send([{ method, params }]))[0],
    batch: send,
    get networkCalls() { return networkCalls; }
  });
}

function callData(to, selector, words = []) {
  return { to: h.normalizeAddress(to), data: h.calldata(selector, words) };
}

async function runTrigger(options = {}) {
  const now = options.now || Date.now;
  const sourceCurrent = options.sourceCurrent || 'UNKNOWN';
  const artifact = baseArtifact(now, sourceCurrent);
  const rpc = options.rpc || createRpcTransport(options);
  const seeds = options.seeds;
  let coreComplete = false;
  let positiveGapSum = 0n;
  let beforeRead = false;

  const call = async (method, params) => rpc.call(method, params);
  const raw = async (to, selector, words = []) => h.normalizeHex(await call('eth_call', [callData(to, selector, words), 'latest']));
  const address = async (to, selector, words = []) => h.wordAddress(h.decodeScalarWord(await raw(to, selector, words)));
  const uint = async (to, selector, words = []) => h.wordUint(h.decodeScalarWord(await raw(to, selector, words)));
  const bool = async (to, selector, words = []) => h.wordBool(h.decodeScalarWord(await raw(to, selector, words)));

  try {
    const chainId = Number(BigInt(h.normalizeQuantity(await call('eth_chainId', []))));
    if (chainId !== 999) throw new h.CaptureError('PIN', 'CHAIN_ID_MISMATCH');
    artifact.chainId = chainId;
    artifact.blockWindow.before = normalizedHeader(await call('eth_getBlockByNumber', ['latest', false]));
    beforeRead = true;
    artifact.trigger.paused = await bool(seeds.stex, h.SELECTOR.stexPaused);
    if (artifact.trigger.paused) {
      artifact.trigger.status = 'BLOCKED_PAUSED';
      artifact.trigger.pendingCount = null;
      artifact.trigger.activeRows = 0;
      artifact.trigger.positiveGap = false;
      artifact.trigger.totalGapRaw = '0';
      coreComplete = true;
    } else {
      const withdrawal = await address(seeds.stex, h.SELECTOR.stexWithdrawal);
      const manager = await address(withdrawal, h.SELECTOR.withdrawalManager);
      const accountant = await address(withdrawal, h.SELECTOR.withdrawalAccountant);
      const pendingRaw = await uint(withdrawal, h.SELECTOR.pendingCount);
      const pendingCount = Number(BigInt(pendingRaw));
      artifact.trigger.pendingCount = pendingCount;
      if (!Number.isSafeInteger(pendingCount) || pendingCount > MAX_ROWS) throw new h.CaptureError('CAPS', 'PENDING_ROW_CAP');
      if (pendingCount === 0) {
        artifact.trigger.status = 'BLOCKED_NO_PENDING';
        artifact.trigger.activeRows = 0;
        artifact.trigger.positiveGap = false;
        artifact.trigger.totalGapRaw = '0';
        coreComplete = true;
      } else {
        let totalGap = 0n;
        for (let index = 0n; index < BigInt(pendingCount); index += 1n) {
          const id = await uint(withdrawal, h.SELECTOR.pendingIdAt, [h.encodeWord(index)]);
          const tuple = h.decodeRequestTuple(await raw(manager, h.SELECTOR.withdrawalRequests, [h.encodeAddress(withdrawal), h.encodeWord(id)]));
          if (BigInt(tuple.hypeAmount) === 0n) continue;
          const current = await uint(accountant, h.SELECTOR.kHypeToHype, [h.encodeWord(tuple.kHYPEAmount)]);
          const gap = BigInt(current) - BigInt(tuple.hypeAmount);
          totalGap += gap;
          if (gap > 0n) positiveGapSum += gap;
          artifact.requests.push({
            id, kHYPEAmountRaw: tuple.kHYPEAmount, fixedHypeAmountRaw: tuple.hypeAmount,
            currentHypeValueRaw: current, gapRaw: gap.toString()
          });
        }
        artifact.trigger.activeRows = artifact.requests.length;
        artifact.trigger.positiveGap = positiveGapSum > 0n;
        artifact.trigger.totalGapRaw = totalGap.toString();
        artifact.trigger.status = positiveGapSum > 0n ? 'POSITIVE' : 'BLOCKED_NONPOSITIVE_GAP';
        coreComplete = true;
        if (positiveGapSum > 0n) {
          artifact.liquidity = emptyLiquidity('INCOMPLETE');
          artifact.economics = emptyEconomics('INCOMPLETE');
          const entries = [
            { method: 'eth_call', params: [callData(seeds.pool, h.SELECTOR.poolReserves), 'latest'] },
            { method: 'eth_call', params: [callData(seeds.WHYPE, h.SELECTOR.balanceOf, [h.encodeAddress(seeds.pool)]), 'latest'] },
            { method: 'eth_call', params: [callData(seeds.pool, h.SELECTOR.poolManagerFees), 'latest'] },
            { method: 'eth_call', params: [callData(seeds.pool, h.SELECTOR.poolProtocolFee1), 'latest'] },
            { method: 'eth_call', params: [callData(withdrawal, h.SELECTOR.pendingToken1), 'latest'] },
            { method: 'eth_call', params: [callData(withdrawal, h.SELECTOR.claimableToken1), 'latest'] }
          ];
          const values = await rpc.batch(entries);
          const reserves = h.decodeStaticTuple(h.normalizeHex(values[0]), 2);
          const managerFees = h.decodeStaticTuple(h.normalizeHex(values[2]), 2);
          const whypeReserve = BigInt(h.wordUint(reserves[1]));
          const whypeBalance = BigInt(h.wordUint(h.decodeScalarWord(h.normalizeHex(values[1]))));
          const managerFee1 = BigInt(h.wordUint(managerFees[1]));
          const protocolFee1 = BigInt(h.wordUint(h.decodeScalarWord(h.normalizeHex(values[3]))));
          const pending1 = BigInt(h.wordUint(h.decodeScalarWord(h.normalizeHex(values[4]))));
          const claimable1 = BigInt(h.wordUint(h.decodeScalarWord(h.normalizeHex(values[5]))));
          const haircut = managerFee1 + protocolFee1 + pending1 + claimable1;
          const grossLiquidity = whypeReserve < whypeBalance ? whypeReserve : whypeBalance;
          const available = grossLiquidity > haircut ? grossLiquidity - haircut : 0n;
          artifact.liquidity = {
            status: 'COMPLETE', whypeBalanceRaw: whypeBalance.toString(), whypeReserveRaw: whypeReserve.toString(),
            liabilityHaircutRaw: haircut.toString(), conservativeAvailableRaw: available.toString()
          };
          const grossCeiling = positiveGapSum < available ? positiveGapSum : available;
          artifact.economics = {
            ...emptyEconomics('TRIGGER_POSITIVE_GROSS_ONLY'),
            grossCeilingRaw: grossCeiling.toString(), capacityRaw: available.toString()
          };
        }
      }
    }
  } catch (_) {
    artifact.trigger.status = 'INCOMPLETE';
    if (artifact.economics.status !== 'NOT_RUN') artifact.economics.status = 'INCOMPLETE';
  } finally {
    if (beforeRead) {
      try { artifact.blockWindow.after = normalizedHeader(await call('eth_getBlockByNumber', ['latest', false])); }
      catch (_) { artifact.trigger.status = 'INCOMPLETE'; }
    }
    artifact.safety.networkCalls = rpc.networkCalls;
  }

  const before = artifact.blockWindow.before;
  const after = artifact.blockWindow.after;
  if (before.number !== null && after.number !== null) {
    artifact.blockWindow.stable = before.number === after.number && before.hash === after.hash;
    if (!artifact.blockWindow.stable) artifact.trigger.status = 'INCOMPLETE';
  }
  if (!coreComplete) artifact.trigger.status = 'INCOMPLETE';
  const status = artifact.trigger.status;
  artifact.gates.triggerObserved = status === 'POSITIVE' ? 'PASS' : status === 'INCOMPLETE' ? 'UNKNOWN' : 'FAIL';
  artifact.gates.runtimeReachability = coreComplete ? 'PASS' : 'UNKNOWN';
  artifact.gates.economicsComplete = 'FAIL';
  artifact.gates.liquidityExit = artifact.liquidity.status === 'COMPLETE'
    ? BigInt(artifact.liquidity.conservativeAvailableRaw) > 0n ? 'PASS' : 'FAIL' : 'UNKNOWN';
  artifact.gates.conservativeNetPositive = artifact.economics.status === 'NEGATIVE' ? 'FAIL' : 'UNKNOWN';
  artifact.gates.keylessForkJustified = status === 'POSITIVE' && artifact.economics.status === 'TRIGGER_POSITIVE_GROSS_ONLY' ? 'PASS'
    : status === 'INCOMPLETE' ? 'UNKNOWN' : 'FAIL';
  if (!validateArtifact(artifact)) throw new h.CaptureError('SCHEMA', 'OUTPUT_SCHEMA_INVALID');
  return artifact;
}

function fsyncDirectory(directory, fsImpl) {
  const fd = fsImpl.openSync(directory, 'r');
  try { try { fsImpl.fsyncSync(fd); } catch (error) { if (!['EINVAL', 'EPERM', 'EBADF'].includes(error.code)) throw error; } }
  finally { fsImpl.closeSync(fd); }
}

function publishAtomic(artifact, options = {}) {
  if (!validateArtifact(artifact)) throw new h.CaptureError('SCHEMA', 'OUTPUT_SCHEMA_INVALID');
  const fsImpl = options.fsImpl || fs;
  const target = path.resolve(options.outputPath || OUTPUT);
  const allowedRoot = path.resolve(options.allowedRoot || path.dirname(target));
  if (path.dirname(target) !== allowedRoot || path.basename(target) !== 'stex-profit-trigger.json') {
    throw new h.CaptureError('PUBLISH', 'OUTPUT_PATH_REJECTED');
  }
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const temporary = path.join(allowedRoot, `.stex-profit-trigger.json.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  let fd;
  try {
    fd = fsImpl.openSync(temporary, 'wx', 0o600);
    fsImpl.writeFileSync(fd, bytes);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(temporary, target);
    fsyncDirectory(allowedRoot, fsImpl);
    const readback = fsImpl.readFileSync(target);
    const decoded = JSON.parse(readback.toString('utf8'));
    if (!readback.equals(bytes) || !validateArtifact(decoded)) throw new h.CaptureError('PUBLISH', 'READBACK_INVALID');
    return target;
  } finally {
    if (fd !== undefined) try { fsImpl.closeSync(fd); } catch (_) {}
    if (fsImpl.existsSync(temporary)) try { fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}

function authoritySeeds(authority) {
  return Object.fromEntries(Object.entries(authority.candidateSeeds)
    .filter(([key]) => key !== 'chainId').map(([key, value]) => [key, h.normalizeAddress(value)]));
}

async function runAndPublish(options = {}) {
  const now = options.now || Date.now;
  let artifact;
  try {
    const authority = options.authority || h.preflightAuthority({ root: WORKSPACE });
    artifact = await runTrigger({ ...options, now, seeds: options.seeds || authoritySeeds(authority), sourceCurrent: 'PASS' });
  } catch (_) {
    artifact = baseArtifact(now, 'UNKNOWN');
  }
  if (!validateArtifact(artifact)) throw new h.CaptureError('SCHEMA', 'OUTPUT_SCHEMA_INVALID');
  publishAtomic(artifact, options);
  return artifact;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) throw new h.CaptureError('CLI', 'ARGUMENTS_REJECTED');
  await runAndPublish();
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({
  CLAIM, SCHEMA, EVIDENCE_CLASS, MAX_NETWORK_CALLS, MAX_ROWS, OUTPUT,
  validateArtifact, baseArtifact, createRpcTransport, runTrigger, publishAtomic, authoritySeeds, runAndPublish, main
});
