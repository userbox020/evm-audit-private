'use strict';

const math = require('./lib/ammalgam-l-math');
const { u, pack, six } = math;
const FACTORY = '0x1a411b0fd1f368d2f413a8cbb6aad425c923015b';
const HISTORICAL_IMPLEMENTATION = '0xffff5ee29c5e707fe5d9e1e9385437231cfb99fc';
const LIBRARIES = Object.freeze({ Interest: '0xe6cecf8b6593a7decf232bd2ccd444c4a09980b1', Validation: '0xe61a70f7ad7ce007e6119663ba334884e193f72e', Liquidation: '0xeaae9d222f16d0142eb3102788cecbe0c3e3ba1f' });
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const ZERO = `0x${'0'.repeat(40)}`;
const ABI = Object.freeze([
  'function allPairsLength() view returns (uint256)', 'function allPairs(uint256) view returns (address)',
  'function getPair(address,address) view returns (address)', 'function pairBeacon() view returns (address)',
  'function feeToSetter() view returns (address)', 'function owner() view returns (address)', 'function implementation() view returns (address)',
  'event PairCreated(address indexed tokenX,address indexed tokenY,address pair,uint256 allPairsLength)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'function underlyingTokens() view returns (address,address)', 'function tokens(uint256) view returns (address)',
  'function totalAssetsAndShares(bool withInterest) view returns (uint112[6] allAssets,uint112[6] allShares)',
  'function getReserves() view returns (uint112 reserveXAssets,uint112 reserveYAssets,uint32 lastTimestamp)',
  'function externalLiquidity() view returns (uint112)', 'function fragileLiquidityShares() view returns (uint112)',
  'function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)',
]);
const CAPS = Object.freeze({ maxPairs: 128, maxUsers: 10000, maxReads: 100000, maxChunks: 2048, blockChunkSize: 50000, maxLogsPerChunk: 10000, maxHeaders: 20000 });
// Only locally constructed, privately branded validation failures may contribute
// allowlisted detail. Never inspect dependency message/code/stack/body/cause.
const VALIDATION_DETAILS = new WeakMap();
const ALLOWED_VALIDATION_DETAILS = new Set([
  'invalid hex identity', 'runtime absent', 'wrong tuple shape', 'missing tuple field', 'uint112 totals overflow',
  'read cap', 'wrong pin/chain', 'incomplete/overflow read', 'header cap', 'history header missing', 'pin reorg',
  'runtime binding mismatch', 'malformed address slot', 'unknown creation bounds', 'creation hash mismatch',
  'creation bound omits prior history', 'creation code/source binding mismatch', 'missing range/overflow logs',
  'wrong log identity', 'log history/hash mismatch', 'conflicting duplicate', 'invalid cap', 'Ethereum fixed pin required',
  'invalid pin', 'explicit readers required', 'wrong provider chain', 'deployed source kind/implementation unbound',
  'linked library mismatch', 'authority binding mismatch', 'pair cap', 'multiple PairCreated for pair', 'zero/duplicate pair',
  'cached/beacon implementations differ: reinitialization/static fallback unmodeled', 'underlying token order/identity',
  'getPair mismatch', 'PairCreated association mismatch', 'zero/duplicate receipt token', 'receipt owner/pair mismatch',
  'debt token belongs to multiple pairs', 'user cap', 'chain changed', 'missing chunks (cap)', 'PairCreated/factory count mismatch',
]);
class ObserverValidationError extends Error {
  constructor(detail) {
    super('Observer validation failed');
    if (ALLOWED_VALIDATION_DETAILS.has(detail)) VALIDATION_DETAILS.set(this, detail);
  }
}
function failureCode(stage, cause) {
  const detail = VALIDATION_DETAILS.get(cause);
  return detail === undefined ? stage : `${stage}: ${detail}`;
}
function hex(v, bytes) { if (typeof v !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)) throw new ObserverValidationError('invalid hex identity'); return v.toLowerCase(); }
function addr(v) { return hex(v, 20); }
function code(v) { if (typeof v !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(v)) throw new ObserverValidationError('runtime absent'); return v.toLowerCase(); }
function tuple(v, keys) {
  if (!v || typeof v !== 'object' || (Array.isArray(v) && v.length !== keys.length)) throw new ObserverValidationError('wrong tuple shape');
  return keys.map((k, i) => { const x = v[k] ?? v[i]; if (x === undefined) throw new ObserverValidationError('missing tuple field'); return x; });
}
function totals(v) { const [a, s] = tuple(v, ['allAssets', 'allShares']); const assets = six(a), shares = six(s); if ([...assets, ...shares].some(x => x >= (1n << 112n))) throw new ObserverValidationError('uint112 totals overflow'); return { assets, shares }; }
function baseReport() {
  return { observer: 'ethereum-ammalgam-l', pin: null, coverage: { complete: false, snapshotComplete: false, enumerationComplete: false, errors: [], duplicateEvents: 0 }, classSemantics: { exact: false }, eligibility: 'UNKNOWN', eligibilityComplete: false,
    pipeline: { wired: false }, liveAdmission: false, routePositive: 'unknown', executableNow: 'unknown', pairs: [],
    remainingGates: ['global + account-specific saturation penalties BEFORE interest', 'all HARD directional tranche and bad-debt transitions', 'official SATURATION roots and pair+borrower change ratio', 'post-penalty price inputs and repayment/burn parity', 'fresh parent-owned bindings/capture/admission'] };
}

