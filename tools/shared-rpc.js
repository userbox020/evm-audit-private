// shared-rpc.js — Centralized RPC resolution for all scanner tools
// Source: rpc_endpoints.txt with origin-aware calling and annotation filtering.
const fs = require("fs");
const path = require("path");
const deadline = require("./lib/producer-deadline");
const {
  providerCapabilityRank,
  providerFamily,
  rankProviderUrls,
  boundedFamilyCandidates,
  MAX_ENDPOINTS_PER_FAMILY,
  isTransportFailure,
} = require("./lib/rpc-provider-reliability");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const MAX_INVENTORY_BYTES = 1024 * 1024;
const MAX_RPC_CANDIDATES = 128;
const MAX_QUALIFICATION_CONCURRENCY = 4;
const QUALIFICATION_TIMEOUT_MS = 4000;
const READ_PROBE_ADDRESS = "0x0000000000000000000000000000000000000000";
const READ_PROBE_SLOT = "0x" + "0".repeat(64);
const DYNAMIC_ORIGINS = new Map();
const LINE_CHAIN_HINTS = new Map();
const URL_TO_CHAIN = new Map();
const QUALIFIED_FALLBACK_POOLS = new Map();

const RPC_ORIGINS = [
  { urlMatch: "nodereal.io", origin: "https://pancakeswap.finance" },
  { urlMatch: "app.aave.com/api/rpc-proxy", origin: "https://app.aave.com" },
  { urlMatch: "app.morpho.org/api/rpc", origin: "https://app.morpho.org" },
  { urlMatch: "proxy.sky.money", origin: "https://app.sky.money" },
  { urlMatch: "gateway.tenderly.co", origin: "https://app.sky.money" },
];

const rpcCapabilityRank = providerCapabilityRank;

const ANNOTATION_DOMAINS = [
  "pancakeswap.finance", "app.aave.com", "app.morpho.org",
  "raydium.io", "jup.ag", "pump.fun", "coinfactory.app",
  "www.oriontools.io", "yo.xyz", "app.sky.money",
];

const PUBLIC_FALLBACKS = {
  1: "https://ethereum.publicnode.com", 10: "https://optimism.publicnode.com",
  56: "https://bsc.publicnode.com", 100: "https://gnosis.publicnode.com",
  130: "https://unichain-rpc.publicnode.com", 137: "https://polygon-bor.publicnode.com",
  146: "https://sonic-rpc.publicnode.com", 250: "https://fantom-rpc.publicnode.com",
  324: "https://zksync-era-rpc.publicnode.com", 1135: "https://rpc.api.lisk.com",
  1868: "https://rpc.soneium.org", 34443: "https://mainnet.mode.network",
  480: "https://world-chain-rpc.publicnode.com", 8453: "https://base.publicnode.com",
  42161: "https://arbitrum-one.publicnode.com", 42220: "https://celo.publicnode.com",
  43114: "https://avalanche.publicnode.com", 5000: "https://mantle.publicnode.com",
  534352: "https://scroll.publicnode.com", 59144: "https://linea.publicnode.com",
  57073: "https://ink-rpc.publicnode.com", 81457: "https://blast.publicnode.com",
  999: "https://hyperliquid.drpc.org",
  4663: "https://rpc.mainnet.chain.robinhood.com",
  46630: "https://rpc.testnet.chain.robinhood.com",
};

// Private process-only metadata key, matching callers that use new URL(...).href.
// Returned inventory handles remain unchanged; this is never host-wide matching.
function inventoryUrlKey(value) {
  try { return new URL(value).href; } catch (_) { return value; }
}

function getOrigin(url) {
  const key = inventoryUrlKey(url);
  if (typeof url === "string" && DYNAMIC_ORIGINS.has(key)) return DYNAMIC_ORIGINS.get(key);
  for (const e of RPC_ORIGINS) { if (url.includes(e.urlMatch)) return e.origin; }
  return null;
}

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function sanitizeError(_error, fallback = "operation-failed") {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(fallback) ? fallback : "operation-failed";
}

// Candidate-pool family key. Reviewed provider families reuse the shared
// registry; every other host is treated as its own family so that no single
// operator can monopolise the candidate cap. Host identity stays process-only.
function inventoryFamily(value) {
  const known = providerFamily(value);
  if (known) return known;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    return host ? `host:${host}` : null;
  } catch (_) {
    return null;
  }
}

