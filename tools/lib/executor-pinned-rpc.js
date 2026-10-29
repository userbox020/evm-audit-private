"use strict";

const { Interface } = require("../node_modules/ethers");
const { ExecutionError, requireThat, uint } = require("./wallet-execution-guard.js");
const { qualifyNextBlockProvider, createNextBlockSimulation, validateNextBlockParams, safeNextBlockError, nextBlockFailurePriority,
  createNextBlockContext, normalizeNextBlockResult, buildNextBlockProbeTransaction, UNKNOWN_HASH: SIMULATION_UNKNOWN_HASH } = require("./next-block-simulation.js");
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const PROBE = new Interface(["function getBlockNumber() view returns(uint256)"]);
const MAX_CANDIDATES = 32;
const QUALIFICATION_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 4000;
const TRANSIENT_RETRIES = 2;
const RETRY_BACKOFF_MS = 150;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_AGE_MS = 120000;
const TRACE_UNKNOWN_HASH = "0x" + "f".repeat(64);
const TRACE_PROBE_FROM = "0x" + "0".repeat(40);
// Only internally minted read guards may enter httpRpc's physical-fetch guard.
// Arbitrary caller-supplied read callbacks retain the legacy ignored semantics.
const CAPABILITY_DISPATCH_GUARDS = new WeakSet();
const CURRENT_TRACE_DISPATCH_GUARDS = new WeakSet();
const RECOVERY_HTTP_OBSERVERS = new WeakMap();
const REMOTE_RESPONSE_FAILURES = new WeakSet();
const RESPONSE_VALIDATION_ORDER = new WeakMap(); let responseValidationOrder = 0;
function responseError(code) {
  const error = new ExecutionError(code); REMOTE_RESPONSE_FAILURES.add(error);
  RESPONSE_VALIDATION_ORDER.set(error, ++responseValidationOrder); return error;
}
function responseRequire(ok, code) { if (!ok) throw responseError(code); }
function responseUint(value, code = "INVALID_INTEGER") {
  // Only this scalar validator can mint a remote integer rejection. No object
  // coercion/getter or surrounding inspection exception enters this boundary.
  responseRequire(["string", "number", "bigint"].includes(typeof value), code);
  try { return uint(value, code); }
  catch (error) { if (error instanceof ExecutionError) throw responseError(code); throw error; }
}
const HTTP_CAPABILITY_CONFIGURATION = Object.freeze({});
const CAPABILITY_SUITE = "M1_STRICT_CALL_CODE_V1";
const traceOptions = () => ({ tracer: "callTracer", timeout: "3s", tracerConfig: { onlyTopCall: false } });
const hash = x => typeof x === "string" && /^0x[0-9a-f]{64}$/i.test(x);
const tag = n => "0x" + n.toString(16);
const canonicalHashRef = ref => ref && typeof ref === "object" && !Array.isArray(ref) &&
  Object.keys(ref).length === 2 && hash(ref.blockHash) && ref.blockHash.length === 66 && ref.requireCanonical === true;
