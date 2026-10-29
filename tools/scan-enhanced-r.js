'use strict';

// Read-only, injection-only observer. Import and CLI do not discover RPCs, read
// files, load ethers, publish artifacts, or execute transactions.
const P = 10n ** 18n;
const DEPLOYMENT_BLOCK = 25645217;
const ADDRESSES = Object.freeze({
  proxy: '0xb7da7b8ffca7ca4bff6b68024d4ba50ef337d049',
  implementation: '0xc667962ee4850539b3f8ac9c3da801d50b8e84ab',
  cycleLibrary: '0xd6abf4444089d5371416f1bdaf5176bc14efb896',
  recordsLibrary: '0xac767ca3e423ffc5ae58865d6c1380340fdca48d',
});
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const PHASES = Object.freeze(['OPEN', 'SETTLED', 'PROCESSING_DONE', 'ENDED']);
const AUTHORITY_METHODS = Object.freeze(['owner', 'operator', 'vaultSigner', 'enhancedOptions', 'swapRouter', 'protocolFeeRecipient']);
const FUND_FIELDS = Object.freeze(['activePrincipal', 'pendingActivePrincipal', 'pendingWithdrawAmount', 'stoppedPrincipal', 'systemPausedPrincipal', 'materializedPremium', 'entryCumCollateral', 'entryCumPremium', 'initialAmountTotal', 'nextRecordId', 'buybackEnabled', 'exists', 'autoBuyEnabled']);
const CYCLE_FIELDS = Object.freeze(['totalActiveCollateral', 'remainingActiveCollateral', 'totalPremium', 'collateralRatio', 'premiumRatio']);
const RECORD_FIELDS = Object.freeze(['id', 'vaultHash', 'user', 'recordType', 'amount', 'createdCycleId', 'isExitAll']);
const POSITION_FIELDS = Object.freeze(['activeBalance', 'pendingDeposit', 'pendingWithdrawAmount', 'claimableWithdraw', 'claimableSystemPaused', 'claimablePremium', 'projectedPremium']);
const PARAM_FIELDS = Object.freeze(['cycleDuration', 'underlyingAsset', 'collateralAsset', 'strikeAsset', 'isPut', 'capacity', 'minInvestmentAmount', 'startTime', 'strikePriceBps', 'minPrincipalRatio', 'buybackPriceRatio']);
const RECORD_TUPLE = '(uint256 id,bytes32 vaultHash,address user,uint8 recordType,uint256 amount,uint256 createdCycleId,bool isExitAll)';
const ABI = Object.freeze([
  'event VaultCreated(bytes32 indexed vaultHash, uint256 cycleDuration, address underlyingAsset, address collateralAsset, address strikeAsset, bool isPut, uint256 capacity, uint256 minInvestmentAmount, uint256 startTime, int256 strikePriceBps, uint256 minPrincipalRatio, int256 buybackPriceRatio, uint256 protocolFeeRate)',
  'event Deposited(bytes32 indexed vaultHash, address indexed user, uint256 recordId, uint256 amount)',
  'function vaults(bytes32) view returns ((uint256 cycleDuration, address underlyingAsset, address collateralAsset, address strikeAsset, bool isPut, uint256 capacity, uint256 minInvestmentAmount, uint256 startTime, int256 strikePriceBps, uint256 minPrincipalRatio, int256 buybackPriceRatio) params, bool isActive, uint256 currentCycleId, uint256 currentCycleStart, uint256 totalDeposited, bool isPaused, bool isEnd, uint256 protocolFeeRate)',
  'function userFunds(bytes32,address) view returns (uint256 activePrincipal,uint256 pendingActivePrincipal,uint256 pendingWithdrawAmount,uint256 stoppedPrincipal,uint256 systemPausedPrincipal,uint256 materializedPremium,uint256 entryCumCollateral,uint256 entryCumPremium,uint256 initialAmountTotal,uint256 nextRecordId,bool buybackEnabled,bool exists,bool autoBuyEnabled)',
  'function cycleRecords(bytes32,uint256) view returns (uint256 totalActiveCollateral,uint256 remainingActiveCollateral,uint256 totalPremium,uint256 collateralRatio,uint256 premiumRatio)',
  'function vaultPhases(bytes32) view returns (uint8)',
  'function getQueueProgress(bytes32) view returns (uint8 phase,uint256 queueLen,uint256 processedCount,uint256 remaining,bool canStartNextCycle)',
  'function getQueueUsers(bytes32,uint256,uint256) view returns (address[])',
  ...['getPendingDeposits', 'getPendingWithdrawRequests', 'getPendingWithdraws'].map(name => `function ${name}(bytes32,address) view returns (${RECORD_TUPLE}[])`),
  'function getMyPosition(bytes32 vaultHash, address user) view returns ((uint256 activeBalance, uint256 pendingDeposit, uint256 pendingWithdrawAmount, uint256 claimableWithdraw, uint256 claimableSystemPaused, uint256 claimablePremium, uint256 projectedPremium) pos)',
  'function cumCollateral(bytes32,uint256) view returns (uint256)',
  'function cumPremium(bytes32,uint256) view returns (uint256)',
  'function protocolFeeAccrued(bytes32) view returns (uint256)',
  'function getVaultIds(bytes32,uint256) view returns (uint256[])',
  ...AUTHORITY_METHODS.map(name => `function ${name}() view returns (address)`),
]);
const DEFAULT_CAPS = Object.freeze({ blockChunkSize: 50000, maxChunks: 512, maxLogsPerChunk: 5000, maxVaults: 256, maxUsers: 5000, pageSize: 100, maxPages: 1024, maxRecordsPerUser: 4096, maxTotalRecords: 50000, maxVaultIds: 2048, maxHeaderReads: 10000, maxReads: 100000 });