function optimismHostnameHint(value) {
  try {
    return new URL(value).hostname.toLowerCase().split(".")
      .some((label) => /^(?:optimism|optimistic|optimism-mainnet|op-mainnet|opt-mainnet)$/.test(label));
  } catch (_) {
    return false;
  }
}

// Selection hint only: callers must still qualify eth_chainId before any reads.
function ethereumInventoryHint(value) {
  const key = inventoryUrlKey(value);
  if (LINE_CHAIN_HINTS.has(key)) return LINE_CHAIN_HINTS.get(key) === 1;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host.split(".").some(label => /^(?:eth|ethereum|eth-mainnet|ethereum-mainnet|ethereum-rpc)$/.test(label))) return true;
    if (host === "mainnet.infura.io") return true;
    return ["rpc.ankr.com", "1rpc.io", "0xrpc.io"].includes(host)
      && /^\/(?:eth|ethereum)(?:\/|$)/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

// Selection hint only; never a substitute for eth_chainId qualification.
function baseInventoryHint(value) {
  const key = inventoryUrlKey(value);
  if (LINE_CHAIN_HINTS.has(key)) return LINE_CHAIN_HINTS.get(key) === 8453;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host.split(".").some(label => /^(?:base|base-mainnet|base-rpc)$/.test(label))) return true;
    return ["rpc.ankr.com", "1rpc.io", "0xrpc.io"].includes(host)
      && /^\/base(?:\/|$)/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function arbitrumInventoryHint(value) {
  const key = inventoryUrlKey(value);
  if (LINE_CHAIN_HINTS.has(key)) return LINE_CHAIN_HINTS.get(key) === 42161;
  return /\b(?:arb|arbitrum|arbitrum-one|arb-mainnet)\b/i.test(value);
}

function inventoryTransports(options) {
  if (options.transports === undefined) return ["http:", "https:"];
  const values = options.transports;
  return Array.isArray(values) && values.length > 0 &&
    Array.from(values).every(value => ["http:", "https:", "ws:", "wss:"].includes(value)) ? values : null;
}

