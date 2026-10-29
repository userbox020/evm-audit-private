"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATASET_BASE = "https://portal.sqd.dev/datasets/base-mainnet";
const FACTORY_MANIFEST = "targets/fluid-contracts-public/deployments/base/VaultFactory.json";
const PROVIDER_MATRIX = "fluid_evm_provider_matrix.md";
const RPC_INVENTORY = "rpc_endpoints.txt";
const MAX_WINDOW_BLOCKS = 4096;
const MAX_PAGES = 32;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 50_000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const SUCCESS_STATUS = "INCOMPLETE_EVENT_ONLY_CANNOT_EXCLUDE_SPELL";
const COMPLETE_STATUS = "COMPLETE_DISCOVERY_NO_SURVIVOR";
const DELTA_STATUS = "DISCOVERY_DELTA_UNBOUND";
// Exact local declaration: main.sol:184 function spell(address target_, bytes memory data_).
const SPELL_SIGNATURE = "spell(address,bytes)";
const SPELL_SELECTOR = "0xc7acb01f";
const TRACE_TYPES = Object.freeze(["call", "delegatecall", "staticcall"]);
const BASE_CHAIN_ID = 8453n;
const REQUAL_LIMITS = Object.freeze({
  requests: 32,
  requestMs: 15_000,
  wallMs: 120_000,
  responseBytes: 4 * 1024 * 1024,
  totalResponseBytes: 20 * 1024 * 1024,
  records: 50_000,
  pages: 16,
  evidenceBytes: 1024 * 1024
});

// Exact signatures are taken from the local Fluid vault factory declarations in
// contracts/protocols/vault/factory/main.sol and deploymentLogics/vaultT4Logic.sol.
const EVENT_DEFINITIONS = Object.freeze([
  Object.freeze({
    eventClass: "VaultDeployed",
    signature: "VaultDeployed(address,uint256)",
    topic0: "0x00fa89a51ae01c150bfde909191818194382d30b43b645428ed6a71f19551073",
    topicKinds: Object.freeze(["address", "uint256"]),
    dataWords: 0
  }),
  Object.freeze({
    eventClass: "VaultT4Deployed",
    signature: "VaultT4Deployed(address,uint256,address,address)",
    topic0: "0x4b2bfb33ad24dcef9319f290b974e50081def081b7a43561ade90d78d068514e",
    topicKinds: Object.freeze(["address", "address", "address"]),
    dataWords: 1
  }),
  Object.freeze({
    eventClass: "LogSetDeployer",
    signature: "LogSetDeployer(address,bool)",
    topic0: "0x48cc5b4660fae22eabe5e803ee595e63572773d114bcd54ecc118c1efa8d75af",
    topicKinds: Object.freeze(["address", "bool"]),
    dataWords: 0
  }),
  Object.freeze({
    eventClass: "LogSetGlobalAuth",
    signature: "LogSetGlobalAuth(address,bool)",
    topic0: "0x0a1c6cd77aa2e405e482adf6ee6cf190a27682b6dd1234403f7602e5203c83bb",
    topicKinds: Object.freeze(["address", "bool"]),
    dataWords: 0
  }),
  Object.freeze({
    eventClass: "LogSetVaultAuth",
    signature: "LogSetVaultAuth(address,bool,address)",
    topic0: "0x7aee16d2c366535c2577e873699b458af55a0b0bd4c4fab5e930a780f05669d7",
    topicKinds: Object.freeze(["address", "bool", "address"]),
    dataWords: 0
  }),
  Object.freeze({
    eventClass: "LogSetVaultDeploymentLogic",
    signature: "LogSetVaultDeploymentLogic(address,bool)",
    topic0: "0x6e71f281df08e5962589123c1ca39a8c9df25c6c9cfa7b6d1525effed3dafd21",
    topicKinds: Object.freeze(["address", "bool"]),
    dataWords: 0
  })
]);

const EVENT_BY_TOPIC = new Map(EVENT_DEFINITIONS.map((item) => [item.topic0, item]));
const HASH = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const WORD = /^0x[0-9a-f]{64}$/u;
const ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/u;
const BOOL_WORD = /^0x0{63}[01]$/u;

class WatcherError extends Error {
  constructor(code) {
    super(code);
    this.name = "WatcherError";
    this.code = code;
  }
}

const stop = (code) => { throw new WatcherError(code); };

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function commitment(namespace, value) {
  return `${namespace}_${crypto.createHash("sha256").update(`${namespace}:${value}`).digest("base64url")}`;
}

function withDerivedHash(core) {
  return { ...core, derivedHash: commitment("derived", canonical(core)) };
}

function exactKeys(value, required, optional, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop(code);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) stop(code);
  return value;
}

function uint(value, code) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) stop(code);
    return value;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) stop(code);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) stop(code);
  return number;
}

async function loadFactoryAddress(readFileFn = fs.readFile) {
  let input;
  try {
    input = await readFileFn(path.join(ROOT, ...FACTORY_MANIFEST.split("/")));
  } catch (_) {
    stop("MANIFEST_READ_FAILED");
  }
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) stop("MANIFEST_BYTES_CAP_EXCEEDED");
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (_) {
    stop("MANIFEST_JSON_INVALID");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || typeof manifest.address !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(manifest.address)) {
    stop("MANIFEST_ADDRESS_INVALID");
  }
  const address = manifest.address.toLowerCase();
  if (!ADDRESS.test(address)) stop("MANIFEST_ADDRESS_INVALID");
  return address;
}

async function loadFactoryBinding(readFileFn = fs.readFile) {
  let input;
  try { input = await readFileFn(path.join(ROOT, ...FACTORY_MANIFEST.split("/"))); }
  catch (_) { stop("FACTORY_MANIFEST_READ_FAILED"); }
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_MANIFEST_BYTES) stop("FACTORY_MANIFEST_INVALID");
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch (_) { stop("FACTORY_MANIFEST_INVALID"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || typeof manifest.address !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(manifest.address)
      || !Array.isArray(manifest.abi)) stop("FACTORY_MANIFEST_INVALID");
  const declarations = manifest.abi.filter((item) => item && item.type === "function" && item.name === "spell");
  if (declarations.length !== 1 || declarations[0].stateMutability !== "nonpayable"
      || !Array.isArray(declarations[0].inputs) || declarations[0].inputs.length !== 2
      || declarations[0].inputs[0].type !== "address" || declarations[0].inputs[1].type !== "bytes") {
    stop("FACTORY_SPELL_BINDING_INVALID");
  }
  return manifest.address.toLowerCase();
}

