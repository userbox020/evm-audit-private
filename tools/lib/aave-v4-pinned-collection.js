"use strict";

// Aave-only read adapter. Endpoint handles and raw error bodies stay in closures.
const { id, keccak256, Interface } = require("ethers");
const shared = require("../shared-rpc");
const preflight = require("./common-finalized-rpc-preflight");

const READ_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"]);
const ZERO_SLOT = "0x" + "0".repeat(64);
const LIMITS = Object.freeze({ maxCandidates: 16, maxRequests: 12000, maxMs: 240000, timeoutMs: 10000, maxBytes: 4 * 1024 * 1024, concurrency: 4, reserveRequests: 8, maxPinAgeMs: 30 * 60_000 });
const MULTICALL = new Interface(["function multicall(bytes[] data) returns (bytes[])"]);
const VIEW_BATCH_SIZE = 64;
const SPOKE_VIEWS = new Map([
  ["getUserAccountData(address)", 1, 7],
  ["getUserReserveStatus(uint256,address)", 2, 2],
  ["getUserSuppliedAssets(uint256,address)", 2, 1],
  ["getUserTotalDebt(uint256,address)", 2, 1],
  ["getLiquidationBonus(uint256,address,uint256)", 3, 1],
].map(([signature, inputs, outputs]) => [id(signature).slice(0, 10), { inputLength: 10 + 64 * inputs, outputLength: 2 + 64 * outputs }]));

class CollectionError extends Error {
  constructor(code, diagnostics) {
    const safe = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,70}$/.test(code) ? code : "COLLECTION_FAILED";
    super(safe);
    this.name = "CollectionError";
    this.code = safe;
    if (diagnostics) Object.defineProperty(this, "diagnostics", { value: Object.freeze({ ...diagnostics }) });
  }
}
function fail(code) { throw new CollectionError(code); }
function quantity(value) {
  try {
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
    const number = Number(BigInt(value));
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  } catch (_) { return null; }
}
function hexBlock(value) { if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_BLOCK"); return "0x" + value.toString(16); }
function hexData(value) { return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value); }
function safeError(error) { return error instanceof CollectionError ? error : new CollectionError("RPC_TRANSPORT"); }

async function rpcRead(handle, method, params, timeoutMs, options = {}) {
  if (!READ_METHODS.has(method)) fail("METHOD_NOT_ALLOWED");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await (options.fetch || fetch)(handle, {
      method: "POST", redirect: "error", signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) fail(response.status === 429 ? "RPC_RATE_LIMITED" : "RPC_HTTP_REJECTED");
    const maximum = options.maxBytes || LIMITS.maxBytes;
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maximum) { ctrl.abort(); fail("RPC_RESPONSE_TOO_LARGE"); }
      chunks.push(Buffer.from(chunk));
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { fail("RPC_INVALID_JSON"); }
    if (!result || Array.isArray(result) || result.jsonrpc !== "2.0" || result.id !== 1
      || Object.hasOwn(result, "result") === Object.hasOwn(result, "error")) fail("RPC_INVALID_ENVELOPE");
    if (Object.hasOwn(result, "error")) {
      const message = typeof result.error?.message === "string" ? result.error.message : "";
      if (method === "eth_call" && (result.error?.code === 3 || /execution reverted|VM execution error/i.test(message))) fail("CALL_EXCEPTION");
      if (method === "eth_getLogs" && /query returned more than|block range.{0,80}(?:large|limit|maximum)|response size.{0,40}exceed|more than \d+ results/i.test(message)) fail("LOG_RANGE_LIMIT");
      fail("RPC_REJECTED");
    }
    return result.result;
  } catch (error) {
    throw safeError(error);
  } finally { clearTimeout(timer); }
}

function defaultCandidates(chainId) {
  return shared.loadRpcUrls({ maxCandidates: 128, preferredChainId: chainId,
    candidateFilter: handle => Boolean(preflight.classifyOperatorFamily(handle)) && !shared.getOrigin(handle),
  }).flatMap((handle, inventoryOrder) => {
    // Do not use application-origin proxies or unknown/private provider families.
    const family = preflight.classifyOperatorFamily(handle);
    return family && !shared.getOrigin(handle) ? [{ handle, inventoryOrder, operatorFamily: family.operatorFamily, capabilityRank: family.capabilityRank }] : [];
  });
}

