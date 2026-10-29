"use strict";

// Import-inert, injected sources only. No endpoint discovery, file IO, or CLI.
// rpc(method, params, id, timeoutMs) returns a decoded JSON-RPC result.
// sqd(route, { method, body?, signal, timeoutMs }) returns { status, headers,
// body: Web ReadableStream<Uint8Array> }. body in the request is a JSON object.
// Routes are only finalized-head (GET; JSON {number,hash}) and finalized-stream
// (POST; NDJSON). Transports must honor timeout/abort and cap response allocation.
// RPC byte accounting measures the JSON-encoded result, not HTTP framing.
const { performance } = require("node:perf_hooks");
const indexer = require("./compound-borrower-index");
const RPC_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"]);
const MAX = { blocks: 2000, pages: 16, requests: 48, runtime: 180000, bytes: 2 * 1024 * 1024, line: 256 * 1024, timeout: 30000 };
const integer = (n, min = 0, max = Number.MAX_SAFE_INTEGER - 1) => Number.isSafeInteger(n) && n >= min && n <= max;
const isHash = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
const hex = (n) => `0x${n.toString(16)}`;
class ComparisonError extends Error {
  constructor(code, details = {}) { super(code); this.details = details; }
}
const fail = (code, details) => { throw new ComparisonError(code, details); };
function quantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) fail("READ_INVALID");
  const number = Number(BigInt(value));
  if (!integer(number)) fail("READ_INVALID");
  return number;
}
function rpcHeader(value) {
  if (!value || !isHash(value.hash)) fail("READ_INVALID");
  const header = { number: quantity(value.number), hash: value.hash.toLowerCase(), timestamp: quantity(value.timestamp) };
  if (!header.timestamp) fail("READ_INVALID");
  return header;
}
function sqdHeader(value) {
  if (!keys(value, ["number", "hash", "parentHash"]) || !integer(value.number) || !isHash(value.hash) || !isHash(value.parentHash)) fail("READ_INVALID");
  return { number: value.number, hash: value.hash.toLowerCase(), parentHash: value.parentHash.toLowerCase() };
}
function parseJson(raw) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)); }
  catch (_) { fail("READ_INVALID"); }
}
function normalizedLogs(logs, range, pin) {
  try { return indexer.normalizeLogs(logs, { ...range, pin }); }
  catch (_) { fail("READ_INVALID"); }
}
function query(fromBlock, toBlock, { pinOnly = false, parentBlockHash } = {}) {
  const result = { type: "evm", fromBlock, toBlock, includeAllBlocks: true,
    fields: { block: { number: true, hash: true, parentHash: true } } };
  if (parentBlockHash !== undefined) result.parentBlockHash = parentBlockHash;
  if (!pinOnly) {
    result.fields.log = { logIndex: true, transactionIndex: true, transactionHash: true, address: true, topics: true, data: true };
    result.fields.transaction = { transactionIndex: true, hash: true, status: true };
    // Filter emitted events, not transaction destinations (including internal calls).
    result.logs = [{ address: [indexer.MARKET], topic0: indexer.TOPICS.slice(), transaction: true }];
  }
  return result;
}
function validatePage(rows, { fromBlock, toBlock, pin, parentBlockHash, pinOnly = false }) {
  if (!rows.length) fail("EMPTY_PAGE");
  const headers = [], mapped = [];
  let cursor = fromBlock, parent = parentBlockHash;
  for (const row of rows) {
    if (!keys(row, ["header", "logs", "transactions"])) fail("READ_INVALID");
    const header = sqdHeader(row.header);
    if (header.number !== cursor || header.number > toBlock) fail("BLOCK_SEQUENCE_INVALID");
    if ((parent !== undefined && header.parentHash !== parent) || (header.number === pin.number && header.hash !== pin.hash)) fail("PIN_OR_PARENT_MISMATCH");
    headers.push(header); cursor++; parent = header.hash;
    if (pinOnly) {
      if ((row.logs !== undefined && (!Array.isArray(row.logs) || row.logs.length))
          || (row.transactions !== undefined && (!Array.isArray(row.transactions) || row.transactions.length))) fail("READ_INVALID");
      continue;
    }
    // includeAllBlocks may omit empty collections, but never the explicit header.
    const hasLogs = Object.hasOwn(row, "logs"), hasTransactions = Object.hasOwn(row, "transactions");
    if ((hasLogs && !Array.isArray(row.logs)) || (hasTransactions && !Array.isArray(row.transactions))) fail("READ_INVALID");
    const logs = hasLogs ? row.logs : [], relatedTransactions = hasTransactions ? row.transactions : [];
    if ((!hasLogs && relatedTransactions.length) || (!hasTransactions && logs.length)) fail("READ_INVALID");
    const transactions = new Map();
    for (const tx of relatedTransactions) {
      if (!keys(tx, ["transactionIndex", "hash", "status"]) || !integer(tx.transactionIndex) || !isHash(tx.hash)
          || !integer(tx.status, 0, 1) || transactions.has(tx.transactionIndex)) fail("TRANSACTION_RELATION_INVALID");
      transactions.set(tx.transactionIndex, tx);
    }
    for (const log of logs) {
      if (!keys(log, ["logIndex", "transactionIndex", "transactionHash", "address", "topics", "data"])
          || !integer(log.logIndex) || !integer(log.transactionIndex) || !isHash(log.transactionHash)) fail("READ_INVALID");
      const tx = transactions.get(log.transactionIndex);
      if (!tx || tx.status !== 1 || tx.hash.toLowerCase() !== log.transactionHash.toLowerCase()) fail("TRANSACTION_RELATION_INVALID");
      mapped.push({ address: log.address, topics: log.topics, data: log.data, logIndex: hex(log.logIndex),
        transactionIndex: hex(log.transactionIndex), transactionHash: log.transactionHash,
        blockNumber: hex(header.number), blockHash: header.hash, removed: false });
    }
  }
  const range = { fromBlock, toBlock: cursor - 1 };
  return { ...range, headers, logs: normalizedLogs(mapped, range, pin) };
}

