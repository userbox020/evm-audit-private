"use strict";

// Isolated, opt-in prototype. No endpoint discovery, ambient transport or IO.
const {
  classifyOperatorFamily, normalizeHeader, createRpcLedger, qualifyCommonFinalized,
} = require("./common-finalized-rpc-preflight");

const METHODS = Object.freeze(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"]);
const METHOD_SET = new Set(METHODS);
const STATE_METHODS = new Set(["eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"]);
const CODES = new Set(["INVALID_INPUT", "METHOD_NOT_ALLOWED", "QUALIFICATION_FAILED", "QUOTA_LIMIT", "COOLDOWN",
  "SCOPE_DISABLED", "NETWORK_CALL_CAP", "DEADLINE", "RPC_FAILURE", "PIN_INVALID", "PIN_MISMATCH", "SESSION_INVALID"]);
const CEILINGS = Object.freeze({ maxRequests: 160, maxMs: 45_000, maxConcurrent: 4, timeoutMs: 5_000, maxResponseBytes: 1_048_576 });
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const HEX = /^0x(?:[0-9a-f]{2})*$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const MAX_REQUEST_BYTES = 16 * 1024;
const PIN_AGE_MS = 30 * 60_000;
const FUTURE_MS = 60_000;

function failure(code) {
  const safe = CODES.has(code) ? code : "RPC_FAILURE";
  const error = new Error(safe);
  error.name = "PoolError";
  error.code = safe;
  delete error.stack;
  return error;
}
function plain(value) { return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function fields(value, allowed) { return plain(value) && Object.keys(value).every(key => allowed.includes(key)); }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function headerAge(header, epoch) {
  const time = Number(header?.timestamp) * 1000;
  return Number.isSafeInteger(time) && time <= epoch + FUTURE_MS && epoch - time <= PIN_AGE_MS;
}
function block(value) { return value === "finalized" || value === "safe" || value === "latest" || (typeof value === "string" && QUANTITY.test(value)); }
function canonical(value) { return fields(value, ["blockHash", "requireCanonical"])
  && Object.keys(value).length === 2 && HASH.test(value.blockHash) && value.requireCanonical === true; }
function transaction(value) {
  return fields(value, ["to", "data"]) && Object.keys(value).length === 2
    && typeof value.to === "string" && ADDRESS.test(value.to)
    && typeof value.data === "string" && HEX.test(value.data) && value.data.length <= MAX_REQUEST_BYTES;
}
function filter(value, isPinned) {
  if (!fields(value, isPinned ? ["address", "topics"] : ["address", "topics", "blockHash"])) return false;
  if (typeof value.address !== "string" || !ADDRESS.test(value.address)
    || !Array.isArray(value.topics) || value.topics.length > 4
    || value.topics.some(topic => topic !== null && !(typeof topic === "string" && HASH.test(topic)))) return false;
  return isPinned || typeof value.blockHash === "string" && HASH.test(value.blockHash);
}
function validParams(method, params, pinned = false) {
  if (!Array.isArray(params)) return false;
  if (method === "eth_chainId") return !pinned && params.length === 0;
  if (method === "eth_getBlockByNumber") return !pinned && params.length === 2 && block(params[0]) && params[1] === false;
  if (method === "eth_getLogs") return params.length === 1 && filter(params[0], pinned);
  const stateBlock = pinned ? params.length === (method === "eth_getStorageAt" ? 2 : 1)
    : params.length === (method === "eth_getStorageAt" ? 3 : 2) && (block(params.at(-1)) || canonical(params.at(-1)));
  if (!stateBlock) return false;
  if (method === "eth_getCode") return typeof params[0] === "string" && ADDRESS.test(params[0]);
  if (method === "eth_getStorageAt") return typeof params[0] === "string" && ADDRESS.test(params[0])
    && typeof params[1] === "string" && HASH.test(params[1]);
  if (method === "eth_call") return transaction(params[0]);
  return false;
}
function stateResult(method, value) {
  if (method === "eth_getLogs") return Array.isArray(value) && value.length <= 4096;
  if (method === "eth_getStorageAt") return typeof value === "string" && HASH.test(value);
  return typeof value === "string" && HEX.test(value) && value.length <= CEILINGS.maxResponseBytes * 2 + 2;
}
function createDefaultSleep(ms, { signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(failure("DEADLINE")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(failure("DEADLINE")); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function createReadOnlyPinnedRpcPool(options) {
  try { return construct(options); }
  catch (_) { throw failure("INVALID_INPUT"); }
}

function construct(options) {
  if (!fields(options, ["endpoints", "quota", "transport", "now", "sleep", "limits"])
    || typeof options.transport !== "function" || (options.now !== undefined && typeof options.now !== "function")
    || (options.sleep !== undefined && typeof options.sleep !== "function")) throw failure("INVALID_INPUT");
  const clock = options.now || Date.now;
  const sleep = options.sleep || createDefaultSleep;
  if (!fields(options.limits || {}, Object.keys(CEILINGS))) throw failure("INVALID_INPUT");
  const limits = { ...CEILINGS, ...options.limits };
  for (const key of Object.keys(CEILINGS)) if (!positive(limits[key]) || limits[key] > CEILINGS[key]) throw failure("INVALID_INPUT");
  // Fourteen physical preflight reads is the minimum for two families; the
  // other 80 calls are reserved before even attempting admission.
  if (limits.maxRequests < 94) throw failure("INVALID_INPUT");
  if (!Array.isArray(options.endpoints) || !options.endpoints.length || options.endpoints.length > 16) throw failure("INVALID_INPUT");
  const endpoints = [];
  const deduped = new Set();
  for (const entry of options.endpoints) {
    if (!fields(entry, ["handle"]) || Object.keys(entry).length !== 1 || typeof entry.handle !== "string"
      || !entry.handle || entry.handle.length > 4096) throw failure("INVALID_INPUT");
    let parsed;
    try { parsed = new URL(entry.handle); } catch (_) { throw failure("INVALID_INPUT"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw failure("INVALID_INPUT");
    const handle = parsed.href;
    const family = classifyOperatorFamily(handle);
    if (!family?.operatorFamily) throw failure("INVALID_INPUT");
    if (!deduped.has(handle)) {
      deduped.add(handle);
      endpoints.push({ handle, family: family.operatorFamily, rank: family.capabilityRank });
    }
  }
  if (!endpoints.length) throw failure("INVALID_INPUT");
  if (!fields(options.quota, ["global", "ip", "families"]) || Object.keys(options.quota).length !== 3
    || !plain(options.quota.families)) throw failure("INVALID_INPUT");
  const familyNames = new Set(endpoints.map(endpoint => endpoint.family));
  if (Object.keys(options.quota.families).length !== familyNames.size
    || [...familyNames].some(name => !Object.hasOwn(options.quota.families, name))) throw failure("INVALID_INPUT");
  function makeBucket(source, methods = false) {
    const keys = methods ? ["capacityUnits", "windowMs", "maxInFlight", "methodCosts"] : ["capacityUnits", "windowMs", "maxInFlight"];
    if (!fields(source, keys) || Object.keys(source).length !== keys.length
      || !positive(source.capacityUnits) || !positive(source.windowMs) || !positive(source.maxInFlight)) throw failure("INVALID_INPUT");
    if (methods && (!fields(source.methodCosts, METHODS) || Object.keys(source.methodCosts).length !== METHODS.length
      || METHODS.some(method => !positive(source.methodCosts[method]) || source.methodCosts[method] > source.capacityUnits))) throw failure("INVALID_INPUT");
    return { capacity: source.capacityUnits, windowMs: source.windowMs,
      maxInFlight: source.maxInFlight, costs: methods ? { ...source.methodCosts } : null,
      entries: [], used: 0, inFlight: 0, until: 0, disabled: false };
  }
  const global = makeBucket(options.quota.global);
  const ip = makeBucket(options.quota.ip);
  const families = new Map([...familyNames].map(name => [name, makeBucket(options.quota.families[name], true)]));
  let lastTime;
  let clockBroken = false;
  function current() {
    if (clockBroken) throw failure("DEADLINE");
    let epoch;
    try { epoch = clock(); } catch (_) { clockBroken = true; throw failure("DEADLINE"); }
    if (!Number.isSafeInteger(epoch) || epoch < 0 || lastTime !== undefined && epoch < lastTime) {
      clockBroken = true; throw failure("DEADLINE");
    }
    lastTime = epoch;
    return epoch;
  }
  const started = current();
  if (started > Number.MAX_SAFE_INTEGER - limits.maxMs) throw failure("INVALID_INPUT");
  const expires = started + limits.maxMs;
  const counters = { physicalRequests: 0, inFlight: 0, peakInFlight: 0, rejectedRequests: 0,
    completedRequests: 0, transportFailures: 0, httpRejects: 0, rateLimited: 0 };
  let uncertain = 0;
  let nextEndpoint = 0;
  function remaining(epoch = current()) {
    if (epoch >= expires) throw failure("DEADLINE");
    return expires - epoch;
  }
  function rejection(code) { counters.rejectedRequests += 1; throw failure(code); }
  function prune(bucket, epoch) {
    while (bucket.entries.length && epoch - bucket.entries[0].at >= bucket.windowMs) {
      bucket.used -= bucket.entries[0].cost;
      bucket.entries.shift();
    }
  }
  function available(bucket, cost, epoch) {
    prune(bucket, epoch);
    return bucket.inFlight < bucket.maxInFlight && cost <= bucket.capacity - bucket.used;
  }
  function eligible(endpoint, method, epoch) {
    const family = families.get(endpoint.family);
    if (family.disabled) return "SCOPE_DISABLED";
    if (epoch < ip.until || epoch < family.until) return "COOLDOWN";
    if (!available(family, family.costs[method], epoch)) return "QUOTA_LIMIT";
    return null;
  }
  function fullCooldown(endpoint, hint, epoch) {
    const family = families.get(endpoint.family);
    let until = Infinity;
    if (typeof hint === "number" && Number.isFinite(hint) && hint > 0 && epoch + hint * 1000 <= Number.MAX_SAFE_INTEGER) {
      until = epoch + hint * 1000;
    } else if (typeof hint === "string" && /^\d+$/.test(hint)) {
      const seconds = BigInt(hint);
      if (seconds > 0n && seconds <= BigInt(Math.floor((Number.MAX_SAFE_INTEGER - epoch) / 1000))) until = epoch + Number(seconds) * 1000;
    } else if (typeof hint === "string") {
      const date = Date.parse(hint);
      if (Number.isSafeInteger(date) && date > epoch) until = date;
    }
    // An absent/invalid/past/very long hint blocks the remaining pool lifetime.
    if (until >= expires) until = Infinity;
    family.until = Math.max(family.until, until);
    ip.until = Math.max(ip.until, until);
  }
  function response(endpoint, method, envelope, epoch) {
    if (!fields(envelope, ["kind", "value", "bytes", "status", "retryAfter", "quotaExhausted"])) throw failure("RPC_FAILURE");
    if (envelope.kind === "http") {
      if (!Number.isSafeInteger(envelope.status) || envelope.status < 100 || envelope.status > 599
        || Object.keys(envelope).some(key => !["kind", "status", "retryAfter", "quotaExhausted"].includes(key))) throw failure("RPC_FAILURE");
      counters.httpRejects += 1;
      const family = families.get(endpoint.family);
      if ([401, 402, 403].includes(envelope.status) || envelope.quotaExhausted === true) {
        family.disabled = true; throw failure("SCOPE_DISABLED");
      }
      if (envelope.status === 429) { counters.rateLimited += 1; fullCooldown(endpoint, envelope.retryAfter, epoch); throw failure("COOLDOWN"); }
      throw failure("RPC_FAILURE");
    }
    if (envelope.kind !== "result" || Object.keys(envelope).sort().join(",") !== "bytes,kind,value"
      || !Number.isSafeInteger(envelope.bytes) || envelope.bytes < 0 || envelope.bytes > limits.maxResponseBytes) throw failure("RPC_FAILURE");
    if (method === "eth_chainId" && !(typeof envelope.value === "string" && QUANTITY.test(envelope.value))) throw failure("RPC_FAILURE");
    if (method === "eth_getBlockByNumber" && !normalizeHeader(envelope.value)) throw failure("RPC_FAILURE");
    if (STATE_METHODS.has(method) && !stateResult(method, envelope.value)) throw failure("RPC_FAILURE");
    return envelope.value;
  }
  async function physical(endpoint, method, params, phase) {
    let epoch;
    try { epoch = current(); remaining(epoch); } catch (error) { rejection(error.code); }
    if (uncertain) rejection("RPC_FAILURE");
    if (!METHOD_SET.has(method)) rejection("METHOD_NOT_ALLOWED");
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify({ method, params })); } catch (_) { rejection("INVALID_INPUT"); }
    if (bytes > MAX_REQUEST_BYTES) rejection("INVALID_INPUT");
    const terminalReserve = phase === "terminal" ? 0 : phase === "preflight" ? 80 : 8;
    if (counters.physicalRequests >= limits.maxRequests - terminalReserve) rejection("NETWORK_CALL_CAP");
    if (counters.inFlight >= limits.maxConcurrent) rejection("QUOTA_LIMIT");
    if (!available(global, 1, epoch) || !available(ip, 1, epoch)) rejection("QUOTA_LIMIT");
    const problem = eligible(endpoint, method, epoch);
    if (problem) rejection(problem);
    const family = families.get(endpoint.family);
    // All three rolling buckets and physical permits are charged synchronously,
    // before calling injected transport. Never refund a dispatched attempt.
    for (const [bucket, cost] of [[global, 1], [ip, 1], [family, family.costs[method]]]) {
      bucket.entries.push({ at: epoch, cost }); bucket.used += cost; bucket.inFlight += 1;
    }
    counters.physicalRequests += 1;
    counters.inFlight += 1;
    counters.peakInFlight = Math.max(counters.peakInFlight, counters.inFlight);
    const controller = new AbortController();
    const timerController = new AbortController();
    let settled = false;
    let timedOut = false;
    const limit = Math.min(limits.timeoutMs, expires - epoch);
    function completionTime() {
      const finished = current();
      if (finished >= expires) throw failure("DEADLINE");
      if (finished >= epoch + limit) throw failure("RPC_FAILURE");
      return finished;
    }
    const transportPromise = Promise.resolve().then(() => options.transport(endpoint.handle, method, params,
      { signal: controller.signal, timeoutMs: limit, maxResponseBytes: limits.maxResponseBytes }));
    const read = transportPromise.then(
      envelope => {
        settled = true;
        // A resolved transport can beat its sleep callback even though the
        // injected epoch clock has already crossed either hard deadline.
        const value = response(endpoint, method, envelope, completionTime());
        completionTime(); // Also cover time spent validating the response.
        return value;
      },
      () => { settled = true; throw failure("RPC_FAILURE"); },
    ).finally(() => {
      timerController.abort();
      for (const bucket of [global, ip, family]) bucket.inFlight -= 1;
      counters.inFlight -= 1;
      counters.completedRequests += 1;
      if (timedOut) uncertain -= 1;
    });
    const timer = Promise.resolve().then(() => sleep(limit, { signal: timerController.signal })).then(
      () => {
        if (settled) return new Promise(() => {});
        timedOut = true; uncertain += 1; controller.abort();
        throw failure(epoch + limit >= expires ? "DEADLINE" : "RPC_FAILURE");
      },
      () => {
        if (settled) return new Promise(() => {});
        timedOut = true; uncertain += 1; controller.abort();
        throw failure("RPC_FAILURE");
      },
    );
    try { return await Promise.race([read, timer]); }
    catch (error) {
      if (error?.code === "RPC_FAILURE" || error?.code === "DEADLINE") counters.transportFailures += 1;
      throw failure(error?.code);
    } finally { timerController.abort(); }
  }
  function lookup(handle) { return endpoints.find(endpoint => endpoint.handle === handle); }
  function qualifiedCall(handle, method, params) {
    const endpoint = lookup(handle);
    if (!endpoint || !METHOD_SET.has(method) || !validParams(method, params, false)) throw failure("INVALID_INPUT");
    return physical(endpoint, method, params, "preflight");
  }
  async function readUnpinned(input) {
    if (!fields(input, ["method", "params"]) || Object.keys(input).length !== 2) rejection("INVALID_INPUT");
    if (!METHOD_SET.has(input.method)) rejection("METHOD_NOT_ALLOWED");
    if (!validParams(input.method, input.params)) rejection("INVALID_INPUT");
    const epoch = current();
    try { remaining(epoch); } catch (error) { rejection(error.code); }
    if (uncertain) rejection("RPC_FAILURE");
    if (!available(global, 1, epoch) || !available(ip, 1, epoch)) rejection("QUOTA_LIMIT");
    let reason = "QUOTA_LIMIT";
    for (let i = 0; i < endpoints.length; i += 1) {
      const index = (nextEndpoint + i) % endpoints.length;
      const endpoint = endpoints[index];
      const blocked = eligible(endpoint, input.method, epoch);
      if (!blocked) { nextEndpoint = (index + 1) % endpoints.length; return physical(endpoint, input.method, input.params, "unpinned"); }
      if (blocked === "COOLDOWN" || reason !== "COOLDOWN" && blocked === "SCOPE_DISABLED") reason = blocked;
    }
    rejection(reason);
  }
  async function qualifyPinned(input) {
    if (!fields(input, ["chainId", "probe"]) || Object.keys(input).length !== 2
      || !positive(input.chainId) || typeof input.probe !== "function") rejection("INVALID_INPUT");
    let epoch;
    try { epoch = current(); remaining(epoch); } catch (error) { rejection(error.code); }
    if (uncertain) rejection("RPC_FAILURE");
    if (limits.maxRequests - counters.physicalRequests < 94) rejection("NETWORK_CALL_CAP");
    if (new Set(endpoints.filter(endpoint => !families.get(endpoint.family).disabled && epoch >= families.get(endpoint.family).until)
      .map(endpoint => endpoint.family)).size < 2 || epoch < ip.until) rejection("QUALIFICATION_FAILED");
    const candidates = endpoints.map((endpoint, inventoryOrder) => ({
      handle: endpoint.handle, operatorFamily: endpoint.family, capabilityRank: endpoint.rank, inventoryOrder,
    }));
    const availableForPreflight = limits.maxRequests - counters.physicalRequests - 80;
    const ledger = createRpcLedger(qualifiedCall, availableForPreflight + 8);
    let admitted;
    try {
      admitted = await qualifyCommonFinalized({ chainId: input.chainId, candidates,
        minimumFamilies: 2, preferredFamilies: 2, rpc: ledger,
        limits: { maxCandidates: candidates.length, maxProbeCallsPerCandidate: 4, reserveRequests: 8, retries: 0 },
        probe: ({ reader, pin }) => input.probe(Object.freeze({ reader, pin })),
      });
    } catch (_) { throw failure("QUALIFICATION_FAILED"); }
    // qualifyCommonFinalized already validated raw headers and returns this
    // frozen normalized shape; normalizeHeader accepts raw hex fields only.
    const pin = admitted.pin;
    try {
      if (!fields(pin, ["number", "hash", "parentHash", "stateRoot", "timestamp"])
        || Object.keys(pin).length !== 5 || !Object.isFrozen(pin)
        || !Number.isSafeInteger(pin.number) || pin.number < 0
        || typeof pin.timestamp !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(pin.timestamp)
        || ![pin.hash, pin.parentHash, pin.stateRoot].every(value => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value))
        || !headerAge(pin, current()) || current() >= expires) throw failure("PIN_INVALID");
    }
    catch (_) { throw failure("PIN_INVALID"); }
    const chosen = admitted.selected;
    if (chosen.length !== 2 || new Set(chosen.map(row => row.candidate.operatorFamily)).size !== 2) throw failure("QUALIFICATION_FAILED");
    const primary = lookup(chosen[0].candidate.handle);
    const witnesses = chosen.map(row => lookup(row.candidate.handle));
    if (!primary || witnesses.some(row => !row)) throw failure("QUALIFICATION_FAILED");
    let invalid = false;
    let confirmed = false;
    let revision = 0;
    let generation = 0;
    let activeStateReads = 0;
    function invalidate() { invalid = true; confirmed = false; generation += 1; }
    function checkSession() {
      if (invalid) throw failure("SESSION_INVALID");
      try { if (!headerAge(pin, current()) || current() >= expires) throw failure("PIN_INVALID"); }
      catch (error) { invalidate(); throw failure(error?.code === "PIN_INVALID" ? "PIN_INVALID" : "DEADLINE"); }
    }
    async function readState(input) {
      try {
        checkSession();
        if (!fields(input, ["method", "params"]) || Object.keys(input).length !== 2) throw failure("INVALID_INPUT");
        if (!STATE_METHODS.has(input.method)) throw failure("METHOD_NOT_ALLOWED");
        if (!validParams(input.method, input.params, true)) throw failure("INVALID_INPUT");
        confirmed = false;
        revision += 1;
        const startedGeneration = generation;
        const canonicalAt = Object.freeze({ blockHash: pin.hash, requireCanonical: true });
        const params = input.method === "eth_getLogs" ? [{ ...input.params[0], blockHash: pin.hash }]
          : [...input.params, canonicalAt];
        activeStateReads += 1;
        try {
          const value = await physical(primary, input.method, params, "state");
          if (invalid || startedGeneration !== generation) throw failure("SESSION_INVALID");
          checkSession();
          return value;
        } finally { activeStateReads -= 1; }
      } catch (error) { invalidate(); throw failure(error?.code); }
    }
    async function confirmPin() {
      try {
        checkSession();
        if (activeStateReads > 0) throw failure("SESSION_INVALID");
        if (limits.maxRequests - counters.physicalRequests < 2) throw failure("NETWORK_CALL_CAP");
        confirmed = false;
        const version = ++revision;
        const startedGeneration = generation;
        const selector = `0x${pin.number.toString(16)}`;
        const headers = [];
        for (const endpoint of witnesses) {
          headers.push(await physical(endpoint, "eth_getBlockByNumber", [selector, false], "terminal"));
        }
        if (invalid || startedGeneration !== generation || version !== revision || activeStateReads > 0) throw failure("SESSION_INVALID");
        if (!headers.every(raw => {
          const header = normalizeHeader(raw);
          return header && JSON.stringify(header) === JSON.stringify(pin);
        })) throw failure("PIN_MISMATCH");
        checkSession();
        confirmed = true;
        return pin;
      } catch (error) { invalidate(); throw failure(error?.code); }
    }
    return Object.freeze({ pin: Object.freeze({ ...pin }), readState, confirmPin, invalidate });
  }
  function statistics() { return Object.freeze({ ...counters }); }
  return Object.freeze({ readUnpinned, qualifyPinned, statistics });
}

module.exports = Object.freeze({ createReadOnlyPinnedRpcPool });