async function openPinnedCollection(options = {}) {
  const chainId = options.chainId === undefined ? 1 : options.chainId;
  if (chainId !== 1 && chainId !== 8453) fail("INVALID_CHAIN_ID");
  const limits = { ...LIMITS, ...(options.limits || {}) };
  for (const key of Object.keys(LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > LIMITS[key]) fail("INVALID_LIMITS");
  }
  if (limits.maxRequests < 160 || limits.reserveRequests < 4) fail("INVALID_LIMITS");
  const probeAddress = options.probeAddress;
  if (typeof probeAddress !== "string" || !/^0x[0-9a-f]{40}$/i.test(probeAddress)) fail("INVALID_PROBE_ADDRESS");
  if (options.historyProbe && (!Array.isArray(options.historyProbe.addresses) || !options.historyProbe.addresses.length
    || options.historyProbe.addresses.some(address => !/^0x[0-9a-f]{40}$/i.test(address))
    || !/^0x[0-9a-f]{64}$/i.test(options.historyProbe.topic || ""))) fail("INVALID_HISTORY_PROBE");
  const now = options.now || Date.now;
  const started = now();
  const raw = options.rpc || ((handle, method, params, timeout) => rpcRead(handle, method, params, timeout, { maxBytes: limits.maxBytes }));
  let active = 0;
  const waiters = [];
  const counters = { dispatchedRequests: 0, stateRequests: 0, stateReadOperations: 0, stateCacheHits: 0, stateTransportFailures: 0, revertedStateReads: 0, rejectedRequests: 0 };
  let firstRejectedDispatch = null;
  const qualification = { historyRequested: Boolean(options.historyProbe), candidatesConsidered: 0, chainMatches: 0, stateCapableCandidates: 0, historyCapableCandidates: 0, stateCapableFamilies: 0, historyCapableFamilies: 0 };
  async function transport(handle, method, params, timeout) {
    if (!READ_METHODS.has(method)) fail("METHOD_NOT_ALLOWED");
    if (active >= limits.concurrency) await new Promise(resolve => waiters.push(resolve));
    else active += 1;
    try {
      const remaining = limits.maxMs - (now() - started);
      if (remaining <= 0) fail("COLLECTION_DEADLINE");
      counters.dispatchedRequests += 1;
      return await raw(handle, method, params, Math.min(timeout || limits.timeoutMs, limits.timeoutMs, remaining));
    } catch (error) { throw safeError(error); }
    finally { const next = waiters.shift(); if (next) next(); else active -= 1; }
  }
  const ledger = preflight.createRpcLedger(transport, limits.maxRequests);
  const sourceCandidates = options.candidates || (options.loadCandidates || (() => defaultCandidates(chainId)))();
  if (!Array.isArray(sourceCandidates)) fail("INVALID_CANDIDATES");
  let candidates = sourceCandidates.filter(row => row && typeof row === "object" && Object.hasOwn(row, "handle")).sort((a, b) => (a.capabilityRank ?? 1) - (b.capabilityRank ?? 1)
    || (a.inventoryOrder ?? 0) - (b.inventoryOrder ?? 0)).slice(0, limits.maxCandidates);
  qualification.candidatesConsidered = candidates.length;
  // Qualify the whole bounded, capability-ranked pool before family selection.
  // This prevents two header-capable but EIP-1898-incompatible entries from
  // excluding a later usable family in the sealed common-pin preflight.
  {
    const qualified = await Promise.all(candidates.map(async candidate => {
      try {
        if (quantity(await ledger.call(candidate.handle, "eth_chainId", [], 4000)) !== chainId) return null;
        qualification.chainMatches += 1;
        const head = preflight.normalizeHeader(await ledger.call(candidate.handle, "eth_getBlockByNumber", ["finalized", false], limits.timeoutMs));
        if (!head) return null;
        const at = { blockHash: head.hash, requireCanonical: true };
        const code = await ledger.call(candidate.handle, "eth_getCode", [probeAddress, at], limits.timeoutMs);
        const slot = await ledger.call(candidate.handle, "eth_getStorageAt", [probeAddress, ZERO_SLOT, at], limits.timeoutMs);
        const value = await ledger.call(candidate.handle, "eth_call", [{ to: probeAddress, data: id("getAssetCount()").slice(0, 10) }, at], limits.timeoutMs);
        if (!hexData(code) || code === "0x" || !/^0x[0-9a-f]{64}$/i.test(slot || "") || !/^0x[0-9a-f]{64}$/i.test(value || "")) return null;
        const logs = await ledger.call(candidate.handle, "eth_getLogs", [{ address: probeAddress, blockHash: head.hash, topics: [ZERO_SLOT] }], limits.timeoutMs);
        if (!Array.isArray(logs)) return null;
        qualification.stateCapableCandidates += 1;
        let historyQualified = false;
        if (options.historyProbe) {
          try {
            const historical = await ledger.call(candidate.handle, "eth_getLogs", [{ address: options.historyProbe.addresses,
              topics: [options.historyProbe.topic], fromBlock: "0x0", toBlock: "0x0" }], limits.timeoutMs);
            historyQualified = Array.isArray(historical) && historical.length === 0;
          } catch (_) { /* witness may still corroborate the finalized header */ }
        }
        if (historyQualified) qualification.historyCapableCandidates += 1;
        return { ...candidate, historyQualified };
      } catch (_) { return null; }
    }));
    candidates = qualified.filter(Boolean).sort((a, b) => Number(b.historyQualified) - Number(a.historyQualified)
      || (a.capabilityRank ?? 1) - (b.capabilityRank ?? 1) || (a.inventoryOrder ?? 0) - (b.inventoryOrder ?? 0));
  }
  qualification.stateCapableFamilies = new Set(candidates.map(row => row.operatorFamily).filter(Boolean)).size;
  qualification.historyCapableFamilies = new Set(candidates.filter(row => row.historyQualified).map(row => row.operatorFamily).filter(Boolean)).size;
  if (options.historyProbe && !qualification.historyCapableCandidates) throw new CollectionError("HISTORY_CAPABILITY_UNAVAILABLE", qualification);
  let admitted;
  try {
    admitted = await preflight.qualifyCommonFinalized({
      chainId, candidates, minimumFamilies: 2, preferredFamilies: 2, rpc: ledger,
      ...(chainId === 8453 ? { logCanaryAddress: probeAddress } : {}),
      limits: { maxCandidates: limits.maxCandidates, maxProbeCallsPerCandidate: 4,
        reserveRequests: limits.maxRequests - Math.min(192, limits.maxRequests - limits.reserveRequests), retries: 0 },
      probe: async ({ reader }) => {
        const code = await reader.getCode(probeAddress);
        const slot = await reader.getStorageAt(probeAddress, ZERO_SLOT);
        const count = await reader.call({ to: probeAddress, data: id("getAssetCount()").slice(0, 10) });
        if (code === "0x" || !/^0x[0-9a-f]{64}$/i.test(count)) fail("PROBE_DECODE_FAILED");
        return { codeHash: keccak256(code), slot, count };
      },
    });
  } catch (error) { throw new CollectionError(error?.code || "PREFLIGHT_FAILED", qualification); }
  const selected = admitted.selected;
  const primaryRow = options.historyProbe ? selected.find(row => row.candidate.source.historyQualified) : selected[0];
  if (!primaryRow) throw new CollectionError("HISTORY_CAPABILITY_UNAVAILABLE", qualification);
  const primary = primaryRow.candidate.handle;
  let pin = admitted.pin;
  if (options.requestedPin) {
    const requested = options.requestedPin;
    if (requested.chainId !== chainId || requested.finality !== "finalized"
      || !Number.isSafeInteger(requested.blockNumber) || requested.blockNumber < 0 || requested.blockNumber > admitted.pin.number
      || !/^0x[0-9a-f]{64}$/i.test(requested.blockHash || "")) fail("REQUESTED_PIN_INVALID");
    const headers = await Promise.all(selected.map(row => ledger.call(row.candidate.handle, "eth_getBlockByNumber", [hexBlock(requested.blockNumber), false], limits.timeoutMs)));
    const normalized = headers.map(preflight.normalizeHeader);
    if (normalized.some(row => !row || row.number !== requested.blockNumber || row.hash !== requested.blockHash.toLowerCase())
      || new Set(normalized.map(row => JSON.stringify(row))).size !== 1) fail("REQUESTED_PIN_MISMATCH");
    pin = normalized[0];
  }
  if (/^0x0{64}$/i.test(pin.hash) || now() - Number(pin.timestamp) * 1000 > limits.maxPinAgeMs || Number(pin.timestamp) * 1000 - now() > 60_000) fail("PIN_STALE_OR_FUTURE");
  pin = Object.freeze({ ...pin });
  const canonical = Object.freeze({ blockHash: pin.hash, requireCanonical: true });
  const stateCache = new Map();
  let cacheBytes = 0;
  let confirmed = false;
  // Read-only snapshot, NOT a reservation. Ledger calls already include active
  // and queued dispatches; callers must recheck after every awaited operation.
  function budgetStatus() {
    const elapsed = now() - started;
    const elapsedMs = Number.isSafeInteger(elapsed) ? Math.max(0, elapsed) : limits.maxMs;
    return Object.freeze({
      effectiveLimits: Object.freeze(Object.fromEntries(Object.keys(LIMITS).map(key => [key, limits[key]]))),
      elapsedMs,
      ordinaryRequestsRemaining: Math.max(0, limits.maxRequests - limits.reserveRequests - ledger.networkCalls),
      ordinaryTimeRemainingMs: Math.max(0, limits.maxMs - 3 * limits.timeoutMs - elapsedMs),
      activeRequests: active, queuedRequests: waiters.length, outstandingRequests: active + waiters.length,
    });
  }
  function canCollect() {
    return ledger.networkCalls < limits.maxRequests - limits.reserveRequests
      && now() - started < limits.maxMs - 3 * limits.timeoutMs;
  }
  async function read(method, params, state = false) {
    confirmed = false;
    if (!canCollect()) {
      counters.rejectedRequests += 1;
      if (!firstRejectedDispatch) {
        const budget = budgetStatus();
        const requestThreshold = budget.ordinaryRequestsRemaining === 0;
        const timeThreshold = budget.ordinaryTimeRemainingMs === 0;
        firstRejectedDispatch = Object.freeze({ method,
          reason: requestThreshold && timeThreshold ? "BOTH" : requestThreshold ? "REQUEST_THRESHOLD" : "TIME_THRESHOLD",
          budget,
        });
      }
      fail("COLLECTION_BUDGET_EXHAUSTED");
    }
    if (state) counters.stateRequests += 1;
    try { return await ledger.call(primary, method, params, limits.timeoutMs); }
    catch (error) {
      if (state) {
        if (error?.code === "CALL_EXCEPTION") counters.revertedStateReads += 1;
        else counters.stateTransportFailures += 1;
      }
      throw safeError(error);
    }
  }
  // Same provider + immutable block hash + identical read parameters. Keep the
  // memo session-local and bounded; failures other than EVM reverts are not cached.
  async function stateRead(method, params, valid) {
    confirmed = false;
    counters.stateReadOperations += 1;
    const key = method + JSON.stringify(params);
    const cached = stateCache.get(key);
    if (cached) {
      counters.stateCacheHits += 1;
      if (cached.reverted) fail("CALL_EXCEPTION");
      return cached.result;
    }
    const remember = value => {
      const bytes = Buffer.byteLength(key) + (value.result ? Buffer.byteLength(value.result) : 16);
      if (stateCache.size < 2048 && bytes <= 64 * 1024 && cacheBytes + bytes <= 8 * 1024 * 1024) {
        stateCache.set(key, value); cacheBytes += bytes;
      }
    };
    try {
      const result = await read(method, params, true);
      if (!valid(result)) { counters.stateTransportFailures += 1; fail("RPC_INVALID_RESULT"); }
      remember({ result });
      return result;
    } catch (error) {
      if (error?.code === "CALL_EXCEPTION") remember({ reverted: true });
      throw error;
    }
  }
  const batchTargets = new Set((options.historyProbe?.addresses || []).map(address => address.toLowerCase()));
  const verifiedViews = new Set();
  const batchCounters = { viewBatchCalls: 0, viewBatchSplits: 0, viewBatchSubcalls: 0, viewBatchComparisons: 0 };
  let batchingFailure = null;
  function validViewResult(data, result) {
    return hexData(result) && result.length === SPOKE_VIEWS.get(data.slice(0, 10).toLowerCase()).outputLength;
  }
  async function nativeBatch(to, data) {
    batchCounters.viewBatchCalls += 1;
    const rawResult = await read("eth_call", [{ to, data: MULTICALL.encodeFunctionData("multicall", [data]) }, canonical], true);
    try {
      const [results] = MULTICALL.decodeFunctionResult("multicall", rawResult);
      if (results.length !== data.length || results.some((value, index) => !validViewResult(data[index], value))) throw new Error();
      return Array.from(results);
    } catch (_) { counters.stateTransportFailures += 1; fail("INVALID_MULTICALL_RESULT"); }
  }
  const settled = async operation => {
    try { return { value: await operation() }; } catch (error) { return { error: safeError(error).code }; }
  };
  async function callMany(transactions) {
    // Native self-delegatecall retains the direct caller. Restrict its contents
    // to these fixed-shape views and the already declared history/spoke scope.
    if (!Array.isArray(transactions) || transactions.length > 32768 || transactions.some(tx =>
      !tx || typeof tx.to !== "string" || !batchTargets.has(tx.to.toLowerCase()) || !hexData(tx.data)
      || tx.data.length !== SPOKE_VIEWS.get(tx.data.slice(0, 10).toLowerCase())?.inputLength
      || Object.keys(tx).some(key => key !== "to" && key !== "data"))) fail("INVALID_VIEW_BATCH");
    confirmed = false;
    counters.stateReadOperations += transactions.length;
    batchCounters.viewBatchSubcalls += transactions.length;
    const failed = code => transactions.map(() => ({ error: code }));
    if (batchingFailure) return failed(batchingFailure);
    // One exact direct/native comparison per used selector and target, per pin.
    // A missing/changed multicall implementation cannot silently alter reads.
    for (const tx of transactions) {
      const key = tx.to.toLowerCase() + tx.data.slice(0, 10).toLowerCase();
      if (verifiedViews.has(key)) continue;
      const direct = await settled(() => stateRead("eth_call", [{ to: tx.to, data: tx.data }, canonical], value => validViewResult(tx.data, value)));
      const batched = await settled(async () => (await nativeBatch(tx.to, [tx.data]))[0]);
      batchCounters.viewBatchComparisons += 1;
      if ((direct.error && direct.error !== "CALL_EXCEPTION") || (batched.error && batched.error !== "CALL_EXCEPTION")) {
        batchingFailure = direct.error && direct.error !== "CALL_EXCEPTION" ? direct.error : batched.error;
        return failed(batchingFailure);
      }
      if (direct.error !== batched.error || direct.value?.toLowerCase() !== batched.value?.toLowerCase()) {
        counters.stateTransportFailures += 1;
        batchingFailure = "MULTICALL_EQUIVALENCE_FAILED";
        return failed(batchingFailure);
      }
      verifiedViews.add(key);
    }
    const groups = new Map();
    transactions.forEach((tx, index) => {
      const key = tx.to.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...tx, index });
    });
    const jobs = [];
    for (const group of groups.values()) for (let i = 0; i < group.length; i += VIEW_BATCH_SIZE) jobs.push(group.slice(i, i + VIEW_BATCH_SIZE));
    const results = new Array(transactions.length);
    async function execute(batch) {
      try {
        const values = await nativeBatch(batch[0].to, batch.map(tx => tx.data));
        batch.forEach((tx, i) => { results[tx.index] = { value: values[i] }; });
      } catch (error) {
        // A native batch bubbles its first revert; do not ascribe that revert to
        // every member. Bisect only EVM reverts, never transport/quota failures.
        if (error?.code === "CALL_EXCEPTION" && batch.length > 1) {
          batchCounters.viewBatchSplits += 1;
          const middle = Math.floor(batch.length / 2);
          await execute(batch.slice(0, middle)); await execute(batch.slice(middle));
        } else for (const tx of batch) results[tx.index] = { error: safeError(error).code };
      }
    }
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limits.concurrency, jobs.length) }, async () => {
      while (cursor < jobs.length) await execute(jobs[cursor++]);
    }));
    return results;
  }
  const provider = Object.freeze({
    callMany,
    async call(transaction) {
      if (!transaction || typeof transaction.to !== "string" || !/^0x[0-9a-f]{40}$/i.test(transaction.to)
        || !hexData(transaction.data)) fail("INVALID_CALL");
      return stateRead("eth_call", [{ to: transaction.to, data: transaction.data }, canonical], hexData);
    },
    async getCode(address) {
      if (!/^0x[0-9a-f]{40}$/i.test(address || "")) fail("INVALID_ADDRESS");
      return stateRead("eth_getCode", [address, canonical], hexData);
    },
    async getStorage(address, slot) {
      if (!/^0x[0-9a-f]{40}$/i.test(address || "") || !/^0x[0-9a-f]{64}$/i.test(slot || "")) fail("INVALID_STORAGE_READ");
      return stateRead("eth_getStorageAt", [address, slot, canonical], result => /^0x[0-9a-f]{64}$/i.test(result || ""));
    },
    async getLogs(filter) {
      if (!filter || !Number.isSafeInteger(filter.fromBlock) || !Number.isSafeInteger(filter.toBlock)
        || filter.fromBlock < 0 || filter.toBlock < filter.fromBlock || filter.toBlock > pin.number
        || Object.hasOwn(filter, "blockHash")) fail("INVALID_LOG_RANGE");
      const result = await read("eth_getLogs", [{ ...filter, fromBlock: hexBlock(filter.fromBlock), toBlock: hexBlock(filter.toBlock) }]);
      if (!Array.isArray(result)) fail("RPC_INVALID_RESULT");
      return result;
    },
    async getBlock(number) {
      if (!Number.isSafeInteger(number) || number < 0 || number > pin.number) fail("INVALID_BLOCK");
      const header = preflight.normalizeHeader(await read("eth_getBlockByNumber", [hexBlock(number), false]));
      if (!header || header.number !== number) fail("RPC_INVALID_HEADER");
      return header;
    },
  });
  async function checkpointBlock(number) {
    confirmed = false;
    if (!Number.isSafeInteger(number) || number < 0 || number > pin.number) fail("INVALID_BLOCK");
    // Use the reserved control budget after ordinary collection reaches its cap.
    const header = preflight.normalizeHeader(await ledger.call(primary, "eth_getBlockByNumber", [hexBlock(number), false], limits.timeoutMs));
    if (!header || header.number !== number) fail("RPC_INVALID_HEADER");
    return header;
  }
  async function confirmPin() {
    confirmed = false;
    if (now() - Number(pin.timestamp) * 1000 > limits.maxPinAgeMs) fail("PIN_STALE_OR_FUTURE");
    const headers = await Promise.all(selected.map(row => ledger.call(row.candidate.handle, "eth_getBlockByNumber", [hexBlock(pin.number), false], limits.timeoutMs)));
    if (headers.some(rawHeader => {
      const header = preflight.normalizeHeader(rawHeader);
      return !header || JSON.stringify(header) !== JSON.stringify(pin);
    })) fail("TERMINAL_PIN_MISMATCH");
    confirmed = true;
    return pin;
  }
  function observationPin(coverage) {
    if (!confirmed || now() - Number(pin.timestamp) * 1000 > limits.maxPinAgeMs || counters.stateTransportFailures || counters.rejectedRequests
      || !Number.isSafeInteger(coverage.stateReadsAttempted) || coverage.stateReadsAttempted < 0
      || coverage.stateReadsAttempted > counters.stateReadOperations || coverage.stateReadsFailed !== 0
      || coverage.stateReadsSucceeded !== coverage.stateReadsAttempted) return null;
    return {
      schema: "aave-v4-state-pin/v1", chainId, blockNumber: pin.number, blockHash: pin.hash,
      stateRoot: pin.stateRoot, finality: "finalized", stateReadsPinned: coverage.stateReadsAttempted,
      terminalBlockNumber: pin.number, terminalBlockHash: pin.hash,
      headerFamilies: selected.length, stateFamilies: 1, rpcStrength: "single-provider",
    };
  }
  return Object.freeze({ chainId, provider, pin, canCollect, budgetStatus, checkpointBlock, confirmPin, observationPin,
    statistics: () => ({ ...counters, ...batchCounters, viewBatchVerifiedSelectors: verifiedViews.size,
      qualification: { ...qualification }, networkCalls: ledger.networkCalls, headerFamilies: selected.length, stateFamilies: 1, automaticRetries: 0,
      budget: budgetStatus(), firstRejectedDispatch }),
  });
}

module.exports = { CollectionError, LIMITS, hexBlock, quantity, rpcRead, openPinnedCollection };