function normalizeCode(raw, check = requireThat) {
  check(typeof raw === "string" && raw.length <= MAX_RESPONSE_BYTES * 2 + 2 && raw === raw.trim() && /^0x(?:[0-9a-f]{2})*$/i.test(raw), "PIN_CODE_RESULT_INVALID");
  return raw.toLowerCase();
}
function validateCodeParams(params) {
  requireThat(Array.isArray(params) && params.length === 2 && typeof params[0] === "string" && params[0].length === 42 && /^0x[0-9a-f]{40}$/i.test(params[0]) &&
    canonicalHashRef(params[1]), "PIN_CODE_REQUEST_INVALID");
}
function strictUnknownProbe(method, params) {
  if (!Array.isArray(params) || params.length !== 2 || !canonicalHashRef(params[1]) || params[1].blockHash !== TRACE_UNKNOWN_HASH) return false;
  if (method === "eth_getCode") return params[0] === MULTICALL3;
  const tx = params[0];
  return method === "eth_call" && tx && typeof tx === "object" && !Array.isArray(tx) && Object.keys(tx).length === 2 &&
    tx.to === MULTICALL3 && tx.data === PROBE.encodeFunctionData("getBlockNumber");
}
function header(raw, now, allowClockSkew = false, includeGasLimit = false, check = requireThat, integer = uint) {
  check(raw && hash(raw.hash) && hash(raw.parentHash) && hash(raw.stateRoot), "PIN_HEADER_INVALID");
  const number = Number(integer(raw.number)), rawTs = Number(integer(raw.timestamp)), age = now - rawTs * 1000;
  const minAge = allowClockSkew ? -15000 : 0;
  check(Number.isSafeInteger(number) && Number.isSafeInteger(rawTs) && age >= minAge && age <= MAX_AGE_MS, "PIN_STALE_OR_FUTURE");
  const timestamp = allowClockSkew && age < 0 ? Math.floor(now / 1000) : rawTs;
  return { number, hash: raw.hash.toLowerCase(), parentHash: raw.parentHash.toLowerCase(), stateRoot: raw.stateRoot.toLowerCase(), timestamp,
    baseFeePerGas: integer(raw.baseFeePerGas).toString(), ...(includeGasLimit ? { gasLimit: integer(raw.gasLimit, "PIN_HEADER_INVALID").toString() } : {}) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function normalizeCallTrace(raw) {
  let nodes = 0;
  const address = value => {
    requireThat(typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value), "TRACE_SHAPE_INVALID"); return value.toLowerCase();
  };
  const bytes = value => {
    requireThat(typeof value === "string" && value.length <= MAX_RESPONSE_BYTES * 2 + 2 && /^0x(?:[0-9a-f]{2})*$/i.test(value), "TRACE_SHAPE_INVALID");
    return value.toLowerCase();
  };
  function visit(row, depth) {
    requireThat(++nodes <= 2000 && depth <= 64 && row && typeof row === "object" && !Array.isArray(row), "TRACE_SHAPE_INVALID");
    requireThat(["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE"].includes(row.type), "TRACE_SHAPE_INVALID");
    requireThat(!Object.hasOwn(row, "calls") || Array.isArray(row.calls), "TRACE_SHAPE_INVALID");
    requireThat(!Object.hasOwn(row, "error") || (typeof row.error === "string" && row.error.trim().length > 0), "TRACE_SHAPE_INVALID");
    const reverted = Object.hasOwn(row, "error");
    requireThat(!Object.hasOwn(row, "reverted") || (typeof row.reverted === "boolean" && row.reverted === reverted), "TRACE_SHAPE_INVALID");
    requireThat(!Object.hasOwn(row, "value") || (typeof row.value === "string" && /^0x[0-9a-f]{1,64}$/i.test(row.value)), "TRACE_SHAPE_INVALID");
    const normalized = { type: row.type, from: address(row.from), to: address(row.to), input: bytes(row.input),
      output: Object.hasOwn(row, "output") ? bytes(row.output) : "0x", value: BigInt(row.value ?? "0x0").toString(), reverted, calls: [] };
    for (const child of row.calls ?? []) normalized.calls.push(visit(child, depth + 1));
    return normalized;
  }
  try { return { tree: visit(raw, 0), nodes }; }
  catch (_) { throw new ExecutionError("TRACE_SHAPE_INVALID"); }
}
function validateTraceParams(params) {
  const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
  requireThat(Array.isArray(params) && params.length === 3 && params[0] && typeof params[0] === "object" && !Array.isArray(params[0]) &&
    keys(params[1], ["blockHash", "requireCanonical"]) && hash(params[1].blockHash) && params[1].requireCanonical === true &&
    keys(params[2], ["tracer", "timeout", "tracerConfig"]) && params[2].tracer === "callTracer" && params[2].timeout === "3s" &&
    keys(params[2].tracerConfig, ["onlyTopCall"]) && params[2].tracerConfig.onlyTopCall === false, "TRACE_OPTIONS_INVALID");
}
// Only the new lease facet accepts this strict, already RPC-encoded envelope.
// Legacy trace callers and their option validation remain unchanged.
function currentTraceTransaction(tx) {
  const code = "TRACE_OPTIONS_INVALID", address = x => typeof x === "string" && /^0x[0-9a-f]{40}$/i.test(x);
  const quantity = x => typeof x === "string" && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(x);
  try {
    requireThat(tx && [Object.prototype, null].includes(Object.getPrototypeOf(tx)), code);
    const fields = Object.getOwnPropertyDescriptors(tx), allowed = ["from", "to", "data", "value", "gas", "gasPrice", "type", "chainId",
      "nonce", "maxFeePerGas", "maxPriorityFeePerGas", "accessList"];
    requireThat(Reflect.ownKeys(tx).every(key => allowed.includes(key) && Object.hasOwn(fields[key], "value")), code);
    requireThat(address(tx.from) && address(tx.to) && typeof tx.data === "string" && tx.data.length <= MAX_RESPONSE_BYTES * 2 + 2 &&
      /^0x(?:[0-9a-f]{2})*$/i.test(tx.data) && quantity(tx.value), code);
    for (const name of ["gas", "gasPrice", "type", "chainId", "nonce", "maxFeePerGas", "maxPriorityFeePerGas"])
      if (Object.hasOwn(tx, name)) requireThat(quantity(tx[name]), code);
    requireThat(tx.chainId === undefined || tx.chainId === "0x1", code);
    requireThat(tx.gasPrice === undefined || tx.maxFeePerGas === undefined && tx.maxPriorityFeePerGas === undefined, code);
    if (tx.maxPriorityFeePerGas !== undefined) requireThat(tx.maxFeePerGas !== undefined && BigInt(tx.maxPriorityFeePerGas) <= BigInt(tx.maxFeePerGas), code);
    const copy = structuredClone(tx);
    if (copy.accessList !== undefined) requireThat(Array.isArray(copy.accessList) && copy.accessList.length <= 1024 && copy.accessList.every(row =>
      row && Reflect.ownKeys(row).length === 2 && address(row.address) && Array.isArray(row.storageKeys) &&
      row.storageKeys.length <= 1024 && row.storageKeys.every(hash)), code);
    return copy;
  } catch (_) { throw new ExecutionError(code); }
}
function unknownBlockRejection(error) {
  // Only explicit block-lookup/canonicality failures count. In particular, neither
  // invalid-params nor method-unavailable errors can qualify EIP-1898 support.
  if (![-32000, -32001, -32002, -32603].includes(error.code) || error.message.length > 512) return false;
  return /^(?:unknown block(?: hash)?(?:(?:[: ]+)(?:0x[0-9a-f]{64}))?|(?:block|header)(?: (?:with hash )?0x[0-9a-f]{64})?(?: is)? not found|not canonical|block(?: 0x[0-9a-f]{64})?(?: is)? not canonical|hash 0x[0-9a-f]{64} is not currently canonical)\.?$/i.test(error.message);
}
function explicitHashNotFoundRejection(error, requestedHash) {
  // Reth (-32001) and Erigon (-32000) exact lookup forms only. "canonical
  // hash" names Reth's selector; this is not proof of canonical execution.
  if (!hash(requestedHash) || requestedHash.length !== 66 || typeof error.message !== "string" ||
      error.message.length > 512 || error.message !== error.message.trim()) return false;
  const pattern = error.code === -32001 ? /^block not found: (?:canonical )?hash (0x[0-9a-fA-F]{64})$/ :
    error.code === -32000 ? /^block not found: (0x[0-9a-fA-F]{64})$/ : null;
  const match = pattern?.exec(error.message);
  return !!match && match[0] === error.message && match[1].toLowerCase() === requestedHash.toLowerCase();
}
function traceBlockNumberNotFoundRejection(error, requestedHash) {
  // Erigon's tracing-only get-block-number wrapper; never a shared read/simulation classifier.
  if (error.code !== -32000 || requestedHash !== TRACE_UNKNOWN_HASH || typeof error.message !== "string" ||
      error.message.length > 512 || error.message !== error.message.trim()) return false;
  const match = /^get block number: block not found: (0x[0-9a-fA-F]{64})$/.exec(error.message);
  return !!match && match[0] === error.message && match[1].toLowerCase() === requestedHash;
}
function simulationSelectorNotFoundRejection(error, requestedHash) {
  // Reth's EthSimulateError uses -32000; shared HeaderNotFound/read forms stay separate.
  if (error.code !== -32000 || requestedHash !== SIMULATION_UNKNOWN_HASH || typeof error.message !== "string" ||
      error.message.length > 512 || error.message !== error.message.trim()) return false;
  const match = /^block not found: (?:canonical )?hash (0x[0-9a-fA-F]{64})$/.exec(error.message);
  return !!match && match[0] === error.message && match[1].toLowerCase() === requestedHash;
}
function simulationUnknownBlockRejection(error, requestedHash) {
  if (explicitHashNotFoundRejection(error, requestedHash)) return true;
  // Additional exact -32000 lookup forms for simulation/strict read probes.
  // Keep the trace classifier unchanged; never qualify a different embedded hash.
  const standard = /^(?:header for hash not found|canonical block not found, hash: 0x[0-9a-f]{64})\.?$/i.exec(error.message);
  if (!unknownBlockRejection(error) && !(error.code === -32000 && standard?.[0] === error.message)) return false;
  const embeddedHashes = error.message.match(/0x[0-9a-f]{64}/gi) || [];
  return embeddedHashes.every(value => value.toLowerCase() === requestedHash.toLowerCase());
}
function sanitizedTraceResult(raw) {
  // Keep the HTTP result raw-callTracer compatible without exposing error strings
  // or irrelevant client metadata. The API compares canonical {tree,nodes} values.
  const publicFrame = row => ({ type: row.type, from: row.from, to: row.to, input: row.input, output: row.output,
    value: tag(BigInt(row.value)), ...(row.reverted ? { error: "CALL_REVERTED" } : {}), calls: row.calls.map(publicFrame) });
  return publicFrame(normalizeCallTrace(raw).tree);
}
function normalizeReceipt(receipt, txHash) {
  requireThat(hash(txHash), "RECEIPT_INVALID");
  if (receipt === null) return null;
  const address = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
  requireThat(receipt && typeof receipt === "object" && !Array.isArray(receipt) && hash(receipt.transactionHash) &&
    receipt.transactionHash.toLowerCase() === txHash.toLowerCase() && hash(receipt.blockHash) &&
    address(receipt.from) && address(receipt.to) && Array.isArray(receipt.logs), "RECEIPT_INVALID");
  const quantity = value => tag(uint(value, "RECEIPT_INVALID"));
  const normalized = {
    transactionHash: receipt.transactionHash.toLowerCase(), blockHash: receipt.blockHash.toLowerCase(),
    blockNumber: quantity(receipt.blockNumber), transactionIndex: quantity(receipt.transactionIndex),
    status: quantity(receipt.status), from: receipt.from.toLowerCase(), to: receipt.to.toLowerCase(),
    gasUsed: quantity(receipt.gasUsed), effectiveGasPrice: quantity(receipt.effectiveGasPrice)
  };
  requireThat(["0x0", "0x1"].includes(normalized.status) && BigInt(normalized.gasUsed) > 0n &&
    BigInt(normalized.blockNumber) <= BigInt(Number.MAX_SAFE_INTEGER), "RECEIPT_INVALID");
  const indices = new Set(), logQuantity = value => tag(uint(value, "RECEIPT_LOG_INVALID"));
  normalized.logs = receipt.logs.map(log => {
    requireThat(log && typeof log === "object" && !Array.isArray(log) && address(log.address) &&
      Array.isArray(log.topics) && log.topics.length <= 4 && log.topics.every(hash) &&
      typeof log.data === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(log.data) && log.removed === false &&
      hash(log.blockHash) && log.blockHash.toLowerCase() === normalized.blockHash &&
      hash(log.transactionHash) && log.transactionHash.toLowerCase() === normalized.transactionHash, "RECEIPT_LOG_INVALID");
    const logIndex = logQuantity(log.logIndex), blockNumber = logQuantity(log.blockNumber), transactionIndex = logQuantity(log.transactionIndex);
    requireThat(!indices.has(logIndex) && blockNumber === normalized.blockNumber && transactionIndex === normalized.transactionIndex, "RECEIPT_LOG_INVALID");
    indices.add(logIndex);
    return { address: log.address.toLowerCase(), topics: log.topics.map(topic => topic.toLowerCase()), data: log.data.toLowerCase(),
      logIndex, blockHash: normalized.blockHash, blockNumber, transactionHash: normalized.transactionHash, transactionIndex, removed: false };
  }); // Member order is canonicalized, but log array order remains consensus evidence.
  return normalized;
}
const trustFailure = error => !["PIN_STALE_OR_FUTURE", "PIN_TOO_FAR_BEHIND", "RPC_TIMEOUT", "RPC_TRANSPORT_ERROR", "RPC_HTTP_RETRYABLE",
  "PINNED_RPC_FAILED", "STRICT_QUALIFICATION_FAILED", "CALL_REVERTED", "M1_HOT_PATH_CANCELLED", "M1_HOT_PATH_BUDGET",
  "M1_CAPABILITY_EXPIRED", "M1_CAPABILITY_INVALIDATED", "M1_CAPABILITY_CONTEXT_CHANGED", "M1_CAPABILITY_CONTEXT_INVALID",
  "TRACE_CAPABILITY_UNAVAILABLE"].includes(error?.code);
// Private strict-control stages: at most two jobs per witness, no new work after
// failure, and every started job (including its assertions/retries) is drained.
// A fast availability failure must never hide a slower observed trust failure.
async function strictControlGroup(jobs, onFailure) {
  const settled = new Array(jobs.length); let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
    while (!failed && next < jobs.length) {
      const index = next++;
      try { settled[index] = { status: "fulfilled", value: await jobs[index]() }; }
      catch (reason) { failed = true; settled[index] = { status: "rejected", reason }; onFailure?.(reason); }
    }
  }));
  const failures = settled.filter(row => row?.status === "rejected");
  if (failures.length) throw (failures.find(row => trustFailure(row.reason)) || failures[0]).reason;
  return settled.map(row => row.value);
}
async function createPinnedRpc(options) { return createPinnedSession(options); }
// Private hooks split selection from proof acquisition for M1 v2 only. Public
// legacy entrypoints still run exactly the original qualification/session path.
async function createPinnedSession({ candidates, rpc, now = Date.now, requireTrace = false, requireNextBlock = false, requireStrictEvidence = false, ...options }, internal = {}) {
  requireThat(typeof requireStrictEvidence === "boolean", "STRICT_EVIDENCE_OPTIONS_INVALID");
  if (requireStrictEvidence) requireThat(Object.keys(options).length === 0 && typeof now === "function", "STRICT_EVIDENCE_OPTIONS_INVALID");
  requireThat(typeof requireTrace === "boolean", "TRACE_OPTIONS_INVALID");
  if (requireTrace) requireThat(Object.keys(options).length === 0 && typeof now === "function", "TRACE_OPTIONS_INVALID");
  requireThat(typeof requireNextBlock === "boolean", "NEXT_BLOCK_OPTIONS_INVALID");
  if (requireNextBlock) requireThat(Object.keys(options).length === 0 && typeof now === "function", "NEXT_BLOCK_OPTIONS_INVALID");
  requireThat(Array.isArray(candidates) && candidates.length >= 2 && candidates.length <= MAX_CANDIDATES &&
    candidates.every(c => c && typeof c.family === "string" && c.family && Object.hasOwn(c, "handle")) && typeof rpc === "function", "RPC_CANDIDATES_INVALID");
  async function requestOne(c, method, params, timeoutMs, retries = method === "eth_sendRawTransaction" ? 0 : TRANSIENT_RETRIES, assertDispatch, inspectResponse, inspectFailure) {
    // An explicit timeout is the caller's remaining budget, not a fresh allowance
    // per retry. Without one, each of the at most three attempts is capped at 4s.
    const expiresAt = Number.isSafeInteger(timeoutMs) ? now() + Math.max(0, timeoutMs) : Infinity;
    try {
      params = structuredClone(params);
      for (let attempt = 0; ; attempt++) {
        const remaining = expiresAt - now();
        requireThat(remaining > 0, "RPC_TIMEOUT");
        try {
          const timeout = Math.min(boundedTimeout(timeoutMs), remaining);
          return await (internal.trackSemantic ? rpc(c, method, params, timeout, assertDispatch, inspectResponse, inspectFailure) :
            assertDispatch ? rpc(c, method, params, timeout, assertDispatch) : rpc(c, method, params, timeout));
        }
        catch (error) {
          if (attempt >= retries || !transientRpcFailure(error) || expiresAt - now() <= RETRY_BACKOFF_MS) throw error;
          await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
        }
      }
    } catch (error) {
      const reject = failure => { internal.onRequestFailure?.(error, failure); throw failure; };
      if (requireStrictEvidence && strictUnknownProbe(method, params) && error instanceof ExecutionError && error.code === "UNKNOWN_BLOCK_REJECTED")
        return reject(new ExecutionError("UNKNOWN_BLOCK_REJECTED"));
      if (requireTrace && method === "debug_traceCall" && error instanceof ExecutionError &&
        (["TRACE_METHOD_UNAVAILABLE", "RPC_TIMEOUT", "RPC_RESPONSE_TOO_LARGE"].includes(error.code) ||
            (error.code === "UNKNOWN_BLOCK_REJECTED" && params[1].blockHash === TRACE_UNKNOWN_HASH))) return reject(new ExecutionError(error.code));
      if (requireNextBlock && method === "eth_simulateV1") {
        if (error instanceof ExecutionError && error.code === "UNKNOWN_BLOCK_REJECTED" && params[1].blockHash === SIMULATION_UNKNOWN_HASH)
          return reject(new ExecutionError("UNKNOWN_BLOCK_REJECTED"));
        return reject(safeNextBlockError(error));
      }
      return reject(new ExecutionError(error instanceof ExecutionError && error.code === "CALL_REVERTED" ? "CALL_REVERTED" : "PINNED_RPC_FAILED"));
    }
  }
  const request = (...args) => {
    const result = requestOne(...args); return internal.trackRequest ? internal.trackRequest(result) : result;
  };
  const ref = h => ({ blockHash: h.hash, requireCanonical: true });
  const checkedRequest = async (c, method, params, inspect) => {
    const value = await request(c, method, params); inspect?.(value); return value;
  };
  async function probe(c, h, send = checkedRequest) {
    await send(c, "eth_call", [{ to: MULTICALL3, data: PROBE.encodeFunctionData("getBlockNumber") }, ref(h)], raw => {
      requireThat(typeof raw === "string" && /^0x[0-9a-f]{64}$/i.test(raw) && BigInt(raw) === BigInt(h.number), "PIN_CALL_CAPABILITY_FAILED");
    });
  }
  const traceProbeTx = () => ({ from: TRACE_PROBE_FROM, to: MULTICALL3, value: "0x0", data: PROBE.encodeFunctionData("getBlockNumber") });
  async function probeTrace(c, h, send = checkedRequest) {
    const tx = traceProbeTx();
    await send(c, "debug_traceCall", [tx, ref(h), traceOptions()], raw => {
      const { tree } = normalizeCallTrace(raw);
      requireThat(tree.type === "CALL" && tree.from === tx.from && tree.to === tx.to && tree.input === tx.data && tree.value === "0" &&
        !tree.reverted && tree.output === PROBE.encodeFunctionResult("getBlockNumber", [h.number]), "PIN_TRACE_CAPABILITY_FAILED");
    });
  }
  const liveClock = now === Date.now && rpc === httpRpc;
  // Forecast acquisition and every strict header read retain the actual timestamp.
  const readHeader = (raw, clockSkew = liveClock && !requireNextBlock) => header(raw, now(), clockSkew && !requireStrictEvidence, requireNextBlock || internal.includeGasLimit === true);
  async function qualifyStrict(c, h) {
    (internal.responseRequire || requireThat)(h.number > 0 && h.hash !== TRACE_UNKNOWN_HASH, "PIN_STRICT_CAPABILITY_FAILED");
    const previous = readHeader(await request(c, "eth_getBlockByNumber", [tag(h.number - 1), false]));
    requireThat(previous.number === h.number - 1 && previous.hash === h.parentHash && previous.timestamp < h.timestamp &&
      previous.hash !== TRACE_UNKNOWN_HASH, "PIN_STRICT_CAPABILITY_FAILED");
    // The current hash-sensitive NUMBER probe has already run in the pool loop.
    if (internal.parallelStrictControls === true) {
      const codes = new Array(2);
      const code = (observed, index) => async () => {
        codes[index] = normalizeCode(await request(c, "eth_getCode", [MULTICALL3, ref(observed)]));
        // Compare inside the jobs so a completed code contradiction survives a
        // sibling NUMBER timeout; never rely on a partially returned stage.
        if (index === 0) requireThat(codes[0] !== "0x", "PIN_CODE_CAPABILITY_FAILED");
        if (codes[0] !== undefined && codes[1] !== undefined)
          requireThat(codes[0] === codes[1], "PIN_CODE_CAPABILITY_FAILED");
        return codes[index];
      };
      await strictControlGroup([() => probe(c, previous), code(previous, 0), code(h, 1)]);
    } else {
      await probe(c, previous);
      const previousCode = normalizeCode(await request(c, "eth_getCode", [MULTICALL3, ref(previous)]));
      const currentCode = normalizeCode(await request(c, "eth_getCode", [MULTICALL3, ref(h)]));
      requireThat(previousCode !== "0x" && previousCode === currentCode, "PIN_CODE_CAPABILITY_FAILED");
    }
    const negativeControls = [
      ["eth_call", [{ to: MULTICALL3, data: PROBE.encodeFunctionData("getBlockNumber") }, ref({ hash: TRACE_UNKNOWN_HASH })], "CALL_UNKNOWN_HASH_NOT_REJECTED"],
      ["eth_getCode", [MULTICALL3, ref({ hash: TRACE_UNKNOWN_HASH })], "CODE_UNKNOWN_HASH_NOT_REJECTED"]
    ];
    const rejectUnknown = async ([method, params, failure]) => {
      let rejected = false;
      try { await request(c, method, params); }
      catch (error) { if (!(error instanceof ExecutionError) || error.code !== "UNKNOWN_BLOCK_REJECTED") throw error; rejected = true; }
      requireThat(rejected, failure);
    };
    if (internal.parallelStrictControls === true) await strictControlGroup(negativeControls.map(control => () => rejectUnknown(control)));
    else for (const [method, params, failure] of negativeControls) {
      let rejected = false;
      try { await request(c, method, params); }
      catch (error) { if (!(error instanceof ExecutionError) || error.code !== "UNKNOWN_BLOCK_REJECTED") throw error; rejected = true; }
      requireThat(rejected, failure);
    }
    const canonicalCheck = async observed => {
      const canonical = readHeader(await request(c, "eth_getBlockByNumber", [tag(observed.number), false]));
      requireThat(same(canonical, observed), "PIN_CHANGED");
    };
    if (internal.parallelStrictControls === true) await strictControlGroup([previous, h].map(observed => () => canonicalCheck(observed)));
    else for (const observed of [previous, h]) {
      const canonical = readHeader(await request(c, "eth_getBlockByNumber", [tag(observed.number), false]));
      requireThat(same(canonical, observed), "PIN_CHANGED");
    }
    return { strictEvidence: true, hashPinnedCallQualified: true, callUnknownHashRejected: true,
      codeHashPinnedQualified: true, codeUnknownHashRejected: true, strictProbePin: previous };
  }
  async function qualifyTrace(c, h, send = checkedRequest) {
    requireThat(h.number > 0, "PIN_TRACE_CAPABILITY_FAILED");
    let previous;
    await send(c, "eth_getBlockByNumber", [tag(h.number - 1), false], raw => {
      previous = readHeader(raw);
      requireThat(previous.number === h.number - 1 && previous.hash === h.parentHash && previous.timestamp < h.timestamp &&
        previous.hash !== TRACE_UNKNOWN_HASH && h.hash !== TRACE_UNKNOWN_HASH, "PIN_TRACE_CAPABILITY_FAILED");
    });
    await probe(c, previous, send); await probeTrace(c, previous, send);
    let rejected = false;
    try { await send(c, "debug_traceCall", [traceProbeTx(), { blockHash: TRACE_UNKNOWN_HASH, requireCanonical: true }, traceOptions()], () => {
      throw new ExecutionError("TRACE_UNKNOWN_HASH_NOT_REJECTED");
    }); }
    catch (error) { if (error.code !== "UNKNOWN_BLOCK_REJECTED") throw error; rejected = true; }
    requireThat(rejected, "TRACE_UNKNOWN_HASH_NOT_REJECTED");
    for (const observed of [previous, h]) {
      await send(c, "eth_getBlockByNumber", [tag(observed.number), false], raw => {
        requireThat(same(readHeader(raw), observed), "PIN_CHANGED");
      });
    }
    return { traceQualified: true, hashPinnedBlockNumberVerified: true, unknownHashRejected: true, probePin: previous };
  }
  async function qualifyNextBlock(c, h) {
    const evidence = await qualifyNextBlockProvider({ provider: c, pin: h, request });
    requireThat(same(readHeader(await request(c, "eth_getBlockByNumber", [tag(h.number), false])), h), "NEXT_BLOCK_PARENT_CHANGED");
    return evidence;
  }
  const qualified = [], outcomes = new Array(candidates.length), qualificationFailures = [];
  if (internal.capabilityRows) {
    // This branch is reachable only through the factory's private certificate.
    // The public entrypoint cannot supply internal hooks or qualification rows.
    internal.assertUsable();
    for (let index = 0; index < candidates.length; index++) {
      const proof = internal.capabilityRows[index];
      qualified.push({ c: candidates[index], h: proof.anchor, alias: index + 1 });
      outcomes[index] = { ...structuredClone(proof.qualification), alias: index + 1, qualificationMode: "capability-v1",
        capabilityAnchor: structuredClone(proof.anchor), freshPinNumberVerified: true };
    }
  } else {
  // Finish qualification of the entire bounded pool before choosing any families.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(internal.concurrency || QUALIFICATION_CONCURRENCY, candidates.length) }, async () => {
    while (next < candidates.length) {
      const index = next++, c = candidates[index];
      try {
        requireThat(uint(await request(c, "eth_chainId", [])) === 1n, "WRONG_CHAIN");
        const h = readHeader(await request(c, "eth_getBlockByNumber", ["latest", false])); await probe(c, h);
        internal.onHeader?.(c, h);
        const strictEvidence = requireStrictEvidence ? await qualifyStrict(c, h) : {};
        const traceEvidence = requireTrace ? await qualifyTrace(c, h) : {};
        const nextBlockEvidence = requireNextBlock ? await qualifyNextBlock(c, h) : {};
        await internal.onQualified?.(c);
        qualified.push({ c, h, alias: index + 1 }); outcomes[index] = { alias: index + 1, qualified: true, ...strictEvidence, ...traceEvidence, ...nextBlockEvidence };
      } catch (error) {
        qualificationFailures.push(error);
        internal.onQualificationFailure?.(c, error);
        outcomes[index] = { alias: index + 1, qualified: false };
        if (requireTrace) outcomes[index].reason = error instanceof ExecutionError &&
          ["WRONG_CHAIN", "PIN_HEADER_INVALID", "PIN_STALE_OR_FUTURE", "PIN_CALL_CAPABILITY_FAILED", "PIN_TRACE_CAPABILITY_FAILED", "PIN_CHANGED",
            "TRACE_UNKNOWN_HASH_NOT_REJECTED", "TRACE_METHOD_UNAVAILABLE", "TRACE_SHAPE_INVALID", "RPC_TIMEOUT", "RPC_RESPONSE_TOO_LARGE"].includes(error.code)
          ? error.code : "TRACE_QUALIFICATION_FAILED";
        if (requireNextBlock) outcomes[index].reason = safeNextBlockError(error).code;
        if (requireStrictEvidence) outcomes[index].reason = error instanceof ExecutionError &&
          ["WRONG_CHAIN", "PIN_HEADER_INVALID", "PIN_STALE_OR_FUTURE", "PIN_CALL_CAPABILITY_FAILED", "PIN_STRICT_CAPABILITY_FAILED", "PIN_CHANGED",
            "PIN_CODE_RESULT_INVALID", "PIN_CODE_CAPABILITY_FAILED", "CALL_UNKNOWN_HASH_NOT_REJECTED", "CODE_UNKNOWN_HASH_NOT_REJECTED",
            "RPC_TIMEOUT", "RPC_RESPONSE_TOO_LARGE"].includes(error.code) ? error.code : "STRICT_QUALIFICATION_FAILED";
      }
    }
  }));
  qualified.sort((a, b) => b.h.number - a.h.number || a.alias - b.alias);
  }
  const first = qualified[0], second = qualified.find(q => q.c.family !== first?.c.family);
  if (!(first && second)) {
    const error = new ExecutionError(requireStrictEvidence ? "TWO_STRICT_CAPABLE_FAMILIES_REQUIRED" : requireNextBlock ? "TWO_NEXT_BLOCK_CAPABLE_FAMILIES_REQUIRED" :
      requireTrace ? "TWO_TRACE_CAPABLE_FAMILIES_REQUIRED" : "TWO_PIN_CAPABLE_FAMILIES_REQUIRED");
    internal.onSelectionFailure?.(error, qualificationFailures); throw error;
  }
  const selected = [first, second];
  if (requireStrictEvidence) Object.freeze(selected);
  if (internal.selectionOnly) return { aliases: selected.map(q => q.alias),
    capabilities: selected.map(q => ({ anchor: q.h, qualification: outcomes[q.alias - 1] })),
    ...(internal.selectionHints ? {
      strictPool: qualified.map(q => ({ alias: q.alias, anchor: q.h, qualification: outcomes[q.alias - 1] })),
      async hintTrace(c, h, send) { await probe(c, h, send); await probeTrace(c, h, send); await qualifyTrace(c, h, send); },
    } : {}) };
  internal.onPinStart?.();
  // Full-pool qualification can age the observed heads. Refresh only the already
  // selected pair before acquiring the immutable pin; never reselect on failure.
  const observedFailure = error => { if (trustFailure(error)) internal.onQualificationFailure?.(first.c, error); };
  let freshHeads;
  if (internal.capabilityRows) {
    await strictControlGroup(selected.map(q => async () => {
      try { requireThat(uint(await request(q.c, "eth_chainId", [])) === 1n, "WRONG_CHAIN"); }
      catch (error) { if (trustFailure(error)) internal.onQualificationFailure?.(q.c, error); throw error; }
    }));
    freshHeads = await strictControlGroup(selected.map(q => async () => {
      try { const h = readHeader(await request(q.c, "eth_getBlockByNumber", ["latest", false])); internal.onHeader?.(q.c, h); return h; }
      catch (error) { if (trustFailure(error)) internal.onQualificationFailure?.(q.c, error); throw error; }
    }));
  } else freshHeads = await Promise.all(selected.map(async q => {
    requireThat(uint(await request(q.c, "eth_chainId", [])) === 1n, "WRONG_CHAIN");
    return readHeader(await request(q.c, "eth_getBlockByNumber", ["latest", false]));
  }));
  if (requireNextBlock) requireThat(same(freshHeads[0], freshHeads[1]), "NEXT_BLOCK_PROVIDER_DISAGREEMENT");
  requireThat(Math.abs(freshHeads[0].number - freshHeads[1].number) <= 4, "PROVIDER_HEAD_GAP");
  const number = Math.min(freshHeads[0].number, freshHeads[1].number);
  const headerJobs = selected.map((q, i) => async () => {
    const result = readHeader(await request(q.c, "eth_getBlockByNumber", [tag(number), false]));
    if (internal.capabilityRows) requireThat(result.number === number &&
      (freshHeads[i].number !== number || same(result, freshHeads[i])), "PIN_HASH_DISAGREEMENT");
    return result;
  });
  const headers = internal.capabilityRows ? await strictControlGroup(headerJobs, observedFailure) : await Promise.all(headerJobs.map(invoke => invoke()));
  requireThat(headers.every(h => h.number === number) && same(headers[0], headers[1]), "PIN_HASH_DISAGREEMENT");
  let pin = headers[0];
  internal.onPin?.(pin);
  // Next-block capability probes have all finished before the fresh final pin.
  // Do not spend its +12s window repeating qualification; strict rechecks and the
  // actual simulation still validate this exact parent's hash/number/timestamp.
  if (!requireNextBlock) {
    const jobs = selected.map(q => async () => {
    await probe(q.c, pin); if (requireTrace) await probeTrace(q.c, pin);
    });
    if (internal.capabilityRows) await strictControlGroup(jobs, observedFailure); else await Promise.all(jobs.map(invoke => invoke()));
  }
  let poisoned = false;
  const assertUsable = () => { requireThat(!poisoned, "PIN_EVIDENCE_INVALIDATED"); internal.assertUsable?.(); };
  const poison = error => { poisoned = true; internal.onPoison?.(error); };
  async function equalOne(method, params, timeoutMs) {
    assertUsable();
    try {
      const facts = new Map(); let semanticFailure;
      const observe = (c, value, reverted = false) => {
        try {
          facts.set(c.handle, { value, reverted });
          if (facts.size !== selected.length) return;
          const rows = [...facts.values()];
          if (method === "eth_call" && rows.some(row => row.reverted) && rows.some(row => !row.reverted))
            throw new ExecutionError("PROVIDER_CALL_OUTCOME_DISAGREEMENT");
          if (rows.every(row => !row.reverted)) requireThat(same(rows[0].value, rows[1].value), "PROVIDER_RESULT_DISAGREEMENT");
        } catch (error) { semanticFailure = error; poison(error); throw error; }
      };
      const normalize = value => {
        if (method === "eth_getBalance") {
          requireThat(validRpcResult(method, value), "PIN_BALANCE_RESULT_INVALID");
          return tag(uint(value, "PIN_BALANCE_RESULT_INVALID"));
        }
        return method === "eth_getTransactionReceipt" ? normalizeReceipt(value, params[0]) :
          method === "debug_traceCall" ? normalizeCallTrace(value) : method === "eth_getCode" ? normalizeCode(value) : value;
      };
      const settled = await Promise.allSettled(selected.map(q => request(q.c, method, params, timeoutMs, undefined, undefined,
        internal.trackSemantic ? value => observe(q.c, normalize(value)) : undefined,
        internal.trackSemantic ? error => { if (error.code === "CALL_REVERTED") observe(q.c, null, true); return error; } : undefined)));
      if (semanticFailure) throw semanticFailure;
      if (["eth_call", "eth_estimateGas"].includes(method) && settled.every(s => s.status === "rejected" && s.reason.code === "CALL_REVERTED"))
        throw new ExecutionError("CALL_REVERTED");
      // Both witnesses ran the identical hash-pinned call. A successful result
      // versus a genuine execution revert is semantic disagreement, not missing
      // transport evidence; poison shared trust before unrelated work drains.
      if (method === "eth_call" && settled.some(s => s.status === "fulfilled") &&
          settled.some(s => s.status === "rejected" && s.reason instanceof ExecutionError && s.reason.code === "CALL_REVERTED"))
        throw new ExecutionError("PROVIDER_CALL_OUTCOME_DISAGREEMENT");
      if (!settled.every(s => s.status === "fulfilled")) {
        const error = new ExecutionError("PINNED_RPC_FAILED");
        internal.onOperationFailure?.(error, settled.filter(row => row.status === "rejected").map(row => row.reason)); throw error;
      }
      const values = settled.map(s => normalize(s.value));
      requireThat(same(values[0], values[1]), "PROVIDER_RESULT_DISAGREEMENT");
      assertUsable(); return values[0];
    } catch (error) { if (error.code !== "CALL_REVERTED") poison(error); throw error; }
  }
  const equal = (...args) => { const result = equalOne(...args); return internal.trackSemantic ? internal.trackSemantic(result) : result; };
  async function recheckOne() {
    assertUsable();
    try {
      if (internal.parallelRecheck === true) {
        const observed = error => { if (trustFailure(error)) poison(error); };
        await strictControlGroup(selected.map(q => async () => {
          try {
            requireThat(uint(await request(q.c, "eth_chainId", [])) === 1n, "WRONG_CHAIN");
            await strictControlGroup([
              async () => {
                const current = readHeader(await request(q.c, "eth_getBlockByNumber", [tag(pin.number), false]), liveClock);
                requireThat(same(current, pin), "PIN_CHANGED");
              },
              async () => {
                const head = readHeader(await request(q.c, "eth_getBlockByNumber", ["latest", false]), liveClock);
                if (head.number === pin.number) requireThat(same(head, pin), "PIN_CHANGED");
                requireThat(head.number >= pin.number && head.number - pin.number <= 4, "PIN_TOO_FAR_BEHIND");
              },
            ], observed);
          } catch (error) { observed(error); throw error; }
        }));
      } else {
      for (const q of selected) {
        requireThat(uint(await request(q.c, "eth_chainId", [])) === 1n, "WRONG_CHAIN");
        const current = readHeader(await request(q.c, "eth_getBlockByNumber", [tag(pin.number), false]), liveClock);
        requireThat(same(current, pin), "PIN_CHANGED");
        const head = readHeader(await request(q.c, "eth_getBlockByNumber", ["latest", false]), liveClock);
        requireThat(head.number >= pin.number && head.number - pin.number <= 4, "PIN_TOO_FAR_BEHIND");
      }
      }
      internal.assertUsable?.();
    } catch (error) { poison(error); throw error; }
  }
  const recheck = (...args) => { const result = recheckOne(...args); return internal.trackSemantic ? internal.trackSemantic(result) : result; };
  // Only standalone CURRENT sessions may repin. Reject every private session
  // binding, including methods copied into M1's frozen FUTURE facade. This is
  // a caller error outside the poison boundary; no lease proof is retargeted.
  const repinSupported = !requireNextBlock && !requireTrace && Reflect.ownKeys(internal).length === 0;
  let repinning = false, repinCount = 0;
  async function repin() {
    requireThat(repinSupported, "REPIN_UNSUPPORTED_FOR_LEASE_SESSION");
    try {
      assertUsable(); requireThat(!repinning, "REPIN_IN_PROGRESS"); repinning = true;
      // Plain sessions have no pass-lifecycle signal: the owner must await all
      // pass work before repinning, and await repin before starting another pass.
      // Latest heads may legitimately be skewed. Use their numbers only to
      // choose a common height, then compare both witnesses at that exact height.
      const latest = await Promise.allSettled(selected.map(async q => {
        const raw = await request(q.c, "eth_getBlockByNumber", ["latest", false]);
        const number = Number(uint(raw?.number, "PIN_HEADER_INVALID"));
        requireThat(Number.isSafeInteger(number), "PIN_HEADER_INVALID"); return number;
      }));
      const latestFailure = latest.find(row => row.status === "rejected");
      if (latestFailure) throw latestFailure.reason;
      const number = Math.min(...latest.map(row => row.value));
      assertUsable();
      // Drain both witnesses; retain actual timestamps, never clock-skew clamps.
      const settled = await Promise.allSettled(selected.map(async q =>
        readHeader(await request(q.c, "eth_getBlockByNumber", [tag(number), false]), false)));
      const failed = settled.find(row => row.status === "rejected");
      if (failed) throw failed.reason;
      const [head, witness] = settled.map(row => row.value);
      requireThat(head.number === number && witness.number === number && same(head, witness), "PROVIDER_RESULT_DISAGREEMENT");
      // Same four-block freshness convention as recheck; equality is a no-op,
      // not permission to replace an already witnessed header at that height.
      requireThat(number >= pin.number && number - pin.number <= 4, "PIN_TOO_FAR_BEHIND");
      if (head.number === pin.number) requireThat(same(head, pin), "PIN_CHANGED");
      const nextPin = Object.freeze(head), aliases = Object.freeze([...api.evidence.aliases]);
      const record = Object.freeze({ sequence: repinCount + 1,
        previousPin: Object.freeze({ number: pin.number, hash: pin.hash }),
        pin: Object.freeze({ number: nextPin.number, hash: nextPin.hash }),
        timestamp: new Date(now()).toISOString(), aliases });
      assertUsable();
      // Bounded latest-repin metadata; original qualification/probe snapshots
      // remain untouched. No await separates publication from the closure swap.
      api.evidence.lastRepin = record; api.pin = nextPin; pin = nextPin; repinCount++;
      return { pin, aliases };
    } catch (error) { poison(error); throw error; }
    finally { repinning = false; }
  }
  let liveHeadProvider = 0;
  async function send(signed, assertProof = assertUsable) {
    // The private v2 binding carries the active CURRENT/FUTURE proof all the
    // way to the queued physical invocation. Legacy transport is unchanged.
    const assertDispatch = internal.bindSend ? () => { assertUsable(); assertProof(); } : undefined;
    assertDispatch?.();
    return request(first.c, "eth_sendRawTransaction", [signed], undefined, 0, assertDispatch);
  }
  internal.bindSend?.(send);
  // Private same-session binding: neither provider handles nor a replacement pin
  // cross the lease API. The factory supplies a context-bound, finite-budget job.
  internal.bindCurrentTrace?.(async ({ request: traceRequest, assertUsable: assertLease, stop, drain }) => {
    let failure = null, qualified = false, queue = Promise.resolve();
    const assertTrace = () => {
      assertUsable(); assertLease();
      if (failure) throw failure;
    };
    const observeFailure = error => {
      if (!failure || !trustFailure(failure) && trustFailure(error)) failure = error;
      stop();
      if (trustFailure(error)) poison(error);
    };
    const stage = async jobs => {
      assertTrace();
      let values;
      try { values = await strictControlGroup(jobs, observeFailure); }
      catch (error) { observeFailure(error); }
      finally { await drain(); }
      // Draining may observe a late contradiction after a resource timeout.
      if (failure) throw failure;
      return values;
    };
    const requester = () => {
      const traces = new Map(), headers = new Map();
      return async (c, method, params, inspect) => {
        assertTrace();
        const failed = error => {
          if (error instanceof ExecutionError && error.code === "UNKNOWN_BLOCK_REJECTED" && method === "debug_traceCall" && params[1].blockHash === TRACE_UNKNOWN_HASH) return error;
          const availability = ["TRACE_METHOD_UNAVAILABLE", "TRACE_RESOURCE_UNAVAILABLE", "RPC_TIMEOUT", "RPC_RESPONSE_TOO_LARGE", "RPC_HTTP_RETRYABLE", "RPC_TRANSPORT_ERROR"];
          if (method === "debug_traceCall" && availability.includes(error?.code)) error = new ExecutionError("TRACE_CAPABILITY_UNAVAILABLE");
          else if (!(error instanceof ExecutionError)) error = new ExecutionError("PINNED_RPC_FAILED");
          observeFailure(error); return error;
        };
        try {
          return await traceRequest(c, method, params, raw => {
            // Inspect before the job's cancellation/context checks: a late
            // contradiction from a started sibling must still revoke trust.
            try {
              inspect?.(raw);
              if (method === "debug_traceCall") {
                const value = normalizeCallTrace(raw), key = params[1].blockHash;
                requireThat(!traces.has(key) || same(traces.get(key), value), "PROVIDER_RESULT_DISAGREEMENT");
                traces.set(key, value);
              } else if (method === "eth_getBlockByNumber" && params[0] !== "latest") {
                const value = readHeader(raw), key = params[0];
                requireThat(value.number === Number(BigInt(key)) && (!headers.has(key) || same(headers.get(key), value)), "PIN_CHANGED");
                headers.set(key, value);
              }
            } catch (error) { observeFailure(error); throw error; }
          }, failed);
        } catch (error) { throw failed(error); }
      };
    };
    const request = requester();
    const proofs = await stage(selected.map(q => async () => {
      await request(q.c, "eth_chainId", [], raw => { requireThat(uint(raw, "WRONG_CHAIN") === 1n, "WRONG_CHAIN"); });
      await request(q.c, "eth_getBlockByNumber", [tag(pin.number), false], raw => { requireThat(same(readHeader(raw), pin), "PIN_CHANGED"); });
      await probe(q.c, pin, request); await probeTrace(q.c, pin, request);
      const proof = await qualifyTrace(q.c, pin, request);
      await request(q.c, "eth_getBlockByNumber", ["latest", false], raw => {
        const head = readHeader(raw);
        if (head.number === pin.number) requireThat(same(head, pin), "PIN_CHANGED");
        requireThat(head.number >= pin.number && head.number - pin.number <= 4, "PIN_TOO_FAR_BEHIND");
      });
      return proof;
    }));
    assertTrace(); qualified = true;
    const evidence = Object.freeze({ traceQualified: true, independentFamilies: true, fixedProviderPair: true,
      hashPinnedBlockNumberVerified: true, unknownHashRejected: true,
      aliases: Object.freeze([...api.evidence.aliases]), probePin: Object.freeze({ ...proofs[0].probePin }) });
    const assertFacet = () => { assertTrace(); requireThat(qualified, "TRACE_EVIDENCE_INVALIDATED"); };
    return Object.freeze({ pin: api.pin, evidence, assertUsable: assertFacet, async trace(tx, ...extra) {
      requireThat(extra.length === 0, "TRACE_OPTIONS_INVALID");
      const transaction = currentTraceTransaction(tx);
      const run = queue.then(async () => {
        assertFacet(); const request = requester();
        const values = await stage(selected.map(q => async () => {
          const raw = await request(q.c, "debug_traceCall", [transaction, ref(pin), traceOptions()], value => {
            const { tree } = normalizeCallTrace(value);
            requireThat(tree.type === "CALL" && tree.from === transaction.from.toLowerCase() && tree.to === transaction.to.toLowerCase() &&
              tree.input === transaction.data.toLowerCase() && tree.value === BigInt(transaction.value).toString(), "TRACE_TRANSACTION_MISMATCH");
          });
          return normalizeCallTrace(raw);
        }));
        assertFacet(); return values[0];
      });
      queue = run.then(() => {}, () => {}); return internal.trackSemantic ? internal.trackSemantic(run) : run;
    } });
  });
  async function liveHeadNumber() {
    // Scheduling only: one read, no retry, consensus, pin update or poison writes.
    // After failure prefer the other qualified witness on the next poll.
    try {
      const raw = await request(selected[liveHeadProvider].c, "eth_getBlockByNumber", ["latest", false], 1500, 0);
      const number = Number(uint(raw?.number, "LIVE_HEAD_INVALID"));
      requireThat(Number.isSafeInteger(number), "LIVE_HEAD_INVALID"); return number;
    } catch (error) { liveHeadProvider = 1 - liveHeadProvider; throw error; }
  }
  const api = {
    pin: Object.freeze(pin), evidence: { aliases: selected.map(q => q.alias), qualification: outcomes, independentFamilies: true },
    call: tx => equal("eth_call", [tx, ref(pin)]),
    estimateGas: tx => equal("eth_estimateGas", [tx, ref(pin)]),
    nonce: account => equal("eth_getTransactionCount", [account, "pending"]),
    // Native wei at this session's canonical pin, returned as normalized hex.
    // Not a fresh/latest or inclusion-time balance check; retain recheck/stale holds.
    balance: async (account, timeoutMs) => {
      requireThat(typeof account === "string" && account.length === 42 && /^0x[0-9a-f]{40}$/i.test(account), "PIN_BALANCE_REQUEST_INVALID");
      return equal("eth_getBalance", [account.toLowerCase(), ref(pin)], timeoutMs);
    },
    receipt: (txHash, timeoutMs) => equal("eth_getTransactionReceipt", [txHash], timeoutMs),
    send: signed => send(signed), recheck, repin,
    liveHeadNumber: internal.trackSemantic ? (...args) => internal.trackSemantic(liveHeadNumber(...args)) : liveHeadNumber,
    assertUsable,
    collectorOptions: {
      writeOut: false,
      resolveRpc: async chainId => chainId === 1 ? "PINNED_ETHEREUM" : null,
      rpcCall: async (handle, method, params, timeoutMs = REQUEST_TIMEOUT_MS) => {
        if (internal.capabilityRows) assertUsable();
        requireThat(handle === "PINNED_ETHEREUM", "COLLECTOR_CHAIN_NOT_ALLOWED");
        if (method === "eth_getBlockByNumber" && params[0] === "latest" && params[1] === false) return {
          ...pin, number: tag(pin.number), timestamp: tag(pin.timestamp), baseFeePerGas: tag(BigInt(pin.baseFeePerGas))
        };
        requireThat(method === "eth_call" && params.length === 2 && (params[1] === pin.hash || params[1]?.blockHash === pin.hash), "COLLECTOR_UNPINNED_REQUEST");
        return equal("eth_call", [params[0], ref(pin)], timeoutMs);
      }
    }
  };
  if (requireStrictEvidence) {
    Object.assign(api.evidence, { strictEvidence: true, fixedProviderPair: true, rawTimestamp: true, codeHashPinnedQualified: true });
    api.code = async (account, ...extra) => {
      requireThat(extra.length === 0, "PIN_CODE_REQUEST_INVALID");
      const params = [account, ref(pin)]; validateCodeParams(params); params[0] = account.toLowerCase();
      return equal("eth_getCode", params);
    };
  }
  if (requireTrace) {
    api.evidence.traceQualified = true;
    api.trace = async (tx, ...extra) => {
      requireThat(extra.length === 0, "TRACE_OPTIONS_INVALID");
      const params = [tx, ref(pin), traceOptions()]; validateTraceParams(params);
      return equal("debug_traceCall", params);
    };
    await recheck();
  }
  if (requireNextBlock) {
    api.nextBlock = createNextBlockSimulation({ pin, providers: selected.map(q => q.c),
      request: (c, method, params) => request(c, method, params, Math.max(0, (pin.timestamp + 12) * 1000 - now())),
      now, assertUsable: api.assertUsable });
    await api.nextBlock.recheck();
    api.evidence.nextBlockQualified = true;
  }
  return api;
}
// The inventory loader supplies plain {family, handle: string} records. Reject
// opaque/mutable handle objects rather than guessing which nested fields matter.
// Copies stay process-local, are never serialized/hashed, and isolate sessions
// from subsequent caller mutations (including edits during qualification).
function snapshotPairCandidates(candidates) {
  const code = "RPC_CANDIDATES_INVALID";
  try {
    requireThat(Array.isArray(candidates) && candidates.length >= 2 && candidates.length <= MAX_CANDIDATES, code);
    return Object.freeze(Array.from({ length: candidates.length }, (_, index) => {
      const item = Object.getOwnPropertyDescriptor(candidates, String(index));
      requireThat(item && Object.hasOwn(item, "value"), code);
      const c = item.value;
      requireThat(c && [Object.prototype, null].includes(Object.getPrototypeOf(c)) &&
        Reflect.ownKeys(c).length === 2, code);
      const family = Object.getOwnPropertyDescriptor(c, "family"), handle = Object.getOwnPropertyDescriptor(c, "handle");
      requireThat(family && handle && Object.hasOwn(family, "value") && Object.hasOwn(handle, "value") &&
        typeof family.value === "string" && family.value.length > 0 && typeof handle.value === "string" && handle.value.length > 0, code);
      return Object.freeze({ family: family.value, handle: handle.value });
    }));
  } catch (_) { throw new ExecutionError(code); }
}
const samePairInventory = (a, b) => a.length === b.length && a.every((c, i) => c.family === b[i].family && c.handle === b[i].handle);

