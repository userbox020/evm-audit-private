#!/usr/bin/env node
"use strict";

// Bounded, config-driven, read-only ERC-20 value-flow clustering scanner.
// Pins one finalized/latest block per chain, reads Transfer logs over a bounded
// trailing window, and clusters net token flow per public address. Emits exactly
// one sanitized artifact. RPC endpoint material, endpoint identities, and raw
// responses remain process-only. No signing, no transactions, no broadcast.
// Fail closed per token; the scanner is a behaviour/state signal, not a source read.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const shared = require("./shared-rpc");
const { AbiCoder, id: keccakId } = require("ethers");

const CLAIM = "monitor/value-flow-cluster";
const SCHEMA = "value-flow-cluster/v1";
const CONFIG_SCHEMA = "value-flow-targets/v1";
const WORKSPACE = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(__dirname, "value-flow-targets.json");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "value-flow-cluster.json");

const MAX_NETWORK_CALLS = 256;
const MAX_TARGETS = 64;
const MAX_WINDOW_BLOCKS = 50000;
const DEFAULT_CHUNK_BLOCKS = 2000;
const MIN_CHUNK_BLOCKS = 10;
const MAX_LOGS_PER_TARGET = 60000;
const MAX_ADDRESSES = 50000;
const MIN_TX_DEFAULT = 3;
const TOP_ROWS = 25;
const RPC_TIMEOUT_MS = 9000;
const ENTRY_TIMEOUT_MS = 20000;
const TOTAL_TIMEOUT_MS = 120000;
const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/;
const DATA_RE = /^0x[0-9a-fA-F]{64}$/;
const BLOCK_TAG_RE = /^(?:finalized|safe|latest|0x[0-9a-f]+)$/;
const USAGE = "value-flow-cluster: bounded read-only ERC-20 net-flow clustering scanner; pass --run-once to execute.\n";

// keccak256("Transfer(address,address,uint256)") — computed, never hard-coded.
const TRANSFER_TOPIC = keccakId("Transfer(address,address,uint256)").toLowerCase();
const CODER = AbiCoder.defaultAbiCoder();

const ERROR_CLASS = Object.freeze({
  ENDPOINT_UNAVAILABLE: "ENDPOINT_UNAVAILABLE",
  RPC_READ_FAILED: "RPC_READ_FAILED",
  RPC_CALL_CAP: "RPC_CALL_CAP",
  BLOCK_PIN_FAILED: "BLOCK_PIN_FAILED",
  LOG_CAP: "LOG_CAP",
  ADDRESS_CAP: "ADDRESS_CAP",
  LOG_DECODE_FAILED: "LOG_DECODE_FAILED",
  ENTRY_TIMEOUT: "ENTRY_TIMEOUT",
  SCANNER_TIMEOUT: "SCANNER_TIMEOUT",
  SCHEMA: "SCHEMA_INVALID"
});

const URL_RE = /(?:https?|wss?):\/\/[^\s"'<>[\]()]*/gi;
const SENSITIVE_KEY_RE = /(?:url|uri|endpoint|rpc|provider|authorization|auth|secret|apikey|api[_-]?key|header|bearer|password|credential|private[_-]?key)/i;
// Public on-chain identifiers that must survive redaction (token/contract addresses,
// directed-flow endpoints, row ids). Endpoint material never appears under these keys.
const PROTECTED_KEY_RE = /^(?:token|from|to|address|id)$/i;
const LEAK_PATTERN = /(?:https?|wss?):\/\/|authorization\s*:|bearer\s|api[_-]?key|private[_-]?key|mnemonic|rpc_endpoints|\.env\b|secret|infura|alchemy|nodereal|publicnode|drpc\.org/i;

class WorkError extends Error {
  constructor(code) { super(code); this.name = "WorkError"; this.code = code; }
}
function fail(code) { throw new WorkError(code); }
function lower(value) { return String(value).toLowerCase(); }
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function iso(value) {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch (_) { return false; }
}
function unsigned(value) { return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value); }
function address(value) { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value); }
function addressLower(value) { return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value); }
function positiveInt(value, max) { return Number.isSafeInteger(value) && value > 0 && value <= max; }
function nonNegInt(value) { return Number.isInteger(value) && value >= 0; }

