"use strict";

// Import-inert diagnostic matrix: no inventory, CLI, persistence or pair selection.
const { performance } = require("node:perf_hooks");
const { keccak256 } = require("ethers");
const EXPIRY = Date.parse("2026-10-21T00:00:00Z");
const ACTOR = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const SELECTOR = "0x355e937d";
const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// Public committed executor fingerprints; no collector import or source-equivalence claim.
const TARGETS = Object.freeze({
  1: Object.freeze({ executor: "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4", vault: "0x657d9aba1dbb59e53f9f3ecaa878447dcfc96dcb",
    runtimeHash: "0x215e7db8f7c5bb0cc1e7c16c9cce6c325046a62b7ec08e72f20b381e03482617" }),
  8453: Object.freeze({ executor: "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32", vault: "0x0000000f2eb9f69274678c76222b35eec7588a65",
    runtimeHash: "0x9d8776039d0473879cb7fcf6d8e7263eedf08aceb310b50161f377491b086b7b" })
});
const LIMITS = Object.freeze({ maxCandidates: 128, maxRequests: 1024, maxBytes: 64 * 1024 * 1024,
  maxResponseBytes: 1024 * 1024, sessionMs: 15 * 60 * 1000, requestMs: 8000, maxConcurrency: 2 });
const CHECKS = Object.freeze(["CHAIN_ID", "FINALIZED_HEADER", "ACTOR_NUMBER", "ACTOR_HASH", "EXECUTOR_CODE",
  "IMPLEMENTATION_SLOT", "NUMBER_RECHECK", "FINALIZED_RECHECK"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const quantity = value => typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value);
const hex = value => typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const hash = value => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
class SweepError extends Error {
  constructor(reason, diagnostic = null, ordinary = false) {
    super(reason); this.name = "SweepError"; this.code = reason;
    this.diagnostic = diagnostic; this.ordinary = ordinary;
  }
}
const fail = reason => { throw new SweepError(reason); };
function settings(input) {
  if (input === undefined) return LIMITS;
  if (!record(input) || Object.keys(input).some(key => !Object.hasOwn(LIMITS, key))) fail("INVALID_INPUT");
  const result = { ...LIMITS, ...input };
  for (const key of Object.keys(LIMITS)) if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > LIMITS[key]) fail("INVALID_INPUT");
  return Object.freeze(result);
}
function routeUrl(value, origin = false) {
  if (typeof value !== "string" || value.length > 8192 || /[\s\x00-\x1f\x7f\\]/.test(value)) fail("INVALID_INPUT");
  let url;
  try { url = new URL(value); } catch (_) { fail("INVALID_INPUT"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || (origin && (url.pathname !== "/" || url.search))) fail("INVALID_INPUT");
  return value;
}
function copyCandidates(input, maximum) {
  if (!Array.isArray(input) || input.length < 1 || input.length > maximum) fail("INVALID_INPUT");
  // Never stringify the protected array or retain its methods/arbitrary metadata.
  return Array.from(input, value => {
    if (!record(value) || ![1, 8453].includes(value.chainId) || !["single", "batch", "chain-body"].includes(value.format)
      || typeof value.family !== "string" || !value.family.length || value.family.length > 256
      || typeof value.reviewedFamily !== "boolean") fail("INVALID_INPUT");
    return Object.freeze({ chainId: value.chainId, handle: routeUrl(value.handle),
      origin: value.origin === null ? null : routeUrl(value.origin, true), format: value.format,
      family: value.family, reviewedFamily: value.reviewedFamily });
  });
}
function classify(body, id, outboundCheck) {
  const result = record(body) && Object.hasOwn(body, "result"), error = record(body) && Object.hasOwn(body, "error");
  const rpcError = error ? body.error : null;
  const validError = record(rpcError) && Number.isSafeInteger(rpcError.code) && typeof rpcError.message === "string"
    && Object.keys(rpcError).every(key => ["code", "message", "data"].includes(key));
  let errorClass = error ? "MALFORMED" : "ABSENT";
  if (error && validError) {
    switch (rpcError.code) {
      case -32700: errorClass = "PARSE_ERROR"; break;
      case -32600: errorClass = "INVALID_REQUEST"; break;
      case -32602: errorClass = "INVALID_PARAMS"; break;
      case -32601: errorClass = "UNSUPPORTED_METHOD"; break;
      case 3: errorClass = "EXECUTION_REVERT_CODE"; break;
      default: errorClass = "OTHER";
    }
  }
  return Object.freeze({ outboundCheck,
    responseIdClass: !record(body) ? "INVALID" : !Object.hasOwn(body, "id") ? "MISSING" : body.id === id ? "MATCH"
      : body.id === null ? "NULL" : typeof body.id === "string" ? body.id === String(id) ? "DECIMAL_STRING_EQUIVALENT" : "OTHER_STRING"
      : Number.isSafeInteger(body.id) ? "OTHER_NUMBER" : "INVALID",
    branch: result ? error ? "BOTH" : "RESULT" : error ? "ERROR" : "NEITHER",
    envelopeExceptIdValid: record(body) && body.jsonrpc === "2.0" && result !== error
      && exact(body, ["jsonrpc", "id", result ? "result" : "error"]) && (!error || validError), errorClass });
}
function outboundCheck(text, expected, format) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return "SERIALIZATION_INVALID"; }
  if (format === "batch") {
    if (!Array.isArray(parsed) || parsed.length !== 1) return "ENVELOPE_MISMATCH";
    parsed = parsed[0];
  }
  const keys = format === "chain-body" ? ["jsonrpc", "id", "method", "params", "chainId"] : ["jsonrpc", "id", "method", "params"];
  if (!exact(parsed, keys) || parsed.jsonrpc !== "2.0" || parsed.id !== expected.id || parsed.method !== expected.method
    || (format === "chain-body" && parsed.chainId !== expected.chainId)) return "ENVELOPE_MISMATCH";
  return JSON.stringify(parsed.params) === JSON.stringify(expected.params) ? "MATCH" : "PARAMS_MISMATCH";
}
function normalizedHeader(value, time) {
  if (value === null) fail("NULL_HEADER");
  if (!record(value) || !quantity(value.number) || !quantity(value.timestamp)
    || ![value.hash, value.parentHash, value.stateRoot].every(hash)) fail("HEADER_SCHEMA");
  const seconds = BigInt(Math.floor(time / 1000)), timestamp = BigInt(value.timestamp);
  if (timestamp < seconds - 3600n || timestamp > seconds + 60n) fail("HEADER_FRESHNESS");
  return { number: `0x${BigInt(value.number).toString(16)}`, hash: value.hash.toLowerCase(),
    parentHash: value.parentHash.toLowerCase(), stateRoot: value.stateRoot.toLowerCase(), timestamp: `0x${timestamp.toString(16)}` };
}
const sameHeader = (a, b) => ["number", "hash", "parentHash", "stateRoot", "timestamp"].every(key => a[key] === b[key]);