function createQualifiedPairFactory({ rpc, now = Date.now, monotonic = () => performance.now(), ttlMs = 60000,
  requireStrictEvidence = true, requireNextBlock = false, requireTrace = false, ...options } = {}) {
  requireThat(Object.keys(options).length === 0 && typeof rpc === "function" && typeof now === "function" &&
    typeof monotonic === "function" && Number.isFinite(ttlMs) && ttlMs > 0 && ttlMs <= 60000 &&
    requireStrictEvidence === true && typeof requireNextBlock === "boolean" && typeof requireTrace === "boolean",
  "QUALIFIED_PAIR_OPTIONS_INVALID");
  let cache = null, generation = 0, closed = false, lastTick = null, queue = Promise.resolve();
  function invalidate() { cache = null; generation++; }
  function close() { closed = true; invalidate(); }
  function tick() {
    try {
      const value = monotonic();
      requireThat(Number.isFinite(value) && value >= 0 && (lastTick === null || value >= lastTick), "QUALIFIED_PAIR_CLOCK_INVALID");
      lastTick = value; return value;
    } catch (_) { lastTick = null; invalidate(); throw new ExecutionError("QUALIFIED_PAIR_CLOCK_INVALID"); }
  }
  function wallClock() {
    try {
      const value = now(); requireThat(Number.isSafeInteger(value) && value >= 0, "QUALIFIED_PAIR_CLOCK_INVALID"); return value;
    } catch (_) { throw new ExecutionError("QUALIFIED_PAIR_CLOCK_INVALID"); }
  }
  function inputCandidates(input) {
    try {
      const field = input && Object.getOwnPropertyDescriptor(input, "candidates");
      requireThat(input && Reflect.ownKeys(input).length === 1 && field && Object.hasOwn(field, "value"), "QUALIFIED_PAIR_OPTIONS_INVALID");
      return field.value;
    } catch (_) { throw new ExecutionError("QUALIFIED_PAIR_OPTIONS_INVALID"); }
  }
  async function acquireOne(input) {
    requireThat(!closed, "QUALIFIED_PAIR_CLOSED");
    let inventory;
    try {
      inventory = snapshotPairCandidates(inputCandidates(input));
    } catch (error) { invalidate(); throw new ExecutionError(error instanceof ExecutionError ? error.code : "RPC_CANDIDATES_INVALID"); }
    const start = tick();
    if (cache && (start - cache.startedAt >= ttlMs || !samePairInventory(cache.inventory, inventory))) invalidate();
    if (cache) { try { cache.assertUsable(); } catch (_) { invalidate(); } }
    const warm = cache !== null, startedAt = warm ? cache.startedAt : start;
    // Only selection indices, inventory values and a poison predicate survive.
    // Never retain pins, contexts, qualification/runtime values or nonce evidence.
    const aliases = warm ? [...cache.aliases].sort((a, b) => a - b) : inventory.map((_, i) => i + 1);
    const selected = aliases.map(alias => inventory[alias - 1]), epoch = generation;
    const evict = () => { if (generation === epoch) invalidate(); };
    let accepting = true;
    const pending = new Set();
    const trackedRpc = (...args) => {
      const request = Promise.resolve().then(() => {
        requireThat(accepting, "PINNED_RPC_FAILED"); return rpc(...args);
      });
      const settled = request.then(() => pending.delete(settled), () => pending.delete(settled));
      pending.add(settled); return request;
    };
    const drain = async () => { while (pending.size) await Promise.all([...pending]); };
    try {
      const api = await createPinnedRpc({ candidates: selected, rpc: trackedRpc, now: wallClock,
        requireStrictEvidence: true, requireNextBlock, requireTrace });
      await drain();
      const end = tick();
      requireThat(!closed, "QUALIFIED_PAIR_CLOSED");
      requireThat(generation === epoch, "QUALIFIED_PAIR_INVALIDATED");
      requireThat(samePairInventory(inventory, snapshotPairCandidates(inputCandidates(input))), "QUALIFIED_PAIR_INVENTORY_CHANGED");
      api.evidence.aliases = api.evidence.aliases.map(alias => aliases[alias - 1]);
      api.evidence.qualification = api.evidence.qualification.map(row => ({ ...row, alias: aliases[row.alias - 1] }));
      api.evidence.qualificationReuse = warm ? "WARM_PAIR_REQUALIFICATION" : "COLD_FULL_POOL";
      const assertUsable = api.assertUsable;
      const observeParent = invoke => async (...args) => {
        try { return await invoke(...args); }
        finally { try { assertUsable(); } catch (_) { evict(); } }
      };
      for (const name of ["call", "estimateGas", "nonce", "receipt", "recheck", "code", "trace"])
        if (api[name]) api[name] = observeParent(api[name]);
      api.collectorOptions.rpcCall = observeParent(api.collectorOptions.rpcCall);
      if (api.nextBlock) {
        const child = api.nextBlock, observeChild = invoke => async (...args) => {
          try { return await invoke(...args); }
          catch (error) { if (error.code !== "NEXT_BLOCK_REVERTED") evict(); throw error; }
        };
        api.nextBlock = Object.freeze({ context: child.context, recheck: observeChild(child.recheck), simulate: observeChild(child.simulate) });
      }
      // Expiry does not discard this freshly qualified session, but forbids reuse.
      if (end - startedAt < ttlMs) cache = { inventory, aliases: [...api.evidence.aliases], startedAt, assertUsable };
      else invalidate();
      return api;
    } catch (error) {
      // Promise.all inside legacy acquisition may fail fast. Stop subsequent
      // physical calls (including delayed retries) and drain every started call
      // before releasing the queue. Never cold-fallback within this acquisition.
      accepting = false; evict(); await drain();
      throw error instanceof ExecutionError ? error : new ExecutionError("QUALIFIED_PAIR_ACQUISITION_FAILED");
    }
  }
  function acquire(input) {
    const result = queue.then(() => acquireOne(input));
    queue = result.then(() => {}, () => {}); return result;
  }
  return Object.freeze({ acquire, invalidate, close });
}

