"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_FILE = path.join(ROOT, "rpc_endpoints.txt");
const FACTORY_MANIFEST = path.join(ROOT, "targets", "fluid-contracts-public", "deployments", "base", "VaultFactory.json");
const CHAIN_ID = 8453n;
const SPELL_SELECTOR = "0xc7acb01f";
const ALLOWED_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "trace_filter"]);
const COMPLETE_STATUS = "COMPLETE_DISCOVERY_NO_SURVIVOR";
const DELTA_STATUS = "DISCOVERY_DELTA_UNBOUND";
const INCOMPLETE_STATUS = "INCOMPLETE";
const PHASE_BY_CODE = Object.freeze({
  WINDOW_INVALID: "WINDOW", INVENTORY_INVALID: "INVENTORY", INVENTORY_MUTATED: "INVENTORY", MANIFEST_INVALID: "INVENTORY",
  TWO_FAMILIES_UNAVAILABLE: "QUALIFICATION", WRONG_CHAIN: "QUALIFICATION", CHAIN_INVALID: "QUALIFICATION",
  HEADER_INVALID: "QUALIFICATION", NON_FINALIZED_BOUNDARY: "QUALIFICATION", TRACE_FILTER_UNAVAILABLE: "QUALIFICATION",
  RPC_METHOD_FORBIDDEN: "QUALIFICATION", RPC_HTTP_INVALID: "QUALIFICATION", RPC_BODY_INVALID: "QUALIFICATION",
  RPC_JSON_INVALID: "QUALIFICATION", RPC_TRANSPORT_FAILED: "QUALIFICATION", RPC_TIMEOUT: "QUALIFICATION",
  RPC_RESPONSE_INVALID: "QUALIFICATION", REQUEST_CAP_EXCEEDED: "QUALIFICATION", RESPONSE_CAP_EXCEEDED: "QUALIFICATION",
  TOTAL_RESPONSE_CAP_EXCEEDED: "QUALIFICATION", TRACE_PAGE_CAP_EXCEEDED: "CAPTURE", TRACE_RECORD_CAP_EXCEEDED: "CAPTURE",
  TRACE_PAGE_INVALID: "CAPTURE", TRACE_ERROR_OR_SHAPE_INVALID: "CAPTURE", TRACE_ACTION_INVALID: "CAPTURE",
  TRACE_BLOCK_INVALID: "CAPTURE", TRACE_TRANSACTION_POSITION_INVALID: "CAPTURE", TRACE_ADDRESS_INVALID: "CAPTURE",
  TRACE_DUPLICATE: "CAPTURE", TRACE_ORDER_INVALID: "CAPTURE", TRACE_AGREEMENT_FAILED: "AGREEMENT",
  TERMINAL_HEADER_CHANGED: "TERMINAL", TERMINAL_HEADER_MISMATCH: "TERMINAL"
});

const LIMITS = Object.freeze({
  inventoryBytes: 1024 * 1024,
  manifestBytes: 32 * 1024 * 1024,
  candidates: 12,
  families: 8,
  requests: 128,
  requestMs: 15_000,
  wallMs: 180_000,
  responseBytes: 4 * 1024 * 1024,
  totalResponseBytes: 64 * 1024 * 1024,
  tracePages: 32,
  traceRecords: 32_000,
  tracePageSize: 1000,
  windowBlocks: 4096
});

const FIXED_PUBLIC_BASE = Object.freeze({
  "mainnet.base.org": Object.freeze(["/"]),
  "base-rpc.publicnode.com": Object.freeze(["/"]),
  "base.llamarpc.com": Object.freeze(["/"]),
  "base.drpc.org": Object.freeze(["/"]),
  "base.meowrpc.com": Object.freeze(["/"]),
  "1rpc.io": Object.freeze(["/base"]),
  "base.public.blxrbdn.com": Object.freeze(["/"])
});

class FallbackError extends Error {
  constructor(code) {
    super(code);
    this.name = "FallbackError";
    this.code = code;
  }
}