async function sweepEndpoints(options) {
  let candidates, limits, fetcher, now, startedAt, hardExpiry;
  try {
    if (!record(options)) fail("INVALID_INPUT");
    hardExpiry = options.hardExpiry === undefined ? EXPIRY : options.hardExpiry;
    if (!Number.isSafeInteger(hardExpiry) || hardExpiry <= 0 || hardExpiry > Date.parse("2026-10-21T01:30:00Z")) fail("INVALID_INPUT");
    limits = settings(options.limits); candidates = copyCandidates(options.candidates, limits.maxCandidates);
    fetcher = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
    now = options.now === undefined ? Date.now : options.now;
    if (typeof fetcher !== "function" || typeof now !== "function") fail("INVALID_INPUT");
    startedAt = now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) fail("INVALID_INPUT");
  } catch (_) { throw new SweepError("INVALID_INPUT"); }
  options = null;
  const monoStart = performance.now(), controllers = new Set(), lastStart = new Map(), stopController = new AbortController();
  const reviewedPassFamilies = new Set();
  let stopReason = null, physicalRequests = 0, bytes = 0, nextCandidate = 0, deadlineTimer;
  const rows = candidates.map((candidate, index) => ({ candidateOrdinal: index + 1, chainId: candidate.chainId,
    status: "NOT_TESTED", reason: null, complete: false, identityAccepted: false, pin: null, runtimeBound: null,
    physicalRequests: 0, aggregateConsumedBytes: 0,
    checks: CHECKS.map(check => ({ check, status: "NOT_TESTED", reason: null, observation: null, transportDiagnostic: null })) }));
  function stop(reason) {
    if (!stopReason) stopReason = reason;
    stopController.abort();
    for (const controller of controllers) controller.abort();
    return new SweepError(stopReason);
  }
  function clock() {
    let time;
    try { time = now(); } catch (_) { throw stop("CLOCK_ERROR"); }
    if (!Number.isSafeInteger(time) || time < startedAt) throw stop("CLOCK_ERROR");
    return { time, elapsed: Math.max(time - startedAt, performance.now() - monoStart) };
  }
  function alive() {
    if (stopReason) throw new SweepError(stopReason);
    const current = clock();
    if (current.time >= hardExpiry) throw stop("EXPIRED");
    if (current.elapsed >= limits.sessionMs) throw stop("DEADLINE");
    return current;
  }
  function delay(ms) {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); stopController.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      stopController.signal.addEventListener("abort", done, { once: true });
      if (stopReason) done();
    });
  }
  async function pace(family) {
    for (;;) {
      const current = alive(), remaining = (lastStart.get(family) ?? -Infinity) + 500 - current.elapsed;
      if (remaining <= 0) return;
      await delay(Math.ceil(remaining));
    }
  }
  async function request(candidate, row, method, params) {
    let controller, timer, reader, response, timedOut = false;
    try {
      let current;
      for (;;) {
        await pace(candidate.family);
        current = alive();
        // Another same-family worker may have started while pace was awaited.
        if (current.elapsed - (lastStart.get(candidate.family) ?? -Infinity) >= 500) break;
      }
      if (physicalRequests >= limits.maxRequests) throw stop("REQUEST_CAP");
      if (bytes >= limits.maxBytes) throw stop("BYTE_CAP");
      lastStart.set(candidate.family, current.elapsed);
      const id = ++physicalRequests; row.physicalRequests += 1;
      controller = new AbortController(); controllers.add(controller);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.requestMs);
      const expected = { jsonrpc: "2.0", id, method, params, ...(candidate.format === "chain-body" ? { chainId: candidate.chainId } : {}) };
      const serialized = JSON.stringify(candidate.format === "batch" ? [expected] : expected);
      const outbound = outboundCheck(serialized, expected, candidate.format);
      response = await fetcher(candidate.handle, { method: "POST", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(candidate.origin === null ? {} : { Origin: candidate.origin }) }, body: serialized });
      alive();
      if (timedOut) fail("REQUEST_TIMEOUT");
      if (!response || response.redirected || (response.status >= 300 && response.status < 400)) fail("REDIRECT");
      if (response.status !== 200) fail("HTTP_STATUS");
      if (!response.body || typeof response.body.getReader !== "function") fail("BODY_SCHEMA");
      reader = response.body.getReader();
      const chunks = []; let responseBytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (!chunk.done && chunk.value instanceof Uint8Array) {
          bytes += chunk.value.byteLength; row.aggregateConsumedBytes += chunk.value.byteLength; responseBytes += chunk.value.byteLength;
          if (bytes > limits.maxBytes) throw stop("BYTE_CAP");
          if (responseBytes > limits.maxResponseBytes) fail("RESPONSE_CAP");
          chunks.push(Buffer.from(chunk.value));
        } else if (!chunk.done) fail("STREAM_SCHEMA");
        alive(); if (timedOut) fail("REQUEST_TIMEOUT");
        if (chunk.done) break;
      }
      let text, body;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, responseBytes)); } catch (_) { fail("INVALID_UTF8"); }
      try { body = JSON.parse(text); } catch (_) { fail("INVALID_JSON"); }
      if (candidate.format === "batch") {
        if (!Array.isArray(body) || body.length !== 1) fail("BATCH_SHAPE");
        body = body[0];
      }
      const diagnostic = classify(body, id, outbound);
      const reject = reason => { throw new SweepError(reason, diagnostic); };
      if (!record(body)) reject("ENVELOPE_SHAPE");
      if (body.jsonrpc !== "2.0") reject("ENVELOPE_VERSION");
      if (body.id !== id) reject("ENVELOPE_ID");
      if (Object.hasOwn(body, "result") === Object.hasOwn(body, "error")) reject("ENVELOPE_XOR");
      if (!exact(body, ["jsonrpc", "id", Object.hasOwn(body, "result") ? "result" : "error"])) reject("ENVELOPE_KEYS");
      if (Object.hasOwn(body, "error")) {
        if (diagnostic.errorClass === "MALFORMED") reject("RPC_ERROR_SCHEMA");
        throw new SweepError("RPC_ERROR", diagnostic, true);
      }
      return { value: body.result, diagnostic };
    } catch (cause) {
      if (stopReason) throw new SweepError(stopReason);
      if (timedOut) throw new SweepError("REQUEST_TIMEOUT");
      throw cause instanceof SweepError ? cause : new SweepError("TRANSPORT_ERROR");
    } finally {
      clearTimeout(timer); controller?.abort();
      try {
        if (reader) { await reader.cancel(); reader.releaseLock(); }
        else if (response?.body && typeof response.body.cancel === "function") await response.body.cancel();
      } catch (_) { /* No transport text escapes cleanup. */ }
      if (controller) controllers.delete(controller);
    }
  }
  async function endpoint(candidate, row) {
    const target = TARGETS[candidate.chainId];
    const probe = Object.freeze({ from: ACTOR, to: target.executor, data: SELECTOR });
    for (let index = 0; index < CHECKS.length; index += 1) {
      const check = row.checks[index];
      let diagnostic = null;
      try {
        alive();
        const canonical = row.pin ? { blockHash: row.pin.hash, requireCanonical: true } : null;
        const methods = ["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_getBlockByNumber", "eth_getBlockByNumber"];
        const params = [[], ["finalized", false], [probe, row.pin?.number], [probe, canonical],
          [target.executor, canonical], [target.vault, SLOT, canonical], [row.pin?.number, false], ["finalized", false]][index];
        const response = await request(candidate, row, methods[index], params);
        alive(); // No accepted observation from a body that completed after a global stop.
        diagnostic = response.diagnostic;
        const value = response.value;
        check.status = "PASS";
        if (index === 0) {
          if (!quantity(value)) fail("CHAIN_QUANTITY");
          if (BigInt(value) !== BigInt(candidate.chainId)) fail("CHAIN_MISMATCH");
          row.identityAccepted = true;
        } else if ([1, 6, 7].includes(index)) {
          const header = normalizedHeader(value, alive().time);
          if (index === 1) row.pin = header;
          else if (index === 6 && !sameHeader(header, row.pin)) fail("PIN_DRIFT");
          else if (index === 7 && (BigInt(header.number) < BigInt(row.pin.number)
            || (header.number === row.pin.number && !sameHeader(header, row.pin)))) fail("FINALITY_DRIFT");
          check.observation = header;
        } else if (index === 2 || index === 3) {
          if (typeof value !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) fail("ACTOR_SHAPE");
          const actor = `0x${value.slice(26).toLowerCase()}`;
          if (actor !== ACTOR) fail("ACTOR_MISMATCH");
          check.observation = { actor };
        } else if (index === 4) {
          if (!hex(value)) fail("CODE_HEX");
          const fingerprint = keccak256(value);
          row.runtimeBound = value !== "0x" && fingerprint === target.runtimeHash;
          check.observation = { runtimeBytes: (value.length - 2) / 2, runtimeKeccak256: fingerprint, runtimeBound: row.runtimeBound };
          if (!row.runtimeBound) { check.status = "FAIL"; check.reason = value === "0x" ? "CODE_EMPTY" : "RUNTIME_MISMATCH"; check.transportDiagnostic = diagnostic; }
        } else {
          if (!hex(value) || value.length !== 66) fail("STORAGE_HEX");
          check.observation = { zero: /^0x0{64}$/.test(value), implementationAddress: /^0x0{24}[0-9a-fA-F]{40}$/.test(value) ? `0x${value.slice(26).toLowerCase()}` : null };
        }
      } catch (cause) {
        const failure = stopReason ? new SweepError(stopReason) : cause instanceof SweepError ? cause : new SweepError("INTERNAL_ERROR");
        if (row.physicalRequests === 0 && stopReason) { row.reason = stopReason; return; }
        check.status = failure.ordinary ? "RPC_ERROR" : "FAIL";
        check.reason = failure.code; check.transportDiagnostic = stopReason ? null : failure.diagnostic || diagnostic;
        if (!failure.ordinary || !row.identityAccepted || !row.pin) {
          for (const later of row.checks.slice(index + 1)) { later.status = "SKIPPED"; later.reason = stopReason || "ENDPOINT_STOPPED"; }
          break;
        }
      }
    }
    row.complete = row.checks.every(check => ["PASS", "FAIL", "RPC_ERROR"].includes(check.status));
    row.status = row.checks.every(check => check.status === "PASS") ? "PASS" : "FAIL";
    row.reason = row.checks.find(check => check.status !== "PASS")?.reason ?? null;
    if (row.status === "PASS" && candidate.reviewedFamily) reviewedPassFamilies.add(candidate.family);
  }
  async function worker() {
    while (!stopReason && nextCandidate < candidates.length) {
      const index = nextCandidate++;
      await endpoint(candidates[index], rows[index]);
    }
  }
  if (startedAt >= hardExpiry) stop("EXPIRED");
  else deadlineTimer = setTimeout(() => stop(hardExpiry - startedAt <= limits.sessionMs ? "EXPIRED" : "DEADLINE"), Math.min(limits.sessionMs, hardExpiry - startedAt));
  try { await Promise.all(Array.from({ length: Math.min(limits.maxConcurrency, candidates.length) }, () => worker())); }
  finally { clearTimeout(deadlineTimer); }
  // Workers await fetch and reader cancellation; no timeout Promise.race leaves detached work.
  for (const row of rows) if (row.status === "NOT_TESTED") row.reason = stopReason;
  let elapsedMs = null;
  try { elapsedMs = Math.floor(clock().elapsed); } catch (_) { /* Fixed global clock error is already latched. */ }
  const attempted = rows.filter(row => row.physicalRequests > 0).length;
  const result = { status: stopReason || attempted !== rows.length ? "PARTIAL" : "COMPLETE", stopReason, drained: controllers.size === 0,
    counts: { candidates: rows.length, attempted, notTested: rows.length - attempted, passed: rows.filter(row => row.status === "PASS").length,
      failed: rows.filter(row => row.status === "FAIL").length, physicalRequests, aggregateConsumedBytes: bytes, elapsedMs },
    distinctReviewedFamiliesWithCompletePass: reviewedPassFamilies.size, rows };
  candidates = null; fetcher = null; now = null; lastStart.clear(); reviewedPassFamilies.clear();
  return result;
}

module.exports = Object.freeze({ sweepEndpoints, LIMITS });