function createM1HotPathFactory({ rpc, now = Date.now, monotonic = () => performance.now(), allowFuture = false, onTiming,
  qualificationMode = "fresh", resolveOrigin, getCapabilityContext, rank1AcquisitionRecovery = false, selectionPolicy, ...options } = {}) {
  requireThat(["fresh", "capability-v1"].includes(qualificationMode), "M1_QUALIFICATION_MODE_INVALID");
  requireThat(Object.keys(options).length === 0 && typeof rpc === "function" && typeof now === "function" &&
    typeof monotonic === "function" && typeof allowFuture === "boolean" && typeof rank1AcquisitionRecovery === "boolean" &&
    (selectionPolicy === undefined || selectionPolicy === "rank1-prefer-dual") &&
    (onTiming === undefined || typeof onTiming === "function"), "M1_HOT_PATH_OPTIONS_INVALID");
  const reuseCapability = qualificationMode === "capability-v1";
  const preferDual = selectionPolicy === "rank1-prefer-dual";
  requireThat((resolveOrigin === undefined || typeof resolveOrigin === "function") &&
    (getCapabilityContext === undefined || typeof getCapabilityContext === "function") &&
    (!reuseCapability || rpc === httpRpc || typeof resolveOrigin === "function" && typeof getCapabilityContext === "function"), "M1_CAPABILITY_CONTEXT_REQUIRED");
  const TTL = 60000, REFRESH_AT = 30000, RETRY_MS = 5000, BUDGET = 30000;
  let closed = false, inventory = null, selection = null, epoch = 0, refresh = null, optional = null, hints = null, retryAt = 0, lastClock = null, latestLeaseCancel = null;
  let trust = new Map();
  const pending = new Set(), acquisitions = new Set(), timingRecords = [], certificates = new Set();
  let inventoryRevision = 0, certificateRevision = 0;
  // All authority is private and identity-bound; public codes are never permits.
  const recovery = rank1AcquisitionRecovery ? { errors: new WeakMap(), causes: new WeakMap(), works: new Set(),
    origins: new WeakMap(), accepted: new Map(), domains: [], roots: new Set(), background: new Set(), records: new Set(), hard: null, retiring: null, disposed: false } : null;
  const noOrigin = () => null;
  const hintSoftErrors = new WeakSet();
  function hintWindow(code = "M1_HOT_PATH_BUDGET") {
    const error = new ExecutionError(code); hintSoftErrors.add(error);
    return rememberFailure(error, { hintUnavailable: true, eligible: false });
  }
  const hintUnavailable = (error, method) => hintSoftErrors.has(error) || error instanceof ExecutionError && (
    ["RPC_TIMEOUT", "RPC_TRANSPORT_ERROR", "RPC_HTTP_RETRYABLE"].includes(error.code) ||
    method === "debug_traceCall" && ["TRACE_METHOD_UNAVAILABLE", "TRACE_RESOURCE_UNAVAILABLE", "RPC_RESPONSE_TOO_LARGE"].includes(error.code) ||
    method === "eth_simulateV1" && ["NEXT_BLOCK_METHOD_UNAVAILABLE", "NEXT_BLOCK_REVERTED"].includes(error.code));
  const safeRecoveryError = error => new ExecutionError(error instanceof ExecutionError && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)
    ? error.code : "M1_HOT_PATH_ACQUISITION_FAILED");
  function hardFailure(error) {
    if (recovery && !recovery.hard) recovery.hard = safeRecoveryError(error);
  }
  function rememberFailure(error, cause) {
    if (recovery && error && typeof error === "object") recovery.causes.set(error, cause);
    return error;
  }
  const ownedLifecycle = error => !!recovery?.causes.get(error)?.lifecycle;
  function lifecycle(code, owner) {
    return rememberFailure(new ExecutionError(code), { lifecycle: true, owner, cleanup: recovery?.retiring, eligible: false });
  }
  function trackSemantic(promise) {
    if (!recovery) return promise;
    const done = promise.then(() => {}, () => {}).finally(() => recovery.roots.delete(done));
    recovery.roots.add(done); return promise;
  }
  function acceptedCandidate(c, reference = trust.get(c.handle)) {
    return !!reference?.accepted || !!recovery?.accepted.get(c.handle)?.has(c.family);
  }
  function acceptCandidate(c, reference) {
    reference.accepted = true;
    if (!recovery.accepted.has(c.handle)) recovery.accepted.set(c.handle, new Set());
    recovery.accepted.get(c.handle).add(c.family);
  }
  function reconcileCandidate(c, row, reference) {
    const context = row.recoveryContext;
    let domain = recovery.domains.find(value => sameContext(value.context, context));
    if (!domain) { domain = { context, headers: new Map(), byHash: new Map(), facts: new Map() }; recovery.domains.push(domain); }
    const conflicts = new Set();
    const compare = (previous, value) => { if (previous && !same(previous.value, value)) conflicts.add(previous.c); };
    for (const [number, value] of row.acceptedFacts.headers) {
      compare(domain.headers.get(number), value); compare(domain.byHash.get(value.hash), value);
      const parent = domain.headers.get(number - 1), child = domain.headers.get(number + 1);
      if (parent && (parent.value.hash !== value.parentHash || parent.value.timestamp >= value.timestamp)) conflicts.add(parent.c);
      if (child && (child.value.parentHash !== value.hash || child.value.timestamp <= value.timestamp)) conflicts.add(child.c);
    }
    for (const [key, value] of row.acceptedFacts.fixed) compare(domain.facts.get(key), value);
    if (conflicts.size) {
      const error = new ExecutionError("PROVIDER_RESULT_DISAGREEMENT");
      hardFailure(error); rememberFailure(error, { local: true, work: row, eligible: false });
      distrust([c, ...conflicts]); throw error;
    }
    // Only a completely qualified, drained row contributes facts. Original
    // context/reference identities and canonical history survive refresh/expiry.
    const entry = value => ({ value, c, reference, revision: reference.revision });
    for (const [number, value] of row.acceptedFacts.headers) {
      if (!domain.headers.has(number)) domain.headers.set(number, entry(value));
      if (!domain.byHash.has(value.hash)) domain.byHash.set(value.hash, entry(value));
    }
    for (const [key, value] of row.acceptedFacts.fixed) if (!domain.facts.has(key)) domain.facts.set(key, entry(value));
  }
  function eligibleFor(cause, record) {
    return !!(cause?.eligible && cause.record === record && cause.work === record?.work && cause.context === record?.work?.recoveryContext &&
      (cause.parts ? cause.parts.every(part => eligibleFor(part, record)) : cause.invocation?.prepublication && cause.invocation.issued));
  }
  function bindFailureIdentity(error, invocation) {
    // Identities, never messages or nested codes, bind a physical failure to its
    // original operation. Reusing an old/shared error cannot transfer authority.
    let current = error, reused = false;
    for (let depth = 0; current && typeof current === "object" && depth < 8; depth++) {
      const previous = recovery.origins.get(current), known = recovery.causes.get(current);
      if (previous && (previous.record !== invocation.record || previous.prepublication !== invocation.prepublication) ||
        known && !known.lifecycle && known.invocation && (known.record !== invocation.record || !known.invocation.prepublication)) reused = true;
      if (!previous) recovery.origins.set(current, invocation);
      const nested = Object.getOwnPropertyDescriptor(current, "cause");
      if (nested && !Object.hasOwn(nested, "value")) reused = true;
      current = nested && Object.hasOwn(nested, "value") ? nested.value : null;
    }
    if (current && typeof current === "object") reused = true;
    return reused;
  }
  function normalizedFailure(error, normalized, work) {
    const cause = recovery.causes.get(error);
    if (!cause) hardFailure(error);
    rememberFailure(normalized, cause && (!work || !cause.work || cause.work === work || cause.work.parent === work) ? cause : { raw: error, eligible: false });
  }
  function recoveryHooks(work) {
    return recovery ? { trackRequest: work.track, trackSemantic, onRequestFailure: (error, normalized) => normalizedFailure(error, normalized, work),
      onOperationFailure(error, failures) {
        if (failures.length && failures.every(failure => {
          const cause = recovery.causes.get(failure); return cause && (cause.lifecycle || cause.absence || cause.expected || cause.reverted || cause.hintUnavailable);
        })) rememberFailure(error, { lifecycle: true, owner: work, eligible: false });
      },
      onSelectionFailure(error, failures) {
        const causes = failures.map(failure => recovery.causes.get(failure));
        if (causes.length > 0 && causes.every(cause => cause?.lifecycle || cause?.cold)) {
          rememberFailure(error, { lifecycle: true, owner: work, eligible: false }); return;
        }
        const eligible = causes.length > 0 && causes.every(cause => eligibleFor(cause, work.record));
        if (!eligible && !work.provisional) hardFailure(error);
        rememberFailure(error, { eligible, parts: causes, record: work.record, work, context: work.recoveryContext });
      } } : {};
  }
  function trackBackground(promise) {
    if (recovery) {
      const done = promise.then(() => {}, () => {}).finally(() => recovery.background.delete(done));
      recovery.background.add(done);
    }
  }
  // Process-only identities. Injected transports must explicitly report their
  // underlying RPC/fetch and replace a frozen configuration token on mutation.
  // Neither context nor Origin values ever enter evidence, errors or hashes.
  function captureContext(snapshot) {
    try {
      const resolver = rpc === httpRpc ? require("../shared-rpc.js").getOrigin : resolveOrigin || (recovery || preferDual ? noOrigin : undefined);
      const value = getCapabilityContext ? getCapabilityContext() :
        { rpc, fetch: globalThis.fetch, configuration: HTTP_CAPABILITY_CONFIGURATION, inventoryRevision: 0 };
      const names = ["rpc", "fetch", "configuration", "inventoryRevision"], fields = Object.getOwnPropertyDescriptors(value);
      requireThat(Reflect.ownKeys(value).length === names.length && names.every(key => fields[key] && Object.hasOwn(fields[key], "value")), "M1_CAPABILITY_CONTEXT_INVALID");
      const context = Object.fromEntries(names.map(key => [key, fields[key].value]));
      requireThat(typeof context.rpc === "function" && (context.fetch === null || typeof context.fetch === "function") &&
        context.configuration && typeof context.configuration === "object" && Object.isFrozen(context.configuration) &&
        (typeof context.inventoryRevision === "string" || Number.isSafeInteger(context.inventoryRevision) || typeof context.inventoryRevision === "symbol"), "M1_CAPABILITY_CONTEXT_INVALID");
      const origins = snapshot.map(c => {
        const origin = resolver(c.handle);
        requireThat(origin === null || typeof origin === "string", "M1_CAPABILITY_CONTEXT_INVALID"); return origin;
      });
      return { ...context, resolver, origins, defaultFetch: rpc === httpRpc ? globalThis.fetch : null, inventoryRevisionLocal: inventoryRevision };
    } catch (_) { const error = new ExecutionError("M1_CAPABILITY_CONTEXT_INVALID"); hardFailure(error); throw error; }
  }
  function sameContext(a, b) {
    return ["rpc", "fetch", "configuration", "inventoryRevision", "resolver", "defaultFetch", "inventoryRevisionLocal"].every(key => a[key] === b[key]) &&
      a.origins.length === b.origins.length && a.origins.every((origin, i) => origin === b.origins[i]);
  }
  function revokeCertificate(cert, code = "M1_CAPABILITY_INVALIDATED", ordinary = false) {
    if (!cert.valid) return;
    cert.valid = false; cert.reason = code;
    cert.failure = ordinary && recovery ? lifecycle(code, cert) : new ExecutionError(code);
    clearTimeout(cert.timer); certificates.delete(cert);
    for (const stop of cert.dependents) stop(cert.failure); cert.dependents.clear();
    if (selection?.certificate === cert) selection = null;
  }
  function assertContext(context, snapshot, input) {
    try {
      requireThat(samePairInventory(snapshot, inventory) && samePairInventory(snapshot, inputInventory(input)) &&
        sameContext(context, captureContext(snapshot)), "M1_CAPABILITY_CONTEXT_CHANGED");
    } catch (error) {
      hardFailure(error);
      invalidateProofs(); throw new ExecutionError(error?.code === "M1_CAPABILITY_CONTEXT_INVALID" ? error.code : "M1_CAPABILITY_CONTEXT_CHANGED");
    }
  }
  function assertCertificate(cert) {
    if (!cert?.valid) throw cert?.failure || new ExecutionError("M1_CAPABILITY_INVALIDATED");
    clock();
    assertContext(cert.context, cert.inventory, cert.input);
    const time = clock();
    if (!cert.references.every(({ item, revision }) => item?.valid && item.revision === revision)) revokeCertificate(cert);
    if (Math.abs((time.wall - cert.started.wall) - (time.mono - cert.started.mono)) > 1000) {
      invalidateProofs(); throw new ExecutionError("M1_HOT_PATH_CLOCK_INVALID");
    }
    if (time.mono - cert.started.mono >= TTL || time.wall - cert.started.wall >= TTL) revokeCertificate(cert, "M1_CAPABILITY_EXPIRED", true);
    if (!cert.valid) throw cert.failure; return time;
  }
  function bindCapabilityWork(work, context, snapshot, assertion) {
    work.assertContext = assertion;
    work.assertPhysical = (candidate, physical) => {
      const index = snapshot.findIndex(c => c.handle === candidate.handle);
      requireThat(index >= 0 && physical.handle === candidate.handle && physical.origin === context.origins[index] &&
        physical.fetch === (rpc === httpRpc ? context.defaultFetch : context.fetch) &&
        (rpc !== httpRpc || physical.resolver === context.resolver), "M1_CAPABILITY_CONTEXT_CHANGED");
    };
  }
  function flushTimings() {
    // Delivery is deliberately restricted to entry boundaries (before fresh
    // checks) and closed/drained termination, never proof publication or a
    // background completion that could interrupt the caller's execution window.
    for (const event of timingRecords.splice(0)) {
      try { Promise.resolve(onTiming(event)).catch(() => {}); } catch (_) {}
    }
  }
  const freezeEvidence = value => {
    if (value && typeof value === "object") { Object.values(value).forEach(freezeEvidence); Object.freeze(value); }
    return value;
  };
  function timing(phase) {
    let start;
    const emit = edge => {
      try {
        const atMonoMs = monotonic(), atWallMs = now();
        if (!Number.isFinite(atMonoMs) || !Number.isSafeInteger(atWallMs)) return;
        if (edge === "start") start = atMonoMs;
        const event = { phase, edge, atMonoMs, atWallMs, ...(edge === "end" ? { durationMs: Math.max(0, atMonoMs - start) } : {}) };
        if (onTiming) {
          if (timingRecords.length === 128) timingRecords.shift();
          timingRecords.push(Object.freeze(event));
        }
      } catch (_) {} // Observers never authorize, reject, or delay work.
    };
    emit("start"); let ended = false;
    return () => { if (!ended) { ended = true; emit("end"); } };
  }
  function invalidate() { selection = null; epoch++; refresh?.stop(); optional?.cancel(); hints?.stop(); latestLeaseCancel?.(); }
  function invalidateProofs() {
    for (const cert of certificates) revokeCertificate(cert);
    for (const item of trust.values()) item.valid = false;
    invalidate(); trust = new Map((inventory || []).map(c => [c.handle, { valid: true, revision: 0 }]));
  }
  function clock() {
    try {
      const mono = monotonic(), wall = now();
      requireThat(Number.isFinite(mono) && mono >= 0 && Number.isSafeInteger(wall) && wall >= 0 &&
        (!lastClock || mono >= lastClock.mono && wall >= lastClock.wall && Math.abs((wall - lastClock.wall) - (mono - lastClock.mono)) <= 1000), "M1_HOT_PATH_CLOCK_INVALID");
      lastClock = { mono, wall }; return lastClock;
    } catch (_) { const error = new ExecutionError("M1_HOT_PATH_CLOCK_INVALID"); hardFailure(error); lastClock = null; invalidateProofs(); throw error; }
  }
  function inputInventory(input) {
    try {
      const field = input && Object.getOwnPropertyDescriptor(input, "candidates");
      requireThat(input && Reflect.ownKeys(input).length === 1 && field && Object.hasOwn(field, "value"), "M1_HOT_PATH_OPTIONS_INVALID");
      return snapshotPairCandidates(field.value);
    } catch (error) { hardFailure(error); invalidateProofs(); throw error instanceof ExecutionError ? error : new ExecutionError("RPC_CANDIDATES_INVALID"); }
  }
  function syncInventory(input) {
    const next = inputInventory(input);
    if (!inventory || !samePairInventory(inventory, next)) {
      invalidateProofs(); inventoryRevision++; inventory = next; trust = new Map(next.map(c => [c.handle, { valid: true, revision: 0 }]));
    }
    return next;
  }
  const includes = (pair, c) => pair?.some(p => p.handle === c.handle && p.family === c.family);
  function distrust(pair, poisonProofs = true) {
    if (recovery && pair.some(c => acceptedCandidate(c))) hardFailure(new ExecutionError("PIN_EVIDENCE_INVALIDATED"));
    if (poisonProofs) for (const c of pair) { const item = trust.get(c.handle); if (item) item.revision++; }
    if (poisonProofs) for (const cert of certificates) if (pair.some(c => includes(cert.pair, c))) revokeCertificate(cert);
    invalidate();
  }
  function bindRecoveryWork(work, snapshot, input, anchor = null, compareHeads = true) {
    if (!recovery && !work.selectionHint) return;
    const context = captureContext(snapshot), started = clock(), facts = new Map(), headers = new Map(), byHash = new Map(), latest = new Map(), accounts = new Map(), fixed = new Map();
    work.acceptedFacts = { headers, fixed };
    work.recoveryContext = context;
    work.references = snapshot.map(c => ({ c, item: trust.get(c.handle), revision: trust.get(c.handle)?.revision }));
    work.remoteFault = (candidate, error) => {
      if (ownedLifecycle(error) || hintSoftErrors.has(error)) return;
      const reference = work.references.find(row => row.c.handle === candidate.handle)?.item;
      if (recovery && REMOTE_RESPONSE_FAILURES.has(error) && work.provisional && !acceptedCandidate(candidate, reference)) {
        work.rejection ||= error;
        rememberFailure(error, { cold: true, work, eligible: false });
      } else {
        hardFailure(error); work.onHintHard?.(error);
        if (recovery && acceptedCandidate(candidate, reference)) distrust([candidate]);
        rememberFailure(error, { work, eligible: false, remote: REMOTE_RESPONSE_FAILURES.has(error), local: !REMOTE_RESPONSE_FAILURES.has(error) });
      }
    };
    work.localFault = (candidate, error) => {
      hardFailure(error); work.onHintHard?.(error);
      if (recovery && acceptedCandidate(candidate, work.references.find(row => row.c.handle === candidate.handle)?.item)) distrust([candidate]);
      rememberFailure(error, { local: true, work, eligible: false });
    };
    if (anchor) { headers.set(anchor.number, structuredClone(anchor)); byHash.set(anchor.hash, structuredClone(anchor)); }
    work.recoveryCheck = (withinBudget = false) => {
      try {
        // Do not consult closed/epoch/certificate.valid here: disposal must not
        // hide changed credentials/configuration, clocks or already observed facts.
        requireThat(samePairInventory(snapshot, inventory) && samePairInventory(snapshot, inputInventory(input)) &&
          sameContext(context, captureContext(snapshot)), "M1_CAPABILITY_CONTEXT_CHANGED");
        const time = clock();
        requireThat(Math.abs((time.wall - started.wall) - (time.mono - started.mono)) <= 1000, "M1_HOT_PATH_CLOCK_INVALID");
        if (withinBudget && work.selectionHint && time.mono >= work.deadline) throw hintWindow();
        if (withinBudget && recovery && time.mono >= work.deadline) throw lifecycle("M1_HOT_PATH_BUDGET", work);
        if (withinBudget) requireThat(time.mono < work.deadline, "M1_HOT_PATH_BUDGET");
      } catch (error) { if (!hintSoftErrors.has(error) && !ownedLifecycle(error)) { hardFailure(error); work.onHintHard?.(error); } throw error; }
    };
    bindCapabilityWork(work, context, snapshot, work.recoveryCheck);
    work.recoveryInspect = (candidate, method, params, raw) => {
      // Captured normalized facts survive a timeout, cancellation and epoch changes.
      // Comparing at this boundary also catches two individually valid but unequal
      // responses when the normal Promise.all/race consumer never sees both.
      const validationStart = responseValidationOrder;
      try {
        let value = raw, key = JSON.stringify([method, params]);
        if (method === "eth_chainId") responseRequire(responseUint(raw, "WRONG_CHAIN") === 1n, "WRONG_CHAIN");
        else if (method === "eth_getBlockByNumber") {
          // Inspect shape and canonical contradictions even after a hint window.
          value = header(raw, recovery || work.selectionHint ? Number(responseUint(raw?.timestamp)) * 1000 : now(), false, allowFuture || work.selectionHint, responseRequire, responseUint);
          if (params[0] !== "latest") responseRequire(value.number === Number(BigInt(params[0])), "PIN_HASH_DISAGREEMENT");
          const previous = headers.get(value.number);
          responseRequire(!previous || same(previous, value), "PIN_CHANGED");
          const child = headers.get(value.number + 1), parent = headers.get(value.number - 1);
          responseRequire((!child || child.parentHash === value.hash && child.timestamp > value.timestamp) &&
            (!parent || parent.hash === value.parentHash && parent.timestamp < value.timestamp), "PIN_HASH_DISAGREEMENT");
          if (params[0] === "latest" && compareHeads) {
            latest.set(candidate.handle, value.number);
            responseRequire(Math.max(...latest.values()) - Math.min(...latest.values()) <= 4, "PROVIDER_HEAD_GAP");
          }
          headers.set(value.number, structuredClone(value)); byHash.set(value.hash, structuredClone(value));
          key = JSON.stringify([method, value.number]);
          if (recovery || work.selectionHint) {
            responseRequire(now() >= value.timestamp * 1000, "PIN_STALE_OR_FUTURE");
            if (now() - value.timestamp * 1000 > MAX_AGE_MS) throw work.selectionHint ? hintWindow("PIN_STALE_OR_FUTURE") : lifecycle("PIN_STALE_OR_FUTURE", work);
          }
        } else if (method === "eth_getCode") {
          responseRequire(!strictUnknownProbe(method, params), "CODE_UNKNOWN_HASH_NOT_REJECTED");
          value = normalizeCode(raw, responseRequire);
          if (params[0] === MULTICALL3) { responseRequire(value !== "0x", "PIN_CODE_CAPABILITY_FAILED"); key = "MULTICALL3_CODE"; }
        } else if (method === "eth_call") {
          responseRequire(!strictUnknownProbe(method, params), "CALL_UNKNOWN_HASH_NOT_REJECTED");
          responseRequire(validRpcResult(method, raw), "PIN_CALL_CAPABILITY_FAILED"); value = raw.toLowerCase();
          if (params[0]?.to === MULTICALL3 && params[0]?.data === PROBE.encodeFunctionData("getBlockNumber")) {
            const expected = byHash.get(params[1]?.blockHash);
            responseRequire(expected && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) === BigInt(expected.number), "PIN_CALL_CAPABILITY_FAILED");
          }
        } else if (method === "eth_simulateV1") {
          requireThat(params[1].blockHash !== SIMULATION_UNKNOWN_HASH, "NEXT_BLOCK_UNKNOWN_HASH_NOT_REJECTED");
          const pin = byHash.get(params[1].blockHash), block = params[0].blockStateCalls[0], tx = block.calls[0];
          requireThat(pin, "NEXT_BLOCK_CONTEXT_INVALID");
          const timestamp = Number(BigInt(block.blockOverrides.time)), context = { ...createNextBlockContext(pin), timestamp, seconds: timestamp - pin.timestamp };
          try { value = normalizeNextBlockResult(raw, context, tx); }
          catch (error) {
            if (work.selectionHint && error instanceof ExecutionError && error.code === "NEXT_BLOCK_REVERTED") throw hintWindow(error.code);
            throw error;
          }
          if (tx.to === null) requireThat(value.returnData === "0x" + BigInt(context.number).toString(16).padStart(64, "0") +
            BigInt(context.timestamp).toString(16).padStart(64, "0"), "NEXT_BLOCK_OVERRIDES_IGNORED");
        } else if (method === "debug_traceCall") {
          requireThat(params[1].blockHash !== TRACE_UNKNOWN_HASH, "TRACE_UNKNOWN_HASH_NOT_REJECTED");
          value = normalizeCallTrace(raw);
          const tx = params[0], tree = value.tree;
          requireThat(tree.type === "CALL" && tree.from === tx.from.toLowerCase() && tree.to === tx.to.toLowerCase() &&
            tree.input === tx.data.toLowerCase() && tree.value === BigInt(tx.value).toString(), "TRACE_TRANSACTION_MISMATCH");
          if (tx.to === MULTICALL3) {
            const expected = byHash.get(params[1].blockHash);
            requireThat(expected && !tree.reverted && tree.output === PROBE.encodeFunctionResult("getBlockNumber", [expected.number]), "PIN_TRACE_CAPABILITY_FAILED");
          }
        } else {
          requireThat(validRpcResult(method, raw), "RPC_FAILED");
          if (method === "eth_getTransactionReceipt") value = normalizeReceipt(raw, params[0]);
          if (["eth_getTransactionCount", "eth_getBalance", "eth_estimateGas"].includes(method)) value = uint(raw).toString();
          if (anchor && ["eth_getTransactionCount", "eth_getBalance"].includes(method)) {
            const account = accounts.get(candidate.handle) || {}; accounts.set(candidate.handle, account);
            account[method] = value;
            if (account.eth_getTransactionCount !== undefined && account.eth_getBalance !== undefined)
              buildNextBlockProbeTransaction(anchor, account.eth_getTransactionCount, account.eth_getBalance);
          }
        }
        // These two public polling reads are volatile, not lifetime pin facts.
        // equal() still compares both witnesses for each individual invocation;
        // physical shape/context checks above remain active after publication.
        if (method !== "eth_getTransactionReceipt" && !(method === "eth_getTransactionCount" && params[1] === "pending")) {
          responseRequire(!facts.has(key) || same(facts.get(key), value), "PROVIDER_RESULT_DISAGREEMENT");
          facts.set(key, structuredClone(value));
          if (["eth_getCode", "eth_call"].includes(method) && canonicalHashRef(params[1]))
            fixed.set(JSON.stringify([method, params]), structuredClone(value));
        }
      } catch (error) {
        if (RESPONSE_VALIDATION_ORDER.get(error) > validationStart ||
          ownedLifecycle(error) && recovery.causes.get(error).owner === work || hintSoftErrors.has(error)) work.remoteFault(candidate, error);
        else work.localFault(candidate, error);
        throw error;
      }
    };
  }
  function stoppedWork(item) {
    if (!closed && item.accepting) return;
    if (recovery && item.stopFailure) throw item.stopFailure;
    const error = new ExecutionError("M1_HOT_PATH_CANCELLED");
    if (recovery?.retiring && item.retirement === recovery.retiring) rememberFailure(error, { lifecycle: true, cleanup: recovery.retiring, eligible: false });
    else hardFailure(error);
    throw error;
  }
  function job(budget = BUDGET, selectionHint = false) {
    const start = clock(), item = { accepting: true, selectionHint, currentTrace: selectionHint,
      deadline: start.mono + budget, stop(reason) {
        item.accepting = false;
        if (recovery && (!item.stopFailure || ownedLifecycle(item.stopFailure) && reason && !ownedLifecycle(reason)))
          item.stopFailure = reason || lifecycle("M1_HOT_PATH_CANCELLED", item);
        for (const row of item.rows?.values() || []) row.stop(item.stopFailure);
      } };
    const inspectAtPhysical = !!recovery || selectionHint;
    const active = new Set();
    if (recovery) recovery.works.add(item);
    item.drain = async () => { while (active.size) await Promise.all([...active]); };
    item.track = promise => {
      const done = promise.then(() => {}, () => {}).finally(() => { pending.delete(done); active.delete(done); });
      pending.add(done); active.add(done); return promise;
    };
    item.request = async (candidate, method, params, timeoutMs = REQUEST_TIMEOUT_MS, assertDispatch, inspectResponse, inspectFailure) => {
      const invocation = { record: item.record, work: item, context: item.recoveryContext, prepublication: !!item.authority && !item.record?.published,
        issued: false, local: new WeakSet() };
      const time = clock();
      if (!recovery?.retiring || item.retirement !== recovery.retiring) item.assertContext?.();
      if (inspectAtPhysical) { item.recoveryCheck?.(true); stoppedWork(item); }
      else requireThat(!closed && item.accepting, "M1_HOT_PATH_CANCELLED");
      if (method === "eth_sendRawTransaction") { requireThat(typeof assertDispatch === "function", "PIN_EVIDENCE_INVALIDATED"); assertDispatch(); }
      const remaining = Math.floor(item.deadline - time.mono);
      if (remaining <= 0 && (recovery || selectionHint)) throw selectionHint ? hintWindow() : lifecycle("M1_HOT_PATH_BUDGET", item);
      requireThat(remaining > 0, "M1_HOT_PATH_BUDGET");
      const timeout = Math.min(boundedTimeout(timeoutMs), remaining);
      const dispatchGuard = method === "eth_sendRawTransaction" || item.assertContext ? physical => {
        try {
        clock(); if (!recovery?.retiring || item.retirement !== recovery.retiring) item.assertContext?.();
        if (physical && item.assertPhysical) {
          try { item.assertPhysical(candidate, physical); } catch (_) { invalidateProofs(); throw new ExecutionError("M1_CAPABILITY_CONTEXT_CHANGED"); }
        }
        if (inspectAtPhysical) { item.recoveryCheck?.(true); stoppedWork(item); }
        else requireThat(!closed && item.accepting, "M1_HOT_PATH_CANCELLED");
        if (method === "eth_sendRawTransaction") assertDispatch();
        const dispatchTime = clock();
        if (dispatchTime.mono >= item.deadline && (recovery || selectionHint)) throw selectionHint ? hintWindow() : lifecycle("M1_HOT_PATH_BUDGET", item);
        requireThat(dispatchTime.mono < item.deadline, "M1_HOT_PATH_BUDGET");
        } catch (error) {
          if (!recovery) throw error;
          // A shared stop/certificate cause is not itself invocation authority.
          // Mint the exact outward guard failure here, before any normalization.
          const failure = safeRecoveryError(error), cause = recovery.causes.get(error);
          if (!cause && !hintSoftErrors.has(error)) hardFailure(error);
          if (hintSoftErrors.has(error)) hintSoftErrors.add(failure);
          rememberFailure(failure, { ...cause, local: true, invocation, work: item, eligible: false });
          invocation.local.add(failure); throw failure;
        }
      } : undefined;
      if (item.assertContext) CAPABILITY_DISPATCH_GUARDS.add(dispatchGuard);
      if (item.currentTrace && method === "debug_traceCall") CURRENT_TRACE_DISPATCH_GUARDS.add(dispatchGuard);
      let timer, issued = false, httpInspected = false;
      const inspectPhysicalValue = value => {
        try { item.recoveryInspect?.(candidate, method, params, value); inspectResponse?.(value); item.inspectResponse?.(candidate, method, params, value); }
        catch (error) { invocation.local.add(error); if (!recovery?.causes.has(error)) item.localFault?.(candidate, error); throw error; }
        finally { item.recoveryCheck?.(); }
        return value;
      };
      const physicalFailure = error => {
        const existing = recovery?.causes.get(error);
        if (existing && (existing.invocation === invocation || invocation.local.has(error))) return error;
        const expected = error instanceof ExecutionError && error.code === "UNKNOWN_BLOCK_REJECTED" &&
          (strictUnknownProbe(method, params) || ["eth_simulateV1", "debug_traceCall"].includes(method) && params[1]?.blockHash === TRACE_UNKNOWN_HASH);
        const absence = issued && error instanceof ExecutionError && ["RPC_TIMEOUT", "RPC_TRANSPORT_ERROR", "RPC_HTTP_RETRYABLE"].includes(error.code);
        const unavailable = issued && (selectionHint || item.currentTrace || item.optional) && hintUnavailable(error, method) || hintSoftErrors.has(error);
        const reverted = error instanceof ExecutionError && error.code === "CALL_REVERTED" && ["eth_call", "eth_estimateGas"].includes(method) &&
          !(params[0]?.to === MULTICALL3 && params[0]?.data === PROBE.encodeFunctionData("getBlockNumber"));
        if (!recovery) { if (!absence && !expected && !unavailable && !reverted) item.onHintHard?.(error); return error; }
        const reused = bindFailureIdentity(error, invocation), failure = safeRecoveryError(error);
        if (!existing && issued && (REMOTE_RESPONSE_FAILURES.has(error) || item.recoveryContext?.rpc !== httpRpc && error instanceof ExecutionError))
          REMOTE_RESPONSE_FAILURES.add(failure);
        if (!absence && !expected && !unavailable && !reverted) item.remoteFault?.(candidate, failure);
        const cold = recovery.causes.get(failure)?.cold;
        rememberFailure(failure, { raw: error, invocation, record: item.record, work: item, context: item.recoveryContext,
          eligible: absence && invocation.prepublication && !reused, absence, expected, hintUnavailable: unavailable, reverted, cold });
        return failure;
      };
      if (inspectAtPhysical) RECOVERY_HTTP_OBSERVERS.set(dispatchGuard, { issued() { issued = invocation.issued = true; },
        inspect(value) { httpInspected = true; return inspectPhysicalValue(value); },
        failure(error, normalized) {
          if (recovery) {
             if (invocation.local.has(error)) { normalizedFailure(error, normalized); invocation.local.add(normalized); }
             else if (REMOTE_RESPONSE_FAILURES.has(error)) { const reused = bindFailureIdentity(error, invocation); if (reused) invocation.foreign = true; }
             else {
               hardFailure(error); invocation.local.add(normalized);
               rememberFailure(normalized, { local: true, invocation, work: item, eligible: false });
             }
          }
          if (selectionHint && hintSoftErrors.has(error)) {
            hintSoftErrors.add(normalized); rememberFailure(normalized, { hintUnavailable: true, eligible: false });
          }
          if (REMOTE_RESPONSE_FAILURES.has(error)) REMOTE_RESPONSE_FAILURES.add(normalized);
        }, localFailure(error) { invocation.local.add(error); hardFailure(error); rememberFailure(error, { local: true, work: item, eligible: false }); }
      });
      const physical = Promise.resolve().then(() => {
        if (dispatchGuard) dispatchGuard();
        else if (inspectAtPhysical) { item.recoveryCheck?.(true); stoppedWork(item); }
        else requireThat(!closed && item.accepting, "M1_HOT_PATH_CANCELLED");
        if (method === "eth_sendRawTransaction") assertDispatch();
        const requestParams = structuredClone(params);
        if (rpc !== httpRpc && item.recoveryContext?.rpc !== httpRpc) issued = invocation.issued = true;
        return dispatchGuard ? rpc(candidate, method, requestParams, timeout, dispatchGuard) : rpc(candidate, method, requestParams, timeout);
      });
      // Opt-in traces drain the actual transport even if its timeout wins. A
      // late observed contradiction, including a rejected malformed response, is
      // inspected before terminal rejection and before sibling drain completes.
      const inspected = inspectAtPhysical ? physical.then(value => {
        return httpInspected ? value : inspectPhysicalValue(value);
      }, error => {
        error = physicalFailure(error);
        if (invocation.foreign && recovery?.causes.has(error)) recovery.causes.get(error).eligible = false;
        item.recoveryCheck?.();
        const failure = inspectFailure ? inspectFailure(error) : error;
        if (failure !== error && recovery) normalizedFailure(error, failure);
        throw failure;
      }) : item.currentTrace ? physical.then(value => { inspectResponse?.(value); return value; },
        error => { throw inspectFailure ? inspectFailure(error) : error; }) : physical;
      if (item.currentTrace || inspectAtPhysical) {
        const done = inspected.then(() => {}, () => {}).finally(() => { pending.delete(done); active.delete(done); });
        pending.add(done); active.add(done);
      }
      const call = Promise.race([inspected,
        new Promise((_, reject) => { timer = setTimeout(() => {
          const error = timeout === remaining ? selectionHint ? hintWindow() : recovery ? lifecycle("M1_HOT_PATH_BUDGET", item) : new ExecutionError("M1_HOT_PATH_BUDGET") : new ExecutionError("RPC_TIMEOUT");
          if (recovery && !hintSoftErrors.has(error) && !ownedLifecycle(error)) {
            rememberFailure(error, { raw: error, eligible: issued && invocation.prepublication, absence: issued, invocation,
              record: item.record, work: item, context: item.recoveryContext }); if (!issued) hardFailure(error);
          }
          reject(error);
        }, timeout); })]);
      const settled = call.then(() => {}, () => {}).finally(() => { clearTimeout(timer); pending.delete(settled); active.delete(settled); });
      pending.add(settled); active.add(settled);
      try {
        const value = await call;
        // Inspect known contradictions before expiry/cancellation can mask them.
        if (!inspectAtPhysical) item.inspectResponse?.(candidate, method, params, value);
        if (!recovery?.retiring || item.retirement !== recovery.retiring) item.assertContext?.();
        if (inspectAtPhysical) stoppedWork(item); else requireThat(!closed && item.accepting, "M1_HOT_PATH_CANCELLED");
        const accepted = clock();
        if (item.assertContext && accepted.mono >= item.deadline && (recovery || selectionHint)) throw selectionHint ? hintWindow() : lifecycle("M1_HOT_PATH_BUDGET", item);
        if (item.assertContext) requireThat(accepted.mono < item.deadline, "M1_HOT_PATH_BUDGET");
        return value;
      } catch (error) {
        if (error instanceof ExecutionError && ["RPC_FAILED", "RPC_RESPONSE_TOO_LARGE"].includes(error.code)) item.onUntrustedResponse?.(candidate, method, error);
        // Error responses (including successful negative controls) are accepted
        // only under the same live certificate/context as successful responses.
        if (item.assertContext && (!recovery?.retiring || item.retirement !== recovery.retiring)) {
          try { item.assertContext(); }
          catch (contextError) { if (!trustFailure(error) || error?.code === "UNKNOWN_BLOCK_REJECTED") throw contextError; }
        }
        if (item.strictErrors && !(error instanceof ExecutionError)) throw new ExecutionError("NEXT_BLOCK_TRUST_FAILED");
        throw error instanceof ExecutionError ? error : new ExecutionError("PINNED_RPC_FAILED");
      }
    };
    if (inspectAtPhysical) {
      const invoke = item.request;
      item.request = (...args) => item.track(invoke(...args).catch(error => {
        if (recovery && !recovery.causes.has(error)) hardFailure(error);
        throw error;
      }));
    }
    return item;
  }
  function ready(time) {
    if (reuseCapability && selection) { try { assertCertificate(selection.certificate); } catch (_) { return false; } }
    if (selection && (time.mono - selection.started.mono >= TTL || time.wall - selection.started.wall >= TTL)) selection = null;
    return selection !== null;
  }
  function publishSelection(aliases, rows, snapshot, input, context, references, started, completed) {
    const chosen = { pair: Object.freeze(aliases.map(alias => snapshot[alias - 1])), aliases, started };
    if (reuseCapability) {
      const cert = { valid: true, context, input, inventory: snapshot, pair: chosen.pair,
        started, completed, suite: CAPABILITY_SUITE, revision: ++certificateRevision,
        rows: freezeEvidence(structuredClone(rows)), dependents: new Set(),
        references: references || chosen.pair.map(c => ({ item: trust.get(c.handle), revision: trust.get(c.handle)?.revision })) };
      certificates.add(cert); chosen.certificate = cert;
      cert.timer = setTimeout(() => revokeCertificate(cert, "M1_CAPABILITY_EXPIRED", true),
        Math.max(0, Math.min(TTL - (completed.mono - started.mono), TTL - (completed.wall - started.wall)))); cert.timer.unref?.();
    }
    selection = chosen; return chosen;
  }
  function startSelectionHints(result, fallback, snapshot, input, context, originalReferences, token) {
    const pool = freezeEvidence(structuredClone(result.strictPool));
    const references = pool.map(row => originalReferences[row.alias - 1]);
    const work = job(BUDGET, true), started = clock();
    work.deadline = Math.min(work.deadline, fallback.started.mono + TTL,
      started.mono + TTL - (started.wall - fallback.started.wall));
    bindRecoveryWork(work, snapshot, input, null, false);
    const observed = new Map(); let next = 0, complete = true, hard = false;
    const validReferences = () => references.every(({ item, revision }) => item?.valid && item.revision === revision);
    work.onHintHard = error => {
      hardFailure(error);
      if (!hard) { hard = true; distrust(pool.map(row => snapshot[row.alias - 1])); }
    };
    const check = () => {
      work.recoveryCheck(); assertContext(context, snapshot, input);
      if (!validReferences()) { const error = new ExecutionError("M1_CAPABILITY_INVALIDATED"); work.onHintHard(error); throw error; }
      if (closed || !work.accepting || epoch !== token) stoppedWork(work);
      const time = clock();
      if (time.mono >= work.deadline || time.wall - fallback.started.wall >= TTL) throw hintWindow();
    };
    const send = async (c, method, params, inspect) => {
      check(); return work.request(c, method, params, undefined, undefined, inspect);
    };
    const freshHeader = async c => {
      const h = header(await send(c, "eth_getBlockByNumber", ["latest", false]), now(), false, true);
      await send(c, "eth_getBlockByNumber", [tag(h.number), false], raw => {
        requireThat(same(header(raw, now(), false, true), h), "PIN_CHANGED");
      });
      return h;
    };
    const outcome = async run => {
      try { await run(); check(); return true; }
      catch (error) {
        if (hintSoftErrors.has(error)) { if (error.code === "M1_HOT_PATH_BUDGET") complete = false; }
        else if (!hintUnavailable(error, "debug_traceCall") && !hintUnavailable(error, "eth_simulateV1") &&
          !ownedLifecycle(error) && !recovery?.causes.get(error)?.cleanup) work.onHintHard(error);
        return false;
      }
    };
    hints = work;
    work.promise = Promise.resolve().then(async () => {
      await Promise.all(Array.from({ length: Math.min(2, pool.length) }, async () => {
        while (next < pool.length) {
          try { check(); } catch (error) { complete = false; if (!hintSoftErrors.has(error) && !ownedLifecycle(error) && !recovery?.causes.get(error)?.cleanup) work.onHintHard(error); return; }
          const row = pool[next++], c = snapshot[row.alias - 1], hint = { trace: false, future: false };
          // Independent attempts: absent trace support must not suppress FUTURE.
          hint.trace = await outcome(async () => {
            const h = await freshHeader(c);
            // The existing trace primitive reads headers in the strict row shape.
            const { gasLimit, ...tracePin } = h;
            await result.hintTrace(c, tracePin, send);
          });
          hint.future = await outcome(async () => {
            const h = await freshHeader(c);
            const request = async (...args) => {
              check();
              if (now() >= (h.timestamp + 12) * 1000) throw hintWindow("NEXT_BLOCK_DEADLINE");
              const value = await send(...args);
              if (now() >= (h.timestamp + 12) * 1000) throw hintWindow("NEXT_BLOCK_DEADLINE");
              return value;
            };
            // Serial mode retains the exact physical failure identity. The job
            // already observes/drains each physical and semantic completion.
            try { await qualifyNextBlockProvider({ provider: c, pin: h, request }); }
            catch (error) {
              if (error instanceof ExecutionError && error.code === "NEXT_BLOCK_PROBE_UNFUNDED" && !recovery?.causes.has(error))
                throw hintWindow("NEXT_BLOCK_PROBE_UNFUNDED");
              throw error;
            }
            await send(c, "eth_getBlockByNumber", [tag(h.number), false], raw => {
              requireThat(same(header(raw, now(), false, true), h), "NEXT_BLOCK_PARENT_CHANGED");
            });
          });
          observed.set(row.alias, hint);
        }
      }));
      // No partial publication, including when a raced timeout still has a late
      // physical response capable of revoking the original strict trust.
      await work.drain(); check();
      if (!complete || hard || observed.size !== pool.length || selection !== fallback) return;
      let best = null, score = 0;
      for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
        const a = pool[i], b = pool[j], x = observed.get(a.alias), y = observed.get(b.alias);
        if (snapshot[a.alias - 1].family === snapshot[b.alias - 1].family || !x.future || !y.future) continue;
        const rank = 1 + Number(x.trace) + Number(y.trace);
        if (rank > score) { best = [a, b]; score = rank; }
      }
      if (!best || same(best.map(row => row.alias), fallback.aliases)) return;
      // The old certificate remains valid for in-flight acquisitions/leases.
      // No epoch change, cancellation, cached optional proof, or refreshed TTL.
      publishSelection(best.map(row => row.alias), best.map(({ anchor, qualification }) => ({ anchor, qualification })),
        snapshot, input, context, best.map(row => originalReferences[row.alias - 1]), fallback.started, clock());
    }).catch(error => {
      if (!hintSoftErrors.has(error) && !ownedLifecycle(error) && !recovery?.causes.get(error)?.cleanup) work.onHintHard(error);
    }).finally(async () => { work.stop(); await work.drain(); if (hints === work) hints = null; });
    trackBackground(work.promise);
  }
  function maintain(input) {
    requireThat(!closed, "M1_HOT_PATH_CLOSED");
    flushTimings(); requireThat(!closed, "M1_HOT_PATH_CLOSED");
    const snapshot = syncInventory(input), started = clock(), usable = ready(started);
    if (!refresh && !hints && started.mono >= retryAt && (!usable || started.mono - selection.started.mono >= REFRESH_AT)) {
      const token = epoch, work = job(), endTiming = timing("poolQualification");
      if (recovery) { work.provisional = true; work.rows = new Map(); }
      bindRecoveryWork(work, snapshot, input, null, false);
      const context = reuseCapability || preferDual ? captureContext(snapshot) : null;
      const originalReferences = preferDual || recovery ? snapshot.map(c => ({ item: trust.get(c.handle), revision: trust.get(c.handle)?.revision })) : null;
      if (reuseCapability || preferDual) bindCapabilityWork(work, context, snapshot, () => {
        assertContext(context, snapshot, input);
        if (recovery && !work.accepting) stoppedWork(work);
        requireThat(epoch === token, "M1_CAPABILITY_INVALIDATED");
      });
      work.onUntrustedResponse = c => {
        const item = trust.get(c.handle); if (item) item.revision++;
        let affected = includes(selection?.pair, c);
        for (const cert of certificates) if (includes(cert.pair, c)) { affected = true; revokeCertificate(cert); }
        if (affected) invalidate();
      };
      if (recovery) {
        const rowFor = c => {
          if (!work.rows.has(c.handle)) {
            if (closed || !work.accepting) stoppedWork(work);
            const row = job(); row.deadline = work.deadline; row.parent = work; row.provisional = true;
            bindRecoveryWork(row, snapshot, input, null, false);
            row.assertContext = () => { row.recoveryCheck(); work.assertContext?.(); };
            work.rows.set(c.handle, row);
          }
          return work.rows.get(c.handle);
        };
        work.request = (c, ...args) => rowFor(c).request(c, ...args);
        work.onQualified = async c => {
          const row = rowFor(c), index = snapshot.findIndex(candidate => candidate.handle === c.handle);
          await row.drain(); row.recoveryCheck(); stoppedWork(work);
          const { item, revision } = originalReferences[index];
          requireThat(item?.valid && item === trust.get(c.handle) && item.revision === revision, "M1_CAPABILITY_INVALIDATED");
          if (row.rejection) throw row.rejection;
          acceptCandidate(c, item);
          reconcileCandidate(c, row, item);
        };
        work.onRejected = (c, error) => {
          const row = rowFor(c), cause = recovery.causes.get(error);
          if (!cause) row.remoteFault(c, error);
          else if (!cause.cold && !cause.absence && !cause.lifecycle && !cause.expected && !cause.hintUnavailable) row.remoteFault(c, error);
        };
      }
      retryAt = started.mono + RETRY_MS; refresh = work;
      work.promise = Promise.resolve().then(async () => {
        const result = await createPinnedSession({ candidates: snapshot, rpc: work.request, now, requireStrictEvidence: true }, {
          ...recoveryHooks(work),
          responseRequire: recovery ? responseRequire : undefined,
          onQualified: work.onQualified,
          concurrency: 2, selectionOnly: true, selectionHints: preferDual,
          onQualificationFailure(c, error) {
            if (recovery) { work.onRejected(c, error); return; }
            if (recovery && !recovery.causes.has(error)) hardFailure(error);
            if (trustFailure(error)) {
              work.onUntrustedResponse(c);
            }
          },
        });
        const finished = clock();
        if (recovery) { work.recoveryCheck(); stoppedWork(work); }
        work.assertContext?.();
        requireThat(!closed && work.accepting && epoch === token && samePairInventory(snapshot, inventory) &&
          samePairInventory(snapshot, inputInventory(input)) && finished.mono - started.mono < BUDGET && finished.wall - started.wall < BUDGET,
        "M1_HOT_PATH_REFRESH_INVALIDATED");
        // A routine replacement changes eligibility, never existing immutable proofs.
        if (preferDual) requireThat(result.strictPool.every(row => {
          const { item, revision } = originalReferences[row.alias - 1]; return item?.valid && item.revision === revision;
        }), "M1_CAPABILITY_INVALIDATED");
        const fallback = publishSelection(result.aliases, result.capabilities, snapshot, input, context,
          originalReferences && result.aliases.map(alias => originalReferences[alias - 1]), started, finished);
        if (preferDual) startSelectionHints(result, fallback, snapshot, input, context, originalReferences, token);
      }).catch(error => { if (recovery && !recovery.causes.has(error)) hardFailure(error); })
        .finally(() => { work.stop(); endTiming(); if (refresh === work) refresh = null; });
      trackBackground(work.promise);
    }
    return Object.freeze({ selection: ready(clock()) ? "READY" : "HOLD", refreshing: refresh !== null });
  }
  async function acquireOne(input, record) {
    if (recovery && closed) throw lifecycle("M1_HOT_PATH_CLOSED", record);
    requireThat(!closed, "M1_HOT_PATH_CLOSED");
    flushTimings(); requireThat(!closed, "M1_HOT_PATH_CLOSED");
    const snapshot = syncInventory(input), start = clock();
    if (!ready(start)) throw recovery ? lifecycle("M1_HOT_PATH_SELECTION_HOLD", record) : new ExecutionError("M1_HOT_PATH_SELECTION_HOLD");
    const chosen = selection, pair = chosen.pair, token = epoch;
    const certificate = chosen.certificate;
    const references = pair.map(c => ({ item: trust.get(c.handle), revision: trust.get(c.handle)?.revision }));
    const assertTrusted = () => {
      if (recovery && closed) throw lifecycle("PIN_EVIDENCE_INVALIDATED", record);
      if (reuseCapability) assertCertificate(certificate);
      if (!samePairInventory(snapshot, inputInventory(input))) invalidateProofs();
      requireThat(!closed && references.every(({ item, revision }) => item?.valid && item.revision === revision), "PIN_EVIDENCE_INVALIDATED");
      clock();
    };
    const work = job(), traceDeadline = work.deadline, endPair = timing("pairQualification");
    if (record) { work.record = record; work.authority = true; record.work = work; }
    bindRecoveryWork(work, snapshot, input);
    let endPin = () => {}, current, resolveCurrent, sendWithProof, optionalWork = null, openCurrentTrace, tracePromise;
    async function qualifyCurrentTrace(...args) {
      requireThat(args.length === 0, "TRACE_OPTIONS_INVALID");
      current.assertUsable();
      if (!tracePromise) {
        // No new lifetime, certificate, pin or pair. Injected fresh-mode callers
        // opting into traces must supply the same explicit context seam as v1.
        requireThat(reuseCapability || rpc === httpRpc || typeof resolveOrigin === "function" && typeof getCapabilityContext === "function", "M1_CAPABILITY_CONTEXT_REQUIRED");
        const context = reuseCapability ? certificate.context : captureContext(snapshot);
        const assertTraceLease = () => {
          current.assertUsable(); assertContext(context, snapshot, input);
          const time = clock();
          if (recovery && (time.mono - chosen.started.mono >= TTL || time.wall - chosen.started.wall >= TTL)) throw lifecycle("M1_CAPABILITY_EXPIRED", record);
          requireThat(time.mono - chosen.started.mono < TTL && time.wall - chosen.started.wall < TTL, "M1_CAPABILITY_EXPIRED");
          if (recovery && time.mono >= traceDeadline) throw lifecycle("M1_HOT_PATH_BUDGET", record);
          requireThat(time.mono < traceDeadline, "M1_HOT_PATH_BUDGET");
          requireThat(time.wall - current.pin.timestamp * 1000 >= 0 && time.wall - current.pin.timestamp * 1000 <= MAX_AGE_MS, "PIN_STALE_OR_FUTURE");
        };
        assertTraceLease();
        const traceWork = job(); traceWork.deadline = traceDeadline; traceWork.currentTrace = true;
        traceWork.record = record;
        bindRecoveryWork(traceWork, snapshot, input, current.pin);
        bindCapabilityWork(traceWork, context, snapshot, assertTraceLease);
        if (reuseCapability) certificate.dependents.add(traceWork.stop);
        traceWork.onUntrustedResponse = (c, method, error) => {
          if (method !== "debug_traceCall" || error.code !== "RPC_RESPONSE_TOO_LARGE") distrust([c]);
        };
        tracePromise = openCurrentTrace({
          request: (c, method, params, inspect, failed) => traceWork.request(c, method, params, undefined, undefined, inspect, failed),
          assertUsable: assertTraceLease, stop: traceWork.stop, drain: traceWork.drain,
        });
        acquisitions.add(tracePromise);
        tracePromise.then(() => acquisitions.delete(tracePromise), () => acquisitions.delete(tracePromise));
      }
      const facet = await tracePromise;
      facet.assertUsable(); return facet;
    }
    function sendWithAdditionalProof(signed, assertProof, assertAdditionalDispatch) {
      if (assertAdditionalDispatch === undefined) return sendWithProof(signed, assertProof);
      return sendWithProof(signed, () => {
        assertProof();
        try {
          requireThat(typeof assertAdditionalDispatch === "function", "PIN_EVIDENCE_INVALIDATED");
          const result = assertAdditionalDispatch();
          // Only synchronous, undefined-returning assertions may authorize a
          // send. Contain rejected promises without awaiting or sending bytes.
          if (result !== undefined) {
            Promise.resolve(result).catch(() => {});
            throw new ExecutionError("PIN_EVIDENCE_INVALIDATED");
          }
        } catch (_) { throw new ExecutionError("PIN_EVIDENCE_INVALIDATED"); }
        // The callback cannot weaken the original proof by consuming its clock,
        // cancelling the child or changing trust/configuration during dispatch.
        assertProof();
      });
    }
    if (reuseCapability) {
      bindCapabilityWork(work, certificate.context, certificate.inventory, assertTrusted); certificate.dependents.add(work.stop);
      const latest = new Map();
      work.inspectResponse = (c, method, params, value) => {
        try {
          if (method === "eth_chainId") requireThat(uint(value, "WRONG_CHAIN") === 1n, "WRONG_CHAIN");
          if (method === "eth_getCode") normalizeCode(value);
          const pin = work.pin;
          if (method === "eth_getBlockByNumber") {
            const observed = header(value, now(), false, allowFuture);
            if (pin) {
              if (params[0] === tag(pin.number) || observed.number === pin.number) requireThat(same(observed, pin), "PIN_CHANGED");
            } else if (params[0] === "latest") latest.set(c.handle, observed);
            else {
              requireThat(observed.number === Number(BigInt(params[0])), "PIN_HASH_DISAGREEMENT");
              const head = latest.get(c.handle);
              if (head?.number === observed.number) requireThat(same(head, observed), "PIN_HASH_DISAGREEMENT");
            }
          }
          if (pin && method === "eth_call" && params[0]?.to === MULTICALL3 && params[0]?.data === PROBE.encodeFunctionData("getBlockNumber"))
            requireThat(typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value) && BigInt(value) === BigInt(pin.number), "PIN_CALL_CAPABILITY_FAILED");
        } catch (error) { if (trustFailure(error)) distrust([c]); throw error; }
      };
    }
    work.onUntrustedResponse = c => distrust([c]);
    const currentReady = new Promise(resolve => { resolveCurrent = resolve; });
    if (record) record.resolveCurrent = resolveCurrent;
    const headers = new Map();
    let taken = false, subscriber = null, notified = false, notice = null, expiry = null;
    const clearReadiness = () => { subscriber = null; clearImmediate(notice); clearTimeout(expiry); notice = expiry = null; };
    const cancelFuture = reason => { taken = true; clearReadiness(); optionalWork?.cancel(ownedLifecycle(reason) ? reason : undefined); };
    if (reuseCapability) certificate.dependents.add(cancelFuture);
    const isFutureReady = () => {
      const future = optionalWork, facade = future?.ready;
      if (taken || !facade) return false;
      if (closed || !future.accepting || epoch !== token || now() >= facade.nextBlock.context.timestamp * 1000) { cancelFuture(); return false; }
      try { clock(); facade.assertUsable(); return true; } catch (_) { cancelFuture(); return false; }
    };
    const notifyReady = () => {
      if (notice || notified || !subscriber || taken) return;
      // Scheduling hint only, after publication and outside the proof's stack.
      // One bounded subscriber; returns/rejections never authorize or delay work.
      notice = setImmediate(() => {
        notice = null;
        if (!subscriber || notified || !isFutureReady()) return;
        const wake = subscriber; subscriber = null; notified = true;
        try { Promise.resolve(wake()).catch(() => {}); } catch (_) {}
      });
    };
    // A previous optional job is cancelled, but CURRENT never waits for its drain.
    latestLeaseCancel?.(); latestLeaseCancel = cancelFuture;
    optional?.cancel();
    function maybeFuture(c, h) {
      if (!allowFuture || chosen.futureUnavailable || optional || optionalWork) return;
      headers.set(c.handle, h); if (headers.size !== 2) return;
      const observed = pair.map(p => headers.get(p.handle));
      if (!same(observed[0], observed[1]) || now() >= (h.timestamp + 12) * 1000) return;
      const future = job(Math.max(1, (h.timestamp + 12) * 1000 - now())), endFuture = timing("futureQualification");
      future.record = record; future.optional = true;
      bindRecoveryWork(future, snapshot, input, h);
      future.strictErrors = true;
      if (reuseCapability) bindCapabilityWork(future, certificate.context, certificate.inventory, assertTrusted);
      if (reuseCapability) future.inspectResponse = (c, method, params, value) => {
        try {
          if (method === "eth_simulateV1") {
            requireThat(params[1].blockHash !== SIMULATION_UNKNOWN_HASH, "NEXT_BLOCK_UNKNOWN_HASH_NOT_REJECTED");
            const block = params[0].blockStateCalls[0], tx = block.calls[0], timestamp = Number(BigInt(block.blockOverrides.time));
            const context = { ...createNextBlockContext(h), timestamp, seconds: timestamp - h.timestamp };
            const result = normalizeNextBlockResult(value, context, tx);
            if (tx.to === null) requireThat(result.returnData === "0x" + BigInt(context.number).toString(16).padStart(64, "0") +
              BigInt(context.timestamp).toString(16).padStart(64, "0"), "NEXT_BLOCK_OVERRIDES_IGNORED");
          } else {
            if (method === "eth_chainId") requireThat(uint(value, "NEXT_BLOCK_WRONG_CHAIN") === 1n, "NEXT_BLOCK_WRONG_CHAIN");
            if (method === "eth_getTransactionCount") uint(value, "NEXT_BLOCK_TX_INVALID");
            if (method === "eth_getBalance") uint(value, "NEXT_BLOCK_PROBE_UNFUNDED");
            if (method === "eth_getBlockByNumber") {
              let observed;
              try { observed = header(value, now(), false, true); } catch (_) { throw new ExecutionError("NEXT_BLOCK_HEADER_INVALID"); }
              if (params[0] === tag(h.number) || observed.number === h.number) requireThat(same(observed, h), "NEXT_BLOCK_CANONICAL_DISAGREEMENT");
            }
          }
        } catch (error) {
          const priority = nextBlockFailurePriority(error); if (priority) distrust(pair, priority === 2); throw error;
        }
      };
      future.ready = null; future.cancelled = false;
      future.cancel = reason => { future.cancelled = true; future.stop(ownedLifecycle(reason) ? reason : undefined); future.ready = null; clearReadiness(); };
      optional = optionalWork = future;
      const request = async (...args) => {
        try { return await future.request(...args); }
        catch (error) {
          if (error.code === "UNKNOWN_BLOCK_REJECTED") throw error;
          const safe = safeNextBlockError(error, true); if (recovery) normalizedFailure(error, safe); throw safe;
        }
      };
      future.promise = Promise.resolve().then(async () => {
        const qualified = await Promise.allSettled(pair.map(provider => qualifyNextBlockProvider({ provider, pin: h, request, parallelQualification: !recovery }, {
          onTrustFailure: error => { const priority = nextBlockFailurePriority(error); if (priority) { hardFailure(error); distrust(pair, priority === 2); } },
        })));
        const failures = qualified.filter(row => row.status === "rejected").map(row => row.reason)
          .sort((a, b) => nextBlockFailurePriority(b) - nextBlockFailurePriority(a));
        if (failures.length) throw failures[0];
        const proofs = qualified.map(row => row.value);
        const base = await currentReady;
        if (recovery) {
          future.recoveryCheck();
          if (!base && record.failed) return;
          stoppedWork(future);
        }
        requireThat(base && future.accepting && !closed && epoch === token && same(base.pin, h), "M1_HOT_PATH_CANCELLED");
        const child = createNextBlockSimulation({ pin: base.pin, providers: pair, request, now, assertUsable: recovery ? () => {
          future.recoveryCheck(); if (!ownedLifecycle(future.stopFailure)) base.assertUsable();
        } : base.assertUsable,
          classifyNormalAdvance: true, parallelRecheck: true }, {
          // Synchronous, internal revocation, never a timing/user callback. Do
          // not gate on cancellation: it cannot erase an observed contradiction.
          onParentTrustFailure: () => distrust(pair),
        });
        const observe = fn => (...args) => trackSemantic((async () => {
          try {
            if (recovery) stoppedWork(future);
            const result = await fn(...args);
            if (recovery) { stoppedWork(future); base.assertUsable(); }
            return result;
          }
          catch (error) {
            const priority = nextBlockFailurePriority(error);
            if (priority && !ownedLifecycle(error)) distrust(pair, priority === 2);
            throw error;
          }
        })());
        const nextBlock = Object.freeze({ context: child.context, recheck: observe(child.recheck), simulate: observe(child.simulate) });
        await nextBlock.recheck();
        if (recovery) { future.recoveryCheck(); stoppedWork(future); }
        requireThat(future.accepting && !closed && epoch === token && samePairInventory(snapshot, inputInventory(input)), "M1_HOT_PATH_CANCELLED");
        base.assertUsable(); clock();
        const evidence = Object.freeze({ ...base.evidence, nextBlockQualified: true,
          qualification: Object.freeze(base.evidence.qualification.map((row, i) => Object.freeze({ ...row, ...proofs[i] }))) });
        const assertFuture = () => {
          base.assertUsable(); child.assertUsable();
          requireThat(future.accepting, "NEXT_BLOCK_EVIDENCE_INVALIDATED");
        };
        future.ready = Object.freeze({ ...base, evidence, nextBlock, assertUsable: assertFuture,
          send: (signed, assertAdditionalDispatch) => sendWithAdditionalProof(signed, assertFuture, assertAdditionalDispatch) });
        expiry = setTimeout(cancelFuture, Math.max(0, child.context.timestamp * 1000 - now())); expiry.unref?.();
        notifyReady();
      }).catch(async error => {
        future.ready = null; future.stop(); clearReadiness();
        if (!future.cancelled && error.code === "NEXT_BLOCK_METHOD_UNAVAILABLE") chosen.futureUnavailable = true;
        const priority = nextBlockFailurePriority(error);
        if (recovery && priority && !ownedLifecycle(error) && !recovery.causes.get(error)?.cleanup) hardFailure(error);
        if (!future.cancelled && !closed && epoch === token && priority && !ownedLifecycle(error)) distrust(pair, priority === 2);
        await future.drain();
      }).finally(() => { endFuture(); if (optional === future) optional = null; });
      trackBackground(future.promise);
    }
    try {
      current = await createPinnedSession({ candidates: pair, rpc: work.request, now, requireStrictEvidence: true }, {
        ...recoveryHooks(work),
        parallelStrictControls: true, parallelRecheck: true, includeGasLimit: allowFuture,
        ...(reuseCapability ? { capabilityRows: certificate.rows, onPin: pin => { work.pin = pin; pair.forEach(c => maybeFuture(c, pin)); } } : { onHeader: maybeFuture }),
        assertUsable: assertTrusted, bindSend: send => { sendWithProof = send; },
        bindCurrentTrace: open => { openCurrentTrace = open; },
        onPinStart: () => { endPair(); endPin = timing("pinAcquisition"); },
        onQualificationFailure: (c, error) => { if (recovery && !recovery.causes.has(error)) hardFailure(error); if (trustFailure(error) && !ownedLifecycle(error)) { distrust([c]); } },
        onPoison: error => { if (recovery && !recovery.causes.has(error)) hardFailure(error); if (trustFailure(error) && !ownedLifecycle(error)) distrust(pair); },
      });
      endPair(); endPin();
      if (recovery) { work.recoveryCheck(); stoppedWork(work); }
      requireThat(!closed && samePairInventory(snapshot, inventory) && samePairInventory(snapshot, inputInventory(input)), "M1_HOT_PATH_ACQUISITION_INVALIDATED");
      assertTrusted(); clock();
      current.evidence.aliases = Object.freeze(current.evidence.aliases.map(alias => chosen.aliases[alias - 1]));
      current.evidence.qualification = Object.freeze(current.evidence.qualification.map(row => Object.freeze({ ...row, alias: chosen.aliases[row.alias - 1] })));
      if (reuseCapability) {
        const published = assertCertificate(certificate);
        Object.assign(current.evidence, { qualificationMode, capability: {
          suite: certificate.suite, chainId: 1, revision: certificate.revision,
          startedAtWallMs: certificate.started.wall, startedAtMonoMs: certificate.started.mono,
          completedAtWallMs: certificate.completed.wall, completedAtMonoMs: certificate.completed.mono,
          expiresAtWallMs: certificate.started.wall + TTL, expiresAtMonoMs: certificate.started.mono + TTL,
          ageAtAcquisitionMs: Math.max(start.wall - certificate.started.wall, start.mono - certificate.started.mono),
          ageAtPublicationMs: Math.max(published.wall - certificate.started.wall, published.mono - certificate.started.mono),
          anchors: certificate.rows.map(row => ({ ...row.anchor })),
        }, freshPinEvidence: { chainIdVerified: true, latestVerified: true, canonicalVerified: true, numberVerified: true,
          pin: { ...current.pin }, acquiredAtWallMs: published.wall, acquiredAtMonoMs: published.mono } });
      }
      current.send = (signed, assertAdditionalDispatch) => sendWithAdditionalProof(signed, current.assertUsable, assertAdditionalDispatch);
      freezeEvidence(current.evidence); Object.freeze(current.collectorOptions); Object.freeze(current);
      work.deadline = Infinity; resolveCurrent(current);
      if (recovery) record.published = true;
      return Object.freeze({ current, qualifyCurrentTrace, cancelFuture, isFutureReady, onFutureReady(wake) {
        requireThat(typeof wake === "function", "M1_FUTURE_SUBSCRIPTION_INVALID");
        if (taken || closed || notified || !optionalWork?.accepting) return () => {};
        requireThat(subscriber === null, "M1_FUTURE_SUBSCRIPTION_EXISTS");
        subscriber = wake; if (isFutureReady()) notifyReady();
        return () => { if (subscriber === wake) { subscriber = null; clearImmediate(notice); notice = null; } };
      }, takeFuture() {
        if (taken) return null; taken = true;
        clearReadiness();
        const future = optionalWork, facade = future?.ready;
        if (!facade || closed || !future.accepting || epoch !== token || now() >= facade.nextBlock.context.timestamp * 1000) { future?.cancel(); return null; }
        try { clock(); current.assertUsable(); } catch (_) { future.cancel(); return null; }
        future.ready = null; return facade;
      } });
    } catch (error) {
      if (record) record.failed = true;
      if (!recovery) { work.stop(); optionalWork?.cancel(); }
      resolveCurrent(null);
      if (epoch === token && trustFailure(error) && !recovery?.causes.get(error)?.eligible && !ownedLifecycle(error)) distrust(pair);
      await work.drain();
      if (recovery) work.stop();
      throw error instanceof ExecutionError ? error : new ExecutionError("M1_HOT_PATH_ACQUISITION_FAILED");
    } finally { endPair(); endPin(); }
  }
  function acquire(input) {
    // No full-pool work, wait for refresh, or cold fallback is reachable here.
    const record = recovery ? { published: false, used: false, failed: false, cause: null } : null;
    if (record) recovery.records.add(record);
    let result = acquireOne(input, record);
    if (recovery) result = result.catch(error => {
      const outward = safeRecoveryError(error);
      record.failed = true; record.cause = recovery.causes.get(error) || { raw: error, eligible: false };
      if (!eligibleFor(record.cause, record)) record.cause = { ...record.cause, eligible: false };
      if (!recovery.causes.has(error)) hardFailure(error);
      recovery.errors.set(outward, record); throw outward;
    });
    acquisitions.add(result);
    result.then(() => acquisitions.delete(result), () => acquisitions.delete(result)); return result;
  }
  async function close() {
    if (recovery) { hardFailure(new ExecutionError("M1_HOT_PATH_CLOSED")); await disposeRecovery(); return; }
    for (const cert of certificates) revokeCertificate(cert, "M1_CAPABILITY_INVALIDATED", true);
    closed = true; invalidate();
    await Promise.allSettled([refresh?.promise, optional?.promise, hints?.promise, ...acquisitions]);
    while (pending.size) await Promise.all([...pending]);
    flushTimings();
  }
  async function disposeRecovery(record = null) {
    closed = true;
    for (const work of recovery.works) {
      if (record) work.retirement = record;
      work.stop(); work.cancel?.();
    }
    for (const acquisition of recovery.records) acquisition.resolveCurrent?.(null);
    for (const cert of certificates) revokeCertificate(cert, "M1_CAPABILITY_INVALIDATED", true);
    invalidate();
    do {
      await Promise.allSettled([...acquisitions, ...recovery.background, ...recovery.roots, ...pending]);
    } while (acquisitions.size || recovery.background.size || recovery.roots.size || pending.size);
    recovery.disposed = true;
  }
  async function retireFailedAcquisition(error) {
    const record = recovery.errors.get(error);
    requireThat(record && record.failed && !record.used && !record.published && !closed && !recovery.retiring,
      "RANK1_ACQUISITION_RETIREMENT_DENIED");
    record.used = true; recovery.retiring = record; closed = true;
    for (const work of recovery.works) { try { work.recoveryCheck?.(); } catch (_) {} }
    await disposeRecovery(record);
    for (const work of recovery.works) { try { work.recoveryCheck?.(); } catch (_) {} }
    requireThat(eligibleFor(record.cause, record) && !recovery.hard && closed && recovery.disposed && pending.size === 0 &&
      acquisitions.size === 0 && recovery.background.size === 0 && recovery.roots.size === 0, "RANK1_ACQUISITION_RETIREMENT_DENIED");
    return true;
  }
  return Object.freeze({ maintain, acquire, close, ...(recovery ? { retireFailedAcquisition } : {}) });
}

