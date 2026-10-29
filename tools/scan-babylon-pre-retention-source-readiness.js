#!/usr/bin/env node
"use strict";

/*
 * Babylon BAB-H-01 Step 10 R3 pre-retention source-readiness gate.
 *
 * Defensive/read-only. Endpoint inventories are consumed only in memory and
 * are never emitted or hashed. Public archive objects are HEAD-probed only.
 * GET responses use a pre-read Content-Length gate plus a streaming byte cap.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BASE = "babylon-pre-retention-source-readiness";
const TOOL = path.join(ROOT, "tools", `scan-${BASE}.js`);
const RAW = path.join(ROOT, "reports", "raw", "fast", `${BASE}.json`);
const FIXTURE = path.join(ROOT, "reports", "raw", "fast", `${BASE}.source-doc-fixtures.json`);
const MANIFEST = path.join(ROOT, "reports", "raw", "fast", `${BASE}.manifest.json`);
const REPORT = path.join(ROOT, "reports", `${BASE}.md`);
const DEFINITIONS = path.join(ROOT, "reports", `${BASE}-definitions.md`);
const SOURCES = path.join(ROOT, "reports", `${BASE}-sources.md`);
const HANDOFF = path.join(ROOT, "coordination", "handoffs", "2026-07-18-critical-babylon-step10-r3-handoff.md");
const INBOX = path.join(ROOT, "coordination", "inbox", "critical", "2026-07-18-critical-babylon-step10-r3-source-gate.json");
const R1_INTEGRITY = path.join(ROOT, "reports", "history", "babylon-step10-r1", "INTEGRITY-FAILURE.json");
const R1_DIR = path.dirname(R1_INTEGRITY);
const R1_MANIFEST = path.join(R1_DIR, "artifact-babylon-pre-retention-source-readiness.manifest.json");
const R2_DIR = path.join(ROOT, "reports", "history", "babylon-step10-r2");
const R2_MANIFEST = path.join(R2_DIR, "artifact-babylon-pre-retention-source-readiness.manifest.json");
const R2_RAW = path.join(R2_DIR, "artifact-babylon-pre-retention-source-readiness.json");
const R2_FIXTURE = path.join(R2_DIR, "artifact-babylon-pre-retention-source-readiness.source-doc-fixtures.json");
const R2_TOOL = path.join(R2_DIR, "tool-scan-babylon-pre-retention-source-readiness.js");

const STEP9_RAW = path.join(ROOT, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.json");
const STEP9_MANIFEST = path.join(ROOT, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.manifest.json");
const STEP9_BOUNDARY = path.join(ROOT, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.archive-boundary.json");
const STEP9_TX = path.join(ROOT, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.tx-event-facts.json");
const STEP9_FIXTURE = path.join(ROOT, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.fixtures.json");
const SOURCE_TX_PROTO = path.join(ROOT, "sources", "babylon-v4.3.0", "proto", "babylon", "btcstaking", "v1", "tx.proto");
const SOURCE_PARAMS_PROTO = path.join(ROOT, "sources", "babylon-v4.3.0", "proto", "babylon", "btcstaking", "v1", "params.proto");
const SOURCE_MSG_SERVER = path.join(ROOT, "sources", "babylon-v4.3.0", "x", "btcstaking", "keeper", "msg_server.go");
const PUBLIC_DISCOVERY_INPUTS = [
  path.join(ROOT, "tools", "scan-babylon-late-quorum-current-state.js"),
  path.join(ROOT, "tools", "scan-babylon-late-quorum-production-exposure.js"),
  path.join(ROOT, "sources", "free-protocol-step5-request-liability", "tokenMapping.js"),
];

const PRIVATE_INPUTS = [path.join(ROOT, "rpc_endpoints.txt"), path.join(ROOT, "graphql_endpoints.txt")];
const OUTPUTS = [RAW, FIXTURE, MANIFEST, REPORT, DEFINITIONS, SOURCES, HANDOFF, INBOX, R1_INTEGRITY].map((file) => path.resolve(file));
const OUTPUT_SET = new Set(OUTPUTS);
const OFFLINE = process.argv.includes("--offline");
const REFRESH = process.argv.includes("--refresh-fixtures");
const MAX_BODY = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 7000;
const LAST_MISSING = "2556425";
const FIRST_RETAINED = "2556426";
const MSG_ADD = "/babylon.btcstaking.v1.MsgAddCovenantSigs";
const MSG_EXEC = "/cosmos.authz.v1beta1.MsgExec";
const MSG_GRANT = "/cosmos.authz.v1beta1.MsgGrant";
const MSG_REVOKE = "/cosmos.authz.v1beta1.MsgRevoke";
const EXPECTED_STEP9_RUN = "babylon-step9-r3-20260717212558-9b163306c904";
const EXPECTED_STEP9_AGG = "8d132b0917d160dc6334e119a7c2520ac2b3b15d0809f31dd519531075a08a5a";
const EXPECTED_R2_RUN = "babylon-step10-r2-20260718020017-9a858d9367e3";
const EVIDENCE_REVISION = "r3-oracle-revised";
const DOC_COMMIT_URL = process.env.BABYLON_STEP10_DOC_COMMIT_URL || null;
const DOC_TREE_URL = process.env.BABYLON_STEP10_DOC_TREE_URL || null;
const DOC_RAW_TEMPLATE = process.env.BABYLON_STEP10_DOC_RAW_TEMPLATE || null;

function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function shaBytes(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function shaFile(file) { return shaBytes(fs.readFileSync(file)); }
function hashText(value) { return shaBytes(Buffer.from(String(value), "utf8")); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function json(value) { return JSON.stringify(canonical(value), null, 2) + "\n"; }
function write(file, body) {
  const target = path.resolve(file);
  if (!OUTPUT_SET.has(target)) throw new Error(`write outside current Step 10 stage: ${rel(target)}`);
  if (!fs.existsSync(path.dirname(target))) throw new Error(`missing output directory: ${rel(path.dirname(target))}`);
  fs.writeFileSync(target, body, "utf8");
}
function existsAll(files) {
  const missing = files.filter((file) => !fs.existsSync(file));
  if (missing.length) throw new Error(`missing inputs: ${missing.map(rel).join(", ")}`);
}
function safeIntString(value) { return value != null && /^\d+$/.test(String(value)) ? String(value) : null; }
function first(object, paths) {
  for (const keys of paths) {
    let value = object;
    for (const key of keys) value = value && typeof value === "object" ? value[key] : null;
    if (value != null && value !== "") return value;
  }
  return null;
}
function ceilDiv(a, b) { return (a + b - 1n) / b; }
function assertNoLeak(text, label) {
  const protocol = new RegExp("h" + "ttps?:" + "\\/\\/", "i");
  const domain = /\b[a-z0-9-]+\.(?:com|io|org|net|xyz|dev|app|cloud|finance|zone)\b/i;
  const credential = /(?:api[_-]?key|authorization|bearer)\s*[:=]\s*[A-Za-z0-9_.-]{8,}/i;
  if (protocol.test(text) || domain.test(text) || credential.test(text)) throw new Error(`leak scan failed: ${label}`);
}
function leakFree(text) {
  const protocol = new RegExp("h" + "ttps?:" + "\\/\\/", "i");
  const domain = /\b[a-z0-9-]+\.(?:com|io|org|net|xyz|dev|app|cloud|finance|zone)\b/i;
  const credential = /(?:api[_-]?key|authorization|bearer)\s*[:=]\s*[A-Za-z0-9_.-]{8,}/i;
  return !protocol.test(text) && !domain.test(text) && !credential.test(text);
}

function extractUrls(text) {
  const re = new RegExp("h" + "ttps?:\\/\\/[^\\s'\"<>\\[\\]]+", "gi");
  return (String(text).match(re) || []).map((value) => value.replace(/[),;]+$/, ""));
}
function loadPrivateCandidates() {
  const rows = [];
  const seen = new Set();
  let discovered = 0;
  for (const file of PRIVATE_INPUTS) {
    if (!fs.existsSync(file)) continue;
    const urls = extractUrls(fs.readFileSync(file, "utf8"));
    discovered += urls.length;
    for (const value of urls) {
      try {
        const parsed = new URL(value);
        if (!/^https?:$/.test(parsed.protocol)) continue;
        parsed.hash = "";
        const normalized = parsed.toString();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        rows.push({ url: normalized, alias: `candidate-${String(rows.length + 1).padStart(3, "0")}` });
      } catch (_) {}
    }
  }
  for (const file of PUBLIC_DISCOVERY_INPUTS) {
    if (!fs.existsSync(file)) continue;
    for (const value of extractUrls(fs.readFileSync(file, "utf8"))) {
      try {
        const parsed = new URL(value);
        if (!/^https?:$/.test(parsed.protocol)) continue;
        parsed.hash = "";
        const normalized = parsed.toString();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        rows.push({ url: normalized, alias: `candidate-${String(rows.length + 1).padStart(3, "0")}` });
      } catch (_) {}
    }
  }
  return { rows: rows.slice(0, 512), discovered, deduplicated: rows.length, bounded: Math.min(rows.length, 512) };
}
function joinUrl(base, suffix) {
  const parsed = new URL(base);
  const q = suffix.indexOf("?");
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}${q < 0 ? suffix : suffix.slice(0, q)}`.replace(/\/{2,}/g, "/");
  parsed.search = q < 0 ? "" : `?${suffix.slice(q + 1)}`;
  parsed.hash = "";
  return parsed.toString();
}
function redirectClass(from, to) {
  try {
    const a = new URL(from); const b = new URL(to, from);
    return a.origin === b.origin ? "SAME_ORIGIN" : "CROSS_ORIGIN";
  } catch (_) { return "INVALID_TARGET"; }
}
function isPublicHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1") return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    const match = host.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return false;
    if (/^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host)) return false;
    return true;
  } catch (_) { return false; }
}
function coarseStatus(status) {
  if (status == null) return "UNREACHABLE";
  if (status === 401) return "UNAUTHORIZED_401";
  if (status === 403) return "FORBIDDEN_403";
  if (status >= 200 && status < 300) return "REACHABLE";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_ERROR";
  return "REJECTED";
}
async function boundedResponse(response, method) {
  if (method === "HEAD") return { bytes: 0, text: "", object: null, abortedBeforeBody: true, capReason: "HEAD" };
  const declared = safeIntString(response.headers.get("content-length"));
  if (declared != null && BigInt(declared) > BigInt(MAX_BODY)) {
    try { await response.body?.cancel(); } catch (_) {}
    return { bytes: 0, text: "", object: null, abortedBeforeBody: true, capReason: "CONTENT_LENGTH" };
  }
  if (!response.body) return { bytes: 0, text: "", object: null, abortedBeforeBody: false, capReason: null };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY) {
      try { await reader.cancel(); } catch (_) {}
      return { bytes, text: "", object: null, abortedBeforeBody: false, capReason: "STREAM_CAP" };
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let object = null;
  try { object = JSON.parse(text); } catch (_) {}
  return { bytes, text, object, abortedBeforeBody: false, capReason: null };
}
async function httpRequest(url, options = {}) {
  const method = options.method || "GET";
  const redirectChain = [];
  let current = url;
  if (!isPublicHttpUrl(current)) return { status: null, ok: false, headers: null, redirectChain, publicTargetRejected: true, redirectLimitExceeded: false, bytes: 0, text: "", object: null, capReason: null };
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        method,
        headers: { accept: options.accept || "application/json", "user-agent": "babylon-step10-r3-readonly", ...(options.headers || {}) },
        body: options.body || null,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        const next = new URL(response.headers.get("location"), current).toString();
        const targetClass = redirectClass(current, next);
        redirectChain.push(targetClass);
        try { await response.body?.cancel(); } catch (_) {}
        if (targetClass !== "SAME_ORIGIN" || !isPublicHttpUrl(next)) return { status: response.status, headers: response.headers, redirectChain, crossOriginRedirectBlocked: targetClass !== "SAME_ORIGIN", publicTargetRejected: !isPublicHttpUrl(next), redirectLimitExceeded: false, bytes: 0, text: "", object: null };
        if (redirects === MAX_REDIRECTS) return { status: response.status, headers: response.headers, redirectChain, redirectLimitExceeded: true, bytes: 0, text: "", object: null };
        current = next;
        continue;
      }
      const body = await boundedResponse(response, method);
      return { status: response.status, ok: response.ok, headers: response.headers, redirectChain, redirectLimitExceeded: false, ...body };
    } catch (_) {
      return { status: null, ok: false, headers: null, redirectChain, redirectLimitExceeded: false, bytes: 0, text: "", object: null, capReason: null };
    } finally { clearTimeout(timer); }
  }
  throw new Error("unreachable redirect state");
}

function chainId(object) {
  return first(object || {}, [["result", "node_info", "network"], ["node_info", "network"], ["default_node_info", "network"], ["defaultNodeInfo", "network"]]);
}
function blockHeight(object) { return safeIntString(first(object || {}, [["result", "block", "header", "height"], ["block", "header", "height"]])); }
async function probeProvider(candidate) {
  const [status, rest] = await Promise.all([
    httpRequest(joinUrl(candidate.url, "/status")),
    httpRequest(joinUrl(candidate.url, "/cosmos/base/tendermint/v1beta1/node_info")),
  ]);
  const comet = chainId(status.object) === "bbn-1";
  const restOk = chainId(rest.object) === "bbn-1";
  const babylon = comet || restOk;
  const row = {
    alias: candidate.alias,
    status: babylon ? "BABYLON_REACHABLE" : ([status.status, rest.status].includes(401) ? "AUTH_REQUIRED" : "NOT_REACHABLE_AS_BABYLON"),
    capabilities: { comet, rest: restOk, txSearch: null, blockAtLastMissing: null, blockAtFirstRetained: null },
    earliestObservedHeight: null,
  };
  if (comet) {
    const [prior, retained, tx] = await Promise.all([
      httpRequest(joinUrl(candidate.url, `/block?height=${LAST_MISSING}`)),
      httpRequest(joinUrl(candidate.url, `/block?height=${FIRST_RETAINED}`)),
      httpRequest(candidate.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx_search", params: { query: `message.action='${MSG_ADD}'`, prove: false, page: "1", per_page: "1", order_by: "asc" } }) }),
    ]);
    row.capabilities.blockAtLastMissing = blockHeight(prior.object) === LAST_MISSING;
    row.capabilities.blockAtFirstRetained = blockHeight(retained.object) === FIRST_RETAINED;
    row.capabilities.txSearch = Boolean(tx.object && tx.object.result && Array.isArray(tx.object.result.txs));
    row.earliestObservedHeight = row.capabilities.blockAtLastMissing ? LAST_MISSING : row.capabilities.blockAtFirstRetained ? FIRST_RETAINED : null;
  }
  row._url = candidate.url;
  return row;
}
async function probeProviders(pool) {
  const rows = new Array(pool.rows.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= pool.rows.length) return;
      rows[index] = await probeProvider(pool.rows[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(20, Math.max(1, pool.rows.length)) }, worker));
  const reachable = rows.filter((row) => row.status === "BABYLON_REACHABLE");
  const earliest = reachable.map((row) => row.earliestObservedHeight).filter(Boolean).map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)[0];
  return {
    privateRows: rows,
    sanitized: {
      discoveredCandidates: pool.deduplicated,
      boundedCandidates: pool.bounded,
      reachable: reachable.length,
      comet: rows.filter((row) => row.capabilities.comet).length,
      rest: rows.filter((row) => row.capabilities.rest).length,
      txSearch: rows.filter((row) => row.capabilities.txSearch).length,
      preRetentionBlock: rows.filter((row) => row.capabilities.blockAtLastMissing).length,
      earliestObservedHeight: earliest == null ? null : earliest.toString(),
      reachableRows: reachable.map((row) => ({ alias: row.alias, capabilities: row.capabilities, earliestObservedHeight: row.earliestObservedHeight })),
      reproducibility: { discoveryInput: "authorized-memory-only-inventory", endpointMaterialRetained: false, probeMethods: ["GET status", "GET node_info", "GET fixed blocks", "POST tx_search"] },
    },
  };
}

function deriveArchiveStatusPages(pool) {
  const pages = [];
  const seen = new Set();
  function add(value) { try { const normalized = new URL(value).toString(); if (!seen.has(normalized)) { seen.add(normalized); pages.push(normalized); } } catch (_) {} }
  for (const row of pool.rows) {
    try {
      const parsed = new URL(row.url);
      if (/tendermint_snapshots\/babylon/i.test(parsed.pathname)) add(parsed.toString());
      if (/\/snapshots\/babylon\//i.test(parsed.pathname) || /babylon_\d+\.tar\.lz4/i.test(parsed.pathname)) {
        const labels = parsed.hostname.split(".");
        if (labels.length > 1) labels[0] = "www";
        parsed.hostname = labels.join(".");
        parsed.pathname = "/tendermint_snapshots/babylon";
        parsed.search = "";
        add(parsed.toString());
      }
    } catch (_) {}
  }
  return pages;
}
async function probeArchive(pool) {
  let page = null;
  let pageUrl = null;
  for (const candidate of deriveArchiveStatusPages(pool)) {
    const response = await httpRequest(candidate, { accept: "text/html" });
    if (response.ok && /Babylon Node Snapshot/i.test(response.text) && /How To Process Babylon Snapshot/i.test(response.text)) { page = response; pageUrl = candidate; break; }
  }
  if (!page) return { sourceClassification: "AUTHORITATIVE_PUBLIC_SNAPSHOT_STATUS_PAGE", pageStatus: "UNAVAILABLE", sourceCaptureRecords: [], current: null, historical: null, safeHttp: emptyArchiveHttp(), nodeConfiguration: null, replacementPolicy: null, suitability: "NOT_EVALUATED" };
  const objectMatch = page.text.match(/(?:href=["']|wget[^\n]*?)([^\s"']*babylon_(\d+)\.tar\.lz4)/i) || page.text.match(/(h[^\s"']+babylon_(\d+)\.tar\.lz4)/i);
  let objectUrl = null;
  let height = null;
  if (objectMatch) {
    height = objectMatch[2];
    try { objectUrl = new URL(objectMatch[1], pageUrl).toString(); } catch (_) {}
  }
  const head = objectUrl ? await httpRequest(objectUrl, { method: "HEAD", accept: "*/*" }) : null;
  const compressedBytes = safeIntString(head && head.headers && head.headers.get("content-length"));
  const rangeHeader = head && head.headers && head.headers.get("accept-ranges");
  const visible = page.text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, "\n").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const lines = visible.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const exact = (pattern) => lines.find((line) => pattern.test(line)) || null;
  const value = (key) => {
    const line = exact(new RegExp(`^${key}\\s*=`, "i"));
    if (!line) return null;
    const match = line.match(/=\s*["']?([^"'\s#<]+)["']?/);
    return match ? match[1] : null;
  };
  const keepRecent = safeIntString(value("pruning-keep-recent"));
  const keepEvery = safeIntString(value("pruning-keep-every"));
  const pruningInterval = safeIntString(value("pruning-interval"));
  const pruning = value("pruning");
  const indexer = value("indexer");
  const configExcerpts = [exact(/^pruning\s*=/i), exact(/^pruning-keep-recent\s*=/i), exact(/^pruning-keep-every\s*=/i), exact(/^pruning-interval\s*=/i), exact(/^indexer\s*=/i)].filter(Boolean);
  const replacementIndex = lines.findIndex((line) => /We take one node snapshot every day\. We then delete all the previous/i.test(line));
  const replacementExcerpt = replacementIndex >= 0 ? [lines[replacementIndex], lines[replacementIndex + 1]].filter(Boolean).join(" ") : exact(/(?:previous|older|old).*snapshot.*(?:delete|remove|replace)|snapshot.*(?:delete|remove|replace).*(?:previous|older|old)/i);
  const checksumDetected = /(?:sha-?256|checksum|\.sha256\b)/i.test(page.text);
  const signatureDetected = /(?:detached signature|\.asc\b|\.sig\b)/i.test(page.text);
  const nodeConfiguration = {
    pruning: pruning || null,
    pruningKeepRecent: keepRecent == null ? null : Number(keepRecent),
    pruningKeepEvery: keepEvery == null ? null : Number(keepEvery),
    pruningInterval: pruningInterval == null ? null : Number(pruningInterval),
    indexer: indexer || null,
  };
  const current = {
    status: head && head.ok ? "CURRENT_METADATA_VERIFIED" : "CURRENT_METADATA_UNVERIFIED",
    height,
    compressedBytes,
    byteRangeSupport: rangeHeader == null ? null : !/^none$/i.test(rangeHeader),
    publishedChecksum: checksumDetected ? true : null,
    publishedSignature: signatureDetected ? true : null,
    checksumVerificationResult: null,
    signatureVerificationResult: null,
    extractionBytes: null,
    requiredRamBytes: null,
    transferAndExtractionSeconds: null,
  };
  const fetchedAt = new Date().toISOString();
  const pageFacts = { currentObjectHeight: height, nodeConfiguration, replacementPolicy: replacementExcerpt, checksumMentioned: checksumDetected || null, signatureMentioned: signatureDetected || null };
  const headHeaders = sanitizedHeaders(head && head.headers);
  const sourceCaptureRecords = [
    { sourceAlias: "snapshot-status-instructions", repositoryCommitSha: null, repositoryTreeSha: null, path: "snapshot/status-and-instructions", httpStatus: page.status, responseBytes: page.bytes, responseSha256: hashText(page.text), normalizedExactExcerpts: [...configExcerpts, ...(replacementExcerpt ? [replacementExcerpt] : [])], facts: pageFacts, fetchedAt },
    { sourceAlias: "snapshot-current-object-head", repositoryCommitSha: null, repositoryTreeSha: null, path: "snapshot/current-object", httpStatus: head ? head.status : null, responseBytes: 0, responseSha256: null, normalizedExactExcerpts: [], facts: { height, compressedBytes, byteRangeSupport: rangeHeader == null ? null : !/^none$/i.test(rangeHeader), sanitizedHeaders: headHeaders.values, sanitizedHeadersSha256: headHeaders.sha256 }, fetchedAt },
  ];
  const normalized = { sourceClassification: "AUTHORITATIVE_PUBLIC_SNAPSHOT_STATUS_AND_INSTRUCTIONS", current, nodeConfiguration, replacementPolicy: replacementExcerpt };
  return {
    sourceClassification: "AUTHORITATIVE_PUBLIC_SNAPSHOT_STATUS_AND_INSTRUCTIONS",
    pageStatus: "CONSUMED",
    normalizedContentSha256: hashText(json(normalized)),
    sourceCaptureRecords,
    current,
    historical: null,
    nodeConfiguration,
    replacementPolicy: replacementExcerpt,
    suitability: "PRUNED/NON_INDEXED/UNSUITABLE_FOR_PRE_RETENTION_HISTORY",
    primaryBlocker: "SOURCE_SEMANTICS_UNSUITABLE",
    safeHttp: {
      headFirst: true,
      statusPageBoundedGet: true,
      preReadContentLengthCapBytes: MAX_BODY,
      streamedBodyCapBytes: MAX_BODY,
      redirectLimit: MAX_REDIRECTS,
      redirectCount: head ? head.redirectChain.length : null,
      redirectTargetClassifications: head ? head.redirectChain : [],
      binaryBodyAbortedBeforeRead: head ? head.abortedBeforeBody === true : null,
      rangeRequests: 0,
      samplesDownloaded: 0,
      archiveBytesDownloaded: 0,
      fullDownloadAttempted: false,
    },
  };
}
function emptyArchiveHttp() {
  return { headFirst: true, statusPageBoundedGet: true, preReadContentLengthCapBytes: MAX_BODY, streamedBodyCapBytes: MAX_BODY, redirectLimit: MAX_REDIRECTS, redirectCount: null, redirectTargetClassifications: [], binaryBodyAbortedBeforeRead: null, rangeRequests: 0, samplesDownloaded: 0, archiveBytesDownloaded: 0, fullDownloadAttempted: false };
}
function sanitizedHeaders(headers) {
  const values = {};
  if (headers) for (const name of ["content-type", "content-length", "accept-ranges", "cache-control", "etag", "last-modified"]) {
    const raw = headers.get(name);
    if (raw == null) continue;
    const clean = String(raw).replace(/h.?ttps?:\/\/\S+/gi, "[omitted]").replace(/\b[a-z0-9-]+\.(?:com|io|org|net|xyz|dev|app|cloud|finance|zone)\b/gi, "[omitted]");
    values[name] = clean;
  }
  return { values, sha256: hashText(json(values)) };
}
function exactSubstring(text, value) { return text.includes(value) ? value : null; }
function sourceExcerpts(filePath, text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const excerpts = [];
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) || /^##\s+\*\*\[(?:GET|POST|PUT|DELETE)\]\*\*\s+\//.test(line)) excerpts.push(line);
    if (/^(?:take|messageTypes\[\]|fromDateTime|toDateTime|searchAfter|height):/.test(line)) excerpts.push(line);
    if (line.includes("Authorization: Bearer")) excerpts.push("Authorization: Bearer");
    if (line === "- Babylon" || line === "## Supported Chain List" || line === "## How to get API Key?") excerpts.push(line);
    if (line.includes("Currently in beta, approval is being processed via email")) excerpts.push("Currently in beta, approval is being processed via email");
  }
  return [...new Set(excerpts)].filter((line) => leakFree(line)).slice(0, 32);
}
function parseRoutes(text) {
  const routes = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^##\s+\*\*\[(GET|POST|PUT|DELETE)\]\*\*\s+(\/\S+)/i);
    if (match) routes.push({ method: match[1].toUpperCase(), pathTemplate: match[2] });
  }
  return routes;
}
function parserTests() {
  const sample = "# Account Transactions\n## **[GET]** /v1/:network/accounts/:address/transactions\nAuthorization: Bearer {redacted}\ntake: 20\nsearchAfter: cursor";
  const routes = parseRoutes(sample); const excerpts = sourceExcerpts("fixture.mdx", sample);
  const checks = { routeParsed: routes.length === 1 && routes[0].pathTemplate === "/v1/:network/accounts/:address/transactions", bearerValueNotRetained: excerpts.includes("Authorization: Bearer") && !excerpts.some((line) => /redacted|\{/.test(line)), queryParsed: excerpts.includes("take: 20") && excerpts.includes("searchAfter: cursor") };
  return { checks, passed: Object.values(checks).every(Boolean) };
}
function docUrl(filePath, commitSha) {
  if (!DOC_RAW_TEMPLATE) throw new Error("missing sanitized runtime documentation source template");
  return DOC_RAW_TEMPLATE.replace("{commitSha}", commitSha).replace("{path}", filePath);
}
async function captureMintscanDocumentation(capturedAt) {
  if (!DOC_COMMIT_URL || !DOC_TREE_URL || !DOC_RAW_TEMPLATE) throw new Error("live documentation sources not supplied at runtime");
  const [commitResponse, treeResponse] = await Promise.all([httpRequest(DOC_COMMIT_URL), httpRequest(DOC_TREE_URL)]);
  if (!commitResponse.ok || !commitResponse.object || !treeResponse.ok || !treeResponse.object) throw new Error("official documentation repository metadata unavailable");
  const commitSha = commitResponse.object.sha;
  const treeSha = first(commitResponse.object, [["commit", "tree", "sha"]]);
  if (!/^[0-9a-f]{40}$/.test(commitSha || "") || !/^[0-9a-f]{40}$/.test(treeSha || "")) throw new Error("official documentation repository identifiers invalid");
  const entries = Array.isArray(treeResponse.object.tree) ? treeResponse.object.tree : [];
  const reviewPaths = entries.filter((entry) => entry.type === "blob" && /^pages\/apis\//.test(entry.path) && (/\.mdx$/.test(entry.path) || /_meta\.json$/.test(entry.path))).map((entry) => entry.path).sort();
  const primaryPaths = ["pages/apis/index.mdx", "pages/apis/_meta.json", "pages/apis/reference/_meta.json", "pages/apis/reference/historical/_meta.json", "pages/apis/reference/historical/account/_meta.json", "pages/apis/reference/historical/account/account-transactions.mdx", "pages/apis/reference/historical/txs/_meta.json", "pages/apis/reference/historical/txs/transactions-hash.mdx"];
  for (const required of primaryPaths) if (!reviewPaths.includes(required)) throw new Error(`official documentation path missing: ${required}`);
  const cosmosReferencePaths = reviewPaths.filter((value) => value.startsWith("pages/apis/reference/") && !value.includes("reference-evm/") && (/\.mdx$/.test(value) || /_meta\.json$/.test(value)));
  const fetchPaths = [...new Set([...primaryPaths, ...cosmosReferencePaths])];
  const records = new Array(fetchPaths.length); const parsed = new Map(); let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++; if (index >= fetchPaths.length) return;
      const filePath = fetchPaths[index]; const response = await httpRequest(docUrl(filePath, commitSha), { accept: "text/plain" });
      if (!response.ok || response.capReason) throw new Error(`official documentation fetch failed: ${filePath}`);
      const excerpts = sourceExcerpts(filePath, response.text); const routes = parseRoutes(response.text);
      parsed.set(filePath, { text: response.text, excerpts, routes });
      records[index] = { sourceAlias: `mintscan-doc-${String(index + 1).padStart(3, "0")}`, repositoryCommitSha: commitSha, repositoryTreeSha: treeSha, path: filePath, httpStatus: response.status, responseBytes: response.bytes, responseSha256: hashText(response.text), normalizedExactExcerpts: excerpts, facts: { routes }, fetchedAt: capturedAt };
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  const intro = parsed.get("pages/apis/index.mdx").text;
  const account = parsed.get("pages/apis/reference/historical/account/account-transactions.mdx").text;
  const detail = parsed.get("pages/apis/reference/historical/txs/transactions-hash.mdx").text;
  const accountRoute = parseRoutes(account).find((row) => row.method === "GET" && row.pathTemplate === "/v1/:network/accounts/:address/transactions") || null;
  const detailRoute = parseRoutes(detail).find((row) => row.method === "GET" && row.pathTemplate === "/v1/:network/txs/:hash") || null;
  const queryKeys = ["take", "messageTypes[]", "fromDateTime", "toDateTime", "searchAfter"].filter((key) => new RegExp(`^${key.replace(/[\[\]]/g, "\\$&")}:`, "m").test(account));
  const allRoutes = records.flatMap((record) => record.facts.routes.map((route) => ({ sourceAlias: record.sourceAlias, ...route })));
  const globalCandidates = allRoutes.filter((route) => route.method === "GET" && /^\/v1\/:network\/(?:txs|transactions)\/?$/.test(route.pathTemplate));
  const metadataRecords = [
    { sourceAlias: "mintscan-repository-commit", repositoryCommitSha: commitSha, repositoryTreeSha: treeSha, path: "repository/commit", httpStatus: commitResponse.status, responseBytes: commitResponse.bytes, responseSha256: hashText(commitResponse.text), normalizedExactExcerpts: [], facts: { commitSha, treeSha }, fetchedAt: capturedAt },
    { sourceAlias: "mintscan-repository-tree", repositoryCommitSha: commitSha, repositoryTreeSha: treeSha, path: "repository/api-docs-tree", httpStatus: treeResponse.status, responseBytes: treeResponse.bytes, responseSha256: hashText(treeResponse.text), normalizedExactExcerpts: primaryPaths, facts: { recursiveTreeTruncated: treeResponse.object.truncated === true, reviewedPathCount: reviewPaths.length, reviewedCosmosReferencePathCount: cosmosReferencePaths.length, reviewedPathsSha256: hashText(reviewPaths.join("\n")) }, fetchedAt: capturedAt },
  ];
  return {
    sourceClassification: "OFFICIAL_PUBLIC_STATIC_DOCUMENTATION",
    repository: { commitSha, treeSha },
    sourceCaptureRecords: [...metadataRecords, ...records],
    sourceCaptureRecordCount: metadataRecords.length + records.length,
    babylonSupportDocumented: exactSubstring(intro, "- Babylon") === "- Babylon",
    approvedBearerRequired: intro.includes("## How to get API Key?") && intro.includes("Currently in beta, approval is being processed via email") && account.includes("Authorization: Bearer") && detail.includes("Authorization: Bearer"),
    accountTransactions: { method: accountRoute && accountRoute.method, pathTemplate: accountRoute && accountRoute.pathTemplate, queryParameters: queryKeys, exactRequestSchemaDocumented: Boolean(accountRoute && queryKeys.length === 5), exactResponseSchema: null },
    transactionDetail: { method: detailRoute && detailRoute.method, pathTemplate: detailRoute && detailRoute.pathTemplate, queryParameters: /^height:/m.test(detail) ? ["height"] : [], exactRequestSchemaDocumented: Boolean(detailRoute && /^height:/m.test(detail)), exactResponseSchema: null },
    globalTransactionCollection: { status: globalCandidates.length === 0 ? "NOT_DOCUMENTED_IN_REVIEWED_API_REFERENCE" : "DOCUMENTED", documented: globalCandidates.length > 0, reviewedCosmosReferencePathCount: cosmosReferencePaths.length, parsedRouteCount: allRoutes.length, exactGlobalCollectionCandidateCount: globalCandidates.length, reviewedPathsSha256: hashText(cosmosReferencePaths.join("\n")) },
    parserTests: parserTests(),
  };
}
function mintscanOrigins(pool) {
  const rows = [];
  const seen = new Set();
  for (const row of pool.rows) {
    try {
      const parsed = new URL(row.url);
      if (!/mintscan/i.test(`${parsed.hostname}${parsed.pathname}`)) continue;
      const origin = parsed.origin;
      if (!seen.has(origin)) { seen.add(origin); rows.push(origin); }
    } catch (_) {}
  }
  return rows;
}
async function probeMintscan(pool) {
  const capturedAt = new Date().toISOString();
  const docs = await captureMintscanDocumentation(capturedAt);
  const origins = mintscanOrigins(pool);
  let account = null;
  let detail = null;
  let selected = false;
  const address = "bbn1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  const txHash = "0".repeat(64);
  for (const origin of origins) {
    const [a, d] = await Promise.all([
      httpRequest(`${origin}/v1/babylon/accounts/${address}/transactions?take=1`),
      httpRequest(`${origin}/v1/babylon/txs/${txHash}`),
    ]);
    if (a.status === 401 || d.status === 401) { account = a; detail = d; selected = true; break; }
  }
  const authRecord = (alias, response) => {
    const headers = sanitizedHeaders(response && response.headers);
    return { sourceAlias: alias, repositoryCommitSha: null, repositoryTreeSha: null, path: alias, httpStatus: response ? response.status : null, responseBytes: response ? response.bytes : 0, responseSha256: response && response.text !== "" ? hashText(response.text) : hashText(""), normalizedExactExcerpts: [], facts: { sanitizedHeaders: headers.values, sanitizedHeadersSha256: headers.sha256, bodySha256: response ? hashText(response.text || "") : null }, fetchedAt: capturedAt };
  };
  const uiCaptures = [];
  for (const candidate of pool.rows.filter((row) => /mintscan/i.test(row.url)).slice(0, 12)) {
    const response = await httpRequest(candidate.url, { accept: "text/html" });
    if (response.status == null) continue;
    uiCaptures.push({ alias: candidate.alias, httpStatus: response.status, responseBytes: response.bytes, responseSha256: hashText(response.text || ""), endpointLikePatterns: (response.text.match(/\/v1\/[^\s"'<>]+/g) || []).filter((value) => !/[?&](?:token|key|authorization)=/i.test(value)).slice(0, 20) });
  }
  return {
    ...docs,
    sourceCaptureRecords: [...docs.sourceCaptureRecords, authRecord("mintscan-account-history-unauthenticated-probe", account), authRecord("mintscan-transaction-detail-unauthenticated-probe", detail)],
    sourceCaptureRecordCount: docs.sourceCaptureRecordCount + 2,
    accountTransactions: {
      ...docs.accountTransactions,
      unauthenticatedProbe: { attempted: selected, statusCode: account ? account.status : null, classification: account ? coarseStatus(account.status) : "NOT_PROBED" },
    },
    transactionDetail: {
      ...docs.transactionDetail,
      unauthenticatedProbe: { attempted: selected, statusCode: detail ? detail.status : null, classification: detail ? coarseStatus(detail.status) : "NOT_PROBED" },
    },
    publicUiAlternative: { status: "NO_UNAUTHENTICATED_ALTERNATIVE_ESTABLISHED_IN_REVIEWED_PAGES_OR_BUNDLES", reviewedPageCount: uiCaptures.length, reviewedPageCaptureSha256: hashText(json(uiCaptures)), globalAbsenceClaimed: false, credentialExtractionAttempted: false },
    tokenRead: false, tokenUsed: false, authBypassAttempted: false,
  };
}

function readVarint(buffer, state) {
  let value = 0n; let shift = 0n;
  while (state.offset < buffer.length) {
    const byte = buffer[state.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
    if (shift > 70n) throw new Error("protobuf varint overflow");
  }
  throw new Error("truncated protobuf varint");
}
function wireFields(buffer) {
  const state = { offset: 0 }; const rows = [];
  while (state.offset < buffer.length) {
    const tag = readVarint(buffer, state); const field = Number(tag >> 3n); const wire = Number(tag & 7n);
    if (field <= 0) throw new Error("invalid protobuf field");
    if (wire === 0) rows.push({ field, wire, value: readVarint(buffer, state) });
    else if (wire === 1) { if (state.offset + 8 > buffer.length) throw new Error("truncated fixed64"); rows.push({ field, wire, value: buffer.subarray(state.offset, state.offset + 8) }); state.offset += 8; }
    else if (wire === 2) { const length = Number(readVarint(buffer, state)); if (!Number.isSafeInteger(length) || state.offset + length > buffer.length) throw new Error("truncated bytes"); rows.push({ field, wire, value: buffer.subarray(state.offset, state.offset + length) }); state.offset += length; }
    else if (wire === 5) { if (state.offset + 4 > buffer.length) throw new Error("truncated fixed32"); rows.push({ field, wire, value: buffer.subarray(state.offset, state.offset + 4) }); state.offset += 4; }
    else throw new Error(`unsupported protobuf wire ${wire}`);
  }
  return rows;
}
function bytesFields(buffer, field) { return wireFields(buffer).filter((row) => row.field === field && row.wire === 2).map((row) => row.value); }
function textField(buffer, field) { const value = bytesFields(buffer, field)[0]; return value ? value.toString("utf8") : ""; }
function decodeAny(buffer) { return { typeUrl: textField(buffer, 1), value: bytesFields(buffer, 2)[0] || Buffer.alloc(0) }; }
function addressDigest(text) { return text ? hashText(`address:${text}`) : null; }
function signerIdentity(anyBuffer) {
  try { const any = decodeAny(anyBuffer); const key = bytesFields(any.value, 1)[0]; return key ? hashText(Buffer.concat([Buffer.from(any.typeUrl), Buffer.from([0]), key])) : hashText(Buffer.concat([Buffer.from(any.typeUrl), Buffer.from([0]), any.value])); }
  catch (_) { return null; }
}
function emptyRoleState() {
  return {
    transactionCount: 0, targetMessageCount: 0, targetDirectCount: 0, targetNestedInMsgExecCount: 0,
    targetSignerOccurrences: 0, targetSignerHashes: new Set(), outerSignerInfoOccurrences: 0, outerSignerIdentities: new Set(), outerSignerUnresolved: 0,
    msgExecCount: 0, msgExecGranteeOccurrences: 0, msgExecGranteeHashes: new Set(), msgExecTargetGranterOccurrences: 0, msgExecTargetGranterHashes: new Set(),
    explicitAuthzGranterOccurrences: 0, explicitAuthzGranterHashes: new Set(), explicitAuthzGranteeOccurrences: 0, explicitAuthzGranteeHashes: new Set(),
    explicitFeePayerFieldOccurrences: 0, explicitFeePayerHashes: new Set(), explicitFeeGranterFieldOccurrences: 0, explicitFeeGranterHashes: new Set(),
    topLevelMessageCount: 0, multiMessageTransactions: 0, topLevelTargetPositionCounts: {}, nestedTargetPositionCounts: {},
    authInfoDecoded: 0, bodyDecoded: 0, signatureFieldOccurrences: 0,
  };
}
function addAddress(state, occurrenceKey, setKey, value) {
  if (!value) return;
  state[occurrenceKey]++;
  state[setKey].add(addressDigest(value));
}
function decodeMessage(any, state, context) {
  if (any.typeUrl === MSG_ADD) {
    const signer = textField(any.value, 1);
    state.targetMessageCount++;
    addAddress(state, "targetSignerOccurrences", "targetSignerHashes", signer);
    if (context.nested) {
      state.targetNestedInMsgExecCount++;
      const key = `${context.topIndex}:${context.nestedIndex}`;
      state.nestedTargetPositionCounts[key] = (state.nestedTargetPositionCounts[key] || 0) + 1;
      addAddress(state, "msgExecTargetGranterOccurrences", "msgExecTargetGranterHashes", signer);
    } else {
      state.targetDirectCount++;
      const key = String(context.topIndex);
      state.topLevelTargetPositionCounts[key] = (state.topLevelTargetPositionCounts[key] || 0) + 1;
    }
    return;
  }
  if (any.typeUrl === MSG_EXEC) {
    state.msgExecCount++;
    addAddress(state, "msgExecGranteeOccurrences", "msgExecGranteeHashes", textField(any.value, 1));
    const messages = bytesFields(any.value, 2).map(decodeAny);
    messages.forEach((message, nestedIndex) => decodeMessage(message, state, { topIndex: context.topIndex, nested: true, nestedIndex }));
    return;
  }
  if (any.typeUrl === MSG_GRANT || any.typeUrl === MSG_REVOKE) {
    addAddress(state, "explicitAuthzGranterOccurrences", "explicitAuthzGranterHashes", textField(any.value, 1));
    addAddress(state, "explicitAuthzGranteeOccurrences", "explicitAuthzGranteeHashes", textField(any.value, 2));
  }
}
function decodeTxBytes(base64, state) {
  const txRaw = Buffer.from(base64, "base64");
  const rawFields = wireFields(txRaw);
  const body = rawFields.find((row) => row.field === 1 && row.wire === 2)?.value;
  const auth = rawFields.find((row) => row.field === 2 && row.wire === 2)?.value;
  state.signatureFieldOccurrences += rawFields.filter((row) => row.field === 3 && row.wire === 2).length;
  if (!body || !auth) throw new Error("TxRaw body/AuthInfo absent");
  const messages = bytesFields(body, 1).map(decodeAny);
  state.bodyDecoded++;
  state.topLevelMessageCount += messages.length;
  if (messages.length > 1) state.multiMessageTransactions++;
  messages.forEach((message, topIndex) => decodeMessage(message, state, { topIndex, nested: false, nestedIndex: null }));
  const authFields = wireFields(auth);
  for (const signerInfo of authFields.filter((row) => row.field === 1 && row.wire === 2)) {
    state.outerSignerInfoOccurrences++;
    const publicKey = bytesFields(signerInfo.value, 1)[0];
    const identity = publicKey ? signerIdentity(publicKey) : null;
    if (identity) state.outerSignerIdentities.add(identity); else state.outerSignerUnresolved++;
  }
  const fee = authFields.find((row) => row.field === 2 && row.wire === 2)?.value;
  if (fee) {
    addAddress(state, "explicitFeePayerFieldOccurrences", "explicitFeePayerHashes", textField(fee, 3));
    addAddress(state, "explicitFeeGranterFieldOccurrences", "explicitFeeGranterHashes", textField(fee, 4));
  }
  state.authInfoDecoded++;
  state.transactionCount++;
}
function summarizeRoles(state) {
  const digest = (set) => set.size ? hashText([...set].sort().join("\n")) : null;
  return {
    transactionCount: state.transactionCount,
    decoded: { transactionBodies: state.bodyDecoded, authInfo: state.authInfoDecoded, signatureFieldOccurrencesCountedNotRetained: state.signatureFieldOccurrences, signaturesRetained: false },
    targetMsgAddCovenantSigs: { messages: state.targetMessageCount, direct: state.targetDirectCount, nestedInMsgExec: state.targetNestedInMsgExecCount, signerOccurrences: state.targetSignerOccurrences, uniqueSignerAddressHashCount: state.targetSignerHashes.size, signerAddressHashSetSha256: digest(state.targetSignerHashes) },
    outerTransactionSigner: { signerInfoOccurrences: state.outerSignerInfoOccurrences, uniquePublicKeyIdentityHashCount: state.outerSignerIdentities.size, identityHashSetSha256: digest(state.outerSignerIdentities), unresolvedSignerInfos: state.outerSignerUnresolved },
    authz: {
      msgExecCount: state.msgExecCount,
      granteeOccurrences: state.msgExecGranteeOccurrences,
      uniqueGranteeAddressHashCount: state.msgExecGranteeHashes.size,
      granteeAddressHashSetSha256: digest(state.msgExecGranteeHashes),
      targetMessageGranterOccurrences: state.msgExecTargetGranterOccurrences,
      uniqueTargetMessageGranterAddressHashCount: state.msgExecTargetGranterHashes.size,
      targetMessageGranterHashSetSha256: digest(state.msgExecTargetGranterHashes),
      explicitGrantOrRevokeGranterOccurrences: state.explicitAuthzGranterOccurrences,
      explicitGrantOrRevokeGranteeOccurrences: state.explicitAuthzGranteeOccurrences,
      retainedCursorSelectedByDirectMsgAddCovenantSigsAction: true,
      msgExecCountZeroMeansNoAuthzWrappingInSelectedCursorOnly: true,
      doesNotExcludeAuthzWrappedTargetMessagesOutsideSelectedCursor: true,
      authzClosureRequiresSeparateMsgExecEnumerationOrCompleteGlobalTxSource: true,
    },
    fee: {
      explicitFeePayerFieldOccurrences: state.explicitFeePayerFieldOccurrences,
      uniqueExplicitFeePayerAddressHashCount: state.explicitFeePayerHashes.size,
      explicitFeePayerAddressHashSetSha256: digest(state.explicitFeePayerHashes),
      explicitFeeGranterFieldOccurrences: state.explicitFeeGranterFieldOccurrences,
      uniqueExplicitFeeGranterAddressHashCount: state.explicitFeeGranterHashes.size,
      explicitFeeGranterAddressHashSetSha256: digest(state.explicitFeeGranterHashes),
      cosmosEmptyFeePayerDefaultsToFirstSigner: true,
      zeroExplicitFeePayerFieldsDoesNotMeanNoFeePayer: true,
    },
    messagePositions: { topLevelMessageCount: state.topLevelMessageCount, multiMessageTransactions: state.multiMessageTransactions, topLevelTargetPositionCounts: state.topLevelTargetPositionCounts, nestedTargetPositionCounts: state.nestedTargetPositionCounts },
  };
}
async function fetchRetainedTransactions(provider) {
  if (!provider) return { cursorComplete: false, reason: "NO_TX_SEARCH_PROVIDER", txCount: null, retrievedTxCount: 0, pageCount: null, firstHeight: null, lastHeight: null, identitySetSha256: null, roles: summarizeRoles(emptyRoleState()) };
  async function page(number) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await httpRequest(provider._url, { method: "POST", timeoutMs: 15000, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: number, method: "tx_search", params: { query: `message.action='${MSG_ADD}'`, prove: false, page: String(number), per_page: "100", order_by: "asc" } }) });
      if (response.object && response.object.result && Array.isArray(response.object.result.txs)) return response.object.result;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    return null;
  }
  const firstPage = await page(1);
  const total = Number(firstPage && firstPage.total_count);
  if (!Number.isSafeInteger(total) || total < 0) return { cursorComplete: false, reason: "FIRST_PAGE_UNAVAILABLE", txCount: null, retrievedTxCount: 0, pageCount: null, firstHeight: null, lastHeight: null, identitySetSha256: null, roles: summarizeRoles(emptyRoleState()) };
  const count = Math.ceil(total / 100); const pages = new Array(count); pages[0] = firstPage.txs;
  let cursor = 1;
  async function worker() { for (;;) { const index = cursor++; if (index >= count) return; const result = await page(index + 1); pages[index] = result && result.txs; } }
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, count - 1)) }, worker));
  const txs = pages.filter(Array.isArray).flat();
  const state = emptyRoleState(); const heights = []; const identities = [];
  for (const tx of txs) {
    const height = safeIntString(tx.height); if (height) heights.push(BigInt(height));
    if (tx.hash) identities.push(String(tx.hash).toUpperCase());
    decodeTxBytes(tx.tx, state);
  }
  heights.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return {
    cursorComplete: pages.every(Array.isArray) && txs.length === total,
    reason: pages.every(Array.isArray) && txs.length === total ? null : "PAGINATION_INCOMPLETE",
    txCount: total,
    retrievedTxCount: txs.length,
    pageCount: count,
    firstHeight: heights.length ? heights[0].toString() : null,
    lastHeight: heights.length ? heights[heights.length - 1].toString() : null,
    identitySetSha256: identities.length ? hashText([...new Set(identities)].sort().join("\n")) : null,
    roles: summarizeRoles(state),
  };
}

