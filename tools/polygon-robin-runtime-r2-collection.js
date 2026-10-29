#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");
const { performance } = require("node:perf_hooks");
const { Interface, id, keccak256 } = require("./vendor/polygon-robin-runtime-r2-ethers.umd.min.js");
const common = require("./polygon-robin-runtime-r2-common");

const STEM = common.STEM;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const EXTENSION_SLOT = "0x1018adf3f8510fb79a0ec37a7a5650016754d9443e0fe3393d69ee144be5f600";
const ACCOUNTING_SLOT = "0x07a8aa3d7f8084dac32d7935aa186166c18da33ac7814436fe3ae78cdd22ea00";
const YIELD_SLOT = "0xd8eb9ade092aa0dc31a799bb7e00aef9dc4ce6cbdc1173946b33cbcbb48c9c00";
const POLYMARKET_SLOT = "0x996716fa23045e0aecf8c8f0b6f4eb21669555365c754469b4d4dd3e1cee6a00";
const PAUSABLE_SLOT = "0x8e24408939e53bc18e64f6e826fe4328418837db5b32e520c88d102d39b0c100";
const SIGNATURES_SLOT = "0x19e9f82ffdb8e399c53e4874d0c95cc8fb0c18c1634beccc867c55a407691b00";
const BASE_DEPLOYMENT_BLOCK = 0x5195323n;
const V2_CREATION_BLOCK = 0x538df54n;
const ZERO32 = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const CAPS = common.QUERY_CAPS;
const STATUSES = Object.freeze({
  ACTIVE: "ROBIN_RUNTIME_R2_PASS_EXACT_ACTIVE", DORMANT: "ROBIN_RUNTIME_R2_PASS_EXACT_DORMANT",
  SOURCE: "ROBIN_RUNTIME_R2_FAIL_SOURCE_OR_PACKAGE", APPROVAL: "ROBIN_RUNTIME_R2_FAIL_APPROVAL_OR_CONSUMPTION", SIDECAR_INDETERMINATE: "ROBIN_RUNTIME_R2_SIDECAR_DURABILITY_INDETERMINATE",
  CURRENT: "ROBIN_RUNTIME_R2_FAIL_CURRENT_TWO_FAMILY", ARCHIVE: "ROBIN_RUNTIME_R2_FAIL_ARCHIVE_TWO_FAMILY",
  PIN: "ROBIN_RUNTIME_R2_FAIL_COMMON_PIN", FAMILY: "ROBIN_RUNTIME_R2_FAIL_FAMILY_DISAGREEMENT",
  RUNTIME: "ROBIN_RUNTIME_R2_FAIL_RUNTIME_OR_METADATA", ENUM: "ROBIN_RUNTIME_R2_FAIL_ENUMERATION_OR_DEPENDENCY",
  VALIDATION: "ROBIN_RUNTIME_R2_FAIL_VALIDATION"
});
const ALLOWED_RPC = new Set(common.ALLOWED_RPC_METHODS);
const EVENT_TOPICS = Object.freeze([
  id("Upgraded(address)"), id("MarketInitialized(bytes32,uint256,uint256,bool)"), id("VaultAdded(address,uint256)"), id("VaultRemoved(address,uint256)"),
  id("VaultCapUpdated(address,uint256,uint256)"), id("VaultActiveUpdated(address,bool)"), id("VaultEmergencyUpdated(address,bool)"),
  id("RoleGranted(bytes32,address,address)"), id("RoleRevoked(bytes32,address,address)")
].map((x) => x.toLowerCase()));

class GateError extends Error {
  constructor(status, stage, code) { super(code); this.name = "GateError"; this.status = status; this.stage = stage; this.code = code; }
}
function fail(status, stage, code) { throw new GateError(status, stage, code); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function canonical(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) fail(STATUSES.ENUM, "LOCAL", "NON_CANONICAL_NUMBER"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") fail(STATUSES.ENUM, "LOCAL", "NON_CANONICAL_VALUE");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function same(a, b) { return canonical(a) === canonical(b); }
function hex(value, bytes = null) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || bytes !== null && value.length !== 2 + bytes * 2) fail(STATUSES.FAMILY, "DECODE", "MALFORMED_HEX");
  return value.toLowerCase();
}
function quantity(value) { if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) fail(STATUSES.FAMILY, "DECODE", "MALFORMED_QUANTITY"); return BigInt(value); }
function qhex(value) { return `0x${BigInt(value).toString(16)}`; }
function clean(value) { return JSON.parse(JSON.stringify(value, (_, x) => typeof x === "bigint" ? x.toString() : x)); }
function slotAddress(value) { const v = hex(value, 32); return `0x${v.slice(-40)}`; }
function pinArg(header) { return { blockHash: header.hash, requireCanonical: true }; }
function parseHeader(raw) {
  if (!raw || typeof raw !== "object") fail(STATUSES.PIN, "PIN", "HEADER_MALFORMED");
  return { number: quantity(raw.number), hash: hex(raw.hash, 32), stateRoot: hex(raw.stateRoot, 32), parentHash: hex(raw.parentHash, 32), timestamp: quantity(raw.timestamp) };
}
function semanticHeader(header) { return clean({ number: header.number, hash: header.hash, stateRoot: header.stateRoot, parentHash: header.parentHash, timestamp: header.timestamp }); }

function parseSafeUrl(raw) {
  let url; try { url = new URL(raw); } catch (_) { fail(STATUSES.CURRENT, "INVENTORY", "URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname || url.hostname.toLowerCase() === "localhost") fail(STATUSES.CURRENT, "INVENTORY", "URL_UNSAFE");
  const literal = url.hostname.replace(/^\[|\]$/g, ""); if (net.isIP(literal) && (literal === "::1" || literal.startsWith("127.") || literal.startsWith("10.") || literal.startsWith("192.168."))) fail(STATUSES.CURRENT, "INVENTORY", "URL_UNSAFE");
  return url;
}
const MULTI_LABEL_SUFFIXES = new Set(["co.uk", "com.au", "co.jp", "com.br", "co.in", "co.nz", "com.sg", "com.tr", "co.za"]);
const FAMILY_ALIASES = new Map([["alchemyapi.io", "alchemy.com"], ["g.alchemy.com", "alchemy.com"], ["quiknode.pro", "quicknode.com"], ["quicknode.pro", "quicknode.com"], ["blastapi.io", "blast.io"]]);
function registrableDomain(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, ""), labels = host.split(".").filter(Boolean); if (labels.length < 2 || net.isIP(host)) return host;
  const suffix2 = labels.slice(-2).join("."), count = MULTI_LABEL_SUFFIXES.has(suffix2) ? 3 : 2; return labels.slice(-count).join(".");
}
function familyKey(endpoint) { const host = new URL(endpoint).hostname.toLowerCase(), root = registrableDomain(host); return FAMILY_ALIASES.get(host) || FAMILY_ALIASES.get(root) || root; }
function mappedIpv4(ip) {
  const raw = String(ip).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]; let words;
  if (raw.includes(".")) { const at = raw.lastIndexOf(":"), dotted = raw.slice(at + 1), parts = dotted.split(".").map(Number); if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    const prefix = raw.slice(0, at), tail = `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`; return mappedIpv4(`${prefix}:${tail}`); }
  if (!raw.includes(":")) return null; const halves = raw.split("::"); if (halves.length > 2) return null; const left = halves[0] ? halves[0].split(":") : [], right = halves[1] ? halves[1].split(":") : [];
  words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left; if (words.length !== 8 || words.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  const nums = words.map((x) => parseInt(x, 16)); if (!nums.slice(0, 5).every((x) => x === 0) || nums[5] !== 0xffff) return null; return `${nums[6] >> 8}.${nums[6] & 255}.${nums[7] >> 8}.${nums[7] & 255}`;
}
function ipv4Number(ip) { const parts = String(ip).split(".").map(Number); if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null; return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0; }
function ipv6Bytes(ip) {
  let raw = String(ip).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]; const mapped = mappedIpv4(raw); if (mapped) raw = `::ffff:${ipv4Number(mapped).toString(16).padStart(8, "0").replace(/(.{4})(.{4})/, "$1:$2")}`;
  const halves = raw.split("::"); if (halves.length > 2) return null; const parse = (side) => side ? side.split(":").map((x) => /^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN) : [], left = parse(halves[0]), right = parse(halves[1]);
  if ([...left, ...right].some(Number.isNaN) || halves.length === 1 && left.length !== 8 || halves.length === 2 && left.length + right.length >= 8) return null; const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left, out = Buffer.alloc(16); words.forEach((word, i) => out.writeUInt16BE(word, i * 2)); return out;
}
function prefixMatch(bytes, hex, bits) { const prefix = Buffer.from(hex.padEnd(Math.ceil(bits / 8) * 2, "0"), "hex"), whole = Math.floor(bits / 8), rem = bits % 8; if (!bytes.subarray(0, whole).equals(prefix.subarray(0, whole))) return false; return rem === 0 || (bytes[whole] & (0xff << (8 - rem))) === (prefix[whole] & (0xff << (8 - rem))); }
const IANA_SPECIAL_PURPOSE_SNAPSHOT = common.IANA_SPECIAL_PURPOSE_SNAPSHOT;
const IPV4_NON_GLOBAL = Object.freeze([[0x00000000,8],[0x0a000000,8],[0x64400000,10],[0x7f000000,8],[0xa9fe0000,16],[0xac100000,12],[0xc0000000,24],[0xc0000200,24],[0xc01fc400,24],[0xc034c100,24],[0xc0586300,24],[0xc0a80000,16],[0xc0af3000,24],[0xc6120000,15],[0xc6336400,24],[0xcb007100,24],[0xe0000000,4],[0xf0000000,4]]);
const IPV6_NON_GLOBAL = Object.freeze([["00",96],["00",128],["00000000000000000000000000000001",128],["0064ff9b0000000000000000",96],["0064ff9b0001",48],["0100",64],["20010000",23],["20010020",28],["20010db8",32],["2002",16],["3fff",20],["5f00",16],["fc",7],["fe80",10],["fec0",10],["ff",8]]);
function isGloballyRoutable(ip) {
  const kind = net.isIP(ip); if (!kind) return false;
  if (kind === 6) { const mapped = mappedIpv4(ip); if (mapped) return false; }
  if (kind === 4) { const n = ipv4Number(ip); if (n === 0xc0000009 || n === 0xc000000a) return true; return !IPV4_NON_GLOBAL.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits))); }
  const bytes = ipv6Bytes(ip); if (!bytes || String(ip).includes("%")) return false; return !IPV6_NON_GLOBAL.some(([hex, bits]) => prefixMatch(bytes, hex, bits));
}
function extractCandidates(text, fileIndex, remaining) {
  const rows = [], seen = new Set();
  for (const token of String(text).match(/https:\/\/[^\s<>"'`\])}]+/gi) || []) {
    if (rows.length >= remaining) break;
    try { const url = parseSafeUrl(token.replace(/[.,;!?]+$/, "")); if (!seen.has(url.href)) { seen.add(url.href); rows.push({ endpoint: url.href, fileIndex, ordinal: rows.length }); } } catch (_) { /* ineligible */ }
  }
  return rows;
}
function readBrokerBuffers(buffers, deadline) {
  if (!Array.isArray(buffers) || buffers.length !== 4 || !deadline || typeof deadline.remaining !== "function" || deadline.remaining() <= 0) fail(STATUSES.CURRENT, "INVENTORY", "BROKER_BUFFERS_REQUIRED");
  let aggregate = 0; const byFile = buffers.map((value, fileIndex) => { if (!Buffer.isBuffer(value) || value.length > CAPS.inventoryFileBytes || (aggregate += value.length) > CAPS.inventoryAggregateBytes) fail(STATUSES.CURRENT, "INVENTORY", "BROKER_BUFFER_CAP"); return extractCandidates(value.toString("utf8"), fileIndex, 8); });
  const rows = []; for (let ordinal = 0; ordinal < 8; ordinal += 1) for (const group of byFile) if (group[ordinal] && rows.length < CAPS.candidates) rows.push(group[ordinal]);
  if (rows.length < 2) fail(STATUSES.CURRENT, "INVENTORY", "CANDIDATE_COVERAGE"); return rows;
}function monotonicNow() { return performance.now(); }
class AbsoluteDeadline { constructor(now = monotonicNow, timers = { setTimeout, clearTimeout }, wallMs = CAPS.wallMs) { this.now = now; this.timers = timers; this.deadlineAt = now() + wallMs; this.aborters = new Set(); this.expired = false; this.wallTimer = timers.setTimeout(() => { this.expired = true; for (const abort of this.aborters) try { abort(); } catch (_) { /* bounded abort */ } }, wallMs); this.wallTimer?.unref?.(); }
  remaining() { return Math.max(0, this.deadlineAt - this.now()); } close() { this.timers.clearTimeout(this.wallTimer); this.aborters.clear(); }
  async run(factory, perMs = CAPS.requestTimeoutMs, abort = null) { const globalBefore = this.remaining(), ms = Math.min(perMs, globalBefore); if (ms <= 0 || this.expired) throw new Error("GLOBAL_DEADLINE"); const operationDeadlineAt = this.now() + ms, globallyLimited = globalBefore <= perMs; let timer, operation, cancel = abort, aborter;
    try { operation = factory(); if (operation && typeof operation === "object" && operation.promise) { cancel ||= operation.cancel; operation = operation.promise; } if (typeof operation?.cancel === "function") cancel ||= () => operation.cancel(); aborter = () => cancel?.(); this.aborters.add(aborter);
      const result = await Promise.race([Promise.resolve(operation), new Promise((_, reject) => { timer = this.timers.setTimeout(() => { aborter(); reject(new Error(globallyLimited ? "GLOBAL_DEADLINE" : "ABSOLUTE_TIMEOUT")); }, ms); })]), globalRemaining = this.remaining(), after = this.now();
      if (this.expired || globalRemaining <= 0 || this.deadlineAt - after <= 0) { aborter(); throw new Error("GLOBAL_DEADLINE"); } if (operationDeadlineAt - after <= 0) { aborter(); throw new Error(globallyLimited ? "GLOBAL_DEADLINE" : "ABSOLUTE_TIMEOUT"); } return result;
    } finally { this.timers.clearTimeout(timer); if (aborter) this.aborters.delete(aborter); } }
}
function cancelableLookup(hostname) { const resolver = new dns.Resolver(), promise = Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)])
    .then((results) => results.flatMap((row, family) => row.status === "fulfilled" ? row.value.map((address) => ({ address, family: family ? 6 : 4 })) : [])); return { promise, cancel: () => resolver.cancel() }; }