// --- deep redaction -----------------------------------------------------------------------
function redact(value) {
  if (typeof value === "string") return value.replace(URL_RE, "[redacted-url]");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (isPlainObject(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = (!PROTECTED_KEY_RE.test(key) && SENSITIVE_KEY_RE.test(key)) ? "[redacted]" : redact(item);
    }
    return output;
  }
  return value;
}

// --- config validation --------------------------------------------------------------------
function validateSource(value) {
  return Array.isArray(value) && value.length <= 64
    && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 512);
}
function validateTarget(entry) {
  const keys = Object.keys(entry || {});
  const required = ["id", "chainId", "token", "decimals", "windowBlocks", "label"];
  const optional = ["source", "notes"];
  if (!required.every((key) => keys.includes(key)) || keys.some((key) => ![...required, ...optional].includes(key))) return false;
  if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(entry.id)) return false;
  if (!positiveInt(entry.chainId, 1_000_000_000)) return false;
  if (!address(entry.token)) return false;
  if (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 77) return false;
  if (!positiveInt(entry.windowBlocks, MAX_WINDOW_BLOCKS)) return false;
  if (typeof entry.label !== "string" || entry.label.length === 0 || entry.label.length > 200) return false;
  if (entry.source !== undefined && !validateSource(entry.source)) return false;
  if (entry.notes !== undefined && (typeof entry.notes !== "string" || entry.notes.length === 0 || entry.notes.length > 1000)) return false;
  return true;
}
function validateConfig(config) {
  try {
    if (!exactKeys(config, ["schema", "targets"])) return false;
    if (config.schema !== CONFIG_SCHEMA) return false;
    if (!Array.isArray(config.targets) || config.targets.length === 0 || config.targets.length > MAX_TARGETS) return false;
    if (!config.targets.every(validateTarget)) return false;
    const ids = config.targets.map((entry) => entry.id);
    return new Set(ids).size === ids.length;
  } catch (_) { return false; }
}
function loadConfig(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const file = path.resolve(options.configPath || CONFIG_PATH);
  const text = fsImpl.readFileSync(file, "utf8");
  const config = JSON.parse(text);
  if (!validateConfig(config)) fail("SCHEMA");
  return config;
}

// --- bounded chain transport (shared helper only, no retries) ------------------------------
function createLedger(options) {
  const max = positiveInt(options.maxNetworkCalls, MAX_NETWORK_CALLS) ? options.maxNetworkCalls : MAX_NETWORK_CALLS;
  return { calls: 0, max };
}
function createChainRpc(chainId, options, ledger) {
  const resolveRpc = options.resolveRpc || shared.resolveRpc;
  const rpcCall = options.rpcCall || shared.rpcCall;
  const timeoutMs = positiveInt(options.rpcTimeoutMs, 60_000) ? options.rpcTimeoutMs : RPC_TIMEOUT_MS;
  let resolved = null;
  async function resolve() {
    if (resolved !== null) return resolved;
    // Capability-qualified multi-candidate resolution: pools are only accepted when
    // they answer eth_getLogs, which is the transport this scanner depends on.
    const url = await resolveRpc(chainId, null, { capability: "logs" });
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) fail("ENDPOINT_UNAVAILABLE");
    resolved = url;
    return resolved;
  }
  async function tryCall(method, params, ms) {
    if (ledger.calls >= ledger.max) fail("RPC_CALL_CAP");
    const url = await resolve();
    ledger.calls += 1;
    return await rpcCall(url, method, params, ms || timeoutMs);
  }
  async function call(method, params, ms) {
    const result = await tryCall(method, params, ms);
    if (result === null || result === undefined) fail("RPC_READ_FAILED");
    return result;
  }
  return Object.freeze({ chainId, call, tryCall });
}

