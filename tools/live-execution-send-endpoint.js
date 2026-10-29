#!/usr/bin/env node
"use strict";

// live-execution-send-endpoint.js
//
// Send-capable endpoint resolver for the live-execution broadcast adapter.
//
// createSendEndpointResolver(options) returns
//   async (chainId, endpointRef) => urlOrNull
// and is intended to be injected as the adapter's
// `deps.resolveSendEndpoint`.
//
// It resolves exactly ONE qualified send-capable endpoint for the requested
// chain from the authorized endpoint inventory, entirely in process. It NEVER
// consults the repo-wide public fallback map and NEVER falls back to a public
// endpoint: when nothing qualifies it returns null and the adapter fails
// closed. Every returned URL has already passed the adapter's
// `validateSendEndpointUrl` policy (TLS, no embedded credentials), and it is
// re-checked at return time.
//
// The resolver is fully injectable for offline tests:
//   options.transport     - (url, method, params, timeoutMs) => result
//   options.readInventory - () => string | string[]
//   options.providerUrls  - string[] (bypasses readInventory)
// No disk cache and no URL persistence are performed.
//
// The optional CLI (`resolve --chain <id>`) prints only a RESOLVED / UNAVAILABLE
// status and never a URL. It reads the inventory only when explicitly invoked.

const fs = require("node:fs");
const path = require("node:path");
const { rankProviderUrls } = require("./lib/rpc-provider-reliability");
const { validateSendEndpointUrl } = require("./live-execution-broadcast-adapter.js");

const INVENTORY_FILE = path.join(__dirname, "..", "rpc_endpoints.txt");
const MAX_INVENTORY_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 128;
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_TIMEOUT_MS = 30_000;
const HEX_QUANTITY = /^0x[0-9a-f]+$/iu;
const DECIMAL_QUANTITY = /^[0-9]+$/u;
const URL_MATCH = /(https?:\/\/[^\s'"<>\[\]]+)/iu;
const TRANSPORT_ALLOWLIST = Object.freeze(new Set(["eth_chainId"]));

class SendEndpointError extends Error {
  constructor(code) { super(code); this.name = "SendEndpointError"; this.code = code; }
}
const fail = (code) => { throw new SendEndpointError(code); };
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function parseChainId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  try {
    if (HEX_QUANTITY.test(text)) {
      const parsed = Number(BigInt(text));
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
    if (DECIMAL_QUANTITY.test(text)) {
      const parsed = Number(BigInt(text));
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
  } catch (_) {
    return null;
  }
  return null;
}

// First URL per line, matching the repo's shared RPC inventory convention.
// Annotation domains on the same line are not treated as endpoint candidates.
function parseInventoryUrls(text) {
  if (typeof text !== "string" || text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_INVENTORY_BYTES) return [];
  const urls = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(URL_MATCH);
    if (!match) continue;
    const candidate = match[1].replace(/[)\],;]+$/u, "");
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    urls.push(candidate);
    if (urls.length >= MAX_CANDIDATES) break;
  }
  return urls;
}

function readAuthorizedInventory() {
  let fd;
  let buffer = null;
  try {
    fd = fs.openSync(INVENTORY_FILE, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INVENTORY_BYTES) return [];
    buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!Number.isInteger(read) || read <= 0) break;
      offset += read;
    }
    return parseInventoryUrls(buffer.toString("utf8", 0, offset));
  } catch (_) {
    return [];
  } finally {
    if (buffer) { try { buffer.fill(0); } catch (_) { /* best effort */ } }
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* best effort */ } }
  }
}

async function defaultTransport(url, method, params, timeoutMs) {
  if (!TRANSPORT_ALLOWLIST.has(method)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    let payload;
    try { payload = await response.json(); } catch (_) { return null; }
    if (!response.ok || !isPlainObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== 1) return null;
    if (Object.hasOwn(payload, "error") === Object.hasOwn(payload, "result")) return null;
    if (payload.error) return null;
    return payload.result ?? null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(invoke, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeoutMs);
    Promise.resolve().then(invoke).then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } },
    );
  });
}

