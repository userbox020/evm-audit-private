#!/usr/bin/env node
"use strict";

// Bounded, config-driven, read-only live-state profit-condition scanner.
// Observes on-chain state at one pinned finalized/latest block per chain and
// flags exploitable/mispriced conditions. Emits exactly one sanitized artifact.
// RPC endpoint material, endpoint identities, and raw responses remain
// process-only. No signing, no transactions, no broadcast. Fail closed per entry.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const shared = require("./shared-rpc");
const { AbiCoder } = require("ethers");

const CLAIM = "monitor/profit-condition-scanner";
const SCHEMA = "profit-condition-scan/v1";
const CONFIG_SCHEMA = "profit-scan-targets/v1";
const WORKSPACE = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(__dirname, "profit-scan-targets.json");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "profit-condition-scan.json");

const MAX_NETWORK_CALLS = 128;
const MAX_TARGETS = 64;
const RPC_TIMEOUT_MS = 9000;
const ENTRY_TIMEOUT_MS = 12000;
const TOTAL_TIMEOUT_MS = 60000;
const USAGE = "profit-condition-scanner: bounded read-only live-state scanner; pass --run-once to execute.\n";

const FEED_SELECTOR = "0xfeaf968c";
const TOTAL_ASSETS_SELECTOR = "0x01e1d114";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

const TYPES = Object.freeze(["stale-feed-capacity", "oracle-divergence", "share-price-divergence"]);
const ENCODERS = Object.freeze(["uint", "signed", "feed"]);
const SHARE_MODES = Object.freeze(["divergence", "shortfall"]);
const BLOCK_TAG_RE = /^(?:finalized|safe|latest|0x[0-9a-f]+)$/;
const FEED_TYPES = Object.freeze(["uint80", "int256", "uint256", "uint256", "uint80"]);

const STATUS = Object.freeze({
  STALE_FEED_WITH_CAPACITY: "STALE_FEED_WITH_CAPACITY",
  FEED_ANSWER_INVALID: "FEED_ANSWER_INVALID",
  FEED_STALE_NO_CAPACITY: "FEED_STALE_NO_CAPACITY",
  FEED_OK: "FEED_OK",
  ORACLE_DIVERGENCE: "ORACLE_DIVERGENCE",
  ORACLE_ALIGNED: "ORACLE_ALIGNED",
  SHARE_PRICE_DIVERGENCE: "SHARE_PRICE_DIVERGENCE",
  SHARE_PRICE_ALIGNED: "SHARE_PRICE_ALIGNED",
  FAILED: "FAILED",
  TIMEOUT: "TIMEOUT"
});

const ALL_STATUSES = Object.freeze(Object.values(STATUS));
const FLAGGED_STATUSES = Object.freeze([
  STATUS.FEED_ANSWER_INVALID, STATUS.STALE_FEED_WITH_CAPACITY,
  STATUS.ORACLE_DIVERGENCE, STATUS.SHARE_PRICE_DIVERGENCE
]);
// Higher is more severe. Ranking order: invalid feed > stale+capacity > divergence.
const SEVERITY = Object.freeze({
  FEED_ANSWER_INVALID: 100,
  STALE_FEED_WITH_CAPACITY: 80,
  ORACLE_DIVERGENCE: 70,
  SHARE_PRICE_DIVERGENCE: 60,
  FEED_STALE_NO_CAPACITY: 30,
  FEED_OK: 10,
  ORACLE_ALIGNED: 10,
  SHARE_PRICE_ALIGNED: 10,
  TIMEOUT: 5,
  FAILED: 5
});

const ERROR_CLASS = Object.freeze({
  ENDPOINT_UNAVAILABLE: "ENDPOINT_UNAVAILABLE",
  RPC_READ_FAILED: "RPC_READ_FAILED",
  RPC_CALL_CAP: "RPC_CALL_CAP",
  ABI_DECODE_FAILED: "ABI_DECODE_FAILED",
  SELECTOR_INVALID: "SELECTOR_INVALID",
  BLOCK_PIN_FAILED: "BLOCK_PIN_FAILED",
  ZERO_REFERENCE: "ZERO_REFERENCE",
  ZERO_SUPPLY: "ZERO_SUPPLY",
  ENTRY_TIMEOUT: "ENTRY_TIMEOUT",
  SCANNER_TIMEOUT: "SCANNER_TIMEOUT",
  SCHEMA: "SCHEMA_INVALID"
});