// --- block pinning (finalized > safe > latest > numeric) ----------------------------------
function hexQuantity(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) fail("BLOCK_PIN_FAILED");
  return BigInt(value).toString();
}
async function tryReadBlock(rpc, blockRef) {
  try {
    const raw = await rpc.call("eth_getBlockByNumber", [blockRef, false]);
    if (!isPlainObject(raw)) return null;
    const number = hexQuantity(raw.number);
    return { number, tag: blockRef, hex: `0x${BigInt(number).toString(16)}` };
  } catch (error) {
    if (error instanceof WorkError && (error.code === "ENDPOINT_UNAVAILABLE" || error.code === "RPC_CALL_CAP")) fail(error.code);
    return null;
  }
}
async function pinBlock(rpc, options) {
  const tags = options.preferFinalized === false ? ["latest", "safe"] : ["finalized", "safe", "latest"];
  for (const tag of tags) {
    const block = await tryReadBlock(rpc, tag);
    if (block) return block;
  }
  try {
    const numberHex = await rpc.call("eth_blockNumber", []);
    if (typeof numberHex === "string" && /^0x[0-9a-fA-F]+$/.test(numberHex)) {
      const block = await tryReadBlock(rpc, numberHex);
      if (block) return block;
    }
  } catch (error) {
    if (error instanceof WorkError && (error.code === "ENDPOINT_UNAVAILABLE" || error.code === "RPC_CALL_CAP")) fail(error.code);
  }
  fail("BLOCK_PIN_FAILED");
}

// --- transfer decoding --------------------------------------------------------------------
function topicAddress(topic) {
  if (typeof topic !== "string" || !TOPIC_RE.test(topic)) fail("LOG_DECODE_FAILED");
  return `0x${topic.slice(26)}`.toLowerCase();
}
function decodeAmount(data) {
  if (typeof data !== "string" || !DATA_RE.test(data)) fail("LOG_DECODE_FAILED");
  try { return BigInt(CODER.decode(["uint256"], data)[0]); } catch (_) { fail("LOG_DECODE_FAILED"); }
}
function decodeTransfer(log, token) {
  if (!isPlainObject(log)) return null;
  if (typeof log.address !== "string" || lower(log.address) !== lower(token)) return null;
  if (!Array.isArray(log.topics) || log.topics.length !== 3) return null;
  if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  return { from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]), amount: decodeAmount(log.data) };
}

// --- log collection (adaptive range chunking, globally bounded) ---------------------------
async function collectTransfers(rpc, entry, from, to, options) {
  const requested = positiveInt(options.chunkBlocks, MAX_WINDOW_BLOCKS) ? options.chunkBlocks : DEFAULT_CHUNK_BLOCKS;
  const total = to - from + 1n;
  const chunkBlocks = Math.max(MIN_CHUNK_BLOCKS, Math.min(requested, Number(total)));
  // Pre-slice the window into bounded chunks. A chunk that the provider rejects
  // (range limit / transport) is halved down to MIN_CHUNK_BLOCKS before failing.
  const pending = [];
  for (let cursor = from; cursor <= to;) {
    let end = cursor + BigInt(chunkBlocks) - 1n;
    if (end > to) end = to;
    pending.push({ from: cursor, to: end });
    cursor = end + 1n;
  }
  const transfers = [];
  let chunks = 0;
  let malformed = 0;
  while (pending.length !== 0) {
    const range = pending.pop();
    chunks += 1;
    const span = range.to - range.from + 1n;
    const result = await rpc.tryCall("eth_getLogs", [{
      address: entry.token,
      topics: [TRANSFER_TOPIC],
      fromBlock: `0x${range.from.toString(16)}`,
      toBlock: `0x${range.to.toString(16)}`
    }]);
    if (Array.isArray(result)) {
      for (const log of result) {
        let transfer;
        try { transfer = decodeTransfer(log, entry.token); } catch (_) { transfer = null; }
        if (transfer === null) { malformed += 1; continue; }
        if (transfers.length >= MAX_LOGS_PER_TARGET) fail("LOG_CAP");
        transfers.push(transfer);
      }
    } else if (span > BigInt(MIN_CHUNK_BLOCKS)) {
      const mid = range.from + (span - 1n) / 2n;
      pending.push({ from: mid + 1n, to: range.to });
      pending.push({ from: range.from, to: mid });
    } else {
      fail("RPC_READ_FAILED");
    }
  }
  return { transfers, chunks, malformed, chunkBlocks };
}