async function compareFinalizedRange({ rpc, sqd, pin, fromBlock, toBlock, seedBytes = null,
  maxPages = MAX.pages, maxRequests = MAX.requests, maxRuntimeMs = MAX.runtime,
  maxBytes = MAX.bytes, maxLineBytes = MAX.line, requestTimeoutMs = MAX.timeout,
  sqdIntervalMs = 5000, rpcIntervalMs = 2000,
  now = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof rpc !== "function" || typeof sqd !== "function" || rpc === sqd) fail("SOURCES_REQUIRED");
  pin = indexer.normalizedPin(pin);
  if (!integer(fromBlock, 0, pin.number) || !integer(toBlock, fromBlock, pin.number) || toBlock - fromBlock + 1 > MAX.blocks
      || !integer(maxPages, 0, MAX.pages) || !integer(maxRequests, 0, MAX.requests) || !integer(maxRuntimeMs, 1, MAX.runtime)
      || !integer(maxBytes, 1, MAX.bytes) || !integer(maxLineBytes, 1, MAX.line) || !integer(requestTimeoutMs, 1, MAX.timeout)
      || !integer(sqdIntervalMs, 0, MAX.runtime) || !integer(rpcIntervalMs, 0, MAX.runtime)
      || typeof now !== "function" || typeof sleep !== "function") fail("INPUT_INVALID");
  const seed = seedBytes === null ? null : indexer.parseSeed(seedBytes);
  if (seed && seed.provenance.pin.number > pin.number) fail("SEED_PIN_AHEAD");
  let lastNow = -Infinity;
  const clock = () => {
    const tick = now();
    if (!Number.isFinite(tick) || tick < lastNow) fail("TIME_BUDGET_EXCEEDED");
    lastNow = tick; return tick;
  };
  const started = clock(), deadline = started + maxRuntimeMs;
  const counters = { requests: 0, rpcRequests: 0, sqdRequests: 0, dataPages: 0, responseBytes: 0 };
  const lastStarts = { rpc: -Infinity, sqd: -Infinity };
  const intervals = { rpc: rpcIntervalMs, sqd: sqdIntervalMs };
  const staged = [], users = new Set(seed?.users ?? []);
  const observations = { rpcFinalizedHead: null, sqdFinalizedHead: null, initial: { rpc: null, sqd: null }, final: { rpc: null, sqd: null } };
  let initialPinVerified = false, rechecked = false, cursor = fromBlock, failure = null;

  function account(length) {
    if (!integer(length) || length > maxBytes - counters.responseBytes) fail("BYTE_LIMIT_EXCEEDED");
    counters.responseBytes += length;
  }
  // Calls are awaited serially, including cancellation and stream EOF. No detached
  // Promise.race losers: supplied transports must settle after timeout/abort.
  async function request(source, action, { dataPage = false } = {}) {
    const requestDeadline = Math.min(deadline, clock() + requestTimeoutMs);
    if (counters.requests >= maxRequests) fail("REQUEST_LIMIT_EXCEEDED");
    let tick = clock();
    while (tick < lastStarts[source] + intervals[source]) {
      const wait = lastStarts[source] + intervals[source] - tick;
      if (tick + wait >= requestDeadline) fail("TIME_BUDGET_EXCEEDED");
      try { await sleep(wait); } catch (_) { fail("TIME_BUDGET_EXCEEDED"); }
      const next = clock();
      if (next <= tick) fail("TIME_BUDGET_EXCEEDED");
      tick = next;
    }
    if (tick >= requestDeadline) fail("TIME_BUDGET_EXCEEDED");
    const controller = new AbortController();
    let reader = null, cancelling = null, timedOut = false, failed = true;
    const cancel = () => {
      if (reader && !cancelling) {
        try { cancelling = Promise.resolve(reader.cancel()).catch(() => {}); }
        catch (_) { cancelling = Promise.resolve(); }
      }
      return cancelling;
    };
    const timer = setTimeout(() => { timedOut = true; controller.abort(); cancel(); }, requestDeadline - tick);
    const check = () => { if (timedOut || clock() >= requestDeadline) fail("TIME_BUDGET_EXCEEDED"); };
    lastStarts[source] = tick; counters.requests++; counters[`${source}Requests`]++;
    if (dataPage) counters.dataPages++;
    try {
      const value = await action({ signal: controller.signal, id: counters.requests, timeoutMs: requestDeadline - tick, check,
        attachReader: (body) => {
          if (!body || typeof body.getReader !== "function") fail("RESPONSE_INVALID");
          try { reader = body.getReader(); } catch (_) { fail("RESPONSE_INVALID"); }
          if (!reader || typeof reader.read !== "function" || typeof reader.cancel !== "function" || typeof reader.releaseLock !== "function") fail("RESPONSE_INVALID");
          return reader;
        } });
      check(); failed = false; return value;
    } catch (error) {
      check();
      if (error instanceof ComparisonError) throw error;
      fail(source === "rpc" ? "RPC_FAILURE" : "SQD_FAILURE");
    } finally {
      clearTimeout(timer);
      if (failed) { controller.abort(); cancel(); }
      if (cancelling) await cancelling;
      if (reader) { try { reader.releaseLock(); } catch (_) {} }
    }
  }
  async function rpcRead(method, params) {
    if (!RPC_METHODS.has(method)) fail("READ_ONLY_METHOD_REQUIRED");
    return request("rpc", async (context) => {
      const value = await rpc(method, params, context.id, context.timeoutMs);
      context.check();
      let encoded; try { encoded = JSON.stringify(value); } catch (_) { fail("READ_INVALID"); }
      if (typeof encoded !== "string") fail("READ_INVALID");
      account(Buffer.byteLength(encoded)); return value;
    });
  }
  async function sqdRead(route, body, { dataPage = false } = {}) {
    if (!["finalized-head", "finalized-stream"].includes(route)) fail("READ_ONLY_METHOD_REQUIRED");
    return request("sqd", async (context) => {
      const response = await sqd(route, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body }),
        signal: context.signal, timeoutMs: context.timeoutMs });
      // Attach before checking status/headers, so even an HTTP-error body is cancelled.
      const reader = response?.body == null ? null : context.attachReader(response.body);
      context.check();
      if (!response || !integer(response.status, 100, 599) || !response.headers || typeof response.headers.get !== "function") fail("RESPONSE_INVALID");
      const header = (name) => {
        let value; try { value = response.headers.get(name); } catch (_) { fail("RESPONSE_INVALID"); }
        if (value !== null && (typeof value !== "string" || value.length > 1024 || /[\r\n\0]/.test(value))) fail("RESPONSE_INVALID");
        return value;
      };
      const retry = header("retry-after"), contentLength = header("content-length");
      const retryAfterSeconds = retry !== null && /^(?:0|[1-9][0-9]{0,5})$/.test(retry) && Number(retry) <= 86400 ? Number(retry) : null;
      if (contentLength !== null && !/^(?:0|[1-9][0-9]*)$/.test(contentLength)) fail("RESPONSE_INVALID");
      if (response.status !== 200) {
        const code = ({ 204: "INCOMPLETE_NOT_INDEXED", 409: "PIN_OR_PARENT_MISMATCH", 429: "RATE_LIMIT", 529: "SERVICE_OVERLOADED" })[response.status] ?? "HTTP_ERROR";
        fail(code, { httpStatus: response.status, retryAfterSeconds });
      }
      if (!reader) fail("RESPONSE_INVALID");
      if (contentLength !== null && BigInt(contentLength) > BigInt(maxBytes - counters.responseBytes)) fail("BYTE_LIMIT_EXCEEDED");
      const rows = [], parts = []; let lineBytes = 0;
      const append = (part) => {
        if (lineBytes + part.length > maxLineBytes) fail("LINE_LIMIT_EXCEEDED");
        if (part.length) { parts.push(Buffer.from(part)); lineBytes += part.length; }
      };
      const line = () => {
        if (!lineBytes) fail("READ_INVALID");
        rows.push(parseJson(Buffer.concat(parts, lineBytes))); parts.length = 0; lineBytes = 0;
        if (rows.length > (route === "finalized-head" ? 1 : body.toBlock - body.fromBlock + 1)) fail("BLOCK_SEQUENCE_INVALID");
      };
      while (true) {
        context.check();
        let chunk; try { chunk = await reader.read(); } catch (_) { context.check(); fail("STREAM_FAILURE"); }
        context.check();
        if (!chunk || typeof chunk.done !== "boolean") fail("RESPONSE_INVALID");
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) fail("RESPONSE_INVALID");
        account(chunk.value.byteLength);
        if (route === "finalized-head") { append(chunk.value); continue; }
        let offset = 0;
        for (let i = 0; i < chunk.value.length; i++) {
          if (chunk.value[i] !== 10) continue;
          append(chunk.value.subarray(offset, i)); line(); offset = i + 1;
        }
        append(chunk.value.subarray(offset));
      }
      // Complete JSON at EOF is valid without a final newline; incomplete JSON is not.
      if (lineBytes) line();
      if (!rows.length) fail("EMPTY_PAGE");
      return rows;
    }, { dataPage });
  }
  async function observeRpcPin() {
    const header = rpcHeader(await rpcRead("eth_getBlockByNumber", [hex(pin.number), false]));
    if (header.number !== pin.number || header.hash !== pin.hash || header.timestamp !== pin.timestamp) fail("PIN_OR_PARENT_MISMATCH");
    return header;
  }
  async function observeSqdPin() {
    const rows = await sqdRead("finalized-stream", query(pin.number, pin.number, { pinOnly: true }));
    const page = validatePage(rows, { fromBlock: pin.number, toBlock: pin.number, pin, pinOnly: true });
    return page.headers[0];
  }

  try {
    if (quantity(await rpcRead("eth_chainId", [])) !== indexer.CHAIN_ID) fail("CHAIN_MISMATCH");
    observations.rpcFinalizedHead = rpcHeader(await rpcRead("eth_getBlockByNumber", ["finalized", false]));
    if (observations.rpcFinalizedHead.number < pin.number) fail("FINALIZED_BOUND_STALE");
    observations.initial.rpc = await observeRpcPin();
    const [head] = await sqdRead("finalized-head");
    if (!keys(head, ["number", "hash"]) || !integer(head.number) || !isHash(head.hash)) fail("READ_INVALID");
    observations.sqdFinalizedHead = { number: head.number, hash: head.hash.toLowerCase() };
    if (head.number < pin.number) fail("FINALIZED_BOUND_STALE");
    if (head.number === pin.number && head.hash.toLowerCase() !== pin.hash) fail("PIN_OR_PARENT_MISMATCH");
    observations.initial.sqd = await observeSqdPin();
    initialPinVerified = true;
    let parentBlockHash;
    while (cursor <= toBlock) {
      if (counters.dataPages >= maxPages) fail("PAGE_LIMIT_EXCEEDED");
      const rows = await sqdRead("finalized-stream", query(cursor, toBlock, { parentBlockHash }), { dataPage: true });
      const page = validatePage(rows, { fromBlock: cursor, toBlock, pin, parentBlockHash });
      const rpcLogs = normalizedLogs(await rpcRead("eth_getLogs", [{ address: indexer.MARKET,
        fromBlock: hex(cursor), toBlock: hex(page.toBlock), topics: [indexer.TOPICS.slice()] }]), page, pin);
      if (JSON.stringify(rpcLogs) !== JSON.stringify(page.logs)) fail("LOG_MISMATCH");
      const nextUsers = new Set(users);
      for (const log of page.logs) { const user = `0x${log.topics[1].slice(-40)}`; if (!/^0x0{40}$/.test(user)) nextUsers.add(user); }
      if (nextUsers.size > indexer.CANDIDATE_CAP) fail("DISCOVERY_BOUND_EXCEEDED");
      nextUsers.forEach((user) => users.add(user));
      staged.push(page); cursor = page.toBlock + 1; parentBlockHash = page.headers.at(-1).hash;
    }
    observations.final.rpc = await observeRpcPin();
    observations.final.sqd = await observeSqdPin();
    if (clock() >= deadline) fail("TIME_BUDGET_EXCEEDED");
    rechecked = true;
  } catch (error) {
    failure = error instanceof ComparisonError ? error : new ComparisonError("READ_INVALID");
  }
  const allCandidates = [...users].sort(), stagedLogs = staged.flatMap((page) => page.logs);
  return { schema: "compound-v3-base-sqd-comparison/v1", status: rechecked ? "COMPLETE" : "INCOMPLETE",
    reason: failure?.message ?? null, sourceKinds: { rpc: "CALLER_QUALIFIED_BASE_JSON_RPC", sqd: "SEPARATELY_SUPPLIED_SQD_FINALIZED_DATASET" },
    backendIndependenceEstablished: false, pin, pinVerified: rechecked, rechecked,
    requestedRange: { fromBlock, toBlock }, fullHistoryEstablished: false, fullMarketCoverageEstablished: false,
    pinObservations: observations, seedProvenance: seed?.provenance ?? null,
    pages: rechecked ? staged : [], logs: rechecked ? stagedLogs : [], candidates: rechecked ? allCandidates : (seed?.users ?? []),
    coveredBlocks: rechecked ? toBlock - fromBlock + 1 : 0, nextCursor: rechecked ? toBlock + 1 : fromBlock,
    gaps: rechecked ? [] : [{ fromBlock, toBlock, reason: failure.message }],
    provisional: rechecked ? null : { initialPinVerified, pinRechecked: false, pages: staged, logs: stagedLogs,
      candidates: allCandidates, observedBlocks: cursor - fromBlock, nextCursor: cursor, coverageClaimsTrusted: false },
    diagnostics: { ...counters, elapsedMs: lastNow - started, httpStatus: failure?.details.httpStatus ?? null,
      retryAfterSeconds: failure?.details.retryAfterSeconds ?? null, byteAccounting: "SQD_BODY_BYTES_PLUS_RPC_JSON_VALUE_BYTES" },
    limits: { maxPages, maxRequests, maxRuntimeMs, maxBytes, maxLineBytes, requestTimeoutMs, sqdIntervalMs, rpcIntervalMs } };
}

module.exports = { compareFinalizedRange };