async function resolveSafe(url, lookup = cancelableLookup, deadline = null) {
  let rows; try { if (deadline) rows = await deadline.run(() => lookup(url.hostname, { all: true, verbatim: true }), CAPS.requestTimeoutMs); else { const operation = lookup(url.hostname, { all: true, verbatim: true }); rows = await (operation?.promise || operation); } } catch (_) { rows = null; }
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((x) => !x || !isGloballyRoutable(x.address))) fail(STATUSES.CURRENT, "RPC", "DNS_NOT_GLOBAL"); return rows;
}
async function resolveCandidates(candidates, lookup = cancelableLookup, deadline = null) {
  const accepted = [], claimed = [];
  for (const candidate of candidates) {
    let rows; try { rows = await resolveSafe(new URL(candidate.endpoint), lookup, deadline); } catch (_) { continue; }
    const normalized = rows.map((x) => ({ address: x.address.toLowerCase(), family: net.isIP(x.address) })).sort((a, b) => a.family - b.family || a.address.localeCompare(b.address)), ips = new Set(normalized.map((x) => x.address)), family = familyKey(candidate.endpoint);
    if (claimed.some((x) => x.family === family || [...ips].some((ip) => x.ips.has(ip)))) continue;
    claimed.push({ family, ips }); accepted.push({ ...candidate, familyKey: family, resolved: normalized });
  }
  if (accepted.length < 2) fail(STATUSES.CURRENT, "INVENTORY", "INDEPENDENT_FAMILY_COVERAGE"); return accepted;
}
function resolutionSet(rows) { return [...new Set(rows.map((x) => `${net.isIP(x.address)}:${String(x.address).toLowerCase()}`))].sort(); }
async function verifyDnsBindings(groups, lookup = cancelableLookup, deadline = null) {
  const claims = [];
  for (const group of groups) { if (!group || !Array.isArray(group.resolved) || !group.endpoint) fail(STATUSES.CURRENT, "DNS", "DNS_BINDING_MISSING"); const current = await resolveSafe(new URL(group.endpoint), lookup, deadline);
    if (!same(resolutionSet(current), resolutionSet(group.resolved))) fail(STATUSES.CURRENT, "DNS", "DNS_ANSWER_DRIFT"); const family = familyKey(group.endpoint), ips = new Set(group.resolved.map((x) => String(x.address).toLowerCase()));
    if (claims.some((x) => x.family === family || [...ips].some((ip) => x.ips.has(ip)))) fail(STATUSES.CURRENT, "DNS", "DNS_FAMILY_OVERLAP_DRIFT"); claims.push({ family, ips }); }
  return true;
}
async function httpsTransport(endpoint, body, options = {}) {
  const target = parseSafeUrl(endpoint), rows = options.resolved; if (!Array.isArray(rows) || !rows.length || rows.some((x) => !isGloballyRoutable(x.address))) throw new Error("DNS_BINDING_REQUIRED"); const selected = rows[0];
  return new Promise((resolve, reject) => {
    let size = 0, response, done = false, timer; const chunks = [], finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); if (error) { response?.destroy?.(); request.destroy(error); reject(error); } else resolve(value); }, request = https.request(target, { method: "POST", rejectUnauthorized: true,
      lookup: (_host, lookupOptions, callback) => lookupOptions?.all ? callback(null, rows) : callback(null, selected.address, selected.family),
      servername: target.hostname, headers: { host: target.host, "content-type": "application/json", "content-length": body.length } }, (res) => { response = res;
      if (res.statusCode !== 200) { finish(new Error("HTTP_REJECTED")); return; }
      res.on("data", (chunk) => { size += chunk.length; if (size > CAPS.responseBytes) finish(new Error("RESPONSE_CAP")); else chunks.push(chunk); });
      res.on("end", () => finish(null, Buffer.concat(chunks))); res.on("error", (error) => finish(error));
    });
    timer = setTimeout(() => finish(new Error("REQUEST_TIMEOUT")), Math.max(0, Math.min(options.timeoutMs || CAPS.requestTimeoutMs, options.remainingMs ?? Infinity))); request.on("socket", (socket) => { socket.setTimeout(0); socket.once("secureConnect", () => { const peer = String(socket.remoteAddress || "").toLowerCase(), allowed = new Set(rows.map((x) => String(x.address).toLowerCase())); if (!allowed.has(peer) && !allowed.has(mappedIpv4(peer))) finish(new Error("TLS_PEER_DNS_MISMATCH")); }); }); request.on("error", (error) => finish(error)); request.end(body);
  });
}
class Budget {
  constructor(now = Date.now) { this.now = now; this.started = now(); this.calls = 0; this.bytes = 0; this.history = new Map([["A", 0], ["B", 0]]); this.methods = {}; }
  reserve(method, family, historical = false) {
    if (!ALLOWED_RPC.has(method) || this.now() - this.started >= CAPS.wallMs || ++this.calls > CAPS.logicalCalls) fail(STATUSES.ENUM, "BUDGET", "CALL_OR_WALL_CAP");
    if (historical) { const count = (this.history.get(family) || 0) + 1; this.history.set(family, count); if (count > CAPS.historyCallsPerFamily) fail(STATUSES.ENUM, "BUDGET", "HISTORY_CAP"); }
    this.methods[method] = (this.methods[method] || 0) + 1;
  }
  response(length) { this.bytes += length; if (length > CAPS.responseBytes || this.bytes > CAPS.aggregateResponseBytes) fail(STATUSES.ENUM, "BUDGET", "RESPONSE_CAP"); }
  historyCount(family) { return this.history.get(family) || 0; }
  historyTotal() { return [...this.history.values()].reduce((a, b) => a + b, 0); }
  selectHistory(a, b) { this.history = new Map([["A", Number(a || 0)], ["B", Number(b || 0)]]); }
}
function criticalTargetAddress(context, family, role) { if (!role) return null; return context.model.addresses[role] || context.model.addresses.libraries?.[role] || context.criticalExecution.bindings[family].addresses[role] || null; }
function consumeCriticalDescriptor(context, family, method, params) { const state = context.criticalExecution, index = state.indexes[family], row = state.execution[index]; if (!row) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_QUERY_EXTRA"); if (row.method !== method) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_QUERY_METHOD_MISMATCH"); const spec = row.parameterSpec, blockHash = state.bindings[family].blocks[row.blockReference.role], target = criticalTargetAddress(context, family, row.targetRole), expectTarget = (actual) => { if (!target || String(actual).toLowerCase() !== target) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_QUERY_TARGET_MISMATCH"); };
  if (spec.kind === "HEADER_NUMBER") { if (!same(params, [spec.selector, false])) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_QUERY_PARAMS_MISMATCH"); }
  else if (spec.kind === "HEADER_HASH") { if (!blockHash || !same(params, [blockHash, false])) fail(STATUSES.ENUM, "HISTORY_PLAN", `CRITICAL_QUERY_BLOCK_MISMATCH_${row.semanticQueryId}`); }
  else { const pin = params[spec.kind === "STORAGE" ? 2 : 1]; if (!blockHash || pin?.blockHash !== blockHash || pin.requireCanonical !== true) fail(STATUSES.ENUM, "HISTORY_PLAN", `CRITICAL_QUERY_BLOCK_MISMATCH_${row.semanticQueryId}`); if (spec.kind === "STORAGE") { expectTarget(params[0]); if (params[1] !== spec.slot) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_QUERY_PARAMS_MISMATCH"); } else if (spec.kind === "CODE") expectTarget(params[0]); else if (spec.kind === "CALL") { expectTarget(params[0]?.to); const data = String(params[0]?.data || "").toLowerCase(), selector = id(spec.signature).slice(0, 10), words = Array.from({ length: spec.args.length }, (_, i) => `0x${data.slice(10 + i * 64, 74 + i * 64)}`); if (!data.startsWith(selector) || data.length !== 10 + spec.args.length * 64 || spec.args.some((arg, i) => typeof arg === "string" ? words[i] !== arg : BigInt(words[i]) !== state.bindings[family].values[arg.from])) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_QUERY_PARAMS_MISMATCH"); } }
  state.indexes[family] += 1; state.actual[family].push(sha256(Buffer.from(canonical(state.public[index])))); return row; }
