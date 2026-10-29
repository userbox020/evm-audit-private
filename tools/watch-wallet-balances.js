#!/usr/bin/env node
"use strict";

// watch-wallet-balances.js — read-only wallet-balance collector for the local
// dashboard.
//
// Reads coordination/watch-addresses.json (public addresses), enumerates the
// bounded set of EVM chains that have endpoints in the process-only inventory,
// and records native balances (plus best-effort tokens where repo constants
// exist). A watchlist entry may declare `family`: absent means `evm` (back-compat);
// `solana` entries are read over a Solana JSON-RPC endpoint taken from the same
// process-only inventory (`rpc_endpoints.txt`) and report SOL plus common SPL
// token balances. Nothing is signed or broadcast; endpoint values, URLs, domains
// and credentials are never printed, persisted, or placed in the artifact.
//
// Usage:
//   node tools/watch-wallet-balances.js --once     (default) collect + write
//   node tools/watch-wallet-balances.js --check    dry-run: validate only, no RPC, no write
//
// Read-only. Endpoints process-only.

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { loadRpcUrls, rpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");
const deadline = require("./lib/producer-deadline");
const { acquireWalletBalanceOutputOwner, assertWalletBalanceOutputOwner } = require("./lib/wallet-balance-output-owner");

const WORKSPACE = path.resolve(__dirname, "..");
const WATCHLIST_PATH = path.join(WORKSPACE, "coordination", "watch-addresses.json");
const OUT_PATH = path.join(WORKSPACE, "reports", "monitor", "wallet-balances.json");
const WATCHLIST_REL = "coordination/watch-addresses.json";
const OUT_REL = "reports/monitor/wallet-balances.json";

const SCHEMA = "wallet-balances/v1";
const WATCHLIST_SCHEMA = "watch-addresses/v1";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

// Address families. An absent `family` on a watchlist entry means `evm` for
// back-compat with the existing single-EVM-address watchlist.
const EVM_FAMILY = "evm";
const SOLANA_FAMILY = "solana";
const FAMILIES = Object.freeze([EVM_FAMILY, SOLANA_FAMILY]);
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const SOLANA_NATIVE_SYMBOL = "SOL";
const SOLANA_NATIVE_DECIMALS = 9;
const SOLANA_COINGECKO = "solana";
const SOLANA_RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const SOLANA_PUBLIC_FALLBACK = "https://api.mainnet-beta.solana.com";
const SOLANA_TIMEOUT_MS = 15_000;
const SOLANA_COMMITMENT = "confirmed";
// Common SPL token mints. USDC is the required minimum; USDT is included as the
// other high-liquidity stablecoin mint. Both are the canonical mainnet mints.
const SOLANA_SPL_TOKENS = Object.freeze([
  Object.freeze({ symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }),
  Object.freeze({ symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 }),
]);
const BOUNDED_CHAIN_IDS = Object.freeze([
  1, 10, 56, 100, 130, 137, 146, 196, 250, 324, 480, 999, 8453, 42161, 43114,
  5000, 9745, 59144, 534352, 81457, 42220, 1135, 57073, 1868, 34443, 252, 42793, 98866,
]);

const CHAIN_NAMES = Object.freeze({
  1: "ethereum", 10: "optimism", 56: "bsc", 100: "gnosis", 130: "unichain",
  137: "polygon", 146: "sonic", 196: "xlayer", 250: "fantom", 324: "zksync",
  480: "worldchain", 999: "hyperevm", 8453: "base", 42161: "arbitrum",
  43114: "avalanche", 5000: "mantle", 9745: "plasma", 59144: "linea",
  534352: "scroll", 81457: "blast", 42220: "celo", 1135: "lisk", 57073: "ink",
  1868: "soneium", 34443: "mode", 252: "fraxtal", 42793: "etherlink", 98866: "plume",
});

const CHAIN_NATIVE = Object.freeze({
  1: "ETH", 10: "ETH", 130: "ETH", 324: "ETH", 480: "ETH", 8453: "ETH",
  42161: "ETH", 59144: "ETH", 534352: "ETH", 81457: "ETH", 57073: "ETH",
  1868: "ETH", 34443: "ETH",
  56: "BNB", 100: "xDAI", 137: "POL", 146: "S", 196: "OKB", 250: "FTM",
  999: "HYPE", 43114: "AVAX", 5000: "MNT", 9745: "XPL", 42220: "CELO", 1135: "LSK",
  252: "FRAX", 42793: "XTZ", 98866: "PLUME",
});

const CHAIN_TIMEOUT_MS = 9000;
const READ_CONCURRENCY = 4;
const INVENTORY_CANDIDATES = 60;
const CHAIN_PROBE_TIMEOUT_MS = 4000;
const RESOLUTION_DEADLINE_MS = 180_000;
const RUN_DEADLINE_MS = 225_000;
const NATIVE_DECIMALS = 18;
const UNPRICED_CHAIN_CAP = 64;

// Canonical stablecoin deployments. Addresses are sourced from authoritative
// public lists (Circle USDC contract addresses; the Optimism Superchain token
// list; the official Scroll token list; the official Soneium contracts page; the
// official Mantle token list; the official Gnosis Chain Useful Contracts page).
// Every entry is validated on-chain (`symbol()`, `decimals()`) before it is
// trusted; a mismatch or read failure skips the token with a sanitized warning.
// The contract-reported symbol is kept verbatim (e.g. `USDC.e` stays `USDC.e`).
// Chains below without an authoritative address are skipped with a warning,
// never guessed.
const STABLECOINS = Object.freeze({
  1: Object.freeze([
    Object.freeze({ symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }),
    Object.freeze({ symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7" }),
    Object.freeze({ symbol: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f" }),
  ]),
  10: Object.freeze([Object.freeze({ symbol: "USDC", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85" })]),
  56: Object.freeze([Object.freeze({ symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955" })]),
  100: Object.freeze([Object.freeze({ symbol: "WXDAI", address: "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d" })]),
  130: Object.freeze([
    Object.freeze({ symbol: "USDC", address: "0x078d782b760474a361dda0af3839290b0ef57ad6" }),
    Object.freeze({ symbol: "USDT", address: "0x588ce4f028d8e7b53b687865d6a67b3a54c75518" }),
    Object.freeze({ symbol: "DAI", address: "0x20cab320a855b39f724131c69424240519573f81" }),
  ]),
  137: Object.freeze([Object.freeze({ symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" })]),
  146: Object.freeze([Object.freeze({ symbol: "USDC", address: "0x29219dd400f2bf60e5a23d13be72b486d4038894" })]),
  999: Object.freeze([Object.freeze({ symbol: "USDC", address: "0xb88339cb7199b77e23db6e890353e22632ba630f" })]),
  1135: Object.freeze([
    Object.freeze({ symbol: "USDC.e", address: "0xf242275d3a6527d877f2c927a82d9b057609cc71" }),
    Object.freeze({ symbol: "USDT", address: "0x05d032ac25d322df992303dca074ee7392c117b9" }),
  ]),
  1868: Object.freeze([
    Object.freeze({ symbol: "USDT", address: "0x3a337a6ada9d885b6ad95ec48f9b75f197b5ae35" }),
    Object.freeze({ symbol: "USDC.e", address: "0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369" }),
  ]),
  5000: Object.freeze([Object.freeze({ symbol: "USDC", address: "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9" })]),
  8453: Object.freeze([Object.freeze({ symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" })]),
  9745: Object.freeze([Object.freeze({ symbol: "USDC", address: "0x2d661c89d812261039af9764eceaaee884f5f67f" })]),
  34443: Object.freeze([
    Object.freeze({ symbol: "USDC", address: "0xd988097fb8612cc24eec14542bc03424c656005f" }),
    Object.freeze({ symbol: "USDT", address: "0xf0f161fda2712db8b566946122a5af183995e2ed" }),
    Object.freeze({ symbol: "DAI", address: "0xe7798f023fc62146e8aa1b36da45fb70855a77ea" }),
  ]),
  42161: Object.freeze([Object.freeze({ symbol: "USDC", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" })]),
  42220: Object.freeze([Object.freeze({ symbol: "USDC", address: "0xceba9300f2b948710d2653dd7b07f33a8b32118c" })]),
  43114: Object.freeze([Object.freeze({ symbol: "USDC", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e" })]),
  57073: Object.freeze([Object.freeze({ symbol: "USDC", address: "0x2d270e6886d130d724215a266106e6832161eaed" })]),
  59144: Object.freeze([Object.freeze({ symbol: "USDC", address: "0x176211869ca2b568f2a7d4ee941e073a821ee1ff" })]),
  534352: Object.freeze([
    Object.freeze({ symbol: "USDC", address: "0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4" }),
    Object.freeze({ symbol: "USDT", address: "0xf55bec9cafdbe8730f096aa55dad6d22d44099df" }),
    Object.freeze({ symbol: "DAI", address: "0xca77eb3fefe3725dc33bccb54edefc3d9f764f97" }),
  ]),
});

// Chains with no static canonical USD stablecoin that could be authoritatively
// confirmed. Blast is excluded on purpose: the official Blast docs list only
// USDB (`0x4300…0003`), a rebasing stablecoin whose balance is a yield-bearing
// wrapper rather than a fixed ERC20 claim; the $1.00 static valuation does not
// apply cleanly, so it is kept out of the map rather than mispriced.
const UNBOUND_STABLECOIN_CHAINS = Object.freeze({
  81457: "blast",
});

// DefiLlama native-token ids (public, credential-free). An unlisted/unknown id
// simply yields no price and the native USD field stays null.
const NATIVE_COINGECKO = Object.freeze({
  1: "ethereum", 10: "ethereum", 56: "binancecoin", 100: "xdai", 130: "ethereum",
  137: "polygon-ecosystem-token", 146: "sonic-3", 196: "okb", 250: "fantom", 324: "ethereum",
  480: "ethereum", 999: "hyperliquid", 8453: "ethereum", 42161: "ethereum",
  43114: "avalanche-2", 5000: "mantle", 9745: "plasma", 59144: "ethereum",
  534352: "ethereum", 81457: "ethereum", 42220: "celo", 1135: "lisk", 57073: "ethereum",
  1868: "ethereum", 34443: "ethereum", 252: "frax", 42793: "tezos", 98866: "plume",
});

const DEFILLAMA_PRICE_BASE = "https://coins.llama.fi/prices/current";
const PRICE_TIMEOUT_MS = 15_000;
const PRICE_MAX_ATTEMPTS = 2;

const TOKEN_SELECTOR = Object.freeze({
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  balanceOf: "0x70a08231",
});
const STABLE_USD_ASSUMPTION_NOTE = "Stablecoin balances (USDC/USDT/DAI) are valued at exactly $1.00 each; no market price source is used.";

class WatchError extends Error {
  constructor(code) {
    super(code);
    this.name = "WatchError";
    this.code = code;
  }
}

function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }
function chainName(chainId) { return CHAIN_NAMES[chainId] || `chain-${chainId}`; }
function nativeSymbol(chainId) { return CHAIN_NATIVE[chainId] || "NATIVE"; }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }

// Bounded worker pool (max concurrency 4) preserving input order.
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const bounded = Math.min(Math.max(1, concurrency), READ_CONCURRENCY);
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = { ok: true, value: await worker(items[index], index) }; }
      catch (error) { results[index] = { ok: false, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(bounded, Math.max(1, items.length)) }, run));
  return results;
}

function formatNative(raw) {
  const value = BigInt(raw);
  const base = 10n ** BigInt(NATIVE_DECIMALS);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString();
  let text = fraction.toString().padStart(NATIVE_DECIMALS, "0").replace(/0+$/u, "");
  if (text.length > 8) text = text.slice(0, 8);
  return `${whole}.${text}`;
}

// Generic token amount formatting at the token's own decimals (display capped).
function formatUnits(raw, decimals) {
  const places = Number(decimals);
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

// Stablecoins are valued at exactly $1.00, so USD cents = raw / 10^decimals,
// rounded half-up to the nearest cent.
function centsFromRaw(raw, decimals) {
  const denominator = 10n ** BigInt(Number(decimals));
  return (BigInt(raw) * 100n + denominator / 2n) / denominator;
}
function usdFromRaw(raw, decimals) { return formatCents(centsFromRaw(raw, decimals)); }
function formatCents(value) {
  const cents = BigInt(value);
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
function centsFromUsd(value) {
  const match = /^(-?)([0-9]+)\.([0-9]{2})$/u.exec(String(value));
  if (!match) return null;
  const cents = BigInt(match[2]) * 100n + BigInt(match[3]);
  return match[1] === "-" ? -cents : cents;
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
function encodeBalanceOf(address) { return `${TOKEN_SELECTOR.balanceOf}${address.slice(2).padStart(64, "0")}`; }

function nativeCoingecko(chainId) { return NATIVE_COINGECKO[chainId] || null; }

function sleep(ms) { return deadline.sleep(ms); }

// Every read shares the producer's monotonic deadline. No fallback may silently
// multiply a request timeout; injected transports receive the same abort signal.
function boundedCall(call, remaining) {
  return (url, method, params, timeoutMs = CHAIN_TIMEOUT_MS) => {
    deadline.check();
    const scope = deadline.current();
    const budget = Math.floor(Math.min(remaining(), scope ? scope.remainingMs() : Infinity, timeoutMs));
    if (!(budget > 0)) throw new WatchError("TIMEOUT");
    return deadline.invoke(() => call(url, method, params, budget, { signal: scope?.signal, noFallback: true }));
  };
}

function requestAbort(timeoutMs) {
  deadline.check();
  const scope = deadline.current();
  const remaining = Math.min(timeoutMs, scope ? scope.remainingMs() : Infinity);
  if (!(remaining > 0)) throw new WatchError("TIMEOUT");
  const controller = new AbortController();
  const abort = () => controller.abort();
  scope?.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, remaining);
  return { signal: controller.signal, close() { clearTimeout(timer); scope?.signal.removeEventListener("abort", abort); } };
}

// Native USD from a base-unit balance and a USD-per-token price, rounded half-up
// to the cent using integer arithmetic (price scaled to 1e-6 USD). `decimals`
// defaults to the EVM native precision (18) and is 9 for Solana lamports.
function nativeUsdFromRaw(raw, price, decimals = NATIVE_DECIMALS) {
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const places = Number(decimals);
  if (!Number.isSafeInteger(places) || places < 0 || places > 36) return null;
  const priceMicro = BigInt(Math.round(numeric * 1_000_000));
  if (priceMicro <= 0n) return null;
  const valueMicro = (BigInt(raw) * priceMicro) / (10n ** BigInt(places));
  return formatCents((valueMicro + 5_000n) / 10_000n);
}

// One bounded, credential-free DefiLlama price call for the requested ids. The
// URL and raw response are process-only and never persisted; callers receive
// only `{ ok, prices }`. A failure yields ok=false and never fabricates prices.
async function fetchNativePrices(ids, options = {}) {
  const unique = [...new Set((ids || []).filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return { ok: true, prices: {} };
  const fetchImpl = options.fetchImpl || fetch;
  const url = `${DEFILLAMA_PRICE_BASE}/${unique.map((id) => `coingecko:${id}`).join(",")}`;
  for (let attempt = 0; attempt < PRICE_MAX_ATTEMPTS; attempt += 1) {
    const request = requestAbort(options.timeoutMs ?? PRICE_TIMEOUT_MS);
    try {
      const response = await deadline.invoke(() => fetchImpl(url, { signal: request.signal, headers: { accept: "application/json" } }));
      if (!response || response.ok !== true) throw new WatchError("PRICE_HTTP");
      const body = await deadline.invoke(() => response.json());
      const prices = {};
      for (const [key, row] of Object.entries((body && body.coins) || {})) {
        const id = key.startsWith("coingecko:") ? key.slice("coingecko:".length) : key;
        const price = Number(row && row.price);
        if (Number.isFinite(price) && price > 0) prices[id] = price;
      }
      return { ok: true, prices };
    } catch (_) {
      deadline.check();
      if (attempt < PRICE_MAX_ATTEMPTS - 1) await sleep(500);
    } finally {
      request.close();
    }
  }
  return { ok: false, prices: {} };
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

// --- watchlist ---------------------------------------------------------------------------
function normalizeAddress(value) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value.trim())) return null;
  return value.trim().toLowerCase();
}

// Base58 decode (Bitcoin alphabet). Returns a Buffer or null on any invalid char.
function base58Decode(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let value = 0n;
  for (const character of text) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) return null;
    value = value * 58n + BigInt(index);
  }
  const bytes = [];
  while (value > 0n) { bytes.push(Number(value & 0xffn)); value >>= 8n; }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  for (let index = 0; index < zeros; index += 1) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

// A Solana address is base58 text that decodes to exactly 32 bytes. Base58 is
// case-sensitive, so the address is preserved verbatim (never lowercased).
function normalizeSolanaAddress(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!SOLANA_ADDRESS_RE.test(text)) return null;
  const bytes = base58Decode(text);
  if (!bytes || bytes.length !== 32) return null;
  return text;
}

function familyOf(entry) {
  if (entry.family === undefined || entry.family === null) return EVM_FAMILY;
  return typeof entry.family === "string" ? entry.family.trim().toLowerCase() : null;
}

function validateWatchlist(value) {
  const errors = [];
  const seen = new Set();
  const addresses = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { addresses, errors: [{ scope: "watchlist", message: "SCHEMA_INVALID" }] };
  }
  if (value.schema !== WATCHLIST_SCHEMA) errors.push({ scope: "watchlist", message: "SCHEMA_VERSION_INVALID" });
  if (!Array.isArray(value.addresses)) {
    errors.push({ scope: "watchlist", message: "ADDRESSES_NOT_ARRAY" });
    return { addresses, errors };
  }
  value.addresses.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push({ scope: "watchlist", message: `ENTRY_INVALID:${index}` });
      return;
    }
    const family = familyOf(entry);
    if (family === null || !FAMILIES.includes(family)) {
      errors.push({ scope: "watchlist", message: `FAMILY_INVALID:${index}` });
      return;
    }
    const address = family === SOLANA_FAMILY ? normalizeSolanaAddress(entry.address) : normalizeAddress(entry.address);
    if (!address) { errors.push({ scope: "watchlist", message: `ADDRESS_INVALID:${index}` }); return; }
    const key = `${family}:${address}`;
    if (seen.has(key)) { errors.push({ scope: "watchlist", message: `ADDRESS_DUPLICATE:${index}` }); return; }
    seen.add(key);
    const label = entry.label === undefined || entry.label === null
      ? null
      : (typeof entry.label === "string" && entry.label.length <= 80 ? entry.label : null);
    if (entry.label !== undefined && entry.label !== null && label === null) errors.push({ scope: "watchlist", message: `LABEL_INVALID:${index}` });
    addresses.push({ label, address, family });
  });
  return { addresses, errors };
}

function loadWatchlist(file = WATCHLIST_PATH, fsImpl = fs) {
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch (_) {
    return { addresses: [], errors: [{ scope: "watchlist", message: "WATCHLIST_READ_FAILED" }] };
  }
  return validateWatchlist(parsed);
}

// --- chain enumeration -------------------------------------------------------------------
// Probe every endpoint in the process-only inventory once for its chain id and
// keep the first working endpoint per target chain. Falls back to the public
// fallback host only for a target chain the inventory did not cover. Endpoint
// values stay process-only.
async function enumerateChains(options = {}) {
  const chainIds = options.chainIds || BOUNDED_CHAIN_IDS;
  const now = options.now || (() => performance.now());
  const expires = now() + (options.deadlineMs ?? RESOLUTION_DEADLINE_MS);
  const call = boundedCall(options.call || rpcCall, () => expires - now());
  let urls = [];
  if (now() >= expires) return new Map();
  if (Array.isArray(options.urls)) urls = options.urls;
  else { try { urls = loadRpcUrls({ maxCandidates: options.maxCandidates || INVENTORY_CANDIDATES }); } catch (_) { urls = []; } }
  const targets = new Set(chainIds);
  const resolved = new Map();
  const probes = await mapPool(urls, READ_CONCURRENCY, async (url) => {
    if (now() >= expires) return null;
    let raw = null;
    try { raw = await call(url, "eth_chainId", [], CHAIN_PROBE_TIMEOUT_MS); } catch (_) { return null; }
    if (typeof raw !== "string" || !/^0x[0-9a-f]+$/iu.test(raw)) return null;
    const chainId = Number(BigInt(raw));
    return Number.isSafeInteger(chainId) && targets.has(chainId) ? { chainId, url } : null;
  });
  for (const entry of probes) {
    if (!entry.ok || entry.value === null || resolved.has(entry.value.chainId)) continue;
    resolved.set(entry.value.chainId, entry.value.url);
  }
  for (const chainId of chainIds) {
    if (resolved.has(chainId) || now() >= expires) continue;
    const fallback = (options.fallbacks || PUBLIC_FALLBACKS)[chainId];
    if (typeof fallback !== "string") continue;
    try {
      const raw = await call(fallback, "eth_chainId", [], CHAIN_PROBE_TIMEOUT_MS);
      if (typeof raw === "string" && Number(BigInt(raw)) === chainId) resolved.set(chainId, fallback);
    } catch (_) { /* leave unresolved */ }
  }
  return resolved;
}

// --- collection --------------------------------------------------------------------------
// Validate one canonical stablecoin once per chain; never trust a static address
// without an on-chain symbol/decimals match.
async function readTokenMeta(call, url, spec, errors) {
  let symbolRaw = null;
  try { symbolRaw = await call(url, "eth_call", [{ to: spec.address, data: TOKEN_SELECTOR.symbol }, "latest"], CHAIN_TIMEOUT_MS); }
  catch (_) { symbolRaw = null; }
  const symbol = decodeSymbol(symbolRaw);
  if (!symbol || symbol.trim().toUpperCase() !== spec.symbol.toUpperCase()) {
    errors.push({ scope: "token", message: `TOKEN_SKIPPED:${spec.symbol}:identity` });
    return null;
  }
  let decimalsRaw = null;
  try { decimalsRaw = await call(url, "eth_call", [{ to: spec.address, data: TOKEN_SELECTOR.decimals }, "latest"], CHAIN_TIMEOUT_MS); }
  catch (_) { decimalsRaw = null; }
  const decimals = decodeDecimals(decimalsRaw);
  if (decimals === null) {
    errors.push({ scope: "token", message: `TOKEN_SKIPPED:${spec.symbol}:decimals` });
    return null;
  }
  return { symbol: spec.symbol, address: spec.address.toLowerCase(), decimals };
}

// `chainEndpoints` is a Map<chainId, endpointValue>; endpoint values are never
// emitted. `call` and `stablecoins` are injectable for offline tests.
async function collect({ addresses, chainEndpoints, call, now = () => performance.now(), stablecoins = STABLECOINS, deadlineMs = RUN_DEADLINE_MS, nativePrices = {}, priceAvailable = false }) {
  const chains = [];
  const errors = [];
  const unpriced = new Set();
  const deadline = now() + deadlineMs;
  call = boundedCall(call, () => deadline - now());
  const orderedChains = [...chainEndpoints.keys()].sort((a, b) => a - b);
  for (const chainId of orderedChains) {
    if (now() >= deadline) { errors.push({ scope: "run", message: "DEADLINE_EXCEEDED" }); break; }
    if (UNBOUND_STABLECOIN_CHAINS[chainId]) errors.push({ scope: "token", message: `STABLECOIN_UNBOUND:${UNBOUND_STABLECOIN_CHAINS[chainId]}:no-authoritative-address` });
    const url = chainEndpoints.get(chainId);
    const tokenMeta = [];
    for (const spec of (stablecoins[chainId] || [])) {
      const meta = await readTokenMeta(call, url, spec, errors);
      if (meta) tokenMeta.push(meta);
    }
    const tokenSetComplete = tokenMeta.length === (stablecoins[chainId] || []).length && !UNBOUND_STABLECOIN_CHAINS[chainId];
    if (!tokenSetComplete) unpriced.add(chainName(chainId));
    const coingeckoId = nativeCoingecko(chainId);
    const nativePrice = priceAvailable && coingeckoId ? nativePrices[coingeckoId] : null;
    const jobs = addresses.map((entry) => ({ ...entry }));
    const outcomes = await mapPool(jobs, READ_CONCURRENCY, async (entry) => {
      let blockRaw;
      try { blockRaw = await call(url, "eth_blockNumber", [], CHAIN_TIMEOUT_MS); }
      catch (_) { return { address: entry.address, blockNumber: null, native: null, tokens: [], stableUsdTotal: null, totalUsd: null, error: "BLOCK_READ_FAILED" }; }
      if (typeof blockRaw !== "string" || !/^0x[0-9a-f]+$/iu.test(blockRaw)) {
        return { address: entry.address, blockNumber: null, native: null, tokens: [], stableUsdTotal: null, totalUsd: null, error: "BLOCK_READ_FAILED" };
      }
      const blockNumber = Number(BigInt(blockRaw));
      let native = null;
      let nativeError = null;
      let balanceRaw;
      try { balanceRaw = await call(url, "eth_getBalance", [entry.address, hexBlock(blockNumber)], CHAIN_TIMEOUT_MS); }
      catch (_) { balanceRaw = null; }
      if (typeof balanceRaw !== "string" || !/^0x[0-9a-f]+$/iu.test(balanceRaw)) {
        nativeError = "BALANCE_READ_FAILED";
      } else {
        const raw = BigInt(balanceRaw).toString();
        const usd = nativePrice !== null && nativePrice !== undefined ? nativeUsdFromRaw(raw, nativePrice) : null;
        native = { symbol: nativeSymbol(chainId), raw, formatted: formatNative(raw), usd };
      }
      // Token balances are read at the same per-address block. A read failure is
      // recorded as null (never assumed) and makes the total unknown.
      const tokens = [];
      let rowCents = 0n;
      let tokensComplete = tokenSetComplete;
      for (const token of tokenMeta) {
        let tokenBalance = null;
        try { tokenBalance = await call(url, "eth_call", [{ to: token.address, data: encodeBalanceOf(entry.address) }, hexBlock(blockNumber)], CHAIN_TIMEOUT_MS); }
        catch (_) { tokenBalance = null; }
        if (typeof tokenBalance !== "string" || !/^0x[0-9a-f]+$/iu.test(tokenBalance)) {
          tokens.push({ symbol: token.symbol, address: token.address, decimals: token.decimals, raw: null, formatted: null, usd: null });
          tokensComplete = false;
          unpriced.add(chainName(chainId));
          continue;
        }
        const raw = BigInt(tokenBalance).toString();
        const usd = usdFromRaw(raw, token.decimals);
        tokens.push({ symbol: token.symbol, address: token.address, decimals: token.decimals, raw, formatted: formatUnits(raw, token.decimals), usd });
        const cents = centsFromUsd(usd);
        if (cents !== null) rowCents += cents;
      }
      // A total requires every monitored token and the native leg to be priced.
      let totalUsd = null;
      if (tokensComplete && native && native.usd !== null) {
        const nativeCents = centsFromUsd(native.usd);
        if (nativeCents !== null) totalUsd = formatCents(nativeCents + rowCents);
      }
      return {
        address: entry.address,
        blockNumber,
        native,
        tokens,
        stableUsdTotal: tokensComplete ? formatCents(rowCents) : null,
        totalUsd,
        error: nativeError,
      };
    });
    const addressRows = outcomes.map((outcome, index) => (outcome.ok ? outcome.value : {
      address: jobs[index].address, blockNumber: null, native: null, tokens: [], stableUsdTotal: null, totalUsd: null, error: "ROW_FAILED",
    }));
    if (addressRows.length > 0) chains.push({ chainId, name: chainName(chainId), addressRows });
  }
  return { chains, errors, unpricedChains: [...unpriced].slice(0, UNPRICED_CHAIN_CAP) };
}

// --- solana ------------------------------------------------------------------------------
// Solana endpoints come from the same process-only inventory the solana scanners
// use (`rpc_endpoints.txt` lines mentioning solana/helius), plus the public
// mainnet fallback. They are read in-process and never printed or placed on a
// child command line.
function loadSolanaEndpoints(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const file = options.endpointsPath || SOLANA_RPC_FILE;
  const urls = [];
  try {
    const text = fsImpl.readFileSync(file, "utf8");
    for (const line of String(text).split(/\r?\n/)) {
      const lower = line.toLowerCase();
      if (!lower.includes("http")) continue;
      if (!lower.includes("solana") && !lower.includes("helius")) continue;
      for (const match of line.matchAll(/https?:\/\/[^\s'"<>]+/gu)) urls.push(match[0].replace(/["'`,;]+$/gu, ""));
    }
  } catch (_) { /* absent inventory: fall back to the public endpoint */ }
  urls.push(SOLANA_PUBLIC_FALLBACK);
  return [...new Set(urls)];
}

// One bounded Solana JSON-RPC POST. The URL and raw response stay process-only.
async function solanaRpcCall(url, method, params, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const request = requestAbort(options.timeoutMs ?? SOLANA_TIMEOUT_MS);
  try {
    const headers = { "content-type": "application/json" };
    if (/helius/iu.test(url)) headers.origin = options.origin || "https://helius.xyz";
    const response = await deadline.invoke(() => fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: request.signal,
    }));
    if (!response || response.ok !== true) throw new WatchError("SOLANA_HTTP");
    const body = await deadline.invoke(() => response.json());
    if (body && body.error) throw new WatchError("SOLANA_RPC_ERROR");
    return body ? body.result : null;
  } finally {
    request.close();
  }
}

// Sum every parsed SPL token account for one mint; the parsed tokenAmount carries
// the authoritative raw amount and decimals.
function parseSolanaTokenAmounts(result) {
  if (!result || !Array.isArray(result.value)) return { raw: null, decimals: null };
  const accounts = result.value;
  let raw = 0n;
  let decimals = null;
  for (const account of accounts) {
    const info = account && account.account && account.account.data && account.account.data.parsed
      ? account.account.data.parsed.info : null;
    const tokenAmount = info && info.tokenAmount;
    if (!tokenAmount || typeof tokenAmount.amount !== "string" || !/^[0-9]+$/u.test(tokenAmount.amount)) return { raw: null, decimals: null };
    raw += BigInt(tokenAmount.amount);
    if (!Number.isSafeInteger(tokenAmount.decimals) || tokenAmount.decimals < 0 || tokenAmount.decimals > 36
      || (decimals !== null && decimals !== tokenAmount.decimals)) return { raw: null, decimals: null };
    decimals = tokenAmount.decimals;
  }
  return { raw: raw.toString(), decimals };
}

async function connectSolana(options = {}) {
  if (options.remaining && options.remaining() <= 0) return null;
  const call = options.call;
  if (typeof call !== "function") return null;
  const urls = Array.isArray(options.urls) ? options.urls : loadSolanaEndpoints(options);
  const commitment = options.commitment || SOLANA_COMMITMENT;
  for (const url of urls) {
    if (options.remaining && options.remaining() <= 0) break;
    try {
      await call(url, "getVersion", []);
      const slot = await call(url, "getSlot", [{ commitment }]);
      if ((typeof slot === "number" && Number.isSafeInteger(slot)) || (typeof slot === "string" && /^[0-9]+$/u.test(slot))) {
        return { url, slot: Number(slot) };
      }
    } catch (_) { /* try the next candidate */ }
  }
  return null;
}

function emptySolanaRow(entry, slot, error) {
  return {
    address: entry.address,
    label: entry.label,
    slot: slot === undefined ? null : slot,
    native: null,
    tokens: [],
    stableUsdTotal: null,
    totalUsd: null,
    error,
  };
}

// `call` is injectable for offline tests: `(url, method, params) => result`.
async function collectSolana(options = {}) {
  const entries = options.entries || [];
  const errors = [];
  const rows = [];
  if (entries.length === 0) return { rows, errors };
  const now = options.now || (() => performance.now());
  const deadline = now() + (options.deadlineMs ?? RUN_DEADLINE_MS);
  const remaining = () => deadline - now();
  const call = boundedCall(options.call, remaining);
  const commitment = options.commitment || SOLANA_COMMITMENT;
  const tokenSpecs = options.tokens || SOLANA_SPL_TOKENS;
  const connection = await connectSolana({ ...options, commitment, call, remaining });
  if (!connection) {
    for (const entry of entries) rows.push(emptySolanaRow(entry, null, "SOLANA_RPC_UNAVAILABLE"));
    errors.push({ scope: "solana", message: "SOLANA_RPC_UNAVAILABLE" });
    return { rows, errors };
  }
  const solPrice = options.priceAvailable && options.nativePrices ? options.nativePrices[SOLANA_COINGECKO] : null;
  for (const entry of entries) {
    if (now() >= deadline) {
      rows.push(emptySolanaRow(entry, connection.slot, "SOLANA_DEADLINE_EXCEEDED"));
      errors.push({ scope: "run", message: "DEADLINE_EXCEEDED" });
      continue;
    }
    let nativeRaw = null;
    try {
      const balance = await call(connection.url, "getBalance", [entry.address, { commitment }], SOLANA_TIMEOUT_MS);
      const lamports = balance && typeof balance === "object" && "value" in balance ? balance.value : balance;
      if ((typeof lamports === "number" && Number.isSafeInteger(lamports) && lamports >= 0)
        || (typeof lamports === "string" && /^[0-9]+$/u.test(lamports))) {
        nativeRaw = BigInt(lamports).toString();
      }
    } catch (_) { /* recorded as a read failure below */ }
    const native = nativeRaw === null ? null : {
      symbol: SOLANA_NATIVE_SYMBOL,
      raw: nativeRaw,
      formatted: formatUnits(nativeRaw, SOLANA_NATIVE_DECIMALS),
      usd: solPrice !== null && solPrice !== undefined && Number.isFinite(Number(solPrice)) && Number(solPrice) > 0
        ? nativeUsdFromRaw(nativeRaw, Number(solPrice), SOLANA_NATIVE_DECIMALS)
        : null,
    };
    const tokens = [];
    let rowCents = 0n;
    let tokensComplete = true;
    for (const spec of tokenSpecs) {
      let parsed = null;
      try {
        const result = await call(connection.url, "getTokenAccountsByOwner", [entry.address, { mint: spec.mint }, { encoding: "jsonParsed", commitment }], SOLANA_TIMEOUT_MS);
        parsed = parseSolanaTokenAmounts(result);
      } catch (_) { parsed = null; }
      if (!parsed || parsed.raw === null) {
        tokens.push({ symbol: spec.symbol, mint: spec.mint, decimals: spec.decimals, raw: null, formatted: null, usd: null });
        tokensComplete = false;
        continue;
      }
      const decimals = parsed.decimals === null ? spec.decimals : parsed.decimals;
      const usd = usdFromRaw(parsed.raw, decimals);
      tokens.push({ symbol: spec.symbol, mint: spec.mint, decimals, raw: parsed.raw, formatted: formatUnits(parsed.raw, decimals), usd });
      const cents = centsFromUsd(usd);
      if (cents !== null) rowCents += cents;
    }
    let totalUsd = null;
    if (tokensComplete && native && native.usd !== null) {
      const nativeCents = centsFromUsd(native.usd);
      if (nativeCents !== null) totalUsd = formatCents(nativeCents + rowCents);
    }
    rows.push({
      address: entry.address,
      label: entry.label,
      slot: connection.slot,
      native,
      tokens,
      stableUsdTotal: tokensComplete ? formatCents(rowCents) : null,
      totalUsd,
      error: native === null ? "BALANCE_READ_FAILED" : null,
    });
  }
  return { rows, errors };
}

function computeTotals(chains, unpricedChains, priceAvailable, solana = []) {
  let stableCents = 0n;
  let nativeCents = 0n;
  const rows = [...chains.flatMap(chain => chain.addressRows), ...solana];
  let stableComplete = true;
  let nativeComplete = priceAvailable && rows.length > 0;
  let rowsComplete = rows.length > 0;
  for (const row of rows) {
    const stable = centsFromUsd(row.stableUsdTotal);
    const native = centsFromUsd(row.native?.usd);
    const tokensComplete = Array.isArray(row.tokens) && row.tokens.every(token => token.raw !== null && centsFromUsd(token.usd) !== null);
    if (stable === null || !tokensComplete) stableComplete = false;
    else stableCents += stable;
    if (native === null) nativeComplete = false;
    else nativeCents += native;
    if (row.error || centsFromUsd(row.totalUsd) === null) rowsComplete = false;
  }
  const priceSource = priceAvailable ? "defillama" : "unavailable";
  const complete = rowsComplete && stableComplete && nativeComplete;
  return {
    stableUsd: stableComplete ? formatCents(stableCents) : null,
    nativeUsd: nativeComplete ? formatCents(nativeCents) : null,
    totalUsd: complete ? formatCents(nativeCents + stableCents) : null,
    complete,
    note: STABLE_USD_ASSUMPTION_NOTE,
    unpricedChains: [...new Set(unpricedChains || [])].slice(0, UNPRICED_CHAIN_CAP),
    priceSource,
  };
}

function buildArtifact({ addresses, chains, solana = [], errors, durationMs, unpricedChains, priceAvailable = false, now = Date.now }) {
  const totals = computeTotals(chains, unpricedChains, priceAvailable, solana);
  const covered = addresses.every(entry => entry.family === SOLANA_FAMILY
    ? solana.some(row => row.address === entry.address)
    : chains.length > 0 && chains.every(chain => chain.addressRows.some(row => row.address === entry.address)));
  if (errors.length > 0 || !covered) { totals.complete = false; totals.totalUsd = null; }
  if (!covered || errors.some(error => error.scope === "run" || error.scope.startsWith("chain-"))) {
    totals.stableUsd = null;
    totals.nativeUsd = null;
  }
  return {
    schema: SCHEMA,
    asOf: new Date(now()).toISOString(),
    durationMs,
    watchlistPath: WATCHLIST_REL,
    // `addresses` stays EVM-only so the existing dashboard validator keeps
    // accepting the artifact; Solana rows live under `solana`.
    addresses: addresses.filter((entry) => entry.family !== SOLANA_FAMILY)
      .map((entry) => ({ label: entry.label, address: entry.address })),
    solana,
    chains,
    totals,
    errors,
  };
}

async function runOnce(options = {}) {
  const clock = options.monotonicNow || (() => performance.now());
  const budget = Math.min(options.deadlineMs ?? RUN_DEADLINE_MS, RUN_DEADLINE_MS);
  if (!(budget > 0) || !Number.isFinite(budget)) throw new WatchError("TIMEOUT");
  return deadline.run(() => runOnceWork({ ...options, monotonicNow: clock }), budget,
    { clock, drainGraceMs: options.drainGraceMs ?? 1000 });
}

async function runOnceWork(options) {
  const fsImpl = options.fsImpl || fs;
  const now = options.now || Date.now;
  const clock = options.monotonicNow;
  const started = clock();
  const remaining = () => deadline.current().remainingMs();
  const watchlistPath = options.watchlistPath || WATCHLIST_PATH;
  const outPath = options.outPath || OUT_PATH;
  const loaded = options.watchlist ? validateWatchlist(options.watchlist) : loadWatchlist(watchlistPath, fsImpl);
  const errors = [...loaded.errors];
  const addresses = loaded.addresses;
  const evmAddresses = addresses.filter((entry) => entry.family !== SOLANA_FAMILY);
  const solanaEntries = addresses.filter((entry) => entry.family === SOLANA_FAMILY);
  deadline.check();
  let chainEndpoints = options.chainEndpoints;
  if (!chainEndpoints) chainEndpoints = evmAddresses.length ? await enumerateChains({
    call: options.call, now: clock, chainIds: options.chainIds, deadlineMs: remaining(),
    urls: options.urls, fallbacks: options.fallbacks,
  }) : new Map();
  deadline.check();
  const expectedIds = options.chainIds || (options.chainEndpoints ? [...chainEndpoints.keys()] : BOUNDED_CHAIN_IDS);
  if (evmAddresses.length) for (const chainId of expectedIds) {
    if (!chainEndpoints.has(chainId)) errors.push({ scope: `chain-${chainId}`, message: "NO_ENDPOINT" });
  }
  const resolvedIds = [...(chainEndpoints || new Map()).keys()];
  const coingeckoIds = resolvedIds.map((chainId) => nativeCoingecko(chainId)).filter(Boolean);
  if (solanaEntries.length > 0) coingeckoIds.push(SOLANA_COINGECKO);
  let priceResult;
  if (options.nativePrices !== undefined) priceResult = { ok: true, prices: options.nativePrices };
  else if (typeof options.priceFetcher === "function") priceResult = await deadline.invoke(() => options.priceFetcher(coingeckoIds,
    { signal: deadline.current().signal, timeoutMs: remaining() }));
  else priceResult = await fetchNativePrices(coingeckoIds, { fetchImpl: options.fetchImpl, timeoutMs: options.priceTimeoutMs });
  deadline.check();
  const priceAvailable = priceResult && priceResult.ok === true;
  const nativePrices = priceAvailable && priceResult.prices ? priceResult.prices : {};
  const collected = await collect({
    addresses: evmAddresses, chainEndpoints: chainEndpoints || new Map(), call: options.call || rpcCall, now: clock,
    stablecoins: options.stablecoins, nativePrices, priceAvailable, deadlineMs: remaining(),
  });
  deadline.check();
  const solanaCall = options.solanaCall
    || ((url, method, params, timeoutMs) => solanaRpcCall(url, method, params, {
      fetchImpl: options.solanaFetchImpl, timeoutMs: Math.min(timeoutMs, options.solanaTimeoutMs ?? SOLANA_TIMEOUT_MS), origin: options.solanaOrigin,
    }));
  const solanaCollected = await collectSolana({
    entries: solanaEntries,
    urls: options.solanaUrls,
    endpointsPath: options.solanaEndpointsPath,
    tokens: options.solanaTokens,
    commitment: options.solanaCommitment,
    call: solanaCall,
    fsImpl,
    now: clock,
    deadlineMs: remaining(),
    priceAvailable,
    nativePrices,
  });
  deadline.check();
  const artifact = buildArtifact({
    addresses,
    chains: collected.chains,
    solana: solanaCollected.rows,
    errors: [...errors, ...collected.errors, ...solanaCollected.errors],
    durationMs: Math.max(0, Math.round(clock() - started)),
    unpricedChains: collected.unpricedChains,
    priceAvailable,
    now,
  });
  return { artifact, outPath, resolvedChainCount: chainEndpoints ? chainEndpoints.size : 0, solanaAddressCount: solanaEntries.length };
}

function writeArtifact(artifact, outPath, fsImpl = fs, owner) {
  assertWalletBalanceOutputOwner(owner, outPath);
  const temporary = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    assertWalletBalanceOutputOwner(owner, outPath);
    fsImpl.renameSync(temporary, outPath);
  } finally {
    try {
      assertWalletBalanceOutputOwner(owner, outPath);
      if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
    } catch (_) { /* Lost directory identity: do not clean a replacement's files. */ }
  }
  return outPath;
}

async function collectAndWrite(options = {}) {
  const clock = options.monotonicNow || (() => performance.now());
  const entered = options.enteredAt ?? clock();
  const budget = Math.min(options.deadlineMs ?? RUN_DEADLINE_MS, RUN_DEADLINE_MS);
  const outPath = options.outPath || OUT_PATH;
  const owner = acquireWalletBalanceOutputOwner(outPath);
  let drained = true;
  try {
    const result = await runOnce({ ...options, monotonicNow: clock, deadlineMs: budget - (clock() - entered), outPath });
    writeArtifact(result.artifact, outPath, options.fsImpl || fs, owner);
    return result;
  } catch (error) {
    // Never release to a second writer while ignored/late work remains alive.
    if (error.code === "DRAIN_UNCONFIRMED") drained = false;
    throw error;
  } finally {
    if (drained) owner.release();
  }
}

const EXIT_CODES = Object.freeze({ OUTPUT_BUSY: 2, TIMEOUT: 3, OUTPUT_OWNERSHIP_LOST: 4, DRAIN_UNCONFIRMED: 5 });
function cliFailure(error) {
  const code = error && (Object.hasOwn(EXIT_CODES, error.code) || ["USAGE", "OUTPUT_LOCK_FAILED"].includes(error.code))
    ? error.code : "COLLECT_FAILED";
  return { code, exitCode: EXIT_CODES[code] || 1 };
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((value) => value.startsWith("--")));
  const unknown = [...flags].filter((value) => !["--once", "--check"].includes(value));
  if (unknown.length || (flags.has("--once") && flags.has("--check"))) throw new WatchError("USAGE");
  return { check: flags.has("--check"), once: !flags.has("--check") };
}

async function main(argv = process.argv.slice(2)) {
  const enteredAt = performance.now();
  const options = parseArgs(argv);
  if (options.check) {
    const loaded = loadWatchlist();
    process.stdout.write(`${JSON.stringify({
      status: "CHECK_OK", schema: SCHEMA, watchlistPath: WATCHLIST_REL,
      addresses: loaded.addresses.filter((entry) => entry.family !== SOLANA_FAMILY).length,
      solanaAddresses: loaded.addresses.filter((entry) => entry.family === SOLANA_FAMILY).length,
      watchlistErrors: loaded.errors.length,
      chainsPlanned: BOUNDED_CHAIN_IDS.length, wrote: false,
    })}\n`);
    return;
  }
  const { artifact, resolvedChainCount } = await collectAndWrite({ enteredAt });
  process.stdout.write(`${JSON.stringify({
    status: artifact.totals.complete ? "OK" : "INCOMPLETE", schema: artifact.schema, artifact: OUT_REL, asOf: artifact.asOf,
    durationMs: artifact.durationMs, addresses: artifact.addresses.length,
    solanaAddresses: artifact.solana.length,
    chainsResolved: resolvedChainCount, chainsWithRows: artifact.chains.length,
    addressRows: artifact.chains.reduce((n, chain) => n + chain.addressRows.length, 0),
    stableUsd: artifact.totals.stableUsd,
    nativeUsd: artifact.totals.nativeUsd,
    totalUsd: artifact.totals.totalUsd,
    priceSource: artifact.totals.priceSource,
    errors: artifact.errors.length,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const failure = cliFailure(error);
    process.stderr.write(`watch-wallet-balances failed: ${failure.code}\n`);
    process.exitCode = failure.exitCode;
  });
}

module.exports = {
  WORKSPACE, WATCHLIST_PATH, OUT_PATH, WATCHLIST_REL, OUT_REL, SCHEMA, WATCHLIST_SCHEMA,
  ADDRESS_RE, EVM_FAMILY, SOLANA_FAMILY, FAMILIES, BASE58_ALPHABET, SOLANA_ADDRESS_RE,
  SOLANA_NATIVE_SYMBOL, SOLANA_NATIVE_DECIMALS, SOLANA_COINGECKO, SOLANA_RPC_FILE,
  SOLANA_PUBLIC_FALLBACK, SOLANA_TIMEOUT_MS, SOLANA_COMMITMENT, SOLANA_SPL_TOKENS,
  BOUNDED_CHAIN_IDS, CHAIN_NAMES, CHAIN_NATIVE, STABLECOINS, UNBOUND_STABLECOIN_CHAINS,
  NATIVE_COINGECKO, TOKEN_SELECTOR, STABLE_USD_ASSUMPTION_NOTE, CHAIN_TIMEOUT_MS, READ_CONCURRENCY,
  RUN_DEADLINE_MS, UNPRICED_CHAIN_CAP, PRICE_TIMEOUT_MS,
  WatchError, relPosix, chainName, nativeSymbol, nativeCoingecko, hexBlock, mapPool, formatNative, formatUnits,
  centsFromRaw, usdFromRaw, formatCents, centsFromUsd, asciiFromHex, decodeSymbol, decodeDecimals,
  encodeBalanceOf, nativeUsdFromRaw, fetchNativePrices, sanitizeMessage,
  base58Decode, normalizeAddress, normalizeSolanaAddress, familyOf, validateWatchlist, loadWatchlist,
  enumerateChains, readTokenMeta, collect, loadSolanaEndpoints, solanaRpcCall, parseSolanaTokenAmounts,
  connectSolana, collectSolana,
  computeTotals, buildArtifact, runOnce, writeArtifact, collectAndWrite, cliFailure, EXIT_CODES, parseArgs, main,
};
