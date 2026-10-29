#!/usr/bin/env node
"use strict";

// watch-wallet-transactions.js — read-only per-wallet transaction-history
// collector for the local dashboard.
//
// Standard JSON-RPC has no "transactions by address" index, so this collector
// reads the account nonce and locates each recent outbound transaction by
// binary-searching the account's historical nonce transitions with
// `eth_getTransactionCount`, then loads the resulting block and receipt. Rows
// are bounded (<= 50, newest first). ERC20 `Transfer` logs are decoded with a
// small static token registry; unknown tokens fall back to on-chain
// `symbol()`/`decimals()` reads and are marked unresolved (fail-closed) when
// those reads fail. Nothing is signed or broadcast; endpoint values, URLs,
// domains and credentials are never printed, persisted, or placed in the
// artifact.
//
// Usage:
//   node tools/watch-wallet-transactions.js --once     (default) collect + write
//   node tools/watch-wallet-transactions.js --check    dry-run: validate only, no RPC, no write
//
// Read-only. Endpoints process-only.

const fs = require("node:fs");
const path = require("node:path");
const { loadRpcUrls, rpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_PATH = path.join(
  WORKSPACE,
  "reports",
  "raw",
  "fast",
  "exploit-rearm-canary",
  "wallet-transactions.json"
);
const OUT_REL = "reports/raw/fast/exploit-rearm-canary/wallet-transactions.json";

const SCHEMA = "exploit-rearm-canary-wallet-tx/v1";
const WALLET_DEFAULT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const DECIMAL_RE = /^[0-9]{1,78}$/u;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN_SELECTOR = Object.freeze({
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
});

const MAX_ROWS = 50;
const MAX_AMOUNTS = 16;
const MAX_ERRORS = 100;
const NATIVE_DECIMALS = 18;
const CHAIN_TIMEOUT_MS = 9000;
const BLOCK_TIMEOUT_MS = 15000;
const ENDPOINT_CANDIDATES = 40;
const MAX_ENDPOINTS_PER_CHAIN = 3;
const QUALIFICATION_CONCURRENCY = 4;
const RESOLUTION_DEADLINE_MS = 90000;
const RUN_DEADLINE_MS = 240000;

// Tracked chains. Ethereum and Base carry the known batch transactions; the
// remaining watch-address chains are enumerated too only when an endpoint is
// resolvable.
const CHAINS = Object.freeze([1, 8453]);
const CHAIN_NAMES = Object.freeze({
  1: "ethereum",
  8453: "base",
  42161: "arbitrum",
  999: "hyperevm",
  4663: "robinhood",
});
const CHAIN_NATIVE = Object.freeze({
  1: "ETH",
  8453: "ETH",
  42161: "ETH",
  999: "HYPE",
  4663: "ETH",
});
const CHAIN_EXPLORER = Object.freeze({
  1: "https://etherscan.io/tx/",
  8453: "https://basescan.org/tx/",
  42161: "https://arbiscan.io/tx/",
});

// Static token registry (address -> symbol/decimals). Every entry was confirmed
// on-chain before being recorded; unknown tokens are resolved on-chain instead.
const TOKEN_REGISTRY = Object.freeze({
  1: Object.freeze({
    "0x45804880de22913dafe09f4980848ece6ecbaf78": Object.freeze({ symbol: "PAXG", decimals: 18 }),
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": Object.freeze({ symbol: "USDC", decimals: 6 }),
    "0xdac17f958d2ee523a2206206994597c13d831ec7": Object.freeze({ symbol: "USDT", decimals: 6 }),
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": Object.freeze({ symbol: "WETH", decimals: 18 }),
  }),
  8453: Object.freeze({
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": Object.freeze({ symbol: "USDC", decimals: 6 }),
    "0x4200000000000000000000000000000000000006": Object.freeze({ symbol: "WETH", decimals: 18 }),
    "0x3c0f801d5dd237c9c3e183b2de7a7e18aa6bea18": Object.freeze({ symbol: "bwUSDC", decimals: 18 }),
  }),
});

// Human descriptions for the known batch transactions, keyed by exact hash.
const KNOWN_TX_LABELS = Object.freeze({
  "0x08a7e1fb056e7804c5179c213ce7ffb0ab80866c05b2935dd969486bcc49faec":
    "PAXG strike pre-position: swap ETH\u2192PAXG (batch exploit-rearm-canary-amendment-20260924)",
  "0xf3a45d2ec84e7661c41ee690dfe841ab184f5dd906fa2b24a483cb633c030219":
    "PAXG collateral approval \u2192 Morpho Blue",
  "0x0e2edd9ae01a2890d1a7a3cb8d8059bc4360257ac1482944924c314bd741fbab":
    "bwUSDC strike attempt: dust swap ETH\u2192USDC (deposit gate closed \u2014 blocked, no debt)",
});

// Small method-selector map for classifying unknown calldata.
const METHOD_NAMES = Object.freeze({
  "0x095ea7b3": "approve",
  "0xa9059cbb": "transfer",
  "0x23b872dd": "transferFrom",
  "0x38ed1739": "swapExactTokensForTokens",
  "0x8803dbee": "swapTokensForExactTokens",
  "0x7ff36ab5": "swapExactETHForTokens",
  "0xfb3bdb41": "swapETHForExactTokens",
  "0x18cbafe5": "swapExactTokensForETH",
  "0x4a25d94a": "swapTokensForExactETH",
  "0x6a761202": "execTransaction",
  "0x6e553f65": "deposit",
  "0xb6b55f25": "deposit",
  "0x2e1a7d4d": "withdraw",
  "0x56ca623e": "withdraw",
  "0xa22cb465": "setApprovalForAll",
});

class WatchError extends Error {
  constructor(code) {
    super(code);
    this.name = "WatchError";
    this.code = code;
  }
}

function relPosix(target) {
  return path.relative(WORKSPACE, target).split(path.sep).join("/");
}

function chainName(chainId) {
  return CHAIN_NAMES[chainId] || `chain-${chainId}`;
}

function nativeSymbol(chainId) {
  return CHAIN_NATIVE[chainId] || "NATIVE";
}

function hexBlock(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function normalizeAddress(value) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value.trim())) return null;
  return value.trim().toLowerCase();
}