/** Injection-only input (never resolves providers or reads files):
 * pin:{chainId:1,blockNumber,blockHash}; provider:getNetwork/getBlock/getCode/
 * getStorage (ethers-like, explicit numeric block); contracts.read({target,
 * method,args,pin,abi}); logReader({target,event,fromBlock,toBlock,pin,abi}).
 * Every reader envelope: {...pin,target,complete:true,truncated:false,value};
 * log envelope additionally fromBlock/toBlock/logs, decoded event/address/
 * args/blockNumber/blockHash/transactionHash/index/removed:false.
 * bindings:{...pin,runtimes:{[lowercaseAddress]:{sourceRuntime,sourceKind}},
 * factoryAuthority:{feeToSetter},beaconAuthority:{owner}}. sourceRuntime means
 * independently reviewed compiled/deployed bytes, NOT copied RPC code.
 * Include factory, beacon, pair proxies, all six tokens, implementation and
 * three libraries. Implementation kind MUST be PairBlockedBorrowLiquidity.
 * factoryCreation:{blockNumber,blockHash}: validated against historical code
 * absence/presence. PairCreated and debt-token code absence/presence prove each
 * debt token scan's creation bound. Archive/history gaps never mean no debt.
 * No adapter may turn missing chunks/subreads/truncation into successful empties.
 */