// Only locally branded, allowlisted validation reasons may cross the observation
// boundary. Injected adapters can throw arbitrary provider bodies and metadata.
const VALIDATION_REASONS = new Set([
  'validation-failed', 'invalid uint', 'uint256 overflow', 'invalid bool', 'invalid bytes20', 'invalid bytes32',
  'missing runtime bytecode', 'invalid phase', 'missing tuple', 'wrong tuple length', 'invalid int256', 'int256 overflow',
  'duplicate request id', 'record not pending', 'invalid cap', 'Ethereum chainId=1 required', 'invalid fixed pin block',
  'explicit provider, contracts.read and logReader required', 'read cap exceeded', 'wrong pin/chain binding',
  'incomplete/overflow response or wrong target', 'header cap exceeded', 'missing/wrong block header', 'pin block hash mismatch',
  'provider wrong chain', 'implementation library links missing', 'implementation slot mismatch', 'missing range/overflow logs',
  'wrong/removed log identity', 'log outside chunk', 'log block hash mismatch', 'conflicting duplicate log',
  'vault cap exceeded', 'user cap exceeded', 'queue progress inconsistent', 'queue overflow', 'queue page cap exceeded',
  'truncated queue page', 'duplicate queue user', 'duplicate vault ids', 'duplicate settled vault ids', 'deposit source cap exceeded',
  'record identity/type mismatch', 'record cap exceeded', 'duplicate record ids', 'invalid exit-all requests',
  'withdraw request ledger mismatch', 'withdraw records exceed stopped principal', 'provider chain changed',
  ...[...FUND_FIELDS, ...CYCLE_FIELDS, ...RECORD_FIELDS, ...PARAM_FIELDS, ...POSITION_FIELDS,
    'params', 'isActive', 'currentCycleId', 'currentCycleStart', 'totalDeposited', 'isPaused', 'isEnd', 'protocolFeeRate',
    'phase', 'queueLen', 'processedCount', 'remaining', 'canStartNextCycle'].map(key => `missing ${key}`),
  ...Object.keys(ADDRESSES).flatMap(role => [`${role} address binding mismatch`, `${role} runtime/source mismatch`]),
  ...AUTHORITY_METHODS.map(method => `authority mismatch: ${method}`),
  ...['queue page', 'vault ids', 'settled vault ids', 'getPendingDeposits', 'getPendingWithdrawRequests', 'getPendingWithdraws'].map(label => `${label} overflow/invalid array`),
  ...POSITION_FIELDS.map(key => `public position mismatch: ${key}`),
]);
class ValidationError extends Error {
  constructor(reason) { super(VALIDATION_REASONS.has(reason) ? reason : 'validation-failed'); }
}
function failureReason(error, fallback) {
  return error instanceof ValidationError && VALIDATION_REASONS.has(error.message) ? error.message : fallback;
}