function bindCriticalResult(context, family, row, body) { if (!row || body.error) return; const state = context.criticalExecution, spec = row.parameterSpec, result = body.result; if (row.expectedResultClass === "HEADER" && (!result || typeof result !== "object" || !/^0x[0-9a-f]{64}$/.test(result.hash || ""))) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_RESULT_CLASS"); if (row.expectedResultClass === "WORD32" && !/^0x[0-9a-f]{64}$/i.test(result || "")) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_RESULT_CLASS"); if (["BYTECODE", "ABI_BYTES"].includes(row.expectedResultClass) && !/^0x(?:[0-9a-f]{2})*$/i.test(result || "")) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_RESULT_CLASS"); if (spec.kind === "HEADER_NUMBER") state.bindings[family].blocks[row.blockReference.role] = String(result.hash).toLowerCase(); if (row.bindAddress) state.bindings[family].addresses[row.bindAddress] = addressWord(result); if (row.bindValue) state.bindings[family].values[row.bindValue] = BigInt(`0x${String(result).slice(-64)}`); }
async function boundedRpcEnvelope(endpoint, method, params, context, family = "A", historical = false, allowError = false) {
  let criticalDescriptor = null; if (historical && context.criticalReservation?.active) { if (context.criticalReservation.remaining[family] <= 0) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_PLAN_EXCEEDED"); criticalDescriptor = consumeCriticalDescriptor(context, family, method, params); context.criticalReservation.remaining[family] -= 1; }
  context.budget.reserve(method, family, historical); const requestId = ++context.nextId, request = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
  const binding = context.endpointBindings?.get(endpoint); let bytes; try { const invoke = () => (context.transport || httpsTransport)(endpoint, request, { timeoutMs: CAPS.requestTimeoutMs, remainingMs: context.deadline?.remaining(), resolved: binding?.resolved }); if (context.deadline) bytes = await context.deadline.run(invoke, CAPS.requestTimeoutMs); else { const operation = invoke(); bytes = await (operation?.promise || operation); } } catch (_) { fail(historical ? STATUSES.ARCHIVE : STATUSES.CURRENT, "RPC", "TRANSPORT"); }
  bytes = Buffer.from(bytes); context.budget.response(bytes.length); let body; try { body = JSON.parse(bytes); } catch (_) { fail(STATUSES.FAMILY, "RPC", "JSON"); }
  if (!body || body.jsonrpc !== "2.0" || body.id !== requestId || body.error && !allowError || !body.error && !Object.hasOwn(body, "result")) fail(historical ? STATUSES.ARCHIVE : STATUSES.CURRENT, "RPC", "ENVELOPE"); bindCriticalResult(context, family, criticalDescriptor, body);
  if (context.familySequences && ["A", "B"].includes(family)) {
    const sequence = context.familySequences[family], row = { ordinal: sequence.length, method, historical,
      requestSha256: sha256(Buffer.from(canonical(params))), resultSha256: sha256(Buffer.from(canonical(body.error ? { code: body.error.code, dataCommitment: sha256(Buffer.from(canonical(body.error.data ?? null))) } : body.result))) };
    row.commitment = sha256(Buffer.from(canonical(row))); sequence.push(row);
    body.sequenceCommitment = row.commitment;
  } return body;
}
async function rpc(endpoint, method, params, context, family = "A", historical = false) { return (await boundedRpcEnvelope(endpoint, method, params, context, family, historical)).result; }
async function dual(groups, method, params, context, historical = false, normalize = (x) => x) {
  const values = await Promise.all(groups.map((group, i) => rpc(group.endpoint, method, params, context, i ? "B" : "A", historical)));
  const decoded = values.map((value) => normalize(value)); if (!same(decoded[0], decoded[1])) fail(STATUSES.FAMILY, "DUAL", "SEMANTIC_DISAGREEMENT"); return decoded[0];
}

async function qualifyCandidate(candidate, context) {
  const started = context.budget.now(), charge = candidate.familyKey || familyKey(candidate.endpoint), vault = context.model.addresses.vaultProxy;
  const chain = quantity(await rpc(candidate.endpoint, "eth_chainId", [], context, charge)); if (chain !== 137n) fail(STATUSES.CURRENT, "QUALIFY", "WRONG_CHAIN");
  const header = parseHeader(await rpc(candidate.endpoint, "eth_getBlockByNumber", ["finalized", false], context, charge));
  const byHash = parseHeader(await rpc(candidate.endpoint, "eth_getBlockByHash", [header.hash, false], context, charge));
  if (!same(semanticHeader(header), semanticHeader(byHash))) fail(STATUSES.PIN, "QUALIFY", "FINALIZED_BY_HASH_MISMATCH");
  const statePin = pinArg(header), currentCode = hex(await rpc(candidate.endpoint, "eth_getCode", [vault, statePin], context, charge));
  const currentSlot = hex(await rpc(candidate.endpoint, "eth_getStorageAt", [vault, IMPLEMENTATION_SLOT, statePin], context, charge), 32);
  const currentCall = hex(await rpc(candidate.endpoint, "eth_call", [{ to: vault, data: context.canaryData }, statePin], context, charge));
  if (currentCode === "0x" || currentSlot === ZERO32 || currentCall === "0x") fail(STATUSES.CURRENT, "QUALIFY", "SHALLOW_CURRENT_CANARY");
  const baseHeader = parseHeader(await rpc(candidate.endpoint, "eth_getBlockByNumber", [qhex(BASE_DEPLOYMENT_BLOCK + 0x2dn), false], context, charge, true));
  const baseByHash = parseHeader(await rpc(candidate.endpoint, "eth_getBlockByHash", [baseHeader.hash, false], context, charge, true));
  if (!same(semanticHeader(baseHeader), semanticHeader(baseByHash))) fail(STATUSES.ARCHIVE, "QUALIFY", "BASE_BY_HASH_MISMATCH");
  const bp = pinArg(baseHeader), baseCode = hex(await rpc(candidate.endpoint, "eth_getCode", [vault, bp], context, charge, true));
  const baseSlot = hex(await rpc(candidate.endpoint, "eth_getStorageAt", [vault, IMPLEMENTATION_SLOT, bp], context, charge, true), 32);
  const baseCall = hex(await rpc(candidate.endpoint, "eth_call", [{ to: vault, data: context.canaryData }, bp], context, charge, true));
  const baseLogs = await rpc(candidate.endpoint, "eth_getLogs", [{ address: [vault, context.model.addresses.twapProxy], fromBlock: qhex(BASE_DEPLOYMENT_BLOCK), toBlock: qhex(BASE_DEPLOYMENT_BLOCK + 0x40n), topics: [[EVENT_TOPICS[0]]] }], context, charge, true);
  const v2Header = parseHeader(await rpc(candidate.endpoint, "eth_getBlockByNumber", [qhex(V2_CREATION_BLOCK), false], context, charge, true)), vp = pinArg(v2Header);
  const v2Code = hex(await rpc(candidate.endpoint, "eth_getCode", [context.model.addresses.vaultImplementation, vp], context, charge, true));
  const eraLogs = await rpc(candidate.endpoint, "eth_getLogs", [{ address: [vault, context.model.addresses.twapProxy], fromBlock: qhex(BASE_DEPLOYMENT_BLOCK), toBlock: qhex(V2_CREATION_BLOCK), topics: [[EVENT_TOPICS[0]]] }], context, charge, true);
  if (baseCode === "0x" || baseSlot === ZERO32 || baseCall === "0x" || !Array.isArray(baseLogs) || baseLogs.length === 0 || v2Code === "0x" || !Array.isArray(eraLogs) || eraLogs.length === 0)
    fail(STATUSES.ARCHIVE, "QUALIFY", "SHALLOW_ARCHIVE_CANARY");
  return { ...candidate, familyKey: charge, header, score: 10, latency: context.budget.now() - started, qualificationHistoryCalls: context.budget.historyCount(charge) };
}
async function qualify(candidates, context) {
  const qualified = [];
  for (const candidate of candidates) { try { qualified.push(await qualifyCandidate(candidate, context)); } catch (error) { if (error instanceof GateError && ["BUDGET", "LOCAL"].includes(error.stage)) throw error; } }
  qualified.sort((a, b) => b.score - a.score || a.latency - b.latency || a.fileIndex - b.fileIndex || a.ordinal - b.ordinal);
  let attempts = 0;
  for (let i = 0; i < qualified.length; i += 1) for (let j = i + 1; j < qualified.length; j += 1) {
    if (++attempts > CAPS.pairAttempts) break; const pair = [qualified[i], qualified[j]]; if (pair[0].familyKey === pair[1].familyKey) continue;
    const number = pair[0].header.number < pair[1].header.number ? pair[0].header.number : pair[1].header.number, exact = [], hashReads = [];
    try { for (const row of pair) { const h = parseHeader(await rpc(row.endpoint, "eth_getBlockByNumber", [qhex(number), false], context, row.familyKey)); exact.push(h);
      hashReads.push(parseHeader(await rpc(row.endpoint, "eth_getBlockByHash", [h.hash, false], context, row.familyKey))); } } catch (_) { continue; }
    if (exact[0].number === number && same(semanticHeader(exact[0]), semanticHeader(exact[1])) && hashReads.every((x, k) => same(semanticHeader(x), semanticHeader(exact[k]))))
      return { groups: pair, pin: exact[0], candidatesConsidered: candidates.length, pairAttempts: attempts };
  }
  fail(STATUSES.PIN, "PIN", qualified.length < 2 ? "TWO_FAMILY_QUALIFICATION" : "NO_COMMON_PIN");
}

function mask(hexCode, start, length) { const at = 2 + start * 2, size = length * 2; return `${hexCode.slice(0, at)}${"0".repeat(size)}${hexCode.slice(at + size)}`; }
function artifactTemplate(artifact) { return artifact.deployedBytecode.object.replace(/__\$[0-9a-fA-F]{34}\$__/g, "0".repeat(40)).toLowerCase(); }
function expectedWord(address) { return `${"0".repeat(24)}${address.slice(2).toLowerCase()}`; }
function cborLength(buffer, offset, info) { if (info < 24) return { value: info, next: offset }; const bytes = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0; if (!bytes || offset + bytes > buffer.length) throw new Error("CBOR_LENGTH");
  let value = 0n; for (let i = 0; i < bytes; i += 1) value = (value << 8n) | BigInt(buffer[offset + i]); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR_LARGE"); return { value: Number(value), next: offset + bytes }; }
function parseCborItem(buffer, offset = 0) { if (offset >= buffer.length) throw new Error("CBOR_EOF"); const first = buffer[offset++], major = first >> 5, info = first & 31, length = cborLength(buffer, offset, info); offset = length.next;
  if (major === 0) return { value: length.value, next: offset }; if (major === 2 || major === 3) { if (offset + length.value > buffer.length) throw new Error("CBOR_BYTES"); const bytes = buffer.subarray(offset, offset + length.value); return { value: major === 2 ? { bytes: bytes.toString("hex") } : bytes.toString("utf8"), next: offset + length.value }; }
  if (major === 4) { const value = []; for (let i = 0; i < length.value; i += 1) { const row = parseCborItem(buffer, offset); value.push(row.value); offset = row.next; } return { value, next: offset }; }
  if (major === 5) { const value = {}; for (let i = 0; i < length.value; i += 1) { const key = parseCborItem(buffer, offset); offset = key.next; if (typeof key.value !== "string" || Object.hasOwn(value, key.value)) throw new Error("CBOR_MAP_KEY"); const row = parseCborItem(buffer, offset); offset = row.next; value[key.value] = row.value; } return { value, next: offset }; }
  throw new Error("CBOR_MAJOR"); }
function parseMetadataTrailer(code) { const data = Buffer.from(hex(code).slice(2), "hex"); if (data.length < 3) throw new Error("CBOR_SHORT"); const length = data.readUInt16BE(data.length - 2), start = data.length - 2 - length; if (start < 0) throw new Error("CBOR_BOUNDS");
  const trailer = data.subarray(start, data.length - 2), decoded = parseCborItem(trailer); if (decoded.next !== trailer.length || !decoded.value || Array.isArray(decoded.value)) throw new Error("CBOR_TRAILING"); return { start, length, decoded: decoded.value, trailerHex: trailer.toString("hex") }; }
function metadataDigestOnlyMismatch(expected, observed) { let a, b; try { a = parseMetadataTrailer(expected); b = parseMetadataTrailer(observed); } catch (_) { return false; }
  if (a.start !== b.start || expected.slice(0, 2 + a.start * 2) !== observed.slice(0, 2 + b.start * 2)) return false; const keysA = Object.keys(a.decoded).sort(), keysB = Object.keys(b.decoded).sort(); if (!same(keysA, keysB)) return false;
  const differences = keysA.filter((key) => !same(a.decoded[key], b.decoded[key])); return differences.length === 1 && ["ipfs", "bzzr0", "bzzr1"].includes(differences[0])
    && a.decoded[differences[0]]?.bytes && b.decoded[differences[0]]?.bytes && a.decoded[differences[0]].bytes.length === b.decoded[differences[0]].bytes.length;
}
function compareRuntime(artifact, deployed, binding, addresses) {
  let expected = artifactTemplate(artifact), observed = hex(deployed); if (!/^0x[0-9a-f]*$/.test(expected)) fail(STATUSES.SOURCE, "COMPARE", "ARTIFACT_TEMPLATE");
  const links = artifact.deployedBytecode.linkReferences || {};
  const actualLinkNames = Object.values(links).flatMap((x) => Object.keys(x)).sort(); if (!same(actualLinkNames, [...(binding.links || [])].sort())) return { status: "LINK_REFERENCE_LAYOUT_MISMATCH", exact: false, executableSourceEquivalent: false };
  for (const [source, contracts] of Object.entries(links)) for (const [name, refs] of Object.entries(contracts)) for (const ref of refs) {
    const wanted = addresses.libraries?.[name] || addresses[name]; if (!wanted || observed.slice(2 + ref.start * 2, 2 + (ref.start + ref.length) * 2) !== wanted.slice(2).toLowerCase()) return { status: "LINK_VALUE_MISMATCH", exact: false, executableSourceEquivalent: false };
    expected = mask(expected, ref.start, ref.length); observed = mask(observed, ref.start, ref.length);
  }
  const immutableAddress = binding.uupsSelf ? addresses[binding.uupsSelf] : binding.vaultImmutable ? addresses[binding.vaultImmutable] : null;
  const immutableKeys = Object.keys(artifact.deployedBytecode.immutableReferences || {}).sort(); if (!same(immutableKeys, [...(binding.immutableReferenceKeys || [])].sort())) return { status: "IMMUTABLE_REFERENCE_LAYOUT_MISMATCH", exact: false, executableSourceEquivalent: false };
  if (immutableAddress) for (const refs of Object.values(artifact.deployedBytecode.immutableReferences || {})) for (const ref of refs) {
    if (observed.slice(2 + ref.start * 2, 2 + (ref.start + ref.length) * 2) !== expectedWord(immutableAddress)) return { status: "IMMUTABLE_VALUE_MISMATCH", exact: false, executableSourceEquivalent: false };
    expected = mask(expected, ref.start, ref.length); observed = mask(observed, ref.start, ref.length);
  }
  if (binding.librarySelf) {
    if (expected.slice(2, 4) !== "73" || observed.slice(2, 4) !== "73" || expected.slice(44, 48) !== "3014" || observed.slice(44, 48) !== "3014") return { status: "LIBRARY_GUARD_CONTEXT_MISMATCH", exact: false, executableSourceEquivalent: false };
    const wanted = addresses.libraries[binding.librarySelf]; if (observed.slice(4, 44) !== wanted.slice(2).toLowerCase()) return { status: "LIBRARY_SELF_MISMATCH", exact: false, executableSourceEquivalent: false };
    expected = mask(expected, 1, 20); observed = mask(observed, 1, 20);
  }
  if (expected === observed) return { status: "EXACT", exact: true, executableSourceEquivalent: true, normalizedSha256: sha256(Buffer.from(expected.slice(2), "hex")) };
  if (expected.length === observed.length && metadataDigestOnlyMismatch(expected, observed)) return { status: "FAIL_CLOSED_METADATA_PROVENANCE", exact: false, executableSourceEquivalent: true };
  return { status: "RUNTIME_MISMATCH", exact: false, executableSourceEquivalent: false };
}
function authorityArtifact(context, row) { const value = context?.authorityArtifacts?.[row.path]; if (!value) fail(STATUSES.SOURCE, "AUTHORITY", "IMMUTABLE_SNAPSHOT_REQUIRED"); return value; }
function authorityBytes(context, relative) { const value = context?.authorityBytes?.[relative]; if (!Buffer.isBuffer(value)) fail(STATUSES.SOURCE, "AUTHORITY", "IMMUTABLE_SNAPSHOT_REQUIRED"); return value; }
function expectedProxyRuntime(source, context) {
  const authority = source.declarations.proxyRuntimeAuthority, bytes = authorityBytes(context, authority.path); if (Buffer.from(bytes).length !== authority.bytes || sha256(bytes) !== authority.sha256) fail(STATUSES.SOURCE, "PROXY", "PROXY_AUTHORITY_BINDING");
  let broadcast; try { broadcast = JSON.parse(bytes); } catch (_) { fail(STATUSES.SOURCE, "PROXY", "PROXY_AUTHORITY_JSON"); } const runtimes = [];
  for (const proxy of [source.declarations.vaultProxy, source.declarations.twapProxy]) { const row = broadcast.transactions.find((x) => x.transactionType === "CREATE" && x.contractName === authority.contract && String(x.contractAddress).toLowerCase() === proxy);
    if (!row || typeof row.transaction?.input !== "string") fail(STATUSES.SOURCE, "PROXY", "PROXY_CREATION_MISSING"); const input = hex(row.transaction.input), start = 2 + authority.runtimeOffset * 2, runtime = `0x${input.slice(start, start + authority.runtimeBytes * 2)}`;
    if ((input.length - 2) / 2 < authority.creationCodeBytes || (runtime.length - 2) / 2 !== authority.runtimeBytes || sha256(Buffer.from(runtime.slice(2), "hex")) !== authority.runtimeSha256 || keccak256(runtime) !== authority.runtimeKeccak256) fail(STATUSES.SOURCE, "PROXY", "PROXY_RUNTIME_AUTHORITY_MISMATCH"); runtimes.push(runtime); }
  if (runtimes[0] !== runtimes[1]) fail(STATUSES.SOURCE, "PROXY", "PROXY_AUTHORITY_DISAGREEMENT"); return runtimes[0];
}
function splitInclusive(from, to, width) {
  const rows = []; for (let start = BigInt(from); start <= BigInt(to); start += BigInt(width)) rows.push({ from: start, to: start + BigInt(width) - 1n > BigInt(to) ? BigInt(to) : start + BigInt(width) - 1n }); return rows;
}
function normalizeLog(row) {
  if (!row || row.removed !== false || !Array.isArray(row.topics) || row.topics.length < 1 || !EVENT_TOPICS.includes(hex(row.topics[0], 32))) fail(STATUSES.ENUM, "LOG", "LOG_SCHEMA");
  return { address: hex(row.address, 20), blockNumber: quantity(row.blockNumber), blockHash: hex(row.blockHash, 32), transactionHash: hex(row.transactionHash, 32),
    transactionIndex: quantity(row.transactionIndex), logIndex: quantity(row.logIndex), topics: row.topics.map((x) => hex(x, 32)), dataCommitment: sha256(Buffer.from(hex(row.data).slice(2), "hex")) };
}
function logCommitment(rows) { const projected = rows.map((x) => clean(x)).sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : Number(BigInt(a.logIndex) - BigInt(b.logIndex))); return sha256(Buffer.from(canonical(projected))); }
async function collectLogs(groups, addresses, from, pin, context) {
  const all = []; let width = 100000n;
  while (true) {
    try {
      for (const interval of splitInclusive(from, pin.number, width)) {
        const filter = { address: addresses, fromBlock: qhex(interval.from), toBlock: qhex(interval.to), topics: [EVENT_TOPICS] };
        const rows = await dual(groups, "eth_getLogs", [filter], context, true, (value) => value.map(normalizeLog)); all.push(...rows);
        if (all.length > CAPS.normalizedLogs) fail(STATUSES.ENUM, "LOG", "NORMALIZED_LOG_CAP");
      }
      return all;
    } catch (error) {
      if (!(error instanceof GateError) || error.status !== STATUSES.ARCHIVE || width === 10000n) throw error;
      width = width === 100000n ? 50000n : width === 50000n ? 25000n : 10000n; all.length = 0;
    }
  }
}
async function findCodeStart(groups, address, pin, context) {
  let low = 0n, high = pin.number;
  while (low < high) { const mid = (low + high) >> 1n, headers = await Promise.all(groups.map((g, i) => rpc(g.endpoint, "eth_getBlockByNumber", [qhex(mid), false], context, i ? "B" : "A", true).then(parseHeader)));
    if (!same(semanticHeader(headers[0]), semanticHeader(headers[1]))) fail(STATUSES.FAMILY, "HISTORY", "HEADER_DISAGREEMENT");
    const code = await dual(groups, "eth_getCode", [address, pinArg(headers[0])], context, true, hex); if (code === "0x") low = mid + 1n; else high = mid;
  } return low;
}
function decodeTuple(iface, name, raw) { const values = iface.decodeFunctionResult(name, hex(raw)); return clean(values.length === 1 ? values[0] : Array.from(values)); }
async function semanticCalls(groups, target, iface, names, pin, context, historical = false) {
  const result = {};
  for (const name of names) { const data = iface.encodeFunctionData(name, []); result[name] = await dual(groups, "eth_call", [{ to: target, data }, pinArg(pin)], context, historical, (x) => decodeTuple(iface, name, x)); }
  return result;
}
const COMPLETE_TOPICS = Object.freeze({
  Upgraded: id("Upgraded(address)").toLowerCase(), MarketInitialized: id("MarketInitialized(bytes32,uint256,uint256,bool)").toLowerCase(),
  VaultAdded: id("VaultAdded(address,uint256)").toLowerCase(), VaultRemoved: id("VaultRemoved(address,uint256)").toLowerCase(),
  VaultCapUpdated: id("VaultCapUpdated(address,uint256,uint256)").toLowerCase(), VaultActiveUpdated: id("VaultActiveUpdated(address,bool)").toLowerCase(),
  VaultsSwapped: id("VaultsSwapped(address,address,uint256,uint256)").toLowerCase(), VaultEmergencyUpdated: id("VaultEmergencyUpdated(address,bool)").toLowerCase(),
  RoleGranted: id("RoleGranted(bytes32,address,address)").toLowerCase(), RoleRevoked: id("RoleRevoked(bytes32,address,address)").toLowerCase(),
  TwapUpdated: id("TwapUpdated(bytes32,uint256,uint256)").toLowerCase(), IndexesUpdated: id("IndexesUpdated(bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)").toLowerCase(),
  Deposited: id("Deposited(address,uint256,bytes32[],uint256[],uint256[],uint256[],uint256[])").toLowerCase(),
  Withdrawn: id("Withdrawn(address,uint256,bytes32[],uint256[],uint256[],uint256[],uint256[],uint256,uint256)").toLowerCase()
});
const COMPLETE_TOPIC_SET = new Set(Object.values(COMPLETE_TOPICS));
const HISTORY_WIDTHS = Object.freeze([200000n, 100000n, 50000n, 20000n, 10000n]);
const TOPIC_NAME = Object.fromEntries(Object.entries(COMPLETE_TOPICS).map(([name, topic]) => [topic, name]));
const ERC20_IFACE = new Interface(["function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)", "function decimals() view returns(uint8)"]);
const ERC1155_IFACE = new Interface(["function balanceOf(address,uint256) view returns(uint256)"]);
const ERC4626_IFACE = new Interface(["function asset() view returns(address)", "function balanceOf(address) view returns(uint256)", "function previewRedeem(uint256) view returns(uint256)",
  "function convertToAssets(uint256) view returns(uint256)", "function previewDeposit(uint256) view returns(uint256)", "function convertToShares(uint256) view returns(uint256)", "function totalAssets() view returns(uint256)", "function totalSupply() view returns(uint256)",
  "function maxDeposit(address) view returns(uint256)", "function maxWithdraw(address) view returns(uint256)"]);
function addSlot(base, offset) { return `0x${(BigInt(base) + BigInt(offset)).toString(16).padStart(64, "0")}`; }
function mappingBase(key, slot) { return keccak256(`0x${hex(key, 32).slice(2)}${hex(slot, 32).slice(2)}`); }
function uint256Word(value) { return BigInt(hex(value, 32)); }
function boolWord(value) { const n = uint256Word(value); if (n !== 0n && n !== 1n) fail(STATUSES.ENUM, "DECODE", "BOOL_WORD"); return n === 1n; }
function addressWord(value) { return slotAddress(hex(value, 32)); }
function deepResult(value) { if (typeof value === "bigint") return value.toString(); if (Array.isArray(value)) return Array.from(value, deepResult); if (typeof value === "string") return value.toLowerCase(); return value; }
async function dualHeader(groups, block, context, historical = true) {
  const byNumber = await Promise.all(groups.map((g, i) => rpc(g.endpoint, "eth_getBlockByNumber", [typeof block === "string" ? block : qhex(block), false], context, i ? "B" : "A", historical).then(parseHeader)));
  if (!same(semanticHeader(byNumber[0]), semanticHeader(byNumber[1]))) fail(STATUSES.FAMILY, "HEADER", "BY_NUMBER_FAMILY_DISAGREEMENT");
  const byHash = await Promise.all(groups.map((g, i) => rpc(g.endpoint, "eth_getBlockByHash", [byNumber[0].hash, false], context, i ? "B" : "A", historical).then(parseHeader)));
  if (!byHash.every((x) => same(semanticHeader(x), semanticHeader(byNumber[0])))) fail(STATUSES.PIN, "HEADER", "BY_HASH_CONTINUITY"); return byNumber[0];
}
async function dualStorage(groups, target, slot, pin, context, historical = false) { return dual(groups, "eth_getStorageAt", [target, slot, pinArg(pin)], context, historical, (x) => hex(x, 32)); }
async function dualCode(groups, target, pin, context, historical = false) { return dual(groups, "eth_getCode", [target, pinArg(pin)], context, historical, hex); }
async function dualFunction(groups, target, iface, name, args, pin, context, historical = false) {
  const data = iface.encodeFunctionData(name, args); return dual(groups, "eth_call", [{ to: target, data }, pinArg(pin)], context, historical, (raw) => {
    const decoded = iface.decodeFunctionResult(name, hex(raw)); return deepResult(decoded.length === 1 ? decoded[0] : Array.from(decoded));
  });
}
async function dualFunctionWithFallback(groups, target, iface, primary, fallback, args, pin, context, historical = false) { const data = iface.encodeFunctionData(primary, args), params = [{ to: target, data }, pinArg(pin)], outcomes = await Promise.all(groups.map(async (g, i) => { const family = i ? "B" : "A"; let body; try { body = await boundedRpcEnvelope(g.endpoint, "eth_call", params, context, family, historical, true); } catch (error) { if (error instanceof GateError && error.stage === "RPC") fail(error.status, "VAULT", error.code === "JSON" ? "ERC4626_PREVIEW_JSON" : error.code === "ENVELOPE" ? "ERC4626_PREVIEW_ENVELOPE" : "ERC4626_PREVIEW_TRANSPORT"); throw error; }
    let semantic; if (body.error) { const e = body.error, valid = e.code === 3 && typeof e.message === "string" && /^execution reverted\b/i.test(e.message) && typeof e.data === "string" && /^0x[0-9a-f]*$/i.test(e.data); if (!valid) fail(historical ? STATUSES.ARCHIVE : STATUSES.CURRENT, "VAULT", "ERC4626_PREVIEW_PROVIDER_ERROR"); semantic = { kind: "EVM_REVERT", classification: { kind: "EVM_EXECUTION_REVERT", payloadCommitment: sha256(Buffer.from(canonical({ code: 3, data: e.data.toLowerCase() }))) } }; }
    else { if (!Object.hasOwn(body, "result")) fail(STATUSES.FAMILY, "VAULT", "ERC4626_PREVIEW_ENVELOPE"); let value; try { const decoded = iface.decodeFunctionResult(primary, hex(body.result)); value = deepResult(decoded.length === 1 ? decoded[0] : Array.from(decoded)); } catch { fail(STATUSES.FAMILY, "VAULT", "ERC4626_PREVIEW_DECODE"); } semantic = { kind: "SUCCESS", value }; }
    return { ...semantic, sequenceCommitment: body.sequenceCommitment }; }));
  if (outcomes[0].kind !== outcomes[1].kind) fail(STATUSES.FAMILY, "VAULT", "ERC4626_FALLBACK_FAMILY_DISAGREEMENT"); const primaryCommitments = { A: outcomes[0].sequenceCommitment, B: outcomes[1].sequenceCommitment }; if (outcomes[0].kind === "SUCCESS") { if (!same(outcomes[0].value, outcomes[1].value)) fail(STATUSES.FAMILY, "VAULT", "ERC4626_PREVIEW_FAMILY_DISAGREEMENT"); return { value: outcomes[0].value, mode: "PREVIEW_USED", fallbackClassification: null, callSequenceCommitments: { primary: primaryCommitments, fallback: null } }; }
  if (!same(outcomes[0].classification, outcomes[1].classification)) fail(STATUSES.FAMILY, "VAULT", "ERC4626_REVERT_CLASSIFICATION_DISAGREEMENT"); const before = context.familySequences ? { A: context.familySequences.A.length, B: context.familySequences.B.length } : null, value = await dualFunction(groups, target, iface, fallback, args, pin, context, historical), fallbackCommitments = before ? { A: context.familySequences.A[before.A].commitment, B: context.familySequences.B[before.B].commitment } : null; return { value, mode: "CONVERT_FALLBACK", fallbackClassification: outcomes[0].classification, callSequenceCommitments: { primary: primaryCommitments, fallback: fallbackCommitments } }; }
function normalizeCompleteLog(row, interval) {
  if (!row || row.removed !== false || !Array.isArray(row.topics) || !row.topics.length || !COMPLETE_TOPIC_SET.has(hex(row.topics[0], 32))) fail(STATUSES.ENUM, "LOG", "MALFORMED_LOG");
  const blockNumber = quantity(row.blockNumber), transactionIndex = quantity(row.transactionIndex), logIndex = quantity(row.logIndex);
  if (blockNumber < interval.from || blockNumber > interval.to) fail(STATUSES.ENUM, "LOG", "LOG_OUTSIDE_INTERVAL");
  return { address: hex(row.address, 20), blockNumber, blockHash: hex(row.blockHash, 32), transactionHash: hex(row.transactionHash, 32), transactionIndex, logIndex,
    topics: row.topics.map((x) => hex(x, 32)), data: hex(row.data), removed: false };
}
function sortCompleteLogs(rows) { return [...rows].sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.transactionIndex < b.transactionIndex ? -1 : a.transactionIndex > b.transactionIndex ? 1 : a.logIndex < b.logIndex ? -1 : a.logIndex > b.logIndex ? 1 : a.address.localeCompare(b.address)); }
function historyProjection(from, to, width, qualification = { A: 0, B: 0 }, negotiationCalls = 0) { const ranges = splitInclusive(from, to, width), intervals = ranges.length, singletonIntervals = ranges.filter((x) => x.from === x.to).length, boundaryCallsPerFamily = intervals * 12 - singletonIntervals * 6, authoritativePerFamily = boundaryCallsPerFamily + intervals, A = Number(qualification.A || 0) + negotiationCalls + authoritativePerFamily, B = Number(qualification.B || 0) + negotiationCalls + authoritativePerFamily; return { phase: "SWEEP", intervals, singletonIntervals, boundaryCallsPerFamily, logCallsPerFamily: intervals, qualificationCalls: { A: Number(qualification.A || 0), B: Number(qualification.B || 0) }, negotiationCallsPerFamily: negotiationCalls, projectedHistoryCalls: { A, B }, projectedGlobalCalls: A + B }; }
function allowlistedRangeLimit(error) { return error && [-32005, -32602, -32000].includes(error.code) && typeof error.message === "string" && /(?:block|query|response|result).*(?:range|limit|large|more than)|range.*(?:limit|large)/i.test(error.message); }
async function negotiateHistoryWidth(groups, addresses, from, to, context, options = {}) { let probes = 0; const qualification = { A: context.budget.historyCount("A"), B: context.budget.historyCount("B") };
  for (const width of options.widths || HISTORY_WIDTHS) { const probeTo = BigInt(from) + width - 1n > BigInt(to) ? BigInt(to) : BigInt(from) + width - 1n, params = [{ address: addresses, fromBlock: qhex(from), toBlock: qhex(probeTo), topics: [[...COMPLETE_TOPIC_SET]] }], bodies = await Promise.all(groups.map((group, i) => boundedRpcEnvelope(group.endpoint, "eth_getLogs", params, context, i ? "B" : "A", true, true))); probes += 1; const errors = bodies.map((x) => x.error || null); if (errors.some(Boolean)) { if (errors.every(allowlistedRangeLimit)) continue; fail(STATUSES.ARCHIVE, "HISTORY_PLAN", "RANGE_NEGOTIATION_UNALLOWLISTED"); } if (bodies.some((x) => !Array.isArray(x.result))) fail(STATUSES.ARCHIVE, "HISTORY_PLAN", "RANGE_NEGOTIATION_SHAPE"); const projection = historyProjection(from, to, width, qualification, probes), incrementalGlobal = projection.projectedGlobalCalls - qualification.A - qualification.B;
    if (projection.projectedHistoryCalls.A > CAPS.historyCallsPerFamily || projection.projectedHistoryCalls.B > CAPS.historyCallsPerFamily || context.budget.calls + incrementalGlobal > CAPS.logicalCalls) continue; projection.reservedBeforeSweep = true; context.historyReservation = { ...projection, width: width.toString() }; return { width, projection }; }
  fail(STATUSES.ENUM, "HISTORY_PLAN", "NO_FEASIBLE_HISTORY_WIDTH"); }