async function collectAmmalgamL(ctx = {}) {
  const out = baseReport(), caps = { ...CAPS, ...ctx.caps }, headers = new Map(), bound = new Set();
  const error = message => out.coverage.errors.push(message);
  let pin, reads = 0, chunks = 0, userCount = 0;
  const budget = () => { if (++reads > caps.maxReads) throw new ObserverValidationError('read cap'); };
  const samePin = r => { if (!r || u(r.chainId) !== 1n || u(r.blockNumber) !== BigInt(pin.blockNumber) || hex(r.blockHash, 32) !== pin.blockHash) throw new ObserverValidationError('wrong pin/chain'); };
  const unwrap = (r, target) => { samePin(r); if (addr(r.target) !== target || r.complete !== true || r.truncated !== false || r.overflow === true || r.error) throw new ObserverValidationError('incomplete/overflow read'); return r.value; };
  const read = async (target, method, args = []) => { budget(); return unwrap(await ctx.contracts.read({ target, method, args: pack(args), pin: { ...pin }, abi: ABI }), target); };
  const header = async (n, fresh = false) => {
    if (!fresh && headers.has(n)) return headers.get(n);
    if (!headers.has(n) && headers.size >= caps.maxHeaders) throw new ObserverValidationError('header cap');
    budget(); const h = await ctx.provider.getBlock(n);
    if (!h || u(h.number) !== BigInt(n)) throw new ObserverValidationError('history header missing');
    const hash = hex(h.hash, 32); if (n === pin.blockNumber && hash !== pin.blockHash) throw new ObserverValidationError('pin reorg');
    headers.set(n, hash); return hash;
  };
  const runtime = async target => {
    if (bound.has(target)) return;
    const expected = ctx.bindings.runtimes?.[target];
    const compiled = code(expected?.sourceRuntime);
    budget(); if (code(await ctx.provider.getCode(target, pin.blockNumber)) !== compiled) throw new ObserverValidationError('runtime binding mismatch');
    bound.add(target);
  };
  const slotAddress = async (target, slot) => {
    budget(); const value = hex(await ctx.provider.getStorage(target, slot, pin.blockNumber), 32);
    if (!/^0x0{24}/.test(value)) throw new ObserverValidationError('malformed address slot'); return addr(`0x${value.slice(-40)}`);
  };
  const historyCreation = async (target, block, expectedHash) => {
    if (!Number.isSafeInteger(block) || block <= 0 || block > pin.blockNumber) throw new ObserverValidationError('unknown creation bounds');
    const hash = await header(block);
    if (expectedHash && hash !== hex(expectedHash, 32)) throw new ObserverValidationError('creation hash mismatch');
    budget(); if (await ctx.provider.getCode(target, block - 1) !== '0x') throw new ObserverValidationError('creation bound omits prior history');
    budget(); if (code(await ctx.provider.getCode(target, block)) !== code(ctx.bindings.runtimes?.[target]?.sourceRuntime)) throw new ObserverValidationError('creation code/source binding mismatch');
  };
  // Each range is requested exactly, inclusively, and validated independently of
  // event deduplication. A read failure preserves an explicit missing range.
  const events = async (target, event, from) => {
    const result = [], seen = new Map();
    for (let start = from; start <= pin.blockNumber; start += caps.blockChunkSize) {
      if (++chunks > caps.maxChunks) { error(`${target} ${event}: ${failureCode('AMMALGAM_LOG_CHUNK_FAILED', new ObserverValidationError('missing chunks (cap)'))}`); break; }
      const end = Math.min(pin.blockNumber, start + caps.blockChunkSize - 1);
      try {
        budget(); const r = await ctx.logReader({ target, event, fromBlock: start, toBlock: end, pin: { ...pin }, abi: ABI });
        unwrap(r, target);
        if (r.fromBlock !== start || r.toBlock !== end || !Array.isArray(r.logs) || r.logs.length > caps.maxLogsPerChunk) throw new ObserverValidationError('missing range/overflow logs');
        for (const log of r.logs) {
          if (addr(log.address) !== target || log.event !== event || log.removed !== false) throw new ObserverValidationError('wrong log identity');
          const n = Number(u(log.blockNumber)), hash = hex(log.blockHash, 32);
          if (!Number.isSafeInteger(n) || n < start || n > end || hash !== await header(n)) throw new ObserverValidationError('log history/hash mismatch');
          const id = `${hex(log.transactionHash, 32)}:${u(log.index)}`, content = JSON.stringify(pack(log));
          if (seen.has(id)) { if (seen.get(id) !== content) throw new ObserverValidationError('conflicting duplicate'); out.coverage.duplicateEvents++; continue; }
          seen.set(id, content); result.push(log);
        }
      } catch (e) { error(`${target} ${event}[${start},${end}]: ${failureCode('AMMALGAM_LOG_CHUNK_FAILED', e)}`); }
    }
    return result;
  };
  try {
    for (const [k, v] of Object.entries(caps)) if (!(k in CAPS) || !Number.isSafeInteger(v) || v <= 0) throw new ObserverValidationError('invalid cap');
    if (!ctx.pin || u(ctx.pin.chainId) !== 1n) throw new ObserverValidationError('Ethereum fixed pin required');
    const n = Number(u(ctx.pin.blockNumber)); if (!Number.isSafeInteger(n) || n < 1) throw new ObserverValidationError('invalid pin');
    pin = { chainId: '1', blockNumber: n, blockHash: hex(ctx.pin.blockHash, 32) }; out.pin = pin;
    if (!ctx.provider || typeof ctx.contracts?.read !== 'function' || typeof ctx.logReader !== 'function') throw new ObserverValidationError('explicit readers required');
    budget(); if (u((await ctx.provider.getNetwork()).chainId) !== 1n) throw new ObserverValidationError('wrong provider chain');
    await header(n); samePin(ctx.bindings);
    await runtime(FACTORY);
    const creation = ctx.factoryCreation;
    if (!creation || !creation.blockHash) throw new ObserverValidationError('unknown creation bounds');
    await historyCreation(FACTORY, Number(u(creation.blockNumber)), creation.blockHash);
    const beacon = addr(await read(FACTORY, 'pairBeacon')); await runtime(beacon);
    const implementation = addr(await read(beacon, 'implementation'));
    if (implementation !== HISTORICAL_IMPLEMENTATION || ctx.bindings.runtimes?.[implementation]?.sourceKind !== 'PairBlockedBorrowLiquidity') throw new ObserverValidationError('deployed source kind/implementation unbound');
    await runtime(implementation);
    for (const lib of Object.values(LIBRARIES)) {
      await runtime(lib);
      if (!code(ctx.bindings.runtimes[implementation].sourceRuntime).includes(lib.slice(2))) throw new ObserverValidationError('linked library mismatch');
    }
    for (const [target, method, expected] of [[FACTORY, 'feeToSetter', ctx.bindings.factoryAuthority?.feeToSetter], [beacon, 'owner', ctx.bindings.beaconAuthority?.owner]]) {
      if (addr(await read(target, method)) !== addr(expected)) throw new ObserverValidationError('authority binding mismatch');
    }
    const count = Number(u(await read(FACTORY, 'allPairsLength')));
    if (!Number.isSafeInteger(count) || count > caps.maxPairs) throw new ObserverValidationError('pair cap');
    const created = await events(FACTORY, 'PairCreated', Number(u(creation.blockNumber)));
    const createdByPair = new Map();
    for (const log of created) {
      const pair = addr(log.args?.pair);
      if (createdByPair.has(pair)) throw new ObserverValidationError('multiple PairCreated for pair');
      createdByPair.set(pair, log);
    }
    if (createdByPair.size !== count) error(failureCode('AMMALGAM_CAPTURE_FAILED', new ObserverValidationError('PairCreated/factory count mismatch')));
    const seenPairs = new Set(), seenDebtTokens = new Set();
    for (let index = 0; index < count; index++) {
      const row = { index, pair: null, status: 'UNKNOWN', errors: [], accounts: [] }; out.pairs.push(row);
      try {
        const pair = addr(await read(FACTORY, 'allPairs', [index])); row.pair = pair;
        if (pair === ZERO || seenPairs.has(pair)) throw new ObserverValidationError('zero/duplicate pair'); seenPairs.add(pair);
        await runtime(pair);
        const cached = await slotAddress(pair, IMPLEMENTATION_SLOT), pairBeacon = await slotAddress(pair, BEACON_SLOT);
        row.proxy = { cachedImplementation: cached, beaconImplementation: implementation, beacon: pairBeacon };
        if (pairBeacon !== beacon || cached !== implementation) throw new ObserverValidationError('cached/beacon implementations differ: reinitialization/static fallback unmodeled');
        const [x, y] = tuple(await read(pair, 'underlyingTokens'), ['tokenX', 'tokenY']).map(addr);
        row.underlyingTokens = [x, y];
        if (x === ZERO || BigInt(x) >= BigInt(y)) throw new ObserverValidationError('underlying token order/identity');
        if (addr(await read(FACTORY, 'getPair', [x, y])) !== pair || addr(await read(FACTORY, 'getPair', [y, x])) !== pair) throw new ObserverValidationError('getPair mismatch');
        const event = createdByPair.get(pair);
        if (!event || addr(event.args.tokenX) !== x || addr(event.args.tokenY) !== y || u(event.args.allPairsLength) !== BigInt(index + 1)) throw new ObserverValidationError('PairCreated association mismatch');
        const tokenAddresses = [], supplies = [];
        for (let i = 0; i < 6; i++) {
          const token = addr(await read(pair, 'tokens', [i]));
          if (token === ZERO || tokenAddresses.includes(token)) throw new ObserverValidationError('zero/duplicate receipt token');
          await runtime(token);
          if (addr(await read(token, 'owner')) !== pair) throw new ObserverValidationError('receipt owner/pair mismatch');
          tokenAddresses.push(token); supplies.push(u(await read(token, 'totalSupply')));
        }
        row.tokens = tokenAddresses; row.receiptTokenSupplies = supplies;
        const raw = totals(await read(pair, 'totalAssetsAndShares', [false]));
        const accrued = totals(await read(pair, 'totalAssetsAndShares', [true]));
        const reserves = tuple(await read(pair, 'getReserves'), ['reserveXAssets', 'reserveYAssets', 'lastTimestamp']).map(u);
        const external = u(await read(pair, 'externalLiquidity')), fragile = u(await read(pair, 'fragileLiquidityShares'));
        const stagedShares = u(await read(tokenAddresses[0], 'balanceOf', [pair]));
        row.snapshot = { rawTotals: raw, accruedTotals: accrued, getReservesView: reserves, getReservesDomain: 'throttled stored OR accrued; NOT assumed raw/current transition reserves', externalLiquidity: external, fragileShares: fragile, pairHeldDepositLShares: stagedShares, receiptSupplyIsStoredSharesAuthority: false };
        const accounts = new Set();
        for (let i = 3; i < 6; i++) {
          const token = tokenAddresses[i];
          if (seenDebtTokens.has(token)) throw new ObserverValidationError('debt token belongs to multiple pairs'); seenDebtTokens.add(token);
          await historyCreation(token, Number(u(event.blockNumber)), event.blockHash);
          for (const log of await events(token, 'Transfer', Number(u(event.blockNumber)))) {
            u(log.args?.value);
            for (const rawAddress of [log.args?.from, log.args?.to]) {
              const account = addr(rawAddress);
              if (account !== ZERO && !accounts.has(account)) {
                if (++userCount > caps.maxUsers) throw new ObserverValidationError('user cap'); accounts.add(account);
              }
            }
          }
        }
        for (const account of accounts) {
          const accountRow = { account, status: 'UNKNOWN' }; row.accounts.push(accountRow);
          try {
            const balances = [];
            for (const token of tokenAddresses) balances.push(u(await read(token, 'balanceOf', [account])));
            accountRow.shares = balances;
            accountRow.accounting = math.snapshotAccounting({ accruedAssets: accrued.assets, accruedShares: accrued.shares, rawAssets: raw.assets, rawShares: raw.shares, balances, pairHeldDepositLShares: stagedShares, externalLiquidity: external, fragileShares: fragile });
            accountRow.branches = math.accountBranches(accountRow.accounting.userAssets);
            accountRow.status = 'SNAPSHOT_ONLY';
          } catch (e) { accountRow.error = failureCode('AMMALGAM_ACCOUNT_READ_FAILED', e); error(`account ${pair}:${account}: ${accountRow.error}`); }
        }
        // Compute pair accounting even if no debt Transfer ever existed.
        row.accounting = math.snapshotAccounting({ accruedAssets: accrued.assets, accruedShares: accrued.shares, rawAssets: raw.assets, rawShares: raw.shares, balances: ['0', '0', '0', '0', '0', '0'], pairHeldDepositLShares: stagedShares, externalLiquidity: external, fragileShares: fragile });
        row.status = 'SNAPSHOT_ONLY';
      } catch (e) { const code = failureCode('AMMALGAM_PAIR_READ_FAILED', e); row.errors.push(code); error(`pair index ${index}: ${code}`); }
    }
    out.coverage.expectedPairs = count;
  } catch (e) { error(failureCode('AMMALGAM_CAPTURE_FAILED', e)); }
  if (pin && ctx.provider) {
    try { budget(); if (u((await ctx.provider.getNetwork()).chainId) !== 1n) throw new ObserverValidationError('chain changed'); await header(pin.blockNumber, true); }
    catch (e) { error(failureCode('AMMALGAM_FINAL_PIN_FAILED', e)); }
  }
  out.coverage.reads = reads; out.coverage.logChunks = chunks; out.coverage.accountCount = userCount;
  out.coverage.enumerationComplete = out.coverage.errors.length === 0 && out.coverage.expectedPairs === out.pairs.length;
  out.coverage.snapshotComplete = out.coverage.enumerationComplete;
  // Deliberately never promote snapshot success to liquidation coverage.
  return pack(out);
}
module.exports = { FACTORY, HISTORICAL_IMPLEMENTATION, LIBRARIES, IMPLEMENTATION_SLOT, BEACON_SLOT, ZERO, ABI, CAPS, collectAmmalgamL };
// Direct invocation is intentionally silent and inert, just like import.
