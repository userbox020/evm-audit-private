#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { classifyOperatorFamily } = require("./lib/common-finalized-rpc-preflight");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_FILE = path.join(ROOT, "rpc_endpoints.txt");
const EVENTS_FILE = path.join(ROOT, "targets", "silo-contracts-v2", "silo-vaults", "contracts", "libraries", "EventsLib.sol");
const STANDARD_FILE = path.join(ROOT, "targets", "silo-contracts-v2", "flattened", "silo_vaults", "arbitrum_one", "SiloVaultsFactory.standard.json");
const R2_FILE = path.join(ROOT, "tools", "analyze-critical-silo-v3-public-allocator-runtime-binding-gate0-step4-r2.js");
const V1_FILE = path.join(ROOT, "tools", "analyze-critical-silo-v3-public-allocator-runtime-binding-gate0-step4.js");
const PINS = Object.freeze({
  events: Object.freeze({ file: EVENTS_FILE, bytes: 6383, sha256: "f3ae8742f2453e926e558032a4e79183fe9729469433f8d47ab86e40fddbda47" }),
  standard: Object.freeze({ file: STANDARD_FILE, bytes: 346070, sha256: "6d536b5725d40f67ae0bd8eb754cd711b628f2419c347965889b7ee4e2abe0aa" }),
  r2: Object.freeze({ file: R2_FILE, bytes: 30900, sha256: "d49b8841566892383ca0f6cfd2e5f31ca916ddb80f9c35d4405eda179afb8088" }),
  v1: Object.freeze({ file: V1_FILE, bytes: 40270, sha256: "eb824f1105cb297fd3f2d581a261770810422c3b52b4240565d0a7e44e656396" })
});
const CATEGORIES = Object.freeze(["FactoryCreation", "SetCap", "SetIsAllocator", "SetSupplyQueue", "SetWithdrawQueue", "SetFee", "SetFlowCaps", "SetArbitraryLossThreshold"]);
const EVENT_NAMES = Object.freeze(["CreateSiloVault", ...CATEGORIES.slice(1)]);
const LIMITS = Object.freeze({ inventoryBytes: 1024 * 1024, candidates: 12, calls: 96, responseBytes: 2 * 1024 * 1024,
  totalResponseBytes: 16 * 1024 * 1024, logs: 256, windowBlocks: 8192, decodedItems: 512, requestMs: 15000, wallMs: 180000 });
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"]);
const PHASES = new Set(["NONE", "AUTHORITY", "ABI", "INVENTORY", "QUALIFICATION", "HEADER", "LOG", "TERMINAL", "CAP"]);
const CODES = new Set(["NONE", "AUTHORITY_INVALID", "ABI_INVALID", "INVENTORY_INVALID", "INVENTORY_MUTATED", "TWO_FAMILIES_UNAVAILABLE",
  "COMMON_FINALIZED_UNAVAILABLE", "HEADER_INVALID", "HEADER_DISAGREEMENT", "LOG_INVALID", "LOG_DISAGREEMENT", "UNBOUND_EMITTER", "TERMINAL_RECHECK_FAILED", "READ_CAP", "UNEXPECTED"]);
const STATUS_COMPLETE = "CURRENT_WINDOW_COMPLETE";
const STATUS_INCOMPLETE = "INCOMPLETE";

class WindowError extends Error {
  constructor(phase, code) { super(code); this.name = "WindowError"; this.phase = PHASES.has(phase) ? phase : "CAP"; this.code = CODES.has(code) ? code : "UNEXPECTED"; }
}
const fail = (phase, code) => { throw new WindowError(phase, code); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","); }
function readPinned(record, readFile = fs.readFileSync) { let bytes; try { bytes = readFile(record.file); } catch (_) { fail("AUTHORITY", "AUTHORITY_INVALID"); } if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes); if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) fail("AUTHORITY", "AUTHORITY_INVALID"); return bytes; }

