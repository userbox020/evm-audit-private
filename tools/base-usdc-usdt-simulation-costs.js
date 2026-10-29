'use strict';

// Offline cost accounting only. The caller owns transport, budgets, pin provenance,
// transaction/receipt association and settlement/capacity proofs. No execution API.
const { Interface, Transaction, keccak256 } = require('ethers');

const PROXY = '0x420000000000000000000000000000000000000f';
const IMPLEMENTATION = '0x4f1db3c6abd250ba86e0928471a8f7db3afd88f1';
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const PROXY_HASH = '0x1f958654ab06a152993e7a0ae7b6dbb0d4b19265cc9337b8789fe1353bd9dc35';
const IMPLEMENTATION_HASH = '0xe9fc7c96c4db0d6078e3d359d7e8c982c350a513cb2c31121adf5e1e8a446614';
const VERSION = '1.6.0';
const FLAGS = ['isEcotone', 'isFjord', 'isIsthmus', 'isJovian'];
// ABI signatures from the archived published 1.6.0 record, not a compiler rebuild.
const ABI = new Interface([
  'function version() view returns (string)',
  ...FLAGS.map(name => `function ${name}() view returns (bool)`),
  'function getL1Fee(bytes) view returns (uint256)',
  'function getL1FeeUpperBound(uint256) view returns (uint256)',
  'function getOperatorFee(uint256) view returns (uint256)',
]);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEXBYTES = /^0x(?:[0-9a-fA-F]{2})+$/;
const PRINCIPAL = 1000000000n;
const BPS = 10000n;
const PRIORITY_FLOOR = 100000000n;
const WEI_PER_ETH = 10n ** 18n;
const ETH_USD_SCALE = 10n ** 8n;
const USDC_SCALE = 10n ** 6n;
// The conversion numerator includes USDC_SCALE to produce 6-decimal raw USDC.
const CONVERSION_DIVISOR = WEI_PER_ETH * ETH_USD_SCALE;
const ALLOWANCE_NAMES = [
  'slippageUsdcRaw', 'financingUsdcRaw', 'latencyUsdcRaw',
  'competitionUsdcRaw', 'otherUsdcRaw',
];

class Invalid extends Error {
  constructor(code, stage = 'input', transactionIndex = null) {
    super(code);
    this.code = code;
    this.stage = stage;
    this.transactionIndex = transactionIndex;
  }
}

function requireThat(condition, code, stage, index) {
  if (!condition) throw new Invalid(code, stage, index);
}

function decimal(value, code) {
  requireThat(typeof value === 'string' && /^[0-9]+$/.test(value), code);
  return BigInt(value);
}

function basisPoints(value, minimum = 0) {
  requireThat(Number.isSafeInteger(value) && value >= minimum, 'INVALID_ALLOWANCES');
  return BigInt(value);
}

function cleanPin(pin) {
  requireThat(pin, 'INVALID_PIN');
  const { chainId, number, hash, stateRoot, timestamp } = pin;
  requireThat(chainId === 8453 && Number.isSafeInteger(number)
    && number > 0 && typeof hash === 'string' && HEX32.test(hash)
    && typeof stateRoot === 'string' && HEX32.test(stateRoot), 'INVALID_PIN');
  return {
    chainId: 8453, number, hash: hash.toLowerCase(),
    stateRoot: stateRoot.toLowerCase(), timestamp: decimal(timestamp, 'INVALID_PIN').toString(),
  };
}

function samePin(a, b) {
  return ['chainId', 'number', 'hash', 'stateRoot', 'timestamp'].every(key => a[key] === b[key]);
}