async function probeChain(transport, url, timeoutMs) {
  const result = await withTimeout(() => transport(url, "eth_chainId", [], timeoutMs), timeoutMs);
  return parseChainId(result);
}

function normalizeCandidates(raw, readInventory) {
  if (Array.isArray(raw)) return raw;
  return parseInventoryUrls(raw);
}

function createSendEndpointResolver(options = {}) {
  if (!isPlainObject(options)) fail("SEND_ENDPOINT_OPTIONS_INVALID");
  const transport = typeof options.transport === "function" ? options.transport : defaultTransport;
  const readInventory = typeof options.readInventory === "function" ? options.readInventory : readAuthorizedInventory;
  const injectedProviderUrls = Array.isArray(options.providerUrls) ? options.providerUrls : null;
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxCandidates = boundedInteger(options.maxCandidates, MAX_CANDIDATES, MAX_CANDIDATES);

  return async function resolveSendEndpoint(chainId, _endpointRef) {
    const expected = parseChainId(chainId);
    if (expected === null) return null;
    let raw;
    if (injectedProviderUrls !== null) {
      raw = injectedProviderUrls;
    } else {
      let inventory;
      try { inventory = readInventory(); } catch (_) { return null; }
      raw = normalizeCandidates(inventory, readInventory);
    }
    if (!Array.isArray(raw)) return null;

    // Filter to the adapter's exact URL policy before any probe so an insecure
    // or credential-bearing candidate is never contacted and never returned.
    const candidates = [];
    const seen = new Set();
    for (const value of raw) {
      if (typeof value !== "string") continue;
      const policyUrl = validateSendEndpointUrl(value.trim());
      if (!policyUrl || seen.has(policyUrl)) continue;
      seen.add(policyUrl);
      candidates.push(policyUrl);
    }
    if (candidates.length === 0) return null;

    const ranked = rankProviderUrls(candidates, maxCandidates);
    for (const url of ranked) {
      const observed = await probeChain(transport, url, timeoutMs);
      if (observed !== null && observed === expected) return url;
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Optional CLI: `resolve --chain <id>`. Never prints a URL.
// ---------------------------------------------------------------------------
function parseCli(args) {
  if (!Array.isArray(args) || args.length === 0) fail("USAGE_ERROR");
  if (args[0] !== "resolve") fail("USAGE_ERROR");
  let chainFlag = null;
  const rest = args.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== "--chain") fail("USAGE_ERROR");
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) fail("USAGE_ERROR");
    if (chainFlag !== null) fail("USAGE_ERROR");
    chainFlag = value;
    index += 1;
  }
  if (chainFlag === null) fail("USAGE_ERROR");
  const chainId = parseChainId(chainFlag);
  if (chainId === null) fail("USAGE_ERROR");
  return { command: "resolve", chainId };
}

async function runCli(argv = process.argv) {
  let parsed;
  try { parsed = parseCli(argv.slice(2)); }
  catch (error) {
    const blocker = error instanceof SendEndpointError ? error.code : "USAGE_ERROR";
    process.stdout.write(`${JSON.stringify({ status: "FAIL_CLOSED", blocker })}\n`);
    process.exitCode = 1;
    return null;
  }
  try {
    const resolver = createSendEndpointResolver({});
    const resolved = await resolver(parsed.chainId, null);
    process.stdout.write(`${JSON.stringify({ command: "resolve", chainId: parsed.chainId, status: resolved ? "RESOLVED" : "UNAVAILABLE" })}\n`);
    if (!resolved) process.exitCode = 1;
    return resolved;
  } catch (_) {
    process.stdout.write(`${JSON.stringify({ status: "FAIL_CLOSED", blocker: "INTERNAL_FAILURE_REDACTED" })}\n`);
    process.exitCode = 1;
    return null;
  }
}
if (require.main === module) runCli();

module.exports = Object.freeze({
  createSendEndpointResolver,
  parseInventoryUrls,
  parseChainId,
  readAuthorizedInventory,
  defaultTransport,
  runCli,
  parseCli,
  SendEndpointError,
  constants: Object.freeze({
    INVENTORY_FILE,
    MAX_INVENTORY_BYTES,
    MAX_CANDIDATES,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  }),
});
