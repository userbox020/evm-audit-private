#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { classifyOperatorFamily } = require("./lib/common-finalized-rpc-preflight");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_FILE = path.join(ROOT, "rpc_endpoints.txt");
const OUTPUT_FILE = path.join(ROOT, "reports", "monitor", "aave-v3-arbitrum-config-oracle-events.json");
const SCHEMA = "aave-v3-arbitrum-config-oracle-events/v2";
const LEGACY_SCHEMA = "aave-v3-arbitrum-config-oracle-events/v1";
const SOURCE_ROOT = path.join(ROOT, "targets", "aave-v3-origin-v3.7-cff15de", "src", "contracts", "interfaces");
const ADDRESS_BOOK_FILE = path.join(ROOT, "targets", "aave-address-book-6a0ac5a", "src", "AaveV3Arbitrum.sol");

const PINS = Object.freeze({
  configurator: Object.freeze({ file: path.join(SOURCE_ROOT, "IPoolConfigurator.sol"), bytes: 19595, sha256: "e84bcade8ae8bd981db571c25cab4f20f313b6e4800c4e0d8e9fff216b518da8" }),
  oracle: Object.freeze({ file: path.join(SOURCE_ROOT, "IAaveOracle.sol"), bytes: 2389, sha256: "e55953dba6daa0883e7fb5776c6939cf6d28060e4d7733809a90bf454b31224b" }),
  addressesProvider: Object.freeze({ file: path.join(SOURCE_ROOT, "IPoolAddressesProvider.sol"), bytes: 8210, sha256: "6a44f3a913093d62dd072d1691cf605a76262f56da42cbecdcf80607d8aeef94" }),
  addressBook: Object.freeze({ file: ADDRESS_BOOK_FILE, bytes: 31088, sha256: "f76682d960fdfda5247677b9228916db3c9a6e51fe78c51582ae09b0c7a009a5" })
});
const SOURCE_REVISION = "cff15de6d1271b0c800fc001f4aea4c263e8a597";
const ADDRESS_BOOK_REVISION = "6a0ac5a5e548d764488a2f95f26714ff9275de48";
const EVENT_GROUPS = Object.freeze({
  configurator: Object.freeze([
    "ReserveInitialized", "ReserveBorrowing", "CollateralConfigurationChanged", "ReserveActive", "ReserveFrozen", "ReservePaused",
    "BorrowCapChanged", "SupplyCapChanged", "AssetCollateralInEModeChanged", "AssetBorrowableInEModeChanged",
    "AssetLtvzeroInEModeChanged", "EModeCategoryAdded", "EModeCategoryIsolationChanged", "ReserveInterestRateStrategyChanged",
    "ReserveInterestRateDataChanged", "ATokenUpgraded", "VariableDebtTokenUpgraded"
  ]),
  oracle: Object.freeze(["AssetSourceUpdated"]),
  addressesProvider: Object.freeze(["PriceOracleUpdated", "PoolUpdated", "PoolConfiguratorUpdated"])
});
const EVENT_NAMES = Object.freeze(Object.values(EVENT_GROUPS).flat());
const LIMITS = Object.freeze({
  inventoryBytes: 1024 * 1024, candidates: 6, calls: 40, responseBytes: 2 * 1024 * 1024,
  totalResponseBytes: 8 * 1024 * 1024, events: 64, eventDataBytes: 4096, windowBlocks: 8192,
  requestMs: 15000, wallMs: 120000
});
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"]);
const PHASES = new Set(["NONE", "CURSOR", "AUTHORITY", "ABI", "INVENTORY", "QUALIFICATION", "HEADER", "LOG", "TERMINAL", "CAP", "OUTPUT"]);
const CODES = new Set([
  "NONE", "AUTHORITY_INVALID", "ABI_INVALID", "INVENTORY_INVALID", "INVENTORY_MUTATED", "TWO_FAMILIES_UNAVAILABLE",
  "COMMON_FINALIZED_UNAVAILABLE", "HEADER_INVALID", "HEADER_DISAGREEMENT", "LOG_INVALID", "LOG_DISAGREEMENT",
  "WRONG_EMITTER", "EVENT_CAP", "TERMINAL_RECHECK_FAILED", "FINALITY_REGRESSION", "READ_CAP", "OUTPUT_INVALID",
  "PRIOR_ARTIFACT_INVALID", "PRIOR_ARTIFACT_MUTATED", "UNEXPECTED"
]);
const STATUS_COMPLETE = "COMPLETE";
const STATUS_SURVIVOR = "EVENT_SURVIVOR";
const STATUS_INCOMPLETE = "INCOMPLETE";