// --- clustering ---------------------------------------------------------------------------
function compareBigDesc(a, b, key) { return a[key] > b[key] ? -1 : a[key] < b[key] ? 1 : 0; }
function flowRow(entry) {
  return {
    address: entry.address,
    inflow: entry.inflow.toString(),
    outflow: entry.outflow.toString(),
    net: (entry.inflow - entry.outflow).toString(),
    grossFlow: (entry.inflow + entry.outflow).toString(),
    txCount: entry.txCount
  };
}
function clusterTransfers(transfers, options) {
  const minTx = positiveInt(options.minTx, 1_000_000) ? options.minTx : MIN_TX_DEFAULT;
  const accounts = new Map();
  const pairs = new Map();
  const account = (addr) => {
    let record = accounts.get(addr);
    if (record === undefined) {
      if (accounts.size >= MAX_ADDRESSES) fail("ADDRESS_CAP");
      record = { address: addr, inflow: 0n, outflow: 0n, txCount: 0 };
      accounts.set(addr, record);
    }
    return record;
  };
  const pair = (key, from, to) => {
    let record = pairs.get(key);
    if (record === undefined) {
      record = { from, to, amount: 0n, txCount: 0 };
      pairs.set(key, record);
    }
    return record;
  };
  for (const transfer of transfers) {
    const sender = account(transfer.from);
    sender.outflow += transfer.amount;
    sender.txCount += 1;
    const recipient = account(transfer.to);
    recipient.inflow += transfer.amount;
    if (transfer.to !== transfer.from) recipient.txCount += 1;
    const entry = pair(`${transfer.from}|${transfer.to}`, transfer.from, transfer.to);
    entry.amount += transfer.amount;
    entry.txCount += 1;
  }
  const byInflow = [...accounts.values()].sort((a, b) => compareBigDesc(a, b, "inflow") || compareBigDesc(a, b, "grossFlow") || (a.address < b.address ? -1 : 1));
  const byOutflow = [...accounts.values()].sort((a, b) => compareBigDesc(a, b, "outflow") || compareBigDesc(a, b, "grossFlow") || (a.address < b.address ? -1 : 1));
  const repeatNetPositive = [...accounts.values()]
    .filter((record) => record.txCount >= minTx && record.inflow > record.outflow)
    .sort((a, b) => {
      const netA = a.inflow - a.outflow;
      const netB = b.inflow - b.outflow;
      if (netA !== netB) return netA > netB ? -1 : 1;
      const grossA = a.inflow + a.outflow;
      const grossB = b.inflow + b.outflow;
      if (grossA !== grossB) return grossA > grossB ? -1 : 1;
      return a.address < b.address ? -1 : 1;
    })
    .slice(0, TOP_ROWS)
    .map((record) => ({ address: record.address, net: (record.inflow - record.outflow).toString(), grossFlow: (record.inflow + record.outflow).toString(), txCount: record.txCount }));
  const topPairs = [...pairs.values()]
    .sort((a, b) => compareBigDesc(a, b, "amount") || b.txCount - a.txCount || (a.from < b.from ? -1 : 1))
    .slice(0, TOP_ROWS)
    .map((record) => ({ from: record.from, to: record.to, amount: record.amount.toString(), txCount: record.txCount }));
  return {
    topInflow: byInflow.slice(0, TOP_ROWS).map(flowRow),
    topOutflow: byOutflow.slice(0, TOP_ROWS).map(flowRow),
    repeatNetPositive,
    topPairs
  };
}

