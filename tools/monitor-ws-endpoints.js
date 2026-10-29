"use strict";

// Endpoint values handled here are process-only. This module never logs, hashes,
// persists, or returns them in enumerable result fields.
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");

const RPC_FILE = path.resolve(__dirname, "..", "rpc_endpoints.txt");
const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1024 * 1024,
  maxCandidates: 24,
  concurrency: 3,
  timeoutMs: 8000,
  maxUrlLength: 2048,
});
const DEFAULT_OBSERVATION_TIMEOUT_MS = 8000;
const HOSTNAME_MAX_LENGTH = 253;
const HOSTNAME_ALLOWED_CHARS = /^[A-Za-z0-9.-]+$/;
const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const QUALIFICATION_FAILED = Symbol("WS_QUALIFICATION_FAILED");

// These are intentionally noncredentialed and are attempted only after every
// bounded inventory candidate fails qualification.
const PUBLIC_WS_FALLBACKS = Object.freeze({
  1: "wss://ethereum.publicnode.com",
  10: "wss://optimism.publicnode.com",
  137: "wss://polygon-bor.publicnode.com",
  8453: "wss://base.publicnode.com",
  42161: "wss://arbitrum-one.publicnode.com",
});

const PROVIDER_DOMAIN_TIERS = Object.freeze([
  Object.freeze({ rank: 0, suffixes: Object.freeze(["alchemy.com", "infura.io", "quicknode.com", "quiknode.pro"]) }),
  Object.freeze({ rank: 2, suffixes: Object.freeze(["publicnode.com", "drpc.org", "1rpc.io", "0xrpc.io"]) }),
]);

const providerByResolution = new WeakMap();

class WsResolutionError extends Error {
  constructor(code = "WS_RESOLUTION_FAILED") {
    super(code);
    this.name = "WsResolutionError";
    this.code = code;
  }
}

class WsTimeoutError extends Error {
  constructor() {
    super("WS_TIMEOUT");
    this.name = "WsTimeoutError";
    this.code = "WS_TIMEOUT";
  }
}

function sanitizedErrorClass(error) {
  if (error instanceof WsTimeoutError || error?.code === "WS_TIMEOUT" || error?.code === "TIMEOUT") return "TimeoutError";
  if (error instanceof WsResolutionError) return "ResolutionError";
  if (["NETWORK_ERROR", "SERVER_ERROR", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"].includes(error?.code)) return "NetworkError";
  return "ProviderError";
}

function readInventoryText(filePath = RPC_FILE, maxBytes = DEFAULT_LIMITS.maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new WsResolutionError("WS_INVENTORY_BOUNDS");
    return buffer.toString("utf8", 0, bytesRead);
  } catch (error) {
    if (error instanceof WsResolutionError) throw error;
    throw new WsResolutionError("WS_INVENTORY_UNAVAILABLE");
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

// A real endpoint must have a syntactically valid DNS hostname. This rejects
// unsubstituted template placeholders (for example a brace-delimited token),
// along with spaces, angle brackets, empty labels, leading/trailing hyphens, and
// leading/trailing dots. Rejected candidates are skipped silently so their text
// is never dialed, logged, or surfaced anywhere.
function isValidHostname(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  if (hostname.length > HOSTNAME_MAX_LENGTH) return false;
  if (!HOSTNAME_ALLOWED_CHARS.test(hostname)) return false;
  for (const label of hostname.split(".")) {
    if (!HOSTNAME_LABEL.test(label)) return false;
  }
  return true;
}

function wsHostname(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "wss:" && parsed.hostname ? parsed.hostname : null;
  } catch (_) {
    return null;
  }
}

function domainTier(hostname) {
  const host = hostname.toLowerCase();
  for (const tier of PROVIDER_DOMAIN_TIERS) {
    if (tier.suffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return tier.rank;
  }
  return 1;
}

function extractWsCandidates(text, limits = {}) {
  const maxBytes = limits.maxBytes ?? DEFAULT_LIMITS.maxBytes;
  const maxCandidates = limits.maxCandidates ?? DEFAULT_LIMITS.maxCandidates;
  const maxUrlLength = limits.maxUrlLength ?? DEFAULT_LIMITS.maxUrlLength;
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new WsResolutionError("WS_INVENTORY_BOUNDS");
  }

  const candidates = [];
  const seen = new Set();
  const matcher = /wss:\/\/[^\s'"<>\[\]`]+/gi;
  let match;
  let order = 0;
  while ((match = matcher.exec(text)) !== null) {
    const value = match[0].replace(/[),.;]+$/, "");
    if (value.length > maxUrlLength || seen.has(value)) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "wss:" || !isValidHostname(parsed.hostname)) continue;
      seen.add(value);
      const candidate = { value, rank: domainTier(parsed.hostname), order: order++ };
      if (candidates.length < maxCandidates) {
        candidates.push(candidate);
        continue;
      }

      // Keep the bounded best capability pool while scanning the entire
      // byte-bounded inventory. A preferred entry appearing later must not be
      // excluded merely because lower-tier entries filled the pool first.
      let worstIndex = 0;
      for (let index = 1; index < candidates.length; index += 1) {
        if (candidates[index].rank >= candidates[worstIndex].rank) worstIndex = index;
      }
      if (candidate.rank < candidates[worstIndex].rank) candidates[worstIndex] = candidate;
    } catch (_) {}
  }

  // Stable capability tiers preserve inventory order; endpoint text is never
  // used as an alphabetical tie-breaker.
  candidates.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return candidates.map(candidate => candidate.value);
}