function uint(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new ValidationError('invalid uint');
  if (typeof value !== 'bigint' && typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))) throw new ValidationError('invalid uint');
  const n = BigInt(value);
  if (n < 0n || n >= 2n ** 256n) throw new ValidationError('uint256 overflow');
  return n;
}
function bool(value) { if (typeof value !== 'boolean') throw new ValidationError('invalid bool'); return value; }
function hex(value, bytes) {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) throw new ValidationError(`invalid bytes${bytes}`);
  return value.toLowerCase();
}
function address(value) { return hex(value, 20); }
function bytecode(value) {
  if (typeof value !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(value)) throw new ValidationError('missing runtime bytecode');
  return value.toLowerCase();
}
function phase(value) {
  if (PHASES.includes(value)) return value;
  const i = uint(value);
  if (i > 3n) throw new ValidationError('invalid phase');
  return PHASES[Number(i)];
}
function tuple(value, fields) {
  if (!value || typeof value !== 'object') throw new ValidationError('missing tuple');
  if (Array.isArray(value) && value.length !== fields.length) throw new ValidationError('wrong tuple length');
  return Object.fromEntries(fields.map((key, i) => {
    const v = value[key] === undefined ? value[i] : value[key];
    if (v === undefined) throw new ValidationError(`missing ${key}`);
    return [key, v];
  }));
}
function fundTuple(value) {
  const f = tuple(value, FUND_FIELDS);
  FUND_FIELDS.forEach((key, i) => { f[key] = i < 10 ? uint(f[key]) : bool(f[key]); });
  return f;
}
function cycleTuple(value) { return Object.fromEntries(Object.entries(tuple(value, CYCLE_FIELDS)).map(([k, v]) => [k, uint(v)])); }
function recordTuple(value) {
  const r = tuple(value, RECORD_FIELDS);
  return { id: uint(r.id), vaultHash: hex(r.vaultHash, 32), user: address(r.user), recordType: uint(r.recordType), amount: uint(r.amount), createdCycleId: uint(r.createdCycleId), isExitAll: bool(r.isExitAll) };
}
function stateTuple(value) {
  const s = tuple(value, ['params', 'isActive', 'currentCycleId', 'currentCycleStart', 'totalDeposited', 'isPaused', 'isEnd', 'protocolFeeRate']);
  s.params = tuple(s.params, PARAM_FIELDS);
  for (const k of ['underlyingAsset', 'collateralAsset', 'strikeAsset']) s.params[k] = address(s.params[k]);
  s.params.isPut = bool(s.params.isPut);
  for (const k of ['cycleDuration', 'capacity', 'minInvestmentAmount', 'startTime', 'minPrincipalRatio']) s.params[k] = uint(s.params[k]);
  for (const k of ['strikePriceBps', 'buybackPriceRatio']) {
    if (!/^-?(0|[1-9][0-9]*)$/.test(String(s.params[k]))) throw new ValidationError('invalid int256');
    s.params[k] = BigInt(s.params[k]);
    if (s.params[k] < -(2n ** 255n) || s.params[k] >= 2n ** 255n) throw new ValidationError('int256 overflow');
  }
  for (const k of ['isActive', 'isPaused', 'isEnd']) s[k] = bool(s[k]);
  for (const k of ['currentCycleId', 'currentCycleStart', 'totalDeposited', 'protocolFeeRate']) s[k] = uint(s[k]);
  return s;
}
function canonical(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function settledCycleId(currentCycleId, currentPhase) {
  const id = uint(currentCycleId);
  return phase(currentPhase) === 'OPEN' && id > 0n ? id - 1n : id;
}

// EnhancedVault.sol:1410-1428,1676-1718. Amounts are non-additive lenses.
function projectPosition({ state, currentPhase, fund, cumCollateral, cumPremium, currentRecord, deposits = [], requests = [], withdraws = [] }) {
  const s = stateTuple(state), f = fundTuple(fund), ph = phase(currentPhase);
  const cc = uint(cumCollateral), cp = uint(cumPremium), rec = cycleTuple(currentRecord);
  const ds = deposits.map(recordTuple), rs = requests.map(recordTuple), ws = withdraws.map(recordTuple);
  const active = f.activePrincipal === 0n || f.entryCumCollateral === 0n ? f.activePrincipal : f.activePrincipal * cc / f.entryCumCollateral;
  const accumulator = cp + (ph === 'OPEN' ? rec.premiumRatio * cc / P : 0n);
  const unmaterialized = f.activePrincipal === 0n || f.entryCumCollateral === 0n || accumulator < f.entryCumPremium ? 0n : f.activePrincipal * (accumulator - f.entryCumPremium) / f.entryCumCollateral;
  const projected = f.materializedPremium + unmaterialized;
  // Conversion can remove the request record without clearing the private marker
  // (systemPauseFunds -> RecordsLib). Absence is not a proof of marker == 0.
  const exitAllRequested = rs.some(r => r.isExitAll) ? true : null;
  const withdrawSum = ws.filter(r => r.recordType === 2n).reduce((n, r) => n + r.amount, 0n);
  const writable = s.isActive && !s.isPaused && !s.isEnd;
  const claimable = s.isActive && !s.isPaused;
  const finalAmount = active + f.pendingActivePrincipal + f.systemPausedPrincipal;
  const pausedWithdrawEligible = claimable && ph === 'OPEN' && f.systemPausedPrincipal > 0n;
  const pausedWithdrawAllowed = !pausedWithdrawEligible || exitAllRequested === true ? false : null;
  return canonical({
    settledCycleId: settledCycleId(s.currentCycleId, ph), phase: ph,
    collateralAsset: s.params.collateralAsset, strikeAsset: s.params.strikeAsset,
    pendingDeposit: f.pendingActivePrincipal, activeBalance: active,
    requestedWithdraw: f.pendingWithdrawAmount,
    publicPendingWithdrawAmount: exitAllRequested === true || active === f.pendingWithdrawAmount ? active : null,
    exitAllRequested, exitAllMarkerState: exitAllRequested === true ? 'PRESENT_REQUEST_RECORD' : 'UNOBSERVED',
    withdrawRecordClaimable: withdrawSum,
    stoppedPrincipal: f.stoppedPrincipal, stoppedUnrepresentedDust: f.stoppedPrincipal >= withdrawSum ? f.stoppedPrincipal - withdrawSum : null,
    systemPausedPrincipal: f.systemPausedPrincipal, materializedPremium: f.materializedPremium,
    unmaterializedPremium: unmaterialized, projectedPremium: projected, premiumUnit: 'strikeAsset',
    principalExposure: active + f.pendingActivePrincipal + f.stoppedPrincipal + f.systemPausedPrincipal,
    nonAdditive: ['requestedWithdraw', 'publicPendingWithdrawAmount', 'withdrawRecordClaimable', 'materializedPremium', 'projectedPremium'],
    accessibility: {
      withdrawRecordClaim: { allowed: claimable && ws.some(r => r.recordType === 2n && r.amount > 0n && r.amount <= f.stoppedPrincipal), amount: claimable ? withdrawSum : 0n, requiresOpen: false },
      systemPausedToWithdrawRecord: { allowed: pausedWithdrawAllowed, amount: pausedWithdrawAllowed === null ? null : 0n, separateClaimRequired: true },
      finalActiveExit: { allowed: s.isActive && ph === 'ENDED' && finalAmount > 0n, amount: s.isActive && ph === 'ENDED' ? finalAmount : 0n, excludesStoppedPrincipal: true, requiresNotPaused: false },
      premiumClaim: { allowed: claimable && !f.buybackEnabled && !f.autoBuyEnabled && projected > 0n, amount: claimable && !f.buybackEnabled && !f.autoBuyEnabled ? projected : 0n, materializesProjectionFirst: true },
      cancelDepositIds: writable && ph === 'OPEN' ? ds.filter(r => r.recordType === 0n && r.createdCycleId === s.currentCycleId && r.amount <= f.pendingActivePrincipal && r.amount <= f.initialAmountTotal).map(r => r.id) : [],
      cancelWithdrawIds: writable ? rs.filter(r => r.recordType === 1n && (r.isExitAll || r.amount <= f.pendingWithdrawAmount)).map(r => r.id) : [],
      cancelWithdrawRequiresOpen: false,
      settlement: 'operator-only', queueProcessing: 'operator-only', start: 'operator-only', terminate: 'operator-only',
      expiryAloneEnablesRedemption: false,
    },
  });
}

// EnhancedVaultCycleLib.sol:66-91: preserve both floors and zero-active branch.
function settleCycle({ activeCollateral, remainingActiveCollateral, actualReturnedCollateral, totalPremium, protocolFeeRate, previousCumCollateral, previousCumPremium, previousProtocolFeeAccrued = '0' }) {
  const active = uint(activeCollateral), gross = uint(remainingActiveCollateral) + uint(actualReturnedCollateral), premium = uint(totalPremium);
  const rawFee = active * uint(protocolFeeRate) / 10000000n;
  const fee = active === 0n ? 0n : rawFee < gross ? rawFee : gross;
  const net = active === 0n ? 0n : gross - fee;
  const collateralRatio = active === 0n ? P : net * P / active;
  const premiumRatio = active === 0n ? 0n : premium * P / active;
  return canonical({ grossCollateral: gross, protocolFee: fee, netActiveCollateral: net, collateralRatio, premiumRatio, totalPremium: premium,
    cumCollateral: uint(previousCumCollateral) * collateralRatio / P,
    cumPremium: uint(previousCumPremium) + premiumRatio * uint(previousCumCollateral) / P,
    protocolFeeAccrued: uint(previousProtocolFeeAccrued) + fee });
}

// EnhancedVaultRecordsLib.sol:148-278. Input order is the CURRENT storage-array
// order, never sorted IDs. consumed increases by ACTUAL converted, not prorated.
function prorateWithdrawRequests(records, totalRequested, settledActive) {
  const input = records.map(r => ({ id: uint(r.id), amount: uint(r.amount) }));
  if (new Set(input.map(r => String(r.id))).size !== input.length) throw new ValidationError('duplicate request id');
  const total = uint(totalRequested), active = uint(settledActive), budget = total < active ? total : active;
  let consumed = 0n;
  const converted = input.map((r, i) => {
    const available = budget === total ? budget - consumed : i === input.length - 1 ? budget - consumed : r.amount * budget / total;
    const amount = r.amount < available ? r.amount : available;
    consumed += amount;
    return { id: r.id, amount };
  });
  // The full-budget source's second pass removes all remaining zero/unfunded
  // requests too; no request survives either branch.
  return canonical({ stopAmount: budget, claimableConverted: consumed, unrepresentedDust: budget - consumed, converted, remainingRequestIds: [] });
}
function swapPopIds(ids, removedId) {
  const out = ids.map(uint), id = uint(removedId), index = out.findIndex(x => x === id);
  if (index < 0) throw new ValidationError('record not pending');
  out[index] = out[out.length - 1]; out.pop();
  return canonical(out);
}
function exitAllAmount({ stoppedPrincipal, settledActive, pendingActivePrincipal, systemPausedPrincipal }) {
  return (uint(stoppedPrincipal) + uint(settledActive) + uint(pendingActivePrincipal) + uint(systemPausedPrincipal)).toString();
}
function refundPendingDeposits(deposits, stoppedPrincipal) {
  const amounts = deposits.map(recordTuple).filter(r => r.amount > 0n).map(r => r.amount);
  const refunded = amounts.reduce((n, v) => n + v, 0n);
  return canonical({ refunded, stoppedPrincipal: uint(stoppedPrincipal) + refunded, withdrawAmounts: amounts, remainingDepositIds: [], withdrawArrayHasUniversal64Cap: false });
}

function emptyReport() {
  return { observer: 'ethereum-enhanced-r', mode: 'injected-read-only', pipeline: { wired: false }, coverage: { complete: false, errors: [], duplicateEvents: 0 }, classSemantics: { exact: false, scope: 'reviewed historical source model; not a current-runtime assertion' }, pin: null, authorities: {}, vaults: [], users: [], liveAdmission: false, routePositive: 'unknown', executableNow: 'unknown' };
}

/** Injection contract (no ambient IO):
 * pin: {chainId:1,blockNumber,blockHash}; bindings: same pin fields plus
 * {proxy,implementation,cycleLibrary,recordsLibrary}:{address,sourceRuntime},
 * authority:{owner,operator,vaultSigner,enhancedOptions,swapRouter,protocolFeeRecipient}.
 * sourceRuntime MUST be caller-reviewed, fully linked compiled deployed bytecode
 * (including metadata/immutables), not an RPC copy or the historical addresses.
 * provider: getNetwork(),getBlock(number),getCode(address,number),
 * getStorage(address,slot,number). Ethers-like raw values; no signer.
 * contracts.read({target,method,args,pin,abi}) -> envelope below with value.
 * logReader({target,event,fromBlock,toBlock,pin,abi}) -> envelope with
 * fromBlock,toBlock,logs (decoded args; event,address,blockNumber,blockHash,
 * transactionHash,index,removed:false). Each log's block header is checked.
 * Every envelope: {chainId,blockNumber,blockHash,target,complete:true,
 * truncated:false,...}. Adapters MUST mark truncation/failed subreads, not mask
 * them as empty arrays. All calls use the fixed number; headers bracket capture.
 * This is a trust boundary for the supplied adapters, not an RPC implementation.
 */
async function collectEnhancedR(context = {}) {
  const out = emptyReport();
  const fail = message => { out.coverage.errors.push(message); };
  const caps = { ...DEFAULT_CAPS, ...context.caps };
  let pin;
  try {
    for (const [key, v] of Object.entries(caps)) if (!(key in DEFAULT_CAPS) || !Number.isSafeInteger(v) || v <= 0) throw new ValidationError('invalid cap');
    const p = context.pin;
    if (!p || uint(p.chainId) !== 1n) throw new ValidationError('Ethereum chainId=1 required');
    const blockNumber = Number(uint(p.blockNumber));
    if (!Number.isSafeInteger(blockNumber) || blockNumber < DEPLOYMENT_BLOCK) throw new ValidationError('invalid fixed pin block');
    pin = { chainId: '1', blockNumber, blockHash: hex(p.blockHash, 32) };
    out.pin = pin;
    if (!context.provider || typeof context.contracts?.read !== 'function' || typeof context.logReader !== 'function') throw new ValidationError('explicit provider, contracts.read and logReader required');
  } catch (e) { fail(`input: ${failureReason(e, 'INPUT_VALIDATION_FAILED')}`); return out; }
  let reads = 0, pages = 0, totalRecords = 0;
  const headerCache = new Map();
  const budget = () => { if (++reads > caps.maxReads) throw new ValidationError('read cap exceeded'); };
  const samePin = envelope => {
    if (!envelope || uint(envelope.chainId) !== 1n || uint(envelope.blockNumber) !== BigInt(pin.blockNumber) || hex(envelope.blockHash, 32) !== pin.blockHash) throw new ValidationError('wrong pin/chain binding');
  };
  const envelopeValue = (envelope, target) => {
    samePin(envelope);
    if (address(envelope.target) !== target || envelope.complete !== true || envelope.truncated !== false || envelope.overflow === true || envelope.error) throw new ValidationError('incomplete/overflow response or wrong target');
    return envelope.value;
  };
  const read = async (method, args = []) => {
    budget();
    return envelopeValue(await context.contracts.read({ target: ADDRESSES.proxy, method, args: canonical(args), pin: { ...pin }, abi: ABI }), ADDRESSES.proxy);
  };
  const getHeader = async (number, fresh = false) => {
    if (!fresh && headerCache.has(number)) return headerCache.get(number);
    if (headerCache.size >= caps.maxHeaderReads && !headerCache.has(number)) throw new ValidationError('header cap exceeded');
    budget();
    const h = await context.provider.getBlock(number);
    if (!h || uint(h.number) !== BigInt(number)) throw new ValidationError('missing/wrong block header');
    const hash = hex(h.hash, 32);
    if (number === pin.blockNumber && hash !== pin.blockHash) throw new ValidationError('pin block hash mismatch');
    headerCache.set(number, hash);
    return hash;
  };
  // Identity/authority bindings are mandatory; historical metadata alone never
  // makes this an exact observation. Do not enumerate on an unbound deployment.
  try {
    budget();
    if (uint((await context.provider.getNetwork()).chainId) !== 1n) throw new ValidationError('provider wrong chain');
    await getHeader(pin.blockNumber);
    samePin(context.bindings);
    for (const [role, expectedAddress] of Object.entries(ADDRESSES)) {
      const expected = context.bindings[role];
      if (address(expected?.address) !== expectedAddress) throw new ValidationError(`${role} address binding mismatch`);
      const sourceRuntime = bytecode(expected.sourceRuntime);
      budget();
      const observed = bytecode(await context.provider.getCode(expectedAddress, pin.blockNumber));
      if (observed !== sourceRuntime) throw new ValidationError(`${role} runtime/source mismatch`);
      // Exact linked implementation bytes must bind both external libraries.
      if (role === 'implementation' && ![ADDRESSES.cycleLibrary, ADDRESSES.recordsLibrary].every(a => observed.includes(a.slice(2)))) throw new ValidationError('implementation library links missing');
    }
    budget();
    const slot = hex(await context.provider.getStorage(ADDRESSES.proxy, IMPLEMENTATION_SLOT, pin.blockNumber), 32);
    if (slot !== `0x${'0'.repeat(24)}${ADDRESSES.implementation.slice(2)}`) throw new ValidationError('implementation slot mismatch');
    for (const method of AUTHORITY_METHODS) {
      const expected = address(context.bindings.authority?.[method]);
      const observed = address(await read(method));
      if (observed !== expected) throw new ValidationError(`authority mismatch: ${method}`);
      out.authorities[method] = observed;
    }
  } catch (e) { fail(`bindings: ${failureReason(e, 'BINDINGS_READ_FAILED')}`); return out; }

  const vaults = new Set(), depositors = new Map(), seenLogs = new Map();
  for (const event of ['VaultCreated', 'Deposited']) {
    let chunks = 0;
    for (let from = DEPLOYMENT_BLOCK; from <= pin.blockNumber; from += caps.blockChunkSize) {
      if (++chunks > caps.maxChunks) { fail(`${event}: missing log chunks (cap)`); break; }
      const to = Math.min(pin.blockNumber, from + caps.blockChunkSize - 1);
      try {
        budget();
        const response = await context.logReader({ target: ADDRESSES.proxy, event, fromBlock: from, toBlock: to, pin: { ...pin }, abi: ABI });
        envelopeValue(response, ADDRESSES.proxy);
          if (response.fromBlock !== from || response.toBlock !== to || !Array.isArray(response.logs) || response.logs.length > caps.maxLogsPerChunk) throw new ValidationError('missing range/overflow logs');
        for (const log of response.logs) {
          if (log.event !== event || address(log.address) !== ADDRESSES.proxy || log.removed !== false) throw new ValidationError('wrong/removed log identity');
          const number = Number(uint(log.blockNumber));
          if (!Number.isSafeInteger(number) || number < from || number > to) throw new ValidationError('log outside chunk');
          const hash = hex(log.blockHash, 32);
          if (hash !== await getHeader(number)) throw new ValidationError('log block hash mismatch');
          const tx = hex(log.transactionHash, 32), index = uint(log.index).toString();
          const vaultHash = hex(log.args?.vaultHash, 32);
          const user = event === 'Deposited' ? address(log.args?.user) : null;
          const identity = `${tx}:${index}`, content = JSON.stringify(canonical({ event, number, hash, args: log.args }));
          if (seenLogs.has(identity)) {
            if (seenLogs.get(identity) !== content) throw new ValidationError('conflicting duplicate log');
            out.coverage.duplicateEvents++;
            continue;
          }
          seenLogs.set(identity, content);
          if (event === 'VaultCreated') {
            if (!vaults.has(vaultHash) && vaults.size >= caps.maxVaults) throw new ValidationError('vault cap exceeded');
            vaults.add(vaultHash);
          } else {
            const key = `${vaultHash}:${user}`;
            if (!depositors.has(key) && depositors.size >= caps.maxUsers) throw new ValidationError('user cap exceeded');
            depositors.set(key, { vaultHash, user, fromDeposited: true });
          }
        }
      } catch (e) { fail(`${event}[${from},${to}]: ${failureReason(e, 'LOG_READ_FAILED')}`); }
    }
  }
  for (const d of depositors.values()) if (!vaults.has(d.vaultHash)) fail(`depositor without VaultCreated: ${d.vaultHash}`);
  const array = (value, max, label) => {
    if (!Array.isArray(value) || value.length > max) throw new ValidationError(`${label} overflow/invalid array`);
    return value;
  };
  for (const vaultHash of vaults) {
    try {
      const state = stateTuple(await read('vaults', [vaultHash]));
      const ph = phase(await read('vaultPhases', [vaultHash]));
      const q = tuple(await read('getQueueProgress', [vaultHash]), ['phase', 'queueLen', 'processedCount', 'remaining', 'canStartNextCycle']);
      const len = uint(q.queueLen), processed = uint(q.processedCount), remaining = uint(q.remaining);
      if (phase(q.phase) !== ph || processed > len || remaining !== len - processed || bool(q.canStartNextCycle) !== (ph === 'PROCESSING_DONE' && remaining === 0n)) throw new ValidationError('queue progress inconsistent');
      if (len > BigInt(caps.maxUsers)) throw new ValidationError('queue overflow');
      const queueUsers = [], queuedSet = new Set();
      for (let offset = 0; offset < Number(len); offset += caps.pageSize) {
        if (++pages > caps.maxPages) throw new ValidationError('queue page cap exceeded');
        const count = Math.min(caps.pageSize, Number(len) - offset);
        const users = array(await read('getQueueUsers', [vaultHash, offset, count]), count, 'queue page');
        if (users.length !== count) throw new ValidationError('truncated queue page');
        for (const raw of users) {
          const user = address(raw), key = `${vaultHash}:${user}`;
          if (queuedSet.has(user)) throw new ValidationError('duplicate queue user');
          queuedSet.add(user); queueUsers.push(user);
          if (!depositors.has(key)) {
            fail(`queue user absent from Deposited universe: ${key}`);
            if (depositors.size >= caps.maxUsers) throw new ValidationError('user cap exceeded');
            depositors.set(key, { vaultHash, user, fromDeposited: false });
          }
        }
      }
      const cycle = settledCycleId(state.currentCycleId, ph);
      const currentRecord = cycleTuple(await read('cycleRecords', [vaultHash, state.currentCycleId]));
      const settledRecord = cycle === state.currentCycleId ? currentRecord : cycleTuple(await read('cycleRecords', [vaultHash, cycle]));
      const cc = uint(await read('cumCollateral', [vaultHash, cycle]));
      const cp = uint(await read('cumPremium', [vaultHash, cycle]));
      const fee = uint(await read('protocolFeeAccrued', [vaultHash]));
      const ids = array(await read('getVaultIds', [vaultHash, state.currentCycleId]), caps.maxVaultIds, 'vault ids').map(uint);
      if (new Set(ids.map(String)).size !== ids.length) throw new ValidationError('duplicate vault ids');
      const settledIds = cycle === state.currentCycleId ? ids : array(await read('getVaultIds', [vaultHash, cycle]), caps.maxVaultIds, 'settled vault ids').map(uint);
      if (new Set(settledIds.map(String)).size !== settledIds.length) throw new ValidationError('duplicate settled vault ids');
      out.vaults.push(canonical({ vaultHash, state, phase: ph, queue: q, queueUsers, settledCycleId: cycle, currentRecord, settledRecord, cumCollateral: cc, cumPremium: cp, protocolFeeAccrued: fee, currentVaultIds: ids, settledVaultIds: settledIds }));
      for (const d of depositors.values()) {
        if (d.vaultHash !== vaultHash) continue;
        try {
          const fund = fundTuple(await read('userFunds', [vaultHash, d.user]));
          const records = [];
          for (const [index, method] of ['getPendingDeposits', 'getPendingWithdrawRequests', 'getPendingWithdraws'].entries()) {
            const list = array(await read(method, [vaultHash, d.user]), caps.maxRecordsPerUser, method).map(recordTuple);
            if (index === 0 && list.length > 64) throw new ValidationError('deposit source cap exceeded');
            for (const r of list) if (r.id === 0n || r.vaultHash !== vaultHash || r.user !== d.user || r.recordType !== BigInt(index) || r.id > fund.nextRecordId || r.createdCycleId > state.currentCycleId || (r.isExitAll && index === 0)) throw new ValidationError('record identity/type mismatch');
            records.push(list);
          }
          const [deposits, requests, withdraws] = records;
          const all = records.flat();
          totalRecords += all.length;
          if (all.length > caps.maxRecordsPerUser || totalRecords > caps.maxTotalRecords) throw new ValidationError('record cap exceeded');
          if (new Set(all.map(r => String(r.id))).size !== all.length) throw new ValidationError('duplicate record ids');
          if (requests.filter(r => r.isExitAll).length > 1 || requests.some(r => r.isExitAll && r.amount !== 0n)) throw new ValidationError('invalid exit-all requests');
          if (requests.reduce((sum, r) => sum + r.amount, 0n) !== fund.pendingWithdrawAmount) throw new ValidationError('withdraw request ledger mismatch');
          if (withdraws.reduce((sum, r) => sum + r.amount, 0n) > fund.stoppedPrincipal) throw new ValidationError('withdraw records exceed stopped principal');
          const position = projectPosition({ state, currentPhase: ph, fund, cumCollateral: cc, cumPremium: cp, currentRecord, deposits, requests, withdraws });
          const rawPosition = await read('getMyPosition', [vaultHash, d.user]);
          const publicPosition = tuple(rawPosition?.pos ?? rawPosition, POSITION_FIELDS);
          const expected = [position.activeBalance, position.pendingDeposit, position.publicPendingWithdrawAmount, position.stoppedPrincipal, position.systemPausedPrincipal, position.materializedPremium, position.projectedPremium];
          POSITION_FIELDS.forEach((k, i) => {
            const observed = uint(publicPosition[k]).toString();
            // The public pending-withdraw lens can agree under either private
            // marker state, especially when both candidate amounts are zero.
            const matches = expected[i] === null && k === 'pendingWithdrawAmount'
              ? observed === position.activeBalance || observed === position.requestedWithdraw
              : observed === expected[i];
            if (!matches) throw new ValidationError(`public position mismatch: ${k}`);
          });
          out.users.push(canonical({ ...d, fundedUserNotTransferableOwner: true, fund, deposits, requests, withdraws, publicPosition, position }));
        } catch (e) { fail(`user ${vaultHash}:${d.user}: ${failureReason(e, 'USER_READ_FAILED')}`); }
      }
    } catch (e) { fail(`vault ${vaultHash}: ${failureReason(e, 'VAULT_READ_FAILED')}`); }
  }
  try {
    budget();
    if (uint((await context.provider.getNetwork()).chainId) !== 1n) throw new ValidationError('provider chain changed');
    await getHeader(pin.blockNumber, true);
  } catch (e) { fail(`final pin: ${failureReason(e, 'FINAL_PIN_READ_FAILED')}`); }
  out.coverage.vaultCount = vaults.size;
  out.coverage.userCount = depositors.size;
  out.coverage.reads = reads;
  out.coverage.queuePages = pages;
  out.coverage.complete = out.coverage.errors.length === 0 && out.vaults.length === vaults.size && out.users.length === depositors.size;
  out.classSemantics.unobservedState = out.users.some(user => user.position.exitAllRequested === null) ? ['pendingExitAllRequestId'] : [];
  out.classSemantics.exact = out.coverage.complete && out.classSemantics.unobservedState.length === 0;
  if (out.classSemantics.exact) out.classSemantics.scope = 'fixed-pin observation bound to caller-reviewed compiled source runtimes; only the exported accounting/accessibility model';
  return canonical(out);
}

module.exports = { P, DEPLOYMENT_BLOCK, ADDRESSES, IMPLEMENTATION_SLOT, PHASES, AUTHORITY_METHODS, FUND_FIELDS, CYCLE_FIELDS, RECORD_FIELDS, POSITION_FIELDS, ABI, DEFAULT_CAPS, canonical, settledCycleId, projectPosition, settleCycle, prorateWithdrawRequests, swapPopIds, exitAllAmount, refundPendingDeposits, collectEnhancedR };

if (require.main === module) {
  process.stdout.write('ethereum-enhanced-r: offline/injection-only; no RPC, file reads, output artifacts, or live publishing. Use exported pure helpers or collectEnhancedR(explicitContext).\n');
}