const stop = (code) => { throw new FallbackError(code); };

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

function identity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function readStableInventory() {
  let before;
  let real;
  let descriptor;
  let handleBefore;
  let bytes;
  let handleAfter;
  let after;
  try {
    before = fs.lstatSync(INVENTORY_FILE);
    real = fs.realpathSync.native(INVENTORY_FILE);
    if (!before.isFile() || before.isSymbolicLink() || real !== INVENTORY_FILE
        || before.size < 1 || before.size > LIMITS.inventoryBytes) stop("INVENTORY_INVALID");
    descriptor = fs.openSync(INVENTORY_FILE, "r");
    handleBefore = fs.fstatSync(descriptor);
    bytes = fs.readFileSync(descriptor);
    handleAfter = fs.fstatSync(descriptor);
    after = fs.lstatSync(INVENTORY_FILE);
  } catch (error) {
    if (error instanceof FallbackError) throw error;
    stop("INVENTORY_INVALID");
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch (_) { /* No output side effect. */ }
  }
  if (bytes.length !== before.size || !same(identity(before), identity(after))
      || !same(identity(handleBefore), identity(handleAfter))
      || String(before.dev) !== String(handleBefore.dev) || String(before.ino) !== String(handleBefore.ino)) {
    stop("INVENTORY_MUTATED");
  }
  return { text: bytes.toString("utf8"), identity: identity(after) };
}

function assertInventoryUnchanged(expected) {
  let current;
  let real;
  try {
    current = fs.lstatSync(INVENTORY_FILE);
    real = fs.realpathSync.native(INVENTORY_FILE);
  } catch (_) {
    stop("INVENTORY_MUTATED");
  }
  if (!current.isFile() || current.isSymbolicLink() || real !== INVENTORY_FILE || !same(identity(current), expected)) {
    stop("INVENTORY_MUTATED");
  }
}

function familyOf(hostname) {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const finalTwo = labels.slice(-2).join(".");
  return /^(?:co|com|net|org)\.[a-z]{2}$/u.test(finalTwo) ? labels.slice(-3).join(".") : finalTwo;
}

function fixedPublic(url) {
  const paths = FIXED_PUBLIC_BASE[url.hostname.toLowerCase()];
  return Boolean(paths && paths.includes(url.pathname));
}