function splitTopLevel(value, separator = ",") {
  const rows = []; let depth = 0; let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(" || value[index] === "[") depth += 1;
    else if (value[index] === ")" || value[index] === "]") depth -= 1;
    else if (value[index] === separator && depth === 0) { rows.push(value.slice(start, index).trim()); start = index + 1; }
  }
  rows.push(value.slice(start).trim()); return rows.filter(Boolean);
}
function stripComments(source) { return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\r\n]*/gu, " "); }
function structMap(source) {
  const clean = stripComments(source), structs = new Map();
  for (const match of clean.matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/gu)) {
    const fields = match[2].split(";").map((row) => row.trim()).filter(Boolean).map((row) => row.split(/\s+/u)[0]); structs.set(match[1], fields);
  }
  return structs;
}
function canonicalType(raw, structs, stack = new Set()) {
  const arrays = raw.match(/(?:\[[0-9]*\])+$/u)?.[0] || "", base = arrays ? raw.slice(0, -arrays.length) : raw;
  if (structs.has(base)) {
    if (stack.has(base)) fail("ABI", "ABI_INVALID"); const next = new Set(stack); next.add(base);
    return `(${structs.get(base).map((field) => canonicalType(field, structs, next)).join(",")})${arrays}`;
  }
  if (/^(?:address|bool|string|bytes|bytes[0-9]+|u?int(?:[0-9]+)?)$/u.test(base)) return `${base}${arrays}`;
  if (/^(?:I[A-Z]\w*|[A-Z]\w*)$/u.test(base)) return `address${arrays}`;
  fail("ABI", "ABI_INVALID");
}
function deriveEventAuthority(eventsSource, standard) {
  const embedded = standard.sources?.["silo-vaults/contracts/libraries/EventsLib.sol"]?.content;
  const factorySource = standard.sources?.["silo-vaults/contracts/SiloVaultsFactory.sol"]?.content;
  const allocatorTypes = standard.sources?.["silo-vaults/contracts/interfaces/IPublicAllocator.sol"]?.content;
  if (typeof embedded !== "string" || embedded.replace(/\r\n/gu, "\n") !== eventsSource.replace(/\r\n/gu, "\n")
      || typeof factorySource !== "string" || !factorySource.includes("emit EventsLib.CreateSiloVault(") || typeof allocatorTypes !== "string") fail("AUTHORITY", "AUTHORITY_INVALID");
  const structs = structMap(allocatorTypes); const clean = stripComments(eventsSource); const events = [];
  for (const match of clean.matchAll(/event\s+(\w+)\s*\(([^;]*)\)\s*;/gu)) {
    if (!EVENT_NAMES.includes(match[1])) continue;
    const params = splitTopLevel(match[2]).map((row) => {
      const tokens = row.trim().split(/\s+/u), indexed = tokens.includes("indexed"), rawType = tokens[0];
      return { type: canonicalType(rawType, structs), indexed, name: tokens.at(-1) === "indexed" ? "" : tokens.at(-1) };
    });
    const signature = `${match[1]}(${params.map((row) => row.type).join(",")})`;
    const fragment = `event ${match[1]}(${params.map((row, index) => `${row.type}${row.indexed ? " indexed" : ""} ${row.name || `arg${index}`}`).join(",")})`;
    let iface; let topic; try { iface = new ethers.Interface([fragment]); topic = iface.getEvent(match[1]).topicHash.toLowerCase(); } catch (_) { fail("ABI", "ABI_INVALID"); }
    if (topic !== ethers.id(signature).toLowerCase()) fail("ABI", "ABI_INVALID");
    events.push(Object.freeze({ name: match[1], category: match[1] === "CreateSiloVault" ? "FactoryCreation" : match[1], signature, topic, iface }));
  }
  const byName = new Map(EVENT_NAMES.map((name) => [name, events.filter((row) => row.name === name)]));
  if (byName.get("CreateSiloVault").length !== 1 || ["SetCap", "SetIsAllocator", "SetSupplyQueue", "SetWithdrawQueue", "SetFlowCaps", "SetArbitraryLossThreshold"].some((name) => byName.get(name).length !== 1)
      || byName.get("SetFee").length !== 2 || new Set(events.map((row) => row.topic)).size !== events.length) fail("ABI", "ABI_INVALID");
  return Object.freeze(events);
}
function readAuthority(options = {}) {
  const readFile = options.readFile || fs.readFileSync; const bytes = Object.fromEntries(Object.entries(PINS).map(([key, record]) => [key, readPinned(record, readFile)]));
  let standard; try { standard = JSON.parse(bytes.standard); } catch (_) { fail("AUTHORITY", "AUTHORITY_INVALID"); }
  const r2 = options.r2Module || require("./analyze-critical-silo-v3-public-allocator-runtime-binding-gate0-step4-r2");
  const v1 = options.v1Module || require("./analyze-critical-silo-v3-public-allocator-runtime-binding-gate0-step4");
  if (r2.STANDARD_JSON_SHA256 !== PINS.standard.sha256 || r2.STANDARD_JSON_PATH.replace(/\\/gu, "/") !== path.relative(ROOT, STANDARD_FILE).replace(/\\/gu, "/")
      || r2.V1_HASHES?.["tools/analyze-critical-silo-v3-public-allocator-runtime-binding-gate0-step4.js"] !== PINS.v1.sha256
      || !bytes.r2.toString("utf8").includes("v1.VAULTS.map") || !r2.validateStandardJsonObject(standard)) fail("AUTHORITY", "AUTHORITY_INVALID");
  const factory = r2.FACTORIES?.filter((row) => row.chainId === 42161), vaultRows = v1.VAULTS?.filter((row) => row.chainId === 42161);
  if (factory?.length !== 1 || factory[0].chainHex !== "0xa4b1" || !/^0x[0-9a-f]{40}$/iu.test(factory[0].address || "") || !/^0x[0-9a-f]{64}$/iu.test(factory[0].runtimeHash || "")
      || !Array.isArray(vaultRows) || vaultRows.length < 1 || vaultRows.some((row) => !/^0x[0-9a-f]{40}$/iu.test(row.vault || "") || !/^0x[0-9a-f]{64}$/iu.test(row.runtimeHash || "") || !Number.isSafeInteger(row.creationBlock))) fail("AUTHORITY", "AUTHORITY_INVALID");
  const events = deriveEventAuthority(bytes.events.toString("utf8"), standard), target = ethers.getAddress(factory[0].address).toLowerCase();
  const vaults = vaultRows.map((row) => ethers.getAddress(row.vault).toLowerCase()), membership = new Set(vaults);
  const authority = { eventCount: events.length, categoryNames: [...CATEGORIES] };
  Object.defineProperties(authority, { factory: { value: target }, vaults: { value: Object.freeze(vaults) }, membership: { value: membership }, events: { value: events }, topics: { value: Object.freeze(events.map((row) => row.topic)) }, byTopic: { value: new Map(events.map((row) => [row.topic, row])) } });
  return Object.freeze(authority);
}