function cleanTransactions(rows, exactlyTwo = false) {
  requireThat(Array.isArray(rows) && rows.length >= 1 && rows.length <= 2
    && (!exactlyTwo || rows.length === 2), 'INVALID_TRANSACTIONS');
  const seen = new Set();
  return rows.map(row => {
    requireThat(row, 'INVALID_TRANSACTIONS');
    const suppliedHash = row.hash;
    requireThat(typeof suppliedHash === 'string' && HEX32.test(suppliedHash), 'INVALID_TRANSACTIONS');
    const hash = suppliedHash.toLowerCase();
    requireThat(!seen.has(hash), 'INVALID_TRANSACTIONS');
    seen.add(hash);
    const serialized = row.unsignedSerialized;
    requireThat(typeof serialized === 'string' && serialized.length <= 2 + 65536 * 2
      && HEXBYTES.test(serialized), 'INVALID_TRANSACTIONS');
    const gasLimit = decimal(row.gasLimitRaw, 'INVALID_TRANSACTIONS');
    let tx;
    try {
      tx = Transaction.from(serialized);
      requireThat([0, 1, 2].includes(tx.type) && tx.chainId === 8453n
        && tx.signature === null && !tx.isSigned() && tx.gasLimit === gasLimit
        && tx.unsignedSerialized.toLowerCase() === serialized.toLowerCase(), 'INVALID_TRANSACTIONS');
    } catch {
      throw new Invalid('INVALID_TRANSACTIONS');
    }
    return {
      hash, gasLimitRaw: gasLimit.toString(), unsignedSerialized: serialized.toLowerCase(),
      unsignedSerializedKeccak256: keccak256(serialized), serializedByteLength: (serialized.length - 2) / 2,
    };
  });
}

function failure(error) {
  try {
    if (error instanceof Invalid) return { code: error.code, stage: error.stage, transactionIndex: error.transactionIndex };
  } catch { /* A hostile thrown object is not inspected or returned. */ }
  return { code: 'INVALID_INPUT', stage: 'input', transactionIndex: null };
}

function binding() {
  return {
    matched: false, proxyAddress: PROXY, proxyRuntimeKeccak256: null,
    implementationSlot: SLOT, implementationPointerMatched: false,
    implementationAddress: IMPLEMENTATION, implementationRuntimeKeccak256: null,
  };
}

function supportedFlags(flags) {
  return flags && FLAGS.every(name => typeof flags[name] === 'boolean')
    && flags.isEcotone && flags.isFjord && (!flags.isJovian || flags.isIsthmus);
}

