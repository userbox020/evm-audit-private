"use strict";

const { accessListify } = require("../node_modules/ethers");
const { ExecutionError, requireThat, uint, MAIN_ACCOUNT } = require("./wallet-execution-guard.js");
const PROBE_INITCODE = "0x436000524260205260406000f3";
const UNKNOWN_HASH = "0x" + "f".repeat(64);
const PROBE_GAS_LIMIT = 100000n, PROBE_FEE_CAP = 100000000000n;
const MAX_UINT256 = (1n << 256n) - 1n, MAX_UINT64 = (1n << 64n) - 1n;
const MAX_BYTES = 1024 * 1024;
const hex = n => "0x" + BigInt(n).toString(16);
const hash = x => typeof x === "string" && /^0x[0-9a-f]{64}$/i.test(x);
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (x, allowed) => object(x) && Object.keys(x).every(key => allowed.includes(key));
function quantity(value, code, max = MAX_UINT256) {
  const n = uint(value, code); requireThat(n <= max, code); return hex(n);
}
function bytes(value, code) {
  requireThat(typeof value === "string" && value.length <= MAX_BYTES * 2 + 2 && /^0x(?:[0-9a-f]{2})*$/i.test(value), code);
  return value.toLowerCase();
}
function address(value, code) {
  requireThat(typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value), code); return value.toLowerCase();
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function contextFor(pin, seconds, chainId = 1) {
  const code = "NEXT_BLOCK_CONTEXT_INVALID";
  requireThat(object(pin) && hash(pin.hash) && uint(chainId, code) === 1n && [12, 24].includes(seconds), code);
  const number = Number(uint(pin.number, code)), timestamp = Number(uint(pin.timestamp, code));
  requireThat(Number.isSafeInteger(number) && number >= 0 && Number.isSafeInteger(number + 1) &&
    Number.isSafeInteger(timestamp) && timestamp >= 0 && Number.isSafeInteger((timestamp + seconds) * 1000), code);
  return freeze({ chainId: 1, parentHash: pin.hash.toLowerCase(), parentNumber: number, parentTimestamp: timestamp,
    number: number + 1, timestamp: timestamp + seconds, seconds });
}
// The public forecast is always exactly +12s. +24s is an internal qualification control.
function createNextBlockContext(pin, chainId = 1) { return contextFor(pin, 12, chainId); }
function checkedContext(context) {
  requireThat(object(context), "NEXT_BLOCK_CONTEXT_INVALID");
  const expected = contextFor({ hash: context.parentHash, number: context.parentNumber, timestamp: context.parentTimestamp }, context.seconds, context.chainId);
  requireThat(keys(context, Object.keys(expected)) && Object.keys(expected).every(key => context[key] === expected[key]),
    "NEXT_BLOCK_CONTEXT_INVALID"); return expected;
}
function normalizeSimulationTransaction(tx) {
  const code = "NEXT_BLOCK_TX_INVALID";
  try {
    requireThat(keys(tx, ["type", "from", "to", "input", "data", "value", "nonce", "gas", "gasLimit", "maxFeePerGas",
      "maxPriorityFeePerGas", "chainId", "accessList"]), code);
    const alias = (a, b, normalize) => {
      const result = normalize(tx[a] ?? tx[b]);
      if (tx[a] !== undefined && tx[b] !== undefined) requireThat(result === normalize(tx[b]), code);
      return result;
    };
    const type = quantity(tx.type, code), chainId = quantity(tx.chainId, code);
    requireThat(type === "0x2" && chainId === "0x1" && tx.accessList != null, code);
    const gas = alias("gas", "gasLimit", v => quantity(v, code, MAX_UINT64));
    const maxFeePerGas = quantity(tx.maxFeePerGas, code), maxPriorityFeePerGas = quantity(tx.maxPriorityFeePerGas, code);
    requireThat(BigInt(gas) >= 21000n && BigInt(maxFeePerGas) > 0n && BigInt(maxFeePerGas) >= BigInt(maxPriorityFeePerGas), code);
    const list = accessListify(tx.accessList);
    requireThat(list.length <= 4096, code);
    const accessList = Array.from(list, row => {
      requireThat(object(row) && Array.isArray(row.storageKeys) && row.storageKeys.length <= 4096 && Array.from(row.storageKeys).every(hash), code);
      return { address: address(row.address, code), storageKeys: row.storageKeys.map(key => key.toLowerCase()) };
    });
    return freeze({ type, from: address(tx.from, code), to: tx.to === null ? null : address(tx.to, code),
      input: alias("input", "data", v => bytes(v, code)), value: quantity(tx.value, code), nonce: quantity(tx.nonce, code, MAX_UINT64),
      gas, maxFeePerGas, maxPriorityFeePerGas, chainId, accessList });
  } catch (_) { throw new ExecutionError(code); }
}
function buildNextBlockRequest(context, transaction) {
  const c = checkedContext(context), tx = normalizeSimulationTransaction(transaction);
  return [{ blockStateCalls: [{ blockOverrides: { number: hex(c.number), time: hex(c.timestamp) }, calls: [tx] }],
    validation: true, traceTransfers: false, returnFullTransactions: true }, { blockHash: c.parentHash, requireCanonical: true }];
}
function validateNextBlockParams(params) {
  const code = "NEXT_BLOCK_OPTIONS_INVALID";
  try {
    requireThat(Array.isArray(params) && params.length === 2, code);
    const [payload, ref] = params;
    requireThat(keys(payload, ["blockStateCalls", "validation", "traceTransfers", "returnFullTransactions"]) &&
      payload.validation === true && payload.traceTransfers === false && payload.returnFullTransactions === true &&
      Array.isArray(payload.blockStateCalls) && payload.blockStateCalls.length === 1 &&
      keys(ref, ["blockHash", "requireCanonical"]) && hash(ref.blockHash) && ref.requireCanonical === true, code);
    const block = payload.blockStateCalls[0];
    requireThat(keys(block, ["blockOverrides", "calls"]) && keys(block.blockOverrides, ["number", "time"]) &&
      Array.isArray(block.calls) && block.calls.length === 1, code);
    for (const value of [block.blockOverrides.number, block.blockOverrides.time])
      requireThat(typeof value === "string" && value === quantity(value, code, BigInt(Number.MAX_SAFE_INTEGER)) && BigInt(value) > 0n, code);
    const tx = normalizeSimulationTransaction(block.calls[0]);
    requireThat(keys(block.calls[0], Object.keys(tx)) && Object.keys(tx).every(key => same(block.calls[0][key], tx[key])), code);
  } catch (_) { throw new ExecutionError(code); }
}
function normalizeNextBlockResult(raw, context, transaction) {
  const c = checkedContext(context), tx = normalizeSimulationTransaction(transaction), code = "NEXT_BLOCK_RESULT_INVALID";
  requireThat(Array.isArray(raw) && raw.length === 1 && object(raw[0]), code);
  const block = raw[0];
  requireThat(!Object.hasOwn(block, "error") && hash(block.parentHash) && block.parentHash.toLowerCase() === c.parentHash &&
    quantity(block.number, code) === hex(c.number) && quantity(block.timestamp, code) === hex(c.timestamp) &&
    Array.isArray(block.calls) && block.calls.length === 1 && object(block.calls[0]) &&
    Array.isArray(block.transactions) && block.transactions.length === 1 && object(block.transactions[0]), code);
  const call = block.calls[0], returned = block.transactions[0];
  requireThat(!Object.hasOwn(call, "error") && quantity(call.status, code) === "0x1", "NEXT_BLOCK_REVERTED");
  let execution;
  try {
    execution = normalizeSimulationTransaction({ type: returned.type, from: returned.from, to: returned.to, input: returned.input,
      ...(Object.hasOwn(returned, "data") ? { data: returned.data } : {}), value: returned.value, nonce: returned.nonce, gas: returned.gas,
      ...(Object.hasOwn(returned, "gasLimit") ? { gasLimit: returned.gasLimit } : {}), maxFeePerGas: returned.maxFeePerGas,
      maxPriorityFeePerGas: returned.maxPriorityFeePerGas, chainId: returned.chainId, accessList: returned.accessList });
  } catch (_) { throw new ExecutionError("NEXT_BLOCK_TX_MISMATCH"); }
  requireThat(same(execution, tx), "NEXT_BLOCK_TX_MISMATCH");
  const gasUsed = quantity(call.gasUsed, code);
  requireThat(BigInt(gasUsed) > 0n && BigInt(gasUsed) <= BigInt(tx.gas), code);
  const transactionHash = Object.hasOwn(returned, "hash") ? returned.hash : undefined;
  requireThat(transactionHash === undefined || hash(transactionHash), code);
  requireThat(!Object.hasOwn(call, "transactionHash") || (hash(call.transactionHash) && transactionHash &&
    call.transactionHash.toLowerCase() === transactionHash.toLowerCase()), code);
  requireThat(Array.isArray(call.logs) && call.logs.length <= 10000, code);
  let previousIndex = -1n;
  const logs = Array.from(call.logs, log => {
    requireThat(object(log) && Array.isArray(log.topics) && log.topics.length <= 4 && Array.from(log.topics).every(hash) &&
      (!Object.hasOwn(log, "removed") || log.removed === false), code);
    if (Object.hasOwn(log, "blockNumber")) requireThat(quantity(log.blockNumber, code) === hex(c.number), code);
    if (Object.hasOwn(log, "transactionIndex")) requireThat(quantity(log.transactionIndex, code) === "0x0", code);
    if (Object.hasOwn(log, "transactionHash")) requireThat(hash(log.transactionHash) && transactionHash &&
      log.transactionHash.toLowerCase() === transactionHash.toLowerCase(), code);
    if (Object.hasOwn(log, "blockHash")) requireThat(hash(block.hash) && hash(log.blockHash) &&
      block.hash.toLowerCase() === log.blockHash.toLowerCase(), code);
    if (Object.hasOwn(log, "logIndex")) {
      const index = BigInt(quantity(log.logIndex, code)); requireThat(index > previousIndex, code); previousIndex = index;
    }
    // Ordered execution logs only, not a synthetic on-chain receipt or profit claim.
    return { address: address(log.address, code), topics: log.topics.map(topic => topic.toLowerCase()), data: bytes(log.data, code) };
  });
  return freeze({ context: { ...c, transaction: execution }, returnData: bytes(call.returnData, code), gasUsed, gasLimit: tx.gas, logs,
    ...(transactionHash === undefined ? {} : { transactionHash: transactionHash.toLowerCase() }) });
}
function buildNextBlockProbeTransaction(pin, nonce, balance) {
  const code = "NEXT_BLOCK_PROBE_UNFUNDED";
  const base = uint(pin.baseFeePerGas, code), maxFee = base + (base + 7n) / 8n + 1n;
  requireThat(uint(pin.gasLimit, code) >= PROBE_GAS_LIMIT && maxFee <= PROBE_FEE_CAP &&
    uint(balance, code) >= PROBE_GAS_LIMIT * maxFee, code);
  return normalizeSimulationTransaction({ type: 2, chainId: 1, from: MAIN_ACCOUNT, to: null, data: PROBE_INITCODE, value: 0,
    nonce, gasLimit: PROBE_GAS_LIMIT, maxFeePerGas: maxFee, maxPriorityFeePerGas: 1, accessList: [] });
}
async function qualifyNextBlockProvider({ provider, pin, request, parallelQualification = false }, internal = {}) {
  requireThat(typeof parallelQualification === "boolean" && (internal.onTrustFailure === undefined || typeof internal.onTrustFailure === "function"), "NEXT_BLOCK_OPTIONS_INVALID");
  const context = createNextBlockContext(pin), ref = { blockHash: context.parentHash, requireCanonical: true };
  requireThat(context.parentHash !== UNKNOWN_HASH, "NEXT_BLOCK_CONTEXT_INVALID");
  // Only v2 opts in. Each stage drains both started jobs; private revocation is
  // synchronous on an observed trust failure, not delayed by the sibling drain.
  const checked = async invoke => {
    try { return await invoke(); }
    catch (error) {
      if (parallelQualification) {
        const safe = safeNextBlockError(error, true);
        if (nextBlockFailurePriority(safe)) { try { internal.onTrustFailure?.(safe); } catch (_) {} }
        throw safe;
      }
      throw error;
    }
  };
  const pair = jobs => Promise.allSettled(jobs.map(invoke => checked(invoke))).then(settledValues);
  const [nonce, balance] = parallelQualification ? await pair([
    async () => uint(await request(provider, "eth_getTransactionCount", [MAIN_ACCOUNT, { ...ref }]), "NEXT_BLOCK_TX_INVALID"),
    async () => uint(await request(provider, "eth_getBalance", [MAIN_ACCOUNT, { ...ref }]), "NEXT_BLOCK_PROBE_UNFUNDED"),
  ]) : [await request(provider, "eth_getTransactionCount", [MAIN_ACCOUNT, ref]), await request(provider, "eth_getBalance", [MAIN_ACCOUNT, ref])];
  const tx = buildNextBlockProbeTransaction(pin, nonce, balance);
  const positive = async c => {
    const result = normalizeNextBlockResult(await request(provider, "eth_simulateV1", buildNextBlockRequest(c, tx)), c, tx);
    const words = "0x" + BigInt(c.number).toString(16).padStart(64, "0") + BigInt(c.timestamp).toString(16).padStart(64, "0");
    requireThat(result.returnData === words, "NEXT_BLOCK_OVERRIDES_IGNORED");
  };
  if (parallelQualification) await pair([contextFor(pin, 24), context].map(c => () => positive(c)));
  else for (const c of [contextFor(pin, 24), context]) await positive(c);
  await checked(async () => {
    let rejected = false;
    const params = buildNextBlockRequest(context, tx); params[1].blockHash = UNKNOWN_HASH;
    try { await request(provider, "eth_simulateV1", params); }
    catch (error) { if (!(error instanceof ExecutionError) || error.code !== "UNKNOWN_BLOCK_REJECTED") throw error; rejected = true; }
    requireThat(rejected, "NEXT_BLOCK_UNKNOWN_HASH_NOT_REJECTED");
  });
  return { nextBlockQualified: true, numberTimestampVerified: true, timeControlVerified: true, simulationUnknownHashRejected: true };
}
function normalizedHeader(raw) {
  const code = "NEXT_BLOCK_HEADER_INVALID";
  requireThat(object(raw) && hash(raw.hash) && hash(raw.parentHash) && hash(raw.stateRoot), code);
  return { number: quantity(raw.number, code), hash: raw.hash.toLowerCase(), parentHash: raw.parentHash.toLowerCase(),
    stateRoot: raw.stateRoot.toLowerCase(), timestamp: quantity(raw.timestamp, code),
    baseFeePerGas: quantity(raw.baseFeePerGas, code), gasLimit: quantity(raw.gasLimit, code) };
}
const SAFE_CODES = new Set(["NEXT_BLOCK_CONTEXT_INVALID", "NEXT_BLOCK_OPTIONS_INVALID", "NEXT_BLOCK_TX_INVALID", "NEXT_BLOCK_RESULT_INVALID",
  "NEXT_BLOCK_TX_MISMATCH", "NEXT_BLOCK_REVERTED", "NEXT_BLOCK_PROBE_UNFUNDED", "NEXT_BLOCK_OVERRIDES_IGNORED",
  "NEXT_BLOCK_UNKNOWN_HASH_NOT_REJECTED", "NEXT_BLOCK_METHOD_UNAVAILABLE", "NEXT_BLOCK_HEADER_INVALID", "NEXT_BLOCK_DEADLINE",
  "NEXT_BLOCK_CLOCK_INVALID", "NEXT_BLOCK_WRONG_CHAIN", "NEXT_BLOCK_PARENT_CHANGED", "NEXT_BLOCK_HEAD_ADVANCED", "NEXT_BLOCK_HEAD_STALE",
  "NEXT_BLOCK_PROVIDER_DISAGREEMENT", "NEXT_BLOCK_CANONICAL_DISAGREEMENT", "NEXT_BLOCK_TRUST_FAILED",
  "NEXT_BLOCK_PARENT_INVALIDATED", "NEXT_BLOCK_EVIDENCE_INVALIDATED", "NEXT_BLOCK_RPC_FAILED",
  "RPC_TIMEOUT", "RPC_RESPONSE_TOO_LARGE"]);