// Endpoint URLs precede annotations. Cut at even a malformed directive so its
// application URL can never be mistaken for a second RPC endpoint. Requiring a
// label boundary leaves URL path/query credentials such as ?origin=... intact.
function inventoryOrigin(line, allowBareHost = false) {
  const markers = [...line.matchAll(/(?:^|[\s([|])(app\/origin|origin|app)\b(?=\s|:|$)/gi)];
  if (!markers.length) return { endpoints: line, origin: null, invalid: false };
  // App is descriptive fallback metadata, not a competing Origin requirement.
  const explicit = markers.filter(marker => marker[1].toLowerCase() !== "app");
  let origin = null, invalid = false;
  for (const marker of explicit.length ? explicit : markers) {
    const value = line.slice(marker.index + marker[0].length).match(/^\s*:\s*([^\s'"<>|)\]]+)/)?.[1];
    try {
      const raw = allowBareHost && /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?$/i.test(value || "") ? `https://${value}` : value;
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) { invalid = true; continue; }
      if (origin && origin !== url.origin) invalid = true;
      origin = url.origin;
    } catch (_) { invalid = true; }
  }
  return { endpoints: line.slice(0, markers[0].index), origin, invalid };
}

// Shared pre-cap parsing. headTags is private to buildHeadCandidates: it uses
// full URL tokens for marker detection/preservation, without changing defaults.
function inventoryCandidates(text, options = {}, headTags = null) {
  const maxBytes = boundedInteger(options.maxBytes, MAX_INVENTORY_BYTES, MAX_INVENTORY_BYTES);
  const transports = inventoryTransports(options);
  if (!transports || typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) return [];
  const lines = text.split(/\r?\n/);
  const rows = [], metadata = new Map();
  let sectionOrigin = null, sectionInvalid = false;
  for (const l of lines) {
    if (/^\s*(?:---|===)/.test(l)) {
      const annotation = inventoryOrigin(l, true);
      sectionOrigin = annotation.origin; sectionInvalid = annotation.invalid;
      continue;
    }
    const annotation = inventoryOrigin(l);
    const tokenPattern = headTags ? /(?:https?|wss?):\/\/[^\s'"<>|]+/gi : /(?:https?|wss?):\/\/[^\s'"<>\[\]|]+/gi;
    const matches = [...annotation.endpoints.matchAll(tokenPattern)];
    if (!matches.length) continue;
    if (headTags) {
      // Standalone, same-line tag, outside URLs and before Origin/App metadata.
      // No section inheritance; only the first explicit HTTP endpoint is tagged.
      const outsideUrls = annotation.endpoints.replace(tokenPattern, token => "x".repeat(token.length));
      const firstHttp = matches.find(match => /^https?:/i.test(match[0]));
      if (firstHttp && /(?:^|\s)\[WS\](?=\s|$)/i.test(outsideUrls)) headTags.add(inventoryUrlKey(firstHttp[0]));
    }
    const rawPrefix = annotation.endpoints.slice(0, matches[0].index);
    const prefix = (headTags ? rawPrefix.replace(/(?:^|\s)\[WS\](?=\s|$)/gi, " ") : rawPrefix).trim().toLowerCase();
    let hint = null, defaultHttpSeen = false;
    if (/^eth(?:ereum)?(?:\b|\s|$)/.test(prefix) && !/classic|sepolia|holesky|hoodi/.test(prefix)) hint = 1;
    else if (/^base(?:\b|\s|$)/.test(prefix) && !/sepolia/.test(prefix)) hint = 8453;
    else if (/^arb(?:itrum)?(?:\b|\s|$)/.test(prefix) && !/nova|sepolia/.test(prefix)) hint = 42161;
    else if (/^(?:polygon|avalanche|gnosis|unichain|worldchain|zksync|scroll|linea|blast|mantle|celo|berachain|sonic|ink|mode|lisk|soneium|superseed|metal|swell|fraxtal|bob|optimism|bsc|hyperliquid|fantom|cronos|rootstock|flare|taiko|sei|metis|core|manta|kava|zora|apechain|ronin|plume|katana|monad|tempo)\b/.test(prefix)) hint = -1;
    for (const match of matches) {
      const u = headTags ? match[0] : match[0].replace(/[)\]]+\s*$/, "");
      const isHttp = /^https?:/i.test(u);
      // Preserve the legacy first-HTTP-URL-per-line default. Explicit transport
      // selection can inspect every explicitly listed matching endpoint.
      const defaultEligible = isHttp && !defaultHttpSeen;
      if (isHttp) defaultHttpSeen = true;
      let url;
      try { url = new URL(u); } catch (_) { continue; }
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      if (!host) continue;
      const origin = annotation.origin || sectionOrigin;
      const invalid = annotation.invalid || (!annotation.origin && sectionInvalid);
      const entry = metadata.get(url.href) || { origin: null, invalid: false, hint: null };
      if (invalid || (origin && entry.origin && origin !== entry.origin)) entry.invalid = true;
      if (origin) entry.origin = origin;
      if (hint !== null) entry.hint = hint;
      metadata.set(url.href, entry);
      if (!transports.includes(url.protocol) || (options.transports === undefined && !defaultEligible)) continue;
      const isOriginProxy = RPC_ORIGINS.some(e => u.includes(e.urlMatch));
      if (!isOriginProxy && ANNOTATION_DOMAINS.some(d => host === d || host.endsWith("." + d))) continue;
      if (/solana|sui|aptos|stellar|tron|helius|rpcpool|oriontools|testnet|hoodi|sepolia|tatum/i.test(host)) continue;
      rows.push(u);
    }
  }
  // Refresh only endpoints encountered in this input, including nonselected
  // transports. Never clear other inventories' unrelated endpoint metadata.
  // Resolve duplicate conflicts before caller filters (which may deduplicate).
  for (const [url, entry] of metadata) {
    DYNAMIC_ORIGINS.delete(url); LINE_CHAIN_HINTS.delete(url);
    if (!entry.invalid && entry.origin) DYNAMIC_ORIGINS.set(url, entry.origin);
    if (!entry.invalid && entry.hint !== null) LINE_CHAIN_HINTS.set(url, entry.hint);
  }
  const urls = [];
  for (const u of rows) {
    if (metadata.get(inventoryUrlKey(u)).invalid) continue;
    // Opt-in caller scope must be applied before ranking and all candidate caps.
    if (typeof options.candidateFilter === "function" && !options.candidateFilter(u)) continue;
    urls.push(u);
  }
  return urls;
}

function parseRpcInventory(text, options = {}) {
  const maxCandidates = boundedInteger(options.maxCandidates, MAX_RPC_CANDIDATES, MAX_RPC_CANDIDATES);
  const urls = inventoryCandidates(text, options);
  if (urls.length === 0) return [];
  // Preserve capability ranking order, then keep at most MAX_ENDPOINTS_PER_FAMILY
  // per provider family before applying the candidate cap. This stops keyed
  // rank-0/1 families from evicting keyless rank-2 public providers.
  // Stable hint priority within each capability tier keeps a preferred-chain row even
  // when a family's other-chain rows would otherwise consume its two slots.
  const preferredHint = options.preferredChainId === 1 ? ethereumInventoryHint
    : options.preferredChainId === 8453 ? baseInventoryHint
    : options.preferredChainId === 42161 ? arbitrumInventoryHint : null;
  if (preferredHint) urls.sort((a, b) => Number(preferredHint(b)) - Number(preferredHint(a)));
  const ranked = rankProviderUrls(urls, urls.length);
  const capped = boundedFamilyCandidates(ranked, {
    maximumFamilies: ranked.length,
    maximumCandidates: maxCandidates,
    familyOf: inventoryFamily,
  });
  if (preferredHint) return capped;
  // Prefer chain-hint coverage by replacing only a family's second kept row.
  // Counts, family membership and all other retained row positions stay unchanged.
  const keptByFamily = new Map();
  const taken = new Set(capped);
  for (let index = 0; index < capped.length; index += 1) {
    const family = inventoryFamily(capped[index]);
    if (!keptByFamily.has(family)) keptByFamily.set(family, []);
    keptByFamily.get(family).push(index);
  }
  for (const [family, positions] of keptByFamily) {
    if (positions.length < 2 || positions.some((index) => optimismHostnameHint(capped[index]))) continue;
    const replacement = ranked.find((value) => !taken.has(value)
      && inventoryFamily(value) === family && optimismHostnameHint(value));
    if (replacement === undefined) continue;
    const previous = capped[positions[1]];
    capped[positions[1]] = replacement;
    if (!capped.includes(previous)) taken.delete(previous);
    taken.add(replacement);
  }
  return capped;
}

function readBoundedTextFile(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return null;
    return buffer.toString("utf8", 0, bytesRead);
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function loadRpcUrls(options = {}) {
  if (!inventoryTransports(options)) return [];
  const maxBytes = boundedInteger(options.maxBytes, MAX_INVENTORY_BYTES, MAX_INVENTORY_BYTES);
  const text = readBoundedTextFile(options.file || RPC_FILE, maxBytes);
  return text === null ? [] : parseRpcInventory(text, { ...options, maxBytes });
}

const MAX_HEAD_CANDIDATES = 32;
// Ranking only: these are the existing reviewed Ethereum connector mappings.
// They never add fallback candidates, change handles, or assert WS support.
const HEAD_PUBLIC_HTTPS = new Set([
  "https://ethereum.publicnode.com/", "https://ethereum-rpc.publicnode.com/", "https://eth.drpc.org/"
]);
function headProcessOnly(value) {
  const redacted = () => "[m1-head-inventory:process-only]";
  Object.defineProperties(value, {
    toJSON: { value() { const error = new Error("M1_HEAD_INVENTORY_PROCESS_ONLY"); error.code = error.message; throw error; } },
    toString: { value: redacted },
    [Symbol.toPrimitive]: { value: redacted },
    [Symbol.for("nodejs.util.inspect.custom")]: { value: redacted }
  });
  return Object.freeze(value);
}

// No IO. All URI keys, Origin metadata and provider-family bookkeeping stay
// process-only. Chain hints are ordering hints, never chain/capability proof.
function buildHeadCandidates(text, options = {}) {
  const maxCandidates = boundedInteger(options.maxCandidates, MAX_HEAD_CANDIDATES, MAX_HEAD_CANDIDATES);
  const tagged = new Set(), seen = new Set();
  const urls = inventoryCandidates(text, { maxBytes: options.maxBytes, transports: ["https:", "wss:"],
    candidateFilter(value) {
      try {
        const url = new URL(value);
        if (url.username || url.password || value.includes("#") || /^(?:https|wss):\/\/[^/?#]*@/i.test(value)) return false;
        return typeof options.candidateFilter !== "function" || options.candidateFilter(value);
      } catch (_) { return false; }
    }
  }, tagged);
  const ranked = [];
  for (const handle of urls) {
    const key = inventoryUrlKey(handle);
    if (seen.has(key)) continue;
    seen.add(key);
    const chainHint = LINE_CHAIN_HINTS.get(key) ?? (ethereumInventoryHint(handle) ? 1 : baseInventoryHint(handle) ? 8453 : null);
    const kind = new URL(handle).protocol === "wss:" ? "WSS" : tagged.has(key) ? "HTTPS_WS" : "HTTPS";
    const publicMapping = /^https:\/\/[^/?#:@]+\/?$/i.test(handle) && HEAD_PUBLIC_HTTPS.has(key);
    ranked.push({ record: { kind, handle, origin: getOrigin(handle), chainHint, family: providerFamily(handle) },
      chainRank: chainHint === 1 ? 0 : chainHint === null ? 1 : 2,
      publicRank: publicMapping ? 0 : 1, advertisedRank: kind === "HTTPS" ? 1 : 0,
      providerRank: providerCapabilityRank(handle), order: ranked.length });
  }
  // Rank the complete byte-bounded input BEFORE the new API's family/global
  // caps. Within chain/public priority, advertised WS outranks unmarked HTTPS.
  ranked.sort((a, b) => a.chainRank - b.chainRank || a.publicRank - b.publicRank ||
    a.advertisedRank - b.advertisedRank || a.providerRank - b.providerRank || a.order - b.order);
  const counts = new Map(), result = [];
  for (const { record } of ranked) {
    const family = inventoryFamily(record.handle), count = counts.get(family) || 0;
    if (count >= MAX_ENDPOINTS_PER_FAMILY) continue;
    counts.set(family, count + 1); result.push(headProcessOnly(record));
    if (result.length === maxCandidates) break;
  }
  return headProcessOnly(result);
}

function loadHeadCandidates(options = {}) {
  const maxBytes = boundedInteger(options.maxBytes, MAX_INVENTORY_BYTES, MAX_INVENTORY_BYTES);
  const text = readBoundedTextFile(options.file || RPC_FILE, maxBytes);
  return buildHeadCandidates(text, { ...options, maxBytes });
}

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function getImpl(rpc, proxyAddr, ms = 8000) {
  const raw = await rpcCall(rpc, "eth_getStorageAt", [proxyAddr, EIP1967_IMPL, "latest"], ms);
  if (!raw || raw === "0x" + "0".repeat(64)) return null;
  return "0x" + raw.slice(26);
}

class RpcTransportError extends Error {
  constructor() {
    super("RPC_TRANSPORT");
    this.name = "RpcTransportError";
    this.code = "RPC_TRANSPORT";
  }
}

async function rpcCallStrict(url, method, params, ms = 8000, options = {}) {
  deadline.check();
  const scope = deadline.current();
  const timeoutMs = Math.min(boundedInteger(ms, 8000, 60_000), scope ? scope.remainingMs() : Infinity);
  const ctrl = new AbortController();
  const signals = [...new Set([options.signal, scope?.signal].filter(Boolean))];
  let t;
  const abort = () => { clearTimeout(t); ctrl.abort(); };
  for (const signal of signals) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  t = setTimeout(abort, timeoutMs);
  const headers = { "content-type": "application/json" };
  const orig = getOrigin(url); if (orig) headers["origin"] = orig;
  try {
    if (ctrl.signal.aborted) { deadline.check(); throw new RpcTransportError(); }
    const r = await deadline.invoke(() => fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal }));
    if (ctrl.signal.aborted) { deadline.check(); throw new RpcTransportError(); }
    let j;
    try { j = await deadline.invoke(() => r.json()); } catch (_) { deadline.check(); return null; }
    if (ctrl.signal.aborted) { deadline.check(); throw new RpcTransportError(); }
    if (!r.ok || !j || typeof j !== "object" || Array.isArray(j) || j.jsonrpc !== "2.0"
        || j.id !== 1 || Object.hasOwn(j, "error") === Object.hasOwn(j, "result")) return null;
    if (j.error) return null;
    return j.result ?? null;
  } catch (error) {
    deadline.check();
    if (ctrl.signal.aborted) throw new RpcTransportError();
    if (!isTransportFailure(error)) return null;
    throw new RpcTransportError();
  } finally {
    clearTimeout(t);
    for (const signal of signals) signal.removeEventListener("abort", abort);
  }
}

// Opt-in eth_call classification; all non-proven outcomes are opaque to callers.
async function rpcEthCallOutcome(url, params, ms = 8000) {
  const timeoutMs = boundedInteger(ms, 8000, 60_000);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  const orig = getOrigin(url); if (orig) headers["origin"] = orig;
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params }), signal: ctrl.signal });
    if (!r.ok) return { kind: "unknown" };
    const j = await r.json();
    if (!j || typeof j !== "object" || Array.isArray(j) || j.jsonrpc !== "2.0"
        || j.id !== 1 || Object.hasOwn(j, "error") === Object.hasOwn(j, "result")) return { kind: "unknown" };
    if (Object.hasOwn(j, "error")) {
      // Only the explicit EVM execution-revert error shape is a negative result.
      return j.error && typeof j.error === "object" && !Array.isArray(j.error)
        && j.error.code === 3 && j.error.message === "execution reverted"
        ? { kind: "revert" } : { kind: "unknown" };
    }
    return typeof j.result === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(j.result)
      ? { kind: "success", result: j.result } : { kind: "unknown" };
  } catch (_) { return { kind: "unknown" }; }
  finally { clearTimeout(t); }
}

