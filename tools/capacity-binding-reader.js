"use strict";

// Import-inert, process-only transport. No inventory, environment, persistence or CLI.
const preflight = require("./lib/common-finalized-rpc-preflight");
const { performance } = require("node:perf_hooks");
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const EXPIRY = Date.parse("2026-10-21T00:00:00Z");
const ZERO = `0x${"0".repeat(40)}`;
const ZERO_TOPIC = `0x${"0".repeat(64)}`;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
// Derived offline with ethers.id("actor()").slice(0, 10); no runtime ABI dependency.
const ACTOR_SELECTOR = "0x355e937d";
const LIMITS = Object.freeze({
  maxRequests: 400, maxBytes: 64 * 1024 * 1024, maxResponseBytes: 1024 * 1024,
  sessionMs: 8 * 60 * 1000, requestMs: 8000, maxConcurrency: 2
});
const CODES = new Set([
  "INVALID_INPUT", "EXPIRED", "DEADLINE", "REQUEST_CAP", "BYTE_CAP", "RESPONSE_CAP",
  "REQUEST_TIMEOUT", "RPC_ERROR", "UNKNOWN", "REDIRECT", "STATE_DIVERGENCE",
  "PIN_DRIFT", "FINALITY_DRIFT", "QUALIFICATION_FAILED", "CLOSED", "PROCESS_ONLY"
]);
const DIAGNOSTIC_PHASES = new Set(["input", "qualification", "active", "recheck"]);
const DIAGNOSTIC_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"]);
const DIAGNOSTIC_REASONS = new Set([...CODES,
  "INVALID_UTF8", "INVALID_JSON", "ENVELOPE_SHAPE", "ENVELOPE_VERSION", "ENVELOPE_ID", "ENVELOPE_KEYS", "ENVELOPE_XOR",
  "RPC_ERROR_SCHEMA", "NULL_HEADER", "HEADER_SCHEMA", "CHAIN_QUANTITY", "CODE_HEX", "STORAGE_HEX", "CALL_HEX",
  "ACTOR_SHAPE", "ACTOR_MISMATCH", "LOG_SHAPE", "LOG_NONEMPTY", "TRANSPORT_ERROR", "HTTP_STATUS",
  "BODY_SCHEMA", "STREAM_SCHEMA", "CLOCK_ERROR"
]);
function diagnosticContext(context, phase) {
  return Object.freeze({
    phase: DIAGNOSTIC_PHASES.has(context?.phase) ? context.phase : DIAGNOSTIC_PHASES.has(phase) ? phase : null,
    method: DIAGNOSTIC_METHODS.has(context?.method) ? context.method : null,
    requestSequence: Number.isSafeInteger(context?.requestSequence) && context.requestSequence > 0 ? context.requestSequence : null,
    candidateOrdinal: Number.isSafeInteger(context?.candidateOrdinal) && context.candidateOrdinal >= 1 && context.candidateOrdinal <= 16
      ? context.candidateOrdinal : null,
    identityAccepted: typeof context?.identityAccepted === "boolean" ? context.identityAccepted : null
  });
}
function attachDiagnostics(failure, snapshot) {
  if (!Object.hasOwn(failure, "diagnostics")) {
    Object.defineProperty(failure, "diagnostics", { enumerable: true, value: Object.freeze(snapshot) });
  }
  return failure;
}
function attachAdmission(failure, snapshot) {
  if (!Object.hasOwn(failure, "admission")) Object.defineProperty(failure, "admission", { enumerable: true, value: snapshot });
  return failure;
}
class CapacityError extends Error {
  constructor(code) {
    super(CODES.has(code) ? code : "UNKNOWN");
    this.name = "CapacityError";
    this.code = this.message;
  }
}
const error = code => new CapacityError(code);
const fail = code => { throw error(code); };
const safeError = value => value instanceof CapacityError ? value : error("UNKNOWN");
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const hex = value => typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value);
const quantity = value => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const address = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && value.toLowerCase() !== ZERO;
const headerKey = h => `${h.number}:${h.hash}:${h.parentHash}:${h.stateRoot}:${h.timestamp}`;

function settings(input) {
  if (input === undefined) return LIMITS;
  if (!record(input) || Object.keys(input).some(key => !Object.hasOwn(LIMITS, key))) fail("INVALID_INPUT");
  const out = { ...LIMITS, ...input };
  for (const key of Object.keys(LIMITS)) {
    if (!Number.isSafeInteger(out[key]) || out[key] < 1 || out[key] > LIMITS[key]) fail("INVALID_INPUT");
  }
  // The existing helper requires a ledger larger than its eight-request reserve.
  if (out.maxRequests <= 8) fail("INVALID_INPUT");
  return Object.freeze(out);
}