function safeNextBlockError(error, strict = false) {
  const availability = ["PINNED_RPC_FAILED", "RPC_TRANSPORT_ERROR", "RPC_HTTP_RETRYABLE", "M1_HOT_PATH_CANCELLED", "M1_HOT_PATH_BUDGET",
    "M1_CAPABILITY_EXPIRED", "M1_CAPABILITY_INVALIDATED", "M1_CAPABILITY_CONTEXT_CHANGED", "M1_CAPABILITY_CONTEXT_INVALID"];
  return new ExecutionError(error instanceof ExecutionError && SAFE_CODES.has(error.code) ? error.code :
    strict && !(error instanceof ExecutionError && availability.includes(error.code)) ? "NEXT_BLOCK_TRUST_FAILED" : "NEXT_BLOCK_RPC_FAILED");
}
// Parent/header trust outranks simulation-only trust, which outranks benign
// child expiry/availability. Unknown failures must not acquire an expiry exemption.
function nextBlockFailurePriority(error) {
  if (["NEXT_BLOCK_WRONG_CHAIN", "NEXT_BLOCK_HEADER_INVALID", "NEXT_BLOCK_CANONICAL_DISAGREEMENT", "NEXT_BLOCK_PARENT_CHANGED",
    "NEXT_BLOCK_PARENT_INVALIDATED", "NEXT_BLOCK_CLOCK_INVALID"].includes(error?.code)) return 2;
  return ["NEXT_BLOCK_DEADLINE", "NEXT_BLOCK_HEAD_ADVANCED", "NEXT_BLOCK_REVERTED", "NEXT_BLOCK_METHOD_UNAVAILABLE", "NEXT_BLOCK_PROBE_UNFUNDED",
    "NEXT_BLOCK_EVIDENCE_INVALIDATED", "NEXT_BLOCK_RPC_FAILED", "RPC_TIMEOUT", "M1_HOT_PATH_CANCELLED"].includes(error?.code) ? 0 : 1;
}
function settledValues(settled) {
  const failures = settled.filter(row => row.status === "rejected").map(row => row.reason);
  failures.sort((a, b) => nextBlockFailurePriority(b) - nextBlockFailurePriority(a));
  if (failures.length) throw failures[0];
  return settled.map(row => row.value);
}
function createNextBlockSimulation({ pin, providers, request, now, assertUsable, classifyNormalAdvance = false, parallelRecheck = false }, internal = {}) {
  requireThat(typeof parallelRecheck === "boolean", "NEXT_BLOCK_OPTIONS_INVALID");
  requireThat(internal.onParentTrustFailure === undefined || typeof internal.onParentTrustFailure === "function", "NEXT_BLOCK_OPTIONS_INVALID");
  const context = createNextBlockContext(pin), expected = normalizedHeader(pin);
  requireThat(providers.length === 2 && providers[0].family !== providers[1].family, "TWO_NEXT_BLOCK_CAPABLE_FAMILIES_REQUIRED");
  const pair = providers.slice(); let invalidated = false, parentFailureReported = false;
  function reportParentFailure(error) {
    // Private v2 revocation only: do not wait for allSettled to make a detected
    // contradiction visible to CURRENT's physical dispatch guards. The hook
    // cannot authorize a result, change the original error, or skip the drain.
    const safe = safeNextBlockError(error, classifyNormalAdvance);
    if (internal.onParentTrustFailure && !parentFailureReported && nextBlockFailurePriority(safe) === 2) {
      invalidated = true; parentFailureReported = true;
      try { internal.onParentTrustFailure(); } catch (_) {} // Child remains invalid even if the private revoker throws.
    }
    return error;
  }
  function usable() {
    requireThat(!invalidated, "NEXT_BLOCK_EVIDENCE_INVALIDATED");
    try { assertUsable(); } catch (_) { throw new ExecutionError("NEXT_BLOCK_PARENT_INVALIDATED"); }
  }
  function deadline() {
    const time = now();
    requireThat(Number.isSafeInteger(time) && time >= context.parentTimestamp * 1000, "NEXT_BLOCK_CLOCK_INVALID");
    requireThat(time < context.timestamp * 1000, "NEXT_BLOCK_DEADLINE");
  }
  async function recheck() {
    try {
      usable(); deadline();
      const settled = await Promise.allSettled(pair.map(async provider => {
        try {
          requireThat(uint(await request(provider, "eth_chainId", []), "NEXT_BLOCK_WRONG_CHAIN") === 1n, "NEXT_BLOCK_WRONG_CHAIN");
          if (parallelRecheck) {
            // The chain must validate first. Revoke observed parent trust now,
            // but still drain both reads and select the aggregate error in order.
            const [canonical, head] = settledValues(await Promise.allSettled([
              (async () => {
                try {
                  const value = normalizedHeader(await request(provider, "eth_getBlockByNumber", [hex(context.parentNumber), false]));
                  if (classifyNormalAdvance) requireThat(same(value, expected), "NEXT_BLOCK_CANONICAL_DISAGREEMENT");
                  return value;
                } catch (error) { throw reportParentFailure(error); }
              })(),
              (async () => {
                try {
                  const value = normalizedHeader(await request(provider, "eth_getBlockByNumber", ["latest", false]));
                  if (classifyNormalAdvance && value.number === expected.number)
                    requireThat(same(value, expected), "NEXT_BLOCK_CANONICAL_DISAGREEMENT");
                  return value;
                } catch (error) { throw reportParentFailure(error); }
              })(),
            ]));
            return { canonical, head };
          }
          const canonical = normalizedHeader(await request(provider, "eth_getBlockByNumber", [hex(context.parentNumber), false]));
          if (classifyNormalAdvance) requireThat(same(canonical, expected), "NEXT_BLOCK_CANONICAL_DISAGREEMENT");
          const head = normalizedHeader(await request(provider, "eth_getBlockByNumber", ["latest", false]));
          if (classifyNormalAdvance && head.number === expected.number)
            requireThat(same(head, expected), "NEXT_BLOCK_CANONICAL_DISAGREEMENT");
          return { canonical, head };
        } catch (error) { throw reportParentFailure(error); }
      }));
      const [a, b] = settledValues(settled);
      if (classifyNormalAdvance && same(a.canonical, expected) && same(b.canonical, expected) &&
        [a, b].every(row => BigInt(row.head.number) >= BigInt(expected.number)) &&
        [a, b].some(row => BigInt(row.head.number) > BigInt(expected.number))) {
        const maximum = [a, b].reduce((n, row) => BigInt(row.head.number) > n ? BigInt(row.head.number) : n, BigInt(expected.number));
        requireThat(maximum - BigInt(expected.number) <= 4n, "NEXT_BLOCK_CANONICAL_DISAGREEMENT");
        let previous = expected;
        // A staggered ordinary head is not a provider disagreement only after
        // both witnesses corroborate the complete bounded canonical extension.
        for (let number = BigInt(expected.number) + 1n; number <= maximum; number++) {
          const headers = settledValues(await Promise.allSettled(pair.map(async provider => {
            try { return normalizedHeader(await request(provider, "eth_getBlockByNumber", [hex(number), false])); }
            catch (error) { throw reportParentFailure(error); }
          })));
          requireThat(same(headers[0], headers[1]) && BigInt(headers[0].number) === number && headers[0].parentHash === previous.hash &&
            BigInt(headers[0].timestamp) > BigInt(previous.timestamp), "NEXT_BLOCK_CANONICAL_DISAGREEMENT");
          for (const row of [a, b]) if (BigInt(row.head.number) === number) requireThat(same(row.head, headers[0]), "NEXT_BLOCK_CANONICAL_DISAGREEMENT");
          previous = headers[0];
        }
        for (const row of [a, b]) if (row.head.number === expected.number) requireThat(same(row.head, expected), "NEXT_BLOCK_PARENT_CHANGED");
        usable(); deadline(); throw new ExecutionError("NEXT_BLOCK_HEAD_ADVANCED");
      }
      requireThat(same(a, b), classifyNormalAdvance ? "NEXT_BLOCK_CANONICAL_DISAGREEMENT" : "NEXT_BLOCK_PROVIDER_DISAGREEMENT");
      requireThat(same(a.canonical, expected), "NEXT_BLOCK_PARENT_CHANGED");
      usable(); deadline();
      requireThat(BigInt(a.head.number) <= BigInt(expected.number), "NEXT_BLOCK_HEAD_ADVANCED");
      requireThat(BigInt(a.head.number) >= BigInt(expected.number), "NEXT_BLOCK_HEAD_STALE");
      requireThat(same(a.head, expected), "NEXT_BLOCK_PARENT_CHANGED");
      return context;
    } catch (error) { invalidated = true; reportParentFailure(error); throw safeNextBlockError(error, classifyNormalAdvance); }
  }
  async function simulate(transaction, ...extra) {
    requireThat(extra.length === 0, "NEXT_BLOCK_OPTIONS_INVALID");
    const tx = normalizeSimulationTransaction(transaction), params = buildNextBlockRequest(context, tx);
    requireThat(BigInt(tx.gas) <= BigInt(expected.gasLimit), "NEXT_BLOCK_TX_INVALID");
    try {
      await recheck();
      const settled = await Promise.allSettled(pair.map(async provider => {
        try { return normalizeNextBlockResult(await request(provider, "eth_simulateV1", params), context, tx); }
        catch (error) { throw reportParentFailure(error); }
      }));
      const values = settledValues(settled);
      requireThat(same(values[0], values[1]), "NEXT_BLOCK_PROVIDER_DISAGREEMENT");
      // Only a successful, agreeing response reaches freshness revalidation;
      // expiry/normal advance must not hide trust failures already observed.
      await recheck(); return values[0];
    } catch (error) {
      const safe = safeNextBlockError(error, classifyNormalAdvance);
      if (safe.code !== "NEXT_BLOCK_REVERTED") invalidated = true;
      throw safe;
    }
  }
  return Object.freeze({ context, simulate, recheck, assertUsable() { usable(); deadline(); } });
}
module.exports = { createNextBlockContext, normalizeSimulationTransaction, buildNextBlockRequest, validateNextBlockParams,
  normalizeNextBlockResult, buildNextBlockProbeTransaction, qualifyNextBlockProvider, createNextBlockSimulation, safeNextBlockError, nextBlockFailurePriority,
  PROBE_INITCODE, UNKNOWN_HASH, PROBE_GAS_LIMIT, PROBE_FEE_CAP };