async function rpcCall(url, method, params, ms = 8000, options = {}) {
  try {
    const result = await rpcCallStrict(url, method, params, ms, options);
    if (result !== null) return result;
  } catch (_) { deadline.check(); }
  if (!deadline.current() && !options.noFallback) {
    const cid = URL_TO_CHAIN.get(url);
    const pool = cid ? QUALIFIED_FALLBACK_POOLS.get(cid) : null;
    let attempts = 0;
    for (const fallback of pool || []) {
      if (fallback === url || URL_TO_CHAIN.get(fallback) !== cid) continue;
      if (attempts++ >= 2) break;
      try {
        const result = await rpcCallStrict(fallback, method, params, ms, options);
        if (result !== null) return result;
      } catch (_) { deadline.check(); }
    }
  }
  return null;
}

function boundedPool(urls, maxCandidates) {
  if (!Array.isArray(urls)) return [];
  return rankProviderUrls(urls.filter(url => typeof url === "string" && /^https?:\/\//i.test(url)), maxCandidates);
}

async function callWithDeadline(call, url, method, params, timeoutMs) {
  deadline.check();
  let timer;
  const scope = deadline.current();
  const controller = new AbortController();
  const abort = () => controller.abort();
  scope?.signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await Promise.race([
      // Qualification must establish this endpoint's capabilities, never a fallback's.
      Promise.resolve().then(() => deadline.invoke(() => call(url, method, params, timeoutMs, { signal: controller.signal, noFallback: true })))
        .catch(() => { deadline.check(); return null; }),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, Math.min(timeoutMs, scope ? scope.remainingMs() : Infinity)); }),
    ]);
    deadline.check();
    return result;
  } finally {
    clearTimeout(timer);
    scope?.signal.removeEventListener("abort", abort);
  }
}