async function consumeBytes(response, cap, onText) {
  const length = response.headers && typeof response.headers.get === "function"
    ? response.headers.get("content-length")
    : null;
  if (length !== null && /^(?:0|[1-9][0-9]*)$/u.test(length) && Number(length) > cap) stop("RESPONSE_BYTES_CAP_EXCEEDED");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  const accept = (chunk) => {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    bytes += data.byteLength;
    if (bytes > cap) stop("RESPONSE_BYTES_CAP_EXCEEDED");
    onText(decoder.decode(data, { stream: true }));
  };
  try {
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      let complete = false;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) {
            complete = true;
            break;
          }
          accept(item.value);
        }
      } finally {
        if (!complete && typeof reader.cancel === "function") {
          try { await reader.cancel(); } catch (_) { /* Retain the original sanitized failure. */ }
        }
        if (typeof reader.releaseLock === "function") {
          try { reader.releaseLock(); } catch (_) { /* The body is already settled. */ }
        }
      }
    } else if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
      for await (const chunk of response.body) accept(chunk);
    } else if (typeof response.arrayBuffer === "function") {
      accept(await response.arrayBuffer());
    } else {
      stop("RESPONSE_BODY_UNREADABLE");
    }
    onText(decoder.decode());
  } catch (error) {
    if (error instanceof WatcherError) throw error;
    stop("RESPONSE_BODY_INVALID");
  }
  return bytes;
}

async function fetchHead(fetchFn, cap) {
  let response;
  try {
    response = await fetchFn(`${DATASET_BASE}/head`, { method: "GET", redirect: "error" });
  } catch (_) {
    stop("HEAD_FETCH_FAILED");
  }
  if (!response || response.status !== 200) stop("HEAD_HTTP_STATUS_INVALID");
  let text = "";
  await consumeBytes(response, cap, (chunk) => { text += chunk; });
  const clean = text.trim();
  if (/^(?:0|[1-9][0-9]*)$/u.test(clean)) return uint(clean, "HEAD_INVALID");
  let value;
  try { value = JSON.parse(clean); } catch (_) { stop("HEAD_INVALID"); }
  const candidate = value && typeof value === "object"
    ? (value.finalized ?? value.number ?? value.height ?? (value.header && value.header.number))
    : value;
  return uint(candidate, "HEAD_INVALID");
}

function selectWindow(head, fromBlock, toBlock) {
  const hasFrom = fromBlock !== undefined && fromBlock !== null;
  const hasTo = toBlock !== undefined && toBlock !== null;
  if (hasFrom !== hasTo) stop("WINDOW_BOUNDS_PAIR_REQUIRED");
  const from = hasFrom ? uint(fromBlock, "WINDOW_FROM_INVALID") : Math.max(0, head - MAX_WINDOW_BLOCKS + 1);
  const to = hasTo ? uint(toBlock, "WINDOW_TO_INVALID") : head;
  if (to < from || to > head || to - from + 1 > MAX_WINDOW_BLOCKS) stop("WINDOW_BOUNDS_INVALID");
  return { from, to, pinnedHead: head };
}

function validateTopicWord(value, kind) {
  if (!WORD.test(value)) stop("TOPIC_WORD_INVALID");
  if (kind === "address" && !ADDRESS_WORD.test(value)) stop("TOPIC_ADDRESS_INVALID");
  if (kind === "bool" && !BOOL_WORD.test(value)) stop("TOPIC_BOOL_INVALID");
}

function validateLog(log, factoryAddress, blockNumber, blockHash, state) {
  exactKeys(log, ["address", "topics", "data", "logIndex"], [], "LOG_SHAPE_INVALID");
  if (log.address !== factoryAddress || !ADDRESS.test(log.address)) stop("FACTORY_EMITTER_INVALID");
  if (!Array.isArray(log.topics) || log.topics.length < 1 || log.topics.some((topic) => typeof topic !== "string")) {
    stop("TOPIC_LAYOUT_INVALID");
  }
  const definition = EVENT_BY_TOPIC.get(log.topics[0]);
  if (!definition) stop("UNKNOWN_TOPIC");
  if (log.topics.length !== definition.topicKinds.length + 1) stop("TOPIC_LAYOUT_INVALID");
  if (!HASH.test(log.topics[0])) stop("TOPIC_LAYOUT_INVALID");
  definition.topicKinds.forEach((kind, index) => validateTopicWord(log.topics[index + 1], kind));
  if (typeof log.data !== "string" || !new RegExp(`^0x[0-9a-f]{${definition.dataWords * 64}}$`, "u").test(log.data)) {
    stop("LOG_DATA_BOUNDS_INVALID");
  }
  const logIndex = uint(log.logIndex, "LOG_INDEX_INVALID");
  if (logIndex <= state.lastLogIndex) stop("LOG_INDEX_ORDER_INVALID");
  state.lastLogIndex = logIndex;
  state.recordCount += 1;
  if (state.recordCount > state.maxRecords) stop("RECORD_CAP_EXCEEDED");
  state.counts.set(definition.eventClass, state.counts.get(definition.eventClass) + 1);
  state.positions.push({
    eventClass: definition.eventClass,
    positionCommitment: commitment("position", `${definition.eventClass}:${blockNumber}:${logIndex}:${blockHash}`)
  });
}

function emptyAggregates() {
  return {
    eventClassCounts: Object.fromEntries(EVENT_DEFINITIONS.map((item) => [item.eventClass, 0])),
    eventClassBlockPositionCommitments: []
  };
}

function aggregates(state, zero = false) {
  if (zero) return emptyAggregates();
  const eventClassCounts = Object.fromEntries(EVENT_DEFINITIONS.map((item) => [item.eventClass, state.counts.get(item.eventClass)]));
  const positions = [...state.positions].sort((a, b) => {
    if (a.eventClass !== b.eventClass) return a.eventClass < b.eventClass ? -1 : 1;
    return a.positionCommitment < b.positionCommitment ? -1 : a.positionCommitment > b.positionCommitment ? 1 : 0;
  });
  return { eventClassCounts, eventClassBlockPositionCommitments: positions };
}