function withTimeout(operation, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new WsTimeoutError()), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function destroyProvider(provider) {
  if (!provider) return;
  try {
    if (typeof provider.destroy === "function") await provider.destroy();
    else if (typeof provider.websocket?.close === "function") provider.websocket.close();
  } catch (_) {}
}

function parseChainId(value) {
  const chainId = typeof value === "object" && value !== null && "chainId" in value ? value.chainId : value;
  if (typeof chainId === "bigint") return Number(chainId);
  if (typeof chainId === "number") return Number.isSafeInteger(chainId) ? chainId : null;
  if (typeof chainId === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(chainId)) return Number(BigInt(chainId));
  return null;
}

async function providerChainId(provider) {
  if (typeof provider?.send === "function") return parseChainId(await provider.send("eth_chainId", []));
  if (typeof provider?.getNetwork === "function") return parseChainId(await provider.getNetwork());
  return null;
}

function parseBlockNumber(value) {
  const blockNumber = parseChainId(value);
  return Number.isSafeInteger(blockNumber) && blockNumber >= 0 ? blockNumber : null;
}

async function registerWsSubscription(provider, event, listener, timeoutMs = DEFAULT_OBSERVATION_TIMEOUT_MS) {
  if (typeof provider?.on !== "function" || typeof listener !== "function") {
    throw new WsResolutionError("WS_SUBSCRIPTION_FAILED");
  }
  try {
    await withTimeout(() => provider.on(event, listener), timeoutMs);
  } catch (_) {
    throw new WsResolutionError("WS_SUBSCRIPTION_FAILED");
  }
}

async function readLatestBlock(provider, timeoutMs = DEFAULT_OBSERVATION_TIMEOUT_MS) {
  try {
    const value = await withTimeout(() => {
      if (typeof provider?.getBlockNumber === "function") return provider.getBlockNumber();
      if (typeof provider?.send === "function") return provider.send("eth_blockNumber", []);
      throw new WsResolutionError("WS_OBSERVATION_FAILED");
    }, timeoutMs);
    const blockNumber = parseBlockNumber(value);
    if (blockNumber === null) throw new WsResolutionError("WS_OBSERVATION_FAILED");
    return blockNumber;
  } catch (_) {
    throw new WsResolutionError("WS_OBSERVATION_FAILED");
  }
}

// The ws library emits 'error' on the underlying socket instead of rejecting the
// awaited provider call. A socket with no 'error' listener terminates the
// process. Attach a listener as early as possible: for the default synchronous
// provider factory this happens before any await boundary, so the first error
// can never escape as an unhandled event.
function attachSocketErrorGuard(provider, onError) {
  const socket = provider?.websocket;
  if (socket && typeof socket.on === "function") {
    try {
      socket.on("error", onError);
      return true;
    } catch (_) {}
  }
  return false;
}