/** All RPC results are opaque/untrusted; only selected, decoded scalars leave this function. */
async function observeFeeCosts(input) {
  const result = {
    status: 'UNKNOWN', pin: null, binding: binding(), version: null,
    flags: Object.fromEntries(FLAGS.map(name => [name, null])), transactions: [], failure: null,
    independentBuildReproduced: false, guaranteedFutureFee: false,
    l1UpperBoundKind: 'FJORD_STATISTICAL_99_99_PERCENT_ESTIMATE_NOT_GUARANTEE',
  };
  try {
    result.pin = cleanPin(input && input.pin);
    const transactions = cleanTransactions(input.unsignedTransactions);
    const read = input.read;
    requireThat(typeof read === 'function', 'INVALID_TRANSPORT');
    // Snapshot the hash and transaction bytes before awaiting caller-controlled code.
    const blockHash = result.pin.hash;
    async function rpc(method, params, stage, index = null) {
      try {
        return await read(method, [...params, { blockHash, requireCanonical: true }]);
      } catch {
        throw new Invalid('READ_FAILED', stage, index);
      }
    }
    async function runtime(address, stage) {
      const code = await rpc('eth_getCode', [address], stage);
      requireThat(typeof code === 'string' && code.length <= 2 + 65536 * 2
        && HEXBYTES.test(code), 'INVALID_RUNTIME', stage);
      return keccak256(code);
    }
    async function getter(name, args = [], index = null) {
      const encoded = ABI.encodeFunctionData(name, args);
      const raw = await rpc('eth_call', [{ to: PROXY, data: encoded }], name, index);
      try {
        requireThat(typeof raw === 'string' && raw.length <= 2050 && HEXBYTES.test(raw), 'ABI_RESULT_INVALID');
        const decoded = ABI.decodeFunctionResult(name, raw);
        // Reject truncated, trailing, noncanonical bool/offset and RPC-envelope results.
        requireThat(ABI.encodeFunctionResult(name, [...decoded]).toLowerCase() === raw.toLowerCase(), 'ABI_RESULT_INVALID');
        return decoded[0];
      } catch {
        throw new Invalid('ABI_RESULT_INVALID', name, index);
      }
    }

    result.binding.proxyRuntimeKeccak256 = await runtime(PROXY, 'proxyRuntime');
    requireThat(result.binding.proxyRuntimeKeccak256 === PROXY_HASH, 'PROXY_RUNTIME_MISMATCH', 'proxyRuntime');
    const pointer = await rpc('eth_getStorageAt', [PROXY, SLOT], 'implementationPointer');
    requireThat(typeof pointer === 'string'
      && pointer.toLowerCase() === `0x${'0'.repeat(24)}${IMPLEMENTATION.slice(2)}`,
    'IMPLEMENTATION_POINTER_MISMATCH', 'implementationPointer');
    result.binding.implementationPointerMatched = true;
    result.binding.implementationRuntimeKeccak256 = await runtime(IMPLEMENTATION, 'implementationRuntime');
    requireThat(result.binding.implementationRuntimeKeccak256 === IMPLEMENTATION_HASH,
      'IMPLEMENTATION_RUNTIME_MISMATCH', 'implementationRuntime');
    result.binding.matched = true;
    const version = await getter('version');
    requireThat(version === VERSION, 'VERSION_UNSUPPORTED', 'version');
    result.version = VERSION;
    for (const name of FLAGS) result.flags[name] = await getter(name);
    requireThat(supportedFlags(result.flags), 'FORK_UNSUPPORTED', 'flags');

    for (const [index, tx] of transactions.entries()) {
      const row = {
        hash: tx.hash, gasLimitRaw: tx.gasLimitRaw, serializedByteLength: tx.serializedByteLength,
        unsignedSerializedKeccak256: tx.unsignedSerializedKeccak256,
        l1FeeWei: null, l1UpperBoundWei: null, operatorFeeWei: null,
      };
      result.transactions.push(row);
      // Full canonical UNSIGNED transaction, never calldata or manually padded signatures.
      row.l1FeeWei = (await getter('getL1Fee', [tx.unsignedSerialized], index)).toString();
      row.l1UpperBoundWei = (await getter('getL1FeeUpperBound', [tx.serializedByteLength], index)).toString();
      // This is an actual pin-bound getter, even on Base and even when the result is zero.
      row.operatorFeeWei = (await getter('getOperatorFee', [BigInt(tx.gasLimitRaw)], index)).toString();
    }
    result.status = 'OBSERVED';
  } catch (error) {
    result.failure = failure(error);
  }
  return result;
}