function makeResult(status, error, window, headerCount, aggregate, flags) {
  return withDerivedHash({
    status,
    error,
    windowNumbers: window ? {
      fromBlock: String(window.from),
      toBlock: String(window.to),
      pinnedHead: String(window.pinnedHead)
    } : null,
    headerCount,
    eventClassCounts: aggregate.eventClassCounts,
    eventClassBlockPositionCommitments: aggregate.eventClassBlockPositionCommitments,
    canonicalParentContinuity: flags.canonicalParentContinuity,
    paginationComplete: flags.paginationComplete,
    finalized: flags.finalized,
    traceCompleteness: flags.traceCompleteness,
    spellTraceCount: flags.spellTraceCount,
    spellTraceBlockPositionCommitments: flags.spellTraceBlockPositionCommitments,
    forkEligible: false,
    routePositive: false,
    execution: false,
    signed: false
  });
}

function traceAddress(value) {
  if (!Array.isArray(value) || value.length > 64) stop("TRACE_ADDRESS_INVALID");
  const output = value.map((item) => {
    if (!Number.isSafeInteger(item) || item < 0) stop("TRACE_ADDRESS_INVALID");
    return item;
  });
  return output;
}

function compareTraceAddress(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

async function scanSpellTraces(options, fetchFn, factoryAddress, window) {
  const maxPages = options.maxPages ?? MAX_PAGES;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const maxTotalResponseBytes = options.maxTotalResponseBytes ?? MAX_TOTAL_RESPONSE_BYTES;
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  let cursor = window.from;
  let pages = 0;
  let totalBytes = 0;
  let records = 0;
  let headerCount = 0;
  let lastNumber = null;
  let lastHash = null;
  const positions = [];

  while (cursor <= window.to) {
    if (pages >= maxPages) stop("TRACE_PAGE_CAP_EXCEEDED");
    pages += 1;
    const body = {
      type: "evm",
      fromBlock: cursor,
      toBlock: window.to,
      includeAllBlocks: true,
      fields: {
        block: { number: true, hash: true, parentHash: true, timestamp: true },
        trace: { type: true, callTo: true, callSighash: true, traceAddress: true, error: true }
      },
      traces: [{ type: TRACE_TYPES, callTo: [factoryAddress], callSighash: [SPELL_SELECTOR] }]
    };
    let response;
    try {
      response = await fetchFn(`${DATASET_BASE}/finalized-stream`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (_) {
      stop("TRACE_STREAM_FETCH_FAILED");
    }
    if (!response) stop("TRACE_STREAM_HTTP_STATUS_INVALID");
    if (response.status === 204) stop("TRACE_FINALIZED_WINDOW_INCOMPLETE");
    if (response.status !== 200) stop("TRACE_STREAM_HTTP_STATUS_INVALID");

    let pending = "";
    let pageHeaders = 0;
    let pageLast = null;
    const line = (raw) => {
      const clean = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (clean.length === 0) return;
      records += 1;
      if (records > maxRecords) stop("TRACE_RECORD_CAP_EXCEEDED");
      let record;
      try { record = JSON.parse(clean); } catch (_) { stop("TRACE_NDJSON_RECORD_INVALID"); }
      exactKeys(record, ["header"], ["traces"], "TRACE_NDJSON_RECORD_INVALID");
      const header = exactKeys(record.header, ["number", "hash", "parentHash", "timestamp"], [], "TRACE_HEADER_SHAPE_INVALID");
      const number = uint(header.number, "TRACE_HEADER_NUMBER_INVALID");
      uint(header.timestamp, "TRACE_HEADER_TIMESTAMP_INVALID");
      if (!HASH.test(header.hash) || !HASH.test(header.parentHash)) stop("TRACE_HEADER_HASH_INVALID");
      const expected = lastNumber === null ? cursor : lastNumber + 1;
      if (number !== expected || number > window.to) stop("TRACE_HEADER_CONTINUITY_INVALID");
      if (lastHash !== null && header.parentHash !== lastHash) stop("TRACE_PARENT_HASH_CONTINUITY_INVALID");
      lastNumber = number;
      lastHash = header.hash;
      headerCount += 1;
      pageHeaders += 1;
      pageLast = number;

      const traces = record.traces === undefined ? [] : record.traces;
      if (!Array.isArray(traces)) stop("TRACES_SHAPE_INVALID");
      let previousTraceAddress = null;
      for (const trace of traces) {
        records += 1;
        if (records > maxRecords) stop("TRACE_RECORD_CAP_EXCEEDED");
        exactKeys(trace, ["type", "callTo", "callSighash", "traceAddress", "error"], [], "TRACE_SHAPE_INVALID");
        if (!TRACE_TYPES.includes(trace.type)) stop("TRACE_TYPE_INVALID");
        if (trace.callTo !== factoryAddress || !ADDRESS.test(trace.callTo)) stop("TRACE_TARGET_INVALID");
        if (trace.callSighash !== SPELL_SELECTOR) stop("TRACE_SELECTOR_INVALID");
        if (trace.error !== null) stop("TRACE_ERROR");
        const currentTraceAddress = traceAddress(trace.traceAddress);
        if (previousTraceAddress !== null && compareTraceAddress(previousTraceAddress, currentTraceAddress) >= 0) {
          stop("TRACE_ORDER_INVALID");
        }
        previousTraceAddress = currentTraceAddress;
        positions.push(commitment("spell-position", `${number}:${currentTraceAddress.join(".")}:${header.hash}`));
      }
    };

    const pageBytes = await consumeBytes(response, maxResponseBytes, (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        line(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending, "utf8") > maxResponseBytes) stop("RESPONSE_BYTES_CAP_EXCEEDED");
    });
    if (pending.length !== 0) line(pending);
    totalBytes += pageBytes;
    if (totalBytes > maxTotalResponseBytes) stop("TRACE_TOTAL_RESPONSE_BYTES_CAP_EXCEEDED");
    if (pageHeaders === 0 || pageLast === null) stop("TRACE_EMPTY_STREAM_PAGE");
    cursor = pageLast + 1;
  }
  if (lastNumber !== window.to || headerCount !== window.to - window.from + 1) stop("TRACE_FINALIZED_WINDOW_INCOMPLETE");
  return {
    count: positions.length,
    positions: positions.slice().sort(),
    complete: true
  };
}

async function scan(options, fetchFn, factoryAddress, window, state) {
  const maxPages = options.maxPages ?? MAX_PAGES;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const maxTotalResponseBytes = options.maxTotalResponseBytes ?? MAX_TOTAL_RESPONSE_BYTES;
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  for (const [value, code] of [[maxPages, "PAGE_CAP_INVALID"], [maxResponseBytes, "RESPONSE_BYTES_CAP_INVALID"],
    [maxTotalResponseBytes, "TOTAL_RESPONSE_BYTES_CAP_INVALID"], [maxRecords, "RECORD_CAP_INVALID"]]) {
    if (!Number.isSafeInteger(value) || value < 1) stop(code);
  }
  state.maxRecords = maxRecords;
  let cursor = window.from;
  let pages = 0;
  let totalBytes = 0;

  while (cursor <= window.to) {
    if (pages >= maxPages) stop("PAGE_CAP_EXCEEDED");
    pages += 1;
    const body = {
      type: "evm",
      fromBlock: cursor,
      toBlock: window.to,
      includeAllBlocks: true,
      fields: {
        block: { number: true, hash: true, parentHash: true, timestamp: true },
        log: { address: true, topics: true, data: true, logIndex: true }
      },
      logs: [{ address: [factoryAddress], topic0: EVENT_DEFINITIONS.map((item) => item.topic0) }]
    };
    let response;
    try {
      response = await fetchFn(`${DATASET_BASE}/finalized-stream`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (_) {
      stop("STREAM_FETCH_FAILED");
    }
    if (!response) stop("STREAM_HTTP_STATUS_INVALID");
    if (response.status === 204) stop("FINALIZED_WINDOW_INCOMPLETE");
    if (response.status !== 200) stop("STREAM_HTTP_STATUS_INVALID");

    let pending = "";
    let pageHeaders = 0;
    let pageLast = null;
    const line = (raw) => {
      const clean = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (clean.length === 0) return;
      state.recordCount += 1;
      if (state.recordCount > maxRecords) stop("RECORD_CAP_EXCEEDED");
      let record;
      try { record = JSON.parse(clean); } catch (_) { stop("NDJSON_RECORD_INVALID"); }
      exactKeys(record, ["header"], ["logs"], "NDJSON_RECORD_INVALID");
      const header = exactKeys(record.header, ["number", "hash", "parentHash", "timestamp"], [], "HEADER_SHAPE_INVALID");
      const number = uint(header.number, "HEADER_NUMBER_INVALID");
      uint(header.timestamp, "HEADER_TIMESTAMP_INVALID");
      if (!HASH.test(header.hash) || !HASH.test(header.parentHash)) stop("HEADER_HASH_INVALID");
      const expected = state.lastNumber === null ? cursor : state.lastNumber + 1;
      if (number !== expected || number > window.to) stop("HEADER_CONTINUITY_INVALID");
      if (state.lastHash !== null && header.parentHash !== state.lastHash) stop("PARENT_HASH_CONTINUITY_INVALID");
      state.lastNumber = number;
      state.lastHash = header.hash;
      state.headerCount += 1;
      pageHeaders += 1;
      pageLast = number;
      const logs = record.logs === undefined ? [] : record.logs;
      if (!Array.isArray(logs)) stop("LOGS_SHAPE_INVALID");
      const logState = { lastLogIndex: -1, recordCount: state.recordCount, maxRecords, counts: state.counts, positions: state.positions };
      for (const item of logs) validateLog(item, factoryAddress, number, header.hash, logState);
      state.recordCount = logState.recordCount;
    };

    const pageBytes = await consumeBytes(response, maxResponseBytes, (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        line(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending, "utf8") > maxResponseBytes) stop("RESPONSE_BYTES_CAP_EXCEEDED");
    });
    if (pending.length !== 0) line(pending);
    totalBytes += pageBytes;
    if (totalBytes > maxTotalResponseBytes) stop("TOTAL_RESPONSE_BYTES_CAP_EXCEEDED");
    if (pageHeaders === 0 || pageLast === null) stop("EMPTY_STREAM_PAGE");
    cursor = pageLast + 1;
  }
  if (state.lastNumber !== window.to || state.headerCount !== window.to - window.from + 1) stop("FINALIZED_WINDOW_INCOMPLETE");
}

class RequalBudget {
  constructor(options) {
    this.started = Date.now();
    this.requests = 0;
    this.bytes = 0;
    this.pages = 0;
    this.requestCap = options.maxRequests ?? REQUAL_LIMITS.requests;
    this.requestMs = options.requestMs ?? REQUAL_LIMITS.requestMs;
    this.wallMs = options.maxWallMs ?? REQUAL_LIMITS.wallMs;
    this.responseCap = options.maxResponseBytes ?? REQUAL_LIMITS.responseBytes;
    this.totalResponseCap = options.maxTotalResponseBytes ?? REQUAL_LIMITS.totalResponseBytes;
    this.pageCap = options.maxPages ?? REQUAL_LIMITS.pages;
    this.recordCap = options.maxRecords ?? REQUAL_LIMITS.records;
    for (const [value, code] of [[this.requestCap, "REQUEST_CAP_INVALID"], [this.requestMs, "REQUEST_TIMEOUT_INVALID"],
      [this.wallMs, "WALL_CAP_INVALID"], [this.responseCap, "RESPONSE_BYTES_CAP_INVALID"],
      [this.totalResponseCap, "TOTAL_RESPONSE_BYTES_CAP_INVALID"], [this.pageCap, "PAGE_CAP_INVALID"],
      [this.recordCap, "RECORD_CAP_INVALID"]]) {
      if (!Number.isSafeInteger(value) || value < 1) stop(code);
    }
  }
  wall() {
    if (Date.now() - this.started > this.wallMs) stop("WALL_CAP_EXCEEDED");
  }
  request() {
    this.wall();
    this.requests += 1;
    if (this.requests > this.requestCap) stop("REQUEST_CAP_EXCEEDED");
  }
  addBytes(bytes) {
    this.wall();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.responseCap) stop("RESPONSE_BYTES_CAP_EXCEEDED");
    this.bytes += bytes;
    if (this.bytes > this.totalResponseCap) stop("TOTAL_RESPONSE_BYTES_CAP_EXCEEDED");
  }
  page() {
    this.pages += 1;
    if (this.pages > this.pageCap) stop("TRACE_PAGE_CAP_EXCEEDED");
  }
}

function fileIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameIdentity(left, right) {
  return left && right && canonical(left) === canonical(right);
}

async function readStableEvidence(relativePath, cap, readFileFn = fs.readFile) {
  const target = path.join(ROOT, relativePath);
  let before;
  let after;
  let real;
  let bytes;
  try {
    before = await fs.lstat(target);
    real = await fs.realpath(target);
    if (!before.isFile() || before.isSymbolicLink() || real !== target || before.size < 1 || before.size > cap) stop("POLICY_EVIDENCE_INVALID");
    bytes = await readFileFn(target);
    after = await fs.lstat(target);
  } catch (error) {
    if (error instanceof WatcherError) throw error;
    stop("POLICY_EVIDENCE_INVALID");
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.byteLength !== before.size || !sameIdentity(fileIdentity(before), fileIdentity(after))) stop("POLICY_EVIDENCE_MUTATED");
  return { text: buffer.toString("utf8"), identity: fileIdentity(after), target };
}

async function assertEvidenceUnchanged(item) {
  if (!item) return;
  let current;
  let real;
  try { current = await fs.lstat(item.target); real = await fs.realpath(item.target); }
  catch (_) { stop("POLICY_EVIDENCE_MUTATED"); }
  if (!current.isFile() || current.isSymbolicLink() || real !== item.target
      || !sameIdentity(item.identity, fileIdentity(current))) stop("POLICY_EVIDENCE_MUTATED");
}

function safePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { stop("POLICY_MATRIX_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || (url.port && url.port !== "443") || /(?:localhost|\.local|\.internal|\.invalid)$/u.test(url.hostname.toLowerCase())) {
    stop("POLICY_MATRIX_INVALID");
  }
  return url;
}

function extractPolicyCandidates(matrixText, inventoryText) {
  if (typeof matrixText !== "string" || typeof inventoryText !== "string") stop("POLICY_EVIDENCE_INVALID");
  const matrix = [];
  for (const line of matrixText.split(/\r?\n/u)) {
    const columns = line.split("|").map((item) => item.trim());
    if (columns.length < 7 || columns[1] !== "Base" || columns[2] !== "8453" || !/^Keyless\b/u.test(columns[5])) continue;
    const match = columns[4].match(/`(https:\/\/[^`]+)`/u);
    if (!match) stop("POLICY_MATRIX_INVALID");
    matrix.push({ family: columns[3].toLowerCase(), url: safePublicUrl(match[1]), ordinal: matrix.length });
  }
  if (matrix.length < 2 || matrix.length > 8) stop("POLICY_MATRIX_INVALID");

  const inventoryUrls = new Set();
  let section = "";
  for (const line of inventoryText.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed && !/https?:\/\//iu.test(trimmed)) section = trimmed;
    const context = `${section} ${line}`.toLowerCase();
    const forbidden = /\b(?:origin|browser|session|cookie|referer|custom[- _]?header|authorization|bearer|restricted|app[- _]?scoped|private|internal|exposed|leaked|compromised|failed|unavailable)\b/u.test(context);
    if (forbidden || !/\bbase\b/u.test(line.toLowerCase())) continue;
    for (const match of line.matchAll(/https?:\/\/[^\s<'"`\])}]+/giu)) {
      try {
        const value = new URL(match[0].replace(/[>,.;]+$/u, ""));
        if (value.protocol === "https:" && !value.username && !value.password && !value.search && !value.hash) inventoryUrls.add(value.href);
      } catch (_) { /* Non-candidate inventory material remains process-only. */ }
    }
  }
  const candidates = matrix.filter((item) => inventoryUrls.has(item.url.href));
  const families = new Set(candidates.map((item) => item.family));
  if (families.size !== candidates.length) stop("POLICY_MATRIX_INVALID");
  return candidates;
}

