#!/usr/bin/env node
"use strict";

/*
 * Babylon BAB-H-01 Step 11 token-safe Mintscan pre-retention enumerator.
 *
 * Live mode is read-only and deliberately refuses to run without a bearer in
 * MINTSCAN_API_TOKEN. The bearer is held only in process memory. It is never
 * logged, hashed, serialized, sent to child processes, or included in errors.
 * No live request is made by the offline test suite.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BASE = "babylon-mintscan-pre-retention-enumerator";
const TOOL = path.join(ROOT, "tools", `scan-${BASE}.js`);
const RAW = path.join(ROOT, "reports", "raw", "fast", `${BASE}.json`);
const MANIFEST = path.join(ROOT, "reports", "raw", "fast", `${BASE}.manifest.json`);
const REPORT = path.join(ROOT, "reports", `${BASE}.md`);
const DEFINITIONS = path.join(ROOT, "reports", `${BASE}-definitions.md`);
const SOURCES = path.join(ROOT, "reports", `${BASE}-sources.md`);
const HANDOFF = path.join(ROOT, "coordination", "handoffs", "2026-07-18-critical-babylon-step11-mintscan-handoff.md");
const INBOX = path.join(ROOT, "coordination", "inbox", "critical", "2026-07-18-critical-babylon-step11-mintscan.json");
const LIVE_OUTPUT_PATHS = [RAW, REPORT, DEFINITIONS, SOURCES, HANDOFF, INBOX, MANIFEST];

const STEP9_RAW = path.join(ROOT, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.json");
const STEP9_MANIFEST = path.join(ROOT, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.manifest.json");
const STEP9_TX_FACTS = path.join(ROOT, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.tx-event-facts.json");
const STEP9_BOUNDARY = path.join(ROOT, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.archive-boundary.json");
const STEP10_RAW = path.join(ROOT, "reports", "raw", "fast", "babylon-pre-retention-source-readiness.json");
const STEP10_MANIFEST = path.join(ROOT, "reports", "raw", "fast", "babylon-pre-retention-source-readiness.manifest.json");
const PRIOR_BLOCKED_RUN = "babylon-step11-mintscan-blocked-20260718050209-52cd7578dcdd";
const PRIOR_BLOCKED_ARCHIVE_INDEX = path.join(ROOT, "reports", "history", PRIOR_BLOCKED_RUN, "ARCHIVE-INDEX.json");

const EXPECTED_STEP9_RUN = "babylon-step9-r3-20260717212558-9b163306c904";
const EXPECTED_STEP9_AGGREGATE = "8d132b0917d160dc6334e119a7c2520ac2b3b15d0809f31dd519531075a08a5a";
const EXPECTED_STEP10_RUN = "babylon-step10-r3-20260718023612-374e5747da72";
const EXPECTED_STEP10_REVISION = "r3-oracle-revised";
const ADDRESS_HASH_SALT = "babylon-step11-address-v1";
const IDENTITY_HASH_SALT = "babylon-step11-identity-v1";
const TARGET_MSG = "/babylon.btcstaking.v1.MsgAddCovenantSigs";
const MSG_EXEC = "/cosmos.authz.v1beta1.MsgExec";
const LAST_PRE_RETENTION_HEIGHT = "2556425";
const FIRST_RETAINED_HEIGHT = "2556426";

const API_ORIGIN = ["h", "ttps", "://", "apis", ".", "mintscan", ".", "io"].join("");
const API_HOST = ["apis", ".", "mintscan", ".", "io"].join("");
const API_ACCOUNT_PATH = /^\/v1\/babylon\/accounts\/(bbn1[02-9ac-hj-np-z]{20,80})\/transactions$/;
const API_DETAIL_PATH = /^\/v1\/babylon\/txs\/([0-9a-fA-F]{64})$/;
const COMET_PATHS = new Set(["/tx_search", "/block"]);
const REST_TX_PATH = "/cosmos/tx/v1beta1/txs";
const ALLOWED_ACCOUNT_QUERY = new Set(["take", "messageTypes[0]", "fromDateTime", "toDateTime", "searchAfter"]);
const ALLOWED_DETAIL_QUERY = new Set(["height"]);
const ALLOWED_COMET_QUERY = new Set(["query", "prove", "page", "per_page", "order_by", "height"]);
const ALLOWED_REST_TX_QUERY = new Set(["events", "pagination.limit", "pagination.offset", "order_by"]);

const LIMITS = Object.freeze({
  maxBodyBytes: 2 * 1024 * 1024,
  maxRequests: 25000,
  maxRuntimeMs: 90 * 60 * 1000,
  minRequestIntervalMs: 125,
  requestTimeoutMs: 15000,
  maxRetries: 5,
  maxBackoffMs: 10000,
  maxPagesPerAccountWindow: 2000,
  maxRecordsPerAccountWindow: 100000,
  maxSignerFixedPointRounds: 8,
  maxDiscoveredSigners: 256,
  accountPageTake: 100,
  cometPageSize: 100,
});

class SafeError extends Error {
  constructor(code, diagnostic = {}) {
    super(code);
    this.name = "SafeError";
    this.code = code;
    this.diagnostic = sanitizeDiagnostic(diagnostic);
  }
}

function shaBytes(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function shaFile(file) { return shaBytes(fs.readFileSync(file)); }
function hashText(value) { return shaBytes(Buffer.from(String(value), "utf8")); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function json(value) { return JSON.stringify(canonical(value), null, 2) + "\n"; }
function normalizeHash(value) {
  const text = String(value || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new SafeError("INVALID_TRANSACTION_HASH");
  return text;
}
function normalizeHeight(value) {
  const text = String(value == null ? "" : value);
  if (!/^\d+$/.test(text)) throw new SafeError("INVALID_HEIGHT");
  return text;
}
function normalizeTime(value) {
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) throw new SafeError("INVALID_TIMESTAMP");
  return date.toISOString();
}
function isAddress(value) { return /^bbn1[02-9ac-hj-np-z]{20,80}$/.test(String(value || "")); }
function addressHash(value) {
  if (!isAddress(value)) throw new SafeError("INVALID_BABYLON_ADDRESS");
  return hashText(`${ADDRESS_HASH_SALT}\0${value}`);
}
function identityHash(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) throw new SafeError("OUTER_SIGNER_IDENTITY_INVALID");
  return hashText(`${IDENTITY_HASH_SALT}\0${value}`);
}
function safeType(value, code) {
  const text = String(value || "");
  if (!text || text.length > 160 || !/^[A-Za-z0-9_./:-]+$/.test(text) || text.includes("://") || /bearer|token|authorization|cookie/i.test(text)) throw new SafeError(code);
  return text;
}
function pairKey(txHash, messageIndex) { return `${normalizeHash(txHash)}:${Number(messageIndex)}`; }
function sanitizeDiagnostic(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 32).map(sanitizeDiagnostic);
  if (typeof value === "object") {
    const out = {};
    const allowed = new Set(["category", "causeCode", "source", "requestClass", "status", "attempts", "responseBytes", "schemaFingerprint", "observed", "expected", "pairCount", "signerCount", "missingPairCount", "extraPairCount", "height", "window", "pages", "count"]);
    for (const [key, item] of Object.entries(value)) {
      if (!allowed.has(key)) continue;
      out[key] = sanitizeDiagnostic(item);
    }
    return out;
  }
  if (typeof value === "string") {
    return value
      .replace(/h.?ttps?:\/\/\S+/gi, "[target-omitted]")
      .replace(/bbn1[02-9ac-hj-np-z]{20,80}/g, "[address-omitted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .slice(0, 240);
  }
  return value;
}
function schemaShape(value, depth = 0) {
  if (depth > 8) return "depth-cap";
  if (Array.isArray(value)) return value.length ? [schemaShape(value[0], depth + 1)] : [];
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, schemaShape(value[key], depth + 1)]));
  if (value === null) return "null";
  return typeof value;
}
function schemaFingerprint(value) { return hashText(json(schemaShape(value))); }
function deepFind(object, paths) {
  for (const keys of paths) {
    let value = object;
    for (const key of keys) value = value && typeof value === "object" ? value[key] : undefined;
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function bindContext() {
  for (const file of [STEP9_RAW, STEP9_MANIFEST, STEP9_TX_FACTS, STEP9_BOUNDARY, STEP10_RAW, STEP10_MANIFEST, PRIOR_BLOCKED_ARCHIVE_INDEX]) {
    if (!fs.existsSync(file)) throw new SafeError("REQUIRED_CONTEXT_MISSING", { file: rel(file) });
  }
  const step9Raw = readJson(STEP9_RAW);
  const step9Manifest = readJson(STEP9_MANIFEST);
  const step10Raw = readJson(STEP10_RAW);
  const step10Manifest = readJson(STEP10_MANIFEST);
  const boundary = readJson(STEP9_BOUNDARY);
  const priorBlocked = readJson(PRIOR_BLOCKED_ARCHIVE_INDEX);
  if (step9Raw.runId !== EXPECTED_STEP9_RUN || step9Manifest.runId !== EXPECTED_STEP9_RUN || step9Manifest.aggregateSha256 !== EXPECTED_STEP9_AGGREGATE) throw new SafeError("STEP9_BINDING_MISMATCH");
  if (step10Raw.runId !== EXPECTED_STEP10_RUN || step10Manifest.runId !== EXPECTED_STEP10_RUN || step10Raw.evidenceRevision !== EXPECTED_STEP10_REVISION) throw new SafeError("STEP10_BINDING_MISMATCH");
  const captures = step10Raw.mintscan && step10Raw.mintscan.sourceCaptureRecords;
  if (!Array.isArray(captures)) throw new SafeError("STEP10_SOURCE_CAPTURES_MISSING");
  const accountCapture = captures.find((row) => row.path === "pages/apis/reference/historical/account/account-transactions.mdx");
  const detailCapture = captures.find((row) => row.path === "pages/apis/reference/historical/txs/transactions-hash.mdx");
  const accountSchema = step10Raw.mintscan.accountTransactions;
  const detailSchema = step10Raw.mintscan.transactionDetail;
  const accountRouteBound = accountCapture && accountCapture.httpStatus === 200 && accountCapture.facts.routes.some((route) => route.method === "GET" && route.pathTemplate === "/v1/:network/accounts/:address/transactions");
  const detailRouteBound = detailCapture && detailCapture.httpStatus === 200 && detailCapture.facts.routes.some((route) => route.method === "GET" && route.pathTemplate === "/v1/:network/txs/:hash");
  const accountFields = ["take", "messageTypes[]", "fromDateTime", "toDateTime", "searchAfter"];
  if (!accountRouteBound || !detailRouteBound || !accountFields.every((field) => accountSchema.queryParameters.includes(field)) || !detailSchema.queryParameters.includes("height")) throw new SafeError("STEP10_DOCUMENTED_SCHEMA_MISMATCH");
  if (priorBlocked.runId !== PRIOR_BLOCKED_RUN || priorBlocked.disposition !== "SUPERSEDED_BLOCKED_CONTEXT") throw new SafeError("PRIOR_BLOCKED_ARCHIVE_MISMATCH");
  const unavailable = boundary.comet && boundary.comet.unavailablePredecessor;
  const earliest = boundary.comet && boundary.comet.earliestAvailable;
  if (boundary.fixedPin.height !== step9Raw.pin.height || unavailable.requestedHeight !== LAST_PRE_RETENTION_HEIGHT || unavailable.available !== false || unavailable.servedHeight !== null || unavailable.hash !== null || unavailable.time !== null || earliest.requestedHeight !== FIRST_RETAINED_HEIGHT || earliest.available !== true || earliest.servedHeight !== FIRST_RETAINED_HEIGHT || !earliest.time) throw new SafeError("STEP9_ARCHIVE_BOUNDARY_MISMATCH");
  return {
    step9: { runId: step9Raw.runId, aggregateSha256: step9Manifest.aggregateSha256, manifestFileSha256: shaFile(STEP9_MANIFEST), archiveBoundaryFileSha256: shaFile(STEP9_BOUNDARY), archiveBoundary: { unavailableHeight: unavailable.requestedHeight, unavailableProven: true, unavailableTimestamp: null, firstAvailableHeight: earliest.servedHeight, firstAvailableTimestamp: earliest.time, firstAvailableHash: earliest.hash } },
    step10: { runId: step10Raw.runId, evidenceRevision: step10Raw.evidenceRevision, aggregateSha256: step10Manifest.aggregateSha256, manifestFileSha256: shaFile(STEP10_MANIFEST), repositoryCommitSha: step10Raw.mintscan.repository.commitSha, repositoryTreeSha: step10Raw.mintscan.repository.treeSha },
    priorBlockedRun: { runId: priorBlocked.runId, disposition: priorBlocked.disposition, archiveIndexSha256: shaFile(PRIOR_BLOCKED_ARCHIVE_INDEX), archiveAggregateSha256: priorBlocked.aggregateSha256 },
    documentedSchemas: {
      accountTransactions: { method: "GET", pathTemplate: accountSchema.pathTemplate, queryParameters: ["take", "messageTypes[0]", "fromDateTime", "toDateTime", "searchAfter"], responseSchema: null, sourceResponseSha256: accountCapture.responseSha256 },
      transactionDetail: { method: "GET", pathTemplate: detailSchema.pathTemplate, queryParameters: ["height"], responseSchema: null, sourceResponseSha256: detailCapture.responseSha256 },
    },
  };
}

function loadStep9Baseline() {
  const facts = readJson(STEP9_TX_FACTS);
  const raw = readJson(STEP9_RAW);
  if (facts.runId !== EXPECTED_STEP9_RUN || !facts.pagination.complete || facts.pagination.rows !== 10185) throw new SafeError("STEP9_TRANSACTION_FACTS_INVALID");
  const txHashes = new Set();
  const pairs = new Set();
  const signerIdentityHashes = new Set();
  let messageCount = 0;
  let multiMessageTransactions = 0;
  for (const tx of facts.transactions) {
    const txHash = normalizeHash(tx.txHash);
    if (txHashes.has(txHash)) throw new SafeError("STEP9_DUPLICATE_TRANSACTION");
    txHashes.add(txHash);
    if (!Array.isArray(tx.signatureFacts) || tx.signatureFacts.length < 1) throw new SafeError("STEP9_SIGNATURE_FACTS_MISSING");
    if (tx.signatureFacts.length > 1) multiMessageTransactions++;
    for (const item of tx.signatureFacts) {
      const key = pairKey(txHash, item.messageIndex);
      if (pairs.has(key)) throw new SafeError("STEP9_DUPLICATE_MESSAGE_PAIR");
      pairs.add(key);
      messageCount++;
      if (/^[0-9a-f]{64}$/.test(item.signerIdentityHash || "")) signerIdentityHashes.add(item.signerIdentityHash);
    }
  }
  const expectedMulti = raw.transactions && raw.transactions.multiMessageTx;
  if (txHashes.size !== 10185 || messageCount !== 11412 || pairs.size !== 11412 || multiMessageTransactions !== 986 || expectedMulti !== 986 || signerIdentityHashes.size !== 9) throw new SafeError("STEP9_BASELINE_COUNT_MISMATCH");
  return {
    txHashes,
    pairs,
    signerIdentityHashes,
    counts: { transactions: txHashes.size, messagePairs: pairs.size, multiMessageTransactions, retainedSignerIdentityHashes: signerIdentityHashes.size },
    txHashSetSha256: hashText([...txHashes].sort().join("\n")),
    pairSetSha256: hashText([...pairs].sort().join("\n")),
    firstKnownTxHash: normalizeHash(facts.transactions[0].txHash),
  };
}

function assertHttpsOrigin(value, kind) {
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new SafeError(`${kind}_ORIGIN_INVALID`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new SafeError(`${kind}_ORIGIN_INVALID`);
  if (kind === "MINTSCAN" && (parsed.hostname !== API_HOST || parsed.origin !== API_ORIGIN)) throw new SafeError("MINTSCAN_HOST_NOT_ALLOWLISTED");
  if ((kind === "COMET" || kind === "REST") && (parsed.hostname === "localhost" || /^127\.|^10\.|^192\.168\.|^169\.254\./.test(parsed.hostname))) throw new SafeError(`${kind}_HOST_NOT_PUBLIC`);
  return parsed.origin;
}
function validatePathAndQuery(kind, pathname, query) {
  const entries = Object.entries(query || {}).filter(([, value]) => value !== undefined && value !== null);
  if (kind === "MINTSCAN_ACCOUNT") {
    if (!API_ACCOUNT_PATH.test(pathname) || entries.some(([key]) => !ALLOWED_ACCOUNT_QUERY.has(key))) throw new SafeError("MINTSCAN_ACCOUNT_TARGET_REJECTED");
    const required = Object.fromEntries(entries);
    if (required["messageTypes[0]"] !== TARGET_MSG) throw new SafeError("MINTSCAN_MESSAGE_FILTER_REJECTED");
  } else if (kind === "MINTSCAN_DETAIL") {
    if (!API_DETAIL_PATH.test(pathname) || entries.some(([key]) => !ALLOWED_DETAIL_QUERY.has(key))) throw new SafeError("MINTSCAN_DETAIL_TARGET_REJECTED");
  } else if (kind === "COMET") {
    if (!COMET_PATHS.has(pathname) || entries.some(([key]) => !ALLOWED_COMET_QUERY.has(key))) throw new SafeError("COMET_TARGET_REJECTED");
  } else if (kind === "REST_TX") {
    if (pathname !== REST_TX_PATH || entries.some(([key]) => !ALLOWED_REST_TX_QUERY.has(key))) throw new SafeError("REST_TX_TARGET_REJECTED");
  } else throw new SafeError("REQUEST_CLASS_REJECTED");
  return entries;
}

class BudgetedHttpClient {
  #token;
  constructor(options) {
    if (!options || typeof options.token !== "string" || options.token.length < 1) throw new SafeError("MINTSCAN_API_TOKEN_REQUIRED");
    this.#token = options.token;
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now || (() => Date.now());
    this.apiOrigin = assertHttpsOrigin(options.apiOrigin || API_ORIGIN, "MINTSCAN");
    this.cometOrigin = options.cometOrigin ? assertHttpsOrigin(options.cometOrigin, "COMET") : null;
    this.restOrigin = options.restOrigin ? assertHttpsOrigin(options.restOrigin, "REST") : null;
    this.startedAt = this.now();
    this.lastRequestAt = 0;
    this.requestCount = 0;
    this.retryCount = 0;
  }
  stats() { return { requestCount: this.requestCount, retryCount: this.retryCount, elapsedMs: Math.max(0, this.now() - this.startedAt), budgetPolicy: "bounded-readonly-v1" }; }
  async mintscanAccount(address, query) { return this.#request("MINTSCAN_ACCOUNT", this.apiOrigin, `/v1/babylon/accounts/${address}/transactions`, query, true); }
  async mintscanDetail(txHash, height = null) { return this.#request("MINTSCAN_DETAIL", this.apiOrigin, `/v1/babylon/txs/${normalizeHash(txHash)}`, height == null ? {} : { height: normalizeHeight(height) }, true); }
  async comet(pathname, query, requestOptions = {}) {
    if (!this.cometOrigin) throw new SafeError("PUBLIC_COMET_ORIGIN_REQUIRED");
    return this.#request("COMET", this.cometOrigin, pathname, query, false, requestOptions);
  }
  async restTransactions(query) {
    if (!this.restOrigin) throw new SafeError("PUBLIC_REST_ORIGIN_REQUIRED");
    return this.#request("REST_TX", this.restOrigin, REST_TX_PATH, query, false);
  }
  async #request(kind, origin, pathname, query, authenticated, requestOptions = {}) {
    const entries = validatePathAndQuery(kind, pathname, query);
    const target = new URL(pathname, origin);
    for (const [key, value] of entries) target.searchParams.set(key, String(value));
    for (let attempt = 0; attempt <= LIMITS.maxRetries; attempt++) {
      if (this.requestCount >= LIMITS.maxRequests) throw new SafeError("REQUEST_BUDGET_EXHAUSTED");
      if (this.now() - this.startedAt > LIMITS.maxRuntimeMs) throw new SafeError("RUNTIME_BUDGET_EXHAUSTED");
      const wait = Math.max(0, LIMITS.minRequestIntervalMs - (this.now() - this.lastRequestAt));
      if (wait) await this.sleep(wait);
      this.lastRequestAt = this.now();
      this.requestCount++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LIMITS.requestTimeoutMs);
      let response;
      try {
        response = await this.fetchImpl(target.toString(), { method: "GET", redirect: "manual", headers: authenticated ? { accept: "application/json", authorization: `Bearer ${this.#token}` } : { accept: "application/json" }, signal: controller.signal });
      } catch (_) {
        clearTimeout(timer);
        if (attempt < LIMITS.maxRetries) { this.retryCount++; await this.sleep(Math.min(LIMITS.maxBackoffMs, 250 * (2 ** attempt))); continue; }
        throw new SafeError("HTTP_TRANSPORT_FAILED", { requestClass: kind, attempts: attempt + 1 });
      }
      clearTimeout(timer);
      if (response.status >= 300 && response.status < 400) throw new SafeError("HTTP_REDIRECT_REJECTED", { requestClass: kind, status: response.status });
      const expectedBoundary = requestOptions.expectedPrunedBoundaryProof;
      const exactExpectedPruned = kind === "COMET" && pathname === "/block" && String(query && query.height) === LAST_PRE_RETENTION_HEIGHT && expectedBoundary && expectedBoundary.unavailableHeight === LAST_PRE_RETENTION_HEIGHT && expectedBoundary.unavailableProven === true && expectedBoundary.unavailableTimestamp === null && expectedBoundary.firstAvailableHeight === FIRST_RETAINED_HEIGHT;
      if (exactExpectedPruned && new Set([400, 404, 410, 500]).has(response.status)) {
        try { await response.body?.cancel(); } catch (_) {}
        throw new SafeError("EXPECTED_PRUNED_BOUNDARY", { requestClass: "BOUNDARY", status: response.status, height: LAST_PRE_RETENTION_HEIGHT });
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < LIMITS.maxRetries) {
          this.retryCount++;
          const retrySeconds = Number(response.headers && response.headers.get("retry-after"));
          const delay = Number.isFinite(retrySeconds) ? Math.min(LIMITS.maxBackoffMs, Math.max(0, retrySeconds * 1000)) : Math.min(LIMITS.maxBackoffMs, 250 * (2 ** attempt));
          try { await response.body?.cancel(); } catch (_) {}
          await this.sleep(delay);
          continue;
        }
        throw new SafeError("HTTP_RETRY_BUDGET_EXHAUSTED", { requestClass: kind, status: response.status });
      }
      if (response.status === 401 || response.status === 403) throw new SafeError("MINTSCAN_TOKEN_SCOPE_REJECTED", { requestClass: kind, status: response.status });
      if (!response.ok) throw new SafeError("HTTP_STATUS_REJECTED", { requestClass: kind, status: response.status });
      const declared = response.headers && response.headers.get("content-length");
      if (declared && /^\d+$/.test(declared) && Number(declared) > LIMITS.maxBodyBytes) { try { await response.body?.cancel(); } catch (_) {} throw new SafeError("RESPONSE_BODY_CAP_EXCEEDED", { requestClass: kind }); }
      const bytes = await readBoundedBody(response, LIMITS.maxBodyBytes);
      const text = bytes.toString("utf8");
      if (text.includes(this.#token)) throw new SafeError("TOKEN_ECHO_DETECTED");
      let body;
      try { body = JSON.parse(text); } catch (_) { throw new SafeError("RESPONSE_JSON_INVALID", { requestClass: kind, status: response.status, responseBytes: bytes.length }); }
      return { status: response.status, responseBytes: bytes.length, schemaFingerprint: schemaFingerprint(body), body };
    }
    throw new SafeError("UNREACHABLE_REQUEST_STATE");
  }
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") throw new SafeError("RESPONSE_BODY_UNAVAILABLE");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch (_) {} throw new SafeError("RESPONSE_BODY_CAP_EXCEEDED"); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function readVarint(buffer, state) {
  let value = 0n; let shift = 0n;
  while (state.offset < buffer.length) {
    const byte = buffer[state.offset++]; value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n; if (shift > 70n) throw new SafeError("PROTOBUF_VARINT_OVERFLOW");
  }
  throw new SafeError("PROTOBUF_TRUNCATED");
}
function wireFields(buffer) {
  const state = { offset: 0 }; const rows = [];
  while (state.offset < buffer.length) {
    const tag = readVarint(buffer, state); const field = Number(tag >> 3n); const wire = Number(tag & 7n);
    if (field <= 0) throw new SafeError("PROTOBUF_FIELD_INVALID");
    if (wire === 0) rows.push({ field, wire, value: readVarint(buffer, state) });
    else if (wire === 1) { if (state.offset + 8 > buffer.length) throw new SafeError("PROTOBUF_TRUNCATED"); rows.push({ field, wire, value: buffer.subarray(state.offset, state.offset + 8) }); state.offset += 8; }
    else if (wire === 2) { const length = Number(readVarint(buffer, state)); if (!Number.isSafeInteger(length) || state.offset + length > buffer.length) throw new SafeError("PROTOBUF_TRUNCATED"); rows.push({ field, wire, value: buffer.subarray(state.offset, state.offset + length) }); state.offset += length; }
    else if (wire === 5) { if (state.offset + 4 > buffer.length) throw new SafeError("PROTOBUF_TRUNCATED"); rows.push({ field, wire, value: buffer.subarray(state.offset, state.offset + 4) }); state.offset += 4; }
    else throw new SafeError("PROTOBUF_WIRE_UNSUPPORTED");
  }
  return rows;
}
function bytesFields(buffer, field) { return wireFields(buffer).filter((row) => row.field === field && row.wire === 2).map((row) => row.value); }
function textField(buffer, field) { const value = bytesFields(buffer, field)[0]; return value ? value.toString("utf8") : ""; }
function decodeAny(buffer) { return { typeUrl: textField(buffer, 1), value: bytesFields(buffer, 2)[0] || Buffer.alloc(0) }; }
function decodeRetainedTx(base64) {
  const txRaw = Buffer.from(base64, "base64");
  const body = wireFields(txRaw).find((row) => row.field === 1 && row.wire === 2)?.value;
  if (!body) throw new SafeError("TXRAW_BODY_MISSING");
  return bytesFields(body, 1).map(decodeAny).map((message, messageIndex) => {
    if (message.typeUrl !== TARGET_MSG) return { messageIndex, type: message.typeUrl, target: null };
    const signer = textField(message.value, 1);
    if (!isAddress(signer)) throw new SafeError("RETAINED_TARGET_SIGNER_INVALID");
    const stakingBytes = bytesFields(message.value, 2)[0];
    return { messageIndex, type: message.typeUrl, target: { signer, canonicalStakingTxid: stakingBytes && stakingBytes.length === 32 ? stakingBytes.toString("hex") : null } };
  });
}

function parseCometTxPage(body) {
  const result = body && body.result;
  if (!result || !Array.isArray(result.txs) || !/^\d+$/.test(String(result.total_count))) throw new SafeError("COMET_TX_SEARCH_SCHEMA_MISMATCH", { schemaFingerprint: schemaFingerprint(body) });
  return { total: Number(result.total_count), rows: result.txs };
}
function seedEvidenceFromEntries(entries, baseline, requireExact) {
  const addresses = new Set(); const pairs = new Set(); const txHashes = new Set();
  for (const entry of entries) {
    const txHash = normalizeHash(entry.txHash); txHashes.add(txHash);
    for (const message of entry.messages) if (message.target) { addresses.add(message.target.signer); pairs.add(pairKey(txHash, message.messageIndex)); }
  }
  if (!addresses.size) throw new SafeError("SEED_SOURCE_NO_DIRECT_SIGNER", { requestClass: "SEED_SOURCE" });
  if (!requireExact) return { addresses, addressHashes: [...addresses].map(addressHash).sort(), pairs, txHashes };
  const missingPairs = [...baseline.pairs].filter((key) => !pairs.has(key));
  const extraPairs = [...pairs].filter((key) => !baseline.pairs.has(key));
  if (pairs.size !== 11412 || addresses.size !== 9 || missingPairs.length || extraPairs.length || txHashes.size !== 10185) throw new SafeError("SEED_SOURCE_BASELINE_MISMATCH", { requestClass: "SEED_SOURCE", pairCount: pairs.size, signerCount: addresses.size, missingPairCount: missingPairs.length, extraPairCount: extraPairs.length });
  return { addresses, addressHashes: [...addresses].map(addressHash).sort(), pairSetSha256: hashText([...pairs].sort().join("\n")), txHashSetSha256: hashText([...txHashes].sort().join("\n")), counts: { transactions: txHashes.size, messagePairs: pairs.size, directSigners: addresses.size } };
}
async function discoverRetainedSeedsComet(client, baseline, minimal = false) {
  const rows = [];
  let total = null;
  for (let page = 1; ; page++) {
    const response = await client.comet("/tx_search", { query: `message.action='${TARGET_MSG}'`, prove: "false", page: String(page), per_page: String(minimal ? 1 : LIMITS.cometPageSize), order_by: "asc" });
    const parsed = parseCometTxPage(response.body);
    if (total == null) total = parsed.total;
    if (parsed.total !== total) throw new SafeError("COMET_TOTAL_CHANGED");
    rows.push(...parsed.rows);
    if (minimal && rows.length) break;
    if (rows.length >= total) break;
    if (page > Math.ceil(total / (minimal ? 1 : LIMITS.cometPageSize)) + 1) throw new SafeError("COMET_PAGINATION_EXHAUSTION_FAILED");
  }
  if (!minimal && (rows.length !== total || total !== baseline.counts.transactions)) throw new SafeError("COMET_RETAINED_TRANSACTION_COUNT_MISMATCH", { observed: rows.length, expected: baseline.counts.transactions });
  return seedEvidenceFromEntries(rows.map((row) => ({ txHash: row.hash, messages: decodeRetainedTx(row.tx) })), baseline, !minimal);
}
function parseRestTxPage(body) {
  if (!body || !Array.isArray(body.txs) || !Array.isArray(body.tx_responses) || body.txs.length !== body.tx_responses.length) throw new SafeError("REST_TX_SCHEMA_MISMATCH", { schemaFingerprint: schemaFingerprint(body) });
  const totalRaw = deepFind(body, [["pagination", "total"]]);
  if (!/^\d+$/.test(String(totalRaw))) throw new SafeError("REST_TX_PAGINATION_SCHEMA_MISMATCH", { schemaFingerprint: schemaFingerprint(body) });
  const entries = body.txs.map((tx, index) => {
    const response = body.tx_responses[index];
    const messages = deepFind(tx, [["body", "messages"]]);
    if (!Array.isArray(messages)) throw new SafeError("REST_TX_MESSAGE_SCHEMA_MISMATCH");
    const normalized = messages.map((message, messageIndex) => {
      const type = safeType(messageType(message), "REST_TX_MESSAGE_TYPE_UNSAFE");
      if (type !== TARGET_MSG) return { messageIndex, type, target: null };
      const value = messageValue(message); const signer = extractAddress(value, ["signer", "sender", "signerAddress", "signer_address"]);
      if (!signer) throw new SafeError("REST_TX_TARGET_SIGNER_MISSING");
      return { messageIndex, type, target: { signer, canonicalStakingTxid: normalizeCanonicalTxid(value) } };
    });
    return { txHash: deepFind(response, [["txhash"], ["txHash"], ["hash"]]), messages: normalized };
  });
  return { total: Number(totalRaw), entries };
}
async function discoverRetainedSeedsRest(client, baseline, minimal = false) {
  const entries = []; let total = null; let offset = 0;
  for (;;) {
    const response = await client.restTransactions({ events: `message.action='${TARGET_MSG}'`, "pagination.limit": String(minimal ? 1 : LIMITS.cometPageSize), "pagination.offset": String(offset), order_by: "ORDER_BY_ASC" });
    const page = parseRestTxPage(response.body);
    if (total == null) total = page.total;
    if (page.total !== total) throw new SafeError("REST_TX_TOTAL_CHANGED");
    entries.push(...page.entries);
    if (minimal && entries.length) break;
    if (entries.length >= total) break;
    if (!page.entries.length) throw new SafeError("REST_TX_PAGINATION_STALLED");
    offset += page.entries.length;
  }
  if (!minimal && (entries.length !== total || total !== baseline.counts.transactions)) throw new SafeError("REST_RETAINED_TRANSACTION_COUNT_MISMATCH", { observed: entries.length, expected: baseline.counts.transactions });
  return seedEvidenceFromEntries(entries, baseline, !minimal);
}
function phaseError(category, code, error) {
  const source = error instanceof SafeError ? error.diagnostic : {};
  return new SafeError(code, { category, causeCode: error instanceof SafeError ? error.code : "UNEXPECTED_FAILURE", requestClass: source.requestClass, status: source.status, schemaFingerprint: source.schemaFingerprint, observed: source.observed, expected: source.expected });
}
async function discoverOneRetainedSigner(client, baseline) {
  if (client.cometOrigin) {
    try { const evidence = await discoverRetainedSeedsComet(client, baseline, true); return { source: "COMET", address: [...evidence.addresses][0] }; }
    catch (error) { if (!client.restOrigin) throw phaseError("SEED_SOURCE", "SEED_SOURCE_COMET_UNAVAILABLE", error); }
  }
  if (client.restOrigin) {
    try { const evidence = await discoverRetainedSeedsRest(client, baseline, true); return { source: "REST", address: [...evidence.addresses][0] }; }
    catch (error) { throw phaseError("SEED_SOURCE", "SEED_SOURCE_REST_UNAVAILABLE", error); }
  }
  throw new SafeError("SEED_SOURCE_ORIGIN_REQUIRED", { category: "SEED_SOURCE", requestClass: "SEED_SOURCE" });
}
async function discoverRetainedSeeds(client, baseline, preferredSource) {
  const attempts = preferredSource === "REST" ? ["REST", "COMET"] : ["COMET", "REST"];
  let lastError = null;
  for (const source of attempts) {
    if (source === "COMET" && !client.cometOrigin) continue;
    if (source === "REST" && !client.restOrigin) continue;
    try {
      const evidence = source === "COMET" ? await discoverRetainedSeedsComet(client, baseline, false) : await discoverRetainedSeedsRest(client, baseline, false);
      return { ...evidence, source };
    } catch (error) { lastError = error; }
  }
  throw phaseError("SEED_SOURCE", "SEED_SOURCE_EXHAUSTED", lastError || new SafeError("SEED_SOURCE_ORIGIN_REQUIRED"));
}

function unwrapDetail(body) {
  const candidates = [body && body.data, body && body.transaction, body && body.tx, body];
  for (const candidate of candidates) if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const hash = deepFind(candidate, [["txHash"], ["tx_hash"], ["hash"], ["transactionHash"]]);
    const messages = deepFind(candidate, [["messages"], ["body", "messages"], ["tx", "body", "messages"], ["transaction", "body", "messages"]]);
    if (hash && Array.isArray(messages)) return { root: candidate, hash, messages };
  }
  throw new SafeError("MINTSCAN_DETAIL_SCHEMA_MISMATCH", { schemaFingerprint: schemaFingerprint(body) });
}
function messageType(message) { return String(message && (message["@type"] || message.typeUrl || message.type_url || message.type || message.messageType) || ""); }
function messageValue(message) { return message && (message.value || message.msg || message.data || message); }
function extractAddress(value, names) {
  for (const name of names) if (value && isAddress(value[name])) return value[name];
  return null;
}
function normalizeCanonicalTxid(value) {
  for (const key of ["stakingTxHash", "staking_tx_hash", "stakingTxid", "staking_txid", "btcStakingTxHash"]) {
    const candidate = value && value[key];
    if (candidate == null) continue;
    const text = String(candidate).replace(/^0x/i, "").toLowerCase();
    if (/^[0-9a-f]{64}$/.test(text)) return text;
  }
  return null;
}
function normalizeQuorumEvents(root) {
  const events = deepFind(root, [["events"], ["txResponse", "events"], ["tx_response", "events"], ["logs"]]);
  if (!Array.isArray(events)) return { count: 0, rows: [], sourceAvailable: false };
  const rows = [];
  const visit = (event) => {
    const rawType = String(event && (event.type || event.eventType || event["@type"]) || "");
    if (!rawType || !/quorum|covenant/i.test(rawType)) return;
    let type;
    try { type = safeType(rawType, "UNSAFE_EVENT_TYPE"); } catch (_) { return; }
    const stateCandidate = String(event.state || event.status || "").toUpperCase();
    rows.push({ type, state: /^(ACTIVE|VERIFIED|PENDING|EXPIRED|UNBONDED)$/.test(stateCandidate) ? stateCandidate : null, canonicalStakingTxid: normalizeCanonicalTxid(event) });
  };
  for (const event of events) {
    if (Array.isArray(event && event.events)) for (const nested of event.events) visit(nested); else visit(event);
  }
  return { count: rows.length, rows, sourceAvailable: true };
}
function normalizeOuterSigners(root) {
  const signers = deepFind(root, [["signers"], ["authInfo", "signers"], ["auth_info", "signers"], ["authInfo", "signerInfos"], ["auth_info", "signer_infos"]]);
  if (!Array.isArray(signers)) return [];
  const rows = [];
  for (const item of signers) {
    if (typeof item === "string") { if (isAddress(item)) rows.push(addressHash(item)); continue; }
    if (!item || typeof item !== "object") continue;
    const address = extractAddress(item, ["address", "signer", "signerAddress", "signer_address"]);
    if (address) { rows.push(addressHash(address)); continue; }
  }
  return [...new Set(rows.sort())];
}
function normalizeFee(root) {
  const fee = deepFind(root, [["fee"], ["authInfo", "fee"], ["auth_info", "fee"]]);
  if (!fee || typeof fee !== "object") return { explicitPayerHash: null, explicitGranterHash: null, implicitFeePayerCaveat: true };
  const payer = extractAddress(fee, ["payer", "feePayer", "fee_payer"]);
  const granter = extractAddress(fee, ["granter", "feeGranter", "fee_granter"]);
  return { explicitPayerHash: payer ? addressHash(payer) : null, explicitGranterHash: granter ? addressHash(granter) : null, implicitFeePayerCaveat: !payer };
}
function assertExactKeys(object, allowed, code) {
  if (!object || typeof object !== "object" || Array.isArray(object)) throw new SafeError(code);
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new SafeError(code, { field: key });
}
function assertNormalizedRecord(record) {
  assertExactKeys(record, ["txHash", "height", "time", "success", "code", "messages", "directTargetCount", "msgExecCount", "nestedTargetCount", "outerSignerHashes", "fee", "quorumEvents"], "NORMALIZED_RECORD_FIELD_REJECTED");
  if (!/^[0-9a-f]{64}$/.test(record.txHash) || !/^\d+$/.test(record.height) || (record.time != null && !/^\d{4}-\d{2}-\d{2}T/.test(record.time))) throw new SafeError("NORMALIZED_RECORD_VALUE_REJECTED");
  if (record.success != null && typeof record.success !== "boolean") throw new SafeError("NORMALIZED_RECORD_VALUE_REJECTED");
  if (record.code != null && !/^-?\d+$/.test(record.code)) throw new SafeError("NORMALIZED_RECORD_VALUE_REJECTED");
  if (![record.directTargetCount, record.msgExecCount, record.nestedTargetCount].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new SafeError("NORMALIZED_RECORD_VALUE_REJECTED");
  for (const hash of record.outerSignerHashes) if (!/^[0-9a-f]{64}$/.test(hash)) throw new SafeError("NORMALIZED_IDENTITY_HASH_REJECTED");
  assertExactKeys(record.fee, ["explicitPayerHash", "explicitGranterHash", "implicitFeePayerCaveat"], "NORMALIZED_FEE_FIELD_REJECTED");
  for (const value of [record.fee.explicitPayerHash, record.fee.explicitGranterHash]) if (value != null && !/^[0-9a-f]{64}$/.test(value)) throw new SafeError("NORMALIZED_FEE_HASH_REJECTED");
  if (typeof record.fee.implicitFeePayerCaveat !== "boolean") throw new SafeError("NORMALIZED_FEE_VALUE_REJECTED");
  for (const message of record.messages) {
    if (message.directTarget) {
      assertExactKeys(message, ["messageIndex", "type", "directTarget"], "NORMALIZED_MESSAGE_FIELD_REJECTED");
      assertExactKeys(message.directTarget, ["signerAddressHash", "canonicalStakingTxid"], "NORMALIZED_TARGET_FIELD_REJECTED");
    } else if (message.msgExec) {
      assertExactKeys(message, ["messageIndex", "type", "msgExec"], "NORMALIZED_MESSAGE_FIELD_REJECTED");
      assertExactKeys(message.msgExec, ["granteeAddressHash", "nested"], "NORMALIZED_MSGEXEC_FIELD_REJECTED");
      for (const nested of message.msgExec.nested) {
        assertExactKeys(nested, ["nestedMessageIndex", "type", "target"], "NORMALIZED_NESTED_FIELD_REJECTED");
        if (nested.target) assertExactKeys(nested.target, ["granterAddressHash", "canonicalStakingTxid"], "NORMALIZED_NESTED_TARGET_FIELD_REJECTED");
      }
    } else assertExactKeys(message, ["messageIndex", "type"], "NORMALIZED_MESSAGE_FIELD_REJECTED");
  }
  assertExactKeys(record.quorumEvents, ["count", "rows", "sourceAvailable"], "NORMALIZED_EVENT_CONTAINER_REJECTED");
  for (const event of record.quorumEvents.rows) assertExactKeys(event, ["type", "state", "canonicalStakingTxid"], "NORMALIZED_EVENT_FIELD_REJECTED");
  return true;
}
function normalizeDetail(body, expectedHash = null) {
  const { root, hash, messages } = unwrapDetail(body);
  const txHash = normalizeHash(hash);
  if (expectedHash && txHash !== normalizeHash(expectedHash)) throw new SafeError("MINTSCAN_DETAIL_HASH_MISMATCH");
  const height = normalizeHeight(deepFind(root, [["height"], ["blockHeight"], ["block_height"], ["txResponse", "height"], ["tx_response", "height"]]));
  const rawTime = deepFind(root, [["timestamp"], ["time"], ["blockTime"], ["block_time"]]);
  const codeValue = deepFind(root, [["code"], ["txResponse", "code"], ["tx_response", "code"]]);
  const successValue = deepFind(root, [["success"], ["isSuccess"], ["is_success"]]);
  const code = codeValue == null ? null : String(codeValue);
  if (code != null && !/^-?\d+$/.test(code)) throw new SafeError("MINTSCAN_CODE_SCHEMA_MISMATCH");
  const success = typeof successValue === "boolean" ? successValue : code == null ? null : code === "0";
  const normalizedMessages = [];
  const discoveredDirectAddresses = new Set();
  let directTargetCount = 0; let msgExecCount = 0; let nestedTargetCount = 0;
  messages.forEach((message, index) => {
    const type = safeType(messageType(message), "UNSAFE_MESSAGE_TYPE"); const value = messageValue(message);
    if (type === TARGET_MSG) {
      const signer = extractAddress(value, ["signer", "sender", "signerAddress", "signer_address"]);
      if (!signer) throw new SafeError("MINTSCAN_TARGET_SIGNER_MISSING");
      discoveredDirectAddresses.add(signer); directTargetCount++;
      normalizedMessages.push({ messageIndex: index, type, directTarget: { signerAddressHash: addressHash(signer), canonicalStakingTxid: normalizeCanonicalTxid(value) } });
      return;
    }
    if (type === MSG_EXEC) {
      msgExecCount++;
      const grantee = extractAddress(value, ["grantee"]);
      const nested = value && (value.msgs || value.messages);
      if (!Array.isArray(nested)) throw new SafeError("MINTSCAN_MSGEXEC_NESTED_SCHEMA_MISMATCH");
      const nestedRows = [];
      nested.forEach((nestedMessage, nestedIndex) => {
        const nestedType = safeType(messageType(nestedMessage), "UNSAFE_NESTED_MESSAGE_TYPE"); const nestedValue = messageValue(nestedMessage);
        if (nestedType !== TARGET_MSG) { nestedRows.push({ nestedMessageIndex: nestedIndex, type: nestedType, target: null }); return; }
        const granter = extractAddress(nestedValue, ["signer", "sender", "granter", "signerAddress", "signer_address"]);
        if (!granter) throw new SafeError("MINTSCAN_MSGEXEC_TARGET_GRANTER_MISSING");
        nestedTargetCount++;
        nestedRows.push({ nestedMessageIndex: nestedIndex, type: nestedType, target: { granterAddressHash: addressHash(granter), canonicalStakingTxid: normalizeCanonicalTxid(nestedValue) } });
      });
      normalizedMessages.push({ messageIndex: index, type, msgExec: { granteeAddressHash: grantee ? addressHash(grantee) : null, nested: nestedRows } });
      return;
    }
    normalizedMessages.push({ messageIndex: index, type });
  });
  const record = { txHash, height, time: rawTime == null ? null : normalizeTime(rawTime), success, code, messages: normalizedMessages, directTargetCount, msgExecCount, nestedTargetCount, outerSignerHashes: normalizeOuterSigners(root), fee: normalizeFee(root), quorumEvents: normalizeQuorumEvents(root) };
  assertNormalizedRecord(record);
  return {
    record,
    discoveredDirectAddresses,
  };
}

function unwrapAccountPage(body) {
  const arrayCandidates = [body && body.data && body.data.transactions, body && body.data && body.data.items, body && body.transactions, body && body.items, Array.isArray(body && body.data) ? body.data : null];
  const rows = arrayCandidates.find(Array.isArray);
  const pagination = deepFind(body, [["pagination"], ["data", "pagination"], ["meta", "pagination"]]);
  if (!rows || (pagination != null && typeof pagination !== "object")) throw new SafeError("MINTSCAN_ACCOUNT_SCHEMA_MISMATCH", { schemaFingerprint: schemaFingerprint(body) });
  const searchAfter = pagination && (pagination.searchAfter ?? pagination.search_after ?? null);
  if (searchAfter != null && typeof searchAfter !== "string") throw new SafeError("MINTSCAN_CURSOR_SCHEMA_MISMATCH");
  const normalizedRows = rows.map((row) => {
    const hash = deepFind(row, [["txHash"], ["tx_hash"], ["hash"], ["transactionHash"]]);
    const height = deepFind(row, [["height"], ["blockHeight"], ["block_height"]]);
    return { txHash: normalizeHash(hash), height: height == null ? null : normalizeHeight(height) };
  });
  return { rows: normalizedRows, searchAfter, schemaFingerprint: schemaFingerprint(body) };
}
async function enumerateAccountWindow(client, address, window) {
  const seenCursors = new Set(); const txRefs = new Map();
  let cursor = null; let pages = 0; let duplicateRows = 0; const schemaFingerprints = new Set();
  for (;;) {
    pages++;
    if (pages > LIMITS.maxPagesPerAccountWindow) throw new SafeError("ACCOUNT_PAGE_CAP_EXCEEDED", { window: window.label });
    const query = { take: String(LIMITS.accountPageTake), "messageTypes[0]": TARGET_MSG, fromDateTime: window.fromDateTime, toDateTime: window.toDateTime, searchAfter: cursor };
    const response = await client.mintscanAccount(address, query);
    const page = unwrapAccountPage(response.body); schemaFingerprints.add(page.schemaFingerprint);
    for (const row of page.rows) {
      const existing = txRefs.get(row.txHash);
      if (existing) { duplicateRows++; if (existing.height && row.height && existing.height !== row.height) throw new SafeError("ACCOUNT_DUPLICATE_HEIGHT_MISMATCH"); }
      else txRefs.set(row.txHash, row);
    }
    if (txRefs.size > LIMITS.maxRecordsPerAccountWindow) throw new SafeError("ACCOUNT_RECORD_CAP_EXCEEDED", { window: window.label });
    if (!page.searchAfter) break;
    const cursorDigest = hashText(`cursor\0${page.searchAfter}`);
    if (seenCursors.has(cursorDigest)) throw new SafeError("ACCOUNT_CURSOR_LOOP_DETECTED", { window: window.label, pages });
    seenCursors.add(cursorDigest); cursor = page.searchAfter;
  }
  return { txRefs, stats: { pages, uniqueTransactions: txRefs.size, duplicateRows, cursorCount: seenCursors.size, cursorSetSha256: seenCursors.size ? hashText([...seenCursors].sort().join("\n")) : null, schemaFingerprints: [...schemaFingerprints].sort() } };
}

function compareRetainedOverlap(records, baseline, firstRetainedTime, pinTime) {
  const pairs = new Set(); const txHashes = new Set();
  const start = new Date(firstRetainedTime).getTime(); const end = new Date(pinTime).getTime();
  for (const record of records) {
    const time = record.time == null ? null : new Date(record.time).getTime();
    const height = BigInt(record.height);
    const inOverlap = height >= BigInt(FIRST_RETAINED_HEIGHT) && (time == null || (time >= start && time <= end));
    if (!inOverlap) continue;
    for (const message of record.messages) if (message.type === TARGET_MSG && message.directTarget) { pairs.add(pairKey(record.txHash, message.messageIndex)); txHashes.add(record.txHash); }
  }
  const missing = [...baseline.pairs].filter((key) => !pairs.has(key));
  const extra = [...pairs].filter((key) => !baseline.pairs.has(key));
  return {
    exact: pairs.size === baseline.pairs.size && txHashes.size === baseline.txHashes.size && missing.length === 0 && extra.length === 0,
    observedTransactions: txHashes.size,
    observedMessagePairs: pairs.size,
    missingPairCount: missing.length,
    extraPairCount: extra.length,
    pairSetSha256: pairs.size ? hashText([...pairs].sort().join("\n")) : null,
    expectedTransactions: baseline.txHashes.size,
    expectedMessagePairs: baseline.pairs.size,
  };
}

function scanForbiddenOutputKeys(value, pathParts = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => scanForbiddenOutputKeys(item, [...pathParts, String(index)])); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    const allowedCredentialSummary = key === "tokenValidation";
    if (!allowedCredentialSummary && /token|bearer|authorization|cookie|endpoint|url|origin|header|secret/.test(normalized)) throw new SafeError("OUTPUT_CREDENTIAL_OR_ENDPOINT_FIELD_REJECTED", { field: key });
    if (/signature|publickey|pubkey|txraw|authinfo|rawmessage|rawaddress|rawbody|rawheader|txbytes|bodybytes|covenantsig|adaptorsig|unbondingsig|slashingsig/.test(normalized)) throw new SafeError("OUTPUT_SIGNATURE_LEAK", { field: key });
    scanForbiddenOutputKeys(item, [...pathParts, key]);
  }
}
function assertOutputSafe(value, token = null) {
  const text = typeof value === "string" ? value : json(value);
  if (value && typeof value === "object") scanForbiddenOutputKeys(value);
  if (token && text.includes(token)) throw new SafeError("OUTPUT_TOKEN_LEAK");
  if (/bbn1[02-9ac-hj-np-z]{20,80}/.test(text)) throw new SafeError("OUTPUT_RAW_ADDRESS_LEAK");
  if (/h.?ttps?:\/\/|wss?:\/\/|\b[a-z0-9-]+\.(?:com|io|org|net|xyz|dev|app|cloud|finance|zone)\b/i.test(text)) throw new SafeError("OUTPUT_ENDPOINT_MATERIAL_LEAK");
  if (/(?:authorization|bearer|access[_-]?token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_.~+\/-]{8,}/i.test(text) || /set-cookie\s*:|cookie\s*[:=]/i.test(text)) throw new SafeError("OUTPUT_CREDENTIAL_LEAK");
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)) throw new SafeError("OUTPUT_JWT_LEAK");
  if (/-----BEGIN [A-Z ]+-----/.test(text)) throw new SafeError("OUTPUT_KEY_MATERIAL_LEAK");
  if (/[A-Za-z0-9+/]{80,}={0,2}/.test(text) || /\b(?:0x)?[0-9a-fA-F]{128,}\b/.test(text)) throw new SafeError("OUTPUT_SIGNATURE_LIKE_BLOB_LEAK");
  if (/(?:covenant|adaptor|unbonding|slashing)?[_-]?signatures?\s*[:=]/i.test(text)) throw new SafeError("OUTPUT_SIGNATURE_LEAK");
  if (/"[^"]*(?:signature|public[_-]?key|pubkey|txraw|authinfo|txbytes|raw[_-]?message)[^"]*"\s*:/i.test(text)) throw new SafeError("OUTPUT_SIGNATURE_LEAK");
  return true;
}

async function runLive(options = {}) {
  const token = options.token;
  if (typeof token !== "string" || token.length < 1) throw new SafeError("MINTSCAN_API_TOKEN_REQUIRED");
  const context = bindContext(); const baseline = loadStep9Baseline();
  const cometOrigin = options.cometOrigin || process.env.BABYLON_PUBLIC_COMET_ORIGIN;
  const restOrigin = options.restOrigin || process.env.BABYLON_PUBLIC_REST_ORIGIN;
  const client = new BudgetedHttpClient({ token, cometOrigin, restOrigin, fetchImpl: options.fetchImpl, sleep: options.sleep, now: options.now });
  const boundaryProof = context.step9.archiveBoundary;
  const firstRetainedTimeExact = boundaryProof.firstAvailableTimestamp;
  const firstRetainedTime = normalizeTime(firstRetainedTimeExact);
  const pinTime = normalizeTime(readJson(STEP9_BOUNDARY).fixedPin.time);
  const boundarySemantics = {
    unavailableHeight: LAST_PRE_RETENTION_HEIGHT,
    unavailableTimestamp: null,
    unavailableProvenByStep9: true,
    firstAvailableHeight: FIRST_RETAINED_HEIGHT,
    firstAvailableTimestamp: firstRetainedTimeExact,
    logicalPreRetentionComparator: "timestamp < firstAvailableTimestamp",
    accountApiUpperBoundInclusivity: null,
    exactClassificationPostFilter: "height <= 2556425",
    timestampPrecision: "STEP9_SOURCE_PRECISION_RETAINED; ACCOUNT_API_FILTER_PRECISION_UNKNOWN",
    knownUnavailableBlockQueried: false,
  };
  const windows = [
    { label: "pre-retention", fromDateTime: "1970-01-01T00:00:00.000Z", toDateTime: firstRetainedTimeExact, logicalUpperBoundExclusive: true, apiUpperBoundInclusivity: null, detailHeightPostFilter: true },
    { label: "retained-overlap", fromDateTime: firstRetainedTimeExact, toDateTime: pinTime, logicalLowerBoundInclusive: true },
  ];

  let knownDetailValidationResponse; let knownDetailValidation;
  try {
    knownDetailValidationResponse = await client.mintscanDetail(baseline.firstKnownTxHash);
    knownDetailValidation = normalizeDetail(knownDetailValidationResponse.body, baseline.firstKnownTxHash);
  } catch (error) {
    const category = error instanceof SafeError && /SCHEMA|HASH|SIGNER|MESSAGE|TIMESTAMP|HEIGHT|CODE/.test(error.code) ? "TOKEN_SCHEMA" : "TOKEN_AUTH";
    throw phaseError(category, "TOKEN_DETAIL_VALIDATION_FAILED", error);
  }
  const minimalSeed = await discoverOneRetainedSigner(client, baseline);
  let accountValidationResponse; let accountValidationPage;
  try {
    accountValidationResponse = await client.mintscanAccount(minimalSeed.address, { take: "1", "messageTypes[0]": TARGET_MSG, fromDateTime: firstRetainedTimeExact, toDateTime: pinTime });
    accountValidationPage = unwrapAccountPage(accountValidationResponse.body);
  } catch (error) {
    const category = error instanceof SafeError && /SCHEMA|CURSOR|HASH|HEIGHT/.test(error.code) ? "TOKEN_SCHEMA" : "TOKEN_AUTH";
    throw phaseError(category, "TOKEN_ACCOUNT_VALIDATION_FAILED", error);
  }
  const tokenValidation = {
    authenticated: true,
    detail: { status: knownDetailValidationResponse.status, schemaFingerprint: knownDetailValidationResponse.schemaFingerprint, normalizedMessageCount: knownDetailValidation.record.messages.length },
    account: { status: accountValidationResponse.status, schemaFingerprint: accountValidationResponse.schemaFingerprint, normalizedRowCount: accountValidationPage.rows.length },
  };
  const seeds = await discoverRetainedSeeds(client, baseline, minimalSeed.source);

  const pending = [...seeds.addresses]; const queried = new Set(); const allRefs = new Map(); const detailsByHash = new Map(); const accountStats = [];
  let fixedPointRounds = 0; let duplicateJoins = 0;
  while (pending.length) {
    fixedPointRounds++;
    if (fixedPointRounds > LIMITS.maxSignerFixedPointRounds) throw new SafeError("SIGNER_FIXED_POINT_ROUND_CAP_EXCEEDED");
    const round = pending.splice(0);
    for (const address of round) {
      if (queried.has(address)) continue;
      queried.add(address);
      for (const window of windows) {
        let result;
        try { result = await enumerateAccountWindow(client, address, window); }
        catch (error) {
          const category = error instanceof SafeError && /CURSOR|PAGE|RECORD|PAGINATION|DUPLICATE/.test(error.code) ? "CURSOR" : "SCHEMA";
          throw phaseError(category, category === "CURSOR" ? "ACCOUNT_CURSOR_ENUMERATION_FAILED" : "ACCOUNT_SCHEMA_ENUMERATION_FAILED", error);
        }
        accountStats.push({ signerAddressHash: addressHash(address), window: window.label, ...result.stats });
        for (const [txHash, ref] of result.txRefs) {
          const existing = allRefs.get(txHash);
          if (existing) { duplicateJoins++; if (existing.height && ref.height && existing.height !== ref.height) throw new SafeError("ACCOUNT_JOIN_HEIGHT_MISMATCH"); }
          else allRefs.set(txHash, ref);
        }
      }
    }
    for (const ref of allRefs.values()) {
      if (detailsByHash.has(ref.txHash)) continue;
      let response; let normalized;
      try { response = await client.mintscanDetail(ref.txHash, ref.height); normalized = normalizeDetail(response.body, ref.txHash); }
      catch (error) { throw phaseError("DETAIL", "TRANSACTION_DETAIL_ENUMERATION_FAILED", error); }
      detailsByHash.set(ref.txHash, normalized.record);
      for (const address of normalized.discoveredDirectAddresses) if (!queried.has(address) && !pending.includes(address)) pending.push(address);
    }
    if (queried.size + pending.length > LIMITS.maxDiscoveredSigners) throw new SafeError("DISCOVERED_SIGNER_CAP_EXCEEDED");
  }
  const details = [...detailsByHash.values()];
  details.sort((a, b) => BigInt(a.height) < BigInt(b.height) ? -1 : BigInt(a.height) > BigInt(b.height) ? 1 : a.txHash.localeCompare(b.txHash));
  const overlap = compareRetainedOverlap(details, baseline, firstRetainedTime, pinTime);
  const preRetentionRows = details.filter((row) => BigInt(row.height) <= BigInt(LAST_PRE_RETENTION_HEIGHT));
  const directMessages = details.reduce((sum, row) => sum + row.directTargetCount, 0);
  const msgExecCount = details.reduce((sum, row) => sum + row.msgExecCount, 0);
  const nestedTargetCount = details.reduce((sum, row) => sum + row.nestedTargetCount, 0);
  const quorumEventCount = preRetentionRows.reduce((sum, row) => sum + row.quorumEvents.count, 0);
  const allSignerHashes = [...new Set([...seeds.addressHashes, ...accountStats.map((row) => row.signerAddressHash)])].sort();
  const initialSignerHashSet = new Set(seeds.addressHashes);
  const newSignerHashes = allSignerHashes.filter((value) => !initialSignerHashSet.has(value));
  const runSeed = hashText(json({ step9: context.step9.aggregateSha256, step10: context.step10.aggregateSha256, overlap: overlap.pairSetSha256, signers: allSignerHashes })).slice(0, 12);
  const generatedAt = new Date().toISOString();
  const raw = {
    schemaVersion: 1,
    stage: "Babylon Step 11 token-safe Mintscan pre-retention enumeration",
    evidenceRevision: "implementation-live-r1",
    runId: `babylon-step11-mintscan-${generatedAt.replace(/[-:TZ.]/g, "").slice(0, 14)}-${runSeed}`,
    generatedAt,
    context,
    safety: { policy: "strict-output-allowlist-v2", retainedFieldClasses: ["transaction-metadata", "message-type-and-index", "canonical-staking-txid", "salted-role-hashes", "event-type-state-counts"], forbiddenMaterialRetained: false, childProcessCount: 0, requestMethod: "GET", redirectLimit: 0 },
    tokenValidation,
    boundarySemantics,
    retainedSeedDiscovery: { source: seeds.source, addressHashes: seeds.addressHashes, addressHashSaltId: ADDRESS_HASH_SALT, counts: seeds.counts, pairSetSha256: seeds.pairSetSha256, txHashSetSha256: seeds.txHashSetSha256, exactStep9Baseline: true },
    windows,
    enumeration: { fixedPointRounds, queriedSignerHashCount: queried.size, initialSignerHashes: seeds.addressHashes, newSignerHashes, signerHashes: allSignerHashes, accountStats, uniqueTransactionDetails: details.length, duplicateJoins, directTargetMessages: directMessages, msgExecCount, nestedTargetCount, msgExecGlobalEnumerationGap: true, signerFixedPointSufficientForGlobalCompletion: false },
    retainedOverlap: overlap,
    preRetention: { transactionCount: preRetentionRows.length, directTargetMessages: preRetentionRows.reduce((sum, row) => sum + row.directTargetCount, 0), minimumHeight: preRetentionRows.length ? preRetentionRows[0].height : null, maximumHeight: preRetentionRows.length ? preRetentionRows[preRetentionRows.length - 1].height : null, quorumEventCount, quorumEventSourceAvailableForAllRows: preRetentionRows.every((row) => row.quorumEvents.sourceAvailable), details: preRetentionRows },
    completeness: { knownSeedApiSemantics: overlap.exact ? "EXACT_RETAINED_OVERLAP_FOR_DISCOVERED_SEEDS" : "KNOWN_SEED_OVERLAP_MISMATCH", globalCompleteness: false, completeHistoricalSignerRosterKnown: false, globalCollectionDocumented: false, fixedPointIsDiscoveryOnly: true, productionExposure: "UNKNOWN/COVERAGE_OPEN" },
    classification: overlap.exact ? "KNOWN_SEED_ENUMERATION_ONLY/GLOBAL_COVERAGE_OPEN" : "API_SEMANTICS_MISMATCH/FAIL_CLOSED",
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, evidenceComplete: false, closureEligible: false, productionWideClosure: false },
    httpBudget: client.stats(),
  };
  assertOutputSafe(raw, token);
  return raw;
}

function buildBlockedRaw(error) {
  const context = bindContext(); const baseline = loadStep9Baseline(); const generatedAt = new Date().toISOString();
  const diagnostic = error instanceof SafeError ? error.diagnostic : {};
  const code = error instanceof SafeError ? error.code : "UNEXPECTED_FAILURE";
  const category = diagnostic.category || (code.startsWith("SEED_SOURCE") ? "SEED_SOURCE" : code.startsWith("TOKEN_") || code === "MINTSCAN_TOKEN_SCOPE_REJECTED" ? "TOKEN_AUTH" : /CURSOR|PAGINATION/.test(code) ? "CURSOR" : /DETAIL/.test(code) ? "DETAIL" : /SCHEMA/.test(code) ? "SCHEMA" : "LOCAL_SETUP");
  const classifications = { SEED_SOURCE: "SEED_SOURCE_BLOCKED/KNOWN_SEED_ENUMERATION_NOT_ESTABLISHED", TOKEN_AUTH: "TOKEN_AUTH_BLOCKED/KNOWN_SEED_ENUMERATION_NOT_ESTABLISHED", TOKEN_SCHEMA: "TOKEN_SCHEMA_BLOCKED/KNOWN_SEED_ENUMERATION_NOT_ESTABLISHED", CURSOR: "CURSOR_SEMANTICS_BLOCKED/KNOWN_SEED_ENUMERATION_INCOMPLETE", DETAIL: "DETAIL_SCHEMA_BLOCKED/KNOWN_SEED_ENUMERATION_INCOMPLETE", SCHEMA: "API_SCHEMA_BLOCKED/KNOWN_SEED_ENUMERATION_NOT_ESTABLISHED", LOCAL_SETUP: "LOCAL_SETUP_BLOCKED/KNOWN_SEED_ENUMERATION_NOT_ESTABLISHED" };
  const cause = diagnostic.causeCode || (code === "MINTSCAN_TOKEN_SCOPE_REJECTED" ? code : null);
  const blockedDiagnostic = { category, code, ...diagnostic };
  if (cause) blockedDiagnostic.cause = cause;
  if (category === "TOKEN_AUTH" && code !== "MINTSCAN_TOKEN_SCOPE_REJECTED" && diagnostic.causeCode === "MINTSCAN_TOKEN_SCOPE_REJECTED") blockedDiagnostic.cause = "MINTSCAN_TOKEN_SCOPE_REJECTED";
  const boundaryProof = context.step9.archiveBoundary;
  return {
    schemaVersion: 1,
    stage: "Babylon Step 11 token-safe Mintscan pre-retention enumeration",
    evidenceRevision: "implementation-live-blocked-r1",
    runId: `babylon-step11-mintscan-blocked-${generatedAt.replace(/[-:TZ.]/g, "").slice(0, 14)}-${hashText(`${context.step10.aggregateSha256}\0${code}`).slice(0, 12)}`,
    generatedAt,
    status: "BLOCKED_FAIL_CLOSED",
    context,
    safety: { policy: "strict-output-allowlist-v2", retainedFieldClasses: ["sanitized-blocker-code", "bound-baseline-counts"], forbiddenMaterialRetained: false, childProcessCount: 0, requestMethod: "GET", redirectLimit: 0 },
    blockedDiagnostic,
    tokenValidation: { authenticated: false, detail: { status: null, schemaFingerprint: null, normalizedMessageCount: null }, account: { status: null, schemaFingerprint: null, normalizedRowCount: null } },
    boundarySemantics: { unavailableHeight: boundaryProof.unavailableHeight, unavailableTimestamp: null, unavailableProvenByStep9: true, firstAvailableHeight: boundaryProof.firstAvailableHeight, firstAvailableTimestamp: boundaryProof.firstAvailableTimestamp, logicalPreRetentionComparator: "timestamp < firstAvailableTimestamp", accountApiUpperBoundInclusivity: null, exactClassificationPostFilter: "height <= 2556425", timestampPrecision: "STEP9_SOURCE_PRECISION_RETAINED; ACCOUNT_API_FILTER_PRECISION_UNKNOWN", knownUnavailableBlockQueried: false },
    retainedSeedDiscovery: { source: null, addressHashes: [], addressHashSaltId: ADDRESS_HASH_SALT, counts: { transactions: baseline.counts.transactions, messagePairs: baseline.counts.messagePairs, directSigners: null }, pairSetSha256: baseline.pairSetSha256, txHashSetSha256: baseline.txHashSetSha256, exactStep9Baseline: null },
    windows: null,
    enumeration: { fixedPointRounds: 0, queriedSignerHashCount: 0, initialSignerHashes: [], newSignerHashes: [], signerHashes: [], accountStats: [], uniqueTransactionDetails: 0, duplicateJoins: 0, directTargetMessages: 0, msgExecCount: 0, nestedTargetCount: 0, msgExecGlobalEnumerationGap: true, signerFixedPointSufficientForGlobalCompletion: false },
    retainedOverlap: { exact: null, observedTransactions: null, observedMessagePairs: null, missingPairCount: null, extraPairCount: null, pairSetSha256: null, expectedTransactions: baseline.counts.transactions, expectedMessagePairs: baseline.counts.messagePairs },
    preRetention: { transactionCount: null, directTargetMessages: null, minimumHeight: null, maximumHeight: null, quorumEventCount: null, quorumEventSourceAvailableForAllRows: null, details: [] },
    completeness: { knownSeedApiSemantics: "NOT_ESTABLISHED_FAIL_CLOSED", globalCompleteness: false, completeHistoricalSignerRosterKnown: false, globalCollectionDocumented: false, fixedPointIsDiscoveryOnly: true, productionExposure: "UNKNOWN/COVERAGE_OPEN" },
    classification: classifications[category] || classifications.LOCAL_SETUP,
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, evidenceComplete: false, closureEligible: false, productionWideClosure: false },
    httpBudget: null,
  };
}

function buildReport(raw) {
  if (raw.status === "BLOCKED_FAIL_CLOSED") {
    const blockedCause = raw.blockedDiagnostic.cause || raw.blockedDiagnostic.causeCode || raw.blockedDiagnostic.code;
    return [
      "# Babylon Step 11 — Token-Safe Mintscan Pre-Retention Enumeration", "",
      `Run: \`${raw.runId}\`.`, "",
      `Signal: 🟠 WATCH — **${raw.classification}**. Production remains **${raw.completeness.productionExposure}**.`, "",
      `- Sanitized root-cause pair: category/classification \`TOKEN_AUTH_BLOCKED\`; cause \`${blockedCause}\`. Lower-level code: \`${raw.blockedDiagnostic.code}\`. No response body, header, cookie, token, authorization, or raw address is retained.`,
      `- Remediation: Obtain an approved Mintscan data API Bearer with tx-detail/account-history scope. Rotate the exposed rejected token.`,
      `- Boundary: height ${raw.boundarySemantics.unavailableHeight} timestamp remains null and is never queried; ${raw.boundarySemantics.firstAvailableHeight} at ${raw.boundarySemantics.firstAvailableTimestamp} is the exclusive logical pre-retention boundary.`,
      `- Step 9 baseline remains ${raw.retainedOverlap.expectedTransactions}/${raw.retainedOverlap.expectedMessagePairs} transactions/message pairs; Mintscan overlap semantics are not established.`,
      "- Known-seed fixed point and global completeness remain unproven; MsgExec global coverage remains open. Global source/complete roster remains the separate completeness requirement after token access works.",
      "- `routePositive=0`, `executableNow=0`, `signedActionJustified=false`, `evidenceComplete=false`, `closureEligible=false`.", "",
    ].join("\n");
  }
  return [
    "# Babylon Step 11 — Token-Safe Mintscan Pre-Retention Enumeration", "",
    `Run: \`${raw.runId}\`.`, "",
    `Signal: 🟠 WATCH — **${raw.classification}**. Production remains **${raw.completeness.productionExposure}**.`, "",
    `- Step 9/10 bindings: \`${raw.context.step9.runId}\` / \`${raw.context.step10.runId}\`.`,
    `- Retained seed discovery: ${raw.retainedSeedDiscovery.counts.directSigners} hashed direct signers, ${raw.retainedSeedDiscovery.counts.transactions} transactions, ${raw.retainedSeedDiscovery.counts.messagePairs} message pairs.`,
    `- Auth validation status: detail/account ${raw.tokenValidation.detail.status}/${raw.tokenValidation.account.status}; only schema fingerprints and counts retained.`,
    `- Seed source: ${raw.retainedSeedDiscovery.source}; known-unavailable height queried: ${raw.boundarySemantics.knownUnavailableBlockQueried}.`,
    `- Retained overlap exact: ${raw.retainedOverlap.exact}; observed ${raw.retainedOverlap.observedTransactions}/${raw.retainedOverlap.observedMessagePairs} transactions/message pairs.`,
    `- Pre-retention transactions/direct targets/quorum events: ${raw.preRetention.transactionCount}/${raw.preRetention.directTargetMessages}/${raw.preRetention.quorumEventCount}.`,
    `- Direct/MsgExec/nested-target totals: ${raw.enumeration.directTargetMessages}/${raw.enumeration.msgExecCount}/${raw.enumeration.nestedTargetCount}. MsgExec global enumeration gap: ${raw.enumeration.msgExecGlobalEnumerationGap}.`,
    "- Signer fixed point is discovery-only and cannot establish global historical completeness.",
    "- No token, raw authorization/header/cookie, raw body, raw address, or covenant signature bytes are retained.", "",
    "## Gates", "",
    "- `routePositive=0`, `executableNow=0`, `signedActionJustified=false`, `evidenceComplete=false`, `closureEligible=false`.", "",
  ].join("\n");
}
function buildDefinitions(raw) {
  const blockedCause = raw.status === "BLOCKED_FAIL_CLOSED" ? (raw.blockedDiagnostic.cause || raw.blockedDiagnostic.causeCode || raw.blockedDiagnostic.code) : null;
  return ["# Babylon Step 11 Definitions", "", `Run: \`${raw.runId}\`.`, "", "- **Known-seed completeness:** exact behavior only for the account seeds actually queried.", "- **Fixed point:** no new direct signer discovered from fetched detail rows; never proof of a complete global roster.", "- **MsgExec gap:** the documented account filter targets MsgAddCovenantSigs and does not establish global MsgExec coverage.", "- **Implicit fee payer caveat:** absent explicit payer means the outer signer may pay; no payer address is inferred.", blockedCause ? `- **Token auth blocker:** the current blocked run is classified as TOKEN_AUTH_BLOCKED; the primary cause is ${blockedCause}. The lower-level code ${raw.blockedDiagnostic.code} is secondary. Remediation: obtain an approved Mintscan data API Bearer with tx-detail/account-history scope and rotate the exposed rejected token.` : "", "- **Null:** source field absent or not established; never silently converted to false or zero.", ""].join("\n").replace(/\n\n\n/g, "\n\n");
}
function buildSources(raw) {
  const blockedCause = raw.status === "BLOCKED_FAIL_CLOSED" ? (raw.blockedDiagnostic.cause || raw.blockedDiagnostic.causeCode || raw.blockedDiagnostic.code) : null;
  return ["# Babylon Step 11 Sources", "", `Run: \`${raw.runId}\`.`, "", "- Step 9 R3 transaction/message baseline and manifest-bound archive boundary are exact local inputs.", "- The known-unavailable predecessor height is never requested; the first available block timestamp is used as an exclusive logical date boundary with unknown account-filter precision and exact height post-filtering.", "- Step 10 R3 manifest and fetched documentation captures bind the two permitted Mintscan GET schemas.", "- Retained signer addresses are decoded in memory from a public Comet or REST transaction cursor and persisted only as stage-salted hashes; origins are excluded.", `- Prior blocked run \`${raw.context.priorBlockedRun.runId}\` is preserved as superseded history.`, blockedCause ? `- Current blocked run root-cause pair: TOKEN_AUTH_BLOCKED / ${blockedCause}. Lower-level code: ${raw.blockedDiagnostic.code}. Remediation: obtain an approved Mintscan data API Bearer with tx-detail/account-history scope and rotate the exposed rejected token.` : "", "- Mintscan responses are normalized in memory; raw bodies, headers, cookies, addresses, authorization, token, and signature bytes are excluded.", ""].join("\n").replace(/\n\n\n/g, "\n\n");
}
function buildHandoff(raw) {
  if (raw.status === "BLOCKED_FAIL_CLOSED") {
    const blockedCause = raw.blockedDiagnostic.cause || raw.blockedDiagnostic.causeCode || raw.blockedDiagnostic.code;
    return ["# Critical Handoff — Babylon Step 11 Mintscan Enumeration", "", `- Run \`${raw.runId}\` blocked fail-closed.`, `- Root-cause pair: category/classification \`TOKEN_AUTH_BLOCKED\`; cause \`${blockedCause}\`. Lower-level code: \`${raw.blockedDiagnostic.code}\`.`, `- Classification \`${raw.classification}\`; production \`${raw.completeness.productionExposure}\`.`, "- Remediation: Obtain an approved Mintscan data API Bearer with tx-detail/account-history scope. Rotate the exposed rejected token.", "- Known-unavailable height 2556425 is not queried; the Step 9 first-available timestamp is the exclusive logical boundary.", "- No known-seed/API semantics, global completeness, route, execution, signing, evidence, or closure gate opened.", "- No endpoint inventory, prior stage, aggregate gate, coordinator state, claim, token, raw address, body/header/cookie, or signature-byte change.", ""].join("\n");
  }
  return ["# Critical Handoff — Babylon Step 11 Mintscan Enumeration", "", `- Run \`${raw.runId}\`; classification \`${raw.classification}\`; production \`${raw.completeness.productionExposure}\`.`, `- Retained overlap exact=${raw.retainedOverlap.exact}; pre-retention tx/direct targets=${raw.preRetention.transactionCount}/${raw.preRetention.directTargetMessages}.`, `- Queried signer hashes=${raw.enumeration.queriedSignerHashCount}; fixed point remains globally insufficient; MsgExec global gap=${raw.enumeration.msgExecGlobalEnumerationGap}.`, "- Route/executable/signing/evidence/closure remain 0/0/false/false/false.", "- No endpoint inventory, prior stage, aggregate gate, coordinator state, claim, token, raw address, or signature-byte change.", ""].join("\n");
}
function buildInbox(raw) {
  const blockedCause = raw.status === "BLOCKED_FAIL_CLOSED" ? (raw.blockedDiagnostic.cause || raw.blockedDiagnostic.causeCode || raw.blockedDiagnostic.code) : null;
  const blockedSummary = raw.status === "BLOCKED_FAIL_CLOSED"
    ? `Token-safe Mintscan enumeration blocked fail-closed: root-cause pair TOKEN_AUTH_BLOCKED / ${blockedCause}; lower-level code ${raw.blockedDiagnostic.code}.`
    : "Token-safe known-seed Mintscan enumeration completed without establishing global pre-retention completeness.";
  const nextAction = raw.status === "BLOCKED_FAIL_CLOSED"
    ? "Obtain an approved Mintscan data API Bearer with tx-detail/account-history scope. Rotate the exposed rejected token. After token access works, complete global source/complete roster reconciliation remains the separate completeness requirement."
    : "Obtain a complete global source, authoritative ledger, or independently complete historical signer roster and reconcile it exactly.";
  return { findingId: "babylon-step11-mintscan-pre-retention", agentId: "critical-babylon-step11-20260718", role: "critical-research", status: "blocked", classification: raw.classification, productionExposure: raw.completeness.productionExposure, routePositive: 0, executableNow: 0, signedActionJustified: false, evidenceComplete: false, closureEligible: false, summary: blockedSummary, artifacts: [rel(RAW), rel(MANIFEST), rel(REPORT), rel(DEFINITIONS), rel(SOURCES), rel(HANDOFF)], nextAction };
}
function manifestFor(raw, stageTexts) {
  const staticInputs = [TOOL, STEP9_MANIFEST, STEP9_RAW, STEP9_TX_FACTS, STEP9_BOUNDARY, STEP10_MANIFEST, STEP10_RAW, PRIOR_BLOCKED_ARCHIVE_INDEX];
  const stagePaths = [RAW, REPORT, DEFINITIONS, SOURCES, HANDOFF, INBOX];
  const files = staticInputs.map((file) => ({ path: rel(file), bytes: fs.statSync(file).size, sha256: shaFile(file) }));
  for (const file of stagePaths) {
    const text = stageTexts.get(file); files.push({ path: rel(file), bytes: Buffer.byteLength(text), sha256: hashText(text) });
  }
  const aggregateSha256 = hashText(files.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"));
  return { schemaVersion: 1, runId: raw.runId, generatedAt: raw.generatedAt, manifestWrittenLast: true, redactionPolicy: "Bearer and authorization material are process-memory-only and excluded from every file and hash.", context: raw.context, files, validations: { priorBindings: true, onlyExpectedStageFiles: true, credentialMaterialExcluded: true, addressValuesExcluded: true, unprocessedPayloadsExcluded: true }, aggregateSha256 };
}
function buildPublicationBundle(raw, token) {
  const texts = new Map([
    [RAW, json(raw)], [REPORT, buildReport(raw)], [DEFINITIONS, buildDefinitions(raw)], [SOURCES, buildSources(raw)], [HANDOFF, buildHandoff(raw)], [INBOX, json(buildInbox(raw))],
  ]);
  for (const [file, text] of texts) {
    try { assertOutputSafe(text, token); }
    catch (error) { if (error instanceof SafeError) throw new SafeError(error.code, { requestClass: rel(file) }); throw error; }
  }
  const manifestText = json(manifestFor(raw, texts));
  try { assertOutputSafe(manifestText, token); }
  catch (error) { if (error instanceof SafeError) throw new SafeError(error.code, { requestClass: rel(MANIFEST) }); throw error; }
  return { texts, manifestText };
}
function defaultPublicationAdapter() {
  return {
    directoryExists: (file) => fs.existsSync(path.dirname(file)),
    stage(file, text) { const temp = `${file}.step11-tmp-${process.pid}`; fs.writeFileSync(temp, text, { encoding: "utf8", flag: "wx" }); return temp; },
    commit(temp, file) { fs.renameSync(temp, file); },
    cleanup(temp) { try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {} },
    remove(file) { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {} },
    hash(file) { return shaFile(file); },
  };
}
function atomicPublish(raw, token, adapter = defaultPublicationAdapter()) {
  const { texts, manifestText } = buildPublicationBundle(raw, token);
  const staged = [];
  let manifestTemp = null;
  try {
    for (const [file, text] of texts) {
      if (!adapter.directoryExists(file)) throw new SafeError("OUTPUT_DIRECTORY_MISSING", { file: rel(file) });
      staged.push([adapter.stage(file, text), file]);
    }
    manifestTemp = adapter.stage(MANIFEST, manifestText);
    for (const [temp, file] of staged) adapter.commit(temp, file);
    adapter.commit(manifestTemp, MANIFEST);
    manifestTemp = null;
  } catch (error) {
    for (const [temp] of staged) adapter.cleanup(temp);
    if (manifestTemp) adapter.cleanup(manifestTemp);
    for (const file of LIVE_OUTPUT_PATHS) adapter.remove(file);
    if (error instanceof SafeError) throw error;
    throw new SafeError("ATOMIC_PUBLISH_FAILED");
  }
  return { runId: raw.runId, classification: raw.classification, manifestAggregateSha256: JSON.parse(manifestText).aggregateSha256, manifestFileSha256: adapter.hash(MANIFEST), gates: raw.gates };
}
function findPartialTempFiles() {
  const rows = [];
  for (const file of LIVE_OUTPUT_PATHS) {
    const directory = path.dirname(file); const prefix = `${path.basename(file)}.step11-tmp-`;
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) if (name.startsWith(prefix)) rows.push(path.join(directory, name));
  }
  return [...new Set(rows)];
}
function completePublicationValid() {
  if (!LIVE_OUTPUT_PATHS.every(fs.existsSync)) return false;
  try {
    const raw = readJson(RAW); const manifest = readJson(MANIFEST);
    if (manifest.runId !== raw.runId || manifest.manifestWrittenLast !== true || !Array.isArray(manifest.files)) return false;
    for (const file of LIVE_OUTPUT_PATHS.filter((item) => item !== MANIFEST)) {
      const row = manifest.files.find((item) => item.path === rel(file));
      if (!row || row.bytes !== fs.statSync(file).size || row.sha256 !== shaFile(file)) return false;
    }
    assertOutputSafe(raw); assertOutputSafe(fs.readFileSync(MANIFEST, "utf8"));
    return true;
  } catch (_) { return false; }
}
function reconcilePartialPublication() {
  const temps = findPartialTempFiles();
  const existing = LIVE_OUTPUT_PATHS.filter(fs.existsSync);
  const completeValid = completePublicationValid();
  let removedTempFiles = 0; let removedMixedFiles = 0;
  for (const file of temps) { try { fs.unlinkSync(file); removedTempFiles++; } catch (_) {} }
  if (existing.length && !completeValid) for (const file of LIVE_OUTPUT_PATHS) {
    try { if (fs.existsSync(file)) { fs.unlinkSync(file); removedMixedFiles++; } } catch (_) {}
  }
  return { status: completeValid ? "COMPLETE_SET_PRESERVED" : existing.length || temps.length ? "PARTIAL_SET_CANCELLED" : "NO_PARTIAL_ARTIFACTS", completeValid, existingBefore: existing.length, tempFilesBefore: temps.length, removedMixedFiles, removedTempFiles, mixedArtifactsRemain: LIVE_OUTPUT_PATHS.some(fs.existsSync) && !completePublicationValid() };
}

async function main() {
  if (process.argv.includes("--reconcile-partials")) { process.stdout.write(json(reconcilePartialPublication())); return; }
  if (!process.argv.includes("--live")) throw new SafeError("LIVE_FLAG_REQUIRED");
  const token = process.env.MINTSCAN_API_TOKEN;
  if (!token) throw new SafeError("MINTSCAN_API_TOKEN_REQUIRED");
  const reconciliation = reconcilePartialPublication();
  if (reconciliation.mixedArtifactsRemain) throw new SafeError("PARTIAL_PUBLICATION_RECONCILIATION_FAILED");
  let raw; let blocked = false;
  try { raw = await runLive({ token }); }
  catch (error) {
    if (!(error instanceof SafeError)) throw error;
    raw = buildBlockedRaw(error); blocked = true;
  }
  const summary = atomicPublish(raw, token);
  process.stdout.write(json(summary));
  if (blocked) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    const code = error instanceof SafeError ? error.code : "UNEXPECTED_FAILURE";
    const diagnostic = error instanceof SafeError ? error.diagnostic : {};
    process.stderr.write(`Babylon Step 11 refused/failed: ${code}${Object.keys(diagnostic).length ? ` ${JSON.stringify(diagnostic)}` : ""}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ADDRESS_HASH_SALT,
  API_ORIGIN,
  BudgetedHttpClient,
  EXPECTED_STEP10_RUN,
  LIMITS,
  SafeError,
  TARGET_MSG,
  addressHash,
  assertOutputSafe,
  assertNormalizedRecord,
  atomicPublish,
  bindContext,
  buildBlockedRaw,
  buildPublicationBundle,
  compareRetainedOverlap,
  decodeRetainedTx,
  discoverRetainedSeeds,
  discoverRetainedSeedsRest,
  discoverOneRetainedSigner,
  enumerateAccountWindow,
  identityHash,
  loadStep9Baseline,
  normalizeDetail,
  pairKey,
  runLive,
  reconcilePartialPublication,
  sanitizeDiagnostic,
  schemaFingerprint,
  unwrapAccountPage,
  validatePathAndQuery,
};