async function clusterEntry(entry, rpc, block, options) {
  const blocks = Math.min(entry.windowBlocks, MAX_WINDOW_BLOCKS);
  const to = BigInt(block.number);
  const rawFrom = to - BigInt(blocks) + 1n;
  const from = rawFrom < 0n ? 0n : rawFrom;
  const collected = await collectTransfers(rpc, entry, from, to, options);
  const clusters = clusterTransfers(collected.transfers, options);
  return {
    id: entry.id,
    token: entry.token.toLowerCase(),
    decimals: entry.decimals,
    label: entry.label,
    window: {
      fromBlock: from.toString(),
      toBlock: to.toString(),
      blocks,
      chunkBlocks: collected.chunkBlocks,
      chunks: collected.chunks,
      logCount: collected.transfers.length,
      malformed: collected.malformed
    },
    topInflow: clusters.topInflow,
    topOutflow: clusters.topOutflow,
    repeatNetPositive: clusters.repeatNetPositive,
    topPairs: clusters.topPairs
  };
}

// --- run ----------------------------------------------------------------------------------
function withTimeout(promiseFactory, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new WorkError(code || "ENTRY_TIMEOUT")), ms); });
  return Promise.race([Promise.resolve().then(promiseFactory), timeout]).finally(() => clearTimeout(timer));
}
function sanitizeErrorClass(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  return ERROR_CLASS[code] || "ENTRY_FAILED";
}
function safetyRow() {
  return Object.freeze({
    localOnly: true, readOnly: true, automaticRetries: 0,
    transactionsInitiated: 0, signing: false, broadcast: false
  });
}

async function runOnce(options = {}) {
  const now = options.now || Date.now;
  const config = options.config || loadConfig(options);
  if (!validateConfig(config)) fail("SCHEMA");
  const ledger = createLedger(options);
  const rpcCache = new Map();
  const rpcFor = (chainId) => {
    if (!rpcCache.has(chainId)) rpcCache.set(chainId, createChainRpc(chainId, options, ledger));
    return rpcCache.get(chainId);
  };
  const entryTimeoutMs = positiveInt(options.entryTimeoutMs, 600_000) ? options.entryTimeoutMs : ENTRY_TIMEOUT_MS;
  const totalTimeoutMs = positiveInt(options.totalTimeoutMs, 3_600_000) ? options.totalTimeoutMs : TOTAL_TIMEOUT_MS;
  const deadline = now() + totalTimeoutMs;

  const groups = new Map();
  for (const entry of config.targets) {
    if (!groups.has(entry.chainId)) groups.set(entry.chainId, []);
    groups.get(entry.chainId).push(entry);
  }
  const chainIds = [...groups.keys()].sort((a, b) => a - b);
  const chains = [];
  const failures = [];
  let evaluated = 0;
  let logCount = 0;
  let repeatNetPositive = 0;

  for (const chainId of chainIds) {
    const entries = groups.get(chainId);
    let block;
    try {
      block = await withTimeout(() => pinBlock(rpcFor(chainId), options), entryTimeoutMs, "ENTRY_TIMEOUT");
    } catch (error) {
      const errorClass = sanitizeErrorClass(error);
      for (const entry of entries) failures.push({ id: entry.id, chainId, errorClass });
      continue;
    }
    const tokens = [];
    for (const entry of entries) {
      try {
        if (now() > deadline) fail("SCANNER_TIMEOUT");
        const row = await withTimeout(() => clusterEntry(entry, rpcFor(chainId), block, options), entryTimeoutMs, "ENTRY_TIMEOUT");
        tokens.push(redact(row));
        evaluated += 1;
        logCount += row.window.logCount;
        repeatNetPositive += row.repeatNetPositive.length;
      } catch (error) {
        failures.push({ id: entry.id, chainId, errorClass: sanitizeErrorClass(error) });
      }
    }
    chains.push({ chainId, blockNumber: block.number, blockTag: block.tag, tokens });
  }

  const artifact = {
    schema: SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    chains,
    failures,
    stats: { targets: config.targets.length, evaluated, failed: failures.length, logCount, repeatNetPositive },
    safety: safetyRow()
  };
  const redacted = redact(artifact);
  if (!validateArtifact(redacted)) fail("SCHEMA");
  return redacted;
}