function parsePublicInventoryText(text, { fixedOnly = false } = {}) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") < 1
      || Buffer.byteLength(text, "utf8") > LIMITS.inventoryBytes) stop("INVENTORY_INVALID");
  const lines = text.split(/\r?\n/u);
  const candidates = [];
  const seen = new Set();
  let section = "";
  let ordinal = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed.length <= 256 && !/https?:\/\//iu.test(trimmed)
        && /^(?:#+|\[|---|[A-Za-z0-9 _():/-]+(?:endpoints?|providers?|rpc)\s*:?)?/u.test(trimmed)) section = trimmed;
    for (const match of line.matchAll(/https?:\/\/[^\s<'"`\])}]+/giu)) {
      const localOrdinal = ordinal++;
      let url;
      try { url = new URL(match[0].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
      const context = `${section} ${line}`;
      const lower = context.toLowerCase();
      const lineLower = line.toLowerCase();
      const baseDeclared = /\bbase(?:[- _]?mainnet)?\b|\b(?:chain(?:id)?|eip155)\s*[:=]?\s*8453\b/u.test(lower);
      const baseDeclaredOnRow = /\bbase(?:[- _]?mainnet)?\b|\b(?:chain(?:id)?|eip155)\s*[:=]?\s*8453\b/u.test(lineLower);
      const otherChainOnRow = /\b(?:ethereum|eth[- _]?mainnet|arbitrum|optimism|polygon|bnb|bsc|avalanche|linea|scroll|zksync|solana)\b/u.test(lineLower);
      const explicitlyPublic = /\bpublic\b|\bopen\b|\bno[- ]?auth\b|\bwithout[- ]?auth\b|\bunauthenticated\b/u.test(lower);
      const forbiddenContext = /\b(?:premium|credentialed|paid|api[- _]?key|token|secret|authorization|bearer|header|origin|app[- _]?scoped|private|restricted|internal|leaked|compromised|placeholder|template|example|deprecated|retired|failed|unavailable|unsupported)\b/u.test(lower);
      const forbiddenUrl = url.protocol !== "https:" || Boolean(url.username || url.password || url.hash || url.search)
        || (url.port !== "" && url.port !== "443")
        || /(?:localhost|\.local|\.internal|\.invalid)$/u.test(url.hostname.toLowerCase())
        || /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(url.hostname)
        || /(?:key|token|auth|secret|origin|app)/iu.test(url.pathname)
        || url.pathname.split("/").some((part) => part.length > 20 || /[{}<>$%]/u.test(part));
      if (forbiddenContext || forbiddenUrl || (otherChainOnRow && !baseDeclaredOnRow)
          || !(fixedPublic(url) || (baseDeclared && explicitlyPublic))) continue;
      if (fixedOnly && !fixedPublic(url)) continue;
      const key = url.href;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ url, family: familyOf(url.hostname), ordinal: localOrdinal });
      if (candidates.length >= LIMITS.candidates) return candidates;
    }
  }
  return candidates;
}

function placeholderEndpoint(url, context) {
  let material;
  try { material = decodeURIComponent(`${url.pathname} ${url.search}`); } catch (_) { return true; }
  return /(?:^|\.)(?:example|placeholder|invalid)(?:\.|$)/iu.test(url.hostname)
    || /(?:\{|\}|<|>|\$\{|your[-_ ]?(?:api[-_ ]?)?key|replace[-_ ]?(?:me|this)|insert[-_ ]?(?:key|token)|placeholder|changeme|api[-_ ]?key[-_ ]?here)/iu.test(`${context} ${material}`);
}

function parseAuthorizedInventoryText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") < 1
      || Buffer.byteLength(text, "utf8") > LIMITS.inventoryBytes) stop("INVENTORY_INVALID");
  const candidates = []; const seen = new Set(); let section = ""; let ordinal = 0;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim(); if (trimmed && trimmed.length <= 512 && !/https?:\/\//iu.test(trimmed)) section = trimmed;
    for (const match of line.matchAll(/https?:\/\/[^\s<'"`\])}]+/giu)) {
      const localOrdinal = ordinal++; let url;
      try { url = new URL(match[0].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
      const context = `${section} ${line}`; const lower = context.toLowerCase(); const rowLower = line.toLowerCase();
      const baseDeclared = /\bbase(?:[- _]?mainnet)?\b|\b(?:chain(?:id)?|eip155)\s*[:=]?\s*8453\b/u.test(lower);
      const baseOnRow = /\bbase(?:[- _]?mainnet)?\b|\b(?:chain(?:id)?|eip155)\s*[:=]?\s*8453\b/u.test(rowLower);
      const otherChainOnRow = /\b(?:ethereum|eth[- _]?mainnet|arbitrum|optimism|polygon|bnb|bsc|avalanche|linea|scroll|zksync|solana)\b/u.test(rowLower);
      const forbiddenContext = /\b(?:restricted|unavailable|disabled|retired|deprecated|unsupported|failed|dead|app[- _]?scoped|private|internal)\b|\bdo[- ]?not[- ]?use\b/iu.test(lower)
        || /\b(?:origin[- _]?required|browser[- _]?only|session[- _]?auth|session|cookie|referer|cors)\b|\brequires?\b[^\r\n]{0,40}\borigin\b/iu.test(lower)
        || /\b(?:custom[- _]?headers?|authorization|bearer|x[- _]?api[- _]?key)\b|\brequires?\b[^\r\n]{0,40}\bheaders?\b/iu.test(lower);
      const forbiddenUrl = url.protocol !== "https:" || Boolean(url.username || url.password || url.hash)
        || (url.port !== "" && url.port !== "443") || /(?:localhost|\.local|\.internal|\.invalid)$/u.test(url.hostname.toLowerCase())
        || /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(url.hostname);
      if (!baseDeclared || (otherChainOnRow && !baseOnRow) || forbiddenContext || forbiddenUrl || placeholderEndpoint(url, context)) continue;
      if (seen.has(url.href)) continue; seen.add(url.href); candidates.push({ url, family: familyOf(url.hostname), ordinal: localOrdinal });
      if (candidates.length >= LIMITS.candidates) return candidates;
    }
  }
  return candidates;
}

const parseInventoryText = parsePublicInventoryText;

function loadFactoryAddress(readFile = fs.readFileSync) {
  let bytes;
  try { bytes = readFile(FACTORY_MANIFEST); } catch (_) { stop("MANIFEST_INVALID"); }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 1 || buffer.length > LIMITS.manifestBytes) stop("MANIFEST_INVALID");
  let manifest;
  try { manifest = JSON.parse(buffer.toString("utf8")); } catch (_) { stop("MANIFEST_INVALID"); }
  if (!manifest || typeof manifest.address !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(manifest.address)) stop("MANIFEST_INVALID");
  return manifest.address.toLowerCase();
}

function quantity(value, code = "QUANTITY_INVALID") {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) stop(code);
  return BigInt(value);
}

function quantityHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function exactHex(value, bytes, code) {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`, "u").test(value)) stop(code);
  return value;
}

function parseHeader(value, expectedNumber = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop("HEADER_INVALID");
  const number = quantity(value.number, "HEADER_INVALID");
  if (expectedNumber !== null && number !== BigInt(expectedNumber)) stop("HEADER_INVALID");
  const projection = {
    number: value.number,
    hash: exactHex(value.hash, 32, "HEADER_INVALID"),
    parentHash: exactHex(value.parentHash, 32, "HEADER_INVALID"),
    stateRoot: exactHex(value.stateRoot, 32, "HEADER_INVALID"),
    transactionsRoot: exactHex(value.transactionsRoot, 32, "HEADER_INVALID"),
    receiptsRoot: exactHex(value.receiptsRoot, 32, "HEADER_INVALID"),
    logsBloom: exactHex(value.logsBloom, 256, "HEADER_INVALID"),
    timestamp: quantityHex(quantity(value.timestamp, "HEADER_INVALID")),
    gasLimit: quantityHex(quantity(value.gasLimit, "HEADER_INVALID")),
    gasUsed: quantityHex(quantity(value.gasUsed, "HEADER_INVALID"))
  };
  if (value.baseFeePerGas !== undefined) projection.baseFeePerGas = quantityHex(quantity(value.baseFeePerGas, "HEADER_INVALID"));
  return { number, hash: projection.hash, projection: canonical(projection) };
}

class Budget {
  constructor(options = {}) {
    this.started = Date.now();
    this.requests = 0;
    this.bytes = 0;
    this.requestCap = options.maxRequests ?? LIMITS.requests;
    this.responseCap = options.maxResponseBytes ?? LIMITS.responseBytes;
    this.totalCap = options.maxTotalResponseBytes ?? LIMITS.totalResponseBytes;
    this.wallCap = options.maxWallMs ?? LIMITS.wallMs;
    this.requestMs = options.requestMs ?? LIMITS.requestMs;
  }
  use() {
    this.requests += 1;
    if (this.requests > this.requestCap || Date.now() - this.started > this.wallCap) stop("REQUEST_CAP_EXCEEDED");
  }
  add(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.responseCap) stop("RESPONSE_CAP_EXCEEDED");
    this.bytes += bytes;
    if (this.bytes > this.totalCap) stop("TOTAL_RESPONSE_CAP_EXCEEDED");
  }
}

async function consumeResponse(response, cap) {
  if (!response || response.status !== 200) stop("RPC_HTTP_INVALID");
  const declared = response.headers && typeof response.headers.get === "function" ? response.headers.get("content-length") : null;
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > cap) stop("RESPONSE_CAP_EXCEEDED");
  let size = 0;
  const chunks = [];
  if (!response.body || typeof response.body.getReader !== "function") stop("RPC_BODY_INVALID");
  const reader = response.body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value instanceof Uint8Array ? item.value : new Uint8Array(item.value);
      size += chunk.byteLength;
      if (size > cap) stop("RESPONSE_CAP_EXCEEDED");
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    try { reader.releaseLock(); } catch (_) { /* Response remains process-only. */ }
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { stop("RPC_JSON_INVALID"); }
  return { value, bytes: size };
}

async function fetchTransport({ candidate, envelope, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(candidate.url.href, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" },
      body: JSON.stringify(envelope)
    });
    return consumeResponse(response, maxBytes);
  } catch (error) {
    if (error instanceof FallbackError) throw error;
    stop("RPC_TRANSPORT_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(candidate, method, params, budget, transport) {
  if (!ALLOWED_METHODS.has(method)) stop("RPC_METHOD_FORBIDDEN");
  budget.use();
  const envelope = { jsonrpc: "2.0", id: budget.requests, method, params };
  let row;
  let timeout;
  try {
    row = await Promise.race([
      transport({ candidate, envelope, timeoutMs: budget.requestMs, maxBytes: budget.responseCap }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new FallbackError("RPC_TIMEOUT")), budget.requestMs); })
    ]);
  } catch (error) {
    if (error instanceof FallbackError) throw error;
    stop("RPC_TRANSPORT_FAILED");
  } finally {
    clearTimeout(timeout);
  }
  if (!row || !Object.hasOwn(row, "value") || !Number.isSafeInteger(row.bytes)) stop("RPC_RESPONSE_INVALID");
  budget.add(row.bytes);
  const value = row.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0"
      || value.id !== envelope.id || Object.hasOwn(value, "error") || !Object.hasOwn(value, "result")) stop("RPC_RESPONSE_INVALID");
  return value.result;
}

async function qualify(candidate, fromBlock, toBlock, factory, budget, transport) {
  if (quantity(await rpc(candidate, "eth_chainId", [], budget, transport), "CHAIN_INVALID") !== CHAIN_ID) stop("WRONG_CHAIN");
  const finalized = parseHeader(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport));
  if (finalized.number < BigInt(toBlock)) stop("NON_FINALIZED_BOUNDARY");
  const from = parseHeader(await rpc(candidate, "eth_getBlockByNumber", [quantityHex(fromBlock), false], budget, transport), fromBlock);
  const to = fromBlock === toBlock ? from
    : parseHeader(await rpc(candidate, "eth_getBlockByNumber", [quantityHex(toBlock), false], budget, transport), toBlock);
  const probe = await rpc(candidate, "trace_filter", [{
    fromBlock: quantityHex(fromBlock), toBlock: quantityHex(toBlock), toAddress: [factory], after: 0, count: 1
  }], budget, transport);
  if (!Array.isArray(probe) || probe.length > 1) stop("TRACE_FILTER_UNAVAILABLE");
  return { candidate, finalized, from, to };
}

function boundariesEqual(left, right) {
  return left.finalized.projection === right.finalized.projection
    && left.from.projection === right.from.projection && left.to.projection === right.to.projection;
}

async function selectPair(candidates, fromBlock, toBlock, factory, budget, transport, flags) {
  const qualified = [];
  const attemptedFamilies = new Set();
  for (const candidate of candidates) {
    if (attemptedFamilies.size >= LIMITS.families) break;
    if (attemptedFamilies.has(candidate.family)) continue;
    attemptedFamilies.add(candidate.family);
    flags.candidatesQualified += 0;
    let row;
    try { row = await qualify(candidate, fromBlock, toBlock, factory, budget, transport); }
    catch (_) { continue; }
    flags.candidatesQualified += 1;
    for (const prior of qualified) {
      if (prior.candidate.family !== row.candidate.family && boundariesEqual(prior, row)) {
        flags.chain8453 = true;
        flags.boundaryAgreement = true;
        flags.traceFilterQualified = true;
        return [prior, row];
      }
    }
    qualified.push(row);
  }
  stop("TWO_FAMILIES_UNAVAILABLE");
}

function tracePosition(trace) {
  if (!Array.isArray(trace.traceAddress) || trace.traceAddress.length > 64
      || trace.traceAddress.some((item) => !Number.isSafeInteger(item) || item < 0)) stop("TRACE_ADDRESS_INVALID");
  return trace.traceAddress;
}

function comparePosition(left, right) {
  if (left.block !== right.block) return left.block < right.block ? -1 : 1;
  if (left.transaction !== right.transaction) return left.transaction < right.transaction ? -1 : 1;
  const length = Math.min(left.trace.length, right.trace.length);
  for (let index = 0; index < length; index += 1) {
    if (left.trace[index] !== right.trace[index]) return left.trace[index] < right.trace[index] ? -1 : 1;
  }
  return left.trace.length === right.trace.length ? 0 : left.trace.length < right.trace.length ? -1 : 1;
}

function parseTrace(trace, factory, fromBlock, toBlock) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace) || trace.type !== "call"
      || (Object.hasOwn(trace, "error") && trace.error !== null)) stop("TRACE_ERROR_OR_SHAPE_INVALID");
  if (!trace.action || typeof trace.action !== "object" || Array.isArray(trace.action)
      || trace.action.to !== factory || !["call", "delegatecall", "staticcall"].includes(trace.action.callType)
      || typeof trace.action.input !== "string" || !/^0x(?:[0-9a-f]{2})*$/u.test(trace.action.input)) {
    stop("TRACE_ACTION_INVALID");
  }
  const block = quantity(trace.blockNumber, "TRACE_BLOCK_INVALID");
  if (block < BigInt(fromBlock) || block > BigInt(toBlock)) stop("TRACE_BLOCK_INVALID");
  let transaction;
  if (Number.isSafeInteger(trace.transactionPosition) && trace.transactionPosition >= 0) transaction = trace.transactionPosition;
  else {
    const value = quantity(trace.transactionPosition, "TRACE_TRANSACTION_POSITION_INVALID");
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) stop("TRACE_TRANSACTION_POSITION_INVALID");
    transaction = Number(value);
  }
  const transactionHash = exactHex(trace.transactionHash, 32, "TRACE_ACTION_INVALID");
  return {
    block,
    transaction,
    trace: tracePosition(trace),
    transactionHash,
    callType: trace.action.callType,
    input: trace.action.input,
    spell: trace.action.input.slice(0, 10) === SPELL_SELECTOR
  };
}

async function enumerate(candidate, fromBlock, toBlock, factory, budget, transport, options = {}) {
  const pageSize = LIMITS.tracePageSize;
  const maxPages = options.maxTracePages ?? LIMITS.tracePages;
  const maxRecords = options.maxTraceRecords ?? LIMITS.traceRecords;
  let after = 0;
  let pages = 0;
  let records = 0;
  let previous = null;
  const seen = new Set();
  const traces = [];
  const spell = [];
  while (true) {
    if (pages >= maxPages) stop("TRACE_PAGE_CAP_EXCEEDED");
    pages += 1;
    const result = await rpc(candidate, "trace_filter", [{
      fromBlock: quantityHex(fromBlock), toBlock: quantityHex(toBlock), toAddress: [factory], after, count: pageSize
    }], budget, transport);
    if (!Array.isArray(result) || result.length > pageSize) stop("TRACE_PAGE_INVALID");
    for (const item of result) {
      records += 1;
      if (records > maxRecords) stop("TRACE_RECORD_CAP_EXCEEDED");
      const position = parseTrace(item, factory, fromBlock, toBlock);
      const key = `${position.block}:${position.transaction}:${position.trace.join(".")}`;
      if (seen.has(key)) stop("TRACE_DUPLICATE");
      seen.add(key);
      if (previous !== null && comparePosition(previous, position) >= 0) stop("TRACE_ORDER_INVALID");
      previous = position;
      const normalized = { block: position.block.toString(), transaction: position.transaction, trace: position.trace,
        transactionHash: position.transactionHash, callType: position.callType, input: position.input };
      traces.push(normalized);
      if (position.spell) spell.push(commitment("spell-position", key));
    }
    after += result.length;
    if (result.length < pageSize) break;
  }
  return { traceCount: traces.length, spellCount: spell.length, spellPositions: spell.sort(),
    traceEvidenceCommitment: commitment("trace-evidence", canonical(traces)) };
}

async function terminalRecheck(selected, fromBlock, toBlock, budget, transport) {
  const rows = [];
  for (const selectedRow of selected) {
    const from = parseHeader(await rpc(selectedRow.candidate, "eth_getBlockByNumber", [quantityHex(fromBlock), false], budget, transport), fromBlock);
    const to = fromBlock === toBlock ? from
      : parseHeader(await rpc(selectedRow.candidate, "eth_getBlockByNumber", [quantityHex(toBlock), false], budget, transport), toBlock);
    const finalized = parseHeader(await rpc(selectedRow.candidate, "eth_getBlockByNumber", [quantityHex(selectedRow.finalized.number), false], budget, transport), selectedRow.finalized.number);
    if (from.projection !== selectedRow.from.projection || to.projection !== selectedRow.to.projection
        || finalized.projection !== selectedRow.finalized.projection) stop("TERMINAL_HEADER_CHANGED");
    rows.push({ finalized, from, to });
  }
  if (rows.length !== 2 || rows[0].finalized.projection !== rows[1].finalized.projection
      || rows[0].from.projection !== rows[1].from.projection || rows[0].to.projection !== rows[1].to.projection) {
    stop("TERMINAL_HEADER_MISMATCH");
  }
}

function defaultFlags() {
  return {
    candidatesQualified: 0,
    inventoryStable: false,
    twoIndependentFamilies: false,
    chain8453: false,
    finalizedAgreement: false,
    boundaryAgreement: false,
    traceFilterQualified: false,
    paginationExhaustive: false,
    traceAgreement: false,
    terminalHeaderRecheck: false
  };
}

function result(status, failurePhase, failureCode, window, candidateCount, selected, budget, observation, flags) {
  const complete = status === COMPLETE_STATUS || status === DELTA_STATUS;
  const core = {
    status,
    failurePhase,
    failureCode,
    window: window ? { fromBlock: window.fromBlock, toBlock: window.toBlock } : null,
    anonymousCandidateCount: candidateCount,
    anonymousQualifiedCount: flags.candidatesQualified,
    anonymousSelectedCount: selected.length,
    readCount: budget.requests,
    selectedFamilyOrdinalCommitments: selected.map((row) => commitment("family-ordinal", String(row.candidate.ordinal))),
    traceCount: complete ? observation.traceCount : null,
    spellCount: complete ? observation.spellCount : null,
    spellPositionCommitments: complete ? observation.spellPositions : [],
    traceEvidenceCommitment: complete ? observation.traceEvidenceCommitment : null,
    completeness: flags,
    temporaryMaterialCleanupComplete: null,
    forkEligible: false,
    routePositive: false,
    execution: false,
    signed: false
  };
  return { ...core, derivedHash: commitment("derived", canonical(core)) };
}

function injectedInventory(options) {
  if (typeof options.inventoryText !== "string") return null;
  if (Buffer.byteLength(options.inventoryText, "utf8") > LIMITS.inventoryBytes) stop("INVENTORY_INVALID");
  return { text: options.inventoryText, identity: options.inventoryIdentity ?? "injected" };
}

async function runFallback(options = {}) {
  const flags = defaultFlags();
  const budget = new Budget(options);
  let candidateCount = 0;
  let selected = [];
  let window = null;
  let inventory = null;
  const checkInventory = options.assertInventoryUnchangedFn ?? ((expected) => assertInventoryUnchanged(expected));
  try {
    const fromBlock = Number(options.fromBlock);
    const toBlock = Number(options.toBlock);
    if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock
        || toBlock - fromBlock + 1 > LIMITS.windowBlocks) stop("WINDOW_INVALID");
    window = { fromBlock, toBlock };
    inventory = injectedInventory(options) ?? (options.readInventoryFn ? options.readInventoryFn() : readStableInventory());
    if (!inventory || typeof inventory.text !== "string" || !Object.hasOwn(inventory, "identity")) stop("INVENTORY_INVALID");
    const parseInventory = options.inventoryAuthorizedMode === false ? parsePublicInventoryText : parseAuthorizedInventoryText;
    const candidates = parseInventory(inventory.text);
    candidateCount = candidates.length;
    const factory = loadFactoryAddress(options.readFileFn ?? fs.readFileSync);
    const transport = options.transport ?? fetchTransport;
    selected = await selectPair(candidates, fromBlock, toBlock, factory, budget, transport, flags);
    flags.twoIndependentFamilies = true;
    flags.finalizedAgreement = true;
    const observations = [];
    for (const row of selected) observations.push(await enumerate(row.candidate, fromBlock, toBlock, factory, budget, transport, options));
    flags.paginationExhaustive = true;
    if (!same(observations[0], observations[1])) stop("TRACE_AGREEMENT_FAILED");
    flags.traceAgreement = true;
    await terminalRecheck(selected, fromBlock, toBlock, budget, transport);
    flags.terminalHeaderRecheck = true;
    checkInventory(inventory.identity);
    flags.inventoryStable = true;
    const observation = observations[0];
    return result(observation.spellCount === 0 ? COMPLETE_STATUS : DELTA_STATUS, null, null,
      window, candidateCount, selected, budget, observation, flags);
  } catch (error) {
    if (inventory !== null) {
      try { checkInventory(inventory.identity); flags.inventoryStable = true; } catch (_) { flags.inventoryStable = false; }
    }
    const code = error instanceof FallbackError ? error.code : "INTERNAL_ERROR";
    return result(INCOMPLETE_STATUS, PHASE_BY_CODE[code] ?? "INTERNAL", code, window, candidateCount, selected, budget, null, flags);
  }
}

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--from-block", "--to-block"].includes(flag) || index + 1 >= argv.length) stop("ARGUMENT_INVALID");
    const key = flag === "--from-block" ? "fromBlock" : "toBlock";
    if (Object.hasOwn(output, key)) stop("ARGUMENT_INVALID");
    output[key] = argv[++index];
  }
  if (!Object.hasOwn(output, "fromBlock") || !Object.hasOwn(output, "toBlock")) stop("ARGUMENT_INVALID");
  return output;
}

async function main() {
  let output;
  try { output = await runFallback(parseArgs(process.argv.slice(2))); }
  catch (error) { const code = error instanceof FallbackError ? error.code : "ARGUMENT_INVALID";
    output = result(INCOMPLETE_STATUS, PHASE_BY_CODE[code] ?? "WINDOW", code, null, 0, [], new Budget(), null, defaultFlags()); }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.status === INCOMPLETE_STATUS) process.exitCode = 1;
}

module.exports = {
  COMPLETE_STATUS,
  DELTA_STATUS,
  FACTORY_MANIFEST,
  INCOMPLETE_STATUS,
  INVENTORY_FILE,
  LIMITS,
  SPELL_SELECTOR,
  parseAuthorizedInventoryText,
  parseInventoryText,
  parsePublicInventoryText,
  parseFixedPublicInventoryText: (text) => parsePublicInventoryText(text, { fixedOnly: true }),
  runFallback
};

if (require.main === module) main();
