"use strict";

// Transports are supplied in-process by the caller after independent-family qualification.
// This module does not discover endpoints, open a network transport, or read credentials.
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
const { performance } = require("node:perf_hooks");
const { Interface } = require("../node_modules/ethers");
const MARKET = "0xb125e6687d4313864e53df431d5425969c15eb2f", CHAIN_ID = 8453;
const SEED_SCHEMA = "compound-v3-base-borrower-seed/v1", INDEX_SCHEMA = "compound-v3-base-borrower-index/v1";
const MAX_SEED_BYTES = 8 * 1024 * 1024, CANDIDATE_CAP = 1000, LOG_CAP = 5000;
const MAX_WINDOW = 120000, MAX_CHUNK = 2000, MAX_CHUNKS = 120;
const EVENTS = new Interface(["event Withdraw(address indexed src,address indexed to,uint256 amount)", "event Transfer(address indexed from,address indexed to,uint256 amount)"]);
const TOPICS = ["Withdraw", "Transfer"].map((name) => EVENTS.getEvent(name).topicHash);
const ERROR_CODES = ["SEED_INVALID", "SEED_BOUND_EXCEEDED", "SEED_READ_FAILED", "SEED_PIN_AHEAD", "DUAL_PROVIDER_REQUIRED", "PROVIDER_DISAGREEMENT", "LOG_MISMATCH", "INDEX_INVALID", "DISCOVERY_INCOMPLETE", "DISCOVERY_BOUND_EXCEEDED", "PIN_INVALID", "PIN_DRIFT", "CHAIN_MISMATCH", "READ_INVALID", "RPC_FAILURE", "RPC_BUDGET_EXCEEDED", "TIME_BUDGET_EXCEEDED", "RESPONSE_BOUND_EXCEEDED"];
const fail = (code) => { throw new Error(code); };
const safeCode = (error) => ERROR_CODES.includes(error?.message) ? error.message : "RPC_FAILURE";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const isHash = (v) => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const isQuantity = (v) => typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v);
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER - 1) => Number.isSafeInteger(v) && v >= min && v <= max;
const keys = (v, allowed) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => allowed.includes(k));
const validPin = (p) => keys(p, ["number", "hash", "timestamp"]) && integer(p.number) && isHash(p.hash) && integer(p.timestamp, 1);
function normalizedPin(pin) {
  if (!validPin(pin)) fail("PIN_INVALID");
  return { number: pin.number, hash: pin.hash.toLowerCase(), timestamp: pin.timestamp };
}
function matchesHeader(header, pin) {
  return header && isQuantity(header.number) && BigInt(header.number) === BigInt(pin.number)
    && isHash(header.hash) && header.hash.toLowerCase() === pin.hash
    && isQuantity(header.timestamp) && BigInt(header.timestamp) === BigInt(pin.timestamp);
}
function validateTransports(transports) {
  if (!Array.isArray(transports) || transports.length !== 2 || transports.some((t) => typeof t !== "function") || transports[0] === transports[1]) fail("DUAL_PROVIDER_REQUIRED");
}
function normalizedUsers(users, cap = CANDIDATE_CAP) {
  if (!Array.isArray(users)) fail("SEED_INVALID");
  if (users.length > cap) fail("SEED_BOUND_EXCEEDED");
  if (users.some((u) => typeof u !== "string" || !/^0x[0-9a-f]{40}$/i.test(u) || /^0x0{40}$/i.test(u))) fail("SEED_INVALID");
  return [...new Set(users.map((u) => u.toLowerCase()))].sort();
}
function normalizeLogs(logs, { fromBlock, toBlock, pin, logCap = LOG_CAP }) {
  if (!Array.isArray(logs)) fail("READ_INVALID");
  if (logs.length > logCap) fail("DISCOVERY_BOUND_EXCEEDED");
  const found = new Map(), blockHashes = new Map();
  for (const log of logs) {
    if (!log || typeof log.address !== "string" || log.address.toLowerCase() !== MARKET || log.removed !== false
        || !isQuantity(log.blockNumber) || !isHash(log.blockHash) || !isHash(log.transactionHash) || !isQuantity(log.logIndex)
        || !integer(Number(BigInt(log.blockNumber)), fromBlock, toBlock) || !integer(Number(BigInt(log.logIndex)))
        || (log.transactionIndex != null && (!isQuantity(log.transactionIndex) || !integer(Number(BigInt(log.transactionIndex)))))
        || !Array.isArray(log.topics) || log.topics.length !== 3 || !isHash(log.topics[0]) || !TOPICS.includes(log.topics[0].toLowerCase())
        || !log.topics.slice(1).every((t) => typeof t === "string" && /^0x0{24}[0-9a-f]{40}$/i.test(t))
        || typeof log.data !== "string" || !/^0x[0-9a-f]{64}$/i.test(log.data)) fail("READ_INVALID");
    const blockNumber = Number(BigInt(log.blockNumber)), blockHash = log.blockHash.toLowerCase();
    if (blockNumber === pin.number && blockHash !== pin.hash) fail("PIN_DRIFT");
    if (blockHashes.has(blockNumber) && blockHashes.get(blockNumber) !== blockHash) fail("READ_INVALID");
    blockHashes.set(blockNumber, blockHash);
    let parsed; try { parsed = EVENTS.parseLog(log); } catch (_) { fail("READ_INVALID"); }
    if (!parsed) fail("READ_INVALID");
    const row = { address: MARKET, removed: false, blockNumber: hex(blockNumber), blockHash,
      transactionHash: log.transactionHash.toLowerCase(), transactionIndex: log.transactionIndex == null ? null : hex(BigInt(log.transactionIndex)),
      logIndex: hex(BigInt(log.logIndex)), topics: log.topics.map((t) => t.toLowerCase()), data: log.data.toLowerCase() };
    const id = `${blockNumber}:${row.logIndex}`;
    if (found.has(id) && JSON.stringify(found.get(id)) !== JSON.stringify(row)) fail("READ_INVALID");
    found.set(id, row);
  }
  return [...found.values()].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
}
const logsDigest = (logs) => sha(JSON.stringify(logs));
function validateProvenance(p) {
  return p === null || (keys(p, ["schema", "sha256", "hashScope", "updatedAt", "pin", "candidateCount", "coverage", "legacyHintsOnly", "coverageClaimsTrusted"])
    && [SEED_SCHEMA, INDEX_SCHEMA].includes(p.schema) && /^[0-9a-f]{64}$/.test(p.sha256)
    && p.hashScope === "validated-sanitized-seed-file-bytes" && typeof p.updatedAt === "string" && Number.isFinite(Date.parse(p.updatedAt))
    && validPin(p.pin) && integer(p.candidateCount, 0, CANDIDATE_CAP) && p.coverage === "PARTIAL"
    && p.legacyHintsOnly === (p.schema === SEED_SCHEMA) && p.coverageClaimsTrusted === false);
}
function validateIndex(doc) {
  const w = doc.window;
  if (!keys(w, ["fromBlock", "toBlock", "chunkBlocks", "maxChunks", "backfill"]) || !integer(w.fromBlock) || !integer(w.toBlock, w.fromBlock, doc.pin.number)
      || w.toBlock - w.fromBlock + 1 > MAX_WINDOW || !integer(w.chunkBlocks, 1, MAX_CHUNK) || !integer(w.maxChunks, 1, MAX_CHUNKS) || typeof w.backfill !== "boolean"
      || !integer(doc.nextCursor, w.fromBlock, w.toBlock + 1) || !Array.isArray(doc.coveredRanges) || doc.coveredRanges.length > MAX_CHUNKS
      || !Array.isArray(doc.gaps) || doc.gaps.length > 1 || !Array.isArray(doc.logs) || doc.logs.length > LOG_CAP
      || doc.coverage !== "PARTIAL" || doc.fullHistoryEstablished !== false || typeof doc.pinVerified !== "boolean"
      || doc.corroboration !== "TWO_CALLER_QUALIFIED_TRANSPORTS_EXACT_LOG_AGREEMENT"
      || !["COMPLETE", "INCOMPLETE"].includes(doc.status) || !(doc.reason === null || ERROR_CODES.includes(doc.reason)) || !validateProvenance(doc.seedProvenance)) fail("SEED_INVALID");
  const logs = normalizeLogs(doc.logs, { ...w, pin: normalizedPin(doc.pin) });
  if (JSON.stringify(logs) !== JSON.stringify(doc.logs)) fail("SEED_INVALID");
  let cursor = w.fromBlock, coveredBlocks = 0, logCount = 0;
  for (const range of doc.coveredRanges) {
    if (!keys(range, ["fromBlock", "toBlock", "logCount", "logsSha256"]) || range.fromBlock !== cursor || range.toBlock !== Math.min(w.toBlock, cursor + w.chunkBlocks - 1)) fail("SEED_INVALID");
    const subset = logs.filter((l) => Number(BigInt(l.blockNumber)) >= cursor && Number(BigInt(l.blockNumber)) <= range.toBlock);
    if (range.logCount !== subset.length || range.logsSha256 !== logsDigest(subset)) fail("SEED_INVALID");
    logCount += subset.length; coveredBlocks += range.toBlock - cursor + 1; cursor = range.toBlock + 1;
  }
  if (cursor !== doc.nextCursor || logCount !== logs.length || coveredBlocks !== doc.coveredBlocks || doc.successfulChunks !== doc.coveredRanges.length
      || (!doc.pinVerified && doc.successfulChunks !== 0)) fail("SEED_INVALID");
  for (const gap of doc.gaps) {
    if (!keys(gap, ["fromBlock", "toBlock", "reason"]) || gap.fromBlock !== cursor || !integer(gap.toBlock, cursor, w.toBlock) || !ERROR_CODES.includes(gap.reason) || gap.reason !== doc.reason) fail("SEED_INVALID");
  }
  if (doc.status === "COMPLETE" && (cursor !== w.toBlock + 1 || doc.gaps.length || !doc.pinVerified || doc.reason !== null)) fail("SEED_INVALID");
  if (doc.status === "INCOMPLETE" && (doc.reason === null || (cursor === w.toBlock + 1 && !doc.gaps.length && doc.pinVerified))) fail("SEED_INVALID");
  const users = new Set(normalizedUsers(doc.users));
  if (logs.some((log) => { const user = `0x${log.topics[1].slice(-40)}`; return !/^0x0{40}$/.test(user) && !users.has(user); })) fail("SEED_INVALID");
}
function parseSeed(bytes, { candidateCap = CANDIDATE_CAP } = {}) {
  if (!integer(candidateCap, 1, CANDIDATE_CAP)) fail("SEED_INVALID");
  if (!(typeof bytes === "string" || Buffer.isBuffer(bytes))) fail("SEED_INVALID");
  if (Buffer.byteLength(bytes) > MAX_SEED_BYTES) fail("SEED_BOUND_EXCEEDED");
  bytes = Buffer.from(bytes);
  let doc; try { doc = JSON.parse(bytes.toString("utf8")); } catch (_) { fail("SEED_INVALID"); }
  const common = ["schema", "updatedAt", "market", "chainId", "pin", "users"];
  const legacy = ["blocksScanned", "logsFound", "candidatesChecked", "activeBorrowerCount", "totalDiscoveredDebtRaw", "totalDiscoveredDebtUsdc"];
  const index = ["window", "nextCursor", "coveredRanges", "gaps", "logs", "coverage", "fullHistoryEstablished", "pinVerified", "status", "reason", "seedProvenance", "successfulChunks", "coveredBlocks", "corroboration"];
  if (!doc || ![SEED_SCHEMA, INDEX_SCHEMA].includes(doc.schema) || !keys(doc, [...common, ...(doc.schema === SEED_SCHEMA ? legacy : index)])
      || doc.chainId !== CHAIN_ID || typeof doc.market !== "string" || doc.market.toLowerCase() !== MARKET || !validPin(doc.pin)
      || typeof doc.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(doc.updatedAt) || !Number.isFinite(Date.parse(doc.updatedAt))) fail("SEED_INVALID");
  const users = normalizedUsers(doc.users, candidateCap);
  if (doc.schema === SEED_SCHEMA) {
    for (const field of legacy.slice(0, 4)) if (Object.hasOwn(doc, field) && !integer(doc[field])) fail("SEED_INVALID");
    if (Object.hasOwn(doc, "totalDiscoveredDebtRaw") && (typeof doc.totalDiscoveredDebtRaw !== "string" || !/^(?:0|[1-9][0-9]{0,77})$/.test(doc.totalDiscoveredDebtRaw))) fail("SEED_INVALID");
    if (Object.hasOwn(doc, "totalDiscoveredDebtUsdc") && (typeof doc.totalDiscoveredDebtUsdc !== "number" || !Number.isFinite(doc.totalDiscoveredDebtUsdc) || doc.totalDiscoveredDebtUsdc < 0)) fail("SEED_INVALID");
  } else {
    try { validateIndex(doc); } catch (_) { fail("SEED_INVALID"); }
  }
  // Only validated, closed-schema public chain data is hashed; arbitrary extra fields fail above.
  const provenance = { schema: doc.schema, sha256: sha(bytes), hashScope: "validated-sanitized-seed-file-bytes", updatedAt: doc.updatedAt,
    pin: normalizedPin(doc.pin), candidateCount: users.length, coverage: "PARTIAL", legacyHintsOnly: doc.schema === SEED_SCHEMA, coverageClaimsTrusted: false };
  return { document: doc, users, provenance, bytes };
}
function loadSeed(file, { optional = false, ...options } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    if (fs.fstatSync(fd).size > MAX_SEED_BYTES) fail("SEED_BOUND_EXCEEDED");
    const buffer = Buffer.alloc(MAX_SEED_BYTES + 1); let length = 0, read;
    do { read = fs.readSync(fd, buffer, length, buffer.length - length, null); length += read; } while (read && length < buffer.length);
    return parseSeed(buffer.subarray(0, length), options);
  } catch (error) {
    if (error.code === "ENOENT" && optional) return null;
    if (["SEED_INVALID", "SEED_BOUND_EXCEEDED"].includes(error.message)) throw error;
    fail("SEED_READ_FAILED");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function scanBorrowerIndex({ transports, pin, seedBytes = null, windowBlocks = 2000, chunkBlocks = 2000,
  maxChunks = 10, fromBlock = null, backfill = false, candidateCap = CANDIDATE_CAP, maxMs = 120000, now = () => performance.now() } = {}) {
  validateTransports(transports); pin = normalizedPin(pin);
  if (!integer(windowBlocks, 1, MAX_WINDOW) || !integer(chunkBlocks, 1, MAX_CHUNK) || !integer(maxChunks, 1, MAX_CHUNKS)
      || !integer(candidateCap, 1, CANDIDATE_CAP) || !integer(maxMs, 1, 120000) || typeof now !== "function"
      || typeof backfill !== "boolean" || (fromBlock !== null && !integer(fromBlock, 0, pin.number))) fail("INDEX_INVALID");
  const seed = seedBytes === null ? null : parseSeed(seedBytes, { candidateCap });
  if (seed && seed.provenance.pin.number > pin.number) fail("SEED_PIN_AHEAD");
  const prior = seed?.document.schema === INDEX_SCHEMA && JSON.stringify(normalizedPin(seed.document.pin)) === JSON.stringify(pin) ? seed.document : null;
  const start = fromBlock ?? Math.max(0, pin.number - windowBlocks + 1);
  const end = Math.min(pin.number, start + windowBlocks - 1);
  if (!backfill && end !== pin.number) fail("INDEX_INVALID");
  const resume = prior && prior.window.fromBlock === start && prior.window.toBlock === end && prior.window.chunkBlocks === chunkBlocks && prior.pinVerified;
  const users = new Set(seed?.users ?? []);
  const result = { schema: INDEX_SCHEMA, updatedAt: new Date().toISOString(), chainId: CHAIN_ID, market: MARKET, pin,
    users: [...users], window: { fromBlock: start, toBlock: end, chunkBlocks, maxChunks, backfill }, nextCursor: resume ? prior.nextCursor : start,
    coveredRanges: resume ? prior.coveredRanges.map((r) => ({ ...r })) : [], gaps: [], logs: resume ? prior.logs.slice() : [],
    successfulChunks: resume ? prior.successfulChunks : 0, coveredBlocks: resume ? prior.coveredBlocks : 0,
    coverage: "PARTIAL", fullHistoryEstablished: false, pinVerified: false, status: "INCOMPLETE", reason: null, seedProvenance: seed?.provenance ?? null,
    corroboration: "TWO_CALLER_QUALIFIED_TRANSPORTS_EXACT_LOG_AGREEMENT" };
  const started = now(); let requests = 0;
  async function pair(method, params) {
    if (now() - started >= maxMs) fail("TIME_BUDGET_EXCEEDED");
    // Supplied transports must honor this timeout and their response-byte cap. Wait
    // for both to settle; never publish while one sibling request is still pending.
    const settled = await Promise.allSettled(transports.map(async (send) => send(method, params, ++requests, Math.max(1, Math.min(15000, maxMs - (now() - started))))));
    const failed = settled.find((r) => r.status === "rejected");
    if (failed) fail(safeCode(failed.reason));
    if (now() - started >= maxMs) fail("TIME_BUDGET_EXCEEDED");
    return settled.map((r) => r.value);
  }
  async function recheck() {
    const headers = await pair("eth_getBlockByNumber", [hex(pin.number), false]);
    if (!headers.every((header) => matchesHeader(header, pin))) fail("PIN_DRIFT");
  }
  try {
    const chains = await pair("eth_chainId", []);
    if (!chains.every((id) => isQuantity(id) && BigInt(id) === BigInt(CHAIN_ID))) fail("CHAIN_MISMATCH");
    await recheck();
    for (let attempted = 0; result.nextCursor <= end && attempted < maxChunks; attempted++) {
      const from = result.nextCursor, to = Math.min(end, from + chunkBlocks - 1);
      try {
        if (result.successfulChunks >= MAX_CHUNKS) fail("DISCOVERY_BOUND_EXCEEDED");
        const responses = await pair("eth_getLogs", [{ address: MARKET, fromBlock: hex(from), toBlock: hex(to), topics: [TOPICS] }]);
        const logs = responses.map((rows) => normalizeLogs(rows, { fromBlock: from, toBlock: to, pin }));
        if (JSON.stringify(logs[0]) !== JSON.stringify(logs[1])) fail("LOG_MISMATCH");
        const nextUsers = new Set(users);
        for (const log of logs[0]) { const user = `0x${log.topics[1].slice(-40)}`; if (!/^0x0{40}$/.test(user)) nextUsers.add(user); }
        if (nextUsers.size > candidateCap || result.logs.length + logs[0].length > LOG_CAP) fail("DISCOVERY_BOUND_EXCEEDED");
        // Commit a chunk only after both complete responses, validation, comparison, and caps pass.
        nextUsers.forEach((user) => users.add(user)); result.logs.push(...logs[0]);
        result.coveredRanges.push({ fromBlock: from, toBlock: to, logCount: logs[0].length, logsSha256: logsDigest(logs[0]) });
        result.successfulChunks++; result.coveredBlocks += to - from + 1; result.nextCursor = to + 1;
      } catch (error) {
        result.reason = safeCode(error); result.gaps.push({ fromBlock: from, toBlock: to, reason: result.reason }); break;
      }
    }
    await recheck(); result.pinVerified = true;
    result.status = result.nextCursor === end + 1 && !result.gaps.length ? "COMPLETE" : "INCOMPLETE";
    if (result.status !== "COMPLETE" && result.reason === null) result.reason = "DISCOVERY_INCOMPLETE";
  } catch (error) {
    // A failed canonical-pin check invalidates coverage, including cached coverage at that pin.
    result.reason = safeCode(error); result.coveredRanges = []; result.logs = []; result.successfulChunks = 0; result.coveredBlocks = 0; result.nextCursor = start;
    result.gaps = [{ fromBlock: start, toBlock: end, reason: result.reason }];
  }
  // Keep all candidate addresses, including those that later screen with zero current debt.
  result.users = [...users].sort();
  return result;
}
function persistBorrowerIndex(file, index, { replace = false } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`); parseSeed(bytes);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`; let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (replace) fs.renameSync(temp, file); else fs.linkSync(temp, file);
    return { sha256: sha(bytes), bytes: bytes.length };
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (_) {} }
}
module.exports = { parseSeed, loadSeed, scanBorrowerIndex, persistBorrowerIndex, normalizeLogs, normalizedPin, validateTransports,
  TOPICS, MARKET, CHAIN_ID, SEED_SCHEMA, INDEX_SCHEMA, MAX_SEED_BYTES, CANDIDATE_CAP, MAX_WINDOW, MAX_CHUNK, MAX_CHUNKS, ERROR_CODES };