async function authoritativeLogs(groups, addresses, from, to, context, width = 10000n) {
  const intervals = splitInclusive(from, to, width), rows = [], coverage = []; const seen = new Set();
  for (const interval of intervals) {
    const preStart = await dualHeader(groups, interval.from, context, true), preEnd = interval.to === interval.from ? preStart : await dualHeader(groups, interval.to, context, true), preBoundary = { startBlock: interval.from.toString(), startHash: preStart.hash, endBlock: interval.to.toString(), endHash: preEnd.hash };
    const filter = { address: addresses, fromBlock: qhex(interval.from), toBlock: qhex(interval.to), topics: [[...COMPLETE_TOPIC_SET]] };
    const batch = await dual(groups, "eth_getLogs", [filter], context, true, (value) => {
      if (!Array.isArray(value)) fail(STATUSES.ENUM, "LOG", "LOG_RESULT_NOT_ARRAY"); return sortCompleteLogs(value.map((x) => normalizeCompleteLog(x, interval)));
    });
    if (batch.some((row) => row.blockNumber === interval.from && row.blockHash !== preStart.hash || row.blockNumber === interval.to && row.blockHash !== preEnd.hash)) fail(STATUSES.ARCHIVE, "LOG", "INTERVAL_LOG_BOUNDARY_HASH");
    for (const row of batch) { const key = `${row.blockHash}:${row.transactionHash}:${row.logIndex}`; if (seen.has(key)) fail(STATUSES.ENUM, "LOG", "DUPLICATE_LOG"); seen.add(key); rows.push(row); }
    const postStart = await dualHeader(groups, interval.from, context, true), postEnd = interval.to === interval.from ? postStart : await dualHeader(groups, interval.to, context, true), postBoundary = { startBlock: interval.from.toString(), startHash: postStart.hash, endBlock: interval.to.toString(), endHash: postEnd.hash }; if (!same(preBoundary, postBoundary)) fail(STATUSES.ARCHIVE, "LOG", "INTERVAL_BOUNDARY_DRIFT");
    coverage.push({ fromBlock: interval.from.toString(), toBlock: interval.to.toString(), inclusiveWidth: (interval.to - interval.from + 1n).toString(), resultCount: batch.length,
      commitment: sha256(Buffer.from(canonical(batch.map((x) => clean(x))))), boundary: { ...preBoundary, commitment: sha256(Buffer.from(canonical(preBoundary))) } });
    if (rows.length > CAPS.normalizedLogs) fail(STATUSES.ENUM, "LOG", "NORMALIZED_LOG_CAP");
  }
  for (const item of coverage) { const start = await dualHeader(groups, BigInt(item.fromBlock), context, true), end = item.toBlock === item.fromBlock ? start : await dualHeader(groups, BigInt(item.toBlock), context, true); if (start.hash !== item.boundary.startHash || end.hash !== item.boundary.endHash) fail(STATUSES.ARCHIVE, "LOG", "FINAL_INTERVAL_BOUNDARY_DRIFT"); }
  return { width: width.toString(), rows: sortCompleteLogs(rows), coverage };
}
function logSemantic(row, interfaces = null) {
  const name = TOPIC_NAME[row.topics[0]], out = { name, address: row.address, blockNumber: row.blockNumber.toString(), blockHash: row.blockHash,
    transactionHash: row.transactionHash, transactionIndex: row.transactionIndex.toString(), logIndex: row.logIndex.toString() };
  if (["Upgraded", "VaultAdded", "VaultRemoved", "VaultCapUpdated", "VaultActiveUpdated", "VaultEmergencyUpdated"].includes(name)) out.subject = `0x${row.topics[1].slice(-40)}`;
  if (["MarketInitialized", "TwapUpdated", "IndexesUpdated"].includes(name)) out.conditionId = row.topics[1];
  if (["RoleGranted", "RoleRevoked"].includes(name)) { out.role = row.topics[1]; out.account = `0x${row.topics[2].slice(-40)}`; }
  if (name === "Upgraded") out.implementation = out.subject;
  if (name === "VaultsSwapped") { out.vault1 = `0x${row.topics[1].slice(-40)}`; out.vault2 = `0x${row.topics[2].slice(-40)}`; }
  if (interfaces && ["Deposited", "Withdrawn"].includes(name)) {
    let parsed; try { parsed = interfaces.vaultIface.parseLog({ topics: row.topics, data: row.data }); } catch (_) { fail(STATUSES.ENUM, "LOG", "EVENT_DECODE_FAILED"); }
    const ids = parsed?.args?.conditionIds; if (!ids || !Array.isArray(ids)) fail(STATUSES.ENUM, "LOG", "CONDITION_ARRAY_MISSING"); out.conditionIds = Array.from(ids, (x) => String(x).toLowerCase());
  }
  return out;
}
function criticalHistoryDescriptors(facts, model) { const a = model.addresses, descriptors = [], execution = [], roleAddress = (role) => a[role] || a.libraries?.[role] || null, add = (semanticQueryId, method, targetRole, blockReference, parameterSpec, expectedResultClass, bindAddress = null, bindValue = null) => { const address = targetRole ? roleAddress(targetRole) : null, targetRoleAddressCommitment = sha256(Buffer.from(canonical(address ? { targetRole, address } : { targetRole, dynamic: true }))), publicRow = { semanticQueryId, method, targetRole, targetRoleAddressCommitment, blockReference, parameterCommitment: sha256(Buffer.from(canonical(parameterSpec))), expectedResultClass }; descriptors.push(publicRow); execution.push({ ...publicRow, parameterSpec, bindAddress, bindValue }); }, header = (prefix, role, number) => { add(`${prefix}.number`, "eth_getBlockByNumber", null, { role, reference: qhex(number) }, { kind: "HEADER_NUMBER", selector: qhex(number) }, "HEADER"); add(`${prefix}.hash`, "eth_getBlockByHash", null, { role, reference: "BOUND_BY_NUMBER_HASH" }, { kind: "HEADER_HASH", role }, "HEADER"); }, storage = (id, targetRole, slot, blockRole, bind = null) => add(id, "eth_getStorageAt", targetRole, { role: blockRole, reference: "BOUND_BLOCK_HASH" }, { kind: "STORAGE", slot }, "WORD32", bind), code = (id, targetRole, blockRole) => add(id, "eth_getCode", targetRole, { role: blockRole, reference: "BOUND_BLOCK_HASH" }, { kind: "CODE" }, "BYTECODE"), call = (id, targetRole, blockRole, signature, args, bindValue = null) => add(id, "eth_call", targetRole, { role: blockRole, reference: "BOUND_BLOCK_HASH" }, { kind: "CALL", signature, args }, "ABI_BYTES", null, bindValue);
  for (const upgrade of facts.upgrades) { const prefix = `upgrade.${upgrade.proxy}`, parentRole = `${prefix}.parent`, postRole = `${prefix}.post`, parentDynamic = `${upgrade.proxy}.parentImplementation`; header(`${prefix}.parent.header`, parentRole, BigInt(upgrade.blockNumber) - 1n); header(`${prefix}.post.header`, postRole, BigInt(upgrade.blockNumber)); storage(`${prefix}.parent.implementation.slot`, upgrade.proxy, IMPLEMENTATION_SLOT, parentRole, parentDynamic); storage(`${prefix}.post.implementation.slot`, upgrade.proxy, IMPLEMENTATION_SLOT, postRole); code(`${prefix}.parent.implementation.code`, parentDynamic, parentRole); code(`${prefix}.post.implementation.code`, upgrade.proxy === "vaultProxy" ? "vaultImplementation" : "twapImplementation", postRole); if (upgrade.proxy === "vaultProxy") storage(`${prefix}.post.extension.slot`, "vaultProxy", EXTENSION_SLOT, postRole); const runtimes = upgrade.proxy === "vaultProxy" ? ["vaultProxy", "vaultImplementation", "vaultExtension", "AccountingLib", "IndexCalcLib", "PolymarketLib", "VaultLib"] : ["twapProxy", "twapImplementation"]; for (const role of runtimes) code(`${prefix}.post.runtime.${role}.code`, role, postRole); }
  const vaultUpgrade = facts.upgrades.find((x) => x.proxy === "vaultProxy"), adoptionParent = "upgrade.vaultProxy.parent", adoptionPost = "upgrade.vaultProxy.post"; for (const conditionId of facts.preexistingMarkets) { const base = mappingBase(conditionId, ACCOUNTING_SLOT); header(`market.${conditionId}.adoption.parent.header`, adoptionParent, BigInt(vaultUpgrade.blockNumber) - 1n); header(`market.${conditionId}.adoption.post.header`, adoptionPost, BigInt(vaultUpgrade.blockNumber)); storage(`market.${conditionId}.adoption.parent.slot9`, "vaultProxy", addSlot(base, 9), adoptionParent); storage(`market.${conditionId}.adoption.post.slot9`, "vaultProxy", addSlot(base, 9), adoptionPost); }
  const state = (prefix, conditionId, blockRole) => { const base = mappingBase(conditionId, ACCOUNTING_SLOT), polymarketBase = mappingBase(conditionId, addSlot(POLYMARKET_SLOT, 7)), lastTwapBinding = `${prefix}.vault.getMarketState.lastTwapPriceYes`; call(`${prefix}.vault.getMarketState`, "vaultProxy", blockRole, "getMarketState(bytes32)", [conditionId], lastTwapBinding); storage(`${prefix}.vault.slot9`, "vaultProxy", addSlot(base, 9), blockRole); call(`${prefix}.vault.getMarketIndexes`, "vaultProxy", blockRole, "getMarketIndexes(bytes32,uint256)", [conditionId, { from: lastTwapBinding }]); call(`${prefix}.twap.getMarketState`, "twapProxy", blockRole, "getMarketState(bytes32)", [conditionId]); storage(`${prefix}.token.yes.slot`, "vaultProxy", polymarketBase, blockRole); storage(`${prefix}.token.no.slot`, "vaultProxy", addSlot(polymarketBase, 1), blockRole); storage(`${prefix}.token.info.slot`, "vaultProxy", addSlot(polymarketBase, 2), blockRole); for (const [proxy, implementation] of [["vaultProxy", "vaultImplementation"], ["twapProxy", "twapImplementation"]]) { storage(`${prefix}.${proxy}.implementation.slot`, proxy, IMPLEMENTATION_SLOT, blockRole); code(`${prefix}.${proxy}.implementation.code`, implementation, blockRole); } storage(`${prefix}.extension.slot`, "vaultProxy", EXTENSION_SLOT, blockRole); code(`${prefix}.extension.code`, "vaultExtension", blockRole); code(`${prefix}.vault.proxy.code`, "vaultProxy", blockRole); code(`${prefix}.twap.proxy.code`, "twapProxy", blockRole); for (const role of ["AccountingLib", "IndexCalcLib", "PolymarketLib", "VaultLib"]) code(`${prefix}.library.${role}.code`, role, blockRole); storage(`${prefix}.pool.totalShares.slot`, "vaultProxy", addSlot(ACCOUNTING_SLOT, 2), blockRole); storage(`${prefix}.pool.totalAssets.slot`, "vaultProxy", addSlot(ACCOUNTING_SLOT, 3), blockRole); };
  for (const transition of facts.transitionFacts) { const prefix = `market.${transition.conditionId}.transition.${transition.kind}`, parentRole = `${prefix}.parent`, postRole = `${prefix}.post`; header(`${prefix}.parent.header`, parentRole, BigInt(transition.blockNumber) - 1n); header(`${prefix}.post.header`, postRole, BigInt(transition.blockNumber)); state(`${prefix}.parent`, transition.conditionId, parentRole); state(`${prefix}.post`, transition.conditionId, postRole); } return { descriptors, execution }; }