function hexToDecimal(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) return null;
  return BigInt(value).toString();
}

function decimalOrNull(value) {
  const text = hexToDecimal(value);
  if (text !== null) return text;
  if (typeof value === "string" && DECIMAL_RE.test(value)) return value;
  return null;
}

function numberOrNull(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) return null;
  const parsed = Number(BigInt(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function timestampIso(value) {
  const parsed = numberOrNull(value);
  if (parsed === null || parsed <= 0) return null;
  try {
    return new Date(parsed * 1000).toISOString();
  } catch (_) {
    return null;
  }
}

// Generic token amount formatting at the token's own decimals (display capped).
function formatUnits(raw, decimals) {
  const places = Number(decimals);
  if (!Number.isSafeInteger(places) || places < 0 || places > 36) return null;
  if (typeof raw !== "string" || !DECIMAL_RE.test(raw)) return null;
  const base = 10n ** BigInt(places);
  const value = BigInt(raw);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString();
  let text = fraction.toString().padStart(places, "0");
  if (text.length > 8) text = text.slice(0, 8);
  text = text.replace(/0+$/u, "");
  return text.length ? `${whole}.${text}` : whole.toString();
}

// Never let endpoint material or raw provider text reach the artifact.
function sanitizeMessage(value, fallback = "READ_FAILED") {
  const text = String(value ?? "")
    .replace(/\b(?:https?|wss?):\/\/\S+/giu, "[endpoint]")
    .replace(/\b(?:authorization|bearer|api[_-]?key|token|password|secret)\b[:=]?\s*\S*/giu, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim();
  if (!text || /(?:https?|wss?):\/\//iu.test(text)) return fallback;
  return text.slice(0, 120);
}

// Tolerant `symbol()` decode: dynamic string or bytes32, ASCII only.
function asciiFromHex(hex) {
  const bytes = String(hex).match(/.{1,2}/gu) || [];
  let out = "";
  for (const byte of bytes) {
    const code = Number.parseInt(byte, 16);
    if (code === 0) break;
    if (code < 32 || code > 126) return null;
    out += String.fromCharCode(code);
  }
  return out || null;
}

function decodeSymbol(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-f]*$/iu.test(hex) || hex.length < 66) return null;
  const body = hex.slice(2);
  if (body.length >= 128) {
    const offset = Number(BigInt(`0x${body.slice(0, 64)}`));
    if (Number.isSafeInteger(offset) && offset >= 32 && (offset + 32) * 2 <= body.length) {
      const length = Number(BigInt(`0x${body.slice(offset * 2, offset * 2 + 64)}`));
      if (Number.isSafeInteger(length) && length > 0 && length <= 64) {
        return asciiFromHex(body.slice(offset * 2 + 64, offset * 2 + 64 + length * 2));
      }
    }
  }
  return asciiFromHex(body.slice(0, 64));
}

function decodeDecimals(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-f]+$/iu.test(hex) || hex.length < 66) return null;
  const value = Number(BigInt(`0x${hex.slice(2, 66)}`));
  return Number.isSafeInteger(value) && value >= 0 && value <= 36 ? value : null;
}