async function qualifyCandidate(value, chainId, sourceClass, providerFactory, timeoutMs) {
  let provider;
  let expired = false;
  let signalSocketFailure = () => {};
  const socketFailure = new Promise(resolve => { signalSocketFailure = () => resolve(QUALIFICATION_FAILED); });
  const onSocketError = () => signalSocketFailure();

  try {
    const qualifiedId = await withTimeout(async () => {
      const built = providerFactory(value, { chainId, sourceClass });
      if (built && typeof built.then === "function") provider = await built;
      else provider = built;
      attachSocketErrorGuard(provider, onSocketError);
      if (expired) {
        await destroyProvider(provider);
        return null;
      }
      return Promise.race([providerChainId(provider), socketFailure]);
    }, timeoutMs);
    if (qualifiedId !== chainId) {
      await destroyProvider(provider);
      return null;
    }
    return provider;
  } catch (_) {
    expired = true;
    await destroyProvider(provider);
    return null;
  }
}

function opaqueResolution(provider, sourceClass) {
  const result = Object.freeze({ sourceClass });
  providerByResolution.set(result, provider);
  return result;
}

function getResolvedProvider(resolution) {
  const provider = providerByResolution.get(resolution);
  if (!provider) throw new WsResolutionError("WS_PROVIDER_UNAVAILABLE");
  return provider;
}

async function selectQualified(candidates, chainId, sourceClass, providerFactory, limits) {
  for (let index = 0; index < candidates.length; index += limits.concurrency) {
    const batch = candidates.slice(index, index + limits.concurrency);
    const providers = await Promise.all(batch.map(value => qualifyCandidate(
      value,
      chainId,
      sourceClass,
      providerFactory,
      limits.timeoutMs,
    )));
    const selectedIndex = providers.findIndex(Boolean);
    if (selectedIndex !== -1) {
      await Promise.all(providers.map((provider, providerIndex) => (
        provider && providerIndex !== selectedIndex ? destroyProvider(provider) : undefined
      )));
      return providers[selectedIndex];
    }
  }
  return null;
}

async function resolveWsProvider(options) {
  const chainId = Number(options?.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new WsResolutionError("WS_INVALID_CHAIN");

  const limits = {
    maxBytes: Math.max(1, Math.min(options.maxBytes ?? DEFAULT_LIMITS.maxBytes, DEFAULT_LIMITS.maxBytes)),
    maxCandidates: Math.max(1, Math.min(options.maxCandidates ?? DEFAULT_LIMITS.maxCandidates, DEFAULT_LIMITS.maxCandidates)),
    maxUrlLength: Math.max(1, Math.min(options.maxUrlLength ?? DEFAULT_LIMITS.maxUrlLength, DEFAULT_LIMITS.maxUrlLength)),
    concurrency: Math.max(1, Math.min(options.concurrency ?? DEFAULT_LIMITS.concurrency, 8)),
    timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs, 30000)),
  };
  const providerFactory = options.providerFactory || (value => new ethers.WebSocketProvider(value));

  let candidates = [];
  try {
    const text = options.candidateText === undefined
      ? readInventoryText(RPC_FILE, limits.maxBytes)
      : options.candidateText;
    candidates = extractWsCandidates(text, limits);
  } catch (_) {
    candidates = [];
  }

  const inventoryProvider = await selectQualified(candidates, chainId, "inventory", providerFactory, limits);
  if (inventoryProvider) return opaqueResolution(inventoryProvider, "inventory");

  const fallbackMap = options.publicFallbacks || PUBLIC_WS_FALLBACKS;
  const fallback = fallbackMap[chainId];
  if (typeof fallback === "string" && isValidHostname(wsHostname(fallback))) {
    const fallbackProvider = await selectQualified([fallback], chainId, "public-fallback", providerFactory, limits);
    if (fallbackProvider) return opaqueResolution(fallbackProvider, "public-fallback");
  }

  throw new WsResolutionError();
}

module.exports = {
  DEFAULT_LIMITS,
  DEFAULT_OBSERVATION_TIMEOUT_MS,
  WsResolutionError,
  getResolvedProvider,
  readLatestBlock,
  registerWsSubscription,
  resolveWsProvider,
  sanitizedErrorClass,
};