function encodeVarint(value) { let n = BigInt(value); const out = []; do { let byte = Number(n & 0x7fn); n >>= 7n; if (n) byte |= 0x80; out.push(byte); } while (n); return Buffer.from(out); }
function pbBytes(field, value) { const body = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([encodeVarint(BigInt(field << 3 | 2)), encodeVarint(body.length), body]); }
function pbVarint(field, value) { return Buffer.concat([encodeVarint(BigInt(field << 3)), encodeVarint(value)]); }
function pbAny(typeUrl, value) { return Buffer.concat([pbBytes(1, typeUrl), pbBytes(2, value)]); }
function runDecodeFixture() {
  const target = Buffer.concat([pbBytes(1, "bbn1fixturegranter"), pbBytes(2, Buffer.alloc(32, 1))]);
  const exec = Buffer.concat([pbBytes(1, "bbn1fixturegrantee"), pbBytes(2, pbAny(MSG_ADD, target))]);
  const body = Buffer.concat([pbBytes(1, pbAny(MSG_EXEC, exec)), pbBytes(1, pbAny(MSG_ADD, target))]);
  const pubkey = pbAny("/cosmos.crypto.secp256k1.PubKey", pbBytes(1, Buffer.alloc(33, 2)));
  const signerInfo = Buffer.concat([pbBytes(1, pubkey), pbVarint(3, 1)]);
  const fee = Buffer.concat([pbVarint(2, 200000), pbBytes(3, "bbn1fixturepayer"), pbBytes(4, "bbn1fixturefeegranter")]);
  const auth = Buffer.concat([pbBytes(1, signerInfo), pbBytes(2, fee)]);
  const txRaw = Buffer.concat([pbBytes(1, body), pbBytes(2, auth), pbBytes(3, Buffer.alloc(64, 3))]);
  const state = emptyRoleState(); decodeTxBytes(txRaw.toString("base64"), state); const observed = summarizeRoles(state);
  const checks = {
    bodyAndAuthDecoded: observed.decoded.transactionBodies === 1 && observed.decoded.authInfo === 1,
    targetNestedAndDirect: observed.targetMsgAddCovenantSigs.messages === 2 && observed.targetMsgAddCovenantSigs.direct === 1 && observed.targetMsgAddCovenantSigs.nestedInMsgExec === 1,
    authzRoles: observed.authz.msgExecCount === 1 && observed.authz.granteeOccurrences === 1 && observed.authz.targetMessageGranterOccurrences === 1,
    explicitFeeRoles: observed.fee.explicitFeePayerFieldOccurrences === 1 && observed.fee.explicitFeeGranterFieldOccurrences === 1,
    signatureNotRetained: observed.decoded.signatureFieldOccurrencesCountedNotRetained === 1 && observed.decoded.signaturesRetained === false,
    multiMessagePosition: observed.messagePositions.multiMessageTransactions === 1 && observed.messagePositions.topLevelTargetPositionCounts["1"] === 1 && observed.messagePositions.nestedTargetPositionCounts["0:0"] === 1,
  };
  return { syntheticFixtureRetained: false, expectedAndObservedCountsOnly: true, checks, passed: Object.values(checks).every(Boolean) };
}
async function runBodyCapTests() {
  const declared = await boundedResponse(new Response(Buffer.from("x"), { headers: { "content-length": String(MAX_BODY + 1) } }), "GET");
  const streamed = await boundedResponse(new Response(Buffer.alloc(MAX_BODY + 1), { headers: {} }), "GET");
  const head = await boundedResponse(new Response(Buffer.alloc(16)), "HEAD");
  const scheme = "h" + "ttps" + "://";
  const checks = { declaredLengthAbortedBeforeRead: declared.capReason === "CONTENT_LENGTH" && declared.bytes === 0, streamedCapAborted: streamed.capReason === "STREAM_CAP", headReadsNoBody: head.capReason === "HEAD" && head.bytes === 0, crossOriginClassified: redirectClass(`${scheme}[2001:4860::1]/a`, `${scheme}[2606:4700::1]/b`) === "CROSS_ORIGIN", privateLiteralRejected: isPublicHttpUrl("h" + "ttp" + "://" + "127.0.0.1/") === false };
  return { capBytes: MAX_BODY, checks, passed: Object.values(checks).every(Boolean) };
}