class ScannerError extends Error {
  constructor(phase, code) {
    super(code);
    this.name = "ScannerError";
    this.phase = PHASES.has(phase) ? phase : "CAP";
    this.code = CODES.has(code) ? code : "UNEXPECTED";
  }
}
const fail = (phase, code) => { throw new ScannerError(phase, code); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const commitment = (value) => `sha256-${crypto.createHash("sha256").update(stable(value)).digest("base64url")}`;
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function readPinned(record, readFile) {
  let bytes;
  try { bytes = readFile(record.file); } catch (_) { fail("AUTHORITY", "AUTHORITY_INVALID"); }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) fail("AUTHORITY", "AUTHORITY_INVALID");
  return bytes.toString("utf8");
}
function stripComments(source) { return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\r\n]*/gu, " "); }
function splitTopLevel(value) {
  const rows = []; let depth = 0; let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(" || value[index] === "[") depth += 1;
    else if (value[index] === ")" || value[index] === "]") depth -= 1;
    else if (value[index] === "," && depth === 0) { rows.push(value.slice(start, index).trim()); start = index + 1; }
  }
  rows.push(value.slice(start).trim());
  return rows.filter(Boolean);
}
function parseAddressBook(source) {
  const clean = stripComments(source), definitions = {
    configurator: ["POOL_CONFIGURATOR", "IPoolConfigurator"],
    oracle: ["ORACLE", "IAaveOracle"],
    addressesProvider: ["POOL_ADDRESSES_PROVIDER", "IPoolAddressesProvider"]
  }, emitters = {};
  for (const [group, [constantName, typeName]] of Object.entries(definitions)) {
    const expression = new RegExp(`\\b${typeName}\\s+internal\\s+constant\\s+${constantName}\\s*=\\s*${typeName}\\s*\\(\\s*(0x[0-9a-fA-F]{40})\\s*\\)\\s*;`, "gu");
    const matches = [...clean.matchAll(expression)];
    if (matches.length !== 1) fail("AUTHORITY", "AUTHORITY_INVALID");
    try { emitters[group] = ethers.getAddress(matches[0][1]).toLowerCase(); } catch (_) { fail("AUTHORITY", "AUTHORITY_INVALID"); }
  }
  if (new Set(Object.values(emitters)).size !== 3) fail("AUTHORITY", "AUTHORITY_INVALID");
  return emitters;
}
function deriveEvents(source, group, names) {
  const clean = stripComments(source), wanted = new Set(names), events = [];
  for (const match of clean.matchAll(/\bevent\s+(\w+)\s*\(([\s\S]*?)\)\s*;/gu)) {
    if (!wanted.has(match[1])) continue;
    const params = splitTopLevel(match[2]);
    if (!params.length || params.some((row) => !/^[A-Za-z_$][\w$]*(?:\[[0-9]*\])?(?:\s+indexed)?(?:\s+[A-Za-z_$][\w$]*)?$/u.test(row.replace(/\s+/gu, " ")))) fail("ABI", "ABI_INVALID");
    let iface; let fragment; let topic; let signature;
    try {
      iface = new ethers.Interface([`event ${match[1]}(${params.join(",")})`]);
      fragment = iface.getEvent(match[1]);
      signature = fragment.format("sighash");
      topic = fragment.topicHash.toLowerCase();
    } catch (_) { fail("ABI", "ABI_INVALID"); }
    if (topic !== ethers.id(signature).toLowerCase()) fail("ABI", "ABI_INVALID");
    events.push(Object.freeze({ name: match[1], group, signature, topic, indexedCount: fragment.inputs.filter((row) => row.indexed).length, iface, fragment }));
  }
  if (events.length !== names.length || names.some((name) => events.filter((row) => row.name === name).length !== 1)) fail("ABI", "ABI_INVALID");
  return events;
}
function readAuthority(options = {}) {
  const readFile = options.readFile || fs.readFileSync;
  const sources = Object.fromEntries(Object.entries(PINS).map(([name, record]) => [name, readPinned(record, readFile)]));
  const emitters = parseAddressBook(sources.addressBook), events = [
    ...deriveEvents(sources.configurator, "configurator", EVENT_GROUPS.configurator),
    ...deriveEvents(sources.oracle, "oracle", EVENT_GROUPS.oracle),
    ...deriveEvents(sources.addressesProvider, "addressesProvider", EVENT_GROUPS.addressesProvider)
  ];
  if (events.length !== EVENT_NAMES.length || new Set(events.map((row) => row.topic)).size !== events.length) fail("ABI", "ABI_INVALID");
  const authority = { sourceRevision: SOURCE_REVISION, addressBookRevision: ADDRESS_BOOK_REVISION, eventCount: events.length, eventNames: [...EVENT_NAMES] };
  Object.defineProperties(authority, {
    emitters: { value: Object.freeze(emitters) },
    addresses: { value: Object.freeze(Object.values(emitters)) },
    events: { value: Object.freeze(events) },
    topics: { value: Object.freeze(events.map((row) => row.topic)) },
    byTopic: { value: new Map(events.map((row) => [row.topic, row])) }
  });
  return Object.freeze(authority);
}

function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function readStableInventory() {
  let before; let after; let heldBefore; let heldAfter; let descriptor; let bytes; let real;
  try {
    before = fs.lstatSync(INVENTORY_FILE); real = fs.realpathSync.native(INVENTORY_FILE);
    if (!before.isFile() || before.isSymbolicLink() || real !== INVENTORY_FILE || before.size < 1 || before.size > LIMITS.inventoryBytes) fail("INVENTORY", "INVENTORY_INVALID");
    descriptor = fs.openSync(INVENTORY_FILE, "r"); heldBefore = fs.fstatSync(descriptor); bytes = fs.readFileSync(descriptor); heldAfter = fs.fstatSync(descriptor); after = fs.lstatSync(INVENTORY_FILE);
  } catch (error) { if (error instanceof ScannerError) throw error; fail("INVENTORY", "INVENTORY_INVALID"); }
  finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch (_) {} }
  if (bytes.length !== before.size || stable(identity(before)) !== stable(identity(after)) || stable(identity(heldBefore)) !== stable(identity(heldAfter)) || String(before.dev) !== String(heldBefore.dev) || String(before.ino) !== String(heldBefore.ino)) fail("INVENTORY", "INVENTORY_MUTATED");
  return { text: bytes.toString("utf8"), identity: identity(after) };
}
function inventoryUnchanged(expected) {
  let stat; let real;
  try { stat = fs.lstatSync(INVENTORY_FILE); real = fs.realpathSync.native(INVENTORY_FILE); } catch (_) { fail("INVENTORY", "INVENTORY_MUTATED"); }
  if (!stat.isFile() || stat.isSymbolicLink() || real !== INVENTORY_FILE || stable(identity(stat)) !== stable(expected)) fail("INVENTORY", "INVENTORY_MUTATED");
}
function readStablePriorArtifact() {
  let before; let after; let heldBefore; let heldAfter; let descriptor; let bytes; let real;
  try { before = fs.lstatSync(OUTPUT_FILE); }
  catch (error) { if (error && error.code === "ENOENT") return { value: null, identity: null }; fail("CURSOR", "PRIOR_ARTIFACT_INVALID"); }
  try {
    real = fs.realpathSync.native(OUTPUT_FILE);
    if (!before.isFile() || before.isSymbolicLink() || real !== OUTPUT_FILE || before.nlink > 1 || before.size < 1 || before.size > LIMITS.inventoryBytes) fail("CURSOR", "PRIOR_ARTIFACT_INVALID");
    descriptor = fs.openSync(OUTPUT_FILE, "r"); heldBefore = fs.fstatSync(descriptor); bytes = fs.readFileSync(descriptor); heldAfter = fs.fstatSync(descriptor); after = fs.lstatSync(OUTPUT_FILE);
  } catch (error) { if (error instanceof ScannerError) throw error; fail("CURSOR", "PRIOR_ARTIFACT_INVALID"); }
  finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch (_) {} }
  if (bytes.length !== before.size || stable(identity(before)) !== stable(identity(after)) || stable(identity(heldBefore)) !== stable(identity(heldAfter)) || String(before.dev) !== String(heldBefore.dev) || String(before.ino) !== String(heldBefore.ino)) fail("CURSOR", "PRIOR_ARTIFACT_MUTATED");
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch (_) { fail("CURSOR", "PRIOR_ARTIFACT_INVALID"); }
  return { value, identity: identity(after) };
}
function priorArtifactUnchanged(record) {
  if (!record || !Object.hasOwn(record, "identity")) fail("CURSOR", "PRIOR_ARTIFACT_MUTATED");
  if (record.identity === null) { if (fs.existsSync(OUTPUT_FILE)) fail("CURSOR", "PRIOR_ARTIFACT_MUTATED"); return; }
  let stat; let real; try { stat = fs.lstatSync(OUTPUT_FILE); real = fs.realpathSync.native(OUTPUT_FILE); } catch (_) { fail("CURSOR", "PRIOR_ARTIFACT_MUTATED"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || real !== OUTPUT_FILE || stable(identity(stat)) !== stable(record.identity)) fail("CURSOR", "PRIOR_ARTIFACT_MUTATED");
}
function placeholder(url, context) {
  let decoded; try { decoded = decodeURIComponent(`${url.pathname} ${url.search}`); } catch (_) { return true; }
  return /(?:^|\.)(?:example|placeholder|invalid)(?:\.|$)/u.test(url.hostname.toLowerCase()) || /(?:\{|\}|<|>|\$\{|your[-_ ]?(?:api[-_ ]?)?key|replace[-_ ]?(?:me|this)|insert[-_ ]?(?:key|token)|placeholder|changeme|api[-_ ]?key[-_ ]?here)/iu.test(`${context} ${decoded}`);
}
function canonicalFamilyLabel(value) {
  if (typeof value !== "string" || value.length > 256 || /https?:\/\//iu.test(value) || /\b(?:credentials?|secrets?|api[- _]?keys?|tokens?|authorization|bearer|origin|browser|session|custom[- _]?headers?)\b/iu.test(value)) return null;
  const ignored = new Set(["arbitrum", "one", "chain", "mainnet", "public", "keyless", "open", "rpc", "rpcs", "endpoint", "endpoints", "provider", "operator", "section", "status", "https", "http", "url", "urls", "none", "auth", "no"]);
  const tokens = value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().split(/\s+/u).filter((token) => token && !ignored.has(token));
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
      const localOrdinal = ordinal++; let url;
      try { url = new URL(match[1].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
      const context = line.replace(match[1], " "), lower = context.toLowerCase();
      const forbidden = /\b(?:restricted|unavailable|disabled|retired|deprecated|unsupported|failed|dead|pruned|exposed|leaked|compromised|app[- _]?scoped|credentialed|internal)\b|\bprivate[- _]?(?:only|endpoint|route)\b|\bdo[- ]?not[- ]?use\b/iu.test(lower)
        || /\b(?:credentials?|secrets?|api[- _]?keys?|tokens?)\s*[:=]?\s*(?:required|present|included|embedded|exposed)\b|\brequires?\b[^\r\n]{0,40}\b(?:credentials?|secrets?|api[- _]?keys?|tokens?|auth)\b/iu.test(lower)
        || /\b(?:origin[- _]?required|browser[- _]?only|session[- _]?auth|session|cookie|referer|cors)\b|\brequires?\b[^\r\n]{0,40}\borigin\b/iu.test(lower)
        || /\b(?:custom[- _]?headers?|authorization|bearer|x[- _]?api[- _]?key|proxy|batch)\b|\brequires?\b[^\r\n]{0,40}\bheaders?\b/iu.test(lower);
      const unsafe = url.protocol !== "https:" || Boolean(url.username || url.password || url.hash || url.search) || (url.port && url.port !== "443") || /(?:localhost|\.local|\.internal|\.invalid)$/u.test(url.hostname.toLowerCase()) || /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(url.hostname);
      if (forbidden || unsafe || placeholder(url, context) || seen.has(url.href)) continue;
      let classified = null; try { classified = operatorClassifier(url.href); } catch (_) {}
      const rowFamilyKey = canonicalFamilyLabel(line.slice(0, match.index));
      seen.add(url.href); rows.push({ url, family: opaqueFamily(rowFamilyKey || activeFamilyKey) || classified?.operatorFamily || null, ordinal: localOrdinal });
    }
  }
  return rows.sort((a, b) => a.ordinal - b.ordinal).slice(0, LIMITS.candidates);
}

class Budget {
  constructor(maxCalls = LIMITS.calls) { this.maxCalls = Math.min(LIMITS.calls, maxCalls); this.calls = 0; this.bytes = 0; this.started = Date.now(); }
  use() { if (++this.calls > this.maxCalls || Date.now() - this.started > LIMITS.wallMs) fail("CAP", "READ_CAP"); }
  add(bytes) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > LIMITS.responseBytes) fail("CAP", "READ_CAP"); this.bytes += bytes; if (this.bytes > LIMITS.totalResponseBytes) fail("CAP", "READ_CAP"); }
}
async function fetchTransport({ candidate, envelope, timeoutMs }) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(candidate.url.href, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" }, body: JSON.stringify(envelope) });
    if (response.status !== 200) throw new Error("transport");
    const text = await response.text(), bytes = Buffer.byteLength(text); if (bytes > LIMITS.responseBytes) fail("CAP", "READ_CAP");
    return { value: JSON.parse(text), bytes };
  } catch (error) { if (error instanceof ScannerError) throw error; throw new Error("transport"); }
  finally { clearTimeout(timer); }
}
async function rpc(candidate, method, params, budget, transport) {
  if (!METHODS.has(method)) fail("CAP", "READ_CAP"); budget.use();
  const envelope = { jsonrpc: "2.0", id: budget.calls, method, params }; let row;
  try { row = await transport({ candidate, envelope, timeoutMs: LIMITS.requestMs }); } catch (error) { if (error instanceof ScannerError) throw error; throw new Error("transport"); }
  if (!row || !Number.isSafeInteger(row.bytes) || !row.value || row.value.jsonrpc !== "2.0" || row.value.id !== envelope.id || Object.hasOwn(row.value, "error") || !Object.hasOwn(row.value, "result")) throw new Error("transport");
  budget.add(row.bytes); return row.value.result;
}
function quantity(value) { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) throw new Error("quantity"); return BigInt(value); }
function header(value, expected = null) {
  try {
    if (!value || !/^0x[0-9a-f]{64}$/iu.test(value.hash || "") || !/^0x[0-9a-f]{64}$/iu.test(value.parentHash || "") || !/^0x[0-9a-f]{64}$/iu.test(value.stateRoot || "")) throw new Error("header");
    const number = quantity(value.number), timestamp = quantity(value.timestamp); if (expected !== null && number !== expected) throw new Error("header");
    return { number: number.toString(), hash: value.hash.toLowerCase(), parentHash: value.parentHash.toLowerCase(), stateRoot: value.stateRoot.toLowerCase(), timestamp: timestamp.toString() };
  } catch (_) { fail("HEADER", "HEADER_INVALID"); }
}
function normalizeValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^0x[0-9a-f]{40}$/iu.test(value)) return ethers.getAddress(value).toLowerCase();
    if (/^0x(?:[0-9a-f]{2})*$/iu.test(value)) { if ((value.length - 2) / 2 > LIMITS.eventDataBytes) fail("LOG", "LOG_INVALID"); return value.toLowerCase(); }
    if (value.length > 512) fail("LOG", "LOG_INVALID"); return value;
  }
  if (Array.isArray(value)) return Array.from(value, normalizeValue);
  fail("LOG", "LOG_INVALID");
}
function normalizeLogs(raw, authority, fromHeader, toHeader) {
  if (!Array.isArray(raw)) fail("LOG", "LOG_INVALID");
  if (raw.length > LIMITS.events) fail("CAP", "EVENT_CAP");
  const rows = [];
  for (const log of raw) {
    try {
      if (!log || log.removed !== false || !/^0x[0-9a-f]{40}$/iu.test(log.address || "") || !/^0x[0-9a-f]{64}$/iu.test(log.blockHash || "") || !/^0x[0-9a-f]{64}$/iu.test(log.transactionHash || "") || !Array.isArray(log.topics) || log.topics.some((topic) => !/^0x[0-9a-f]{64}$/iu.test(topic)) || typeof log.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/iu.test(log.data) || (log.data.length - 2) / 2 > LIMITS.eventDataBytes) throw new Error("log");
      const emitter = ethers.getAddress(log.address).toLowerCase(), block = quantity(log.blockNumber), transactionIndex = quantity(log.transactionIndex), logIndex = quantity(log.logIndex), topic = String(log.topics[0] || "").toLowerCase(), event = authority.byTopic.get(topic);
      if (block < BigInt(fromHeader.number) || block > BigInt(toHeader.number) || !event || log.topics.length !== event.indexedCount + 1) throw new Error("log");
      if (emitter !== authority.emitters[event.group]) fail("LOG", "WRONG_EMITTER");
      const parsed = event.iface.parseLog({ topics: log.topics, data: log.data }); if (!parsed) throw new Error("log");
      const encoded = event.iface.encodeEventLog(event.fragment, Array.from(parsed.args));
      if (stable(encoded.topics.map((row) => row.toLowerCase())) !== stable(log.topics.map((row) => row.toLowerCase())) || encoded.data.toLowerCase() !== log.data.toLowerCase()) throw new Error("log");
      const normalized = { emitter, category: event.name, signature: event.signature, blockNumber: block.toString(), blockHash: log.blockHash.toLowerCase(), transactionHash: log.transactionHash.toLowerCase(), transactionIndex: transactionIndex.toString(), logIndex: logIndex.toString(), values: normalizeValue(Array.from(parsed.args)) };
      rows.push({ category: event.name, blockNumber: normalized.blockNumber, transactionIndex: normalized.transactionIndex, logIndex: normalized.logIndex, commitment: commitment(normalized) });
    } catch (error) { if (error instanceof ScannerError) throw error; fail("LOG", "LOG_INVALID"); }
  }
  rows.sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : BigInt(a.transactionIndex) < BigInt(b.transactionIndex) ? -1 : BigInt(a.transactionIndex) > BigInt(b.transactionIndex) ? 1 : BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : BigInt(a.logIndex) > BigInt(b.logIndex) ? 1 : 0);
  const dedup = [], seen = new Map();
  for (const row of rows) {
    const key = `${row.blockNumber}:${row.transactionIndex}:${row.logIndex}`;
    if (seen.has(key)) { if (stable(seen.get(key)) !== stable(row)) fail("LOG", "LOG_INVALID"); continue; }
    seen.set(key, row); dedup.push(row);
  }
  return dedup;
}
async function detectChain(candidate, budget, transport) { return quantity(await rpc(candidate, "eth_chainId", [], budget, transport)) === 42161n; }
async function qualify(candidate, authority, budget, transport) {
  const finalized = header(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport));
  const probe = await rpc(candidate, "eth_getLogs", [{ address: authority.addresses, fromBlock: ethers.toQuantity(finalized.number), toBlock: ethers.toQuantity(finalized.number), topics: [authority.topics] }], budget, transport);
  if (!Array.isArray(probe) || probe.length > LIMITS.events) fail("CAP", "EVENT_CAP");
  return { candidate, finalized };
}
async function commonFinalized(qualified, budget, transport) {
  const cache = new Map(), heights = [...new Set(qualified.map((row) => row.finalized.number))].map(BigInt).sort((a, b) => a > b ? -1 : 1);
  for (const number of heights) {
    const eligible = qualified.filter((row) => row.candidate.family && BigInt(row.finalized.number) >= number); if (new Set(eligible.map((row) => row.candidate.family)).size < 2) continue;
    const groups = new Map();
    for (const row of eligible) {
      const key = `${row.candidate.ordinal}:${number}`; let current = cache.get(key);
      if (current === undefined) {
        if (BigInt(row.finalized.number) === number) current = row.finalized;
        else { try { current = header(await rpc(row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(number), false], budget, transport), number); } catch (_) { current = null; } }
        cache.set(key, current);
      }
      if (!current) continue; const id = stable(current); if (!groups.has(id)) groups.set(id, []); groups.get(id).push({ candidate: row.candidate, pin: current });
    }
    for (const group of groups.values()) {
      const selected = [], families = new Set();
      for (const row of group) { if (families.has(row.candidate.family)) continue; selected.push(row); families.add(row.candidate.family); if (selected.length === 2) return { pin: selected[0].pin, selected }; }
    }
  }
  fail("QUALIFICATION", "COMMON_FINALIZED_UNAVAILABLE");
}
async function capture(selected, pin, from, to, authority, budget, transport) {
  const views = [];
  for (const row of selected) {
    const fromHeader = header(await rpc(row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(from), false], budget, transport), from);
    const toHeader = header(await rpc(row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(to), false], budget, transport), to);
    if (to === BigInt(pin.number) && stable(toHeader) !== stable(pin)) fail("HEADER", "HEADER_DISAGREEMENT");
    const logs = normalizeLogs(await rpc(row.candidate, "eth_getLogs", [{ address: authority.addresses, fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to), topics: [authority.topics] }], budget, transport), authority, fromHeader, toHeader);
    views.push({ row, fromHeader, toHeader, logs });
  }
  if (stable(views[0].fromHeader) !== stable(views[1].fromHeader) || stable(views[0].toHeader) !== stable(views[1].toHeader)) fail("HEADER", "HEADER_DISAGREEMENT");
  if (stable(views[0].logs) !== stable(views[1].logs)) fail("LOG", "LOG_DISAGREEMENT");
  return { from, to, views };
}
async function terminal(captured, budget, transport) {
  for (const view of captured.views) for (const [number, expected] of [[captured.from, view.fromHeader], [captured.to, view.toHeader]]) {
    const current = header(await rpc(view.row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(number), false], budget, transport), number);
    if (stable(current) !== stable(expected)) fail("TERMINAL", "TERMINAL_RECHECK_FAILED");
  }
}
async function terminalPin(selected, pin, budget, transport) {
  for (const row of selected) {
    const current = header(await rpc(row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(pin.number), false], budget, transport), BigInt(pin.number));
    if (stable(current) !== stable(pin)) fail("TERMINAL", "TERMINAL_RECHECK_FAILED");
  }
}
function categoryCounts(events) { const result = Object.fromEntries(EVENT_NAMES.map((name) => [name, 0])); for (const event of events) result[event.category] += 1; return result; }
function iso(value) { if (typeof value !== "string") return false; try { return new Date(value).toISOString() === value; } catch (_) { return false; } }
function decimal(value) { return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value); }
function validRange(value) { return exactKeys(value, ["fromBlock", "toBlock"]) && decimal(value.fromBlock) && decimal(value.toBlock) && BigInt(value.fromBlock) <= BigInt(value.toBlock); }
function validateLegacyArtifact(output) {
  const successful = output?.status === STATUS_COMPLETE || output?.status === STATUS_SURVIVOR;
  const keys = ["schema", "status", "outcome", "phase", "code", "chainId", "eventOnly", "sourcePinned", "qualification", "blockRange", "reads", "route", "safety", ...(successful ? ["eventCount", "categoryCounts", "events"] : [])];
  try {
    return Boolean(exactKeys(output, keys) && output.schema === LEGACY_SCHEMA && [STATUS_COMPLETE, STATUS_SURVIVOR, STATUS_INCOMPLETE].includes(output.status)
      && PHASES.has(output.phase) && CODES.has(output.code) && output.chainId === 42161 && output.eventOnly === true && output.sourcePinned === true
      && successful === (output.phase === "NONE" && output.code === "NONE")
      && output.outcome === (output.status === STATUS_COMPLETE ? "COMPLETE_ZERO_EVENTS" : output.status === STATUS_SURVIVOR ? "EVENT_SURVIVOR_NO_ROUTE" : "INCOMPLETE")
      && exactKeys(output.qualification, ["anonymousCandidateCount", "anonymousChainMatchedCount", "anonymousLogQualifiedCount", "selectedFamilyCount"])
      && Object.values(output.qualification).every(Number.isSafeInteger) && output.qualification.anonymousCandidateCount <= LIMITS.candidates
      && output.qualification.anonymousChainMatchedCount <= output.qualification.anonymousCandidateCount && output.qualification.anonymousLogQualifiedCount <= output.qualification.anonymousChainMatchedCount && output.qualification.selectedFamilyCount <= 2
      && exactKeys(output.blockRange, ["fromBlock", "toBlock"]) && (successful ? validRange(output.blockRange) : output.blockRange.fromBlock === null && output.blockRange.toBlock === null)
      && (!successful || Number.isSafeInteger(output.eventCount) && output.eventCount >= 0 && output.eventCount <= LIMITS.events && Array.isArray(output.events) && output.events.length === output.eventCount
        && exactKeys(output.categoryCounts, EVENT_NAMES) && Object.values(output.categoryCounts).every(Number.isSafeInteger) && Object.values(output.categoryCounts).reduce((a, b) => a + b, 0) === output.eventCount
        && (output.status === STATUS_COMPLETE) === (output.eventCount === 0)
        && output.events.every((row) => exactKeys(row, ["category", "blockNumber", "transactionIndex", "logIndex", "commitment"]) && EVENT_NAMES.includes(row.category) && decimal(row.blockNumber) && decimal(row.transactionIndex) && decimal(row.logIndex) && /^sha256-[A-Za-z0-9_-]{43}$/u.test(row.commitment)))
      && exactKeys(output.reads, ["count", "maximum", "retries"]) && Number.isSafeInteger(output.reads.count) && output.reads.count <= LIMITS.calls && output.reads.maximum === LIMITS.calls && output.reads.retries === 0
      && exactKeys(output.route, ["routeObserved", "routePositive", "stateInterpretationPerformed"]) && stable(output.route) === stable({ routeObserved: false, routePositive: "n/a", stateInterpretationPerformed: false })
      && exactKeys(output.safety, ["readOnlyRpc", "transactions", "signing", "broadcast", "walletAccess", "productionMutation"]) && stable(output.safety) === stable({ readOnlyRpc: true, transactions: false, signing: false, broadcast: false, walletAccess: false, productionMutation: false })
      && !/(?:https?|wss?):\/\/|0x[0-9a-f]{8,}|\b(?:credentials?|secrets?|api[- _]?keys?|authorization|bearer|endpoints?|rpc[_-]?endpoints|raw[- _]?logs?)\b/iu.test(JSON.stringify(output)));
  } catch (_) { return false; }
}
function cursorFromPrior(value) {
  if (value === null) return null;
  if (validateLegacyArtifact(value)) return value.status === STATUS_INCOMPLETE ? null : { ...value.blockRange };
  try { validateOutput(value); } catch (_) { fail("CURSOR", "PRIOR_ARTIFACT_INVALID"); }
  return value.lastCompleteCursor === null ? null : { ...value.lastCompleteCursor };
}
function emptyOutput(generatedAt) {
  return {
    schema: SCHEMA, generatedAt, status: STATUS_INCOMPLETE, outcome: "INCOMPLETE", phase: "NONE", code: "NONE", chainId: 42161,
    eventOnly: true, sourcePinned: true,
    qualification: { anonymousCandidateCount: 0, anonymousChainMatchedCount: 0, anonymousLogQualifiedCount: 0, selectedFamilyCount: 0 },
    blockRange: { fromBlock: null, toBlock: null }, reads: { count: 0, maximum: LIMITS.calls, retries: 0 },
    lastCompleteCursor: null,
    continuation: { mode: "INCOMPLETE", previousToBlock: null, nextFromBlock: null, cursorAdvanced: false, backlogRemaining: null, blocksScanned: 0 },
    route: { routeObserved: false, routePositive: "n/a", stateInterpretationPerformed: false },
    safety: { readOnlyRpc: true, transactions: false, signing: false, broadcast: false, walletAccess: false, productionMutation: false }
  };
}
function validateOutput(output) {
  const successful = output.status === STATUS_COMPLETE || output.status === STATUS_SURVIVOR;
  const keys = ["schema", "generatedAt", "status", "outcome", "phase", "code", "chainId", "eventOnly", "sourcePinned", "qualification", "blockRange", "reads", "lastCompleteCursor", "continuation", "route", "safety", ...(successful ? ["eventCount", "categoryCounts", "events"] : [])];
  if (!exactKeys(output, keys) || output.schema !== SCHEMA || !iso(output.generatedAt) || ![STATUS_COMPLETE, STATUS_SURVIVOR, STATUS_INCOMPLETE].includes(output.status)
      || !PHASES.has(output.phase) || !CODES.has(output.code) || output.chainId !== 42161 || output.eventOnly !== true || output.sourcePinned !== true
      || successful !== (output.phase === "NONE" && output.code === "NONE") || output.outcome !== (output.status === STATUS_COMPLETE ? "COMPLETE_ZERO_EVENTS" : output.status === STATUS_SURVIVOR ? "EVENT_SURVIVOR_NO_ROUTE" : "INCOMPLETE")
      || !exactKeys(output.qualification, ["anonymousCandidateCount", "anonymousChainMatchedCount", "anonymousLogQualifiedCount", "selectedFamilyCount"])
      || !exactKeys(output.blockRange, ["fromBlock", "toBlock"]) || !exactKeys(output.reads, ["count", "maximum", "retries"])
      || output.lastCompleteCursor !== null && !validRange(output.lastCompleteCursor)
      || !exactKeys(output.continuation, ["mode", "previousToBlock", "nextFromBlock", "cursorAdvanced", "backlogRemaining", "blocksScanned"])
      || !["FIRST_WINDOW", "CONTINUATION", "NO_NEW_FINALIZED_BLOCK", "INCOMPLETE"].includes(output.continuation.mode)
      || output.continuation.previousToBlock !== null && !decimal(output.continuation.previousToBlock) || output.continuation.nextFromBlock !== null && !decimal(output.continuation.nextFromBlock)
      || typeof output.continuation.cursorAdvanced !== "boolean" || output.continuation.backlogRemaining !== null && typeof output.continuation.backlogRemaining !== "boolean"
      || !Number.isSafeInteger(output.continuation.blocksScanned) || output.continuation.blocksScanned < 0 || output.continuation.blocksScanned > LIMITS.windowBlocks
      || !exactKeys(output.route, ["routeObserved", "routePositive", "stateInterpretationPerformed"]) || stable(output.route) !== stable({ routeObserved: false, routePositive: "n/a", stateInterpretationPerformed: false })
      || !exactKeys(output.safety, ["readOnlyRpc", "transactions", "signing", "broadcast", "walletAccess", "productionMutation"]) || stable(output.safety) !== stable({ readOnlyRpc: true, transactions: false, signing: false, broadcast: false, walletAccess: false, productionMutation: false })) fail("OUTPUT", "OUTPUT_INVALID");
  const counts = Object.values(output.qualification);
  if (!counts.every(Number.isSafeInteger) || output.qualification.anonymousCandidateCount > LIMITS.candidates || output.qualification.anonymousChainMatchedCount > output.qualification.anonymousCandidateCount || output.qualification.anonymousLogQualifiedCount > output.qualification.anonymousChainMatchedCount || output.qualification.selectedFamilyCount > 2
      || !Number.isSafeInteger(output.reads.count) || output.reads.count > LIMITS.calls || output.reads.maximum !== LIMITS.calls || output.reads.retries !== 0) fail("OUTPUT", "OUTPUT_INVALID");
  if (successful) {
    if (!Number.isSafeInteger(output.eventCount) || output.eventCount < 0 || output.eventCount > LIMITS.events || !Array.isArray(output.events) || output.events.length !== output.eventCount || !exactKeys(output.categoryCounts, EVENT_NAMES) || !Object.values(output.categoryCounts).every(Number.isSafeInteger) || Object.values(output.categoryCounts).reduce((a, b) => a + b, 0) !== output.eventCount
        || output.status === STATUS_COMPLETE !== (output.eventCount === 0) || output.events.some((row) => !exactKeys(row, ["category", "blockNumber", "transactionIndex", "logIndex", "commitment"]) || !EVENT_NAMES.includes(row.category) || !decimal(row.blockNumber) || !decimal(row.transactionIndex) || !decimal(row.logIndex) || !/^sha256-[A-Za-z0-9_-]{43}$/u.test(row.commitment))) fail("OUTPUT", "OUTPUT_INVALID");
    const noNew = output.continuation.mode === "NO_NEW_FINALIZED_BLOCK";
    if (noNew) {
      if (output.status !== STATUS_COMPLETE || output.eventCount !== 0 || output.lastCompleteCursor === null || output.blockRange.fromBlock !== null || output.blockRange.toBlock !== null || output.continuation.cursorAdvanced || output.continuation.blocksScanned !== 0 || output.continuation.backlogRemaining !== false || output.continuation.previousToBlock !== output.lastCompleteCursor.toBlock || output.continuation.nextFromBlock !== (BigInt(output.lastCompleteCursor.toBlock) + 1n).toString()) fail("OUTPUT", "OUTPUT_INVALID");
    } else if (!["FIRST_WINDOW", "CONTINUATION"].includes(output.continuation.mode) || !validRange(output.blockRange) || stable(output.lastCompleteCursor) !== stable(output.blockRange) || output.continuation.cursorAdvanced !== true || output.continuation.blocksScanned !== Number(BigInt(output.blockRange.toBlock) - BigInt(output.blockRange.fromBlock) + 1n) || output.continuation.nextFromBlock !== (BigInt(output.blockRange.toBlock) + 1n).toString() || (output.continuation.mode === "FIRST_WINDOW") !== (output.continuation.previousToBlock === null) || output.continuation.mode === "CONTINUATION" && BigInt(output.blockRange.fromBlock) !== BigInt(output.continuation.previousToBlock) + 1n) fail("OUTPUT", "OUTPUT_INVALID");
  } else if (output.continuation.mode !== "INCOMPLETE" || output.continuation.cursorAdvanced || output.continuation.backlogRemaining !== null || output.continuation.blocksScanned !== 0 || output.blockRange.fromBlock !== null || output.blockRange.toBlock !== null || (output.lastCompleteCursor === null ? output.continuation.previousToBlock !== null || output.continuation.nextFromBlock !== null : output.continuation.previousToBlock !== output.lastCompleteCursor.toBlock || output.continuation.nextFromBlock !== (BigInt(output.lastCompleteCursor.toBlock) + 1n).toString())) {
    fail("OUTPUT", "OUTPUT_INVALID");
  }
  const serialized = JSON.stringify(output);
  if (/(?:https?|wss?):\/\/|0x[0-9a-f]{8,}|\b(?:credentials?|secrets?|api[- _]?keys?|authorization|bearer|endpoints?|rpc[_-]?endpoints|raw[- _]?logs?)\b/iu.test(serialized)) fail("OUTPUT", "OUTPUT_INVALID");
  return true;
}
async function runScanner(options = {}) {
  const now = options.now || Date.now, output = emptyOutput(new Date(now()).toISOString()), budget = new Budget(options.maxCalls ?? LIMITS.calls), transport = options.transport || fetchTransport, checkInventory = options.assertInventoryUnchangedFn || inventoryUnchanged; let inventory = null; let priorRecord = null; let priorCursor = null;
  try {
    if (Object.hasOwn(options, "priorArtifact")) priorRecord = { value: options.priorArtifact, identity: "injected" };
    else priorRecord = (options.readPriorArtifactFn || readStablePriorArtifact)();
    if (!priorRecord || !Object.hasOwn(priorRecord, "value") || !Object.hasOwn(priorRecord, "identity")) fail("CURSOR", "PRIOR_ARTIFACT_INVALID");
    priorCursor = cursorFromPrior(priorRecord.value); output.lastCompleteCursor = priorCursor; output.continuation.previousToBlock = priorCursor?.toBlock ?? null; output.continuation.nextFromBlock = priorCursor ? (BigInt(priorCursor.toBlock) + 1n).toString() : null;
    const authority = await (options.authorityAdapter || readAuthority)(options.authorityOptions || {});
    inventory = options.inventoryText !== undefined ? { text: options.inventoryText, identity: options.inventoryIdentity ?? "injected" } : (options.readInventoryFn ? options.readInventoryFn() : readStableInventory());
    if (!inventory || typeof inventory.text !== "string" || !Object.hasOwn(inventory, "identity")) fail("INVENTORY", "INVENTORY_INVALID");
    const candidates = parseInventoryText(inventory.text, options.operatorClassifier || classifyOperatorFamily).filter((row) => row.family); output.qualification.anonymousCandidateCount = candidates.length;
    const chainMatched = [];
    for (const candidate of candidates) { try { if (await detectChain(candidate, budget, transport)) chainMatched.push(candidate); } catch (error) { if (error instanceof ScannerError && error.code === "READ_CAP") throw error; } }
    output.qualification.anonymousChainMatchedCount = chainMatched.length;
    const qualified = [];
    for (const candidate of chainMatched) { try { qualified.push(await qualify(candidate, authority, budget, transport)); } catch (error) { if (error instanceof ScannerError && ["READ_CAP", "EVENT_CAP"].includes(error.code)) throw error; } }
    output.qualification.anonymousLogQualifiedCount = qualified.length;
    if (new Set(qualified.map((row) => row.candidate.family)).size < 2) fail("QUALIFICATION", "TWO_FAMILIES_UNAVAILABLE");
    const agreed = await commonFinalized(qualified, budget, transport); output.qualification.selectedFamilyCount = 2;
    const common = BigInt(agreed.pin.number);
    if (priorCursor && BigInt(priorCursor.toBlock) > common) fail("QUALIFICATION", "FINALITY_REGRESSION");
    if (priorCursor && BigInt(priorCursor.toBlock) === common) {
      await terminalPin(agreed.selected, agreed.pin, budget, transport); checkInventory(inventory.identity);
      output.status = STATUS_COMPLETE; output.outcome = "COMPLETE_ZERO_EVENTS"; output.eventCount = 0; output.categoryCounts = categoryCounts([]); output.events = [];
      output.continuation = { mode: "NO_NEW_FINALIZED_BLOCK", previousToBlock: priorCursor.toBlock, nextFromBlock: (common + 1n).toString(), cursorAdvanced: false, backlogRemaining: false, blocksScanned: 0 };
    } else {
      const from = priorCursor ? BigInt(priorCursor.toBlock) + 1n : (common >= BigInt(LIMITS.windowBlocks - 1) ? common - BigInt(LIMITS.windowBlocks - 1) : 0n);
      const to = priorCursor ? (common < from + BigInt(LIMITS.windowBlocks - 1) ? common : from + BigInt(LIMITS.windowBlocks - 1)) : common;
      const captured = await capture(agreed.selected, agreed.pin, from, to, authority, budget, transport);
      await terminal(captured, budget, transport); checkInventory(inventory.identity);
      const events = captured.views[0].logs; output.status = events.length ? STATUS_SURVIVOR : STATUS_COMPLETE; output.outcome = events.length ? "EVENT_SURVIVOR_NO_ROUTE" : "COMPLETE_ZERO_EVENTS";
      output.blockRange = { fromBlock: captured.from.toString(), toBlock: captured.to.toString() }; output.lastCompleteCursor = { ...output.blockRange };
      output.continuation = { mode: priorCursor ? "CONTINUATION" : "FIRST_WINDOW", previousToBlock: priorCursor?.toBlock ?? null, nextFromBlock: (captured.to + 1n).toString(), cursorAdvanced: true, backlogRemaining: captured.to < common, blocksScanned: Number(captured.to - captured.from + 1n) };
      output.eventCount = events.length; output.categoryCounts = categoryCounts(events); output.events = events;
    }
  } catch (error) {
    const failure = error instanceof ScannerError ? error : new ScannerError("CAP", "UNEXPECTED"); output.phase = failure.phase; output.code = failure.code;
  } finally {
    if (inventory && output.code !== "INVENTORY_MUTATED") try { checkInventory(inventory.identity); } catch (_) { output.status = STATUS_INCOMPLETE; output.outcome = "INCOMPLETE"; output.phase = "INVENTORY"; output.code = "INVENTORY_MUTATED"; output.qualification.selectedFamilyCount = 0; }
    if (priorRecord && priorRecord.identity !== "injected") try { (options.assertPriorArtifactUnchangedFn || priorArtifactUnchanged)(priorRecord); } catch (_) { output.status = STATUS_INCOMPLETE; output.outcome = "INCOMPLETE"; output.phase = "CURSOR"; output.code = "PRIOR_ARTIFACT_MUTATED"; output.qualification.selectedFamilyCount = 0; }
    output.reads.count = budget.calls;
    if (output.status === STATUS_INCOMPLETE) { delete output.eventCount; delete output.categoryCounts; delete output.events; output.blockRange = { fromBlock: null, toBlock: null }; output.lastCompleteCursor = priorCursor; output.continuation = { mode: "INCOMPLETE", previousToBlock: priorCursor?.toBlock ?? null, nextFromBlock: priorCursor ? (BigInt(priorCursor.toBlock) + 1n).toString() : null, cursorAdvanced: false, backlogRemaining: null, blocksScanned: 0 }; }
  }
  validateOutput(output); return output;
}
function fsyncDirectory(directory, fsImpl) { let descriptor; try { descriptor = fsImpl.openSync(directory, "r"); fsImpl.fsyncSync(descriptor); } catch (_) {} finally { if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch (_) {} } }
function atomicWriteOutput(output, options = {}) {
  validateOutput(output); const fsImpl = options.fsImpl || fs, target = options.target || OUTPUT_FILE, parent = path.dirname(target), temporary = `${target}.tmp-${process.pid}`;
  let descriptor;
  try {
    fsImpl.mkdirSync(parent, { recursive: true });
    descriptor = fsImpl.openSync(temporary, "wx", 0o600); const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`); fsImpl.writeFileSync(descriptor, bytes); fsImpl.fsyncSync(descriptor); fsImpl.closeSync(descriptor); descriptor = undefined;
    fsImpl.renameSync(temporary, target); fsyncDirectory(parent, fsImpl); if (!fsImpl.readFileSync(target).equals(bytes)) fail("OUTPUT", "OUTPUT_INVALID");
  } catch (error) { if (error instanceof ScannerError) throw error; fail("OUTPUT", "OUTPUT_INVALID"); }
  finally { if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch (_) {} try { if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary); } catch (_) {} }
  return target;
}
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== "--live") { process.stderr.write("Refusing network access: invoke exactly with --live.\n"); process.exitCode = 1; return; }
  const output = await runScanner(); atomicWriteOutput(output);
  process.stdout.write(`${JSON.stringify({ status: output.status, outcome: output.outcome, readCount: output.reads.count, output: "reports/monitor/aave-v3-arbitrum-config-oracle-events.json" })}\n`);
  if (output.status === STATUS_INCOMPLETE) process.exitCode = 1;
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({
  SCHEMA, EVENT_GROUPS, EVENT_NAMES, LIMITS, OUTPUT_FILE, PINS, STATUS_COMPLETE, STATUS_INCOMPLETE, STATUS_SURVIVOR, ScannerError,
  atomicWriteOutput, deriveEvents, normalizeLogs, parseInventoryText, readAuthority, runScanner, validateArtifact: validateOutput, validateOutput
});