function buildCriticalHistoryPlan(semanticLogs, model) { const upgrades = [["vaultProxy", model.addresses.vaultImplementation], ["twapProxy", model.addresses.twapImplementation]].map(([proxy, implementation]) => { const row = semanticLogs.find((x) => x.name === "Upgraded" && x.address === model.addresses[proxy] && x.implementation === implementation); if (!row) fail(STATUSES.RUNTIME, "HISTORY_PLAN", "V2_ADOPTION_MISSING"); return { proxy, blockNumber: row.blockNumber, blockHash: row.blockHash }; }), adoption = upgrades[0], adoptionBlock = BigInt(adoption.blockNumber), markets = [...new Set(semanticLogs.filter((x) => x.name === "MarketInitialized" && x.address === model.addresses.vaultProxy && BigInt(x.blockNumber) < adoptionBlock).map((x) => x.conditionId))], transitionFacts = [];
  for (const conditionId of markets) for (const kind of ["TwapUpdated", "IndexesUpdated", "Deposited", "Withdrawn"]) { const row = semanticLogs.find((x) => x.name === kind && BigInt(x.blockNumber) > adoptionBlock && (x.conditionId === conditionId || x.conditionIds?.includes(conditionId))); if (row) transitionFacts.push({ conditionId, kind, blockNumber: row.blockNumber, blockHash: row.blockHash }); } const facts = { preexistingMarkets: markets, transitionFacts, upgrades }, built = criticalHistoryDescriptors(facts, model), commitment = sha256(Buffer.from(canonical(built.descriptors))); return { schemaVersion: "robin-runtime-r2/critical-history-plan-v2", facts, descriptors: built.descriptors, executionDescriptors: built.execution, countPerFamily: built.descriptors.length, commitment }; }