async function loadBoundaryCandidates(options) {
  if (Array.isArray(options.boundaryCandidates)) {
    if (options.boundaryCandidates.length < 2 || options.boundaryCandidates.length > 8) stop("BOUNDARY_CANDIDATES_INVALID");
    const families = new Set();
    for (const item of options.boundaryCandidates) {
      if (!item || typeof item !== "object" || typeof item.family !== "string" || item.family.length < 1 || families.has(item.family)) {
        stop("BOUNDARY_CANDIDATES_INVALID");
      }
      families.add(item.family);
    }
    return { candidates: options.boundaryCandidates, evidence: [] };
  }
  const matrix = await readStableEvidence(PROVIDER_MATRIX, REQUAL_LIMITS.evidenceBytes, options.readEvidenceFn ?? fs.readFile);
  const inventory = await readStableEvidence(RPC_INVENTORY, REQUAL_LIMITS.evidenceBytes, options.readEvidenceFn ?? fs.readFile);
  return { candidates: extractPolicyCandidates(matrix.text, inventory.text), evidence: [matrix, inventory] };
}

function hexQuantity(value, code) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) stop(code);
  return BigInt(value);
}

function quantityHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function parseRpcHeader(value, expectedNumber = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop("BOUNDARY_HEADER_INVALID");
  const number = hexQuantity(value.number, "BOUNDARY_HEADER_INVALID");
  if (expectedNumber !== null && number !== BigInt(expectedNumber)) stop("BOUNDARY_HEADER_INVALID");
  for (const key of ["hash", "parentHash", "stateRoot"]) if (typeof value[key] !== "string" || !HASH.test(value[key])) stop("BOUNDARY_HEADER_INVALID");
  const timestamp = hexQuantity(value.timestamp, "BOUNDARY_HEADER_INVALID");
  return { number, hash: value.hash, projection: canonical({ number: quantityHex(number), hash: value.hash,
    parentHash: value.parentHash, stateRoot: value.stateRoot, timestamp: quantityHex(timestamp) }) };
}