// --- artifact validation ------------------------------------------------------------------
function validateFlowRow(row) {
  if (!exactKeys(row, ["address", "inflow", "outflow", "net", "grossFlow", "txCount"])) return false;
  if (!addressLower(row.address) || !unsigned(row.inflow) || !unsigned(row.outflow)) return false;
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(row.net) || !unsigned(row.grossFlow)) return false;
  return nonNegInt(row.txCount);
}
function validateRepeatRow(row) {
  if (!exactKeys(row, ["address", "net", "grossFlow", "txCount"])) return false;
  if (!addressLower(row.address) || !unsigned(row.net) || !unsigned(row.grossFlow)) return false;
  return nonNegInt(row.txCount);
}
function validatePairRow(row) {
  if (!exactKeys(row, ["from", "to", "amount", "txCount"])) return false;
  if (!addressLower(row.from) || !addressLower(row.to) || !unsigned(row.amount)) return false;
  return nonNegInt(row.txCount);
}
function validateWindow(window) {
  if (!exactKeys(window, ["fromBlock", "toBlock", "blocks", "chunkBlocks", "chunks", "logCount", "malformed"])) return false;
  if (!unsigned(window.fromBlock) || !unsigned(window.toBlock)) return false;
  if (!positiveInt(window.blocks, MAX_WINDOW_BLOCKS)) return false;
  if (!positiveInt(window.chunkBlocks, MAX_WINDOW_BLOCKS)) return false;
  return [window.chunks, window.logCount, window.malformed].every(nonNegInt);
}
function validateArtifact(value) {
  try {
    if (!exactKeys(value, ["schema", "generatedAt", "chains", "failures", "stats", "safety"])) return false;
    if (value.schema !== SCHEMA || !iso(value.generatedAt)) return false;
    if (!Array.isArray(value.chains) || !Array.isArray(value.failures)) return false;
    const seen = new Set();
    for (const chain of value.chains) {
      if (!exactKeys(chain, ["chainId", "blockNumber", "blockTag", "tokens"])) return false;
      if (!positiveInt(chain.chainId, 1_000_000_000)) return false;
      if (!unsigned(chain.blockNumber) || typeof chain.blockTag !== "string" || !BLOCK_TAG_RE.test(chain.blockTag)) return false;
      if (!Array.isArray(chain.tokens)) return false;
      for (const token of chain.tokens) {
        if (!exactKeys(token, ["id", "token", "decimals", "label", "window", "topInflow", "topOutflow", "repeatNetPositive", "topPairs"])) return false;
        if (typeof token.id !== "string" || seen.has(token.id)) return false;
        seen.add(token.id);
        if (!addressLower(token.token)) return false;
        if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 77) return false;
        if (typeof token.label !== "string" || token.label.length === 0 || token.label.length > 200) return false;
        if (!validateWindow(token.window)) return false;
        if (!Array.isArray(token.topInflow) || !token.topInflow.every(validateFlowRow)) return false;
        if (!Array.isArray(token.topOutflow) || !token.topOutflow.every(validateFlowRow)) return false;
        if (!Array.isArray(token.repeatNetPositive) || !token.repeatNetPositive.every(validateRepeatRow)) return false;
        if (!Array.isArray(token.topPairs) || !token.topPairs.every(validatePairRow)) return false;
      }
    }
    for (const failure of value.failures) {
      if (!exactKeys(failure, ["id", "chainId", "errorClass"])) return false;
      if (typeof failure.id !== "string" || !positiveInt(failure.chainId, 1_000_000_000)) return false;
      if (!/^[A-Z0-9_]{1,64}$/.test(failure.errorClass)) return false;
    }
    const stats = value.stats;
    if (!exactKeys(stats, ["targets", "evaluated", "failed", "logCount", "repeatNetPositive"])) return false;
    if (![stats.targets, stats.evaluated, stats.failed, stats.logCount, stats.repeatNetPositive].every(nonNegInt)) return false;
    const safety = value.safety;
    if (!exactKeys(safety, ["localOnly", "readOnly", "automaticRetries", "transactionsInitiated", "signing", "broadcast"])) return false;
    if (safety.localOnly !== true || safety.readOnly !== true || safety.automaticRetries !== 0
      || safety.transactionsInitiated !== 0 || safety.signing !== false || safety.broadcast !== false) return false;
    return !LEAK_PATTERN.test(JSON.stringify(value));
  } catch (_) { return false; }
}