function ceil(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function max(a, b) {
  return a > b ? a : b;
}

function cleanObservation(observation, pin, transactions) {
  requireThat(observation && observation.status === 'OBSERVED' && observation.failure === null,
    'FEE_OBSERVATION_UNAVAILABLE');
  requireThat(samePin(cleanPin(observation.pin), pin), 'FEE_PIN_MISMATCH');
  const bound = observation.binding;
  requireThat(bound && bound.matched === true && bound.proxyAddress === PROXY
    && bound.proxyRuntimeKeccak256 === PROXY_HASH && bound.implementationSlot === SLOT
    && bound.implementationPointerMatched === true && bound.implementationAddress === IMPLEMENTATION
    && bound.implementationRuntimeKeccak256 === IMPLEMENTATION_HASH
    && observation.version === VERSION && supportedFlags(observation.flags)
    && observation.independentBuildReproduced === false && observation.guaranteedFutureFee === false,
  'FEE_BINDING_INVALID');
  requireThat(Array.isArray(observation.transactions) && observation.transactions.length === transactions.length,
    'FEE_TRANSACTIONS_MISMATCH');
  const seen = new Set();
  const fees = new Map();
  for (const row of observation.transactions) {
    requireThat(row && typeof row.hash === 'string' && HEX32.test(row.hash), 'FEE_TRANSACTIONS_MISMATCH');
    const hash = row.hash.toLowerCase();
    const tx = transactions.find(item => item.hash === hash);
    requireThat(tx && !seen.has(hash) && row.gasLimitRaw === tx.gasLimitRaw
      && row.serializedByteLength === tx.serializedByteLength
      && row.unsignedSerializedKeccak256 === tx.unsignedSerializedKeccak256, 'FEE_TRANSACTIONS_MISMATCH');
    seen.add(hash);
    const amounts = {};
    for (const name of ['l1FeeWei', 'l1UpperBoundWei', 'operatorFeeWei']) {
      amounts[name] = decimal(row[name], 'FEE_VALUES_INVALID');
      requireThat(amounts[name] < 2n ** 256n, 'FEE_VALUES_INVALID');
    }
    fees.set(hash, amounts);
  }
  return fees;
}

/** Pure evaluation of caller-supplied evidence, not authentication of that evidence. */
function evaluateCosts(evidence) {
  const result = {
    status: 'UNKNOWN', pin: null, transactions: [], pricing: null, allowances: null, costs: null,
    netUsdcRaw: null, qualifiedAtPin: false, liveReady: false, signingAuthorized: false,
    realizedProfit: null, guaranteedFutureFee: false, failure: null,
    assumptions: {
      basis: 'CALLER_SETTLEMENT_AT_PIN', principalUsdcRaw: PRINCIPAL.toString(),
      callerMustProveCapacityRepaymentAndReceiptAssociation: true,
      actorDeltaIncludesVenueFeesAndPrincipalRepayment: true,
      quoteHaircutFloorBps: 60, priorityFeeFloorWei: PRIORITY_FLOOR.toString(),
      l2GasPriceRule: 'MAX_EFFECTIVE_AND_CEIL_BASE_9_OVER_8_PLUS_MAX_PRIORITY_FLOOR',
      l1FeeRule: 'MAX_OBSERVED_AND_UPPER_BOUND',
      l1UpperBoundKind: 'FJORD_STATISTICAL_99_99_PERCENT_ESTIMATE_NOT_GUARANTEE',
      operatorFeeGasBasis: 'GAS_LIMIT', networkMarginRounding: 'UP_IN_WEI',
      ethHaircutRounding: 'UP_IN_8_DECIMAL_ETH_USD_PRICE', usdcConversionRounding: 'UP_ON_AGGREGATE_NETWORK_FEE',
      contractConversionDivisor: CONVERSION_DIVISOR.toString(),
      ethUsdDecimals: 8, usdcDecimals: 6, independentBuildReproduced: false,
      futureProfitGuaranteed: false,
    },
  };
  try {
    result.pin = cleanPin(evidence && evidence.pin);
    const settlement = evidence.settlement;
    requireThat(settlement && settlement.status === 'PASS' && settlement.callbackComplete === true
      && settlement.bothSwapsComplete === true, 'SETTLEMENT_UNPROVEN');
    requireThat(decimal(settlement.principalRepaidRaw, 'SETTLEMENT_UNPROVEN') === PRINCIPAL
      && decimal(settlement.actorBeforeRaw, 'SETTLEMENT_UNPROVEN') === 0n
      && decimal(settlement.executorInitialUsdcRaw, 'SETTLEMENT_UNPROVEN') === 0n, 'SETTLEMENT_UNPROVEN');
    const actorDelta = decimal(settlement.actorAfterRaw, 'SETTLEMENT_UNPROVEN');
    const transactions = cleanTransactions(evidence.transactions, true);
    const fees = cleanObservation(evidence.feeObservation, result.pin, transactions);
    const pricing = evidence.pricing;
    requireThat(pricing, 'INVALID_PRICING');
    const ethUsd = decimal(pricing.ethUsdRaw, 'INVALID_PRICING');
    requireThat(ethUsd > 0n, 'INVALID_PRICING');
    const baseFee = decimal(pricing.baseFeeWei, 'INVALID_PRICING');
    const priorityFee = decimal(pricing.priorityFeeWei, 'INVALID_PRICING');
    const allowances = evidence.allowances;
    requireThat(allowances, 'INVALID_ALLOWANCES');
    const quoteBps = basisPoints(allowances.quoteHaircutBps, 60);
    const conversionBps = basisPoints(allowances.ethConversionHaircutBps);
    const networkBps = basisPoints(allowances.networkFeeMarginBps);
    const explicit = {};
    let explicitTotal = 0n;
    for (const name of ALLOWANCE_NAMES) {
      const amount = decimal(allowances[name], 'INVALID_ALLOWANCES');
      explicit[name] = amount.toString();
      explicitTotal += amount;
    }
    const stressedEthUsd = ceil(ethUsd * (BPS + conversionBps), BPS);
    const stressedL2GasPrice = ceil(baseFee * 9n, 8n) + max(priorityFee, PRIORITY_FLOOR);
    let l2Total = 0n;
    let l1Total = 0n;
    let operatorTotal = 0n;
    const computed = transactions.map((tx, index) => {
      const receipt = evidence.transactions[index];
      const gasUsed = decimal(receipt.gasUsedRaw, 'INVALID_GAS');
      requireThat(gasUsed <= BigInt(tx.gasLimitRaw), 'INVALID_GAS');
      const effective = decimal(receipt.effectiveGasPriceWei, 'INVALID_GAS');
      const gasPrice = max(effective, stressedL2GasPrice);
      const fee = fees.get(tx.hash);
      const l2 = gasUsed * gasPrice;
      const l1 = max(fee.l1FeeWei, fee.l1UpperBoundWei);
      l2Total += l2;
      l1Total += l1;
      operatorTotal += fee.operatorFeeWei;
      return {
        hash: tx.hash, unsignedSerializedKeccak256: tx.unsignedSerializedKeccak256,
        serializedByteLength: tx.serializedByteLength, gasLimitRaw: tx.gasLimitRaw,
        gasUsedRaw: gasUsed.toString(), effectiveGasPriceWei: effective.toString(),
        l2GasPriceWei: gasPrice.toString(), l2FeeWei: l2.toString(),
        l1FeeWei: fee.l1FeeWei.toString(), l1UpperBoundWei: fee.l1UpperBoundWei.toString(),
        l1ChargedEstimateWei: l1.toString(), operatorFeeWei: fee.operatorFeeWei.toString(),
        networkFeeWei: (l2 + l1 + fee.operatorFeeWei).toString(),
      };
    });
    const network = l2Total + l1Total + operatorTotal;
    const networkWithMargin = ceil(network * (BPS + networkBps), BPS);
    // wei * (USD/ETH scaled by 1e8) * raw-USDC/USD / (wei/ETH * 1e8).
    const networkUsdc = ceil(networkWithMargin * stressedEthUsd * USDC_SCALE, CONVERSION_DIVISOR);
    const quoteHaircut = ceil(PRINCIPAL * quoteBps, BPS);
    const total = networkUsdc + quoteHaircut + explicitTotal;
    const net = actorDelta - total;
    result.transactions = computed;
    result.pricing = {
      ethUsdRaw: ethUsd.toString(), ethUsdAfterHaircutRaw: stressedEthUsd.toString(),
      baseFeeWei: baseFee.toString(), priorityFeeWei: priorityFee.toString(),
      stressedL2GasPriceWei: stressedL2GasPrice.toString(),
    };
    result.allowances = {
      quoteHaircutBps: Number(quoteBps), ...explicit,
      ethConversionHaircutBps: Number(conversionBps),
      networkFeeMarginBps: Number(networkBps),
    };
    result.costs = {
      actorDeltaUsdcRaw: actorDelta.toString(), l2FeeWei: l2Total.toString(),
      l1ChargedEstimateWei: l1Total.toString(), operatorFeeWei: operatorTotal.toString(),
      networkFeeWei: network.toString(), networkFeeMarginWei: (networkWithMargin - network).toString(),
      networkFeeWithMarginWei: networkWithMargin.toString(), networkUsdcRaw: networkUsdc.toString(),
      quoteHaircutUsdcRaw: quoteHaircut.toString(), ...explicit,
      explicitAllowancesUsdcRaw: explicitTotal.toString(), totalCostsUsdcRaw: total.toString(),
    };
    result.netUsdcRaw = net.toString();
    result.qualifiedAtPin = net > 0n;
    result.status = net > 0n ? 'POSITIVE_AT_PIN' : 'NONPOSITIVE';
  } catch (error) {
    result.failure = failure(error);
  }
  return result;
}

module.exports = { observeFeeCosts, evaluateCosts };