async function defaultRpcTransport({ candidate, envelope, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await globalThis.fetch(candidate.url.href, { method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" },
      body: JSON.stringify(envelope) });
    if (!response || response.status !== 200) stop("BOUNDARY_RPC_HTTP_INVALID");
    let text = "";
    const bytes = await consumeBytes(response, maxBytes, (chunk) => { text += chunk; });
    let value;
    try { value = JSON.parse(text); } catch (_) { stop("BOUNDARY_RPC_JSON_INVALID"); }
    return { value, bytes };
  } catch (error) {
    if (error instanceof WatcherError) throw error;
    stop("BOUNDARY_RPC_TRANSPORT_FAILED");
  } finally { clearTimeout(timer); }
}

async function rpcRead(candidate, method, params, budget, transport) {
  if (!["eth_chainId", "eth_getBlockByNumber"].includes(method)) stop("BOUNDARY_RPC_METHOD_FORBIDDEN");
  budget.request();
  const envelope = { jsonrpc: "2.0", id: budget.requests, method, params };
  let row;
  let timeout;
  try {
    row = await Promise.race([
      transport({ candidate, envelope, timeoutMs: budget.requestMs, maxBytes: budget.responseCap }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new WatcherError("BOUNDARY_RPC_TIMEOUT")), budget.requestMs); })
    ]);
  } catch (error) {
    if (error instanceof WatcherError) throw error;
    stop("BOUNDARY_RPC_TRANSPORT_FAILED");
  } finally { clearTimeout(timeout); }
  if (!row || !Object.hasOwn(row, "value") || !Number.isSafeInteger(row.bytes)) stop("BOUNDARY_RPC_RESPONSE_INVALID");
  budget.addBytes(row.bytes);
  const value = row.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0" || value.id !== envelope.id
      || Object.hasOwn(value, "error") || !Object.hasOwn(value, "result")) stop("BOUNDARY_RPC_RESPONSE_INVALID");
  return value.result;
}