function parseChainId(value) {
  try {
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
    const parsed = Number(BigInt(value));
    return Number.isSafeInteger(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function qualifyRpc(url, chainId, options) {
  deadline.check();
  const call = options.rpcCall || rpcCall;
  const timeoutMs = options.timeoutMs;
  const id = await callWithDeadline(call, url, "eth_chainId", [], timeoutMs);
  if (parseChainId(id) !== chainId) return false;

  const block = await callWithDeadline(call, url, "eth_blockNumber", [], timeoutMs);
  if (typeof block !== "string" || !/^0x[0-9a-f]+$/i.test(block)) return false;
  if (options.capability === "read") {
    const callResult = await callWithDeadline(call, url, "eth_call", [{ to: READ_PROBE_ADDRESS, data: "0x" }, block], timeoutMs);
    if (typeof callResult !== "string" || !/^0x[0-9a-f]*$/i.test(callResult)) return false;
    const code = await callWithDeadline(call, url, "eth_getCode", [READ_PROBE_ADDRESS, block], timeoutMs);
    if (typeof code !== "string" || !/^0x[0-9a-f]*$/i.test(code)) return false;
    const storage = await callWithDeadline(call, url, "eth_getStorageAt", [READ_PROBE_ADDRESS, READ_PROBE_SLOT, block], timeoutMs);
    return typeof storage === "string" && /^0x[0-9a-f]{64}$/i.test(storage);
  }
  if (options.capability !== "logs") return false;

  const logs = await callWithDeadline(call, url, "eth_getLogs", [{
    address: "0x0000000000000000000000000000000000000000",
    topics: ["0x" + "0".repeat(64)],
    fromBlock: block,
    toBlock: block,
  }], timeoutMs);
  return Array.isArray(logs);
}

async function firstQualified(entries, chainId, options) {
  const concurrency = options.concurrency;
  for (let start = 0; start < entries.length; start += concurrency) {
    deadline.check();
    const batch = entries.slice(start, start + concurrency);
    const qualified = await deadline.join(batch.map(entry => qualifyRpc(entry.url, chainId, options)));
    if (options.rpcCall === rpcCall) {
      const pool = QUALIFIED_FALLBACK_POOLS.get(chainId) || new Set();
      for (let i = 0; i < batch.length; i += 1) {
        if (qualified[i] !== true) continue;
        pool.add(batch[i].url);
        URL_TO_CHAIN.set(batch[i].url, chainId);
      }
      if (pool.size) QUALIFIED_FALLBACK_POOLS.set(chainId, pool);
    }
    const first = qualified.findIndex(Boolean);
    if (first !== -1) return batch[first].url;
  }
  return null;
}

function resolverOptions(options = {}) {
  return {
    capability: options.capability === "logs" ? "logs" : "read",
    concurrency: boundedInteger(options.concurrency, MAX_QUALIFICATION_CONCURRENCY, MAX_QUALIFICATION_CONCURRENCY),
    maxCandidates: boundedInteger(options.maxCandidates, MAX_RPC_CANDIDATES, MAX_RPC_CANDIDATES),
    timeoutMs: boundedInteger(options.timeoutMs, QUALIFICATION_TIMEOUT_MS, 30_000),
    rpcCall: typeof options.rpcCall === "function" ? options.rpcCall : rpcCall,
    publicFallbacks: options.publicFallbacks || PUBLIC_FALLBACKS,
  };
}

async function resolveRpc(chainId, urls = null, options = {}) {
  deadline.check();
  const settings = resolverOptions(options);
  const inventory = urls === null ? loadRpcUrls({ maxCandidates: settings.maxCandidates, preferredChainId: chainId }) : urls;
  const pool = boundedPool(inventory, settings.maxCandidates);
  deadline.check();
  const sorted = pool
    .map((url, order) => ({ url, order, rank: rpcCapabilityRank(url) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order);

  for (const rank of [...new Set(sorted.map(entry => entry.rank))]) {
    deadline.check();
    const selected = await firstQualified(sorted.filter(entry => entry.rank === rank), chainId, settings);
    if (selected) {
      if (options.rpcCall === undefined) {
        URL_TO_CHAIN.set(selected, chainId);
        const pool = QUALIFIED_FALLBACK_POOLS.get(chainId) || new Set();
        pool.add(selected);
        QUALIFIED_FALLBACK_POOLS.set(chainId, pool);
      }
      return selected;
    }
  }

  deadline.check();
  const fallback = settings.publicFallbacks[chainId];
  if (typeof fallback !== "string") return null;
  if (!await qualifyRpc(fallback, chainId, settings)) return null;
  if (options.rpcCall === undefined) {
    URL_TO_CHAIN.set(fallback, chainId);
    const pool = QUALIFIED_FALLBACK_POOLS.get(chainId) || new Set();
    pool.add(fallback);
    QUALIFIED_FALLBACK_POOLS.set(chainId, pool);
  }
  return fallback;
}

async function resolveRpcPool(chainIds, urls = null, options = {}) {
  deadline.check();
  const settings = resolverOptions(options);
  const pool = boundedPool(urls === null ? loadRpcUrls({ maxCandidates: settings.maxCandidates }) : urls, settings.maxCandidates);
  const result = {};
  const boundedChainIds = Array.isArray(chainIds) ? chainIds.slice(0, 64) : [];
  for (const cid of boundedChainIds) {
    deadline.check();
    const selected = await resolveRpc(cid, pool, settings);
    if (selected) result[cid] = selected;
  }
  return result;
}

module.exports = {
  getOrigin,
  loadRpcUrls,
  parseRpcInventory,
  buildHeadCandidates,
  loadHeadCandidates,
  rpcCall,
  rpcCallStrict,
  rpcEthCallOutcome,
  RpcTransportError,
  rpcCapabilityRank,
  resolveRpc,
  resolveRpcPool,
  sanitizeError,
  getImpl,
  PUBLIC_FALLBACKS,
  MAX_INVENTORY_BYTES,
  MAX_RPC_CANDIDATES,
};
