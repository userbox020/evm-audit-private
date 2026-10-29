'use strict';

// Offline, injected read-only observer. No provider resolver, filesystem, signer,
// publishing, or protocol-NAV/atomic-composition claim.
const FACTORY = '0x08e466fb09617d16ed27da9ea43ba601665f3b89';
const HISTORICAL_ADDRESS_BOOK = '0xcd2f28939e4b9f4d2af772137396ec42ad6d8143';
const DOLOMITE = '0x6bd780e7fdf01d77e4d475c821f1e7ae05409072';
const GM = '0x47c031236e19d024b42f8ae6780e44a573170703';
const ZERO = `0x${'0'.repeat(40)}`;
const HANDLERS = Object.freeze(['depositHandler', 'withdrawHandler', 'managerHandler', 'asyncRecoveryHandler', 'feeAccountingHandler', 'extensionHandler1', 'extensionHandler2', 'extensionHandler3']);
const STATE_ADDRESSES = Object.freeze(['vaultCoreClone', 'dolomiteIsolationVault', 'pendingWithdrawer', 'pendingRebalanceInitiator']);
const STATE_BOOLS = Object.freeze(['pendingWithdrawIsManagerFee', 'managerDeadmanTriggered']);
const STATE_UINTS = Object.freeze(['depositState', 'withdrawState', 'rebalanceState', 'pendingDepositAmountGmE18', 'pendingDepositGmPriceE18', 'pendingDepositGmCollateralSnapshotE18', 'pendingDepositDeadline',
  'pendingWithdrawSharesE18', 'pendingWithdrawGmToSellE18', 'pendingWithdrawCollateralSnapshotE18', 'pendingWithdrawWbtcDebtSnapshotE8', 'pendingWithdrawRawRatioInitialE18', 'pendingWithdrawMinWbtcOutE8', 'pendingWithdrawBorrowIndexE18', 'pendingWithdrawDeadline',
  'pendingRebalanceKind', 'pendingRebalanceDirection', 'pendingRebalanceLtvSnapshotBps', 'pendingRebalanceDeadline', 'totalDepositedGmE18', 'totalDepositedUsdE18', 'totalWithdrawnUsdE18', 'highWaterMarkProfitUsdE18', 'managerAccruedFeeUsdE18',
  'lastFinalizedNavUsdE18', 'lastFinalizedGmCollateralE18', 'lastFinalizedWbtcDebtE8', 'globalActionCooldownEndBlock', 'managementFeeBps', 'keeperDeadline', 'targetLtvBps', 'rebalanceThresholdUpBps', 'rebalanceThresholdDownBps', 'rebalanceSlippageCapBps', 'unwrapLongShareBps', 'lastManagerActionBlock']);