async function qualifyBoundary(candidate, window, budget, transport) {
  if (hexQuantity(await rpcRead(candidate, "eth_chainId", [], budget, transport), "BOUNDARY_CHAIN_INVALID") !== BASE_CHAIN_ID) {
    stop("BOUNDARY_CHAIN_INVALID");
  }
  const finalized = parseRpcHeader(await rpcRead(candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport));
  if (finalized.number < BigInt(window.to)) stop("BOUNDARY_NOT_FINALIZED");
  const from = parseRpcHeader(await rpcRead(candidate, "eth_getBlockByNumber", [quantityHex(window.from), false], budget, transport), window.from);
  const to = parseRpcHeader(await rpcRead(candidate, "eth_getBlockByNumber", [quantityHex(window.to), false], budget, transport), window.to);
  return { candidate, from, to };
}

async function qualifyBoundaries(candidates, window, budget, transport) {
  const qualified = [];
  for (const candidate of candidates) {
    try { qualified.push(await qualifyBoundary(candidate, window, budget, transport)); }
    catch (error) {
      if (error instanceof WatcherError && /(?:CAP_EXCEEDED|TIMEOUT)$/u.test(error.code)) throw error;
    }
  }
  for (let left = 0; left < qualified.length; left += 1) {
    for (let right = left + 1; right < qualified.length; right += 1) {
      if (qualified[left].from.projection === qualified[right].from.projection
          && qualified[left].to.projection === qualified[right].to.projection) {
        return { qualifiedCount: qualified.length, selected: [qualified[left], qualified[right]] };
      }
    }
  }
  if (qualified.length >= 2) stop("BOUNDARY_AGREEMENT_FAILED");
  stop("BOUNDARY_TWO_FAMILIES_UNAVAILABLE");
}

function httpFailure(prefix, status) {
  if ([204, 409, 429, 529].includes(status)) stop(`${prefix}_HTTP_${status}`);
  stop(`${prefix}_HTTP_INVALID`);
}

async function sqdRequest(fetchFn, url, init, budget, prefix) {
  budget.request();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget.requestMs);
  let response;
  try { response = await fetchFn(url, { ...init, signal: controller.signal }); }
  catch (_) { clearTimeout(timer); stop(`${prefix}_FETCH_FAILED`); }
  if (!response || response.status !== 200) { clearTimeout(timer); httpFailure(prefix, response && response.status); }
  return { response, finish: () => clearTimeout(timer) };
}

async function fetchRequalHead(fetchFn, budget) {
  const request = await sqdRequest(fetchFn, `${DATASET_BASE}/head`, { method: "GET", redirect: "error" }, budget, "SQD_HEAD");
  let text = "";
  try {
    const bytes = await consumeBytes(request.response, Math.min(2048, budget.responseCap), (chunk) => { budget.wall(); text += chunk; });
    budget.addBytes(bytes);
  } finally { request.finish(); }
  const clean = text.trim();
  if (/^(?:0|[1-9][0-9]*)$/u.test(clean)) return uint(clean, "SQD_HEAD_INVALID");
  let value;
  try { value = JSON.parse(clean); } catch (_) { stop("SQD_HEAD_INVALID"); }
  return uint(value && typeof value === "object" ? (value.finalized ?? value.number ?? value.height) : value, "SQD_HEAD_INVALID");
}

function compareFullTracePosition(left, right) {
  if (left.block !== right.block) return left.block < right.block ? -1 : 1;
  if (left.transaction !== right.transaction) return left.transaction < right.transaction ? -1 : 1;
  return compareTraceAddress(left.trace, right.trace);
}