function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function readStableInventory() { let before; let after; let heldBefore; let heldAfter; let fd; let bytes; let real; try { before = fs.lstatSync(INVENTORY_FILE); real = fs.realpathSync.native(INVENTORY_FILE); if (!before.isFile() || before.isSymbolicLink() || real !== INVENTORY_FILE || before.size < 1 || before.size > LIMITS.inventoryBytes) fail("INVENTORY", "INVENTORY_INVALID"); fd = fs.openSync(INVENTORY_FILE, "r"); heldBefore = fs.fstatSync(fd); bytes = fs.readFileSync(fd); heldAfter = fs.fstatSync(fd); after = fs.lstatSync(INVENTORY_FILE); } catch (error) { if (error instanceof WindowError) throw error; fail("INVENTORY", "INVENTORY_INVALID"); } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} } if (bytes.length !== before.size || stable(identity(before)) !== stable(identity(after)) || stable(identity(heldBefore)) !== stable(identity(heldAfter)) || String(before.dev) !== String(heldBefore.dev) || String(before.ino) !== String(heldBefore.ino)) fail("INVENTORY", "INVENTORY_MUTATED"); return { text: bytes.toString("utf8"), identity: identity(after) }; }
function inventoryUnchanged(expected) { let stat; let real; try { stat = fs.lstatSync(INVENTORY_FILE); real = fs.realpathSync.native(INVENTORY_FILE); } catch (_) { fail("INVENTORY", "INVENTORY_MUTATED"); } if (!stat.isFile() || stat.isSymbolicLink() || real !== INVENTORY_FILE || stable(identity(stat)) !== stable(expected)) fail("INVENTORY", "INVENTORY_MUTATED"); }
function placeholder(url, context) { let decoded; try { decoded = decodeURIComponent(`${url.pathname} ${url.search}`); } catch (_) { return true; } return /(?:^|\.)(?:example|placeholder|invalid)(?:\.|$)/u.test(url.hostname.toLowerCase()) || /(?:\{|\}|<|>|\$\{|your[-_ ]?(?:api[-_ ]?)?key|replace[-_ ]?(?:me|this)|insert[-_ ]?(?:key|token)|placeholder|changeme|api[-_ ]?key[-_ ]?here)/iu.test(`${context} ${decoded}`); }
function canonicalFamilyLabel(value) {
  if (typeof value !== "string" || value.length > 256 || /https?:\/\//iu.test(value) || /\b(?:credentials?|secrets?|api[- _]?keys?|tokens?|authorization|bearer|origin|browser|session|custom[- _]?headers?)\b/iu.test(value)) return null;
  const tokens = value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().split(/\s+/u).filter((token) => token && !new Set(["arbitrum", "one", "chain", "mainnet", "public", "keyless", "open", "rpc", "rpcs", "endpoint", "endpoints", "provider", "operator", "section", "status", "https", "http", "url", "urls", "none", "auth", "no"]).has(token));
  return tokens.length && tokens.join(" ").length <= 128 ? tokens.join(" ") : null;
}
function parseInventoryText(text, operatorClassifier = classifyOperatorFamily) {
  if (typeof text !== "string" || Buffer.byteLength(text) < 1 || Buffer.byteLength(text) > LIMITS.inventoryBytes) fail("INVENTORY", "INVENTORY_INVALID");
  const rows = []; const seen = new Set(); const familyTokens = new Map(); let activeFamilyKey = null; let ordinal = 0;
  const opaqueFamily = (key) => { if (!key) return null; if (!familyTokens.has(key)) familyTokens.set(key, `inventory-family-${familyTokens.size}`); return familyTokens.get(key); };
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) activeFamilyKey = null;
    else if (!/https?:\/\//iu.test(trimmed)) activeFamilyKey = canonicalFamilyLabel(trimmed);
    for (const match of line.matchAll(/\barbitrum(?:[- _]+one)?\s+(https?:\/\/[^\s<'"`\])}]+)/giu)) {
      const localOrdinal = ordinal++; let url; try { url = new URL(match[1].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
      const context = line.replace(match[1], " "), lower = context.toLowerCase();
      const forbidden = /\b(?:restricted|unavailable|disabled|retired|deprecated|unsupported|failed|dead|pruned|exposed|leaked|compromised|app[- _]?scoped|credentialed|internal)\b|\bprivate[- _]?(?:only|endpoint|route)\b|\bdo[- ]?not[- ]?use\b/iu.test(lower) || /\b(?:credentials?|secrets?|api[- _]?keys?|tokens?)\s*[:=]?\s*(?:required|present|included|embedded|exposed)\b|\brequires?\b[^\r\n]{0,40}\b(?:credentials?|secrets?|api[- _]?keys?|tokens?|auth)\b/iu.test(lower) || /\b(?:origin[- _]?required|browser[- _]?only|session[- _]?auth|session|cookie|referer|cors)\b|\brequires?\b[^\r\n]{0,40}\borigin\b/iu.test(lower) || /\b(?:custom[- _]?headers?|authorization|bearer|x[- _]?api[- _]?key|proxy|batch)\b|\brequires?\b[^\r\n]{0,40}\bheaders?\b/iu.test(lower);
      const unsafe = url.protocol !== "https:" || Boolean(url.username || url.password || url.hash || url.search) || (url.port && url.port !== "443") || /(?:localhost|\.local|\.internal|\.invalid)$/u.test(url.hostname.toLowerCase()) || /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(url.hostname);
      if (forbidden || unsafe || placeholder(url, context) || seen.has(url.href)) continue;
      let classified = null; try { classified = operatorClassifier(url.href); } catch (_) {}
      const rowFamilyKey = canonicalFamilyLabel(line.slice(0, match.index));
      seen.add(url.href); rows.push({ url, family: opaqueFamily(rowFamilyKey || activeFamilyKey) || classified?.operatorFamily || null, ordinal: localOrdinal });
    }
  }
  return rows.sort((a, b) => a.ordinal - b.ordinal).slice(0, LIMITS.candidates);
}

class Budget { constructor(maxCalls = LIMITS.calls) { this.maxCalls = Math.min(LIMITS.calls, maxCalls); this.calls = 0; this.bytes = 0; this.started = Date.now(); } use() { if (++this.calls > this.maxCalls || Date.now() - this.started > LIMITS.wallMs) fail("CAP", "READ_CAP"); } add(bytes) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > LIMITS.responseBytes) fail("CAP", "READ_CAP"); this.bytes += bytes; if (this.bytes > LIMITS.totalResponseBytes) fail("CAP", "READ_CAP"); } }
async function fetchTransport({ candidate, envelope, timeoutMs }) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { const response = await fetch(candidate.url.href, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" }, body: JSON.stringify(envelope) }); if (response.status !== 200) throw new Error("transport"); const text = await response.text(); if (Buffer.byteLength(text) > LIMITS.responseBytes) fail("CAP", "READ_CAP"); return { value: JSON.parse(text), bytes: Buffer.byteLength(text) }; } catch (error) { if (error instanceof WindowError) throw error; throw new Error("transport"); } finally { clearTimeout(timer); } }
async function rpc(candidate, method, params, budget, transport) { if (!METHODS.has(method)) fail("CAP", "READ_CAP"); budget.use(); const envelope = { jsonrpc: "2.0", id: budget.calls, method, params }; let row; try { row = await transport({ candidate, envelope, timeoutMs: LIMITS.requestMs }); } catch (error) { if (error instanceof WindowError) throw error; throw new Error("transport"); } if (!row || !Number.isSafeInteger(row.bytes) || !row.value || row.value.jsonrpc !== "2.0" || row.value.id !== envelope.id || Object.hasOwn(row.value, "error") || !Object.hasOwn(row.value, "result")) throw new Error("transport"); budget.add(row.bytes); return row.value.result; }
function quantity(value) { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) throw new Error("quantity"); return BigInt(value); }
function header(value, expected = null) { try { if (!value || !/^0x[0-9a-f]{64}$/iu.test(value.hash || "") || !/^0x[0-9a-f]{64}$/iu.test(value.parentHash || "") || !/^0x[0-9a-f]{64}$/iu.test(value.stateRoot || "")) throw new Error("header"); const number = quantity(value.number), timestamp = quantity(value.timestamp); if (expected !== null && number !== expected) throw new Error("header"); return { number: number.toString(), hash: value.hash.toLowerCase(), parentHash: value.parentHash.toLowerCase(), stateRoot: value.stateRoot.toLowerCase(), timestamp: timestamp.toString() }; } catch (_) { fail("HEADER", "HEADER_INVALID"); } }
function normalizeDecoded(value, ledger) { if (++ledger.count > LIMITS.decodedItems) fail("LOG", "LOG_INVALID"); if (typeof value === "bigint") return value.toString(); if (typeof value === "boolean") return value; if (typeof value === "string") { if (/^0x[0-9a-f]{40}$/iu.test(value)) return ethers.getAddress(value).toLowerCase(); if (value.length > 256) fail("LOG", "LOG_INVALID"); return value; } if (Array.isArray(value)) return Array.from(value, (row) => normalizeDecoded(row, ledger)); fail("LOG", "LOG_INVALID"); }
function normalizeLogs(raw, authority, fromHeader, toHeader) {
  if (!Array.isArray(raw) || raw.length > LIMITS.logs) fail("LOG", "LOG_INVALID"); const rows = [];
  for (const log of raw) {
    try {
      if (!log || log.removed !== false || !/^0x[0-9a-f]{40}$/iu.test(log.address || "") || !/^0x[0-9a-f]{64}$/iu.test(log.blockHash || "") || !/^0x[0-9a-f]{64}$/iu.test(log.transactionHash || "") || !Array.isArray(log.topics) || log.topics.some((topic) => !/^0x[0-9a-f]{64}$/iu.test(topic)) || typeof log.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/iu.test(log.data)) throw new Error("log");
      const emitter = ethers.getAddress(log.address).toLowerCase(), block = quantity(log.blockNumber), transactionIndex = quantity(log.transactionIndex), logIndex = quantity(log.logIndex), topic = String(log.topics[0]).toLowerCase(), event = authority.byTopic.get(topic);
      if (block < BigInt(fromHeader.number) || block > BigInt(toHeader.number) || !event) throw new Error("log");
      if (emitter === authority.factory ? event.category !== "FactoryCreation" : !authority.membership.has(emitter) || event.category === "FactoryCreation") fail("LOG", "UNBOUND_EMITTER");
      const parsed = event.iface.parseLog({ topics: log.topics, data: log.data }); if (!parsed) throw new Error("log");
      rows.push({ emitter, category: event.category, block: block.toString(), blockHash: log.blockHash.toLowerCase(), transactionHash: log.transactionHash.toLowerCase(), transactionIndex: transactionIndex.toString(), logIndex: logIndex.toString(), decoded: normalizeDecoded(Array.from(parsed.args), { count: 0 }) });
    } catch (error) { if (error instanceof WindowError) throw error; fail("LOG", "LOG_INVALID"); }
  }
  rows.sort((a, b) => BigInt(a.block) < BigInt(b.block) ? -1 : BigInt(a.block) > BigInt(b.block) ? 1 : BigInt(a.transactionIndex) < BigInt(b.transactionIndex) ? -1 : BigInt(a.transactionIndex) > BigInt(b.transactionIndex) ? 1 : BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : BigInt(a.logIndex) > BigInt(b.logIndex) ? 1 : 0);
  const dedup = [], seen = new Map(); for (const row of rows) { const key = `${row.blockHash}:${row.transactionHash}:${row.logIndex}`; if (seen.has(key)) { if (stable(seen.get(key)) !== stable(row)) fail("LOG", "LOG_INVALID"); continue; } seen.set(key, row); dedup.push(row); }
  return dedup;
}
async function detectChain(candidate, budget, transport) { return quantity(await rpc(candidate, "eth_chainId", [], budget, transport)) === 42161n; }
async function qualifyLogs(candidate, authority, budget, transport) { const finalized = header(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport)); const probe = await rpc(candidate, "eth_getLogs", [{ address: [authority.factory, ...authority.vaults], fromBlock: ethers.toQuantity(finalized.number), toBlock: ethers.toQuantity(finalized.number), topics: [authority.topics] }], budget, transport); if (!Array.isArray(probe)) throw new Error("logs"); return { candidate, finalized }; }
async function commonFinalized(qualified, budget, transport) {
  const cache = new Map(); const heights = [...new Set(qualified.map((row) => row.finalized.number))].map(BigInt).sort((a, b) => a > b ? -1 : 1);
  for (const number of heights) {
    const eligible = qualified.filter((row) => row.candidate.family && BigInt(row.finalized.number) >= number), groups = new Map(); if (new Set(eligible.map((row) => row.candidate.family)).size < 2) continue;
    for (const row of eligible) { const key = `${row.candidate.url.href}:${number}`; let current = cache.get(key); if (current === undefined) { try { current = header(await rpc(row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(number), false], budget, transport), number); } catch (_) { current = null; } cache.set(key, current); } if (!current) continue; const id = stable(current); if (!groups.has(id)) groups.set(id, []); groups.get(id).push({ candidate: row.candidate, pin: current }); }
    for (const group of groups.values()) { const selected = [], families = new Set(); for (const row of group) { if (families.has(row.candidate.family)) continue; selected.push(row); families.add(row.candidate.family); if (selected.length === 2) return { pin: selected[0].pin, selected }; } }
  }
  fail("QUALIFICATION", "COMMON_FINALIZED_UNAVAILABLE");
}
async function capture(selected, pin, authority, budget, transport) {
  const to = BigInt(pin.number), from = to >= BigInt(LIMITS.windowBlocks - 1) ? to - BigInt(LIMITS.windowBlocks - 1) : 0n, views = [];
  for (const row of selected) {
    const fromHeader = header(await rpc(row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(from), false], budget, transport), from);
    const toHeader = header(await rpc(row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(to), false], budget, transport), to);
    if (stable(toHeader) !== stable(pin)) fail("HEADER", "HEADER_DISAGREEMENT");
    const logs = normalizeLogs(await rpc(row.candidate, "eth_getLogs", [{ address: [authority.factory, ...authority.vaults], fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to), topics: [authority.topics] }], budget, transport), authority, fromHeader, toHeader);
    views.push({ row, fromHeader, toHeader, logs });
  }
  if (stable(views[0].fromHeader) !== stable(views[1].fromHeader) || stable(views[0].toHeader) !== stable(views[1].toHeader)) fail("HEADER", "HEADER_DISAGREEMENT");
  if (stable(views[0].logs) !== stable(views[1].logs)) fail("LOG", "LOG_DISAGREEMENT");
  return { from, to, views };
}
async function terminal(captureRow, budget, transport) { for (const view of captureRow.views) for (const [number, expected] of [[captureRow.from, view.fromHeader], [captureRow.to, view.toHeader]]) { const current = header(await rpc(view.row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(number), false], budget, transport), number); if (stable(current) !== stable(expected)) fail("TERMINAL", "TERMINAL_RECHECK_FAILED"); } }
function counts(logs) { const result = Object.fromEntries(CATEGORIES.map((name) => [name, 0])); for (const log of logs) result[log.category] += 1; return result; }
function emptyOutput() { return { status: STATUS_INCOMPLETE, phase: "NONE", code: "NONE", anonymousLabelledCount: 0, anonymousChainMatchedCount: 0, anonymousLogQualifiedCount: 0, anonymousSelectedCount: 0, blockRange: { fromBlock: null, toBlock: null }, readCount: 0, retryCount: 0, cleanupComplete: true }; }
function validateOutput(output) {
  const complete = output.status === STATUS_COMPLETE;
  const keys = ["status", "phase", "code", "anonymousLabelledCount", "anonymousChainMatchedCount", "anonymousLogQualifiedCount", "anonymousSelectedCount", "blockRange", "readCount", "retryCount", "cleanupComplete", ...(complete ? ["categoryCounts", "eventCount"] : [])];
  if (!exactKeys(output, keys) || ![STATUS_COMPLETE, STATUS_INCOMPLETE].includes(output.status) || !PHASES.has(output.phase) || !CODES.has(output.code) || complete !== (output.phase === "NONE" && output.code === "NONE") || !exactKeys(output.blockRange, ["fromBlock", "toBlock"])
      || (complete && (!exactKeys(output.categoryCounts, CATEGORIES) || !Object.values(output.categoryCounts).every(Number.isSafeInteger) || Object.values(output.categoryCounts).reduce((a, b) => a + b, 0) !== output.eventCount))
      || ![output.anonymousLabelledCount, output.anonymousChainMatchedCount, output.anonymousLogQualifiedCount, output.anonymousSelectedCount, output.readCount, output.retryCount, ...(complete ? [output.eventCount] : [])].every(Number.isSafeInteger)
      || output.anonymousLabelledCount > LIMITS.candidates || output.anonymousChainMatchedCount > output.anonymousLabelledCount || output.anonymousLogQualifiedCount > output.anonymousChainMatchedCount || output.anonymousSelectedCount > 2 || (complete && output.eventCount > LIMITS.logs) || output.readCount > LIMITS.calls || output.retryCount !== 0 || output.cleanupComplete !== true) fail("CAP", "UNEXPECTED");
  const serialized = JSON.stringify(output); if (/(?:https?|wss?):\/\/|0x[0-9a-f]{8,}|provider|endpoint|credential|topic|address|rpc[_-]?endpoints|commitment/iu.test(serialized)) fail("CAP", "UNEXPECTED"); return true;
}
async function runWindow(options = {}) {
  const output = emptyOutput(), budget = new Budget(options.maxCalls ?? LIMITS.calls); let inventory = null; const transport = options.transport || fetchTransport, checkInventory = options.assertInventoryUnchangedFn || inventoryUnchanged;
  try {
    const authority = await (options.authorityAdapter || readAuthority)(options.authorityOptions || {});
    inventory = options.inventoryText !== undefined ? { text: options.inventoryText, identity: options.inventoryIdentity ?? "injected" } : (options.readInventoryFn ? options.readInventoryFn() : readStableInventory());
    if (!inventory || typeof inventory.text !== "string" || !Object.hasOwn(inventory, "identity")) fail("INVENTORY", "INVENTORY_INVALID");
    const candidates = parseInventoryText(inventory.text, options.operatorClassifier || classifyOperatorFamily); output.anonymousLabelledCount = candidates.length; const chainMatched = [];
    for (const candidate of candidates) { try { if (await detectChain(candidate, budget, transport)) chainMatched.push(candidate); } catch (error) { if (error instanceof WindowError && error.code === "READ_CAP") throw error; } }
    output.anonymousChainMatchedCount = chainMatched.length; const qualified = [];
    for (const candidate of chainMatched) { try { qualified.push(await qualifyLogs(candidate, authority, budget, transport)); } catch (error) { if (error instanceof WindowError && error.code === "READ_CAP") throw error; } }
    output.anonymousLogQualifiedCount = qualified.length; if (new Set(qualified.map((row) => row.candidate.family).filter(Boolean)).size < 2) fail("QUALIFICATION", "TWO_FAMILIES_UNAVAILABLE");
    const agreed = await commonFinalized(qualified, budget, transport), captured = await capture(agreed.selected, agreed.pin, authority, budget, transport); await terminal(captured, budget, transport); checkInventory(inventory.identity);
    const logs = captured.views[0].logs; output.status = STATUS_COMPLETE; output.anonymousSelectedCount = 2; output.blockRange = { fromBlock: captured.from.toString(), toBlock: captured.to.toString() }; output.categoryCounts = counts(logs); output.eventCount = logs.length;
  } catch (error) { const failure = error instanceof WindowError ? error : new WindowError("CAP", "UNEXPECTED"); output.phase = failure.phase; output.code = failure.code; }
  finally { if (inventory && output.code !== "INVENTORY_MUTATED") try { checkInventory(inventory.identity); } catch (_) { output.status = STATUS_INCOMPLETE; output.phase = "INVENTORY"; output.code = "INVENTORY_MUTATED"; output.anonymousSelectedCount = 0; } output.readCount = budget.calls; if (output.status !== STATUS_COMPLETE) { delete output.categoryCounts; delete output.eventCount; } }
  validateOutput(output); return output;
}
async function main(argv = process.argv.slice(2)) { if (argv.length) { process.exitCode = 1; return; } const result = await runWindow(); process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status !== STATUS_COMPLETE) process.exitCode = 1; }
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = Object.freeze({ CATEGORIES, LIMITS, PINS, STATUS_COMPLETE, STATUS_INCOMPLETE, WindowError, deriveEventAuthority, normalizeLogs, parseInventoryText, readAuthority, runWindow, validateOutput });