const URL_RE = /(?:https?|wss?):\/\/[^\s"'<>[\]()]*/gi;
const SENSITIVE_KEY_RE = /(?:url|uri|endpoint|rpc|provider|authorization|auth|token|secret|apikey|api[_-]?key|header|bearer|password|credential)/i;
const LEAK_PATTERN = /(?:https?|wss?):\/\/|authorization\s*:|bearer\s|api[_-]?key|private[_-]?key|mnemonic|rpc_endpoints|\.env\b|secret|infura|alchemy|nodereal|publicnode|drpc\.org/i;

const CODER = AbiCoder.defaultAbiCoder();

class WorkError extends Error {
  constructor(code) { super(code); this.name = "WorkError"; this.code = code; }
}
function fail(code) { throw new WorkError(code); }
function lower(value) { return String(value).toLowerCase(); }
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function iso(value) {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch (_) { return false; }
}
function unsigned(value) { return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value); }
function signed(value) { return typeof value === "string" && /^(?:0|-?[1-9][0-9]*)$/.test(value); }
function address(value) { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value); }
function selector(value) { return typeof value === "string" && /^0x[0-9a-fA-F]{8}$/.test(value); }
function argWord(value) { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value); }
function addressHex(value) {
  const raw = lower(value);
  return /^0x[0-9a-f]{40}$/.test(raw) ? raw : fail("SELECTOR_INVALID");
}
function argWordsHex(words) {
  if (words === undefined) return [];
  if (!Array.isArray(words) || !words.every(argWord)) fail("SELECTOR_INVALID");
  return words.map(lower);
}
function callData(to, sel, argWords) {
  const target = addressHex(to);
  const selectorHex = lower(sel);
  if (!selector(selectorHex)) fail("SELECTOR_INVALID");
  return { to: target, data: selectorHex + argWordsHex(argWords).map((word) => word.slice(2)).join("") };
}
function strictHex(raw) {
  if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw)) fail("ABI_DECODE_FAILED");
  return lower(raw);
}
function decodeUint(raw) {
  try { return BigInt(CODER.decode(["uint256"], strictHex(raw))[0]); } catch (error) { fail("ABI_DECODE_FAILED"); }
}
function decodeInt(raw) {
  try { return BigInt(CODER.decode(["int256"], strictHex(raw))[0]); } catch (error) { fail("ABI_DECODE_FAILED"); }
}
function decodeFeed(raw) {
  let decoded;
  try { decoded = CODER.decode(FEED_TYPES, strictHex(raw)); } catch (error) { fail("ABI_DECODE_FAILED"); }
  return {
    roundId: decoded[0].toString(), answer: BigInt(decoded[1]), startedAt: decoded[2].toString(),
    updatedAt: decoded[3].toString(), answeredInRound: decoded[4].toString()
  };
}
function hexQuantity(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) fail("BLOCK_PIN_FAILED");
  return BigInt(value).toString();
}
function sanitizeErrorClass(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  return ERROR_CLASS[code] || "ENTRY_FAILED";
}

// --- deep redaction -----------------------------------------------------------------------
function redact(value) {
  if (typeof value === "string") return value.replace(URL_RE, "[redacted-url]");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (isPlainObject(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : redact(item);
    }
    return output;
  }
  return value;
}