// --- publish ------------------------------------------------------------------------------
function fsyncDirectory(directory, fsImpl) {
  const descriptor = fsImpl.openSync(directory, "r");
  try { try { fsImpl.fsyncSync(descriptor); } catch (error) { if (!["EINVAL", "EPERM", "EBADF"].includes(error.code)) throw error; } }
  finally { fsImpl.closeSync(descriptor); }
}
function publishAtomic(artifact, options = {}) {
  if (!validateArtifact(artifact)) fail("SCHEMA");
  const fsImpl = options.fsImpl || fs;
  const target = path.resolve(options.outputPath || OUTPUT);
  const allowedRoot = path.resolve(options.allowedRoot || path.dirname(OUTPUT));
  if (path.dirname(target) !== allowedRoot || path.basename(target) !== "value-flow-cluster.json") fail("SCHEMA");
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const temporary = path.join(allowedRoot, `.value-flow-cluster.json.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, bytes);
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporary, target);
    fsyncDirectory(allowedRoot, fsImpl);
    const readback = fsImpl.readFileSync(target);
    if (!readback.equals(bytes) || !validateArtifact(JSON.parse(readback.toString("utf8")))) fail("SCHEMA");
    return target;
  } finally {
    if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch (_) {}
    if (fsImpl.existsSync(temporary)) try { fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}
async function runAndPublish(options = {}) {
  const artifact = await runOnce(options);
  publishAtomic(artifact, options);
  return artifact;
}

// --- CLI ----------------------------------------------------------------------------------
function parseCli(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const unknown = args.filter((value) => value !== "--run-once");
  if (unknown.length !== 0) return { action: "usage", reason: "unknown-argument" };
  if (!args.includes("--run-once")) return { action: "usage", reason: "run-once-required" };
  return { action: "run", reason: "run-once" };
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const parsed = parseCli(argv);
  if (parsed.action !== "run") {
    stdout.write(USAGE);
    process.exitCode = 1;
    return { status: "USAGE", reason: parsed.reason };
  }
  const run = deps.runAndPublish || runAndPublish;
  const artifact = await run({ running: false });
  stdout.write(`${JSON.stringify({
    status: "OK",
    artifact: path.relative(WORKSPACE, OUTPUT).split(path.sep).join("/"),
    targets: artifact.stats.targets,
    evaluated: artifact.stats.evaluated,
    repeatNetPositive: artifact.stats.repeatNetPositive,
    failed: artifact.stats.failed
  })}\n`);
  return { status: "OK", artifact };
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({
  CLAIM, SCHEMA, CONFIG_SCHEMA, CONFIG_PATH, OUTPUT, USAGE,
  MAX_NETWORK_CALLS, MAX_TARGETS, MAX_WINDOW_BLOCKS, DEFAULT_CHUNK_BLOCKS, MIN_CHUNK_BLOCKS,
  MAX_LOGS_PER_TARGET, MAX_ADDRESSES, MIN_TX_DEFAULT, TOP_ROWS,
  RPC_TIMEOUT_MS, ENTRY_TIMEOUT_MS, TOTAL_TIMEOUT_MS, TRANSFER_TOPIC, ERROR_CLASS,
  WorkError, redact, validateConfig, validateTarget, validateArtifact, loadConfig,
  createLedger, createChainRpc, pinBlock, hexQuantity, topicAddress, decodeAmount, decodeTransfer,
  collectTransfers, clusterTransfers, clusterEntry, withTimeout, sanitizeErrorClass,
  runOnce, publishAtomic, runAndPublish, parseCli, main
});