// --- endpoint resolution -----------------------------------------------------------------
// Qualify a bounded pool per chain. The nonce search can reach genesis, so a
// recent-state probe alone cannot establish the required historical capability.
// Samples at genesis and halfway to head reject recent-only nodes; individual
// reads still need fallback because samples cannot prove the entire range.
async function probeEndpoint(call, url, chainIds, wallet) {
  let raw;
  try {
    raw = await call(url, "eth_chainId", [], CHAIN_TIMEOUT_MS);
  } catch (_) {
    return null;
  }
  const chainId = numberOrNull(raw);
  if (!chainIds.includes(chainId)) return null;
  let head;
  try {
    head = await call(url, "eth_blockNumber", [], CHAIN_TIMEOUT_MS);
  } catch (_) {
    return null;
  }
  const headBlock = numberOrNull(head);
  if (headBlock === null) return null;
  let previous = -1;
  for (const block of new Set([0, Math.floor(headBlock / 2), headBlock])) {
    const nonce = await nonceAt(call, url, wallet, block);
    if (nonce === null || nonce < previous) return null;
    previous = nonce;
  }
  return chainId;
}

async function readBeforeDeadline(call, url, method, params, timeoutMs, now, deadline) {
  const remaining = deadline - now();
  if (remaining <= 0) return null;
  try {
    return await call(url, method, params, Math.min(timeoutMs, remaining));
  } catch (_) {
    return null;
  }
}

async function resolveEndpoints(chainIds, wallet, options = {}) {
  const call = options.call || rpcCall;
  const now = options.now || Date.now;
  const deadline = now() + (options.deadlineMs || RESOLUTION_DEADLINE_MS);
  let urls = [];
  if (Array.isArray(options.urls)) urls = options.urls;
  else {
    try {
      urls = loadRpcUrls({ maxCandidates: options.maxCandidates || ENDPOINT_CANDIDATES });
    } catch (_) {
      urls = [];
    }
  }
  const maxCandidates = Math.min(options.maxCandidates || ENDPOINT_CANDIDATES, ENDPOINT_CANDIDATES);
  const fallbacks = chainIds
    .map((chainId) => (options.fallbacks || PUBLIC_FALLBACKS)[chainId])
    .filter((url) => typeof url === "string");
  const ordered = [...new Set([...urls.slice(0, maxCandidates), ...fallbacks])];
  const resolved = new Map();
  const boundedCall = (url, method, params, timeoutMs) =>
    readBeforeDeadline(call, url, method, params, timeoutMs, now, deadline);
  for (let start = 0; start < ordered.length; start += QUALIFICATION_CONCURRENCY) {
    const needed = chainIds.filter((id) => (resolved.get(id) || []).length < MAX_ENDPOINTS_PER_CHAIN);
    if (!needed.length || now() >= deadline) break;
    const batch = ordered.slice(start, start + QUALIFICATION_CONCURRENCY);
    const qualified = await Promise.all(batch.map((url) => probeEndpoint(boundedCall, url, needed, wallet)));
    for (let index = 0; index < batch.length; index += 1) {
      const chainId = qualified[index];
      if (chainId === null) continue;
      const pool = resolved.get(chainId) || [];
      if (pool.length < MAX_ENDPOINTS_PER_CHAIN) pool.push(batch[index]);
      resolved.set(chainId, pool);
    }
  }
  return resolved;
}