function decodePackedLastTwap(word) { const n = uint256Word(word); return { packedUint144: (n & ((1n << 144n) - 1n)).toString(), marketInitTimestamp: (n & ((1n << 40n) - 1n)).toString(), lastYieldTimestamp: ((n >> 40n) & ((1n << 40n) - 1n)).toString(), lastTwapPriceYes: ((n >> 80n) & ((1n << 64n) - 1n)).toString(), unusedHighBitsZero: (n >> 144n) === 0n }; }
function decodeMarketTuple(tuple, slot9) {
  if (!Array.isArray(tuple) || tuple.length !== 15) fail(STATUSES.ENUM, "MARKET", "MARKET_TUPLE_INCOMPLETE");
  return { totalSharesYes: tuple[0], totalSharesNo: tuple[1], marketPoolShares: tuple[2], principalContributed: tuple[3], totalWeightedSnapshotYes: tuple[4], totalWeightedSnapshotNo: tuple[5],
    lossIndexYes: tuple[6], lossIndexNo: tuple[7], yieldPerShareYes: tuple[8], yieldPerShareNo: tuple[9], lastYieldTwapCheckpointYes: tuple[10], yieldReductionFactor: tuple[11],
    marketInitTimestamp: tuple[12], lastYieldTimestamp: tuple[13], lastTwapPriceYes: tuple[14], slot9 };
}
function reconstructVaultOrder(semanticLogs) {
  const order = [], state = {};
  for (const row of semanticLogs) {
    if (row.name === "VaultAdded") { if (!order.includes(row.subject)) order.push(row.subject); state[row.subject] = state[row.subject] || {}; }
    else if (row.name === "VaultRemoved") { const at = order.indexOf(row.subject); if (at >= 0) order.splice(at, 1); delete state[row.subject]; }
    else if (row.name === "VaultsSwapped") { const a = order.indexOf(row.vault1), b = order.indexOf(row.vault2); if (a < 0 || b < 0) fail(STATUSES.ENUM, "VAULT", "SWAP_UNKNOWN_VAULT"); [order[a], order[b]] = [order[b], order[a]]; }
    else if (row.name === "VaultCapUpdated" && state[row.subject]) state[row.subject].capUpdated = true;
    else if (row.name === "VaultActiveUpdated" && state[row.subject]) state[row.subject].activeUpdated = true;
    else if (row.name === "VaultEmergencyUpdated" && state[row.subject]) state[row.subject].emergencyUpdated = true;
  }
  return { order, state };
}
async function coreSnapshot(groups, pin, source, model, context, historical = false) {
  const a = model.addresses, sourceByContract = Object.fromEntries(source.artifacts.map((x) => [x.contract, x])), proxyCodes = {}, proxyRuntime = expectedProxyRuntime(source, context);
  for (const proxy of ["vaultProxy", "twapProxy"]) { const code = await dualCode(groups, a[proxy], pin, context, historical); if (code === "0x") fail(STATUSES.RUNTIME, "TOPOLOGY", "PROXY_CODE_EMPTY");
    if (code !== proxyRuntime) fail(STATUSES.RUNTIME, "TOPOLOGY", "PROXY_RUNTIME_NOT_EXACT"); proxyCodes[proxy] = { bytes: (code.length - 2) / 2, keccak256: keccak256(code), normalizedSha256: sha256(Buffer.from(code.slice(2), "hex")), comparison: "EXACT" }; }
  if (!same(proxyCodes.vaultProxy, proxyCodes.twapProxy)) fail(STATUSES.RUNTIME, "TOPOLOGY", "PROXY_RUNTIME_MISMATCH");
  const topology = { proxyCodes };
  for (const proxy of ["vaultProxy", "twapProxy"]) topology[proxy] = { implementation: addressWord(await dualStorage(groups, a[proxy], IMPLEMENTATION_SLOT, pin, context, historical)),
    admin: addressWord(await dualStorage(groups, a[proxy], ADMIN_SLOT, pin, context, historical)), beacon: addressWord(await dualStorage(groups, a[proxy], BEACON_SLOT, pin, context, historical)) };
  topology.vaultExtension = addressWord(await dualStorage(groups, a.vaultProxy, EXTENSION_SLOT, pin, context, historical));
  if (topology.vaultProxy.implementation !== a.vaultImplementation || topology.twapProxy.implementation !== a.twapImplementation || topology.vaultExtension !== a.vaultExtension
    || topology.vaultProxy.admin !== "0x0000000000000000000000000000000000000000" || topology.twapProxy.admin !== "0x0000000000000000000000000000000000000000"
    || topology.vaultProxy.beacon !== "0x0000000000000000000000000000000000000000" || topology.twapProxy.beacon !== "0x0000000000000000000000000000000000000000") fail(STATUSES.RUNTIME, "TOPOLOGY", "PROXY_SLOT_TOPOLOGY_MISMATCH");
  const comparisons = {}, codeEvidence = {};
  for (const binding of model.expectedBindings.filter((x) => x.artifact)) { const target = a[binding.surface] || a.libraries[binding.surface], code = await dualCode(groups, target, pin, context, historical);
    const artifact = authorityArtifact(context, sourceByContract[binding.artifact]), compared = compareRuntime(artifact, code, binding, a); comparisons[binding.surface] = compared;
    codeEvidence[binding.surface] = { bytes: (code.length - 2) / 2, keccak256: code === "0x" ? null : keccak256(code), comparison: compared.status, normalizedSha256: compared.normalizedSha256 || null };
  }
  const mismatch = Object.values(comparisons).find((x) => !x.exact); if (mismatch) fail(STATUSES.RUNTIME, "RUNTIME", mismatch.status === "FAIL_CLOSED_METADATA_PROVENANCE" ? mismatch.status : "RUNTIME_MISMATCH");
  const vaultArtifact = authorityArtifact(context, sourceByContract.RobinStakingVault), extensionArtifact = authorityArtifact(context, sourceByContract.RobinStakingVaultExtension),
    vaultIface = new Interface([...vaultArtifact.abi, ...extensionArtifact.abi]);
  const twapArtifact = authorityArtifact(context, sourceByContract.RobinTwapOracle), twapIface = new Interface(twapArtifact.abi);
  const config = {}, vaultCalls = ["getTwapOracle", "getProtocolFeeBps", "getAccumulatedProtocolFees", "getTwapGracePeriod", "getPolymarketOracles", "getPolymarketOnramp", "getPolymarketOfframp",
    "getExternalVaults", "getTotalVaultValue", "getTotalUsdcValue", "getTotalAvailableCapacity", "getTotalAvailableInternalCapacity", "getMaximumAdditionalMatchedTokens", "getUnderlyingUsdc", "isEmergencyMode", "isInternalCapacityCheckDisabled", "isPausedAll", "isPausedDeposits", "isPausedWithdrawals", "isTransfersPaused"];
  for (const name of vaultCalls) if (vaultIface.getFunction(name)) config[name] = await dualFunction(groups, a.vaultProxy, vaultIface, name, [], pin, context, historical);
  for (const name of ["getTwapSigner", "getDefaultTwapRequired", "getGlobalTwapRequired", "getGlobalTwapDisabled"]) if (twapIface.getFunction(name)) config[`twap.${name}`] = await dualFunction(groups, a.twapProxy, twapIface, name, [], pin, context, historical);
  const storage = { totalPoolShares: uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(ACCOUNTING_SLOT, 2), pin, context, historical)).toString(),
    totalPoolAssetsStored: uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(ACCOUNTING_SLOT, 3), pin, context, historical)).toString(),
    protocolFeeBps: uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(ACCOUNTING_SLOT, 4), pin, context, historical)).toString(),
    accumulatedProtocolFees: uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(ACCOUNTING_SLOT, 5), pin, context, historical)).toString(),
    asset: addressWord(await dualStorage(groups, a.vaultProxy, addSlot(YIELD_SLOT, 2), pin, context, historical)),
    ctf: addressWord(await dualStorage(groups, a.vaultProxy, addSlot(POLYMARKET_SLOT, 0), pin, context, historical)),
    negRiskAdapter: addressWord(await dualStorage(groups, a.vaultProxy, addSlot(POLYMARKET_SLOT, 1), pin, context, historical)),
    polymarketUnderlyingAsset: addressWord(await dualStorage(groups, a.vaultProxy, addSlot(POLYMARKET_SLOT, 4), pin, context, historical)),
    wcol: addressWord(await dualStorage(groups, a.vaultProxy, addSlot(POLYMARKET_SLOT, 5), pin, context, historical)),
    maximumAdditionalMatchedTokens: uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(POLYMARKET_SLOT, 6), pin, context, historical)).toString(),
    signatureFactoryHelper: addressWord(await dualStorage(groups, a.vaultProxy, SIGNATURES_SLOT, pin, context, historical)),
    vaultArrayLength: uint256Word(await dualStorage(groups, a.vaultProxy, YIELD_SLOT, pin, context, historical)).toString(),
    polymarketOracleArrayLength: uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(POLYMARKET_SLOT, 8), pin, context, historical)).toString(),
    yieldFlagsWord: await dualStorage(groups, a.vaultProxy, addSlot(YIELD_SLOT, 3), pin, context, historical), pauseWord: await dualStorage(groups, a.vaultProxy, PAUSABLE_SLOT, pin, context, historical) };
  const yieldFlags = uint256Word(storage.yieldFlagsWord); storage.emergencyMode = (yieldFlags & 0xffn) === 1n; storage.internalCapacityCheckDisabled = ((yieldFlags >> 8n) & 0xffn) === 1n;
  if ((yieldFlags & 0xffn) > 1n || ((yieldFlags >> 8n) & 0xffn) > 1n || yieldFlags >> 16n !== 0n) fail(STATUSES.ENUM, "CONFIG", "YIELD_FLAGS_INVALID");
  const expectedCore = a.coreDependencies; if (String(config.getTwapOracle).toLowerCase() !== a.twapProxy || String(config.getUnderlyingUsdc).toLowerCase() !== storage.asset || storage.asset !== expectedCore.underlyingAsset
    || storage.ctf !== expectedCore.ctf || storage.negRiskAdapter !== expectedCore.negRiskAdapter || storage.polymarketUnderlyingAsset !== expectedCore.underlyingAsset || storage.wcol !== expectedCore.wcol || storage.signatureFactoryHelper !== expectedCore.signatureFactoryHelper
    || Boolean(config.isEmergencyMode) !== storage.emergencyMode || Boolean(config.isInternalCapacityCheckDisabled) !== storage.internalCapacityCheckDisabled
    || String(config.getMaximumAdditionalMatchedTokens) !== storage.maximumAdditionalMatchedTokens
    || String(config.getProtocolFeeBps) !== storage.protocolFeeBps || String(config.getAccumulatedProtocolFees) !== storage.accumulatedProtocolFees) fail(STATUSES.ENUM, "CONFIG", "GETTER_STORAGE_MISMATCH");
  return { topology, codeEvidence, config, storage, interfaces: { vaultIface, twapIface }, commitment: sha256(Buffer.from(canonical({ topology, codeEvidence, config, storage }))) };
}
async function collectCurrent(groups, pin, initial, semanticLogs, source, model, context) {
  const a = model.addresses, { vaultIface, twapIface } = initial.interfaces, config = initial.config, asset = initial.storage.asset;
  const idle = await dualFunction(groups, asset, ERC20_IFACE, "balanceOf", [a.vaultProxy], pin, context), assetCode = await dualCode(groups, asset, pin, context), fees = BigInt(initial.storage.accumulatedProtocolFees),
    idleGross = BigInt(idle), idleNet = idleGross > fees ? idleGross - fees : 0n;
  if (assetCode === "0x") fail(STATUSES.ENUM, "DEPENDENCY", "ASSET_CODE_EMPTY");
  const rawVaults = config.getExternalVaults; if (!Array.isArray(rawVaults) || rawVaults.length !== 5 || rawVaults.some((x) => !Array.isArray(x)) || rawVaults[0].length > CAPS.vaults
    || rawVaults.slice(1).some((x) => x.length !== rawVaults[0].length)) fail(STATUSES.ENUM, "VAULT", "EXTERNAL_VAULT_GETTER_SHAPE");
  const reconstructed = reconstructVaultOrder(semanticLogs), vaults = [], getterOrder = rawVaults[0].map((x) => String(x).toLowerCase());
  if (reconstructed.order.join(",") !== getterOrder.join(",")) fail(STATUSES.ENUM, "VAULT", "VAULT_EVENT_GETTER_ORDER_MISMATCH");
  const vaultArrayBase = keccak256(YIELD_SLOT); let idleAllocationRemaining = idleNet;
  for (let i = 0; i < getterOrder.length; i += 1) {
    const target = getterOrder[i], code = await dualCode(groups, target, pin, context); if (code === "0x") fail(STATUSES.ENUM, "DEPENDENCY", "VAULT_CODE_EMPTY");
    const storageAddress = addressWord(await dualStorage(groups, a.vaultProxy, addSlot(vaultArrayBase, BigInt(i) * 3n), pin, context)), storageCap = uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(vaultArrayBase, BigInt(i) * 3n + 1n), pin, context)),
      storageFlagsWord = uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(vaultArrayBase, BigInt(i) * 3n + 2n), pin, context)), storageActive = (storageFlagsWord & 0xffn) === 1n,
      storageEmergency = ((storageFlagsWord >> 8n) & 0xffn) === 1n;
    const vaultAsset = await dualFunction(groups, target, ERC4626_IFACE, "asset", [], pin, context), shares = await dualFunction(groups, target, ERC4626_IFACE, "balanceOf", [a.vaultProxy], pin, context),
      redemption = await dualFunctionWithFallback(groups, target, ERC4626_IFACE, "previewRedeem", "convertToAssets", [shares], pin, context), previewRedeem = redemption.mode === "PREVIEW_USED" ? redemption.value : null, convertToAssets = redemption.mode === "CONVERT_FALLBACK" ? redemption.value : await dualFunction(groups, target, ERC4626_IFACE, "convertToAssets", [shares], pin, context),
      totalAssets = await dualFunction(groups, target, ERC4626_IFACE, "totalAssets", [], pin, context), totalSupply = await dualFunction(groups, target, ERC4626_IFACE, "totalSupply", [], pin, context),
      maxDeposit = await dualFunction(groups, target, ERC4626_IFACE, "maxDeposit", [a.vaultProxy], pin, context), maxWithdraw = await dualFunction(groups, target, ERC4626_IFACE, "maxWithdraw", [a.vaultProxy], pin, context);
    if (String(vaultAsset).toLowerCase() !== asset || redemption.mode === "PREVIEW_USED" && BigInt(previewRedeem) > BigInt(convertToAssets) || String(redemption.value) !== String(rawVaults[1][i])) fail(STATUSES.ENUM, "VAULT", "VAULT_VALUE_RECONCILIATION");
    if ((storageFlagsWord & 0xffn) > 1n || ((storageFlagsWord >> 8n) & 0xffn) > 1n || storageAddress !== target || storageCap !== BigInt(rawVaults[2][i]) || storageActive !== Boolean(rawVaults[3][i]) || storageEmergency !== Boolean(rawVaults[4][i]) || storageFlagsWord >> 16n !== 0n)
      fail(STATUSES.ENUM, "VAULT", "VAULT_STORAGE_GETTER_MISMATCH");
    const currentValue = BigInt(rawVaults[1][i]), cap = BigInt(rawVaults[2][i]), capRemaining = cap === 0n || cap > currentValue ? cap === 0n ? idleAllocationRemaining : cap - currentValue : 0n,
      allocation = storageActive && !storageEmergency ? [idleAllocationRemaining, capRemaining, BigInt(maxDeposit)].reduce((x, y) => x < y ? x : y) : 0n,
      previewDeposit = await dualFunction(groups, target, ERC4626_IFACE, "previewDeposit", [allocation], pin, context), convertToShares = await dualFunction(groups, target, ERC4626_IFACE, "convertToShares", [allocation], pin, context);
    if (BigInt(previewDeposit) > BigInt(convertToShares)) fail(STATUSES.ENUM, "VAULT", "VAULT_ALLOCATION_SHARE_RECONCILIATION"); idleAllocationRemaining -= allocation;
    vaults.push({ address: target, asset: String(vaultAsset).toLowerCase(), shares: String(shares), previewRedeem: previewRedeem === null ? null : String(previewRedeem), redeemValuationMode: redemption.mode, redeemFallbackClassification: redemption.fallbackClassification, redeemCallSequenceCommitments: redemption.callSequenceCommitments, convertToAssets: String(convertToAssets), allocation: allocation.toString(), previewDeposit: String(previewDeposit), convertToShares: String(convertToShares), totalAssets: String(totalAssets), totalSupply: String(totalSupply),
      maxDeposit: String(maxDeposit), maxWithdraw: String(maxWithdraw), cap: String(rawVaults[2][i]), active: Boolean(rawVaults[3][i]), emergency: Boolean(rawVaults[4][i]), value: String(rawVaults[1][i]),
      feeAwareConversions: { redeemPreviewBelowConvert: previewRedeem === null ? null : BigInt(previewRedeem) < BigInt(convertToAssets), depositPreviewBelowConvert: BigInt(previewDeposit) < BigInt(convertToShares), bounds: "PREVIEW_LTE_CONVERT_OR_SOURCE_FALLBACK" },
      storageReconciled: true, dependency: { codeBytes: (code.length - 2) / 2, codeKeccak256: keccak256(code), runtimeStatus: "OBSERVED_TWO_FAMILY",
        sourceStatus: (model.externalVaultRuntimeBindings || []).some((x) => x.address === target && x.codeKeccak256 === keccak256(code)) ? "SOURCE_RUNTIME_BOUND_EXACT" : "UNKNOWN_RUNTIME" } });
  }
  const marketIds = [...new Set(semanticLogs.filter((x) => x.name === "MarketInitialized").map((x) => x.conditionId))]; if (marketIds.length > CAPS.markets) fail(STATUSES.ENUM, "MARKET", "MARKET_CAP");
  const markets = []; let marketPoolShareSum = 0n;
  for (const conditionId of marketIds) {
    const stateTuple = await dualFunction(groups, a.vaultProxy, vaultIface, "getMarketState", [conditionId], pin, context), base = mappingBase(conditionId, ACCOUNTING_SLOT), polymarketBase = mappingBase(conditionId, addSlot(POLYMARKET_SLOT, 7)),
      yesPositionId = uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(polymarketBase, 0), pin, context)), noPositionId = uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(polymarketBase, 1), pin, context)),
      tokenInfoPacked = uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(polymarketBase, 2), pin, context)), negRiskByte = tokenInfoPacked & 0xffn, collateral = `0x${((tokenInfoPacked >> 8n) & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`,
      slot9Raw = await dualStorage(groups, a.vaultProxy, addSlot(base, 9), pin, context), slot9 = decodePackedLastTwap(slot9Raw);
    if (!yesPositionId || !noPositionId || negRiskByte > 1n || collateral === ZERO_ADDRESS || tokenInfoPacked >> 168n !== 0n) fail(STATUSES.ENUM, "MARKET", "MARKET_TOKEN_STORAGE_INVALID");
    if (!slot9.unusedHighBitsZero) fail(STATUSES.ENUM, "MARKET", "SLOT9_HIGH_BITS_NONZERO"); const market = decodeMarketTuple(stateTuple, slot9);
    if (String(market.marketInitTimestamp) !== slot9.marketInitTimestamp || String(market.lastYieldTimestamp) !== slot9.lastYieldTimestamp || String(market.lastTwapPriceYes) !== slot9.lastTwapPriceYes)
      fail(STATUSES.ENUM, "MARKET", "SLOT9_GETTER_MISMATCH");
    const unpaired = await dualFunction(groups, a.vaultProxy, vaultIface, "getUnpairedTokens", [conditionId], pin, context), ctfYes = await dualFunction(groups, initial.storage.ctf, ERC1155_IFACE, "balanceOf", [a.vaultProxy, yesPositionId], pin, context),
      ctfNo = await dualFunction(groups, initial.storage.ctf, ERC1155_IFACE, "balanceOf", [a.vaultProxy, noPositionId], pin, context), indexes = await dualFunction(groups, a.vaultProxy, vaultIface, "getMarketIndexes", [conditionId, market.lastTwapPriceYes], pin, context),
      twapState = await dualFunction(groups, a.twapProxy, twapIface, "getMarketState", [conditionId], pin, context), initializedVault = await dualFunction(groups, a.vaultProxy, vaultIface, "isMarketInitialized", [conditionId], pin, context),
      initializedTwap = await dualFunction(groups, a.twapProxy, twapIface, "isMarketInitialized", [conditionId], pin, context);
    if (!initializedVault || !initializedTwap || String(unpaired[0]) !== String(ctfYes) || String(unpaired[1]) !== String(ctfNo)) fail(STATUSES.ENUM, "MARKET", "ENUMERATED_MARKET_NOT_CURRENT"); marketPoolShareSum += BigInt(market.marketPoolShares);
    markets.push({ conditionId, yesPositionId: yesPositionId.toString(), noPositionId: noPositionId.toString(), collateral, negRisk: negRiskByte === 1n, tokenStorageReconciled: true, ...market,
      unpaired: { yes: String(unpaired[0]), no: String(unpaired[1]) }, indexes: { lossYes: indexes[0], lossNo: indexes[1], yieldPerShareYes: indexes[2], yieldPerShareNo: indexes[3], marketValue: indexes[4], yieldReductionFactor: indexes[5] }, twapState });
  }
  if (marketPoolShareSum !== BigInt(initial.storage.totalPoolShares)) fail(STATUSES.ENUM, "MATERIALITY", "MARKET_POOL_SHARE_RECONCILIATION");
  const roleRows = semanticLogs.filter((x) => ["RoleGranted", "RoleRevoked"].includes(x.name)), roleKeys = [...new Set(roleRows.map((x) => `${x.address}:${x.role}:${x.account}`))];
  if (roleKeys.length > CAPS.roleSubjects) fail(STATUSES.ENUM, "ROLE", "ROLE_SUBJECT_CAP"); const roles = {};
  for (const key of roleKeys) { const [target, role, account] = key.split(":"), iface = target === a.twapProxy ? twapIface : vaultIface; roles[key] = await dualFunction(groups, target, iface, "hasRole", [role, account], pin, context); }
  const dependencyTargets = Object.entries(a.coreDependencies).map(([kind, address]) => ({ kind, address, sourceStatus: "EXACT_ADDRESS_BOUND" }));
  for (const row of config.getPolymarketOracles || []) { if (!Array.isArray(row) || row.length < 2) fail(STATUSES.ENUM, "DEPENDENCY", "ORACLE_TUPLE_SHAPE"); const collateral = String(row[1]).toLowerCase(); dependencyTargets.push({ kind: "polymarketOracle", address: String(row[0]).toLowerCase() }, { kind: "polymarketCollateral", address: collateral, sourceStatus: Object.values(a.coreDependencies).includes(collateral) ? "EXACT_ADDRESS_BOUND" : "UNBOUND" }); }
  for (const [kind, address] of [["onramp", config.getPolymarketOnramp], ["offramp", config.getPolymarketOfframp]]) if (address && String(address).toLowerCase() !== ZERO_ADDRESS) dependencyTargets.push({ kind, address: String(address).toLowerCase() });
  const dependencies = [];
  for (const row of dependencyTargets) { const code = await dualCode(groups, row.address, pin, context); if (code === "0x") fail(STATUSES.ENUM, "DEPENDENCY", "CONFIGURED_DEPENDENCY_CODE_EMPTY"); dependencies.push({ ...row, codeBytes: (code.length - 2) / 2, codeKeccak256: keccak256(code), runtimeStatus: "OBSERVED_TWO_FAMILY", sourceStatus: row.sourceStatus || "UNBOUND" }); }
  for (const market of markets) { const sourceStatus = Object.values(a.coreDependencies).includes(market.collateral) ? "EXACT_ADDRESS_BOUND" : "UNBOUND"; dependencies.push({ kind: "marketCollateral", conditionId: market.conditionId, address: market.collateral, runtimeStatus: "OBSERVED_TWO_FAMILY", sourceStatus,
      codeBytes: 0, codeKeccak256: null }); const row = dependencies.at(-1), code = await dualCode(groups, row.address, pin, context); if (code === "0x") fail(STATUSES.ENUM, "DEPENDENCY", "MARKET_COLLATERAL_CODE_EMPTY"); row.codeBytes = (code.length - 2) / 2; row.codeKeccak256 = keccak256(code); }
  const totalUsdc = BigInt(config.getTotalUsdcValue), vaultValue = vaults.reduce((x, row) => x + BigInt(row.value), 0n), totalCapacity = BigInt(config.getTotalAvailableCapacity), internalCapacity = BigInt(config.getTotalAvailableInternalCapacity),
    maximumAdditionalMatchedTokens = BigInt(initial.storage.maximumAdditionalMatchedTokens), expectedTotalUsdc = idleNet + vaultValue;
  if (totalUsdc !== expectedTotalUsdc || vaultValue !== BigInt(config.getTotalVaultValue)) fail(STATUSES.ENUM, "MATERIALITY", "TOTAL_USDC_FORMULA_MISMATCH");
  const marketLiability = markets.reduce((sum, x) => sum + BigInt(x.totalSharesYes) + BigInt(x.totalSharesNo) + BigInt(x.marketPoolShares) + BigInt(x.principalContributed) + BigInt(x.totalWeightedSnapshotYes) + BigInt(x.totalWeightedSnapshotNo)
      + BigInt(x.yieldPerShareYes) + BigInt(x.yieldPerShareNo) + BigInt(x.lastYieldTwapCheckpointYes) + BigInt(x.unpaired.yes) + BigInt(x.unpaired.no), 0n), storedPoolAssets = BigInt(initial.storage.totalPoolAssetsStored),
    materialValue = idleNet + fees + vaultValue + storedPoolAssets + marketLiability, withdrawalPath = BigInt(initial.storage.totalPoolShares) > 0n && !config.isPausedAll && !config.isPausedWithdrawals,
    depositReachability = deriveMarketDepositReachability(markets, { pausedAll: config.isPausedAll, pausedDeposits: config.isPausedDeposits, emergencyMode: config.isEmergencyMode, internalCapacityCheckDisabled: config.isInternalCapacityCheckDisabled, maximumAdditionalMatchedTokens, internalCapacity, externalCapacity: totalCapacity, timestamp: pin.timestamp, gracePeriod: config.getTwapGracePeriod }), depositPath = depositReachability.depositPath, depositReachabilityUnknown = depositReachability.depositReachabilityUnknown, depositControls = depositReachability.depositControls,
    idleSupplyPath = idleNet > 0n && !config.isEmergencyMode && vaults.some((x) => BigInt(x.allocation) > 0n),
    unknownValueBearingDependency = vaults.some((x) => x.dependency.sourceStatus !== "SOURCE_RUNTIME_BOUND_EXACT" && (x.active || BigInt(x.allocation) > 0n || BigInt(x.shares) > 0n || BigInt(x.value) > 0n)) || dependencies.some((x) => x.sourceStatus === "UNBOUND");
  return { accounting: { ...initial.storage, idleAssetBalance: String(idle), idleGross: idleGross.toString(), idleNet: idleNet.toString(), totalUsdcFormula: "max(idleGross-accumulatedProtocolFees,0)+totalVaultValue", totalUsdcValue: String(config.getTotalUsdcValue), totalVaultValue: String(config.getTotalVaultValue), totalAvailableCapacity: String(config.getTotalAvailableCapacity), totalAvailableInternalCapacity: String(config.getTotalAvailableInternalCapacity) },
    controls: config, dependencies, externalVaults: vaults, markets, roles, reconciliation: { marketPoolShareSum: marketPoolShareSum.toString(), totalPoolShares: initial.storage.totalPoolShares, pass: true },
    materiality: { materialValue: materialValue.toString(), components: { idleGross: idleGross.toString(), idleNet: idleNet.toString(), fees: fees.toString(), vaultRecoverable: vaultValue.toString(), storedPoolAssets: storedPoolAssets.toString(), marketLiabilitiesAndBalances: marketLiability.toString() }, hasMaterialValue: materialValue > 0n,
      withdrawalPath, depositPath, depositControls, depositReachabilityUnknown, idleSupplyPath, publicAction: withdrawalPath || depositPath || idleSupplyPath, pathActive: withdrawalPath || depositPath || idleSupplyPath, unknownValueBearingDependency } };
}
function saturatingMaxUpdate(counter, oldYes, oldNo, newYes, newNo) { const oldMax = oldYes > oldNo ? oldYes : oldNo, newMax = newYes > newNo ? newYes : newNo; if (newMax > oldMax) return counter + newMax - oldMax; const reduction = oldMax - newMax; return reduction >= counter ? 0n : counter - reduction; }
function simulateDepositCandidate(input, yesAmount, noAmount) { const oldYes = BigInt(input.marketYes || 0), oldNo = BigInt(input.marketNo || 0), yes = BigInt(yesAmount), no = BigInt(noAmount), initialCounter = BigInt(input.maximumAdditionalMatchedTokens), depositedYes = oldYes + yes, depositedNo = oldNo + no,
    afterDepositCounter = saturatingMaxUpdate(initialCounter, oldYes, oldNo, depositedYes, depositedNo), paired = depositedYes < depositedNo ? depositedYes : depositedNo, finalYes = depositedYes - paired, finalNo = depositedNo - paired,
    finalCounter = saturatingMaxUpdate(afterDepositCounter, depositedYes, depositedNo, finalYes, finalNo), internalPass = Boolean(input.internalCapacityCheckDisabled) || finalCounter <= BigInt(input.internalCapacity), externalRequired = paired > 0n,
    externalPass = !externalRequired || !input.emergencyMode && BigInt(input.externalCapacity) >= paired;
  return { yesAmount: yes.toString(), noAmount: no.toString(), preYes: oldYes.toString(), preNo: oldNo.toString(), initialCounter: initialCounter.toString(), afterDepositCounter: afterDepositCounter.toString(), paired: paired.toString(), finalYes: finalYes.toString(), finalNo: finalNo.toString(), finalMaximumAdditional: finalCounter.toString(), internalPass, externalRequired, externalPass, reachable: yes + no > 0n && internalPass && externalPass }; }