function originHeader(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^https:\/\/[^/?#\s\\]+\/?$/i.test(value)) fail("INVALID_INPUT");
  let parsed;
  try { parsed = new URL(value); } catch (_) { fail("INVALID_INPUT"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
    || parsed.pathname !== "/" || parsed.search || parsed.hash) fail("INVALID_INPUT");
  return value;
}

function candidateRows(values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 16) fail("INVALID_INPUT");
  const seen = new Set();
  return values.map(source => {
    const handle = typeof source === "string" ? source : record(source) ? source.handle : null;
    if (typeof handle !== "string" || handle.length > 8192 || /[\s\x00-\x1f\x7f\\]/.test(handle)
      || seen.has(handle)) fail("INVALID_INPUT");
    let parsed;
    try { parsed = new URL(handle); } catch (_) { fail("INVALID_INPUT"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) fail("INVALID_INPUT");
    const classified = preflight.classifyOperatorFamily(handle)?.operatorFamily;
    const explicit = typeof source === "string" || source.operatorFamily === undefined
      ? null : preflight.reviewedOperatorFamily(source.operatorFamily);
    if ((record(source) && source.operatorFamily !== undefined && !explicit)
      || (classified && explicit && classified !== explicit)) fail("INVALID_INPUT");
    seen.add(handle);
    return Object.freeze({ handle, operatorFamily: explicit || classified || null });
  });
}

/**
 * Success reads return normalized hex; a paired eth_call revert returns
 * { code: "EVM_REVERT", data }. All other failures throw a fixed-code CapacityError.
 * `limits` may only lower the production ceilings. `now` returns epoch milliseconds.
 * getOrigin(handle) may return only an Origin string (or null), not a header map.
 * Required qualification topology: probeRoot code + actor() from probeActor;
 * probeStorageRoot (a distinct declared root) implementation slot. No defaults.
 * registerDerived is async; its source/getter provenance remains the caller's duty.
 * Terminal async failures retain their code/message and expose a frozen, detached
 * error.diagnostics snapshot only after abort/drain. Context is request-local.
 * admissionPolicy defaults to "strict"; only explicit "c2-id-only" permits the
 * reviewed initial uncorrelated identity retirement. Snapshots never admit facts.
 * captureTransportDiagnostic: true adds a separate passive five-field snapshot
 * (or null) to drained terminal errors only. Omitted/false leaves errors unchanged.
 */
async function openCapacitySession(options) {
  let limits, rows, targets, probeRoot, probeStorageRoot, probeActor, probeTx, now, fetcher, getOrigin, chainId, startedAt, hardExpiry;
  const allowedStorageSlots = new Map();
  let admissionPolicy = "strict";
  let captureTransportDiagnostic = false, terminalTransportDiagnostic = null;
  const admissionRecords = [];
  function attachTransportDiagnostic(failure) {
    if (captureTransportDiagnostic && !Object.hasOwn(failure, "transportDiagnostic")) {
      Object.defineProperty(failure, "transportDiagnostic", { enumerable: true, value: terminalTransportDiagnostic });
    }
    return failure;
  }
  function admissionSnapshot() {
    return Object.freeze({ policy: admissionPolicy, count: admissionRecords.length,
      records: Object.freeze(admissionRecords.map(row => Object.freeze({ ...row }))) });
  }
  try {
    if (!record(options)) fail("INVALID_INPUT");
    hardExpiry = options.hardExpiry === undefined ? EXPIRY : options.hardExpiry;
    if (!Number.isSafeInteger(hardExpiry) || hardExpiry <= 0 || hardExpiry > Date.parse("2026-10-21T01:30:00Z")) fail("INVALID_INPUT");
    if (options.captureTransportDiagnostic !== undefined && typeof options.captureTransportDiagnostic !== "boolean") fail("INVALID_INPUT");
    captureTransportDiagnostic = options.captureTransportDiagnostic === true;
    if (![1, 8453].includes(options.chainId)) fail("INVALID_INPUT");
    if (options.admissionPolicy !== undefined) {
      if (!["strict", "c2-id-only"].includes(options.admissionPolicy)) fail("INVALID_INPUT");
      admissionPolicy = options.admissionPolicy;
    }
    chainId = options.chainId;
    limits = settings(options.limits);
    rows = candidateRows(options.candidates);
    if (!Array.isArray(options.rootTargets) || !options.rootTargets.length || options.rootTargets.length > 32
      || !options.rootTargets.every(address)) fail("INVALID_INPUT");
    targets = new Map(options.rootTargets.map(value => [value.toLowerCase(), 0]));
    if (options.allowedStorageSlots !== undefined) {
      const slots = options.allowedStorageSlots;
      if (!record(slots) || ![Object.prototype, null].includes(Object.getPrototypeOf(slots))) fail("INVALID_INPUT");
      for (const key of Reflect.ownKeys(slots)) {
        if (!address(key) || !targets.has(key.toLowerCase()) || allowedStorageSlots.has(key.toLowerCase())) fail("INVALID_INPUT");
        const values = slots[key];
        if (!Array.isArray(values) || values.length < 1 || values.length > 8
          || Array.from(values).some(slot => typeof slot !== "string" || !/^0x[0-9a-f]{64}$/.test(slot))) fail("INVALID_INPUT");
        allowedStorageSlots.set(key.toLowerCase(), new Set(values));
      }
    }
    if (targets.size !== options.rootTargets.length || !address(options.probeRoot)
      || !targets.has(options.probeRoot.toLowerCase())) fail("INVALID_INPUT");
    probeRoot = options.probeRoot.toLowerCase();
    if (!address(options.probeStorageRoot) || !targets.has(options.probeStorageRoot.toLowerCase())
      || options.probeStorageRoot.toLowerCase() === probeRoot || !address(options.probeActor)) fail("INVALID_INPUT");
    probeStorageRoot = options.probeStorageRoot.toLowerCase();
    probeActor = options.probeActor.toLowerCase();
    now = options.now === undefined ? Date.now : options.now;
    fetcher = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
    getOrigin = options.getOrigin === undefined ? () => null : options.getOrigin;
    if (typeof now !== "function" || typeof fetcher !== "function" || typeof getOrigin !== "function") fail("INVALID_INPUT");
    startedAt = now();
    if (!Number.isFinite(startedAt) || startedAt < 0) fail("INVALID_INPUT");
    if (startedAt >= hardExpiry) fail("EXPIRED");
    probeTx = transaction(options.probeCall);
    if (probeTx.to.toLowerCase() !== probeRoot || probeTx.data.toLowerCase() !== ACTOR_SELECTOR
      || !probeTx.from || probeTx.from.toLowerCase() !== probeActor) fail("INVALID_INPUT");
  } catch (cause) {
    const failure = safeError(cause);
    // No transport/ledger has been created at this point: these zeros are known.
    attachDiagnostics(failure, { ...diagnosticContext(null, "input"), reason: failure.code,
      physicalRequests: 0, ledgerRequests: 0, aggregateConsumedBytes: 0, elapsedMs: null, pairSelected: false, drained: true });
    throw attachTransportDiagnostic(attachAdmission(failure, admissionSnapshot()));
  }
  // Do not retain the caller's inventory adapter or arbitrary candidate metadata.
  options = null;
  const monoStart = performance.now();
  let phase = "qualification", terminal = null, pin = null, selected = [], derived = 0;
  let physicalRequests = 0, bytes = 0, nextId = 0, rechecks = 0, recheckedAt = null;
  let active = 0, paceTimer = null, deadlineTimer = null, rechecking = false, disposed = false;
  const handles = new Map(rows.map(row => [row.handle, row.operatorFamily]));
  const candidateOrdinals = new Map(rows.map((row, index) => [row.handle, index + 1]));
  const identities = new Map(rows.map(row => [row.handle, false]));
  const dispatchCounts = new Map(), acceptedMaterial = new Set(), retiredHandles = new Set();
  const failureContexts = new WeakMap(), headerContexts = new WeakMap();
  const controllers = new Set(), jobs = new Set(), queue = [], lastStart = new Map();
  const observedHeaders = new Map(), observations = new Map();
  let qualificationCounts = null;
  let terminalDetail = null, pairSelected = false;

  function transaction(tx) {
    if (!record(tx) || Object.keys(tx).some(key => !["from", "to", "data"].includes(key))
      || !address(tx.to) || !targets.has(tx.to.toLowerCase()) || !hex(tx.data)
      || (tx.data.length - 2) / 2 > 16 * 1024
      || (Object.hasOwn(tx, "from") && !(typeof tx.from === "string" && /^0x[0-9a-f]{40}$/i.test(tx.from)))) fail("INVALID_INPUT");
    // Preserve the caller, including an explicitly supplied zero address; never substitute one.
    return Object.freeze({ ...(Object.hasOwn(tx, "from") ? { from: tx.from } : {}), to: tx.to, data: tx.data });
  }
  function clock() {
    const time = now();
    if (!Number.isFinite(time) || time < startedAt) fail("UNKNOWN");
    return { time, elapsed: Math.max(time - startedAt, performance.now() - monoStart) };
  }
  function contextualFailure(failure, reason, context) {
    if (!failureContexts.has(failure)) failureContexts.set(failure, {
      context: diagnosticContext(context, phase), reason: DIAGNOSTIC_REASONS.has(reason) ? reason : "UNKNOWN"
    });
    return failure;
  }
  function terminalSnapshot() {
    if (!terminal || !disposed || jobs.size || controllers.size || active || queue.length) return terminal;
    if (Object.hasOwn(terminal, "diagnostics")) return terminal;
    let elapsedMs = null;
    try { elapsedMs = Math.floor(clock().elapsed); } catch (_) { /* Unknown, never substitute zero. */ }
    attachDiagnostics(terminal, { ...terminalDetail.context, reason: terminalDetail.reason,
      physicalRequests, ledgerRequests: ledger.networkCalls, aggregateConsumedBytes: bytes,
      elapsedMs, pairSelected, drained: true });
    return attachTransportDiagnostic(attachAdmission(terminal, admissionSnapshot()));
  }
  function stop(code, reason = code, context = null) {
    if (!terminal) {
      terminal = error(code);
      terminalDetail = { context: diagnosticContext(context, phase), reason: DIAGNOSTIC_REASONS.has(reason) ? reason : "UNKNOWN" };
      terminalTransportDiagnostic = reason === "ENVELOPE_ID" ? context?.transportDiagnostic ?? null : null;
    }
    clearTimeout(paceTimer); clearTimeout(deadlineTimer);
    paceTimer = null;
    for (const controller of controllers) controller.abort();
    for (const entry of queue.splice(0)) entry.reject(terminal);
    void drain();
    return terminal;
  }
  function alive(context = null) {
    if (terminal) throw terminal;
    let current;
    try { current = clock(); } catch (_) { throw stop("UNKNOWN", "CLOCK_ERROR", context); }
    if (current.time >= hardExpiry) throw stop("EXPIRED", "EXPIRED", context);
    if (current.elapsed >= limits.sessionMs) throw stop("DEADLINE", "DEADLINE", context);
    return current;
  }
  function pump() {
    clearTimeout(paceTimer); paceTimer = null;
    let current;
    try { current = alive(); } catch (_) { return; }
    let wait = Infinity;
    for (let index = 0; index < queue.length && active < limits.maxConcurrency;) {
      const entry = queue[index];
      const remaining = (lastStart.get(entry.family) ?? -Infinity) + 500 - current.elapsed;
      if (remaining > 0) { wait = Math.min(wait, remaining); index += 1; continue; }
      queue.splice(index, 1);
      active += 1;
      lastStart.set(entry.family, current.elapsed);
      entry.resolve();
    }
    if (queue.length && active < limits.maxConcurrency && Number.isFinite(wait)) {
      paceTimer = setTimeout(pump, Math.max(1, Math.ceil(wait)));
    }
  }
  function acquire(family) {
    return new Promise((resolve, reject) => { queue.push({ family, resolve, reject }); pump(); });
  }
  async function drain() {
    while (jobs.size) await Promise.allSettled([...jobs]);
    if (!disposed) {
      disposed = true;
      handles.clear(); lastStart.clear(); observedHeaders.clear(); observations.clear();
      candidateOrdinals.clear(); identities.clear();
      dispatchCounts.clear(); acceptedMaterial.clear(); retiredHandles.clear();
      rows = null; selected = []; getOrigin = null; fetcher = null;
    }
    terminalSnapshot();
  }
  async function guarded(fn) {
    try { alive(); const result = await fn(); alive(); return result; }
    catch (cause) {
      const clean = safeError(cause), detail = failureContexts.get(clean);
      const failure = stop(clean.code, detail?.reason || clean.code, detail?.context);
      await drain(); terminalSnapshot(); throw failure;
    }
  }

  function storageSlotAllowed(target, slot) {
    return typeof slot === "string" && ([IMPLEMENTATION_SLOT, BEACON_SLOT].includes(slot.toLowerCase())
      || phase === "active" && allowedStorageSlots.get(target.toLowerCase())?.has(slot));
  }
  function allowed(method, params) {
    if (!Array.isArray(params)) fail("INVALID_INPUT");
    if (method === "eth_chainId") {
      if (phase !== "qualification" || params.length) fail("INVALID_INPUT");
      return;
    }
    if (method === "eth_getBlockByNumber") {
      if (!["qualification", "recheck"].includes(phase) || params.length !== 2 || params[1] !== false
        || !(params[0] === "finalized" || quantity(params[0]))
        || (phase === "recheck" && params[0] !== "finalized" && params[0] !== `0x${pin.number.toString(16)}`)) fail("INVALID_INPUT");
      return;
    }
    if (method === "eth_getLogs") {
      const filter = params[0];
      if (phase !== "qualification" || !pin || params.length !== 1
        || !exactKeys(filter, ["address", "topics", "blockHash"]) || filter.address !== ZERO
        || filter.blockHash !== pin.hash || !Array.isArray(filter.topics)
        || filter.topics.length !== 1 || filter.topics[0] !== ZERO_TOPIC) fail("INVALID_INPUT");
      return;
    }
    if (!["eth_call", "eth_getCode", "eth_getStorageAt"].includes(method)) fail("INVALID_INPUT");
    const canonical = params[params.length - 1];
    if (!pin || !exactKeys(canonical, ["blockHash", "requireCanonical"])
      || canonical.blockHash !== pin.hash || canonical.requireCanonical !== true) fail("INVALID_INPUT");
    const target = method === "eth_call" ? transaction(params[0]).to : params[0];
    if (!address(target) || !targets.has(target.toLowerCase())
      || (phase === "qualification" && target.toLowerCase() !== (method === "eth_getStorageAt" ? probeStorageRoot : probeRoot))
      || params.length !== (method === "eth_getStorageAt" ? 3 : 2)) fail("INVALID_INPUT");
    if (method === "eth_getStorageAt" && !storageSlotAllowed(target, params[1])) fail("INVALID_INPUT");
    if (phase === "qualification" && ((method === "eth_getStorageAt" && params[1] !== IMPLEMENTATION_SLOT)
      || (method === "eth_call" && JSON.stringify(params[0]) !== JSON.stringify(probeTx)))) fail("INVALID_INPUT");
  }

  function resultValue(method, value, context) {
    // Accepted RPC material is not a candidate-access failure. Latch malformed
    // schemas globally before the helper has any opportunity to retire a row.
    if (method === "eth_chainId") {
      if (!quantity(value)) throw stop("UNKNOWN", "CHAIN_QUANTITY", context);
      return value.toLowerCase();
    }
    if (method === "eth_getBlockByNumber") {
      if (!record(value) || !quantity(value.number) || !quantity(value.timestamp)) {
        throw stop("UNKNOWN", value === null ? "NULL_HEADER" : "HEADER_SCHEMA", context);
      }
      const header = preflight.normalizeHeader(value);
      if (!header) throw stop("UNKNOWN", "HEADER_SCHEMA", context);
      if (phase === "qualification") {
        const key = headerKey(header), prior = observedHeaders.get(header.number);
        if (prior && prior !== key) throw stop("PIN_DRIFT", "PIN_DRIFT", context);
        observedHeaders.set(header.number, key);
      }
      // The existing helper expects the RPC-shaped header rather than its normalized form.
      const result = { number: `0x${header.number.toString(16)}`, hash: header.hash, parentHash: header.parentHash,
        stateRoot: header.stateRoot, timestamp: `0x${BigInt(header.timestamp).toString(16)}` };
      headerContexts.set(result, diagnosticContext(context, phase));
      return result;
    }
    if (method === "eth_getLogs") {
      if (!Array.isArray(value) || value.length !== 0) throw stop("UNKNOWN", Array.isArray(value) ? "LOG_NONEMPTY" : "LOG_SHAPE", context);
      return [];
    }
    if (!hex(value) || (method === "eth_getStorageAt" && value.length !== 66)) {
      throw stop("UNKNOWN", method === "eth_getStorageAt" ? "STORAGE_HEX" : method === "eth_getCode" ? "CODE_HEX" : "CALL_HEX", context);
    }
    if (phase === "qualification" && method === "eth_call") {
      if (!/^0x0{24}[0-9a-f]{40}$/i.test(value)) throw stop("UNKNOWN", "ACTOR_SHAPE", context);
      if (`0x${value.slice(26).toLowerCase()}` !== probeActor) throw stop("STATE_DIVERGENCE", "ACTOR_MISMATCH", context);
    }
    return value.toLowerCase();
  }
  function observe(method, params, value, context) {
    if (phase === "qualification" && ["eth_call", "eth_getCode", "eth_getStorageAt"].includes(method)) {
      const key = JSON.stringify([method, params]), previous = observations.get(key), outcome = JSON.stringify(value);
      if (previous !== undefined && previous !== outcome) throw stop("STATE_DIVERGENCE", "STATE_DIVERGENCE", context);
      observations.set(key, outcome);
    }
    return value;
  }
  function envelope(body, id, method, params, context) {
    if (!record(body)) throw stop("UNKNOWN", "ENVELOPE_SHAPE", context);
    if (body.jsonrpc !== "2.0") throw stop("UNKNOWN", "ENVELOPE_VERSION", context);
    if (body.id !== id) throw stop("UNKNOWN", "ENVELOPE_ID", context);
    if (Object.hasOwn(body, "result") === Object.hasOwn(body, "error")) throw stop("UNKNOWN", "ENVELOPE_XOR", context);
    if (!exactKeys(body, ["jsonrpc", "id", Object.hasOwn(body, "result") ? "result" : "error"])) throw stop("UNKNOWN", "ENVELOPE_KEYS", context);
    if (Object.hasOwn(body, "error")) {
      const rpcError = body.error;
      if (!record(rpcError) || !Number.isSafeInteger(rpcError.code) || typeof rpcError.message !== "string"
        || Object.keys(rpcError).some(key => !["code", "message", "data"].includes(key))) throw stop("UNKNOWN", "RPC_ERROR_SCHEMA", context);
      if (method === "eth_call" && rpcError.code === 3 && hex(rpcError.data)
        && (rpcError.data.length - 2) / 2 <= 16 * 1024) {
        return observe(method, params, Object.freeze({ code: "EVM_REVERT", data: rpcError.data.toLowerCase() }), context);
      }
      throw contextualFailure(error("RPC_ERROR"), "RPC_ERROR", context);
    }
    return observe(method, params, resultValue(method, body.result, context), context);
  }

  function retireInitialUncorrelatedIdentity(body, id, method, context, handle) {
    // Deliberately separate from the strict decoder: its rejection order stays
    // unchanged, including multifault envelopes that also have a mismatched ID.
    if (admissionPolicy !== "c2-id-only" || phase !== "qualification" || context.phase !== "qualification"
      || method !== "eth_chainId" || context.candidateDispatch !== 1 || dispatchCounts.get(handle) !== 1
      || context.identityAccepted !== false || identities.get(handle) !== false || acceptedMaterial.has(handle)
      || retiredHandles.has(handle) || admissionRecords.length >= 16
      || admissionRecords.some(row => row.candidateOrdinal === context.candidateOrdinal)) return;
    if (!record(body) || body.jsonrpc !== "2.0" || !Object.hasOwn(body, "id") || body.id === id
      || !(body.id === null || typeof body.id === "string" || Number.isSafeInteger(body.id))
      || Object.hasOwn(body, "result") === Object.hasOwn(body, "error")
      || !exactKeys(body, ["jsonrpc", "id", Object.hasOwn(body, "result") ? "result" : "error"])) return;
    if (Object.hasOwn(body, "result")) {
      if (!quantity(body.result)) return; // Syntax only: never interpret or accept this chain value.
    } else {
      const rpcError = body.error;
      if (!record(rpcError) || !Number.isSafeInteger(rpcError.code) || typeof rpcError.message !== "string"
        || Object.keys(rpcError).some(key => !["code", "message", "data"].includes(key))) return;
    }
    alive(context); // A global sentinel, deadline or expiry can never be demoted.
    if (physicalRequests >= limits.maxRequests || ledger.networkCalls >= limits.maxRequests - 8) {
      throw stop("REQUEST_CAP", "REQUEST_CAP", context); // Preserve the helper's existing eight-request reserve.
    }
    if (bytes >= limits.maxBytes) throw stop("BYTE_CAP", "BYTE_CAP", context);
    retiredHandles.add(handle);
    admissionRecords.push(Object.freeze({ candidateOrdinal: context.candidateOrdinal, requestSequence: context.requestSequence,
      phase: "qualification", method: "eth_chainId", identityAccepted: false, reason: "ENVELOPE_ID", disposition: "IDENTITY_UNQUALIFIED" }));
    // A nonterminal candidate rejection, not a correlated result and not a retry.
    throw contextualFailure(error("UNKNOWN"), "ENVELOPE_ID", context);
  }

  function outboundCheck(serializedBody, id) {
    let body;
    try {
      if (typeof serializedBody !== "string") return "SERIALIZATION_INVALID";
      body = JSON.parse(serializedBody);
    } catch (_) { return "SERIALIZATION_INVALID"; }
    if (!exactKeys(body, ["jsonrpc", "id", "method", "params"]) || body.jsonrpc !== "2.0"
      || body.id !== id || body.method !== "eth_call") return "ENVELOPE_MISMATCH";
    const params = body.params;
    if (!Array.isArray(params) || params.length !== 2 || !exactKeys(params[0], ["from", "to", "data"])
      || params[0].from !== probeTx.from || params[0].to !== probeTx.to || params[0].data !== probeTx.data
      || !exactKeys(params[1], ["blockHash", "requireCanonical"])
      || params[1].blockHash !== pin?.hash || params[1].requireCanonical !== true) return "PARAMS_MISMATCH";
    return "MATCH";
  }
  function classifyTransportResponse(body, id, context) {
    if (!captureTransportDiagnostic || terminal || phase !== "qualification" || context.phase !== "qualification"
      || context.method !== "eth_call" || context.identityAccepted !== true
      || !record(body) || body.jsonrpc !== "2.0" || body.id === id) return;
    // Pure shape checks only. The strict decoder below still supplies the fatal
    // ENVELOPE_ID; neither result semantics nor error message/data are interpreted.
    const hasResult = Object.hasOwn(body, "result"), hasError = Object.hasOwn(body, "error"), rpcError = body.error;
    const errorValid = record(rpcError) && Number.isSafeInteger(rpcError.code) && typeof rpcError.message === "string"
      && Object.keys(rpcError).every(key => ["code", "message", "data"].includes(key));
    let errorClass = hasError ? "MALFORMED" : "ABSENT";
    if (hasError && errorValid) {
      switch (rpcError.code) {
        case -32700: errorClass = "PARSE_ERROR"; break;
        case -32600: errorClass = "INVALID_REQUEST"; break;
        case -32602: errorClass = "INVALID_PARAMS"; break;
        case -32601: errorClass = "UNSUPPORTED_METHOD"; break;
        case 3: errorClass = "EXECUTION_REVERT_CODE"; break;
        default: errorClass = "OTHER";
      }
    }
    context.transportDiagnostic = Object.freeze({
      outboundCheck: context.outboundCheck,
      responseIdClass: !Object.hasOwn(body, "id") ? "MISSING" : body.id === null ? "NULL"
        : typeof body.id === "string" ? body.id === String(id) ? "DECIMAL_STRING_EQUIVALENT" : "OTHER_STRING"
        : Number.isSafeInteger(body.id) ? "OTHER_NUMBER" : "INVALID",
      branch: hasResult ? hasError ? "BOTH" : "RESULT" : hasError ? "ERROR" : "NEITHER",
      envelopeExceptIdValid: hasResult !== hasError && exactKeys(body, ["jsonrpc", "id", hasResult ? "result" : "error"])
        && (!hasError || errorValid),
      errorClass
    });
  }

  async function physical(handle, method, params) {
    const context = { phase, method, requestSequence: null, candidateOrdinal: candidateOrdinals.get(handle) ?? null,
      identityAccepted: identities.get(handle) ?? null };
    alive(context); allowed(method, params);
    if (!handles.has(handle) || !handles.get(handle)) fail("INVALID_INPUT");
    if (retiredHandles.has(handle)) throw contextualFailure(error("UNKNOWN"), "ENVELOPE_ID", context);
    await acquire(handles.get(handle));
    let controller, timer, reader, response, requestTimedOut = false;
    try {
      alive(context);
      if (retiredHandles.has(handle)) throw contextualFailure(error("UNKNOWN"), "ENVELOPE_ID", context);
      const origin = originHeader(getOrigin(handle));
      alive(context);
      if (physicalRequests >= limits.maxRequests) throw stop("REQUEST_CAP", "REQUEST_CAP", context);
      controller = new AbortController(); controllers.add(controller);
      timer = setTimeout(() => { requestTimedOut = true; controller.abort(); }, limits.requestMs);
      const id = ++nextId;
      context.requestSequence = id;
      lastStart.set(handles.get(handle), alive(context).elapsed);
      physicalRequests += 1;
      context.candidateDispatch = (dispatchCounts.get(handle) || 0) + 1;
      dispatchCounts.set(handle, context.candidateDispatch);
      const serializedBody = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      if (captureTransportDiagnostic && context.phase === "qualification" && method === "eth_call" && context.identityAccepted === true) {
        context.outboundCheck = outboundCheck(serializedBody, id);
      }
      response = await fetcher(handle, {
        method: "POST", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }) },
        body: serializedBody
      });
      alive(context);
      if (requestTimedOut) fail("REQUEST_TIMEOUT");
      if (!response || response.redirected || (response.status >= 300 && response.status < 400)) throw contextualFailure(error("REDIRECT"), "REDIRECT", context);
      if (response.status !== 200) throw contextualFailure(error("RPC_ERROR"), "HTTP_STATUS", context);
      if (!response.body || typeof response.body.getReader !== "function") throw stop("UNKNOWN", "BODY_SCHEMA", context);
      reader = response.body.getReader();
      const chunks = [];
      let responseBytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (!chunk.done && chunk.value instanceof Uint8Array) {
          bytes += chunk.value.byteLength; responseBytes += chunk.value.byteLength;
          if (bytes > limits.maxBytes) throw stop("BYTE_CAP", "BYTE_CAP", context);
          if (responseBytes > limits.maxResponseBytes) throw stop("RESPONSE_CAP", "RESPONSE_CAP", context);
          chunks.push(Buffer.from(chunk.value));
        } else if (!chunk.done) throw stop("UNKNOWN", "STREAM_SCHEMA", context);
        alive(context);
        if (requestTimedOut) fail("REQUEST_TIMEOUT");
        if (chunk.done) break;
      }
      let body, parseReason = "INVALID_UTF8";
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, responseBytes));
        parseReason = "INVALID_JSON";
        body = JSON.parse(text);
      } catch (_) { throw stop("UNKNOWN", parseReason, context); }
      retireInitialUncorrelatedIdentity(body, id, method, context, handle);
      classifyTransportResponse(body, id, context);
      const result = envelope(body, id, method, params, context);
      // No identity acceptance from HTTP/envelope/header/probe facts. Only a
      // canonical, matching chain quantity can flip this request-local marker.
      if (method === "eth_chainId" && BigInt(result) === BigInt(chainId)) {
        identities.set(handle, true); context.identityAccepted = true;
      }
      acceptedMaterial.add(handle);
      return result;
    } catch (cause) {
      const clean = requestTimedOut ? error("REQUEST_TIMEOUT") : safeError(cause);
      throw terminal || contextualFailure(clean, requestTimedOut ? "REQUEST_TIMEOUT"
        : cause instanceof CapacityError ? cause.code : "TRANSPORT_ERROR", context);
    } finally {
      clearTimeout(timer);
      if (controller) controller.abort();
      try {
        if (reader) { await reader.cancel(); reader.releaseLock(); }
        else if (response?.body && typeof response.body.cancel === "function") await response.body.cancel();
      } catch (_) { /* Never propagate transport cleanup text. */ }
      if (controller) controllers.delete(controller);
      active -= 1; pump();
    }
  }
  function trackedCall(handle, method, params) {
    const job = physical(handle, method, params);
    jobs.add(job);
    job.then(() => jobs.delete(job), () => jobs.delete(job));
    return job;
  }
  const ledger = preflight.createRpcLedger(trackedCall, limits.maxRequests);
  const rpc = Object.freeze({
    async call(handle, method, params) {
      alive();
      try { return await ledger.call(handle, method, params); }
      catch (cause) {
        if (cause instanceof preflight.PreflightError && cause.code === "NETWORK_CALL_CAP") throw stop("REQUEST_CAP");
        const clean = safeError(cause), detail = failureContexts.get(clean);
        throw terminal || (phase === "qualification" ? clean : stop(clean.code, detail?.reason || clean.code, detail?.context));
      }
    },
    get networkCalls() { return ledger.networkCalls; },
    get maxNetworkCalls() { return ledger.maxNetworkCalls; }
  });
  deadlineTimer = setTimeout(() => stop(hardExpiry - startedAt <= limits.sessionMs ? "EXPIRED" : "DEADLINE"),
    Math.min(limits.sessionMs, hardExpiry - startedAt));
  // An abandoned idle session must not keep a caller process alive.
  deadlineTimer.unref?.();

  try {
    let qualified = await preflight.qualifyCommonFinalized({
      chainId, candidates: rows, rpc, minimumFamilies: 2, preferredFamilies: rows.length + 1,
      limits: { maxCandidates: 16, maxProbeCallsPerCandidate: 4, reserveRequests: 8, retries: 0 },
      async probe({ reader, pin: commonPin }) {
        alive();
        if (pin && headerKey(pin) !== headerKey(commonPin)) throw stop("PIN_DRIFT");
        pin = Object.freeze({ ...commonPin });
        const code = await reader.getCode(probeRoot);
        const storage = await reader.getStorageAt(probeStorageRoot, IMPLEMENTATION_SLOT);
        const call = await reader.call(probeTx);
        alive();
        return { code, storage, call };
      }
    });
    // Helper deliberately retires ordinary candidate failures, but must never swallow
    // a session-wide sentinel, including a third-provider contradiction.
    alive();
    if (qualified.diagnostics.stateDistinctGroups !== 1) throw stop("STATE_DIVERGENCE");
    selected = qualified.selected.slice(0, 2).map(row => row.candidate.handle);
    if (selected.length !== 2 || new Set(selected.map(handle => handles.get(handle))).size !== 2) fail("QUALIFICATION_FAILED");
    pairSelected = true;
    qualificationCounts = Object.freeze({
      candidates: qualified.diagnostics.candidatesConsidered,
      qualificationAttempts: qualified.diagnostics.qualificationAttempts,
      stateAttempts: qualified.diagnostics.stateAttempts,
      stateSuccesses: qualified.diagnostics.stateSuccesses,
      qualificationRequests: ledger.networkCalls
    });
    qualified = null; rows = null;
    for (const handle of handles.keys()) if (!selected.includes(handle)) handles.delete(handle);
    observations.clear(); observedHeaders.clear();
    phase = "active";
  } catch (cause) {
    const code = cause instanceof preflight.PreflightError
      ? cause.code === "NETWORK_CALL_CAP" ? "REQUEST_CAP" : "QUALIFICATION_FAILED" : safeError(cause).code;
    const detail = failureContexts.get(cause);
    const failure = stop(code, detail?.reason || code, detail?.context); await drain(); terminalSnapshot(); throw failure;
  }

  const canonical = Object.freeze({ blockHash: pin.hash, requireCanonical: true });
  async function pair(method, params) {
    const outcomes = await Promise.allSettled(selected.map(handle => rpc.call(handle, method, params)));
    alive();
    const rejected = outcomes.find(outcome => outcome.status === "rejected");
    if (rejected) throw safeError(rejected.reason);
    const values = outcomes.map(outcome => outcome.value);
    if (JSON.stringify(values[0]) !== JSON.stringify(values[1])) fail("STATE_DIVERGENCE");
    return values[0];
  }
  function target(value) {
    if (!address(value) || !targets.has(value.toLowerCase())) fail("INVALID_INPUT");
    return value.toLowerCase();
  }
  function evidence() {
    alive();
    return Object.freeze({ pin, counts: Object.freeze({ ...qualificationCounts,
      requests: physicalRequests, ledgerRequests: ledger.networkCalls, bytes, derived, rechecks, recheckedAt }),
      independentWitnesses: 2, admission: admissionSnapshot() });
  }
  const session = Object.create(null);
  Object.defineProperties(session, {
    pin: { enumerable: true, value: pin },
    evidence: { enumerable: true, get: evidence },
    call: { value: tx => guarded(() => pair("eth_call", [transaction(tx), canonical])) },
    getCode: { value: value => guarded(() => pair("eth_getCode", [target(value), canonical])) },
    getStorageAt: { value: (value, slot) => guarded(() => {
      if (!storageSlotAllowed(target(value), slot)) fail("INVALID_INPUT");
      return pair("eth_getStorageAt", [target(value), slot.toLowerCase(), canonical]);
    }) },
    registerDerived: { value: (parent, value) => guarded(() => {
      const parentAddress = target(parent);
      if (!address(value) || targets.has(value.toLowerCase()) || targets.get(parentAddress) >= 2 || derived >= 16) fail("INVALID_INPUT");
      const normalized = value.toLowerCase();
      targets.set(normalized, targets.get(parentAddress) + 1); derived += 1;
      return normalized;
    }) },
    recheck: { value: () => guarded(async () => {
      if (rechecking) fail("INVALID_INPUT");
      rechecking = true; phase = "recheck";
      try {
        const results = await Promise.allSettled(selected.map(async handle => {
          const sameRaw = await rpc.call(handle, "eth_getBlockByNumber", [`0x${pin.number.toString(16)}`, false]);
          const same = preflight.normalizeHeader(sameRaw);
          if (!same || headerKey(same) !== headerKey(pin)) throw stop("PIN_DRIFT", "PIN_DRIFT", headerContexts.get(sameRaw));
          const finalizedRaw = await rpc.call(handle, "eth_getBlockByNumber", ["finalized", false]);
          const finalized = preflight.normalizeHeader(finalizedRaw);
          if (!finalized || finalized.number < pin.number
            || (finalized.number === pin.number && headerKey(finalized) !== headerKey(pin))) throw stop("FINALITY_DRIFT", "FINALITY_DRIFT", headerContexts.get(finalizedRaw));
        }));
        alive();
        const rejected = results.find(result => result.status === "rejected");
        if (rejected) throw safeError(rejected.reason);
        recheckedAt = clock().time; rechecks += 1;
        return evidence();
      } finally { rechecking = false; phase = "active"; }
    }) },
    close: { value: async () => { stop("CLOSED"); await drain(); } },
    toJSON: { value: () => fail("PROCESS_ONLY") },
    toString: { value: () => "[capacity-session:process-only]" },
    [INSPECT]: { value: () => "[capacity-session:process-only]" },
    [Symbol.toPrimitive]: { value: () => "[capacity-session:process-only]" }
  });
  return Object.freeze(session);
}

module.exports = Object.freeze({ openCapacitySession, IMPLEMENTATION_SLOT, BEACON_SLOT, LIMITS });