function rpcResultValid(method, params, value) {
  if (method === "eth_blockNumber" || method === "eth_getTransactionCount") {
    return numberOrNull(value) !== null;
  }
  if (method === "eth_getBlockByNumber") {
    return value && numberOrNull(value.number) === numberOrNull(params[0])
      && timestampIso(value.timestamp) !== null && Array.isArray(value.transactions);
  }
  if (method === "eth_getTransactionReceipt") {
    return value && (value.status === "0x0" || value.status === "0x1") && Array.isArray(value.logs);
  }
  return method === "eth_call" && typeof value === "string" && /^0x[0-9a-f]*$/iu.test(value);
}

// Retries use the exact same block/hash parameters, never a fresh head. Keep a
// successful provider per method so a pruned node is not retried for every
// historical nonce. Endpoint identities stay inside this process-only closure.
function createFallbackCall(urls, call, { now, deadline }) {
  const pool = [...new Set(urls)].slice(0, MAX_ENDPOINTS_PER_CHAIN);
  const preferred = new Map();
  return async (_url, method, params, timeoutMs, accept = () => true) => {
    const first = preferred.get(method);
    const ordered = first ? [first, ...pool.filter((url) => url !== first)] : pool;
    for (const url of ordered) {
      if (now() >= deadline) break;
      const value = await readBeforeDeadline(call, url, method, params, timeoutMs, now, deadline);
      if (rpcResultValid(method, params, value) && accept(value)) {
        preferred.set(method, url);
        return value;
      }
    }
    return null;
  };
}