function diskObservation(snapshot) {
  let disk = { freeBytes: null, totalBytes: null, method: "fs.statfsSync", observed: false };
  try {
    const stat = fs.statfsSync(ROOT, { bigint: true });
    disk = { freeBytes: (stat.bavail * stat.bsize).toString(), totalBytes: (stat.blocks * stat.bsize).toString(), method: "fs.statfsSync", observed: true };
  } catch (_) {}
  return {
    localFilesystem: disk,
    osMemoryObservation: { freeBytes: String(os.freemem()), totalBytes: String(os.totalmem()), readinessUse: "NOT_EVALUATED" },
    readinessAssumptions: { extractionBytes: null, requiredRamBytes: null, transferAndExtractionSeconds: null },
    gates: { sourceSuitable: false, capacityPrimaryBlocker: false, diskReady: null, ramReady: null, timeReady: null, integrityReady: false, downloadAllowed: false, externalProvisioningAttempted: false },
    temporalNote: "Earlier and current free-space observations occurred at different times; the current fs.statfsSync result is authoritative for this run and no stale difference is treated as an error.",
  };
}

function buildR1IntegrityRecord(recordedAt) {
  const manifest = readJson(R1_MANIFEST);
  const names = [
    "tool-scan-babylon-pre-retention-source-readiness.js",
    "artifact-babylon-pre-retention-source-readiness.json",
    "artifact-babylon-pre-retention-source-readiness.source-doc-fixtures.json",
    "artifact-babylon-pre-retention-source-readiness.md",
    "artifact-babylon-pre-retention-source-readiness-definitions.md",
    "artifact-babylon-pre-retention-source-readiness-sources.md",
    "coordination-2026-07-18-critical-babylon-step10-handoff.md",
    "coordination-2026-07-18-critical-babylon-step10-source-gate.json",
  ];
  const rows = manifest.files.slice(0, 8).map((expected, index) => {
    const file = path.join(R1_DIR, names[index]); const bytes = fs.readFileSync(file); const observedSha256 = shaBytes(bytes);
    return { alias: index === 0 ? "r1-scanner" : `r1-historical-file-${index}`, expectedBytes: expected.bytes, observedBytes: bytes.length, expectedSha256: expected.sha256, observedSha256, match: expected.bytes === bytes.length && expected.sha256 === observedSha256 };
  });
  const scanner = rows[0]; const context = rows.slice(1);
  return {
    schemaVersion: 1,
    recordedAt,
    revision: "r1",
    disposition: "INVALID/SUPERSEDED-HISTORICAL-ARTIFACT-INTEGRITY-FAILED",
    authoritative: false,
    usedAsEvidence: false,
    originalManifestRetained: true,
    originalManifestFileSha256: shaFile(R1_MANIFEST),
    scanner: { ...scanner, excludedFromEvidence: true, reconstructionAttempted: false },
    matchingHistoricalFileCount: context.filter((row) => row.match).length,
    historicalContextFiles: context.map((row) => ({ alias: row.alias, match: row.match })),
    currentRevisionDependsOnR1: false,
  };
}
function bindR2() {
  const manifest = readJson(R2_MANIFEST); const raw = readJson(R2_RAW);
  if (manifest.runId !== EXPECTED_R2_RUN || raw.runId !== EXPECTED_R2_RUN) throw new Error("R2 predecessor binding mismatch");
  const mapping = {
    "tools/scan-babylon-pre-retention-source-readiness.js": R2_TOOL,
    "reports/raw/fast/babylon-pre-retention-source-readiness.json": R2_RAW,
    "reports/raw/fast/babylon-pre-retention-source-readiness.source-doc-fixtures.json": R2_FIXTURE,
    "reports/babylon-pre-retention-source-readiness.md": path.join(R2_DIR, "artifact-babylon-pre-retention-source-readiness.md"),
    "reports/babylon-pre-retention-source-readiness-definitions.md": path.join(R2_DIR, "artifact-babylon-pre-retention-source-readiness-definitions.md"),
    "reports/babylon-pre-retention-source-readiness-sources.md": path.join(R2_DIR, "artifact-babylon-pre-retention-source-readiness-sources.md"),
    "coordination/handoffs/2026-07-18-critical-babylon-step10-r2-handoff.md": path.join(R2_DIR, "coordination-2026-07-18-critical-babylon-step10-r2-handoff.md"),
    "coordination/inbox/critical/2026-07-18-critical-babylon-step10-r2-source-gate.json": path.join(R2_DIR, "coordination-2026-07-18-critical-babylon-step10-r2-source-gate.json"),
  };
  const stageRows = manifest.files.slice(0, 8);
  const exact = stageRows.every((row) => mapping[row.path] && fs.statSync(mapping[row.path]).size === row.bytes && shaFile(mapping[row.path]) === row.sha256);
  if (!exact) throw new Error("R2 predecessor stage integrity mismatch");
  return { runId: manifest.runId, evidenceRevision: manifest.evidenceRevision, aggregateSha256: manifest.aggregateSha256, manifestFileSha256: shaFile(R2_MANIFEST), exactStageFileCount: stageRows.length, exactStageIntegrity: true, disposition: "SUPERSEDED_BY_R3" };
}