async function scanRequalSpellTraces(options, fetchFn, factoryAddress, window, budget) {
  let cursor = window.from;
  let lastNumber = null;
  let lastHash = null;
  let firstHeader = null;
  let lastHeader = null;
  let records = 0;
  let traceCount = 0;
  let previousPosition = null;
  const seen = new Set();
  while (cursor <= window.to) {
    budget.page();
    const body = { type: "evm", fromBlock: cursor, toBlock: window.to, includeAllBlocks: true,
      fields: { block: { number: true, hash: true, parentHash: true, timestamp: true },
        trace: { type: true, callTo: true, callSighash: true, transactionIndex: true, traceAddress: true, error: true } },
      traces: [{ type: TRACE_TYPES, callTo: [factoryAddress], callSighash: [SPELL_SELECTOR] }] };
    const request = await sqdRequest(fetchFn, `${DATASET_BASE}/finalized-stream`, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", accept: "application/x-ndjson", "accept-encoding": "identity" },
      body: JSON.stringify(body) }, budget, "SQD_TRACE");
    let pending = "";
    let pageHeaders = 0;
    let pageLast = null;
    const consumeLine = (raw) => {
      const clean = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!clean) stop("SQD_TRACE_NDJSON_EMPTY_RECORD");
      records += 1;
      if (records > budget.recordCap) stop("TRACE_RECORD_CAP_EXCEEDED");
      let record;
      try { record = JSON.parse(clean); } catch (_) { stop("SQD_TRACE_NDJSON_MALFORMED"); }
      exactKeys(record, ["header"], ["traces"], "SQD_TRACE_RECORD_INVALID");
      const header = exactKeys(record.header, ["number", "hash", "parentHash", "timestamp"], [], "SQD_TRACE_HEADER_INVALID");
      const number = uint(header.number, "SQD_TRACE_HEADER_INVALID");
      uint(header.timestamp, "SQD_TRACE_HEADER_INVALID");
      if (!HASH.test(header.hash) || !HASH.test(header.parentHash)) stop("SQD_TRACE_HEADER_INVALID");
      const expected = lastNumber === null ? cursor : lastNumber + 1;
      if (number !== expected || number > window.to) stop("SQD_TRACE_HEADER_CONTINUITY_INVALID");
      if (lastHash !== null && header.parentHash !== lastHash) stop("SQD_TRACE_PARENT_CONTINUITY_INVALID");
      const projection = { number, hash: header.hash };
      if (firstHeader === null) firstHeader = projection;
      lastHeader = projection;
      lastNumber = number;
      lastHash = header.hash;
      pageHeaders += 1;
      pageLast = number;
      const traces = record.traces === undefined ? [] : record.traces;
      if (!Array.isArray(traces)) stop("SQD_TRACE_LIST_INVALID");
      for (const trace of traces) {
        records += 1;
        if (records > budget.recordCap) stop("TRACE_RECORD_CAP_EXCEEDED");
        exactKeys(trace, ["type", "callTo", "callSighash", "transactionIndex", "traceAddress", "error"], [], "SQD_TRACE_SHAPE_INVALID");
        if (!TRACE_TYPES.includes(trace.type)) stop("SQD_TRACE_TYPE_INVALID");
        if (trace.callTo !== factoryAddress || !ADDRESS.test(trace.callTo)) stop("SQD_TRACE_TARGET_INVALID");
        if (trace.callSighash !== SPELL_SELECTOR) stop("SQD_TRACE_SELECTOR_INVALID");
        if (trace.error !== null) stop("SQD_TRACE_EXECUTION_ERROR");
        const transaction = uint(trace.transactionIndex, "SQD_TRACE_TRANSACTION_INDEX_INVALID");
        const tracePath = traceAddress(trace.traceAddress);
        const position = { block: number, transaction, trace: tracePath };
        const key = `${number}:${transaction}:${tracePath.join(".")}`;
        if (seen.has(key)) stop("SQD_TRACE_DUPLICATE");
        if (previousPosition !== null && compareFullTracePosition(previousPosition, position) >= 0) stop("SQD_TRACE_ORDER_INVALID");
        seen.add(key);
        previousPosition = position;
        traceCount += 1;
      }
    };
    try {
      const bytes = await consumeBytes(request.response, budget.responseCap, (chunk) => {
        budget.wall();
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          consumeLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        if (Buffer.byteLength(pending, "utf8") > budget.responseCap) stop("RESPONSE_BYTES_CAP_EXCEEDED");
      });
      budget.addBytes(bytes);
    } finally { request.finish(); }
    if (pending.length !== 0) stop("SQD_TRACE_NDJSON_PARTIAL");
    if (pageHeaders === 0 || pageLast === null || pageLast < cursor) stop("SQD_TRACE_NON_PROGRESS");
    cursor = pageLast + 1;
  }
  if (lastNumber !== window.to || !firstHeader || !lastHeader
      || firstHeader.number !== window.from || lastHeader.number !== window.to) stop("SQD_TRACE_PARTIAL_WINDOW");
  return { traceCount, spellCount: traceCount, firstHeader, lastHeader };
}

function requalPhase(code) {
  if (/^(?:WINDOW|ARGUMENT|.*_CAP_INVALID)/u.test(code)) return "INPUT";
  if (/^FACTORY/u.test(code)) return "FACTORY";
  if (/^POLICY/u.test(code)) return "POLICY";
  if (/^BOUNDARY/u.test(code)) return "BOUNDARY";
  if (/^SQD_HEAD/u.test(code)) return "SQD_HEAD";
  if (/^(?:SQD_TRACE|TRACE_|RESPONSE_|TOTAL_RESPONSE_|REQUEST_|WALL_)/u.test(code)) return "SQD_TRACE";
  return "INTERNAL";
}

function requalResult(status, phase, code, window, counts, budget, observation, redundancyAvailable) {
  const complete = status === "COMPLETE";
  return {
    status,
    phase,
    code,
    window: window ? { fromBlock: String(window.from), toBlock: String(window.to) } : null,
    sqdCompleteness: complete ? "COMPLETE" : "FAILED",
    anonymousBoundaryFamilyCounts: counts,
    traceCount: complete ? observation.traceCount : null,
    spellCount: complete ? observation.spellCount : null,
    reads: budget.requests,
    pages: budget.pages,
    retries: 0,
    cleanup: "NOT_REQUIRED",
    independentTraceRedundancyAvailable: redundancyAvailable === true
  };
}

