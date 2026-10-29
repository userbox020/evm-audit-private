#!/usr/bin/env node
"use strict";

// User-authorized bounded defensive read-only qualification. All endpoint and
// response material remains process-memory only. Emitted data is anonymous.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WebSocket = require("./node_modules/ws");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-authorized-endpoint-capability-qualification-r1";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const LEAK = `reports/raw/fast/${NAME}-leak-scan.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const MATRIX = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-r2-corrected-historical-matrix.json";
const PRIOR_R14 = "reports/raw/fast/critical-etherfi-hyperevm-state-canary-r14-r3.json";
const PRIOR_R14_MANIFEST = "reports/raw/fast/critical-etherfi-hyperevm-state-canary-r14-r3-manifest.json";
const PRIOR_COVERAGE = "reports/raw/fast/critical-etherfi-behype-endpoint-coverage-repair.json";
const PRIOR_COVERAGE_MANIFEST = "reports/raw/fast/critical-etherfi-behype-endpoint-coverage-repair-manifest.json";
const INVENTORIES = ["graphql_endpoints.txt", "base_full_stack_endpoints.md", "hyperevm_archive_endpoints.md", "rpc_endpoints.txt"];
const OWNED = [SCANNER, VALIDATOR, RAW, LEAK, MANIFEST, REPORT, INBOX, HANDOFF];
const CLASSIFICATION = "INFORMATIONAL/READ-ONLY-ENDPOINT-CAPABILITY-QUALIFICATION/SANITIZED/FAIL-CLOSED/NO-EXECUTION";
const AGENT = "critical-endpoint-capability-qualification-20260724";
const ID_SALT = "authorized-endpoint-capability-r1-20260724";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_SLOT = `0x${"0".repeat(64)}`;
const MAX_UNIQUE_CANDIDATES = 420;
const MAX_DEEP_REPRESENTATIVES = 120;
const MAX_REQUESTS = 4200;
const MAX_REQUESTS_PER_PROVIDER = 34;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const INITIAL_CONCURRENCY = 10;
const DEEP_CONCURRENCY = 4;
const GRAPHQL_CONCURRENCY = 5;
const CANARY_CONCURRENCY = 3;
const GLOBAL_START_GAP_MS = 35;
const abs = (rel) => path.join(ROOT, rel);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (kind, value) => crypto.createHmac("sha256", ID_SALT).update(`${kind}\0${value}`).digest("hex");
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const commitment = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const quantity = (value) => typeof value === "string" && /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/i.test(value);
const dataHex = (value) => typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value);
const word = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const address = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const countBucket = (value) => value === null ? "unknown" : value === 0 ? "zero" : value <= 10 ? "one-to-ten" : value <= 100 ? "eleven-to-hundred" : value <= 1000 ? "hundred-one-to-thousand" : "over-thousand";
const latencyBucket = (ms) => ms < 500 ? "under-500ms" : ms < 1500 ? "500-1499ms" : ms < 5000 ? "1500-4999ms" : ms < 12000 ? "5-11999ms" : "12s-or-more";
const safeJson = (rel) => JSON.parse(fs.readFileSync(abs(rel), "utf8"));