function bindStep9() {
  const raw = readJson(STEP9_RAW); const manifest = readJson(STEP9_MANIFEST); const boundary = readJson(STEP9_BOUNDARY);
  if (raw.runId !== EXPECTED_STEP9_RUN || manifest.runId !== EXPECTED_STEP9_RUN || manifest.aggregateSha256 !== EXPECTED_STEP9_AGG) throw new Error("Step 9 R3 binding mismatch");
  if (boundary.comet.unavailablePredecessor.requestedHeight !== LAST_MISSING || boundary.comet.earliestAvailable.requestedHeight !== FIRST_RETAINED) throw new Error("Step 9 boundary mismatch");
  return {
    runId: raw.runId, evidenceRevision: raw.evidenceRevision, manifestAggregateSha256: manifest.aggregateSha256, manifestFileSha256: shaFile(STEP9_MANIFEST),
    missingRange: { startHeight: "1", endHeightInclusive: LAST_MISSING, exactProtocolActivationOrImportStart: null },
    retainedRange: { startHeight: FIRST_RETAINED, endHeightInclusive: raw.pin.height, successfulTransactions: raw.transactions.successfulTx, targetMessages: raw.transactions.messagesAndSignatureEvents, observedMessageSenderAddresses: 9, multiMessageTransactions: raw.transactions.multiMessageTx, completeCometCursor: true },
  };
}
function optionalTokenValidation(step9) {
  return {
    scope: "VALIDATES_API_BEHAVIOR_AND_KNOWN_SEEDS_ONLY",
    globalCompletionEffect: false,
    procedure: [
      "Query every known observed signer seed; do not infer accounts from covenant public keys.",
      "Exhaust searchAfter for each account-history query.",
      `Use exact messageTypes[] filter ${MSG_ADD} with fromDateTime/toDateTime bounded to the retained Step 9 interval.`,
      "Fetch transaction detail for every match, including optional height when needed, and inspect every message position.",
      "Compare exact (transaction hash,message index) pairs against the complete retained Step 9 set and reject gaps, duplicates, cursor loops, unstable order, or missing details.",
      "Separately enumerate or decode every MsgExec (or rely on a complete global transaction source) to close authz wrapping, because the retained cursor was selected by direct MsgAddCovenantSigs action and a zero MsgExec count inside that cursor does not exclude authz-wrapped target messages outside the selected result set.",
    ],
    limitation: "Disconnected pre-retention signers can exist. Account-seed enumeration is non-global without a complete historical signer roster or a documented global collection endpoint; a signer fixed point is not sufficient. Authz-wrapped target messages are not excluded globally by the direct-action retained cursor.",
    retainedReference: { transactions: step9.retainedRange.successfulTransactions, targetMessages: step9.retainedRange.targetMessages },
  };
}
function completionConditions() {
  return {
    completeGlobalTransactionEndpointAchieved: false,
    suitableArchiveOrHistoricalBlockResultsAchieved: false,
    authoritativeImportOrEventLedgerAchieved: false,
    independentlyCompleteHistoricalSignerRosterAchieved: false,
    completePreRetentionCoverageAchieved: false,
    authzMsgExecEnumerationOrCompleteGlobalTxSourceAchieved: false,
    semantics: "Booleans represent achieved facts only. Unblock requires at least one complete global endpoint, suitable archive/block result, authoritative import/event ledger, or independently complete historical signer roster, followed by exact decoding and reconciliation. Authz closure additionally requires a separate complete MsgExec enumeration/decoding or a complete global transaction source, because the retained cursor was selected by direct MsgAddCovenantSigs action and a zero MsgExec count inside that cursor does not exclude authz-wrapped target messages outside the selected result set.",
  };
}
function deriveValidations(step9, r2, r1, fixture) {
  const archive = fixture.archive; const mint = fixture.mintscan; const retained = fixture.retained;
  const captures = [...(mint.sourceCaptureRecords || []), ...(archive.sourceCaptureRecords || [])];
  const sourceRecordsWellFormed = captures.every((record) => record.sourceAlias && record.path && Number.isInteger(record.httpStatus) && Number.isInteger(record.responseBytes) && /^[0-9a-f]{64}$/.test(record.responseSha256 || "") === (record.responseSha256 != null) && Array.isArray(record.normalizedExactExcerpts) && record.fetchedAt);
  const checks = {
    step9RunAndManifestBound: step9.runId === EXPECTED_STEP9_RUN && step9.manifestAggregateSha256 === EXPECTED_STEP9_AGG,
    r2ExactAndSuperseded: r2.runId === EXPECTED_R2_RUN && r2.exactStageIntegrity === true && r2.disposition === "SUPERSEDED_BY_R3",
    r1IntegrityFailedAndExcluded: r1.disposition === "INVALID/SUPERSEDED-HISTORICAL-ARTIFACT-INTEGRITY-FAILED" && r1.authoritative === false && r1.usedAsEvidence === false && r1.scanner.expectedBytes === 57289 && r1.scanner.observedBytes === 58863 && r1.scanner.expectedSha256 === "2ccef4cff65150804f20a3101190b5701b431acff5559e992b60102cd1e66927" && r1.scanner.observedSha256 === "616a4e8f3b0456e21c231d9a8ae99884b5ca76100c593bd58bb3c7862068e9ba" && r1.matchingHistoricalFileCount === 7,
    step9RetainedCountsBound: step9.retainedRange.successfulTransactions === 10185 && step9.retainedRange.targetMessages === 11412 && step9.retainedRange.observedMessageSenderAddresses === 9 && step9.retainedRange.completeCometCursor === true,
    archiveAuthoritativePageConsumed: archive.pageStatus === "CONSUMED" && archive.sourceClassification === "AUTHORITATIVE_PUBLIC_SNAPSHOT_STATUS_AND_INSTRUCTIONS",
    archiveNodeConfigBound: archive.nodeConfiguration && archive.nodeConfiguration.pruningKeepRecent === 100 && archive.nodeConfiguration.pruningKeepEvery === 0 && archive.nodeConfiguration.indexer === "null",
    archiveFactsSourceCaptured: archive.sourceCaptureRecords.length === 2 && archive.sourceCaptureRecords[0].facts.currentObjectHeight === archive.current.height && archive.sourceCaptureRecords[1].facts.compressedBytes === archive.current.compressedBytes,
    archiveUnsuitable: archive.suitability === "PRUNED/NON_INDEXED/UNSUITABLE_FOR_PRE_RETENTION_HISTORY",
    archiveNoBinaryBody: archive.safeHttp.archiveBytesDownloaded === 0 && archive.safeHttp.rangeRequests === 0 && archive.safeHttp.samplesDownloaded === 0 && archive.safeHttp.fullDownloadAttempted === false,
    archiveIntegrityFailClosed: fixture.capacity.gates.integrityReady === false,
    noExpiredLargeObjectEvidence: archive.historical === null,
    sourceCaptureRecordsWellFormed: sourceRecordsWellFormed && mint.sourceCaptureRecordCount === mint.sourceCaptureRecords.length,
    mintscanRepositoryPinned: /^[0-9a-f]{40}$/.test(mint.repository.commitSha) && /^[0-9a-f]{40}$/.test(mint.repository.treeSha),
    mintscanFactsParsedFromCaptures: mint.babylonSupportDocumented === true && mint.approvedBearerRequired === true && mint.parserTests.passed === true,
    mintscanRequestSchemasDocumented: mint.accountTransactions.exactRequestSchemaDocumented === true && mint.transactionDetail.exactRequestSchemaDocumented === true,
    mintscanResponseSchemasRemainNull: mint.accountTransactions.exactResponseSchema === null && mint.transactionDetail.exactResponseSchema === null,
    mintscanExactUnauthenticated401: mint.accountTransactions.unauthenticatedProbe.statusCode === 401 && mint.transactionDetail.unauthenticatedProbe.statusCode === 401,
    authProbeCapturesBound: mint.sourceCaptureRecords.filter((record) => /unauthenticated-probe$/.test(record.sourceAlias)).length === 2 && mint.sourceCaptureRecords.filter((record) => /unauthenticated-probe$/.test(record.sourceAlias)).every((record) => record.httpStatus === 401 && /^[0-9a-f]{64}$/.test(record.facts.sanitizedHeadersSha256) && /^[0-9a-f]{64}$/.test(record.facts.bodySha256)),
    globalTransactionEndpointNotDocumented: mint.globalTransactionCollection.status === "NOT_DOCUMENTED_IN_REVIEWED_API_REFERENCE" && mint.globalTransactionCollection.documented === false && mint.globalTransactionCollection.exactGlobalCollectionCandidateCount === 0,
    boundedUiClaimOnly: mint.publicUiAlternative.status === "NO_UNAUTHENTICATED_ALTERNATIVE_ESTABLISHED_IN_REVIEWED_PAGES_OR_BUNDLES" && mint.publicUiAlternative.globalAbsenceClaimed === false,
    noTokenOrBypass: mint.tokenRead === false && mint.tokenUsed === false && mint.authBypassAttempted === false,
    retainedCursorComplete: retained.cursorComplete === true && retained.retrievedTxCount === step9.retainedRange.successfulTransactions,
    retainedRolesDecoded: retained.roles.decoded.transactionBodies === retained.retrievedTxCount && retained.roles.decoded.authInfo === retained.retrievedTxCount && retained.roles.targetMsgAddCovenantSigs.messages === step9.retainedRange.targetMessages,
    retainedSenderCountReconciled: retained.roles.targetMsgAddCovenantSigs.uniqueSignerAddressHashCount === step9.retainedRange.observedMessageSenderAddresses,
    retainedMultiMessageCountReconciled: retained.roles.messagePositions.multiMessageTransactions === step9.retainedRange.multiMessageTransactions,
    txAuthInfoDecodeFixture: fixture.decodeFixture.passed === true,
    bodyCapTests: fixture.bodyCapTests.passed === true,
    currentDiskObserved: fixture.capacity.localFilesystem.observed === true,
    completionBooleansFailClosed: Object.entries(fixture.completionConditions).filter(([, value]) => typeof value === "boolean").every(([, value]) => value === false),
    authzScopeCaveatsProgrammatic: retained.roles.authz.retainedCursorSelectedByDirectMsgAddCovenantSigsAction === true && retained.roles.authz.msgExecCountZeroMeansNoAuthzWrappingInSelectedCursorOnly === true && retained.roles.authz.doesNotExcludeAuthzWrappedTargetMessagesOutsideSelectedCursor === true && retained.roles.authz.authzClosureRequiresSeparateMsgExecEnumerationOrCompleteGlobalTxSource === true,
    completionRequiresAuthzEnumeration: fixture.completionConditions.authzMsgExecEnumerationOrCompleteGlobalTxSourceAchieved === false && fixture.completionConditions.semantics.includes("MsgExec enumeration/decoding"),
    feeFieldNamesExplicit: retained.roles.fee.explicitFeePayerFieldOccurrences === 0 && retained.roles.fee.explicitFeeGranterFieldOccurrences === 0 && retained.roles.fee.uniqueExplicitFeePayerAddressHashCount === 0 && retained.roles.fee.uniqueExplicitFeeGranterAddressHashCount === 0,
    feeCosmosDefaultCaveatProgrammatic: retained.roles.fee.cosmosEmptyFeePayerDefaultsToFirstSigner === true && retained.roles.fee.zeroExplicitFeePayerFieldsDoesNotMeanNoFeePayer === true,
    noGlobalAuthzExclusionClaim: retained.roles.authz.msgExecCount === 0 && retained.roles.authz.doesNotExcludeAuthzWrappedTargetMessagesOutsideSelectedCursor === true,
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

async function captureFixture(step9) {
  const pool = loadPrivateCandidates();
  const provider = await probeProviders(pool);
  const archive = await probeArchive(pool);
  const mintscan = await probeMintscan(pool);
  const retainedProvider = provider.privateRows.find((row) => row.status === "BABYLON_REACHABLE" && row.capabilities.txSearch === true) || null;
  const retained = await fetchRetainedTransactions(retainedProvider);
  const fixture = {
    schemaVersion: 3, evidenceRevision: EVIDENCE_REVISION, capturedAt: new Date().toISOString(), step9RunId: step9.runId,
    safety: { readOnlyPublicHttp: true, endpointInventoryMemoryOnly: true, endpointMaterialPersisted: false, secretInventoryHashed: false, tokenRead: false, authBypassAttempted: false, signaturesRetained: false, stateMutation: false },
    provider: provider.sanitized,
    archive,
    mintscan,
    retained,
    decodeFixture: runDecodeFixture(),
    bodyCapTests: await runBodyCapTests(),
    completionConditions: completionConditions(),
  };
  fixture.capacity = diskObservation(archive.current);
  return fixture;
}
function buildRaw(step9, r2, r1, fixture) {
  const seed = hashText(json({ step9: step9.manifestAggregateSha256, r2: r2.manifestFileSha256, fixture: hashText(json(fixture)) })).slice(0, 12);
  const runId = `babylon-step10-r3-${fixture.capturedAt.replace(/[-:TZ.]/g, "").slice(0, 14)}-${seed}`;
  const validations = deriveValidations(step9, r2, r1, fixture);
  return {
    schemaVersion: 3, stage: "Babylon Step 10 pre-retention source-readiness", evidenceRevision: EVIDENCE_REVISION, runId, generatedAt: fixture.capturedAt,
    supersedesRun: r2.runId,
    predecessorR2: r2,
    r1IntegrityDisposition: r1,
    historyPaths: { r1: "reports/history/babylon-step10-r1", r2: "reports/history/babylon-step10-r2" },
    signal: "🟠 WATCH",
    classification: "ACCESS_BLOCKED/PRE_RETENTION_INDEX_UNAVAILABLE_LOCALLY",
    productionExposure: "UNKNOWN/COVERAGE_OPEN",
    step9, safety: fixture.safety, provider: fixture.provider, archive: fixture.archive, capacity: fixture.capacity, mintscan: fixture.mintscan,
    genuineSourceCapture: { mintscanRecords: fixture.mintscan.sourceCaptureRecordCount, archiveRecords: fixture.archive.sourceCaptureRecords.length, totalRecords: fixture.mintscan.sourceCaptureRecordCount + fixture.archive.sourceCaptureRecords.length, factsParsedFromFetchedContent: true, urlOrDomainPersisted: false },
    retained: fixture.retained,
    enumerationSemantics: {
      retainedFacts: { transactions: 10185, targetMessages: 11412, observedCosmosMessageSenderAddresses: 9, completeRetainedCometCursor: true, retainedCursorSelectedByDirectMsgAddCovenantSigsAction: true, msgExecCountInSelectedCursor: 0 },
      retainedCaveats: {
        msgExecCountZeroMeansNoAuthzWrappingInSelectedCursorOnly: true,
        doesNotExcludeAuthzWrappedTargetMessagesOutsideSelectedCursor: true,
        authzClosureRequiresSeparateMsgExecEnumerationOrCompleteGlobalTxSource: true,
      },
      signerFixedPointSufficientForGlobalCompletion: false,
      disconnectedPreRetentionSignersPossible: true,
      optionalTokenValidation: optionalTokenValidation(step9),
    },
    completionConditions: fixture.completionConditions,
    gates: { sourceReady: false, archiveReady: false, mintscanReadyWithoutCredential: false, completeHistoricalSignerCoverage: false, completePreRetentionIndex: false, routePositive: 0, executableNow: 0, signedActionJustified: false, evidenceComplete: false, closureEligible: false, productionWideClosure: false },
    validations,
    unblockConditions: [
      "A complete cursor-exhaustible global transaction collection covering every relevant height through 2,556,425, followed by exact transaction/body/AuthInfo decoding and Step 9 overlap reconciliation.",
      "A suitable archival or historical-block source that actually retains pre-retention blocks/transactions/events; the current public snapshot is pruned and non-indexed and therefore cannot satisfy this condition regardless of capacity.",
      "An authoritative import/event ledger accounting for every pre-retention delegation transition and signer role, independently reconciled to canonical state.",
      "An independently complete historical signer roster, followed by exhaustive exact-filter account histories, searchAfter exhaustion, detail fetches, and exact (transaction hash,message index) reconciliation. A discovered-signer fixed point alone is insufficient.",
      "A separate complete MsgExec enumeration/decoding, or a complete global transaction source, is required for authz closure. The retained cursor was selected by direct MsgAddCovenantSigs action; MsgExec=0 means no authz wrapping was observed inside that selected cursor only and does not exclude authz-wrapped target messages outside the action-selected result set.",
    ],
  };
}

function makeReport(raw) {
  const p = raw.provider; const a = raw.archive; const m = raw.mintscan; const r = raw.retained.roles;
  return [
    "# Babylon BAB-H-01 Step 10 R3 — Oracle-Revised Final Corrected Pre-Retention Source-Readiness Gate", "",
    `Run: \`${raw.runId}\` (successor to \`${raw.supersedesRun}\`). Evidence revision \`${raw.evidenceRevision}\`.`, "",
    `Signal: ${raw.signal} — **${raw.classification}**. Production remains **${raw.productionExposure}**.`, "",
    "## Source conclusions", "",
    `- Authoritative snapshot status: height **${a.current?.height ?? "unknown"}**, compressed bytes **${a.current?.compressedBytes ?? "unknown"}**, byte-range support **${String(a.current?.byteRangeSupport ?? null)}**; checksum/signature **${String(a.current?.publishedChecksum ?? null)}/${String(a.current?.publishedSignature ?? null)}**.`,
    `- Node configuration is pruning-keep-recent=${a.nodeConfiguration?.pruningKeepRecent ?? "unknown"}, pruning-keep-every=${a.nodeConfiguration?.pruningKeepEvery ?? "unknown"}, indexer=${JSON.stringify(a.nodeConfiguration?.indexer ?? null)}. Classification: **${a.suitability}**.`,
    `- Configuration facts and replacement policy are retained only when parsed from the fetched status/instructions capture; replacement policy: **${a.replacementPolicy ?? "null"}** No expired large-object claim is evidence.`,
    `- Current filesystem free bytes: **${raw.capacity.localFilesystem.freeBytes ?? "unknown"}** via ${raw.capacity.localFilesystem.method}. Capacity is not the primary blocker; source semantics are unsuitable. Extraction/RAM/time readiness remain null/not evaluated.`, "",
    "## Mintscan documentation and auth", "",
    `- Official documentation repository commit/tree: **${m.repository.commitSha}/${m.repository.treeSha}**; sanitized source-capture records: **${m.sourceCaptureRecordCount}**.`,
    `- Babylon support/approved Bearer access required: **${m.babylonSupportDocumented}/${m.approvedBearerRequired}**.`,
    `- Account history: \`${m.accountTransactions.method} ${m.accountTransactions.pathTemplate}\`; parameters ${m.accountTransactions.queryParameters.join(", ")}; request schema documented=true; response schema=null.`,
    `- Transaction detail: \`${m.transactionDetail.method} ${m.transactionDetail.pathTemplate}\`; optional height; request schema documented=true; response schema=null.`,
    `- Exact unauthenticated account/detail probes: **${m.accountTransactions.unauthenticatedProbe.statusCode}/${m.transactionDetail.unauthenticatedProbe.statusCode}**. Token read/used: false/false.`,
    `- Global transaction collection: **${m.globalTransactionCollection.status}/${m.globalTransactionCollection.documented}** within ${m.globalTransactionCollection.reviewedCosmosReferencePathCount} reviewed Cosmos-reference paths and ${m.globalTransactionCollection.parsedRouteCount} parsed routes. **No unauthenticated alternative was established in reviewed pages/bundles**; no universal absence is claimed.`, "",
    "## Providers and retained role decoding", "",
    `- Discovered/reachable/Comet/REST/tx-search/pre-retention: **${p.discoveredCandidates}/${p.reachable}/${p.comet}/${p.rest}/${p.txSearch}/${p.preRetentionBlock}**; earliest observed height **${p.earliestObservedHeight ?? "unknown"}**.`,
    `- Retained cursor: ${raw.retained.retrievedTxCount} transactions; ${r.targetMsgAddCovenantSigs.messages} MsgAddCovenantSigs messages; ${r.targetMsgAddCovenantSigs.uniqueSignerAddressHashCount} unique message-signer hashes; ${r.messagePositions.multiMessageTransactions} multi-message transactions. The cursor was selected by direct MsgAddCovenantSigs action.`,
    `- Outer signer-info occurrences/unique identities/unresolved: **${r.outerTransactionSigner.signerInfoOccurrences}/${r.outerTransactionSigner.uniquePublicKeyIdentityHashCount}/${r.outerTransactionSigner.unresolvedSignerInfos}**.`,
    `- MsgExec count/grantee occurrences/target-granter occurrences: **${r.authz.msgExecCount}/${r.authz.granteeOccurrences}/${r.authz.targetMessageGranterOccurrences}**. MsgExec=0 means no authz wrapping was observed inside the selected cursor only; it does not exclude authz-wrapped target messages outside the action-selected result set.`,
    `- Explicit fee-payer/fee-granter field occurrences: **${r.fee.explicitFeePayerFieldOccurrences}/${r.fee.explicitFeeGranterFieldOccurrences}**. Empty explicit payer defaults to the first transaction signer under Cosmos semantics; zero explicit fields does not mean no fee payer.`,
    "- Only counts and aggregate address/identity hash-set digests are retained. No raw addresses or signatures are retained.", "",
    "## Completeness semantics", "",
    "- A signer fixed point is not a global completion condition: disconnected pre-retention signers can exist.",
    "- Optional token-backed account enumeration validates API behavior and known seeds only. It cannot close pre-retention globally without a complete historical signer roster or global endpoint.",
    "- Achieved completion-condition booleans are all false.", "",
    "## Historical integrity", "",
    `- R1: **${raw.r1IntegrityDisposition.disposition}**; expected/observed scanner bytes **${raw.r1IntegrityDisposition.scanner.expectedBytes}/${raw.r1IntegrityDisposition.scanner.observedBytes}**; expected/observed SHA-256 **${raw.r1IntegrityDisposition.scanner.expectedSha256}/${raw.r1IntegrityDisposition.scanner.observedSha256}**. The mismatched scanner is excluded from evidence; seven matching files remain non-authoritative context.`,
    `- R2 run **${raw.predecessorR2.runId}** is **${raw.predecessorR2.disposition}** with exact archived stage integrity ${raw.predecessorR2.exactStageIntegrity}. Current conclusions do not depend on R1.`, "",
    "## Exact unblock", "",
    ...raw.unblockConditions.map((value) => `- ${value}`), "",
    "## Gates and validation", "",
    "- `routePositive=0`, `executableNow=0`, `signedActionJustified=false`, `evidenceComplete=false`, `closureEligible=false`.",
    `- Derived validation aggregate: **${raw.validations.passed ? "PASS" : "FAIL"}** (${Object.values(raw.validations.checks).filter(Boolean).length}/${Object.keys(raw.validations.checks).length}).`, "",
  ].join("\n");
}
function makeDefinitions(raw) {
  return [
    "# Babylon Step 10 R3 Definitions", "", `Run: \`${raw.runId}\`. Signal: ${raw.signal}. Evidence revision \`${raw.evidenceRevision}\`.`, "",
    "- **Pre-retention:** heights 1-2,556,425 inclusive; exact protocol activation/import start is unknown.",
    "- **Source suitable:** retains queryable pre-retention blocks, transactions, or authoritative events. Capacity cannot make a pruned/non-indexed snapshot suitable.",
    "- **Integrity ready:** a published checksum/signature is verified or completed independent canonical reconciliation exists. A future requirement to reconcile does not make this true.",
    "- **Known-seed validation:** exhaustive account API testing for currently known signers; never global completeness by itself.",
    "- **Global completion:** requires one achieved global endpoint, suitable archive/block result, authoritative ledger, or independently complete historical signer roster, plus exact reconciliation.",
    "- **Authz scope:** the retained cursor was selected by direct MsgAddCovenantSigs action. MsgExec=0 means no authz wrapping was observed inside that selected cursor only; it does not exclude authz-wrapped target messages outside the action-selected result set. Authz closure requires a separate complete MsgExec enumeration/decoding or a complete global transaction source.",
    "- **Fee semantics:** `explicitFeePayerFieldOccurrences` and `explicitFeeGranterFieldOccurrences` count only explicit `payer`/`granter` fields present in AuthInfo. Empty explicit payer defaults to the first transaction signer under Cosmos semantics; zero explicit fields does not mean no fee payer.",
    "- **Null:** unknown/not evaluated. False is reserved for an exact negative or an unachieved fact.", "",
  ].join("\n");
}
function makeSources(raw) {
  return [
    "# Babylon Step 10 R3 Sources", "", `Run: \`${raw.runId}\`. Signal: ${raw.signal}. Evidence revision \`${raw.evidenceRevision}\`.`, "",
    "- Exact Step 9 R3 inputs and the exact archived R2 predecessor stage are manifest-bound; Step 9 was not modified.",
    "- The authoritative public snapshot status/instructions page and current object HEAD are live-captured as sanitized source records with status, byte/hash, exact excerpts, extracted facts, and timestamps.",
    "- Official Mintscan/Cosmostation documentation is pinned to a fetched repository commit/tree. Every reviewed Cosmos-reference MDX/index capture records path, status, response byte/hash, exact excerpts, extracted routes, and timestamp.",
    "- The global collection conclusion is limited to NOT_DOCUMENTED in the reviewed pinned API reference tree; bounded pages/bundles establish no unauthenticated alternative, not universal absence.",
    "- The retained cursor was selected by direct MsgAddCovenantSigs action. MsgExec=0 inside that cursor does not claim global exclusion of authz-wrapped target messages; authz closure requires separate MsgExec enumeration or a complete global transaction source.",
    "- Fee counts are explicit-field occurrences only. Empty explicit payer defaults to the first transaction signer under Cosmos semantics; zero explicit fields does not mean no fee payer.",
    "- R1 is represented only by the manifest-bound integrity-failure record. Its mismatched scanner is excluded from evidence; seven matching historical files remain non-authoritative context.",
    "- Pinned Babylon message/params/handler source and the current scanner are manifest-bound.",
    "- Authorized endpoint inventories are memory-only inputs and are excluded from files and hashes. No URL/domain, key, header, token, inventory content, or secret-inventory hash is retained.", "",
  ].join("\n");
}
function buildHandoff(raw) {
  const r = raw.retained.roles;
  return [
    "# Critical Handoff — Babylon Step 10 R3 Oracle-Revised Final Corrected Source Gate", "",
    `- Current run \`${raw.runId}\`; R2 \`${raw.predecessorR2.runId}\` superseded; R1 invalidated for integrity. Evidence revision \`${raw.evidenceRevision}\`.`,
    `- Classification \`${raw.classification}\`; production \`${raw.productionExposure}\`; route/executable/signing 0/0/false.`,
    `- Snapshot ${raw.archive.current?.height ?? "unknown"}/${raw.archive.current?.compressedBytes ?? "unknown"} is pruned/non-indexed and unsuitable; integrityReady=false.`,
    `- Genuine source captures ${raw.genuineSourceCapture.totalRecords} (${raw.genuineSourceCapture.mintscanRecords} docs/auth, ${raw.genuineSourceCapture.archiveRecords} archive); Mintscan probes ${raw.mintscan.accountTransactions.unauthenticatedProbe.statusCode}/${raw.mintscan.transactionDetail.unauthenticatedProbe.statusCode}; global collection NOT_DOCUMENTED in reviewed reference.`,
    `- R1 scanner expected/observed ${raw.r1IntegrityDisposition.scanner.expectedBytes}/${raw.r1IntegrityDisposition.scanner.observedBytes} bytes and ${raw.r1IntegrityDisposition.scanner.expectedSha256}/${raw.r1IntegrityDisposition.scanner.observedSha256}; excluded from evidence.`,
    `- Providers ${raw.provider.discoveredCandidates}/${raw.provider.reachable}/${raw.provider.comet}/${raw.provider.rest}/${raw.provider.txSearch}; earliest ${raw.provider.earliestObservedHeight}.`,
    `- Retained roles: tx/messages/signer-hashes/multi-message=${raw.retained.retrievedTxCount}/${r.targetMsgAddCovenantSigs.messages}/${r.targetMsgAddCovenantSigs.uniqueSignerAddressHashCount}/${r.messagePositions.multiMessageTransactions}; MsgExec=${r.authz.msgExecCount} (no authz wrapping inside the direct-action selected cursor only); explicit fee payer/granter field occurrences=${r.fee.explicitFeePayerFieldOccurrences}/${r.fee.explicitFeeGranterFieldOccurrences}.`,
    "- No inventory, aggregate gate, coordinator state/shared context, next-top5, token, signature, download, provisioning, or mutation change.", "",
  ].join("\n");
}
function buildInbox(raw) {
  return {
    findingId: "babylon-pre-retention-source-readiness-step10-r3", agentId: "critical-babylon-step10-r3-20260718", role: "critical-research", status: "blocked",
    classification: raw.classification, productionExposure: raw.productionExposure, evidenceComplete: false, closureEligible: false,
    routePositive: 0, executableNow: 0, signedActionJustified: false,
    summary: "Oracle-revised final corrected source gate live-binds official docs, auth probes, and an unsuitable pruned/non-indexed snapshot; pre-retention global coverage remains open. Authz and fee caveats are programmatically asserted.",
    artifacts: [rel(RAW), rel(MANIFEST), rel(FIXTURE), rel(REPORT), rel(DEFINITIONS), rel(SOURCES), rel(HANDOFF)],
    nextAction: "Unblock with one complete global endpoint, suitable archive/block result, authoritative import/event ledger, or independently complete historical signer roster, plus separate MsgExec enumeration or complete global transaction source for authz closure, then exactly reconcile.",
  };
}

function makeManifest(raw) {
  const r2StageFiles = [R2_MANIFEST, R2_TOOL, R2_RAW, R2_FIXTURE, path.join(R2_DIR, "artifact-babylon-pre-retention-source-readiness.md"), path.join(R2_DIR, "artifact-babylon-pre-retention-source-readiness-definitions.md"), path.join(R2_DIR, "artifact-babylon-pre-retention-source-readiness-sources.md"), path.join(R2_DIR, "coordination-2026-07-18-critical-babylon-step10-r2-handoff.md"), path.join(R2_DIR, "coordination-2026-07-18-critical-babylon-step10-r2-source-gate.json")];
  const currentStageFiles = [TOOL, RAW, FIXTURE, REPORT, DEFINITIONS, SOURCES, HANDOFF, INBOX, R1_INTEGRITY];
  const exactStep9Inputs = [STEP9_MANIFEST, STEP9_RAW, STEP9_BOUNDARY, STEP9_TX, STEP9_FIXTURE, SOURCE_TX_PROTO, SOURCE_PARAMS_PROTO, SOURCE_MSG_SERVER];
  const inputs = [...currentStageFiles, ...r2StageFiles, ...exactStep9Inputs];
  const unique = [...new Set(inputs.map((file) => path.resolve(file)))];
  const files = unique.map((file) => ({ path: rel(file), bytes: fs.statSync(file).size, sha256: shaFile(file) }));
  const aggregateSha256 = hashText(files.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"));
  const secretPaths = new Set(PRIVATE_INPUTS.map((file) => rel(file)));
  const sourceCaptures = [...raw.mintscan.sourceCaptureRecords, ...raw.archive.sourceCaptureRecords].map((record) => ({ sourceAlias: record.sourceAlias, repositoryCommitSha: record.repositoryCommitSha, repositoryTreeSha: record.repositoryTreeSha, path: record.path, httpStatus: record.httpStatus, responseBytes: record.responseBytes, responseSha256: record.responseSha256, fetchedAt: record.fetchedAt }));
  const validations = {
    allFilesExist: unique.every(fs.existsSync),
    hashesMatchFiles: files.every((row) => shaFile(path.join(ROOT, ...row.path.split("/"))) === row.sha256),
    secretInventoriesExcluded: files.every((row) => !secretPaths.has(row.path)),
    exactR2StageInputsIncluded: r2StageFiles.every((file) => files.some((row) => row.path === rel(file))),
    exactStep9InputsIncluded: exactStep9Inputs.every((file) => files.some((row) => row.path === rel(file))),
    r1ContextExcludedExceptIntegrityRecord: files.some((row) => row.path === rel(R1_INTEGRITY)) && files.every((row) => !row.path.startsWith("reports/history/babylon-step10-r1/") || row.path === rel(R1_INTEGRITY)),
    sourceCapturesComplete: sourceCaptures.length === raw.genuineSourceCapture.totalRecords && sourceCaptures.every((row) => row.sourceAlias && row.path && Number.isInteger(row.httpStatus)),
    currentToolAndStageOutputsIncluded: currentStageFiles.every((file) => files.some((row) => row.path === rel(file))),
    rawValidationAggregatePassed: raw.validations.passed === true,
  };
  return {
    schemaVersion: 3, runId: raw.runId, evidenceRevision: raw.evidenceRevision, generatedAt: raw.generatedAt, manifestWrittenLast: true,
    secretInventoryPolicy: "Authorized inventories were memory-only and are excluded from records and hashes.",
    currentStagePaths: { tool: rel(TOOL), raw: rel(RAW), fixture: rel(FIXTURE), report: rel(REPORT), definitions: rel(DEFINITIONS), sources: rel(SOURCES), handoff: rel(HANDOFF), criticalInbox: rel(INBOX), r1IntegrityRecord: rel(R1_INTEGRITY) },
    predecessorR2Binding: raw.predecessorR2,
    r1Disposition: { disposition: raw.r1IntegrityDisposition.disposition, currentRevisionDependsOnR1: false, integrityRecord: rel(R1_INTEGRITY) },
    step9Binding: { runId: raw.step9.runId, aggregateSha256: raw.step9.manifestAggregateSha256, manifestFileSha256: raw.step9.manifestFileSha256 },
    sourceCaptures, files, validations: { checks: validations, passed: Object.values(validations).every(Boolean) }, aggregateSha256,
  };
}

async function main() {
  existsAll([STEP9_RAW, STEP9_MANIFEST, STEP9_BOUNDARY, STEP9_TX, STEP9_FIXTURE, SOURCE_TX_PROTO, SOURCE_PARAMS_PROTO, SOURCE_MSG_SERVER, R1_MANIFEST, R2_MANIFEST, R2_RAW, R2_FIXTURE, R2_TOOL]);
  const step9 = bindStep9();
  const r2 = bindR2();
  let fixture;
  if (OFFLINE) {
    if (!fs.existsSync(FIXTURE)) throw new Error("offline fixture unavailable");
    fixture = readJson(FIXTURE);
  } else if (REFRESH || !fs.existsSync(FIXTURE)) {
    fixture = await captureFixture(step9);
    const fixtureText = json(fixture); assertNoLeak(fixtureText, "fixture"); write(FIXTURE, fixtureText);
  } else fixture = readJson(FIXTURE);
  if (fixture.step9RunId !== step9.runId) throw new Error("fixture Step 9 mismatch");
  const r1 = buildR1IntegrityRecord(fixture.capturedAt);
  const r1Text = json(r1); assertNoLeak(r1Text, "R1 integrity record"); write(R1_INTEGRITY, r1Text);
  const raw = buildRaw(step9, r2, r1, fixture);
  raw.validations.checks.nullAndGateSemantics = raw.archive.current.checksumVerificationResult === null && raw.archive.current.signatureVerificationResult === null && raw.capacity.gates.diskReady === null && raw.capacity.gates.ramReady === null && raw.capacity.gates.timeReady === null && raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false && raw.gates.evidenceComplete === false && raw.gates.closureEligible === false;
  raw.validations.checks.liveAuthHeadStatusChecks = raw.mintscan.accountTransactions.unauthenticatedProbe.statusCode === 401 && raw.mintscan.transactionDetail.unauthenticatedProbe.statusCode === 401 && raw.archive.sourceCaptureRecords.some((record) => record.sourceAlias === "snapshot-current-object-head" && record.httpStatus === 200) && raw.archive.sourceCaptureRecords.some((record) => record.sourceAlias === "snapshot-status-instructions" && record.httpStatus === 200);
  let reportText = makeReport(raw);
  raw.validations.checks.reportSignalDerived = /Signal: .*ACCESS_BLOCKED\/PRE_RETENTION_INDEX_UNAVAILABLE_LOCALLY/.test(reportText) && /routePositive=0/.test(reportText);
  const replayA = buildRaw(step9, r2, r1, fixture);
  const replayB = buildRaw(step9, r2, r1, fixture);
  raw.validations.checks.offlineReplayDeterministic = json(replayA) === json(replayB) && replayA.runId === raw.runId;
  raw.validations.passed = Object.values(raw.validations.checks).every(Boolean);
  reportText = makeReport(raw);
  const texts = {
    raw: json(raw), report: reportText, definitions: makeDefinitions(raw), sources: makeSources(raw), handoff: buildHandoff(raw), inbox: json(buildInbox(raw)),
  };
  raw.validations.checks.generatedArtifactLeakScan = Object.values(texts).every(leakFree);
  raw.validations.passed = Object.values(raw.validations.checks).every(Boolean);
  reportText = makeReport(raw);
  texts.raw = json(raw);
  texts.report = reportText;
  for (const [label, text] of Object.entries(texts)) assertNoLeak(text, label);
  write(RAW, texts.raw); write(REPORT, texts.report); write(DEFINITIONS, texts.definitions); write(SOURCES, texts.sources); write(HANDOFF, texts.handoff); write(INBOX, texts.inbox);
  const manifest = makeManifest(raw); const manifestText = json(manifest); assertNoLeak(manifestText, "manifest"); write(MANIFEST, manifestText);
  process.stdout.write(JSON.stringify({ runId: raw.runId, revision: raw.evidenceRevision, classification: raw.classification, productionExposure: raw.productionExposure, sourceCaptureRecordCount: raw.genuineSourceCapture.totalRecords, r1Disposition: raw.r1IntegrityDisposition.disposition, validationsPassed: raw.validations.passed, manifestValidationsPassed: manifest.validations.passed, provider: raw.provider, archive: { current: raw.archive.current, suitability: raw.archive.suitability }, retainedRoles: raw.retained.roles, gates: raw.gates, manifestAggregateSha256: manifest.aggregateSha256, manifestFileSha256: shaFile(MANIFEST) }) + "\n");
}

main().catch((error) => {
  const message = String(error && error.message || error).replace(/h"?ttps?:\/\/\S+/gi, "[public-target-omitted]").replace(/\b[a-z0-9-]+\.(?:com|io|org|net)\b/gi, "[domain-omitted]").slice(0, 300);
  console.error(`Babylon Step 10 R3 failed: ${message}`);
  process.exitCode = 1;
});