// --- nonce transition search -------------------------------------------------------------
async function nonceAt(call, url, wallet, block) {
  let raw;
  try {
    raw = await call(url, "eth_getTransactionCount", [wallet, hexBlock(block)], CHAIN_TIMEOUT_MS);
  } catch (_) {
    return null;
  }
  if (typeof raw !== "string" || !/^0x[0-9a-f]+$/iu.test(raw)) return null;
  const parsed = Number(BigInt(raw));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function binarySearchNonceBlock(call, url, wallet, target, lo, hi) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const current = await nonceAt(call, url, wallet, mid);
    if (current === null) return null;
    if (current >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// Lowest block in [0, hi] whose account nonce is at least `target`; `hi` must
// already satisfy nonce(hi) >= target. Galloping from `hi` keeps clustered
// transactions cheap while remaining bounded for distant history.
async function findNonceTransitionBlock(call, url, wallet, target, hi) {
  let high = hi;
  let step = 1;
  while (high > 0) {
    const low = Math.max(0, high - step);
    const current = await nonceAt(call, url, wallet, low);
    if (current === null) return null;
    if (current >= target) {
      high = low;
      if (low === 0) return 0;
      step *= 2;
    } else {
      return binarySearchNonceBlock(call, url, wallet, target, low + 1, high);
    }
  }
  return 0;
}

// --- decoding ----------------------------------------------------------------------------
async function resolveTokenMeta(chainId, token, call, url, cache, registry, errors) {
  const key = `${chainId}:${token}`;
  if (cache.has(key)) return cache.get(key);
  const known = registry[chainId] && registry[chainId][token];
  if (known) {
    const meta = { symbol: known.symbol, decimals: known.decimals };
    cache.set(key, meta);
    return meta;
  }
  let symbolRaw = null;
  let decimalsRaw = null;
  try {
    symbolRaw = await call(url, "eth_call", [{ to: token, data: TOKEN_SELECTOR.symbol }, "latest"], CHAIN_TIMEOUT_MS);
    decimalsRaw = await call(url, "eth_call", [{ to: token, data: TOKEN_SELECTOR.decimals }, "latest"], CHAIN_TIMEOUT_MS);
  } catch (_) {
    symbolRaw = null;
    decimalsRaw = null;
  }
  const meta = { symbol: decodeSymbol(symbolRaw), decimals: decodeDecimals(decimalsRaw) };
  if (!meta.symbol || meta.decimals === null) {
    errors.push({ scope: "token", message: `TOKEN_META_UNRESOLVED:${token.slice(0, 10)}` });
  }
  cache.set(key, meta);
  return meta;
}

function decodeTransfer(log, wallet) {
  if (!log || !Array.isArray(log.topics) || log.topics.length < 3) return null;
  if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  const from = `0x${String(log.topics[1]).slice(26).toLowerCase()}`;
  const to = `0x${String(log.topics[2]).slice(26).toLowerCase()}`;
  if (from !== wallet && to !== wallet) return null;
  const raw = hexToDecimal(log.data);
  if (raw === null) return null;
  return { token: String(log.address).toLowerCase(), raw, direction: from === wallet ? "out" : "in" };
}

function describeTx(hash, tx, input, hasValue, hasTokenTransfer) {
  const label = KNOWN_TX_LABELS[hash];
  if (label) return label;
  if (!tx.to) return "Contract deployment";
  if (input === "0x" || input === "0x0") return hasValue ? "ETH transfer" : "Empty call";
  const methodName = METHOD_NAMES[input.slice(0, 10).toLowerCase()];
  if (methodName) return `Contract interaction \u00b7 ${methodName}`;
  if (hasTokenTransfer) return "Token transfer";
  if (hasValue) return "ETH transfer";
  return "Contract interaction";
}

async function buildRow({ tx, block, chainId, wallet, call, url, cache, registry, errors }) {
  const hash = String(tx.hash).toLowerCase();
  let receipt = null;
  try {
    receipt = await call(url, "eth_getTransactionReceipt", [hash], CHAIN_TIMEOUT_MS,
      (value) => String(value.transactionHash).toLowerCase() === hash
        && numberOrNull(value.blockNumber) === numberOrNull(tx.blockNumber)
        && (!tx.blockHash || value.blockHash === tx.blockHash));
  } catch (_) {
    receipt = null;
  }
  const receiptError = !receipt || !["0x0", "0x1"].includes(receipt.status) ? "RECEIPT_READ_FAILED" : null;
  if (receiptError) errors.push({ scope: `chain-${chainId}`, message: receiptError });
  const status = receipt && receipt.status === "0x1"
    ? "mined"
    : receipt && receipt.status === "0x0"
      ? "failed"
      : "RECEIPT_UNAVAILABLE";
  const from = normalizeAddress(tx.from);
  const to = normalizeAddress(tx.to);
  const direction = from === wallet ? "out" : to === wallet ? "in" : "unknown";
  const valueRaw = hexToDecimal(tx.value);
  const hasValue = valueRaw !== null && valueRaw !== "0";
  const input = typeof tx.input === "string" ? tx.input : "0x";

  const amounts = [];
  if (hasValue) {
    amounts.push({
      token: null,
      symbol: nativeSymbol(chainId),
      decimals: NATIVE_DECIMALS,
      raw: valueRaw,
      formatted: formatUnits(valueRaw, NATIVE_DECIMALS),
      direction: direction === "in" ? "in" : "out",
    });
  }
  const logs = receipt && Array.isArray(receipt.logs) ? receipt.logs : [];
  for (const log of logs) {
    const transfer = decodeTransfer(log, wallet);
    if (!transfer) continue;
    const meta = await resolveTokenMeta(chainId, transfer.token, call, url, cache, registry, errors);
    amounts.push({
      token: transfer.token,
      symbol: meta.symbol,
      decimals: meta.decimals,
      raw: transfer.raw,
      formatted: meta.decimals === null ? null : formatUnits(transfer.raw, meta.decimals),
      direction: transfer.direction,
    });
    if (amounts.length >= MAX_AMOUNTS) break;
  }
  const method = input.length >= 10 ? input.slice(0, 10).toLowerCase() : null;
  const methodName = method ? METHOD_NAMES[method] || null : null;
  return {
    hash,
    chainId,
    blockNumber: numberOrNull(tx.blockNumber),
    blockTimestamp: timestampIso(block.timestamp),
    status,
    direction,
    from,
    to,
    method,
    methodName,
    description: describeTx(hash, tx, input, hasValue, amounts.some((amount) => amount.token)),
    gasUsed: receipt ? decimalOrNull(receipt.gasUsed) : null,
    gasPriceWei: decimalOrNull(tx.gasPrice) || (receipt ? decimalOrNull(receipt.effectiveGasPrice) : null),
    amounts,
    error: receiptError,
  };
}

// --- collection --------------------------------------------------------------------------
async function collectChain({ chainId, url, wallet, call, now, deadline, maxRows, registry, cache, errors }) {
  const result = { chainId, name: chainName(chainId), headBlock: null, nonce: null, rows: [], error: null };
  let headRaw = null;
  try {
    headRaw = await call(url, "eth_blockNumber", [], CHAIN_TIMEOUT_MS);
  } catch (_) {
    headRaw = null;
  }
  if (numberOrNull(headRaw) === null) {
    result.error = "BLOCK_READ_FAILED";
    errors.push({ scope: `chain-${chainId}`, message: "BLOCK_READ_FAILED" });
    return result;
  }
  result.headBlock = Number(BigInt(headRaw));
  const nonce = await nonceAt(call, url, wallet, result.headBlock);
  if (nonce === null) {
    result.error = "NONCE_READ_FAILED";
    errors.push({ scope: `chain-${chainId}`, message: "NONCE_READ_FAILED" });
    return result;
  }
  result.nonce = nonce;
  const limit = Math.min(maxRows, nonce);
  let hi = result.headBlock;
  for (let k = nonce; k > nonce - limit && k >= 1; k -= 1) {
    if (now() >= deadline) {
      result.error = "DEADLINE_EXCEEDED";
      errors.push({ scope: "run", message: "DEADLINE_EXCEEDED" });
      break;
    }
    const blockNumber = await findNonceTransitionBlock(call, url, wallet, k, hi);
    if (blockNumber === null) {
      result.error = "HISTORICAL_NONCE_READ_FAILED";
      errors.push({ scope: `chain-${chainId}`, message: "HISTORICAL_NONCE_READ_FAILED" });
      break;
    }
    let block = null;
    const matchesTx = (candidate) => candidate && normalizeAddress(candidate.from) === wallet
      && numberOrNull(candidate.nonce) === k - 1 && numberOrNull(candidate.blockNumber) === blockNumber;
    try {
      block = await call(url, "eth_getBlockByNumber", [hexBlock(blockNumber), true], BLOCK_TIMEOUT_MS,
        (value) => value.transactions.some(matchesTx));
    } catch (_) {
      block = null;
    }
    if (!block || !Array.isArray(block.transactions)) {
      result.error = "BLOCK_TX_READ_FAILED";
      errors.push({ scope: `chain-${chainId}`, message: "BLOCK_TX_READ_FAILED" });
      hi = blockNumber;
      continue;
    }
    const tx = block.transactions.find(matchesTx);
    if (!tx) {
      result.error = "NONCE_TX_NOT_FOUND";
      errors.push({ scope: `chain-${chainId}`, message: "NONCE_TX_NOT_FOUND" });
      hi = blockNumber;
      continue;
    }
    result.rows.push(
      await buildRow({ tx, block, chainId, wallet, call, url, cache, registry, errors })
    );
    if (result.rows.length >= maxRows) break;
    hi = blockNumber;
  }
  result.rows.sort(
    (a, b) => (b.blockNumber || 0) - (a.blockNumber || 0)
  );
  return result;
}

function capRows(chains, maxRows) {
  const flattened = [];
  chains.forEach((chain, chainIndex) => {
    chain.rows.forEach((row) => flattened.push({ chainIndex, row }));
  });
  flattened.sort(
    (a, b) => (Date.parse(b.row.blockTimestamp) || 0) - (Date.parse(a.row.blockTimestamp) || 0)
  );
  const kept = flattened.slice(0, maxRows);
  const perChain = chains.map(() => []);
  for (const entry of kept) perChain[entry.chainIndex].push(entry.row);
  return chains.map((chain, index) => ({ ...chain, collectedRowCount: chain.rows.length, rows: perChain[index] }));
}

// `call` and `chainEndpoints` are injectable for offline tests.
async function runOnce(options = {}) {
  const now = options.now || Date.now;
  const started = now();
  const wallet = normalizeAddress(options.wallet || WALLET_DEFAULT);
  if (!wallet) throw new WatchError("WALLET_INVALID");
  const chainIds = options.chainIds || CHAINS;
  const maxRows = Math.min(Math.max(1, options.maxRows || MAX_ROWS), MAX_ROWS);
  const call = options.call || rpcCall;
  const errors = [];
  let chainEndpoints = options.chainEndpoints;
  if (!chainEndpoints) {
    chainEndpoints = await resolveEndpoints(chainIds, wallet, {
      call: options.call,
      urls: options.urls,
      fallbacks: options.fallbacks,
      now,
      maxCandidates: options.maxCandidates,
      deadlineMs: options.resolutionDeadlineMs,
    });
  }
  const cache = new Map();
  const registry = options.registry || TOKEN_REGISTRY;
  const deadline = now() + (options.deadlineMs || RUN_DEADLINE_MS);
  const chains = [];
  for (const chainId of chainIds) {
    const selected = chainEndpoints.get(chainId);
    const urls = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (!urls.length) {
      chains.push({ chainId, name: chainName(chainId), headBlock: null, nonce: null, rows: [], error: "NO_ENDPOINT" });
      errors.push({ scope: `chain-${chainId}`, message: "NO_ENDPOINT" });
      continue;
    }
    chains.push(
      await collectChain({
        chainId,
        url: urls[0],
        wallet,
        call: createFallbackCall(urls, call, { now, deadline }),
        now,
        deadline,
        maxRows,
        registry,
        cache,
        errors,
      })
    );
  }
  const capped = capRows(chains, maxRows);
  const artifact = buildArtifact({
    wallet,
    chains: capped,
    errors,
    durationMs: now() - started,
    maxRows,
    now,
  });
  return { artifact, outPath: options.outPath || OUT_PATH };
}

function buildArtifact({ wallet, chains, errors, durationMs, maxRows, now }) {
  const rowCount = chains.reduce((total, chain) => total + chain.rows.length, 0);
  return {
    schema: SCHEMA,
    wallet,
    generatedAt: new Date(now()).toISOString(),
    durationMs,
    maxRows,
    chains,
    rowCount,
    noSigning: true,
    noBroadcast: true,
    errors: errors.slice(0, MAX_ERRORS),
  };
}

function writeArtifact(artifact, outPath, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(outPath), { recursive: true });
  const temporary = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`);
    fsImpl.renameSync(temporary, outPath);
  } finally {
    try {
      if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
    } catch (_) {
      /* best-effort cleanup */
    }
  }
  return outPath;
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((value) => value.startsWith("--")));
  const unknown = [...flags].filter((value) => !["--once", "--check"].includes(value));
  if (unknown.length || (flags.has("--once") && flags.has("--check"))) throw new WatchError("USAGE");
  return { check: flags.has("--check"), once: !flags.has("--check") };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.check) {
    process.stdout.write(`${JSON.stringify({
      status: "CHECK_OK",
      schema: SCHEMA,
      wallet: WALLET_DEFAULT,
      chains: CHAINS,
      maxRows: MAX_ROWS,
      wrote: false,
    })}\n`);
    return;
  }
  const { artifact, outPath } = await runOnce({});
  writeArtifact(artifact, outPath);
  process.stdout.write(`${JSON.stringify({
    status: "OK",
    schema: artifact.schema,
    artifact: OUT_REL,
    wallet: artifact.wallet,
    asOf: artifact.generatedAt,
    durationMs: artifact.durationMs,
    rowCount: artifact.rowCount,
    chains: artifact.chains.map((chain) => ({
      chainId: chain.chainId,
      headBlock: chain.headBlock,
      nonce: chain.nonce,
      rows: chain.rows.length,
      error: chain.error,
    })),
    errors: artifact.errors.length,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`watch-wallet-transactions failed: ${error && error.code ? error.code : "COLLECT_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, OUT_PATH, OUT_REL, SCHEMA, WALLET_DEFAULT, ADDRESS_RE, DECIMAL_RE,
  TRANSFER_TOPIC, TOKEN_SELECTOR, MAX_ROWS, MAX_AMOUNTS, MAX_ERRORS, NATIVE_DECIMALS,
  CHAIN_TIMEOUT_MS, BLOCK_TIMEOUT_MS, ENDPOINT_CANDIDATES, MAX_ENDPOINTS_PER_CHAIN, QUALIFICATION_CONCURRENCY,
  RESOLUTION_DEADLINE_MS, RUN_DEADLINE_MS, CHAINS, CHAIN_NAMES, CHAIN_NATIVE,
  CHAIN_EXPLORER, TOKEN_REGISTRY, KNOWN_TX_LABELS, METHOD_NAMES,
  WatchError, relPosix, chainName, nativeSymbol, hexBlock, normalizeAddress,
  hexToDecimal, decimalOrNull, numberOrNull, timestampIso, formatUnits, sanitizeMessage,
  asciiFromHex, decodeSymbol, decodeDecimals, probeEndpoint, resolveEndpoints, createFallbackCall, nonceAt,
  binarySearchNonceBlock, findNonceTransitionBlock, resolveTokenMeta, decodeTransfer,
  describeTx, buildRow, collectChain, capRows, runOnce, buildArtifact, writeArtifact,
  parseArgs, main,
};