// --- config validation --------------------------------------------------------------------
function positiveInt(value, max) {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}
function validateSource(value) {
  if (!exactKeys(value, ["target", "selector", "encoder", "decimals", "argWords"])
    && !exactKeys(value, ["target", "selector", "encoder", "decimals"])) return false;
  if (!address(value.target) || !selector(value.selector)) return false;
  if (!ENCODERS.includes(value.encoder)) return false;
  if (!Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 77) return false;
  if (value.argWords !== undefined && (!Array.isArray(value.argWords) || !value.argWords.every(argWord))) return false;
  return true;
}
function validateTarget(entry) {
  const keys = Object.keys(entry || {});
  const required = ["id", "chainId", "type", "reads", "thresholds", "label"];
  const optional = ["source", "notes"];
  if (!required.every((key) => keys.includes(key)) || keys.some((key) => ![...required, ...optional].includes(key))) return false;
  if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(entry.id)) return false;
  if (!positiveInt(entry.chainId, 1_000_000_000)) return false;
  if (!TYPES.includes(entry.type)) return false;
  if (typeof entry.label !== "string" || entry.label.length === 0 || entry.label.length > 200) return false;
  if (entry.source !== undefined && (!Array.isArray(entry.source) || !entry.source.every((item) => typeof item === "string"))) return false;
  if (entry.notes !== undefined && (typeof entry.notes !== "string" || entry.notes.length === 0 || entry.notes.length > 1000)) return false;
  if (!isPlainObject(entry.reads) || !isPlainObject(entry.thresholds)) return false;

  if (entry.type === "stale-feed-capacity") {
    if (!exactKeys(entry.reads, ["feed", "capacity"])) return false;
    if (!address(entry.reads.feed)) return false;
    const cap = entry.reads.capacity;
    if (!exactKeys(cap, ["target", "selector", "argWords"]) && !exactKeys(cap, ["target", "selector"])) return false;
    if (!address(cap.target) || !selector(cap.selector)) return false;
    if (cap.argWords !== undefined && (!Array.isArray(cap.argWords) || !cap.argWords.every(argWord))) return false;
    if (!exactKeys(entry.thresholds, ["staleSeconds"])) return false;
    if (!positiveInt(entry.thresholds.staleSeconds, 1_000_000_000)) return false;
    return true;
  }
  if (entry.type === "oracle-divergence") {
    if (!exactKeys(entry.reads, ["p1", "p2"])) return false;
    if (!validateSource(entry.reads.p1) || !validateSource(entry.reads.p2)) return false;
    if (!exactKeys(entry.thresholds, ["divergenceBps"])) return false;
    return positiveInt(entry.thresholds.divergenceBps, 100_000);
  }
  // share-price-divergence
  const reads = entry.reads;
  const allowed = ["vault", "pricePerShare", "totalAssets", "totalSupply", "reference", "decimals", "mode"];
  if (Object.keys(reads).some((key) => !allowed.includes(key))) return false;
  if (reads.mode !== undefined && !SHARE_MODES.includes(reads.mode)) return false;
  if (!address(reads.vault)) return false;
  if (reads.pricePerShare !== undefined && !validateSource(reads.pricePerShare)) return false;
  if (reads.pricePerShare === undefined) {
    if (reads.totalAssets !== undefined && !exactKeys(reads.totalAssets, ["selector"])) return false;
    if (reads.totalSupply !== undefined && !exactKeys(reads.totalSupply, ["selector"])) return false;
    if (reads.totalAssets !== undefined && !selector(reads.totalAssets.selector)) return false;
    if (reads.totalSupply !== undefined && !selector(reads.totalSupply.selector)) return false;
  }
  if (reads.decimals !== undefined && (!Number.isInteger(reads.decimals) || reads.decimals < 0 || reads.decimals > 77)) return false;
  if (!isPlainObject(reads.reference)) return false;
  const reference = reads.reference;
  if (reference.value !== undefined) {
    if (!exactKeys(reference, ["value", "decimals"])) return false;
    if (!unsigned(reference.value)) return false;
    if (!Number.isInteger(reference.decimals) || reference.decimals < 0 || reference.decimals > 77) return false;
  } else {
    if (!exactKeys(reference, ["target", "selector", "decimals"])
      && !exactKeys(reference, ["target", "selector", "decimals", "argWords"])) return false;
    if (!address(reference.target) || !selector(reference.selector)) return false;
    if (!Number.isInteger(reference.decimals) || reference.decimals < 0 || reference.decimals > 77) return false;
    if (reference.argWords !== undefined && (!Array.isArray(reference.argWords) || !reference.argWords.every(argWord))) return false;
  }
  if (!exactKeys(entry.thresholds, ["divergenceBps"])) return false;
  return positiveInt(entry.thresholds.divergenceBps, 100_000);
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