function candidateOptions(options = {}) {
  const { classifyProvider } = require("./rpc-provider-reliability.js"), seen = new Set();
  return {
    preferredChainId: 1, maxBytes: options.maxBytes,
    maxCandidates: Number.isSafeInteger(options.maxCandidates) && options.maxCandidates > 0 ? Math.min(options.maxCandidates, MAX_CANDIDATES) : MAX_CANDIDATES,
    candidateFilter: value => {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || !classifyProvider(url.href) || seen.has(url.href)) return false;
        seen.add(url.href); return true;
      } catch (_) { return false; }
    }
  };
}
function candidatesFromUrls(urls) {
  const { classifyProvider } = require("./rpc-provider-reliability.js");
  return urls.map(value => ({ handle: new URL(value).href, family: classifyProvider(value).family }));
}
// Pure, bounded parsing for offline fixtures; no inventory reads or network calls.
function buildRpcCandidates(text, options = {}) {
  return candidatesFromUrls(require("../shared-rpc.js").parseRpcInventory(text, candidateOptions(options)));
}
// Runtime-only inventory access. Neither import nor offline tests call this function.
function loadRpcCandidates() {
  return candidatesFromUrls(require("../shared-rpc.js").loadRpcUrls(candidateOptions()));
}
function boundedTimeout(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, REQUEST_TIMEOUT_MS) : REQUEST_TIMEOUT_MS;
}
function transientRpcFailure(error) {
  if (error instanceof ExecutionError) return ["RPC_TIMEOUT", "RPC_TRANSPORT_ERROR", "RPC_HTTP_RETRYABLE"].includes(error.code);
  // Never infer retryability from arbitrary messages or generic RPC_FAILED.
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"].includes(error?.code ?? error?.cause?.code);
}
function validRpcResult(method, result) {
  if (method === "eth_getCode") return typeof result === "string" && result.length <= MAX_RESPONSE_BYTES * 2 + 2 && result === result.trim() && /^0x(?:[0-9a-f]{2})*$/i.test(result);
  if (method === "eth_simulateV1") return Array.isArray(result);
  if (method === "debug_traceCall") return result !== null && typeof result === "object" && !Array.isArray(result);
  if (method === "eth_call") return typeof result === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(result);
  if (["eth_chainId", "eth_estimateGas", "eth_getTransactionCount", "eth_getBalance"].includes(method))
    return typeof result === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(result);
  if (method === "eth_sendRawTransaction") return hash(result);
  if (method === "eth_getTransactionReceipt" && result === null) return true;
  return ["eth_getBlockByNumber", "eth_getTransactionReceipt"].includes(method) && result !== null && typeof result === "object" && !Array.isArray(result);
}
async function httpRpc(candidate, method, params, timeoutMs = REQUEST_TIMEOUT_MS, assertDispatch) {
  if (method === "eth_getCode") validateCodeParams(params);
  if (method === "debug_traceCall") validateTraceParams(params);
  if (method === "eth_simulateV1") validateNextBlockParams(params);
  const recoveryObserver = RECOVERY_HTTP_OBSERVERS.get(assertDispatch);
  const ctl = new AbortController(); let timer, reader, responseBody, readerTerminal, readFailure, complete = false, timeoutError = null;
  const timeout = boundedTimeout(timeoutMs), expiresAt = Date.now() + timeout;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { timeoutError = responseError("RPC_TIMEOUT"); reject(timeoutError);
      if (recoveryObserver) ctl.abort(timeoutError); else ctl.abort(); }, timeout);
  });
  // Only the private recovery lane drains the complete physical HTTP/body/parser
  // operation after the outer work timer wins. Abort alone is not drain evidence.
  if (recoveryObserver) expired.catch(() => {});
  const bounded = invoke => {
    if (recoveryObserver) return Promise.resolve().then(invoke);
    requireThat(Date.now() < expiresAt, "RPC_TIMEOUT");
    return Promise.race([Promise.resolve().then(invoke), expired]);
  };
  try {
    const handle = candidate.handle, resolver = require("../shared-rpc.js").getOrigin, orig = resolver(handle), invokeFetch = fetch;
    const options = { method: "POST", redirect: "error", signal: ctl.signal,
      headers: { "content-type": "application/json", ...(orig ? { origin: orig } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) };
    const response = await bounded(() => {
      if (method === "eth_sendRawTransaction" && assertDispatch !== undefined) {
        try {
          requireThat(typeof assertDispatch === "function", "PIN_EVIDENCE_INVALIDATED");
          // Private metadata validation and composed CURRENT/FUTURE assertions
          // share the send-error boundary. A child deadline is not an untrusted
          // RPC response and must not poison the independent CURRENT proof.
          const result = CAPABILITY_DISPATCH_GUARDS.has(assertDispatch)
            ? assertDispatch({ handle, origin: orig, fetch: invokeFetch, resolver }) : assertDispatch();
          // An asynchronous/invalid guard cannot authorize dispatch. Contain
          // rejected observer-like returns without awaiting or sending bytes.
          if (result !== undefined) { Promise.resolve(result).catch(() => {}); throw new ExecutionError("PIN_EVIDENCE_INVALIDATED"); }
        } catch (_) { throw new ExecutionError("PIN_EVIDENCE_INVALIDATED"); }
      } else if (CAPABILITY_DISPATCH_GUARDS.has(assertDispatch)) assertDispatch({ handle, origin: orig, fetch: invokeFetch, resolver });
      // Body, options and transport are already prepared. No deferred work or
      // caller-controlled serialization remains between the guard and fetch.
      recoveryObserver?.issued();
      try { return Promise.resolve(invokeFetch(handle, options)).catch(error => {
        if (error && typeof error === "object") REMOTE_RESPONSE_FAILURES.add(error); throw error;
      }); } catch (error) { if (error && typeof error === "object") REMOTE_RESPONSE_FAILURES.add(error); throw error; }
    });
    if (recoveryObserver) {
      // Own the body before any status exit. Abort notification is not evidence
      // that its stream/cancellation operation has actually terminated.
      responseBody = response.body;
      responseRequire(responseBody && typeof responseBody.getReader === "function", "RPC_FAILED");
      try {
        reader = responseBody.getReader();
        const terminal = reader.closed;
        requireThat(terminal && typeof terminal.then === "function", "RPC_FAILED");
        readerTerminal = Promise.resolve(terminal).then(() => ({ closed: true }), error => ({ error }));
      } catch (_) { const error = new ExecutionError("RPC_FAILED"); recoveryObserver.localFailure?.(error); throw error; }
    }
    if (response.status === 429 || response.status >= 500 && response.status <= 599) throw responseError("RPC_HTTP_RETRYABLE");
    responseRequire(response.ok && (recoveryObserver ? reader : response.body && typeof response.body.getReader === "function"), "RPC_FAILED");
    if (!recoveryObserver) reader = response.body.getReader();
    const buffer = Buffer.alloc(MAX_RESPONSE_BYTES); let bytes = 0;
    while (true) {
      let part;
      // Accessors and synchronous reader invariants are local. Only a rejected
      // started read is a remote stream failure (and a possible cleanup echo).
      const read = reader.read;
      part = await bounded(() => Promise.resolve(read.call(reader)).catch(error => {
        if (recoveryObserver) readFailure = error;
        if (error && typeof error === "object") REMOTE_RESPONSE_FAILURES.add(error); throw error;
      }));
      const { done, value } = part;
      if (done) { complete = true; break; }
      responseRequire(value instanceof Uint8Array, "RPC_FAILED");
      responseRequire(bytes + value.byteLength <= MAX_RESPONSE_BYTES, "RPC_RESPONSE_TOO_LARGE");
      buffer.set(value, bytes); bytes += value.byteLength;
    }
    let body;
    try { body = JSON.parse(buffer.toString("utf8", 0, bytes)); }
    catch (error) { if (error instanceof SyntaxError) throw responseError("RPC_FAILED"); throw error; }
    if (!recoveryObserver) requireThat(Date.now() < expiresAt, "RPC_TIMEOUT");
    responseRequire(body && typeof body === "object" && !Array.isArray(body) && body.jsonrpc === "2.0" && body.id === 1 &&
      Object.hasOwn(body, "result") !== Object.hasOwn(body, "error"), "RPC_FAILED");
    if (Object.hasOwn(body, "error")) {
      const error = body.error;
      responseRequire(error && typeof error === "object" && !Array.isArray(error) && Number.isSafeInteger(error.code) && typeof error.message === "string", "RPC_FAILED");
      if (strictUnknownProbe(method, params) && error.message === error.message.trim() && simulationUnknownBlockRejection(error, params[1].blockHash))
        throw responseError("UNKNOWN_BLOCK_REJECTED");
      if (["eth_call", "eth_estimateGas"].includes(method) && (error.code === 3 || /^execution reverted\b/i.test(error.message))) throw responseError("CALL_REVERTED");
      if (method === "debug_traceCall") {
        if (error.code === -32601) throw responseError("TRACE_METHOD_UNAVAILABLE");
        const currentTrace = CURRENT_TRACE_DISPATCH_GUARDS.has(assertDispatch);
        if (currentTrace && (error.code === -32005 || [-32000, -32002].includes(error.code) &&
          /^(?:execution (?:timeout|timed out)|request timed out|trace (?:limit exceeded|too large)|response (?:size exceeded|too large)|rate limit exceeded)\.?$/i.test(error.message)))
          throw responseError("TRACE_RESOURCE_UNAVAILABLE");
        if (params[1].blockHash === TRACE_UNKNOWN_HASH && (traceBlockNumberNotFoundRejection(error, params[1].blockHash) ||
          (currentTrace ? simulationUnknownBlockRejection(error, params[1].blockHash) :
            unknownBlockRejection(error) || explicitHashNotFoundRejection(error, params[1].blockHash))))
          throw responseError("UNKNOWN_BLOCK_REJECTED");
      }
      if (method === "eth_simulateV1") {
        if (error.code === -32601) throw responseError("NEXT_BLOCK_METHOD_UNAVAILABLE");
        if (params[1].blockHash === SIMULATION_UNKNOWN_HASH && (simulationSelectorNotFoundRejection(error, params[1].blockHash) ||
          simulationUnknownBlockRejection(error, params[1].blockHash)))
          throw responseError("UNKNOWN_BLOCK_REJECTED");
        if (error.code === 3 || /^execution reverted\b/i.test(error.message)) throw responseError("NEXT_BLOCK_REVERTED");
      }
      throw responseError("RPC_FAILED");
    }
    responseRequire(validRpcResult(method, body.result), "RPC_FAILED");
    if (recoveryObserver) {
      const result = method === "debug_traceCall" ? sanitizedTraceResult(body.result) : method === "eth_getCode" ? normalizeCode(body.result, responseRequire) : body.result;
      recoveryObserver.inspect(result);
      if (timeoutError) throw timeoutError;
      responseRequire(Date.now() < expiresAt, "RPC_TIMEOUT"); return result;
    }
    if (method === "debug_traceCall") {
      const result = sanitizedTraceResult(body.result); requireThat(Date.now() < expiresAt, "RPC_TIMEOUT"); return result;
    }
    if (method === "eth_getCode") return normalizeCode(body.result);
    return body.result;
  } catch (error) {
    const allowed = ["CALL_REVERTED", "RPC_RESPONSE_TOO_LARGE", "RPC_TIMEOUT", "RPC_HTTP_RETRYABLE"];
    if (CAPABILITY_DISPATCH_GUARDS.has(assertDispatch)) allowed.push("M1_CAPABILITY_EXPIRED", "M1_CAPABILITY_INVALIDATED",
      "M1_CAPABILITY_CONTEXT_CHANGED", "M1_CAPABILITY_CONTEXT_INVALID", "M1_HOT_PATH_CLOCK_INVALID", "M1_HOT_PATH_CANCELLED", "M1_HOT_PATH_BUDGET");
    if (method === "eth_sendRawTransaction") allowed.push("PIN_EVIDENCE_INVALIDATED");
    if (strictUnknownProbe(method, params)) allowed.push("UNKNOWN_BLOCK_REJECTED");
    if (method === "debug_traceCall") allowed.push("UNKNOWN_BLOCK_REJECTED", "TRACE_METHOD_UNAVAILABLE", "TRACE_SHAPE_INVALID");
    if (CURRENT_TRACE_DISPATCH_GUARDS.has(assertDispatch)) allowed.push("TRACE_RESOURCE_UNAVAILABLE");
    if (method === "eth_simulateV1") allowed.push("UNKNOWN_BLOCK_REJECTED", "NEXT_BLOCK_METHOD_UNAVAILABLE", "NEXT_BLOCK_REVERTED");
    const failure = new ExecutionError(error instanceof ExecutionError && allowed.includes(error.code) ? error.code :
      transientRpcFailure(error) ? "RPC_TRANSPORT_ERROR" : "RPC_FAILED");
    recoveryObserver?.failure?.(error, failure); throw failure;
  } finally {
    clearTimeout(timer);
    if (!recoveryObserver) ctl.abort();
    try {
      if (reader) {
        let cleanupFailed = false;
        if (!complete) { try {
          if (recoveryObserver) await reader.cancel(); else Promise.resolve(reader.cancel()).catch(() => {});
        } catch (error) {
          if (recoveryObserver) {
            const terminal = await readerTerminal;
            // Native errored streams repeat their stored error from cancel().
            // Only that exact observed read/terminal identity is an echo, never
            // a matching code/name/message or an independently failing cleanup.
            cleanupFailed = !(readFailure && typeof readFailure === "object" && error === readFailure && terminal?.error === readFailure);
          }
        } }
        try { reader.releaseLock(); } catch (_) { cleanupFailed = true; }
        if (recoveryObserver && cleanupFailed) {
          const error = new ExecutionError("RPC_FAILED"); recoveryObserver.localFailure?.(error); throw error;
        }
      } else if (recoveryObserver && responseBody) {
        // getReader failed before ownership transferred; dispose the retained
        // body if possible, without turning that invalid response into eligibility.
        try { await responseBody.cancel(); } catch (_) {
          const error = new ExecutionError("RPC_FAILED"); recoveryObserver.localFailure?.(error); throw error;
        }
      }
    } finally {
      // Do not manufacture an AbortError on an otherwise cancellable 429/5xx
      // body before its actual cancellation has been awaited.
      if (recoveryObserver) ctl.abort();
    }
  }
}
module.exports = { createPinnedRpc, createQualifiedPairFactory, createM1HotPathFactory, buildRpcCandidates, loadRpcCandidates, httpRpc, normalizeCallTrace, MAX_CANDIDATES, MAX_AGE_MS, REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES, QUALIFICATION_CONCURRENCY, MULTICALL3, PROBE };