function writeOwned(rel, text) {
  if (![RAW, LEAK, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error("write-refused");
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text, "utf8");
}
function verifyManifest(rel) {
  const manifest = safeJson(rel);
  for (const row of manifest.records || []) {
    const actual = hashFile(row.path);
    if (actual.bytes !== row.bytes || actual.sha256 !== row.sha256) throw new Error("predecessor-record-mismatch");
  }
  const aggregate = sha(Buffer.from((manifest.records || []).map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  if (aggregate !== manifest.aggregateSha256) throw new Error("predecessor-aggregate-mismatch");
  return manifest;
}
function cleanUrl(text) {
  let value = text.replace(/\\\//g, "/").replace(/^[(`<\[]+|[)>`,.;\]]+$/g, "");
  try { const parsed = new URL(value); return ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) ? parsed.href : null; } catch { return null; }
}
function extractUrls(text) {
  const normalized = text.replace(/\\\//g, "/");
  return [...normalized.matchAll(/(?:https?|wss?):\/\/[^\s"'`<>{}\[\]]+/gi)].map((match) => cleanUrl(match[0])).filter(Boolean);
}
function parseHeaders(context) {
  const headers = {};
  const origin = context.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1] || null;
  if (origin) headers.origin = origin;
  for (const match of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) headers[match[1].trim().toLowerCase()] = match[2].trim();
  for (const match of context.matchAll(/(?:^|[|`\s"'])(authorization|x-api-key|api-key|apikey|api_key)\s*[:=]\s*([^|`\r\n"']+)/gim)) headers[match[1].toLowerCase()] = match[2].trim();
  for (const match of context.matchAll(/(?:-H|--header)\s+["']([^:"']+)\s*:\s*([^"']+)["']/gi)) headers[match[1].trim().toLowerCase()] = match[2].trim();
  return headers;
}
function familyKey(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".").filter(Boolean);
  return parts.length <= 2 ? host : `${parts.at(-2)}.${parts.at(-1)}`;
}
function collectLabel(line, url) {
  const cells = line.split("|").map((value) => value.replace(/[`*_#()[\]<>]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const urlIndex = cells.findIndex((value) => /(?:https?|wss?):\/\//i.test(value));
  let label = urlIndex > 0 ? cells[urlIndex - 1] : line.slice(0, Math.max(0, line.indexOf(url))).replace(/[`*_#()[\]<>:=-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!label || label.length < 3 || label.length > 48 || /^[a-z]+$/i.test(label) || /\b(?:rpc|graphql|archive|trace|debug|http|endpoint|provider|base|hyper|mainnet|full stack|explorer|indexer|url|notes?)\b/i.test(label)) return null;
  return label;
}
function secretLike(value) {
  const text = String(value || "");
  return text.length >= 10 && ((/[a-z]/i.test(text) && /\d/.test(text)) || /^[0-9a-f]{12,}$/i.test(text) || text.length >= 20 && /[-_]/.test(text));
}
function parseInventories() {
  const byUrl = new Map();
  const fileStats = {};
  const secrets = { urls: new Set(), hosts: new Set(), values: new Set(), labels: new Set() };
  for (const file of INVENTORIES) {
    const body = fs.readFileSync(abs(file));
    const text = body.toString("utf8");
    const lines = text.split(/\r?\n/);
    const fileUrls = [];
    for (let index = 0; index < lines.length; index++) {
      for (const found of extractUrls(lines[index])) {
        fileUrls.push(found);
        const context = lines.slice(Math.max(0, index - 4), Math.min(lines.length, index + 5)).join("\n");
        const lower = context.toLowerCase();
        const current = byUrl.get(found) || { url: found, headers: {}, files: new Set(), roles: { rpc: false, graphql: false, rest: false, archiveDeclared: false, traceDeclared: false } };
        current.files.add(file);
        Object.assign(current.headers, parseHeaders(context));
        current.roles.graphql ||= file === "graphql_endpoints.txt" || lower.includes("graphql");
        current.roles.archiveDeclared ||= lower.includes("archive") || lower.includes("historical");
        current.roles.traceDeclared ||= lower.includes("trace") || lower.includes("debug");
        current.roles.rpc ||= file === "rpc_endpoints.txt" || file === "hyperevm_archive_endpoints.md" || lower.includes("json-rpc") || /\brpc\b/.test(lower) || current.roles.archiveDeclared || current.roles.traceDeclared;
        current.roles.rest ||= file === "base_full_stack_endpoints.md" && (lower.includes("rest") || lower.includes("api") || lower.includes("explorer") || lower.includes("indexer") || !current.roles.rpc && !current.roles.graphql);
        byUrl.set(found, current);
        const label = collectLabel(lines[index], found); if (label) secrets.labels.add(label.toLowerCase());
      }
    }
    fileStats[file] = { bytes: body.length, sha256: sha(body), lineCount: lines.length, candidateOccurrences: fileUrls.length, uniqueCandidates: new Set(fileUrls).size };
  }
  if (byUrl.size > MAX_UNIQUE_CANDIDATES) throw new Error("candidate-budget-exceeded");
  for (const row of byUrl.values()) {
    const parsed = new URL(row.url);
    secrets.urls.add(row.url); if (parsed.hostname.includes(".") || parsed.hostname.includes(":")) secrets.hosts.add(parsed.hostname.toLowerCase());
    if (parsed.username) secrets.values.add(parsed.username); if (parsed.password) secrets.values.add(parsed.password);
    for (const value of parsed.searchParams.values()) if (secretLike(value)) secrets.values.add(value);
    for (const segment of parsed.pathname.split("/")) if (secretLike(segment)) secrets.values.add(segment);
    for (const value of Object.values(row.headers)) if (String(value).length >= 6) secrets.values.add(String(value));
    row.providerId = `provider-${hmac("provider", row.url).slice(0, 16)}`;
    row.familyKey = familyKey(row.url);
    row.familyId = `family-${hmac("family", row.familyKey).slice(0, 16)}`;
    row.protocol = parsed.protocol.startsWith("ws") ? "websocket" : "http";
  }
  const rows = [...byUrl.values()].sort((a, b) => a.providerId.localeCompare(b.providerId));
  return { rows, fileStats, secrets, universeCommitment: commitment(rows.map((row) => hmac("candidate-commitment", row.url)).sort()) };
}

const budget = { requests: 0, perProvider: new Map(), lastStart: 0 };
async function paced(row) {
  if (++budget.requests > MAX_REQUESTS) throw Object.assign(new Error("budget"), { category: "request-budget-exhausted" });
  const count = (budget.perProvider.get(row.providerId) || 0) + 1;
  budget.perProvider.set(row.providerId, count);
  if (count > MAX_REQUESTS_PER_PROVIDER) throw Object.assign(new Error("budget"), { category: "provider-budget-exhausted" });
  const wait = Math.max(0, budget.lastStart + GLOBAL_START_GAP_MS - Date.now());
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  budget.lastStart = Date.now();
}
function classifyFailure(input = {}) {
  if (input.category) return input.category;
  const status = Number(input.status || 0), code = Number(input.code);
  const text = String(input.message || "").toLowerCase();
  if (status === 401 || status === 403) return "auth-or-origin-rejected";
  if (status === 429 || code === -32005 || text.includes("rate")) return "rate-limited";
  if (code === -32601 || text.includes("method not found") || text.includes("unsupported method")) return "method-unsupported";
  if (text.includes("prun") || text.includes("historical state") || text.includes("missing trie") || text.includes("state is not available")) return "historical-state-unavailable";
  if (text.includes("limit") || text.includes("too many") || text.includes("range")) return "query-limit";
  if (text.includes("abort") || text.includes("timeout")) return "timeout";
  if (status >= 500) return "http-5xx";
  if (status >= 400) return "http-4xx";
  if (text.includes("json") || text.includes("parse")) return "non-json";
  if (text.includes("large")) return "response-too-large";
  return "transport-or-protocol-error";
}
async function readLimited(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw Object.assign(new Error("large"), { category: "response-too-large" });
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > MAX_BODY_BYTES) { await reader.cancel(); throw Object.assign(new Error("large"), { category: "response-too-large" }); } chunks.push(Buffer.from(value)); }
  return Buffer.concat(chunks).toString("utf8");
}
async function httpJson(row, payload, timeoutMs = 9000, method = "POST") {
  await paced(row); const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { accept: "application/json", ...row.headers };
    if (method === "POST") headers["content-type"] = "application/json";
    const response = await fetch(row.url, { method, headers, body: method === "POST" ? JSON.stringify(payload) : undefined, redirect: "follow", signal: controller.signal });
    const text = await readLimited(response); const latency = latencyBucket(Date.now() - started);
    if (!response.ok) return { ok: false, category: classifyFailure({ status: response.status }), latency };
    let json; try { json = text ? JSON.parse(text) : null; } catch { return { ok: false, category: "non-json", latency }; }
    return { ok: true, json, latency, responseCommitment: sha(Buffer.from(text)) };
  } catch (error) { return { ok: false, category: classifyFailure(error), latency: error?.name === "AbortError" ? "timeout" : latencyBucket(Date.now() - started) }; }
  finally { clearTimeout(timer); }
}
async function wsJson(row, payload, timeoutMs = 9000) {
  await paced(row); const started = Date.now();
  return new Promise((resolve) => {
    let settled = false; const done = (value) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close(); } catch {} resolve(value); };
    const timer = setTimeout(() => done({ ok: false, category: "timeout", latency: "timeout" }), timeoutMs);
    let socket; try { socket = new WebSocket(row.url, { headers: row.headers, maxPayload: MAX_BODY_BYTES, handshakeTimeout: timeoutMs }); } catch { done({ ok: false, category: "transport-or-protocol-error", latency: latencyBucket(Date.now() - started) }); return; }
    socket.once("open", () => { try { socket.send(JSON.stringify(payload)); } catch { done({ ok: false, category: "transport-or-protocol-error", latency: latencyBucket(Date.now() - started) }); } });
    socket.once("message", (data) => { if (data.length > MAX_BODY_BYTES) return done({ ok: false, category: "response-too-large", latency: latencyBucket(Date.now() - started) }); const text = data.toString(); try { done({ ok: true, json: JSON.parse(text), latency: latencyBucket(Date.now() - started), responseCommitment: sha(Buffer.from(text)) }); } catch { done({ ok: false, category: "non-json", latency: latencyBucket(Date.now() - started) }); } });
    socket.once("unexpected-response", (_, response) => done({ ok: false, category: classifyFailure({ status: response.statusCode }), latency: latencyBucket(Date.now() - started) }));
    socket.once("error", () => done({ ok: false, category: "transport-or-protocol-error", latency: latencyBucket(Date.now() - started) }));
  });
}
let rpcId = 1;
async function rpc(row, method, params = [], timeoutMs = 9000) {
  const request = { jsonrpc: "2.0", id: rpcId++, method, params };
  const response = row.protocol === "websocket" ? await wsJson(row, request, timeoutMs) : await httpJson(row, request, timeoutMs);
  if (!response.ok) return response;
  const envelope = response.json;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { ok: false, category: "response-schema-invalid", latency: response.latency };
  if (envelope.error) return { ok: false, category: classifyFailure({ code: envelope.error.code, message: envelope.error.message }), latency: response.latency };
  if (!Object.hasOwn(envelope, "result")) return { ok: false, category: "response-schema-invalid", latency: response.latency };
  return { ok: true, result: envelope.result, latency: response.latency, responseCommitment: response.responseCommitment };
}
async function rpcBatch(row, calls, timeoutMs = 10000) {
  const payload = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: rpcId++, method, params }));
  const response = row.protocol === "websocket" ? await wsJson(row, payload, timeoutMs) : await httpJson(row, payload, timeoutMs);
  if (!response.ok) return response;
  if (!Array.isArray(response.json) || response.json.length !== payload.length || response.json.some((item) => !item || item.error || !Object.hasOwn(item, "result"))) return { ok: false, category: "batch-response-invalid", latency: response.latency };
  return { ok: true, result: response.json, latency: response.latency, responseCommitment: response.responseCommitment };
}
async function parallel(items, limit, fn) {
  const out = new Array(items.length); let cursor = 0;
  async function worker() { while (true) { const index = cursor++; if (index >= items.length) return; try { out[index] = await fn(items[index], index); } catch (error) { out[index] = { internalFailure: classifyFailure(error) }; } } }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker)); return out;
}

async function initialRpc(row) {
  const output = { attempted: row.roles.rpc, chainId: null, identity: false, latest: false, finalized: false, latencyBuckets: {}, failureCategories: [] };
  const internal = {};
  if (!row.roles.rpc) return { output, internal };
  const chain = await rpc(row, "eth_chainId"); output.latencyBuckets.chainIdentity = chain.latency;
  if (!chain.ok || !quantity(chain.result)) { output.failureCategories.push(chain.ok ? "chain-id-schema-invalid" : chain.category); return { output, internal }; }
  output.chainId = Number(BigInt(chain.result)); output.identity = true; internal.chainId = output.chainId;
  const latest = await rpc(row, "eth_getBlockByNumber", ["latest", false]); output.latencyBuckets.latest = latest.latency;
  if (latest.ok && latest.result && quantity(latest.result.number) && word(latest.result.hash)) { output.latest = true; internal.latest = latest.result; } else output.failureCategories.push(latest.ok ? "latest-header-schema-invalid" : latest.category);
  const finalized = await rpc(row, "eth_getBlockByNumber", ["finalized", false]); output.latencyBuckets.finalized = finalized.latency;
  if (finalized.ok && finalized.result && quantity(finalized.result.number) && word(finalized.result.hash)) { output.finalized = true; internal.finalized = finalized.result; } else output.failureCategories.push(finalized.ok ? "finalized-header-schema-invalid" : finalized.category);
  output.failureCategories = [...new Set(output.failureCategories.filter(Boolean))].sort();
  return { output, internal };
}
function summarizeCall(result, validator = () => true) { return { success: result.ok && validator(result.result), latencyBucket: result.latency || null, failureCategory: result.ok ? validator(result.result) ? null : "response-schema-invalid" : result.category }; }
async function deepRpc(row, initial) {
  const failures = []; const latencies = {}; const latestNumber = BigInt(initial.latest.number);
  const depth = latestNumber > 1_000_000n ? 1_000_000n : latestNumber > 100_000n ? 100_000n : latestNumber > 4n ? latestNumber / 2n : 1n;
  const fixedNumber = latestNumber > depth ? latestNumber - depth : 1n;
  const fixedTag = hex(fixedNumber);
  const historical = await rpc(row, "eth_getBlockByNumber", [fixedTag, true], 12000); latencies.historicalHeader = historical.latency;
  const historicalOk = historical.ok && historical.result && quantity(historical.result.number) && word(historical.result.hash) && Array.isArray(historical.result.transactions);
  if (!historicalOk) failures.push(historical.ok ? "historical-header-schema-invalid" : historical.category);
  const target = historicalOk ? (historical.result.transactions.find((tx) => tx && address(tx.to))?.to || ZERO_ADDRESS) : ZERO_ADDRESS;
  const fixedHash = historicalOk ? historical.result.hash : null;
  const code = await rpc(row, "eth_getCode", [target, fixedTag], 12000); latencies.historicalCode = code.latency;
  const storage = await rpc(row, "eth_getStorageAt", [target, ZERO_SLOT, fixedTag], 12000); latencies.historicalStorage = storage.latency;
  const balance = await rpc(row, "eth_getBalance", [target, fixedTag], 12000); latencies.historicalBalance = balance.latency;
  const codeOk = code.ok && dataHex(code.result), storageOk = storage.ok && word(storage.result), balanceOk = balance.ok && quantity(balance.result);
  for (const [result, valid, schema] of [[code, codeOk, "historical-code-schema-invalid"], [storage, storageOk, "historical-storage-schema-invalid"], [balance, balanceOk, "historical-balance-schema-invalid"]]) if (!valid) failures.push(result.ok ? schema : result.category);
  let eipBalance = { ok: false, category: "historical-header-unavailable" }, eipCode = eipBalance, eipStorage = eipBalance;
  if (fixedHash) {
    const blockRef = { blockHash: fixedHash, requireCanonical: true };
    eipBalance = await rpc(row, "eth_getBalance", [target, blockRef], 12000);
    eipCode = await rpc(row, "eth_getCode", [target, blockRef], 12000);
    eipStorage = await rpc(row, "eth_getStorageAt", [target, ZERO_SLOT, blockRef], 12000);
  }
  const eipBalanceOk = eipBalance.ok && quantity(eipBalance.result), eipCodeOk = eipCode.ok && dataHex(eipCode.result), eipStorageOk = eipStorage.ok && word(eipStorage.result);
  latencies.eip1898 = [eipBalance.latency, eipCode.latency, eipStorage.latency].filter(Boolean).sort().at(-1) || null;
  const oldFrom = fixedNumber > 3n ? fixedNumber - 3n : 0n, recentFrom = latestNumber > 3n ? latestNumber - 3n : 0n;
  const logRanges = [[oldFrom, oldFrom + 1n], [oldFrom + 2n, fixedNumber], [recentFrom, recentFrom + 1n], [recentFrom + 2n, latestNumber]];
  const logResults = [];
  for (const [from, to] of logRanges) logResults.push(await rpc(row, "eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to), topics: [] }], 15000));
  const oldLogsOk = logResults.slice(0, 2).every((result) => result.ok && Array.isArray(result.result));
  const recentLogsOk = logResults.slice(2).every((result) => result.ok && Array.isArray(result.result));
  const oldLogCount = oldLogsOk ? logResults.slice(0, 2).reduce((sum, result) => sum + result.result.length, 0) : null;
  const recentLogCount = recentLogsOk ? logResults.slice(2).reduce((sum, result) => sum + result.result.length, 0) : null;
  for (const result of logResults) if (!result.ok) failures.push(result.category);
  const batch = await rpcBatch(row, [["eth_chainId", []], ["eth_getBlockByNumber", [fixedTag, false]]], 12000);
  const batchOk = batch.ok;
  const latestFull = await rpc(row, "eth_getBlockByNumber", ["latest", true], 12000);
  const latestFullOk = latestFull.ok && latestFull.result && Array.isArray(latestFull.result.transactions);
  const transactionHash = latestFullOk ? latestFull.result.transactions.find((tx) => tx && word(tx.hash))?.hash || null : null;
  let receipt = { ok: false, category: "no-transaction-in-probed-block" };
  if (transactionHash) receipt = await rpc(row, "eth_getTransactionReceipt", [transactionHash], 12000);
  const receiptOk = receipt.ok && receipt.result && word(receipt.result.transactionHash);
  const blockReceipts = await rpc(row, "eth_getBlockReceipts", ["latest"], 15000);
  const blockReceiptsOk = blockReceipts.ok && Array.isArray(blockReceipts.result);
  let debug = await rpc(row, "debug_traceCall", [{ to: ZERO_ADDRESS, data: "0x" }, "latest", { tracer: "callTracer", timeout: "5s" }], 20000);
  let parity = { ok: false, category: "not-attempted-debug-succeeded" };
  if (!debug.ok) parity = await rpc(row, "trace_call", [{ to: ZERO_ADDRESS, data: "0x" }, ["trace"], "latest"], 20000);
  const traceOk = debug.ok && debug.result && typeof debug.result === "object" || parity.ok && parity.result && typeof parity.result === "object";
  if (!debug.ok && !parity.ok) failures.push(debug.category, parity.category);
  const exactValues = historicalOk && codeOk && storageOk && balanceOk ? { header: historical.result.hash, code: code.result, storage: storage.result, balance: balance.result } : null;
  const archiveReady = historicalOk && codeOk && storageOk && balanceOk && oldLogsOk;
  const forkReady = historicalOk && codeOk && storageOk && balanceOk;
  return {
    selected: true,
    historyDepthBucket: depth >= 1_000_000n ? "at-least-one-million-blocks" : depth >= 100_000n ? "at-least-one-hundred-thousand-blocks" : "bounded-half-chain",
    historicalHeader: historicalOk,
    historicalCode: codeOk,
    historicalCodeNonEmpty: codeOk && code.result !== "0x",
    historicalStorage: storageOk,
    historicalBalance: balanceOk,
    eip1898: { balance: eipBalanceOk, code: eipCodeOk, storage: eipStorageOk, complete: eipBalanceOk && eipCodeOk && eipStorageOk },
    chunkedLogs: { oldRange: oldLogsOk, recentRange: recentLogsOk, oldLogCountBucket: countBucket(oldLogCount), recentLogCountBucket: countBucket(recentLogCount) },
    batch: batchOk,
    transactionReceipt: receiptOk,
    blockReceipts: blockReceiptsOk,
    traceDebugReadOnly: traceOk,
    traceMethodClass: debug.ok ? "debug-trace-call" : parity.ok ? "parity-trace-call" : null,
    archiveReady,
    forkReady,
    exactHistoricalResultCommitment: exactValues ? commitment(exactValues) : null,
    batchResponseCommitment: batchOk ? batch.responseCommitment : null,
    failureCategories: [...new Set(failures.filter(Boolean))].sort(),
    latencyBuckets: latencies,
  };
}

async function graphqlProbe(row) {
  const output = { attempted: true, http: false, protocol: false, schema: false, basicQuery: false, indexedHeight: false, latencyBuckets: {}, failureCategories: [], commitments: {} };
  if (row.protocol !== "http") { output.failureCategories.push("websocket-graphql-not-probed"); return output; }
  const basic = await httpJson(row, { query: "query Capability { __typename }" }, 10000); output.latencyBuckets.basic = basic.latency;
  if (!basic.ok) { output.failureCategories.push(basic.category); return output; }
  output.http = true; output.protocol = basic.json && typeof basic.json === "object" && (Object.hasOwn(basic.json, "data") || Array.isArray(basic.json.errors));
  output.basicQuery = Boolean(basic.json?.data?.__typename); output.commitments.basic = basic.responseCommitment;
  const schema = await httpJson(row, { query: "query CapabilitySchema { __schema { queryType { fields { name args { name } type { kind name ofType { kind name } } } } } }" }, 12000); output.latencyBuckets.schema = schema.latency;
  if (schema.ok && Array.isArray(schema.json?.data?.__schema?.queryType?.fields)) { output.schema = true; output.commitments.schema = schema.responseCommitment; }
  else output.failureCategories.push(schema.ok ? "graphql-schema-unavailable" : schema.category);
  const meta = await httpJson(row, { query: "query CapabilityHeight { _meta { block { number } } }" }, 10000); output.latencyBuckets.indexedHeight = meta.latency;
  if (meta.ok && Number.isFinite(Number(meta.json?.data?._meta?.block?.number))) { output.indexedHeight = true; output.commitments.indexedHeight = meta.responseCommitment; }
  else output.failureCategories.push(meta.ok ? "indexed-height-unavailable" : meta.category);
  output.failureCategories = [...new Set(output.failureCategories.filter(Boolean))].sort(); return output;
}
async function restProbe(row) {
  if (row.protocol !== "http") return { attempted: false, reachable: false, json: false, latencyBucket: null, failureCategory: "websocket-rest-not-applicable" };
  const response = await httpJson(row, null, 10000, "GET");
  return { attempted: true, reachable: response.ok, json: response.ok && response.json !== null, latencyBucket: response.latency || null, failureCategory: response.ok ? null : response.category, responseCommitment: response.ok ? response.responseCommitment : null };
}

function canaryCallData(row) { return `0x70a08231000000000000000000000000${row.holder.slice(2)}`; }
async function executeCanary(provider, row) {
  let result;
  if (row.method === "eth_getBalance") result = await rpc(provider, row.method, [row.account, hex(row.blockNumber)], 12000);
  else if (row.method === "eth_getCode") result = await rpc(provider, row.method, [row.contract, hex(row.blockNumber)], 12000);
  else if (row.method === "eth_getStorageAt") result = await rpc(provider, row.method, [row.contract, row.storageKey, hex(row.blockNumber)], 12000);
  else if (row.method === "eth_call") result = await rpc(provider, row.method, [{ to: row.contract, data: canaryCallData(row) }, hex(row.blockNumber)], 12000);
  else return { id: row.id, method: row.method, pass: false, category: "method-not-allowlisted", actual: null };
  if (!result.ok) return { id: row.id, method: row.method, pass: false, category: result.category, actual: null };
  const actual = String(result.result).toLowerCase(); let pass = false, category = "exact-value-mismatch";
  if (row.method === "eth_getBalance") { pass = quantity(actual) && actual === row.expectedQuantity; category = pass ? "pass-exact-quantity" : quantity(actual) ? category : "quantity-schema-invalid"; }
  else if (row.method === "eth_getCode") { pass = dataHex(actual) && (Object.hasOwn(row, "expectedData") ? actual === row.expectedData : row.expectedPredicate === "non-empty" && actual !== "0x"); category = pass ? Object.hasOwn(row, "expectedData") ? "pass-exact-data" : "pass-non-empty-predicate" : dataHex(actual) ? category : "data-schema-invalid"; }
  else { pass = word(actual) && actual === row.expectedWord; category = pass ? row.method === "eth_call" ? "pass-exact-word" : "pass-exact-word" : word(actual) ? category : "word-schema-invalid"; }
  return { id: row.id, method: row.method, pass, category, actual };
}
async function hyperProbe(provider, initial, matrix) {
  const header = await rpc(provider, "eth_getBlockByNumber", ["0x1", false], 12000);
  const selectedHeaderMatched = header.ok && header.result && header.result.hash?.toLowerCase() === matrix.block1SelectedHeader.consensusDerivedBlockHash;
  if (!selectedHeaderMatched) return { providerId: provider.providerId, familyId: provider.familyId, selectedHeaderMatched: false, selectedHeaderCategory: header.ok ? "selected-header-mismatch-or-schema" : header.category, allEightAttempted: false, allEightPassed: false, matrixResultCommitment: null, canaries: [] };
  const observed = [];
  for (const row of matrix.stateCanaries) observed.push(await executeCanary(provider, row));
  const storage = new Map(observed.map((row) => [row.id, row]));
  for (const expected of matrix.stateCanaries.filter((row) => row.mustMatchStorage)) {
    const call = observed.find((row) => row.id === expected.id), reference = storage.get(expected.storageReferenceId);
    if (!reference || !call || reference.actual !== call.actual) { if (call) { call.pass = false; call.category = "storage-reference-mismatch"; } }
  }
  const allEightPassed = observed.length === 8 && observed.every((row) => row.pass);
  const matrixResultCommitment = allEightPassed ? commitment({ matrixDigest: matrix.matrixDigest, header: matrix.block1SelectedHeader.consensusDerivedBlockHash, results: observed.map((row) => ({ id: row.id, method: row.method, actual: row.actual })) }) : null;
  return { providerId: provider.providerId, familyId: provider.familyId, selectedHeaderMatched: true, selectedHeaderCategory: "selected-header-exact", allEightAttempted: true, allEightPassed, matrixResultCommitment, canaries: observed.map((row) => ({ id: row.id, method: row.method, pass: row.pass, category: row.category })) };
}

function capabilityFamilies(providerRows, predicate) { return new Set(providerRows.filter(predicate).map((row) => row.familyId)).size; }
function failureSummary(providerRows) {
  const counts = {};
  function add(values) { for (const value of values || []) counts[value] = (counts[value] || 0) + 1; }
  for (const row of providerRows) { add(row.rpc.failureCategories); add(row.deep?.failureCategories); add(row.graphql?.failureCategories); if (row.rest?.failureCategory) add([row.rest.failureCategory]); add(row.hyper?.canaries?.filter((x) => !x.pass).map((x) => x.category)); }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
function latencySummary(providerRows) {
  const counts = {};
  function add(value) { if (value) counts[value] = (counts[value] || 0) + 1; }
  for (const row of providerRows) { for (const value of Object.values(row.rpc.latencyBuckets || {})) add(value); for (const value of Object.values(row.deep?.latencyBuckets || {})) add(value); for (const value of Object.values(row.graphql?.latencyBuckets || {})) add(value); add(row.rest?.latencyBucket); }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
function report(raw) {
  const fileRows = Object.entries(raw.inventory.files).map(([file, row]) => `| ${file} | ${row.candidateOccurrences} | ${row.uniqueCandidates} |`).join("\n");
  const chainRows = raw.chainCapabilities.map((row) => `| ${row.chainId} | ${row.providerCount} | ${row.familyCount} | ${row.deepQualifiedFamilyCount} | ${row.archiveReadyFamilyCount} | ${row.forkReadyFamilyCount} | ${row.oldLogsFamilyCount} | ${row.traceFamilyCount} |`).join("\n");
  const blockers = Object.entries(raw.failureCategories).slice(0, 12).map(([category, count]) => `| ${category} | ${count} |`).join("\n") || "| none | 0 |";
  return `# Endpoint capability qualification — sanitized read-only R1\n\n**Signal:** ⚪ CAPABILITY MAP — not exploit evidence or protocol finality.  \n**Classification:** \`${raw.classification}\`\n\n## Inventory\n\n| Authorized file | Candidate occurrences | Unique candidates |\n|---|---:|---:|\n${fileRows}\n\nUnique candidates across all files: **${raw.inventory.uniqueCandidates}**; anonymous families: **${raw.inventory.anonymousFamilyCount}**. Inventories were parsed in memory. Only file commitments and counts were retained.\n\n## JSON-RPC capability\n\n| Chain ID | Providers | Families | Deep-qualified families | Archive-ready | Fork-ready | Old-log chunks | Trace/debug |\n|---:|---:|---:|---:|---:|---:|---:|---:|\n${chainRows}\n\nArchive/fork readiness is endpoint suitability only; no fork was created. EIP-1898, batch, fixed historical header/code/storage/balance, old/recent chunked logs, receipt/block-receipt, and read-only trace/debug capability were fail-closed.\n\n## GraphQL and Base full-stack\n\nGraphQL candidates tested=${raw.graphql.tested}; protocol/schema/basic/indexed-height families=${raw.graphql.protocolFamilyCount}/${raw.graphql.schemaFamilyCount}/${raw.graphql.basicQueryFamilyCount}/${raw.graphql.indexedHeightFamilyCount}. GraphQL is indexing capability only and is never treated as finality.\n\nBase inventory candidates=${raw.baseFullStack.candidates}; chain-8453 RPC families=${raw.baseFullStack.rpcFamilyCount}; archive/log/trace families=${raw.baseFullStack.archiveReadyFamilyCount}/${raw.baseFullStack.oldLogsFamilyCount}/${raw.baseFullStack.traceFamilyCount}; GraphQL protocol/indexed families=${raw.baseFullStack.graphqlProtocolFamilyCount}/${raw.baseFullStack.graphqlIndexedHeightFamilyCount}; HTTP API families=${raw.baseFullStack.httpApiFamilyCount}.\n\n## HyperEVM strict historical canaries\n\nCorrected matrix \`${raw.hyperevm.matrixDigest}\`; chain-999/header-eligible/all-eight-pass providers=${raw.hyperevm.chain999ProviderCount}/${raw.hyperevm.selectedHeaderEligibleProviderCount}/${raw.hyperevm.allEightPassProviderCount}. Assessed/strict-qualified families=${raw.hyperevm.assessedFamilyCount}/${raw.hyperevm.strictQualifiedFamilyCount}; threshold=${raw.hyperevm.threshold}; status=${raw.hyperevm.thresholdMet ? "PASS" : "NOT_MET"}. Every header-eligible endpoint in a strict family passed all eight canaries with one exact commitment. Backend/operator independence is not established. Prior behavioral exploit capture was not rerun.\n\n## Capability deltas and blockers\n\n${raw.capabilityDeltas.summary.join(" ")}\n\n| Failure category | Incidences |\n|---|---:|\n${blockers}\n\nRecommended lanes: ${raw.recommendedTargetLanes.length ? raw.recommendedTargetLanes.map((row) => `${row.lane} (chain ${row.chainId ?? "index-only"})`).join("; ") : "none beyond coverage repair"}. These are defensive review lanes, not execution authorization.\n\nSafety: ${raw.safety.totalRequests} bounded read-only requests; zero signing, transactions, broadcasts, mutations, exploit calls, fund movement, or fork creation. Leak scan=${raw.leakScan.status}.\n`;
}

function leakScan(texts, secrets) {
  const joined = texts.join("\n"); const generated = texts.slice(2).join("\n"); const lower = joined.toLowerCase(); const generatedLower = generated.toLowerCase(); const findings = [];
  if (/(?:https?|wss?):\/\//i.test(generated)) findings.push("scheme");
  const hosts = generated.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || [];
  if (hosts.some((value) => !/\.(?:json|js|md|txt|sol)$/i.test(value))) findings.push("host-shape");
  if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer)\s*[:=]\s*[^\s,}\]]+/i.test(generated)) findings.push("header-assignment");
  for (const value of [...secrets.urls, ...secrets.hosts, ...secrets.values]) if (value.length >= 6 && lower.includes(value.toLowerCase())) { findings.push("inventory-value"); break; }
  const generic = new Set(["rpc", "graphql", "archive", "trace", "base", "hyperevm", "http", "https", "provider", "endpoint", "public", "api", "mainnet"]);
  for (const value of secrets.labels) if (value.length >= 8 && !generic.has(value) && generatedLower.includes(value)) { findings.push("endpoint-label"); break; }
  return { status: findings.length ? "FAIL" : "PASS", deterministic: true, filesScanned: texts.length, findingCount: findings.length, findingCategories: [...new Set(findings)].sort() };
}

async function main() {
  for (const rel of [SCANNER, VALIDATOR, MATRIX, PRIOR_R14, PRIOR_R14_MANIFEST, PRIOR_COVERAGE, PRIOR_COVERAGE_MANIFEST, ...INVENTORIES]) if (!fs.existsSync(abs(rel))) throw new Error("required-input-missing");
  const generatedAt = new Date().toISOString();
  const matrix = safeJson(MATRIX), priorR14 = safeJson(PRIOR_R14), priorCoverage = safeJson(PRIOR_COVERAGE);
  const priorR14Manifest = verifyManifest(PRIOR_R14_MANIFEST), priorCoverageManifest = verifyManifest(PRIOR_COVERAGE_MANIFEST);
  if (matrix.stateCanaries?.length !== 8 || matrix.matrixDigest !== "d6ccd962759ff5b5b5a85afd7ca16aaa46b60b88ca00f4ab65eed36187343c99") throw new Error("corrected-matrix-invalid");
  const inventory = parseInventories();

  const initialRows = await parallel(inventory.rows, INITIAL_CONCURRENCY, async (row) => ({ row, initial: await initialRpc(row) }));
  const internalById = new Map();
  for (const item of initialRows) if (item?.row) internalById.set(item.row.providerId, item.initial);
  const rpcEligible = inventory.rows.filter((row) => internalById.get(row.providerId)?.output?.identity && internalById.get(row.providerId)?.output?.latest);
  const representatives = [];
  const groups = new Map();
  for (const row of rpcEligible) { const initial = internalById.get(row.providerId); const key = `${initial.output.chainId}|${row.familyId}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  for (const key of [...groups.keys()].sort()) representatives.push(groups.get(key).sort((a, b) => a.providerId.localeCompare(b.providerId))[0]);
  const selectedReps = representatives.slice(0, MAX_DEEP_REPRESENTATIVES);
  const deepRows = await parallel(selectedReps, DEEP_CONCURRENCY, async (row) => ({ providerId: row.providerId, result: await deepRpc(row, internalById.get(row.providerId).internal) }));
  const deepById = new Map(deepRows.filter((row) => row?.providerId).map((row) => [row.providerId, row.result]));

  const gqlCandidates = inventory.rows.filter((row) => row.roles.graphql);
  const gqlRows = await parallel(gqlCandidates, GRAPHQL_CONCURRENCY, async (row) => ({ providerId: row.providerId, result: await graphqlProbe(row) }));
  const gqlById = new Map(gqlRows.filter((row) => row?.providerId).map((row) => [row.providerId, row.result]));
  const restCandidates = inventory.rows.filter((row) => row.files.has("base_full_stack_endpoints.md") && row.roles.rest);
  const restRows = await parallel(restCandidates, GRAPHQL_CONCURRENCY, async (row) => ({ providerId: row.providerId, result: await restProbe(row) }));
  const restById = new Map(restRows.filter((row) => row?.providerId).map((row) => [row.providerId, row.result]));

  const hyperCandidates = inventory.rows.filter((row) => internalById.get(row.providerId)?.output?.chainId === 999);
  const hyperRows = await parallel(hyperCandidates, CANARY_CONCURRENCY, async (row) => ({ providerId: row.providerId, result: await hyperProbe(row, internalById.get(row.providerId).internal, matrix) }));
  const hyperById = new Map(hyperRows.filter((row) => row?.providerId).map((row) => [row.providerId, row.result]));

  const providers = inventory.rows.map((row) => {
    const initial = internalById.get(row.providerId)?.output || { attempted: row.roles.rpc, chainId: null, identity: false, latest: false, finalized: false, latencyBuckets: {}, failureCategories: ["internal-probe-failure"] };
    return canonical({ providerId: row.providerId, familyId: row.familyId, inventoryFiles: [...row.files].sort(), protocol: row.protocol, declaredCapabilities: row.roles, rpc: initial, deep: deepById.get(row.providerId) || null, graphql: gqlById.get(row.providerId) || null, rest: restById.get(row.providerId) || null, hyper: hyperById.get(row.providerId) || null });
  });

  const hyperFamilies = [...new Set(hyperCandidates.map((row) => row.familyId))].sort().map((familyId) => {
    const rows = providers.filter((row) => row.familyId === familyId && row.rpc.chainId === 999);
    const eligible = rows.filter((row) => row.hyper?.selectedHeaderMatched);
    const commitments = [...new Set(eligible.filter((row) => row.hyper.allEightPassed).map((row) => row.hyper.matrixResultCommitment))];
    const strict = eligible.length > 0 && eligible.every((row) => row.hyper.allEightPassed) && commitments.length === 1;
    return canonical({ familyId, chain999ProviderCount: rows.length, eligibleEndpointCount: eligible.length, allEightPassEndpointCount: eligible.filter((row) => row.hyper.allEightPassed).length, strictArchiveQualified: strict, assessmentStatus: eligible.length === 0 ? "not-assessed" : strict ? "strict-qualified" : "eligible-failed", matrixResultCommitment: strict ? commitments[0] : null });
  });
  const strictHyper = hyperFamilies.filter((row) => row.strictArchiveQualified);

  const chainIds = [...new Set(providers.map((row) => row.rpc.chainId).filter(Number.isInteger))].sort((a, b) => a - b);
  const chainCapabilities = chainIds.map((chainId) => {
    const rows = providers.filter((row) => row.rpc.chainId === chainId), deep = rows.filter((row) => row.deep);
    const commitmentGroups = new Map(); for (const row of deep.filter((item) => item.deep.exactHistoricalResultCommitment)) { const set = commitmentGroups.get(row.deep.exactHistoricalResultCommitment) || new Set(); set.add(row.familyId); commitmentGroups.set(row.deep.exactHistoricalResultCommitment, set); }
    return canonical({ chainId, providerCount: rows.length, familyCount: new Set(rows.map((row) => row.familyId)).size, finalizedFamilyCount: capabilityFamilies(rows, (row) => row.rpc.finalized), deepQualifiedProviderCount: deep.length, deepQualifiedFamilyCount: new Set(deep.map((row) => row.familyId)).size, historicalHeaderFamilyCount: capabilityFamilies(deep, (row) => row.deep.historicalHeader), historicalCodeFamilyCount: capabilityFamilies(deep, (row) => row.deep.historicalCode), historicalStorageFamilyCount: capabilityFamilies(deep, (row) => row.deep.historicalStorage), eip1898FamilyCount: capabilityFamilies(deep, (row) => row.deep.eip1898.complete), oldLogsFamilyCount: capabilityFamilies(deep, (row) => row.deep.chunkedLogs.oldRange), recentLogsFamilyCount: capabilityFamilies(deep, (row) => row.deep.chunkedLogs.recentRange), batchFamilyCount: capabilityFamilies(deep, (row) => row.deep.batch), receiptFamilyCount: capabilityFamilies(deep, (row) => row.deep.transactionReceipt), blockReceiptsFamilyCount: capabilityFamilies(deep, (row) => row.deep.blockReceipts), traceFamilyCount: capabilityFamilies(deep, (row) => row.deep.traceDebugReadOnly), archiveReadyFamilyCount: capabilityFamilies(deep, (row) => row.deep.archiveReady), forkReadyFamilyCount: capabilityFamilies(deep, (row) => row.deep.forkReady), largestExactHistoricalAgreementFamilyCount: Math.max(0, ...[...commitmentGroups.values()].map((set) => set.size)) });
  });
  const baseRows = providers.filter((row) => row.inventoryFiles.includes("base_full_stack_endpoints.md"));
  const baseChainRows = baseRows.filter((row) => row.rpc.chainId === 8453), baseDeep = baseChainRows.filter((row) => row.deep), baseGql = baseRows.filter((row) => row.graphql), baseRest = baseRows.filter((row) => row.rest);
  const baseFullStack = canonical({ candidates: baseRows.length, rpcProviderCount: baseChainRows.length, rpcFamilyCount: new Set(baseChainRows.map((row) => row.familyId)).size, archiveReadyFamilyCount: capabilityFamilies(baseDeep, (row) => row.deep.archiveReady), forkReadyFamilyCount: capabilityFamilies(baseDeep, (row) => row.deep.forkReady), oldLogsFamilyCount: capabilityFamilies(baseDeep, (row) => row.deep.chunkedLogs.oldRange), recentLogsFamilyCount: capabilityFamilies(baseDeep, (row) => row.deep.chunkedLogs.recentRange), traceFamilyCount: capabilityFamilies(baseDeep, (row) => row.deep.traceDebugReadOnly), batchFamilyCount: capabilityFamilies(baseDeep, (row) => row.deep.batch), receiptFamilyCount: capabilityFamilies(baseDeep, (row) => row.deep.transactionReceipt), blockReceiptsFamilyCount: capabilityFamilies(baseDeep, (row) => row.deep.blockReceipts), graphqlProtocolFamilyCount: capabilityFamilies(baseGql, (row) => row.graphql.protocol), graphqlSchemaFamilyCount: capabilityFamilies(baseGql, (row) => row.graphql.schema), graphqlIndexedHeightFamilyCount: capabilityFamilies(baseGql, (row) => row.graphql.indexedHeight), httpApiFamilyCount: capabilityFamilies(baseRest, (row) => row.rest.reachable) });
  const graphql = canonical({ tested: providers.filter((row) => row.graphql).length, httpProviderCount: providers.filter((row) => row.graphql?.http).length, protocolProviderCount: providers.filter((row) => row.graphql?.protocol).length, protocolFamilyCount: capabilityFamilies(providers, (row) => row.graphql?.protocol), schemaFamilyCount: capabilityFamilies(providers, (row) => row.graphql?.schema), basicQueryFamilyCount: capabilityFamilies(providers, (row) => row.graphql?.basicQuery), indexedHeightFamilyCount: capabilityFamilies(providers, (row) => row.graphql?.indexedHeight), finalityClaimed: false });
  const hyperevm = canonical({ matrixPath: MATRIX, matrixSha256: hashFile(MATRIX).sha256, matrixDigest: matrix.matrixDigest, stateCanaryCount: 8, chain999ProviderCount: hyperCandidates.length, familyCount: hyperFamilies.length, selectedHeaderEligibleProviderCount: providers.filter((row) => row.hyper?.selectedHeaderMatched).length, allEightPassProviderCount: providers.filter((row) => row.hyper?.allEightPassed).length, assessedFamilyCount: hyperFamilies.filter((row) => row.assessmentStatus !== "not-assessed").length, strictQualifiedFamilyCount: strictHyper.length, threshold: 3, thresholdMet: strictHyper.length >= 3, backendOperatorIndependenceClaimed: false, behavioralExploitCaptureRerun: false, families: hyperFamilies });

  const prior = canonical({ r14: { manifestAggregateSha256: priorR14Manifest.aggregateSha256, retainedCandidateCount: priorR14.strictQualification.retainedCandidateCount, totalFamilyCount: priorR14.familyAssessment.totalFamilyCount, assessedFamilyCount: priorR14.familyAssessment.assessedFamilyCount, strictQualifiedFamilyCount: priorR14.strictQualification.strictArchiveQualifiedFamilyCount }, endpointCoverage: { manifestAggregateSha256: priorCoverageManifest.aggregateSha256, graphqlCandidatesParsed: priorCoverage.inventory.graphqlCandidatesParsed, hyperevmObservedProviderFamilyGroups: priorCoverage.hyperevm.metrics.observedProviderFamilyGroups, hyperevmFullTupleConsensusProviderFamilyGroups: priorCoverage.hyperevm.metrics.fullTupleConsensusProviderFamilyGroups } });
  const deltaSummary = [
    `Current GraphQL unique inventory delta versus the prior sanitized parsed count: ${inventory.fileStats["graphql_endpoints.txt"].uniqueCandidates - prior.endpointCoverage.graphqlCandidatesParsed}.`,
    `Current strict HyperEVM family delta versus R14-r3: ${hyperevm.strictQualifiedFamilyCount - prior.r14.strictQualifiedFamilyCount}.`,
    "Base full-stack had no equivalent prior sanitized capability baseline; current qualified counts are additive coverage, not a historical endpoint-identity claim.",
  ];
  const unlocked = [];
  if (baseFullStack.archiveReadyFamilyCount) unlocked.push({ capability: "base-archive-state-and-logs", chainId: 8453, familyCount: baseFullStack.archiveReadyFamilyCount });
  if (baseFullStack.traceFamilyCount) unlocked.push({ capability: "base-read-only-trace", chainId: 8453, familyCount: baseFullStack.traceFamilyCount });
  if (graphql.indexedHeightFamilyCount) unlocked.push({ capability: "graphql-indexed-height-prefilter", chainId: null, familyCount: graphql.indexedHeightFamilyCount });
  if (hyperevm.strictQualifiedFamilyCount > prior.r14.strictQualifiedFamilyCount) unlocked.push({ capability: "additional-hyperevm-strict-historical-family", chainId: 999, familyCount: hyperevm.strictQualifiedFamilyCount - prior.r14.strictQualifiedFamilyCount });
  const lanes = [];
  const byChain = new Map(chainCapabilities.map((row) => [row.chainId, row]));
  if (byChain.get(8453)?.archiveReadyFamilyCount) lanes.push({ lane: "base-bridge-lending-and-settlement-history", chainId: 8453, reason: "archive plus chunked-log coverage" });
  if (byChain.get(8453)?.traceFamilyCount) lanes.push({ lane: "base-router-and-callback-read-only-trace", chainId: 8453, reason: "trace/debug read capability" });
  if (byChain.get(10)?.archiveReadyFamilyCount) lanes.push({ lane: "optimism-etherfi-state-and-event-binding", chainId: 10, reason: "archive and log capability" });
  if (byChain.get(1)?.archiveReadyFamilyCount) lanes.push({ lane: "ethereum-bridge-oracle-and-governance-history", chainId: 1, reason: "archive and log capability" });
  if (hyperevm.thresholdMet) lanes.push({ lane: "hyperevm-strict-state-and-deployment-binding-only", chainId: 999, reason: "strict historical canary threshold; behavioral capture remains excluded" });
  if (graphql.indexedHeightFamilyCount) lanes.push({ lane: "graphql-consumer-and-history-prefilter-only", chainId: null, reason: "indexed query capability without finality" });

  const resultBase = canonical({ schemaVersion: 1, revision: "authorized-endpoint-capability-qualification-r1", generatedAt, agentId: AGENT, role: "critical-research", classification: CLASSIFICATION, authorization: { currentTurnExplicit: true, authorizedFiles: INVENTORIES, defensiveReadOnlyOnly: true }, inventory: { files: inventory.fileStats, uniqueCandidates: inventory.rows.length, anonymousFamilyCount: new Set(inventory.rows.map((row) => row.familyId)).size, candidateUniverseCommitment: inventory.universeCommitment, rawMaterialPersisted: false }, providers, chainCapabilities, graphql, baseFullStack, hyperevm, priorSanitizedComparison: prior, capabilityDeltas: { summary: deltaSummary, newCoverageUnlocked: unlocked }, failureCategories: failureSummary(providers), latencyBuckets: latencySummary(providers), recommendedTargetLanes: lanes, blockers: { deepRepresentativeCapReached: representatives.length > selectedReps.length, untestedDeepRepresentativeCount: Math.max(0, representatives.length - selectedReps.length), strictHyperThresholdBlocked: !hyperevm.thresholdMet, graphqlNotFinality: true, backendIndependenceUnestablished: true }, gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, forkCreated: false }, safety: { inventoryFilesReadInMemory: 4, totalRequests: budget.requests, requestBudget: MAX_REQUESTS, maxRequestsPerProvider: MAX_REQUESTS_PER_PROVIDER, initialConcurrency: INITIAL_CONCURRENCY, deepConcurrency: DEEP_CONCURRENCY, graphqlConcurrency: GRAPHQL_CONCURRENCY, canaryConcurrency: CANARY_CONCURRENCY, rawUrlsPersisted: false, domainsPersisted: false, keysHeadersTokensPersisted: false, endpointLabelsPersisted: false, rawResponsesPersisted: false, signing: false, transactions: false, broadcasts: false, mutation: false, liveExploitCalls: false, fundMovement: false, forkCreated: false, behavioralExploitCaptureRerun: false }, predecessorBindings: { matrix: hashFile(MATRIX), priorR14: { raw: hashFile(PRIOR_R14), manifest: hashFile(PRIOR_R14_MANIFEST), aggregateSha256: priorR14Manifest.aggregateSha256 }, priorEndpointCoverage: { raw: hashFile(PRIOR_COVERAGE), manifest: hashFile(PRIOR_COVERAGE_MANIFEST), aggregateSha256: priorCoverageManifest.aggregateSha256 } } });
  resultBase.runId = `endpoint-capability-r1-${commitment({ inventory: resultBase.inventory, chains: chainCapabilities, graphql, baseFullStack, hyperevm, prior })}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  resultBase.leakScan = { status: "PENDING" };
  const rawDraft = JSON.stringify(resultBase, null, 2) + "\n";
  const reportDraft = report(resultBase);
  const inbox = canonical({ findingId: NAME, runId: resultBase.runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, classification: CLASSIFICATION, routePositive: 0, executableNow: 0, signedActionJustified: false, inventoryCounts: Object.fromEntries(Object.entries(inventory.fileStats).map(([file, row]) => [file, { candidateOccurrences: row.candidateOccurrences, uniqueCandidates: row.uniqueCandidates }])), chainCapabilities, graphql, baseFullStack, hyperevm: { ...hyperevm, families: undefined }, capabilityDeltas: resultBase.capabilityDeltas, blockers: resultBase.blockers, artifacts: [RAW, REPORT, MANIFEST, LEAK], nextAction: "Use only qualified anonymous capabilities for separately scoped defensive target lanes; GraphQL is prefilter-only and HyperEVM behavioral capture remains excluded." });
  const handoff = `# Authorized endpoint capability qualification R1 handoff\n\n- Four explicitly authorized inventories parsed in memory; candidates by file are retained as counts only.\n- Unique anonymous candidates/families: ${resultBase.inventory.uniqueCandidates}/${resultBase.inventory.anonymousFamilyCount}.\n- JSON-RPC chains observed: ${chainCapabilities.map((row) => `${row.chainId}:${row.providerCount}/${row.familyCount}`).join(", ") || "none"}.\n- GraphQL protocol/schema/indexed families: ${graphql.protocolFamilyCount}/${graphql.schemaFamilyCount}/${graphql.indexedHeightFamilyCount}; never finality evidence.\n- Base chain-8453 RPC/archive/log/trace families: ${baseFullStack.rpcFamilyCount}/${baseFullStack.archiveReadyFamilyCount}/${baseFullStack.oldLogsFamilyCount}/${baseFullStack.traceFamilyCount}.\n- HyperEVM strict assessed/qualified families: ${hyperevm.assessedFamilyCount}/${hyperevm.strictQualifiedFamilyCount}; corrected eight-canary matrix; prior behavioral exploit capture not rerun.\n- Requests ${budget.requests}/${MAX_REQUESTS}; zero signing, transactions, broadcasts, mutation, exploit calls, fund movement, or fork creation.\n- Validate with \`node ${VALIDATOR}\`.\n`;
  writeOwned(RAW, rawDraft); writeOwned(REPORT, reportDraft); writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n"); writeOwned(HANDOFF, handoff);
  const primaryTexts = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF].map((rel) => fs.readFileSync(abs(rel), "utf8"));
  const leak = leakScan(primaryTexts, inventory.secrets);
  if (leak.status !== "PASS") throw new Error("deterministic-leak-scan-failed");
  resultBase.leakScan = { status: "PASS", deterministic: true, artifact: LEAK, primaryFilesScanned: leak.filesScanned, findingCount: 0 };
  writeOwned(RAW, JSON.stringify(resultBase, null, 2) + "\n");
  writeOwned(REPORT, report(resultBase));
  const finalPrimary = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF].map((rel) => fs.readFileSync(abs(rel), "utf8"));
  const finalLeak = leakScan(finalPrimary, inventory.secrets); if (finalLeak.status !== "PASS") throw new Error("final-leak-scan-failed");
  const leakArtifact = canonical({ schemaVersion: 1, revision: resultBase.revision, runId: resultBase.runId, generatedAt, status: "PASS", deterministic: true, scope: "scanner-validator-raw-report-inbox-handoff", filesScanned: finalLeak.filesScanned, findingCount: 0, findingCategories: [], inventoryCommitments: Object.fromEntries(Object.entries(inventory.fileStats).map(([file, row]) => [file, row.sha256])), rawEndpointMaterialPersisted: false });
  writeOwned(LEAK, JSON.stringify(leakArtifact, null, 2) + "\n");
  const records = [SCANNER, VALIDATOR, RAW, LEAK, REPORT, INBOX, HANDOFF, MATRIX, PRIOR_R14, PRIOR_R14_MANIFEST, PRIOR_COVERAGE, PRIOR_COVERAGE_MANIFEST].map(hashFile);
  const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: resultBase.revision, runId: resultBase.runId, generatedAt, classification: CLASSIFICATION, inventoryCommitments: Object.fromEntries(Object.entries(inventory.fileStats).map(([file, row]) => [file, { bytes: row.bytes, sha256: row.sha256, candidateOccurrences: row.candidateOccurrences, uniqueCandidates: row.uniqueCandidates }])), candidateUniverseCommitment: inventory.universeCommitment, chainCapabilities, graphql, baseFullStack, hyperevm: { matrixDigest: hyperevm.matrixDigest, chain999ProviderCount: hyperevm.chain999ProviderCount, assessedFamilyCount: hyperevm.assessedFamilyCount, strictQualifiedFamilyCount: hyperevm.strictQualifiedFamilyCount, threshold: 3, thresholdMet: hyperevm.thresholdMet }, safety: resultBase.safety, leakScan: leakArtifact, gates: resultBase.gates, records, aggregateSha256 });
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  const manifestLeak = leakScan(["", "", fs.readFileSync(abs(MANIFEST), "utf8")], inventory.secrets); if (manifestLeak.status !== "PASS") throw new Error("manifest-leak-scan-failed");
  process.stdout.write(JSON.stringify({ ok: true, runId: resultBase.runId, classification: CLASSIFICATION, inventoryCandidates: Object.fromEntries(Object.entries(inventory.fileStats).map(([file, row]) => [file, { occurrences: row.candidateOccurrences, unique: row.uniqueCandidates }])), uniqueCandidates: resultBase.inventory.uniqueCandidates, chainCapabilities, graphql, baseFullStack, hyperevm: { chain999ProviderCount: hyperevm.chain999ProviderCount, assessedFamilyCount: hyperevm.assessedFamilyCount, strictQualifiedFamilyCount: hyperevm.strictQualifiedFamilyCount, thresholdMet: hyperevm.thresholdMet }, newCoverageUnlocked: unlocked, blockers: resultBase.blockers, recommendedTargetLanes: lanes, totalRequests: budget.requests, leakScan: "PASS", manifestAggregateSha256: aggregateSha256 }, null, 2) + "\n");
}

if (process.env.CAPABILITY_LEAK_ONLY === "1") {
  try {
    const inventory = parseInventories();
    const paths = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF];
    const texts = paths.map((rel) => fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), "utf8") : "");
    const result = leakScan(texts, inventory.secrets);
    const perFile = texts.map((text, index) => ({ index, findingCategories: leakScan(["", "", text], inventory.secrets).findingCategories }));
    const generated = texts.slice(2).join("\n").toLowerCase();
    const labelShapes = [...inventory.secrets.labels].filter((value) => generated.includes(value)).map((value) => ({ length: value.length, words: value.split(/\s+/).length, hasDigit: /\d/.test(value), commitment: sha(Buffer.from(value)).slice(0, 12) }));
    process.stdout.write(JSON.stringify({ status: result.status, findingCategories: result.findingCategories, perFile, labelShapes }) + "\n");
  } catch { process.stdout.write(JSON.stringify({ status: "FAIL", findingCategories: ["diagnostic-unavailable"] }) + "\n"); }
} else main().catch((error) => {
  const message = String(error?.message || "unexpected");
  const allowed = new Set(["required-input-missing", "predecessor-record-mismatch", "predecessor-aggregate-mismatch", "corrected-matrix-invalid", "candidate-budget-exceeded", "deterministic-leak-scan-failed", "final-leak-scan-failed", "manifest-leak-scan-failed"]);
  const category = allowed.has(message) ? message : `unexpected-${sha(Buffer.from(message)).slice(0, 12)}`;
  process.stderr.write(`endpoint capability qualification failed: ${category}\n`); process.exit(1);
});