function deriveDepositControls(input) { const unpaused = !input.pausedAll && !input.pausedDeposits && Number(input.marketCount) > 0, base = { ...input, marketYes: input.pairedMarketYes || 0, marketNo: input.pairedMarketNo || 0 },
    oneSidedWitness = simulateDepositCandidate(base, input.oneSidedYesAmount ?? 1, input.oneSidedNoAmount ?? 0), pairedWitness = simulateDepositCandidate(base, input.pairedYesAmount ?? 1, input.pairedNoAmount ?? 1), oneSidedDepositPath = unpaused && oneSidedWitness.reachable, pairedDepositPath = unpaused && BigInt(pairedWitness.yesAmount) > 0n && BigInt(pairedWitness.noAmount) > 0n && pairedWitness.reachable;
  return { unpaused, internalCapacityCheckDisabled: Boolean(input.internalCapacityCheckDisabled), maximumAdditionalMatchedTokens: BigInt(input.maximumAdditionalMatchedTokens).toString(), internalCapacity: BigInt(input.internalCapacity).toString(), externalCapacity: BigInt(input.externalCapacity).toString(), minimumPositiveDeposit: "1", sequentialSaturatingSourceSimulation: true,
    oneSidedWitness, pairedWitness, oneSidedDepositPath, pairedDepositPath, publicDepositPath: oneSidedDepositPath || pairedDepositPath }; }
function mintGuard(amount, lossIndex) { const assets = BigInt(amount), index = BigInt(lossIndex); return { lossIndex: index.toString(), nonzeroIndex: index > 0n, mintedShares: index > 0n ? (assets * 1000000000000000000n / index).toString() : "0", pass: assets === 0n || index > 0n && assets * 1000000000000000000n / index > 0n }; }
function deriveMarketDepositReachability(markets, input) { const depositsUnpaused = !input.pausedAll && !input.pausedDeposits, now = BigInt(input.timestamp), candidates = markets.map((market) => { const last = BigInt(market.twapState[5]), fresh = last > 0n && last <= now && now - last <= BigInt(input.gracePeriod), controls = deriveDepositControls({ ...input, marketCount: 1, pairedMarketYes: market.unpaired.yes, pairedMarketNo: market.unpaired.no, pairedYesAmount: 1, pairedNoAmount: 1 }), applyGuards = (witness) => { const mintGuards = { yes: mintGuard(witness.yesAmount, market.indexes.lossYes), no: mintGuard(witness.noAmount, market.indexes.lossNo) }; return { ...witness, mintGuards, storedLossIndexes: { yes: String(market.lossIndexYes), no: String(market.lossIndexNo), evidenceOnly: true }, reachable: witness.reachable && mintGuards.yes.pass && mintGuards.no.pass }; }, oneSidedWitness = applyGuards(controls.oneSidedWitness), pairedWitness = applyGuards(controls.pairedWitness); return { conditionId: market.conditionId, twapFresh: fresh, lastTwapUpdate: last.toString(), gracePeriod: String(input.gracePeriod), oneSidedWitness, pairedWitness, reachable: fresh && depositsUnpaused && (oneSidedWitness.reachable || pairedWitness.reachable) }; }), exact = candidates.find((x) => x.reachable) || null, depositPath = Boolean(exact), unknown = depositsUnpaused && !depositPath;
  return { depositPath, depositReachabilityUnknown: unknown, depositControls: { evaluatedMarketCount: markets.length, candidates, exactWitnessConditionId: exact?.conditionId || null, publicInitializationCapability: depositsUnpaused, batchVectorCompleteness: depositPath ? "WITNESS_SUFFICIENT" : depositsUnpaused ? "UNKNOWN_OTHER_VECTOR_OR_NEW_MARKET" : "GLOBAL_PAUSE_PROVES_NONE", reachability: depositPath ? "EXACT_WITNESS" : unknown ? "UNKNOWN" : "PROVEN_NONE" } }; }