const ABI = Object.freeze([
  'function nextTokenId() view returns (uint256)', 'function vaultByTokenId(uint256) view returns (address)', 'function tokenIdByVault(address) view returns (uint256)', 'function ownerOf(uint256) view returns (address)', 'function ownerOfVault(address) view returns (address)',
  'function owner() view returns (address)', 'function protocolManager() view returns (address)', 'function initialCoreAddressBook() view returns (address)', 'function addressBookCooldownEndsAt() view returns (uint256)',
  'function initialized() view returns (bool)', 'function FACTORY() view returns (address)', 'function basaltMath() view returns (address)', 'function basaltState() view returns (address)', 'function accountedCapital() view returns (uint256)',
  'function handlerProposal() view returns (address oldHandler,address newHandler,bool exists)', 'function basaltAddressesProposal() view returns (address newBasaltMath,address newBasaltState,bool exists)',
  ...HANDLERS.map(k => `function ${k}() view returns (address)`), ...STATE_ADDRESSES.map(k => `function ${k}() view returns (address)`), ...STATE_BOOLS.map(k => `function ${k}() view returns (bool)`),
  ...STATE_UINTS.map(k => `function ${k}() view returns (${['depositState', 'withdrawState', 'rebalanceState', 'pendingRebalanceKind', 'pendingRebalanceDirection'].includes(k) ? 'uint8' : 'uint256'})`),
  'function getAccountWei((address owner,uint256 number) account,uint256 market) view returns ((bool sign,uint256 value))',
  'function getMarketPrice(uint256) view returns ((uint256 value))', 'function balanceOf(address) view returns (uint256)',
]);
const CAPS = Object.freeze({ maxVaults: 256, maxReads: 30000, maxRuntimeBytes: 50000 });
// Private branding and a fixed allowlist keep dependency diagnostics out of
// observations. Never read thrown message/code/stack/body/cause properties.
const VALIDATION_DETAILS = new WeakMap();
const ALLOWED_VALIDATION_DETAILS = new Set([
  'unsafe uint', 'invalid uint', 'uint overflow', 'invalid identity', 'invalid bool', 'wrong tuple', 'missing tuple field',
  'read cap', 'wrong pin/chain', 'incomplete/overflow read', 'runtime malformed/overflow', 'cyclic proxy bindings',
  'missing/mismatched source runtime', 'proxy implementation mismatch', 'pin hash/reorg', 'invalid cap',
  'Arbitrum fixed pin required', 'invalid pin', 'explicit readers required', 'wrong provider chain', 'authority mismatch',
  'vault cap', 'zero/duplicate minted association', 'NFT/core reverse association mismatch',
  'mutable core factory/math/state association mismatch', 'state back-reference mismatch', 'unknown action state',
  'invalid uint8 state', 'chain changed',
]);
class ObserverValidationError extends Error {
  constructor(detail) {
    const allowed = ALLOWED_VALIDATION_DETAILS.has(detail);
    super(allowed ? detail : 'Observer validation failed');
    if (allowed) VALIDATION_DETAILS.set(this, detail);
  }
}
function failureCode(stage, cause) {
  const detail = VALIDATION_DETAILS.get(cause);
  return detail === undefined ? stage : `${stage}: ${detail}`;
}
function u(v) {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new ObserverValidationError('unsafe uint');
  if (!['number', 'bigint', 'string'].includes(typeof v) || !/^(0|[1-9][0-9]*)$/.test(String(v))) throw new ObserverValidationError('invalid uint');
  const n = BigInt(v); if (n >= 1n << 256n) throw new ObserverValidationError('uint overflow'); return n;
}
function hex(v, n) { if (typeof v !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${n * 2}}$`).test(v)) throw new ObserverValidationError('invalid identity'); return v.toLowerCase(); }
function addr(v) { return hex(v, 20); }
function bool(v) { if (typeof v !== 'boolean') throw new ObserverValidationError('invalid bool'); return v; }
function tuple(v, keys) {
  if (!v || typeof v !== 'object' || (Array.isArray(v) && v.length !== keys.length)) throw new ObserverValidationError('wrong tuple');
  return Object.fromEntries(keys.map((k, i) => { const x = v[k] ?? v[i]; if (x === undefined) throw new ObserverValidationError('missing tuple field'); return [k, x]; }));
}
function pack(v) {
  if (typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return v.map(pack);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)]));
  return v;
}
function signedWei(value) {
  const t = tuple(value, ['sign', 'value']), sign = bool(t.sign), n = u(t.value);
  return { sign: n === 0n ? true : sign, value: String(n), signed: String(n === 0n || sign ? n : -n), kind: n === 0n ? 'ZERO' : sign ? 'CREDIT' : 'DEBT' };
}
// BasaltMath comes from managerHandler.json.sources['src/pure/BasaltMath.sol'].
// These are its amount/price unit conversions, NOT its clamped protocol NAV.
function analyticalEquity({ gmWei, wbtcWei, gmPriceE18, wbtcPriceE28, physicalGmBalances = [] }) {
  const gm = signedWei(gmWei), wbtc = signedWei(wbtcWei), gp = u(gmPriceE18), wp28 = u(wbtcPriceE28), wp18 = wp28 / 10000000000n;
  const gmProduct = BigInt(gm.signed) * gp, wbtcProduct = BigInt(wbtc.signed) * wp18;
  const gmUsd = gmProduct / 1000000000000000000n, wbtcUsd = wbtcProduct / 100000000n;
  return pack({ gm, wbtc, gmPriceE18: gp, wbtcPriceE28: wp28, wbtcPriceE18: wp18,
    signedRawGmValuationProduct: gmProduct, signedRawWbtcValuationProduct: wbtcProduct,
    signedGmUsdE18: gmUsd, signedWbtcUsdE18: wbtcUsd, analyticalEquityUsdE18: gmUsd + wbtcUsd,
    physicalGmBalances, physicalGmAddedToAccountEquity: false, isProtocolNav: false, clamped: false, conservationEstablished: false,
    limitations: ['withdraw/async-recovery handlers missing', 'escrow and frozen/action state not reconciled', 'GMX oracle/Chainlink/sequencer guards not established', 'not an atomic composition proof'] });
}
function report() {
  return { observer: 'arbitrum-basalt-x', pin: null, policyQualified: false, policyDisposition: 'ARBITRUM_ALLOWED_BLOCKED_ONLY', coverage: { complete: false, snapshotComplete: false, enumerationComplete: false, errors: [] }, classSemantics: { exact: false }, eligibility: 'UNKNOWN', eligibilityComplete: false, pipeline: { wired: false }, liveAdmission: false, routePositive: 'unknown', executableNow: 'unknown', vaults: [],
    remainingGates: ['current mutable core/math/state/handler runtime bindings', 'missing Withdraw and AsyncRecovery sources', 'handler/escrow/frozen-state and oracle+sequencer semantics', 'policy qualification and parent-owned fresh capture/admission'] };
}

/** Explicit input:
 * pin:{chainId:42161,blockNumber,blockHash}; provider:getNetwork/getBlock/getCode/
 * getStorage (only for descriptors carrying proxy:{slot,implementation}).
 * contracts.read({target,method,args,pin,abi})->{...pin,target,complete:true,
 * truncated:false,value}. No failed subread may become a successful empty value.
 * bindings:{...pin,runtimes:{[address]:{sourceRuntime,proxy?}},factoryAuthority:
 * {owner,protocolManager,initialCoreAddressBook}}. Bytes are caller-reviewed
 * compiled source runtimes, not copied RPC code. EIP1167 clone implementations
 * are parsed and separately source-bound. Handler slots come from EACH CORE,
 * never from the address book. Missing handler bindings remain UNKNOWN.
 */
async function collectBasaltX(ctx = {}) {
  const out = report(), caps = { ...CAPS, ...ctx.caps }, bound = new Set();
  let pin, reads = 0;
  const error = msg => out.coverage.errors.push(msg);
  const budget = () => { if (++reads > caps.maxReads) throw new ObserverValidationError('read cap'); };
  const samePin = r => { if (!r || u(r.chainId) !== 42161n || u(r.blockNumber) !== BigInt(pin.blockNumber) || hex(r.blockHash, 32) !== pin.blockHash) throw new ObserverValidationError('wrong pin/chain'); };
  const read = async (target, method, args = []) => {
    budget(); const r = await ctx.contracts.read({ target, method, args: pack(args), pin: { ...pin }, abi: ABI }); samePin(r);
    if (addr(r.target) !== target || r.complete !== true || r.truncated !== false || r.overflow === true || r.error) throw new ObserverValidationError('incomplete/overflow read'); return r.value;
  };
  const getCode = async target => {
    budget(); const value = await ctx.provider.getCode(target, pin.blockNumber);
    if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || (value.length - 2) / 2 > caps.maxRuntimeBytes) throw new ObserverValidationError('runtime malformed/overflow'); return value.toLowerCase();
  };
  const runtime = async (target, stack = new Set()) => {
    if (bound.has(target)) return;
    if (stack.has(target)) throw new ObserverValidationError('cyclic proxy bindings'); stack.add(target);
    const descriptor = ctx.bindings.runtimes?.[target], observed = await getCode(target);
    if (!descriptor || typeof descriptor.sourceRuntime !== 'string' || observed === '0x' || observed !== descriptor.sourceRuntime.toLowerCase()) throw new ObserverValidationError('missing/mismatched source runtime');
    const clone = /^0x363d3d373d3d3d363d73([a-f0-9]{40})5af43d82803e903d91602b57fd5bf3$/.exec(observed);
    if (clone) await runtime(addr(`0x${clone[1]}`), stack);
    if (descriptor.proxy) {
      const implementation = addr(descriptor.proxy.implementation), slot = hex(descriptor.proxy.slot, 32);
      budget(); const value = hex(await ctx.provider.getStorage(target, slot, pin.blockNumber), 32);
      if (value !== `0x${'0'.repeat(24)}${implementation.slice(2)}`) throw new ObserverValidationError('proxy implementation mismatch');
      await runtime(implementation, stack);
    }
    stack.delete(target); bound.add(target);
  };
  const pinHeader = async () => { budget(); const h = await ctx.provider.getBlock(pin.blockNumber); if (!h || u(h.number) !== BigInt(pin.blockNumber) || hex(h.hash, 32) !== pin.blockHash) throw new ObserverValidationError('pin hash/reorg'); return h; };
  let prices;
  const getPrices = async () => {
    if (!prices) {
      await runtime(DOLOMITE); await runtime(GM);
      const gm = tuple(await read(DOLOMITE, 'getMarketPrice', [32]), ['value']);
      const wbtc = tuple(await read(DOLOMITE, 'getMarketPrice', [4]), ['value']);
      prices = { gmPriceE18: u(gm.value), wbtcPriceE28: u(wbtc.value) };
    }
    return prices;
  };
  try {
    for (const [k, v] of Object.entries(caps)) if (!(k in CAPS) || !Number.isSafeInteger(v) || v <= 0) throw new ObserverValidationError('invalid cap');
    if (!ctx.pin || u(ctx.pin.chainId) !== 42161n) throw new ObserverValidationError('Arbitrum fixed pin required');
    const n = Number(u(ctx.pin.blockNumber)); if (!Number.isSafeInteger(n) || n < 1) throw new ObserverValidationError('invalid pin');
    pin = { chainId: '42161', blockNumber: n, blockHash: hex(ctx.pin.blockHash, 32) }; out.pin = pin;
    if (!ctx.provider || typeof ctx.contracts?.read !== 'function') throw new ObserverValidationError('explicit readers required');
    budget(); if (u((await ctx.provider.getNetwork()).chainId) !== 42161n) throw new ObserverValidationError('wrong provider chain');
    await pinHeader(); samePin(ctx.bindings); await runtime(FACTORY);
    out.factoryAuthority = {};
    for (const method of ['owner', 'protocolManager', 'initialCoreAddressBook']) {
      const current = addr(await read(FACTORY, method)); out.factoryAuthority[method] = current;
      if (current !== addr(ctx.bindings.factoryAuthority?.[method])) throw new ObserverValidationError('authority mismatch');
    }
    out.addressBookCooldownEndsAt = u(await read(FACTORY, 'addressBookCooldownEndsAt'));
    const count = Number(u(await read(FACTORY, 'nextTokenId')));
    if (!Number.isSafeInteger(count) || count > caps.maxVaults) throw new ObserverValidationError('vault cap');
    out.coverage.expectedVaults = count;
    const seen = new Set();
    for (let tokenId = 1; tokenId <= count; tokenId++) {
      // Allocate before any read; failed middle IDs never shift associations.
      const row = { tokenId: String(tokenId), owner: null, core: null, basaltState: null, isolationVault: null, status: 'UNKNOWN', errors: [], handlerSemantics: 'UNKNOWN', publicPermission: 'UNKNOWN' }; out.vaults.push(row);
      try {
        row.core = addr(await read(FACTORY, 'vaultByTokenId', [tokenId]));
        row.owner = addr(await read(FACTORY, 'ownerOf', [tokenId]));
        if (row.core === ZERO || row.owner === ZERO || seen.has(row.core)) throw new ObserverValidationError('zero/duplicate minted association'); seen.add(row.core);
        if (u(await read(FACTORY, 'tokenIdByVault', [row.core])) !== BigInt(tokenId) || addr(await read(FACTORY, 'ownerOfVault', [row.core])) !== row.owner) throw new ObserverValidationError('NFT/core reverse association mismatch');
        await runtime(row.core);
        row.ownerCodeHint = { hasCode: (await getCode(row.owner)) !== '0x', confersPublicPermission: false };
        row.initialized = bool(await read(row.core, 'initialized'));
        row.coreFactory = addr(await read(row.core, 'FACTORY'));
        row.basaltMath = addr(await read(row.core, 'basaltMath'));
        row.basaltState = addr(await read(row.core, 'basaltState'));
        row.accountedCapital = u(await read(row.core, 'accountedCapital'));
        row.handlers = {};
        for (const method of HANDLERS) row.handlers[method] = addr(await read(row.core, method));
        const hp = tuple(await read(row.core, 'handlerProposal'), ['oldHandler', 'newHandler', 'exists']);
        row.handlerProposal = { oldHandler: addr(hp.oldHandler), newHandler: addr(hp.newHandler), exists: bool(hp.exists) };
        const bp = tuple(await read(row.core, 'basaltAddressesProposal'), ['newBasaltMath', 'newBasaltState', 'exists']);
        row.basaltAddressesProposal = { newBasaltMath: addr(bp.newBasaltMath), newBasaltState: addr(bp.newBasaltState), exists: bool(bp.exists) };
        if (!row.initialized) { row.status = 'UNINITIALIZED_SNAPSHOT_ONLY'; row.exposure = 'UNKNOWN'; continue; }
        if (row.coreFactory !== FACTORY || row.basaltState === ZERO || row.basaltMath === ZERO) throw new ObserverValidationError('mutable core factory/math/state association mismatch');
        await runtime(row.basaltState); await runtime(row.basaltMath);
        row.handlerBindings = {};
        for (const [slot, target] of Object.entries(row.handlers)) {
          if (target === ZERO) { row.handlerBindings[slot] = { status: 'EMPTY_SLOT' }; continue; }
          if (!ctx.bindings.runtimes?.[target]) {
            // Missing handler source is an explicit semantic gap. Transport
            // failures still escape to the row failure path, never success.
            row.handlerBindings[slot] = { status: 'UNKNOWN', reason: 'CURRENT_HANDLER_SOURCE_RUNTIME_MISSING', codePresent: (await getCode(target)) !== '0x' };
          } else {
            await runtime(target);
            row.handlerBindings[slot] = { status: 'RUNTIME_BOUND_ONLY', semantics: 'UNKNOWN' };
          }
        }
        const state = {}; row.state = state;
        for (const method of STATE_ADDRESSES) state[method] = addr(await read(row.basaltState, method));
        if (state.vaultCoreClone !== row.core) throw new ObserverValidationError('state back-reference mismatch');
        row.isolationVault = state.dolomiteIsolationVault;
        for (const method of STATE_BOOLS) state[method] = bool(await read(row.basaltState, method));
        for (const method of STATE_UINTS) {
          state[method] = u(await read(row.basaltState, method));
          if (['depositState', 'withdrawState', 'rebalanceState'].includes(method) && state[method] > 1n) throw new ObserverValidationError('unknown action state');
          if (['pendingRebalanceKind', 'pendingRebalanceDirection'].includes(method) && state[method] > 255n) throw new ObserverValidationError('invalid uint8 state');
        }
        row.allActionsIdle = ['depositState', 'withdrawState', 'rebalanceState'].every(k => state[k] === 0n);
        const physicalGmBalances = [];
        for (const holder of new Set([row.core, row.basaltState, row.isolationVault].filter(a => a !== ZERO))) {
          await runtime(GM);
          physicalGmBalances.push({ holder, amountE18: u(await read(GM, 'balanceOf', [holder])), additiveToAccountCollateral: false });
        }
        if (row.isolationVault !== ZERO) {
          const price = await getPrices(), account = { owner: row.isolationVault, number: '100' };
          const gmWei = await read(DOLOMITE, 'getAccountWei', [account, 32]);
          const wbtcWei = await read(DOLOMITE, 'getAccountWei', [account, 4]);
          row.valuation = analyticalEquity({ gmWei, wbtcWei, ...price, physicalGmBalances });
        } else row.valuation = { status: 'NO_ISOLATION_ASSOCIATION', physicalGmBalances, exposure: 'UNKNOWN', isProtocolNav: false };
        row.status = 'SNAPSHOT_ONLY';
      } catch (e) { const code = failureCode('BASALT_VAULT_READ_FAILED', e); row.errors.push(code); error(`tokenId ${tokenId}: ${code}`); }
    }
  } catch (e) { error(failureCode('BASALT_CAPTURE_FAILED', e)); }
  if (pin && ctx.provider) {
    try { budget(); if (u((await ctx.provider.getNetwork()).chainId) !== 42161n) throw new ObserverValidationError('chain changed'); await pinHeader(); }
    catch (e) { error(failureCode('BASALT_FINAL_PIN_FAILED', e)); }
  }
  out.coverage.reads = reads;
  out.coverage.enumerationComplete = out.coverage.expectedVaults === out.vaults.length && out.coverage.errors.length === 0;
  out.coverage.snapshotComplete = out.coverage.enumerationComplete;
  return pack(out);
}
module.exports = { FACTORY, HISTORICAL_ADDRESS_BOOK, DOLOMITE, GM, ZERO, HANDLERS, STATE_ADDRESSES, STATE_BOOLS, STATE_UINTS, ABI, CAPS, signedWei, analyticalEquity, collectBasaltX };
// Direct invocation is intentionally silent and inert, just like import.