// --- bounded chain transport (multi-candidate failover, no unbounded retries) --------------
// Mirrors tools/read-contract-state.js: loadRpcUrls + resolveRpc(chainId, remaining) qualify
// independent provider candidates. The current candidate is rotated only when it returns null,
// so a flaky/partial endpoint (e.g. Base that answers `finalized` but not `safe`/`latest`) can
// be replaced by another capable one. Endpoint values are process-only and never persisted; only
// the count of candidates actually used (`families`) is recorded.
function createChainRpc(chainId, options, ledger) {
  const resolveRpc = options.resolveRpc || shared.resolveRpc;
  const rpcCall = options.rpcCall || shared.rpcCall;
  const timeoutMs = positiveInt(options.rpcTimeoutMs, 60_000) ? options.rpcTimeoutMs : RPC_TIMEOUT_MS;
  const maxCandidates = positiveInt(options.maxCandidates, 32) ? options.maxCandidates : 8;
  let remaining = Array.isArray(options.rpcUrls) ? [...options.rpcUrls] : [];
  const families = new Set();
  let active = null;
  let lastCode = "ENDPOINT_UNAVAILABLE";

  function valid(value) { return typeof value === "string" && /^https?:\/\//i.test(value); }
  // Pick a fresh qualified candidate from the remaining pool; when the pool is exhausted (or a
  // single injected resolver is used) fall back to resolveRpc(chainId) so a tag can still be
  // retried against the one candidate. Freshness is per call, so a candidate that failed one tag
  // can still serve another.
  async function selectNext() {
    while (remaining.length !== 0) {
      const candidate = await resolveRpc(chainId, remaining);
      if (!valid(candidate)) break;
      const wasInPool = remaining.includes(candidate);
      if (wasInPool) remaining = remaining.filter((url) => url !== candidate);
      if (!families.has(candidate)) return candidate;
      if (!wasInPool) break;
    }
    if (typeof resolveRpc === "function") {
      const candidate = await resolveRpc(chainId);
      if (valid(candidate)) return candidate;
    }
    return null;
  }
  async function call(method, params, ms) {
    const usedThisCall = new Set();
    for (let attempt = 0; attempt <= maxCandidates; attempt += 1) {
      if (ledger.calls >= ledger.max) fail("RPC_CALL_CAP");
      if (active === null || usedThisCall.has(active)) active = await selectNext();
      if (active === null || usedThisCall.has(active)) fail(lastCode);
      usedThisCall.add(active);
      families.add(active);
      ledger.calls += 1;
      const result = await rpcCall(active, method, params, ms || timeoutMs);
      if (result !== null && result !== undefined) return result;
      lastCode = "RPC_READ_FAILED";
      active = null;
    }
    fail(lastCode);
  }
  return {
    chainId,
    call,
    get families() { return families.size; }
  };
}
function createLedger(options) {
  const max = positiveInt(options.maxNetworkCalls, MAX_NETWORK_CALLS) ? options.maxNetworkCalls : MAX_NETWORK_CALLS;
  return { calls: 0, max };
}

// --- block pinning ------------------------------------------------------------------------
// Prefer `finalized` for the strongest consistency guarantee, then `safe`, then `latest`.
// Tags are not universally supported (some Base/proxy endpoints reject `finalized` or even
// return nothing for tags), so fall back to a numeric block from `eth_blockNumber`. The tag
// or numeric reference actually used is recorded and used for every read on that chain.
async function tryReadBlock(rpc, blockRef) {
  try {
    const raw = await rpc.call("eth_getBlockByNumber", [blockRef, false]);
    if (!isPlainObject(raw)) return null;
    const number = hexQuantity(raw.number);
    const timestamp = hexQuantity(raw.timestamp);
    return { number, timestamp, tag: blockRef, hex: `0x${BigInt(number).toString(16)}` };
  } catch (error) {
    if (error instanceof WorkError && error.code === "ENDPOINT_UNAVAILABLE") fail("ENDPOINT_UNAVAILABLE");
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
    if (error instanceof WorkError && error.code === "ENDPOINT_UNAVAILABLE") fail("ENDPOINT_UNAVAILABLE");
  }
  fail("BLOCK_PIN_FAILED");
}

// --- condition evaluation -----------------------------------------------------------------
async function readSource(rpc, source, blockHex) {
  const raw = await rpc.call("eth_call", [callData(source.target, source.selector, source.argWords), blockHex]);
  if (source.encoder === "feed") return decodeFeed(raw).answer;
  if (source.encoder === "signed") return decodeInt(raw);
  return decodeUint(raw);
}
function absBig(value) { return value < 0n ? -value : value; }
function computeDivergenceBps(v1, d1, v2, d2) {
  const a = absBig(v1) * (10n ** BigInt(d2));
  const b = absBig(v2) * (10n ** BigInt(d1));
  if (b === 0n) fail("ZERO_REFERENCE");
  return ((a > b ? a - b : b - a) * 10000n) / b;
}

async function evaluateStaleFeedCapacity(entry, rpc, block) {
  const cap = entry.reads.capacity;
  const feedRaw = await rpc.call("eth_call", [callData(entry.reads.feed, FEED_SELECTOR), block.hex]);
  const round = decodeFeed(feedRaw);
  const capRaw = await rpc.call("eth_call", [callData(cap.target, cap.selector, cap.argWords), block.hex]);
  const capacity = decodeUint(capRaw);
  const updatedAt = BigInt(round.updatedAt);
  const age = BigInt(block.timestamp) - updatedAt;
  const staleSeconds = BigInt(entry.thresholds.staleSeconds);
  const stale = age > staleSeconds;
  let status;
  if (updatedAt === 0n || round.answer <= 0n) status = STATUS.FEED_ANSWER_INVALID;
  else if (stale && capacity > 0n) status = STATUS.STALE_FEED_WITH_CAPACITY;
  else if (stale) status = STATUS.FEED_STALE_NO_CAPACITY;
  else status = STATUS.FEED_OK;
  return {
    status,
    metrics: {
      blockTimestamp: block.timestamp, updatedAt: round.updatedAt, ageSeconds: age.toString(),
      staleSeconds: String(staleSeconds), answer: round.answer.toString(), capacity: capacity.toString()
    }
  };
}

async function evaluateOracleDivergence(entry, rpc, block) {
  const p1 = await readSource(rpc, entry.reads.p1, block.hex);
  const p2 = await readSource(rpc, entry.reads.p2, block.hex);
  const bps = computeDivergenceBps(p1, entry.reads.p1.decimals, p2, entry.reads.p2.decimals);
  const status = bps > BigInt(entry.thresholds.divergenceBps) ? STATUS.ORACLE_DIVERGENCE : STATUS.ORACLE_ALIGNED;
  return {
    status,
    metrics: {
      p1: p1.toString(), p2: p2.toString(),
      p1Decimals: entry.reads.p1.decimals, p2Decimals: entry.reads.p2.decimals,
      divergenceBps: bps.toString()
    }
  };
}

// `mode`:
//   "divergence" (default) - two-sided: flag |pps - reference| beyond threshold.
//   "shortfall"            - one-sided: flag only when pps is BELOW the reference path.
// Yield-bearing ERC4626 vaults (sDAI/sUSDS/sUSDe-style) accrue value, so a price-per-share
// above parity is expected yield, not a mispricing. Use "shortfall" with a genuine independent
// accrual/rate reference; never flag appreciated yield against a static parity.
async function evaluateSharePrice(entry, rpc, block) {
  const reads = entry.reads;
  const mode = reads.mode === undefined ? "divergence" : reads.mode;
  let pps;
  let ppsDecimals;
  let totalAssets = null;
  let totalSupply = null;
  if (reads.pricePerShare !== undefined) {
    pps = await readSource(rpc, { encoder: "uint", ...reads.pricePerShare }, block.hex);
    ppsDecimals = reads.pricePerShare.decimals;
  } else {
    const totalAssetsSelector = reads.totalAssets && reads.totalAssets.selector ? reads.totalAssets.selector : TOTAL_ASSETS_SELECTOR;
    const totalSupplySelector = reads.totalSupply && reads.totalSupply.selector ? reads.totalSupply.selector : TOTAL_SUPPLY_SELECTOR;
    totalAssets = decodeUint(await rpc.call("eth_call", [callData(reads.vault, totalAssetsSelector), block.hex]));
    totalSupply = decodeUint(await rpc.call("eth_call", [callData(reads.vault, totalSupplySelector), block.hex]));
    if (totalSupply === 0n) fail("ZERO_SUPPLY");
    ppsDecimals = reads.decimals === undefined ? 18 : reads.decimals;
    pps = (totalAssets * (10n ** BigInt(ppsDecimals))) / totalSupply;
  }
  const reference = reads.reference;
  let refValue;
  let refDecimals;
  if (reference.value !== undefined) {
    refValue = BigInt(reference.value);
    refDecimals = reference.decimals;
  } else {
    refValue = decodeUint(await rpc.call("eth_call", [callData(reference.target, reference.selector, reference.argWords), block.hex]));
    refDecimals = reference.decimals;
  }
  const scaled = pps * (10n ** BigInt(refDecimals));
  const refScaled = refValue * (10n ** BigInt(ppsDecimals));
  if (refScaled === 0n) fail("ZERO_REFERENCE");
  const below = scaled < refScaled;
  const magnitude = below ? refScaled - scaled : scaled - refScaled;
  const bps = (magnitude * 10000n) / refScaled;
  let status;
  if (mode === "shortfall") {
    // Upside (pps above the reference path) is accrued yield and never flags.
    status = below && bps > BigInt(entry.thresholds.divergenceBps)
      ? STATUS.SHARE_PRICE_DIVERGENCE : STATUS.SHARE_PRICE_ALIGNED;
  } else {
    status = bps > BigInt(entry.thresholds.divergenceBps) ? STATUS.SHARE_PRICE_DIVERGENCE : STATUS.SHARE_PRICE_ALIGNED;
  }
  const metrics = {
    pricePerShare: pps.toString(), pricePerShareDecimals: ppsDecimals,
    reference: refValue.toString(), referenceDecimals: refDecimals,
    mode, direction: below ? "below" : "above", divergenceBps: bps.toString()
  };
  if (totalAssets !== null) metrics.totalAssets = totalAssets.toString();
  if (totalSupply !== null) metrics.totalSupply = totalSupply.toString();
  return { status, metrics };
}

const EVALUATORS = Object.freeze({
  "stale-feed-capacity": evaluateStaleFeedCapacity,
  "oracle-divergence": evaluateOracleDivergence,
  "share-price-divergence": evaluateSharePrice
});

// --- artifact -----------------------------------------------------------------------------
function withTimeout(promiseFactory, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new WorkError(code || "ENTRY_TIMEOUT")), ms);
  });
  return Promise.race([Promise.resolve().then(promiseFactory), timeout]).finally(() => clearTimeout(timer));
}
function severityOf(status) { return SEVERITY[status] === undefined ? 0 : SEVERITY[status]; }
function rankFlags(flags) {
  return [...flags].sort((a, b) => severityOf(b.status) - severityOf(a.status) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  const loadRpcUrls = options.loadRpcUrls || shared.loadRpcUrls;
  const inventory = Array.isArray(options.rpcUrls) ? options.rpcUrls
    : (typeof loadRpcUrls === "function" ? loadRpcUrls({ maxCandidates: 128 }) : []);
  const transportOptions = { ...options, rpcUrls: inventory };
  const rpcCache = new Map();
  const rpcFor = (chainId) => {
    if (!rpcCache.has(chainId)) rpcCache.set(chainId, createChainRpc(chainId, transportOptions, ledger));
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
  const flags = [];

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
    const chainFlags = [];
    for (const entry of entries) {
      let row;
      try {
        if (now() > deadline) fail("SCANNER_TIMEOUT");
        const result = await withTimeout(() => EVALUATORS[entry.type](entry, rpcFor(chainId), block), entryTimeoutMs, "ENTRY_TIMEOUT");
        row = { id: entry.id, type: entry.type, status: result.status, metrics: result.metrics, label: entry.label };
      } catch (error) {
        const isTimeout = error instanceof WorkError && error.code === "ENTRY_TIMEOUT";
        row = {
          id: entry.id, type: entry.type, status: isTimeout ? STATUS.TIMEOUT : STATUS.FAILED,
          metrics: { errorClass: sanitizeErrorClass(error) }, label: entry.label
        };
        failures.push({ id: entry.id, chainId, errorClass: row.metrics.errorClass });
      }
      chainFlags.push(redact(row));
      flags.push(chainFlags[chainFlags.length - 1]);
    }
    chains.push({
      chainId, blockNumber: block.number, blockTimestamp: block.timestamp, blockTag: block.tag,
      candidateFamilies: rpcFor(chainId).families, flags: rankFlags(chainFlags)
    });
  }

  const byStatus = {};
  for (const flag of flags) byStatus[flag.status] = (byStatus[flag.status] || 0) + 1;
  const artifact = {
    schema: SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    chains,
    failures,
    stats: {
      targets: config.targets.length,
      evaluated: flags.length,
      flagged: flags.filter((flag) => FLAGGED_STATUSES.includes(flag.status)).length,
      failed: failures.length,
      byStatus
    },
    safety: safetyRow()
  };
  const redacted = redact(artifact);
  if (!validateArtifact(redacted)) fail("SCHEMA");
  return redacted;
}

function validateMetrics(metrics) {
  if (!isPlainObject(metrics)) return false;
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof key !== "string" || key.length === 0) return false;
    if (typeof value === "number") { if (!Number.isFinite(value)) return false; continue; }
    if (typeof value === "string") { if (value.length > 256) return false; continue; }
    return false;
  }
  return true;
}
function validateArtifact(value) {
  try {
    if (!exactKeys(value, ["schema", "generatedAt", "chains", "failures", "stats", "safety"])) return false;
    if (value.schema !== SCHEMA || !iso(value.generatedAt)) return false;
    if (!Array.isArray(value.chains) || !Array.isArray(value.failures)) return false;
    const seen = new Set();
    for (const chain of value.chains) {
      if (!exactKeys(chain, ["chainId", "blockNumber", "blockTimestamp", "blockTag", "candidateFamilies", "flags"])) return false;
      if (!positiveInt(chain.chainId, 1_000_000_000)) return false;
      if (!unsigned(chain.blockNumber) || !unsigned(chain.blockTimestamp)) return false;
      if (typeof chain.blockTag !== "string" || !BLOCK_TAG_RE.test(chain.blockTag)) return false;
      if (!Number.isInteger(chain.candidateFamilies) || chain.candidateFamilies < 1 || chain.candidateFamilies > 32) return false;
      if (!Array.isArray(chain.flags)) return false;
      for (const flag of chain.flags) {
        if (!exactKeys(flag, ["id", "type", "status", "metrics", "label"])) return false;
        if (typeof flag.id !== "string" || seen.has(flag.id)) return false;
        seen.add(flag.id);
        if (!TYPES.includes(flag.type) || !ALL_STATUSES.includes(flag.status)) return false;
        if (!validateMetrics(flag.metrics)) return false;
        if (typeof flag.label !== "string" || flag.label.length === 0 || flag.label.length > 200) return false;
        if ((flag.status === STATUS.FAILED || flag.status === STATUS.TIMEOUT)
          && !/^[A-Z0-9_]{1,64}$/.test(flag.metrics.errorClass || "")) return false;
      }
    }
    for (const failure of value.failures) {
      if (!exactKeys(failure, ["id", "chainId", "errorClass"])) return false;
      if (typeof failure.id !== "string" || !positiveInt(failure.chainId, 1_000_000_000)) return false;
      if (!/^[A-Z0-9_]{1,64}$/.test(failure.errorClass)) return false;
    }
    const stats = value.stats;
    if (!exactKeys(stats, ["targets", "evaluated", "flagged", "failed", "byStatus"])) return false;
    if (![stats.targets, stats.evaluated, stats.flagged, stats.failed].every((item) => Number.isInteger(item) && item >= 0)) return false;
    if (!isPlainObject(stats.byStatus)) return false;
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
  if (path.dirname(target) !== allowedRoot || path.basename(target) !== "profit-condition-scan.json") fail("SCHEMA");
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const temporary = path.join(allowedRoot, `.profit-condition-scan.json.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
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
    flagged: artifact.stats.flagged,
    failed: artifact.stats.failed
  })}\n`);
  return { status: "OK", artifact };
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({
  CLAIM, SCHEMA, CONFIG_SCHEMA, CONFIG_PATH, OUTPUT, USAGE,
  MAX_NETWORK_CALLS, MAX_TARGETS, RPC_TIMEOUT_MS, ENTRY_TIMEOUT_MS, TOTAL_TIMEOUT_MS,
  FEED_SELECTOR, TYPES, ENCODERS, STATUS, ALL_STATUSES, FLAGGED_STATUSES, SEVERITY, ERROR_CLASS,
  WorkError, redact, callData, decodeUint, decodeInt, decodeFeed, hexQuantity, sanitizeErrorClass,
  validateConfig, validateTarget, validateArtifact, validateMetrics, loadConfig,
  createChainRpc, createLedger, pinBlock, rankFlags, severityOf, withTimeout,
  evaluateStaleFeedCapacity, evaluateOracleDivergence, evaluateSharePrice,
  runOnce, publishAtomic, runAndPublish, parseCli, main
});