async function collectHistory(groups, pin, sweep, current, source, model, context, decodedLogs = null) {
  const a = model.addresses, semanticLogs = decodedLogs || sweep.rows.map(logSemantic), histories = {}, sourceByContract = Object.fromEntries(source.artifacts.map((x) => [x.contract, x])), proxyRuntime = expectedProxyRuntime(source, context),
    historyVaultArtifact = authorityArtifact(context, sourceByContract.RobinStakingVault), historyExtensionArtifact = authorityArtifact(context, sourceByContract.RobinStakingVaultExtension),
    historyTwapArtifact = authorityArtifact(context, sourceByContract.RobinTwapOracle), historyVaultIface = new Interface([...historyVaultArtifact.abi, ...historyExtensionArtifact.abi]), historyTwapIface = new Interface(historyTwapArtifact.abi), expectedCommitment = (surface) => { if (surface.endsWith("Proxy")) return source.declarations.proxyRuntimeAuthority.runtimeSha256; const binding = model.expectedBindings.find((x) => x.surface === surface), row = sourceByContract[binding.artifact], artifact = authorityArtifact(context, row); let code = artifactTemplate(artifact); for (const contracts of Object.values(artifact.deployedBytecode.linkReferences || {})) for (const refs of Object.values(contracts)) for (const ref of refs) code = mask(code, ref.start, ref.length); if (["RobinStakingVault", "RobinTwapOracle", "RobinLens"].includes(binding.artifact)) for (const refs of Object.values(artifact.deployedBytecode.immutableReferences || {})) for (const ref of refs) code = mask(code, ref.start, ref.length); if (["AccountingLib", "IndexCalcLib", "PolymarketLib", "VaultLib"].includes(binding.artifact)) code = mask(code, 1, 20); return sha256(Buffer.from(code.slice(2), "hex")); };
  for (const [proxy, expected] of [["vaultProxy", a.vaultImplementation], ["twapProxy", a.twapImplementation]]) {
    const events = semanticLogs.filter((x) => x.name === "Upgraded" && x.address === a[proxy]); if (!events.length || events.length > CAPS.upgrades) fail(STATUSES.RUNTIME, "HISTORY", "UPGRADE_HISTORY_INCOMPLETE");
    const final = events.at(-1), slot = proxy === "vaultProxy" ? a.vaultImplementation : a.twapImplementation; if (final.implementation !== slot) fail(STATUSES.RUNTIME, "HISTORY", "FINAL_EVENT_SLOT_MISMATCH");
    const adoption = events.filter((x) => x.implementation === expected); if (adoption.length !== 1) fail(STATUSES.RUNTIME, "HISTORY", "V2_ADOPTION_NOT_UNIQUE"); const event = adoption[0], block = BigInt(event.blockNumber);
    if (events.filter((x) => x.blockNumber === event.blockNumber).length > 1) fail(STATUSES.ENUM, "HISTORY", "SAME_BLOCK_UPGRADE_AMBIGUITY");
    const parentHeader = await dualHeader(groups, block - 1n, context), postHeader = await dualHeader(groups, block, context); if (event.blockHash !== postHeader.hash || postHeader.parentHash !== parentHeader.hash) fail(STATUSES.RUNTIME, "HISTORY", "ADOPTION_HEADER_BINDING_MISMATCH"); const parentImpl = addressWord(await dualStorage(groups, a[proxy], IMPLEMENTATION_SLOT, parentHeader, context, true)),
      postImpl = addressWord(await dualStorage(groups, a[proxy], IMPLEMENTATION_SLOT, postHeader, context, true));
    if (parentImpl === expected || postImpl !== expected) fail(STATUSES.RUNTIME, "HISTORY", "POST_UPGRADE_SLOT_MISMATCH"); const parentCode = await dualCode(groups, parentImpl, parentHeader, context, true), postCode = await dualCode(groups, postImpl, postHeader, context, true);
    if (parentCode === "0x" || postCode === "0x") fail(STATUSES.ARCHIVE, "HISTORY", "PARENT_POST_CODE_EMPTY"); const binding = model.expectedBindings.find((x) => x.surface === (proxy === "vaultProxy" ? "vaultImplementation" : "twapImplementation")),
      artifact = authorityArtifact(context, sourceByContract[binding.artifact]), postComparison = compareRuntime(artifact, postCode, binding, a); if (!postComparison.exact) fail(STATUSES.RUNTIME, "HISTORY", "POST_UPGRADE_RUNTIME_NOT_EXACT");
    let postExtension = null; if (proxy === "vaultProxy") { postExtension = addressWord(await dualStorage(groups, a.vaultProxy, EXTENSION_SLOT, postHeader, context, true)); if (postExtension !== a.vaultExtension) fail(STATUSES.RUNTIME, "HISTORY", "ADOPTION_EXTENSION_SLOT_MISMATCH"); } const requiredRuntimeKeys = proxy === "vaultProxy" ? ["vaultProxy", "vaultImplementation", "vaultExtension", "AccountingLib", "IndexCalcLib", "PolymarketLib", "VaultLib"] : ["twapProxy", "twapImplementation"], exactPostRuntimes = {};
    for (const surface of requiredRuntimeKeys) { const address = a[surface] || a.libraries?.[surface], code = await dualCode(groups, address, postHeader, context, true); if (surface.endsWith("Proxy")) { if (code !== proxyRuntime) fail(STATUSES.RUNTIME, "HISTORY", "ADOPTION_PROXY_RUNTIME_NOT_EXACT"); exactPostRuntimes[surface] = sha256(Buffer.from(code.slice(2), "hex")); }
      else { const expectedBinding = model.expectedBindings.find((x) => x.surface === surface), expectedArtifact = authorityArtifact(context, sourceByContract[expectedBinding.artifact]), compared = compareRuntime(expectedArtifact, code, expectedBinding, a); if (!compared.exact) fail(STATUSES.RUNTIME, "HISTORY", "ADOPTION_REQUIRED_RUNTIME_NOT_EXACT"); exactPostRuntimes[surface] = compared.normalizedSha256; } if (exactPostRuntimes[surface] !== expectedCommitment(surface)) fail(STATUSES.RUNTIME, "HISTORY", "ADOPTION_COMMITMENT_MISMATCH"); }
    histories[proxy] = { events, adoption: event, parent: { header: semanticHeader(parentHeader), implementation: parentImpl, codeKeccak256: keccak256(parentCode) },
      post: { header: semanticHeader(postHeader), implementation: postImpl, postExtensionSlot: postExtension, postExtensionSlotCommitment: postExtension ? sha256(Buffer.from(canonical({ blockHash: postHeader.hash, slot: EXTENSION_SLOT, value: postExtension }))) : null, codeKeccak256: keccak256(postCode), normalizedSha256: postComparison.normalizedSha256, comparison: "EXACT", requiredRuntimeKeys, exactPostRuntimes } };
  }
  const adoptionBlock = BigInt(histories.vaultProxy.adoption.blockNumber), preexisting = semanticLogs.filter((x) => x.name === "MarketInitialized" && x.address === a.vaultProxy && BigInt(x.blockNumber) < adoptionBlock).map((x) => x.conditionId), uniquePreexisting = [...new Set(preexisting)], marketTransitions = {};
  for (const conditionId of uniquePreexisting) {
    const base = mappingBase(conditionId, ACCOUNTING_SLOT), parentHeader = await dualHeader(groups, adoptionBlock - 1n, context), postHeader = await dualHeader(groups, adoptionBlock, context),
      parentWord = await dualStorage(groups, a.vaultProxy, addSlot(base, 9), parentHeader, context, true), postWord = await dualStorage(groups, a.vaultProxy, addSlot(base, 9), postHeader, context, true);
    const relevant = semanticLogs.filter((x) => x.conditionId === conditionId && ["TwapUpdated", "IndexesUpdated"].includes(x.name) && BigInt(x.blockNumber) >= adoptionBlock);
    const deposits = semanticLogs.filter((x) => ["Deposited", "Withdrawn"].includes(x.name) && x.conditionIds?.includes(conditionId) && BigInt(x.blockNumber) >= adoptionBlock);
    if ([...relevant, ...deposits].some((x) => BigInt(x.blockNumber) === adoptionBlock)) fail(STATUSES.ENUM, "HISTORY", "SAME_BLOCK_TRANSITION_AMBIGUITY");
    const allTransitions = [...relevant, ...deposits], first = {}; for (const kind of ["TwapUpdated", "IndexesUpdated"]) first[kind] = relevant.find((x) => x.name === kind) || null;
    for (const kind of ["Deposited", "Withdrawn"]) first[kind] = deposits.find((x) => x.name === kind) || null;
    const transitionStates = {};
    for (const [kind, transition] of Object.entries(first)) if (transition) { const transitionBlock = BigInt(transition.blockNumber); if (allTransitions.filter((x) => BigInt(x.blockNumber) === transitionBlock).length !== 1) fail(STATUSES.ENUM, "HISTORY", "SAME_BLOCK_TRANSITION_AMBIGUITY");
      const captureState = async (header) => { const marketRaw = await dualFunction(groups, a.vaultProxy, historyVaultIface, "getMarketState", [conditionId], header, context, true),
          market = decodeMarketTuple(marketRaw, decodePackedLastTwap(await dualStorage(groups, a.vaultProxy, addSlot(base, 9), header, context, true))),
          indexes = await dualFunction(groups, a.vaultProxy, historyVaultIface, "getMarketIndexes", [conditionId, market.lastTwapPriceYes], header, context, true), twapState = await dualFunction(groups, a.twapProxy, historyTwapIface, "getMarketState", [conditionId], header, context, true), implementations = {}, exactRuntimes = {}, polymarketBase = mappingBase(conditionId, addSlot(POLYMARKET_SLOT, 7)),
          yesPositionId = uint256Word(await dualStorage(groups, a.vaultProxy, polymarketBase, header, context, true)), noPositionId = uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(polymarketBase, 1), header, context, true)), packedTokenInfo = uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(polymarketBase, 2), header, context, true)),
          tokenInfo = { yesPositionId: yesPositionId.toString(), noPositionId: noPositionId.toString(), negRisk: (packedTokenInfo & 0xffn) === 1n, collateral: `0x${((packedTokenInfo >> 8n) & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}` };
        if (!yesPositionId || !noPositionId || (packedTokenInfo & 0xffn) > 1n || packedTokenInfo >> 168n !== 0n || tokenInfo.collateral === ZERO_ADDRESS) fail(STATUSES.ENUM, "HISTORY", "TRANSITION_TOKEN_STORAGE_INVALID");
        for (const [proxy, surface] of [["vaultProxy", "vaultImplementation"], ["twapProxy", "twapImplementation"]]) { const implementation = addressWord(await dualStorage(groups, a[proxy], IMPLEMENTATION_SLOT, header, context, true)); if (implementation !== a[surface]) fail(STATUSES.RUNTIME, "HISTORY", "TRANSITION_IMPLEMENTATION_MISMATCH");
          const code = await dualCode(groups, implementation, header, context, true), binding = model.expectedBindings.find((x) => x.surface === surface), artifact = authorityArtifact(context, sourceByContract[binding.artifact]), compared = compareRuntime(artifact, code, binding, a);
          if (!compared.exact) fail(STATUSES.RUNTIME, "HISTORY", "TRANSITION_RUNTIME_NOT_EXACT"); implementations[proxy] = implementation; exactRuntimes[surface] = compared.normalizedSha256; }
        const extension = addressWord(await dualStorage(groups, a.vaultProxy, EXTENSION_SLOT, header, context, true)); if (extension !== a.vaultExtension) fail(STATUSES.RUNTIME, "HISTORY", "TRANSITION_EXTENSION_SLOT_MISMATCH");
        const extensionCode = await dualCode(groups, extension, header, context, true), extensionBinding = model.expectedBindings.find((x) => x.surface === "vaultExtension"), extensionCompared = compareRuntime(historyExtensionArtifact, extensionCode, extensionBinding, a);
        if (!extensionCompared.exact) fail(STATUSES.RUNTIME, "HISTORY", "TRANSITION_EXTENSION_RUNTIME_NOT_EXACT");
        for (const proxy of ["vaultProxy", "twapProxy"]) { const observedProxy = await dualCode(groups, a[proxy], header, context, true); if (observedProxy !== proxyRuntime) fail(STATUSES.RUNTIME, "HISTORY", "TRANSITION_PROXY_RUNTIME_NOT_EXACT"); exactRuntimes[proxy] = sha256(Buffer.from(proxyRuntime.slice(2), "hex")); }
        for (const surface of ["AccountingLib", "IndexCalcLib", "PolymarketLib", "VaultLib"]) { const binding = model.expectedBindings.find((x) => x.surface === surface), artifact = authorityArtifact(context, sourceByContract[binding.artifact]), compared = compareRuntime(artifact, await dualCode(groups, a.libraries[surface], header, context, true), binding, a); if (!compared.exact) fail(STATUSES.RUNTIME, "HISTORY", "TRANSITION_LIBRARY_RUNTIME_NOT_EXACT"); exactRuntimes[surface] = compared.normalizedSha256; }
        return { header: semanticHeader(header), slot9: market.slot9, market, tokenInfo, indexes, twapState, totalPoolShares: uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(ACCOUNTING_SLOT, 2), header, context, true)).toString(),
          totalPoolAssetsStored: uint256Word(await dualStorage(groups, a.vaultProxy, addSlot(ACCOUNTING_SLOT, 3), header, context, true)).toString(), implementations, extension,
          exactRuntimes: { ...exactRuntimes, vaultExtension: extensionCompared.normalizedSha256 }, proxyRuntimeSha256: sha256(Buffer.from(proxyRuntime.slice(2), "hex")) }; };
      const parentTransitionHeader = await dualHeader(groups, transitionBlock - 1n, context), postTransitionHeader = await dualHeader(groups, transitionBlock, context);
      if (transition.blockHash !== postTransitionHeader.hash || postTransitionHeader.parentHash !== parentTransitionHeader.hash) fail(STATUSES.ENUM, "HISTORY", "TRANSITION_HEADER_BINDING_MISMATCH");
      transitionStates[kind] = { event: transition, parent: await captureState(parentTransitionHeader), post: await captureState(postTransitionHeader) }; }
    marketTransitions[conditionId] = { parentSlot9: decodePackedLastTwap(parentWord), postSlot9: decodePackedLastTwap(postWord), firstPostUpgrade: first,
      transitionStates, transitionCommitment: sha256(Buffer.from(canonical([...relevant, ...deposits]))) };
  }
  return { upgrades: histories, preexistingMarketCount: uniquePreexisting.length, preexistingMarkets: uniquePreexisting, marketTransitions,
    authoritativeSweep: { fromBlock: BASE_DEPLOYMENT_BLOCK.toString(), toBlock: pin.number.toString(), negotiatedWidth: sweep.width, projection: sweep.projection, intervalCount: sweep.coverage.length,
      coverage: sweep.coverage, normalizedLogCount: sweep.rows.length, normalizedLogCommitment: sha256(Buffer.from(canonical(sweep.rows.map((x) => clean(x))))) } };
}
function familyCommitments(context) {
  const project = (rows) => ({ count: rows.length, sequence: rows.map((x) => x.commitment), aggregateSha256: sha256(Buffer.from(canonical(rows.map((x) => x.commitment)))) });
  const A = project(context.familySequences.A), B = project(context.familySequences.B); if (A.count !== B.count || A.aggregateSha256 !== B.aggregateSha256 || !same(A.sequence, B.sequence)) fail(STATUSES.FAMILY, "COMMITMENT", "INDEPENDENT_SEQUENCE_DISAGREEMENT"); return { A, B };
}
async function collectRuntime(qualified, source, model, context) {
  const groups = qualified.groups, pin = qualified.pin; context.model = model; context.familySequences = { A: [], B: [] };
  const initialHeader = await dualHeader(groups, pin.number, context, false); if (!same(semanticHeader(initialHeader), semanticHeader(pin))) fail(STATUSES.PIN, "CURRENT", "INITIAL_PIN_MISMATCH");
  const addresses = [model.addresses.vaultProxy, model.addresses.twapProxy, model.addresses.timelock], initial = await coreSnapshot(groups, pin, source, model, context), plan = await negotiateHistoryWidth(groups, addresses, BASE_DEPLOYMENT_BLOCK, pin.number, context), sweep = await authoritativeLogs(groups, addresses, BASE_DEPLOYMENT_BLOCK, pin.number, context, plan.width); sweep.projection = plan.projection;
  const semanticLogs = sweep.rows.map((x) => logSemantic(x, initial.interfaces)), sweepActual = { A: context.budget.historyCount("A"), B: context.budget.historyCount("B") }; if (!same(sweepActual, plan.projection.projectedHistoryCalls)) fail(STATUSES.ENUM, "HISTORY_PLAN", "SWEEP_PLAN_ACTUAL_MISMATCH"); sweep.projection.actualHistoryCalls = { ...sweepActual }; sweep.projection.actualEqualsProjected = true; const criticalPlan = buildCriticalHistoryPlan(semanticLogs, model), executionDescriptors = criticalPlan.executionDescriptors; delete criticalPlan.executionDescriptors; const current = await collectCurrent(groups, pin, initial, semanticLogs, source, model, context), preCritical = { globalCalls: context.budget.calls, historyCalls: { A: context.budget.historyCount("A"), B: context.budget.historyCount("B") }, methodCalls: { ...context.budget.methods } }; if (criticalPlan.countPerFamily > CAPS.historyCallsPerFamily - preCritical.historyCalls.A || criticalPlan.countPerFamily > CAPS.historyCallsPerFamily - preCritical.historyCalls.B || preCritical.globalCalls + criticalPlan.countPerFamily * 2 > CAPS.logicalCalls) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_PLAN_CAP"); context.criticalExecution = { public: criticalPlan.descriptors, execution: executionDescriptors, indexes: { A: 0, B: 0 }, actual: { A: [], B: [] }, bindings: { A: { blocks: {}, addresses: {}, values: {} }, B: { blocks: {}, addresses: {}, values: {} } } }; context.criticalReservation = { active: true, remaining: { A: criticalPlan.countPerFamily, B: criticalPlan.countPerFamily } };
  const history = await collectHistory(groups, pin, sweep, current, source, model, context, semanticLogs), afterCritical = { A: context.budget.historyCount("A"), B: context.budget.historyCount("B") }, afterCriticalGlobal = context.budget.calls, actualMethodsAfter = { ...context.budget.methods }; context.criticalReservation.active = false; const sequence = Object.fromEntries(["A", "B"].map((family) => [family, { count: context.criticalExecution.actual[family].length, sequence: context.criticalExecution.actual[family], aggregateSha256: sha256(Buffer.from(canonical(context.criticalExecution.actual[family]))) }])); if (context.criticalReservation.remaining.A !== 0 || context.criticalReservation.remaining.B !== 0 || context.criticalExecution.indexes.A !== criticalPlan.countPerFamily || context.criticalExecution.indexes.B !== criticalPlan.countPerFamily || !same(sequence.A, sequence.B) || afterCritical.A - preCritical.historyCalls.A !== criticalPlan.countPerFamily || afterCritical.B - preCritical.historyCalls.B !== criticalPlan.countPerFamily || afterCriticalGlobal !== preCritical.globalCalls + criticalPlan.countPerFamily * 2) fail(STATUSES.ENUM, "HISTORY_PLAN", "CRITICAL_PLAN_ACTUAL_MISMATCH"); history.authoritativeSweep.criticalPlan = { ...criticalPlan, preCritical, beforeCounters: preCritical.historyCalls, actualCounters: afterCritical, actualGlobalAfter: afterCriticalGlobal, actualMethodsAfter, actualCriticalCalls: { A: afterCritical.A - preCritical.historyCalls.A, B: afterCritical.B - preCritical.historyCalls.B }, actualSequenceCommitments: sequence };
  const terminalHistoryBefore = { A: context.budget.historyCount("A"), B: context.budget.historyCount("B") }, terminalMethodsBefore = { ...context.budget.methods }, terminalHeader = await dualHeader(groups, pin.number, context, false), terminal = await coreSnapshot(groups, pin, source, model, context), terminalHistoryAfter = { A: context.budget.historyCount("A"), B: context.budget.historyCount("B") }, terminalMethodsAfter = { ...context.budget.methods }, terminalMethodDelta = Object.fromEntries(Object.keys(terminalMethodsAfter).map((method) => [method, (terminalMethodsAfter[method] || 0) - (terminalMethodsBefore[method] || 0)]).filter(([, count]) => count)), terminalGlobalAfter = context.budget.calls, terminalPlannedLogicalCalls = 4 + (4 + model.expectedBindings.filter((x) => x.artifact).length * 2) + 44 + 48; if (terminalGlobalAfter - afterCriticalGlobal !== terminalPlannedLogicalCalls || !same(terminalHistoryBefore, terminalHistoryAfter)) fail(STATUSES.ENUM, "TERMINAL", "TERMINAL_COUNTER_MISMATCH"); history.authoritativeSweep.criticalPlan.terminalPhase = { beforeGlobalCalls: afterCriticalGlobal, afterGlobalCalls: terminalGlobalAfter, logicalDelta: terminalGlobalAfter - afterCriticalGlobal, plannedLogicalCalls: terminalPlannedLogicalCalls, historyBefore: terminalHistoryBefore, historyAfter: terminalHistoryAfter, methodsBefore: terminalMethodsBefore, methodsAfter: terminalMethodsAfter, methodDelta: terminalMethodDelta };
  if (!same(semanticHeader(initialHeader), semanticHeader(terminalHeader)) || initial.commitment !== terminal.commitment) fail(STATUSES.PIN, "TERMINAL", "PRE_POST_CONTINUITY");
  if (current.materiality.unknownValueBearingDependency) fail(STATUSES.ENUM, "MATERIALITY", "UNKNOWN_VALUE_BEARING_DEPENDENCY");
  if (current.materiality.depositReachabilityUnknown) fail(STATUSES.ENUM, "MATERIALITY", "ENUMERATION_OR_DEPENDENCY");
  const active = current.materiality.hasMaterialValue || current.materiality.publicAction; if (!active && (!current.controls.isPausedAll || current.materiality.withdrawalPath || current.materiality.depositPath || current.materiality.idleSupplyPath)) fail(STATUSES.ENUM, "MATERIALITY", "DORMANCY_GLOBAL_PAUSE_NOT_PROVEN"); const status = active ? STATUSES.ACTIVE : STATUSES.DORMANT, families = familyCommitments(context);
  return { status, pin: semanticHeader(pin), topology: initial.topology, codeEvidence: initial.codeEvidence, current, history, familyCommitments: families,
    queryCompleteness: { currentConfig: true, accountingStorage: true, coreDependencies: true, externalVaults: true, allocationPreviews: true, markets: true, marketTokenStorage: true, roles: true,
      materiality: true, fullUpgradeHistory: true, parentPost: true, transitionParentPostState: true, transitions: true, terminalRecheck: true } };
}

module.exports = { STEM, IMPLEMENTATION_SLOT, ADMIN_SLOT, BEACON_SLOT, EXTENSION_SLOT, ACCOUNTING_SLOT, YIELD_SLOT, POLYMARKET_SLOT, PAUSABLE_SLOT, SIGNATURES_SLOT, BASE_DEPLOYMENT_BLOCK, V2_CREATION_BLOCK, CAPS, STATUSES, IANA_SPECIAL_PURPOSE_SNAPSHOT, IPV4_NON_GLOBAL, IPV6_NON_GLOBAL,
  ALLOWED_RPC, EVENT_TOPICS, COMPLETE_TOPICS, GateError, sha256, canonical, same, hex, quantity, qhex, clean, slotAddress, pinArg, parseHeader, semanticHeader, parseSafeUrl,
  registrableDomain, familyKey, mappedIpv4, ipv4Number, ipv6Bytes, prefixMatch, isGloballyRoutable, extractCandidates, readBrokerBuffers, monotonicNow, AbsoluteDeadline, cancelableLookup, resolveSafe, resolveCandidates, resolutionSet, verifyDnsBindings, httpsTransport, Budget, criticalTargetAddress, consumeCriticalDescriptor, bindCriticalResult, boundedRpcEnvelope, rpc, dual, qualifyCandidate, qualify,
  mask, artifactTemplate, expectedWord, cborLength, parseCborItem, parseMetadataTrailer, metadataDigestOnlyMismatch, compareRuntime, authorityArtifact, authorityBytes, expectedProxyRuntime, splitInclusive, normalizeLog, logCommitment, collectLogs,
  addSlot, mappingBase, uint256Word, boolWord, addressWord, deepResult, dualHeader, dualStorage, dualCode, dualFunction, dualFunctionWithFallback, normalizeCompleteLog, sortCompleteLogs, HISTORY_WIDTHS, historyProjection, allowlistedRangeLimit, negotiateHistoryWidth, authoritativeLogs, logSemantic, criticalHistoryDescriptors, buildCriticalHistoryPlan,
  decodePackedLastTwap, decodeMarketTuple, reconstructVaultOrder, coreSnapshot, collectCurrent, saturatingMaxUpdate, simulateDepositCandidate, deriveDepositControls, mintGuard, deriveMarketDepositReachability, collectHistory, familyCommitments, collectRuntime };
if (require.main === module) { process.stdout.write("ROBIN_RUNTIME_R2_COLLECTION_DIRECT_REJECT\n"); process.exitCode = 1; }