async function runRequalification(options = {}) {
  const budget = new RequalBudget(options);
  let window = null;
  let loaded = null;
  let counts = { candidates: 0, qualified: 0, selected: 0 };
  let observation = { traceCount: 0, spellCount: 0 };
  // The refreshed matrix binds one exact keyless Base trace_filter URL and names a
  // second demo family without binding its exact Base URL. The existing fallback
  // requires two exact families, so default redundancy is unavailable.
  const redundancyAvailable = options.independentTraceRedundancyAvailable === true;
  try {
    const from = uint(options.fromBlock, "WINDOW_FROM_INVALID");
    const to = uint(options.toBlock, "WINDOW_TO_INVALID");
    if (to < from || to - from + 1 > MAX_WINDOW_BLOCKS) stop("WINDOW_BOUNDS_INVALID");
    window = { from, to };
    const factoryAddress = await loadFactoryBinding(options.readFileFn ?? fs.readFile);
    loaded = await loadBoundaryCandidates(options);
    counts.candidates = loaded.candidates.length;
    const boundary = await qualifyBoundaries(loaded.candidates, window, budget, options.rpcTransport ?? defaultRpcTransport);
    counts.qualified = boundary.qualifiedCount;
    counts.selected = boundary.selected.length;
    const fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
    if (typeof fetchFn !== "function") stop("SQD_TRACE_FETCH_UNAVAILABLE");
    const head = await fetchRequalHead(fetchFn, budget);
    if (head < to) stop("SQD_HEAD_BEFORE_WINDOW");
    observation = await scanRequalSpellTraces(options, fetchFn, factoryAddress, window, budget);
    if (observation.firstHeader.hash !== boundary.selected[0].from.hash
        || observation.lastHeader.hash !== boundary.selected[0].to.hash) stop("SQD_TRACE_BOUNDARY_MISMATCH");
    for (const evidence of loaded.evidence) await assertEvidenceUnchanged(evidence);
    return requalResult("COMPLETE", "DONE", null, window, counts, budget, observation, redundancyAvailable);
  } catch (error) {
    let code = error instanceof WatcherError ? error.code : "INTERNAL_ERROR";
    if (loaded && loaded.evidence.length) {
      try { for (const evidence of loaded.evidence) await assertEvidenceUnchanged(evidence); }
      catch (_) { code = "POLICY_EVIDENCE_MUTATED"; }
    }
    return requalResult("ERROR", requalPhase(code), code, window, counts, budget, observation, redundancyAvailable);
  }
}

async function runWatcher(options = {}) {
  if (options.requalifyTrace === true) return runRequalification(options);
  let window = null;
  const includeSpellTrace = options.includeSpellTrace === true;
  let traceResult = { count: 0, positions: [], complete: false };
  const state = {
    headerCount: 0,
    recordCount: 0,
    lastNumber: null,
    lastHash: null,
    maxRecords: MAX_RECORDS,
    counts: new Map(EVENT_DEFINITIONS.map((item) => [item.eventClass, 0])),
    positions: []
  };
  try {
    const fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
    if (typeof fetchFn !== "function") stop("FETCH_UNAVAILABLE");
    const factoryAddress = await loadFactoryAddress(options.readFileFn ?? fs.readFile);
    const head = await fetchHead(fetchFn, options.headResponseBytes ?? 2048);
    window = selectWindow(head, options.fromBlock, options.toBlock);
    await scan(options, fetchFn, factoryAddress, window, state);
    if (includeSpellTrace) traceResult = await scanSpellTraces(options, fetchFn, factoryAddress, window);
    const eventAggregate = aggregates(state);
    const eventCount = Object.values(eventAggregate.eventClassCounts).reduce((sum, count) => sum + count, 0);
    const status = includeSpellTrace
      ? (eventCount === 0 && traceResult.count === 0 ? COMPLETE_STATUS : DELTA_STATUS)
      : SUCCESS_STATUS;
    return makeResult(status, null, window, state.headerCount, eventAggregate, {
      canonicalParentContinuity: true,
      paginationComplete: true,
      finalized: true,
      traceCompleteness: includeSpellTrace ? "COMPLETE" : "NOT_REQUESTED",
      spellTraceCount: traceResult.count,
      spellTraceBlockPositionCommitments: traceResult.positions
    });
  } catch (error) {
    const code = error instanceof WatcherError ? error.code : "INTERNAL_ERROR";
    return makeResult("ERROR", code, window, 0, aggregates(state, true), {
      canonicalParentContinuity: false,
      paginationComplete: false,
      finalized: false,
      traceCompleteness: includeSpellTrace ? "FAILED" : "NOT_REQUESTED",
      spellTraceCount: 0,
      spellTraceBlockPositionCommitments: []
    });
  }
}

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--include-spell-trace") {
      if (output.includeSpellTrace === true) stop("ARGUMENT_DUPLICATE");
      output.includeSpellTrace = true;
      continue;
    }
    if (flag === "--requalify-trace") {
      if (output.requalifyTrace === true) stop("ARGUMENT_DUPLICATE");
      output.requalifyTrace = true;
      continue;
    }
    if (!["--from-block", "--to-block"].includes(flag) || index + 1 >= argv.length) stop("ARGUMENT_INVALID");
    const key = flag === "--from-block" ? "fromBlock" : "toBlock";
    if (Object.hasOwn(output, key)) stop("ARGUMENT_DUPLICATE");
    output[key] = argv[index + 1];
    index += 1;
  }
  return output;
}

async function main() {
  let result;
  try {
    result = await runWatcher(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const code = error instanceof WatcherError ? error.code : "ARGUMENT_INVALID";
    result = makeResult("ERROR", code, null, 0, emptyAggregates(), {
      canonicalParentContinuity: false,
      paginationComplete: false,
      finalized: false,
      traceCompleteness: "NOT_REQUESTED",
      spellTraceCount: 0,
      spellTraceBlockPositionCommitments: []
    });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (![SUCCESS_STATUS, COMPLETE_STATUS, DELTA_STATUS, "COMPLETE"].includes(result.status)) process.exitCode = 1;
}

module.exports = {
  EVENT_DEFINITIONS,
  FACTORY_MANIFEST,
  COMPLETE_STATUS,
  DELTA_STATUS,
  MAX_PAGES,
  MAX_RECORDS,
  MAX_RESPONSE_BYTES,
  MAX_WINDOW_BLOCKS,
  SPELL_SELECTOR,
  SPELL_SIGNATURE,
  SUCCESS_STATUS,
  REQUAL_LIMITS,
  loadFactoryAddress,
  runRequalification,
  runWatcher
};

if (require.main === module) main();
