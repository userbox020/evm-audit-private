#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const batchTool = require("./live-execution-batch");
const sharedRpc = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", "approved-fork-validation");
const MANIFEST_SCHEMA = "fork-validation-manifest/v3";
const OUTPUT_SCHEMA = "approved-fork-validation/v3";
const LIMITS = Object.freeze({
  totalMs: 180_000,
  requestMs: 15_000,
  relayRequests: 20_000,
  relayBytes: 256 * 1024 * 1024,
  localRequests: 5_000,
  localBytes: 64 * 1024 * 1024,
  messageBytes: 1024 * 1024,
  manifestBytes: 1024 * 1024,
  calls: 32,
  watch: 64,
  startupMs: 45_000,
});
const UPSTREAM_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "net_version", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getCode", "eth_getStorageAt", "eth_getProof", "eth_call", "eth_getBalance",
  "eth_getTransactionCount", "eth_getLogs", "eth_feeHistory", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  // Read-only receipt/history lookups are needed when anvil resolves a locally
  // mined fork transaction; they carry no state-mutating capability.
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockReceipts",
]);
const NATIVE = "native";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

class ForkError extends Error {
  constructor(code, stage = "FORK_VALIDATION") {
    super(code);
    this.name = "ForkError";
    this.code = code;
    this.stage = stage;
    this.detail = null;
  }
}
const fail = (code, stage) => {
  throw new ForkError(code, stage);
};
// Bounded, sanitized persistence of a local anvil/RPC error message. This is
// process-local evidence only: URLs and credential labels are redacted, the
// alphabet is restricted, and the result is length-capped so endpoint material
// can never be persisted or printed.
function sanitizeRpcDetail(error) {
  if (!isPlainObject(error)) return null;
  const pieces = [];
  if (typeof error.message === "string" && error.message) pieces.push(error.message);
  if (typeof error.data === "string" && /^0x[0-9a-fA-F]*$/u.test(error.data)) pieces.push(`data=${error.data.slice(0, 2 + 64 * 4)}`);
  const joined = pieces.join(" | ");
  if (!joined) return null;
  const redacted = joined
    .replace(/\b(?:https?|wss?):\/\/\S+/giu, "[redacted-url]")
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|bearer|private[_-]?key|mnemonic)\s*[:=]?\s*\S*/giu, "[redacted]")
    .replace(/[^A-Za-z0-9 _.,:;()\[\]{}<>/=+\-|#]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return redacted ? redacted.slice(0, 240) : null;
}
const hexQuantity = (value) => `0x${BigInt(value).toString(16)}`;
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const isAddress = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/u.test(value) && value !== ZERO_ADDRESS;
const isHexData = (value) => typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/u.test(value);
function decimal(value, code) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) fail(code);
  return BigInt(value);
}
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") fail("NONCANONICAL_NUMBER");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isPlainObject(value)) fail("NONCANONICAL_VALUE");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function leakGuard(value, key = "") {
  if (/^(?:url|urls|endpoint|endpoints|provider|providers|headers|origin|credential|credentials|privateKey|secret|mnemonic|keystore)$/iu.test(key)) fail("OUTPUT_SECRET_FIELD_REJECTED", "PUBLICATION");
  if (typeof value === "string") {
    if (/(?:https?|wss?):\/\//iu.test(value)) fail("OUTPUT_URL_REJECTED", "PUBLICATION");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child) => leakGuard(child, key));
    return;
  }
  if (isPlainObject(value)) Object.entries(value).forEach(([name, child]) => leakGuard(child, name));
}
function sha256(value) {
  return `0x${crypto.createHash("sha256").update(value).digest("hex")}`;
}
function defaultOutPath(manifestId) {
  return path.join(OUT_DIR, `${manifestId}.json`);
}
function assertLocalhost(url) {
  if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(url)) fail("LOCALHOST_BOUNDARY_VIOLATION", "LOCAL");
}
function writeOnce(file, value) {
  leakGuard(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  try {
    fs.writeFileSync(file, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") fail("OUTPUT_ALREADY_EXISTS", "PUBLICATION");
    fail("OUTPUT_WRITE_FAILED", "PUBLICATION");
  }
  return bytes;
}

function validateManifest(manifest) {
  const allowed = new Set(["schema", "manifestId", "chainId", "pinBlockNumber", "pinBlockHash", "pinStateRoot", "pinFinality", "calls", "watch", "pricesUsd"]);
  if (!isPlainObject(manifest) || Object.keys(manifest).some((key) => !allowed.has(key)) || !Object.hasOwn(manifest, "schema")) fail("MANIFEST_SCHEMA_INVALID", "MANIFEST");
  if (manifest.schema !== MANIFEST_SCHEMA) fail("MANIFEST_SCHEMA_INVALID", "MANIFEST");
  if (typeof manifest.manifestId !== "string" || !/^[0-9a-f]{8,32}$/u.test(manifest.manifestId)) fail("MANIFEST_ID_INVALID", "MANIFEST");
  decimal(manifest.chainId, "MANIFEST_CHAIN_INVALID");
  decimal(manifest.pinBlockNumber, "MANIFEST_PIN_INVALID");
  if (typeof manifest.pinBlockHash !== "string" || !/^0x[0-9a-f]{64}$/u.test(manifest.pinBlockHash)) fail("MANIFEST_PIN_HASH_INVALID", "MANIFEST");
  if (typeof manifest.pinStateRoot !== "string" || !/^0x[0-9a-f]{64}$/u.test(manifest.pinStateRoot)) fail("MANIFEST_PIN_STATE_ROOT_INVALID", "MANIFEST");
  if (manifest.pinFinality !== "finalized") fail("MANIFEST_PIN_FINALITY_INVALID", "MANIFEST");
  if (!Array.isArray(manifest.calls) || manifest.calls.length < 1 || manifest.calls.length > LIMITS.calls) fail("MANIFEST_CALLS_INVALID", "MANIFEST");
  const callIds = new Set();
  for (const call of manifest.calls) {
    if (!exactKeys(call, ["id", "actor", "to", "data", "valueWei", "gasLimit", "slippageBps"]) || typeof call.id !== "string" || !/^[0-9a-z-]{1,32}$/u.test(call.id) || callIds.has(call.id)) fail("MANIFEST_CALLS_INVALID", "MANIFEST");
    if (!isAddress(call.actor) || !isAddress(call.to) || !isHexData(call.data) || call.data.length < 10) fail("MANIFEST_CALLS_INVALID", "MANIFEST");
    decimal(call.valueWei, "MANIFEST_CALLS_INVALID");
    if (decimal(call.gasLimit, "MANIFEST_CALLS_INVALID") < 1n || decimal(call.slippageBps, "MANIFEST_CALLS_INVALID") > 10000n) fail("MANIFEST_CALLS_INVALID", "MANIFEST");
    callIds.add(call.id);
  }
  if (!Array.isArray(manifest.watch) || manifest.watch.length < 1 || manifest.watch.length > LIMITS.watch) fail("MANIFEST_WATCH_INVALID", "MANIFEST");
  const watchIds = new Set();
  const watchKeys = new Set();
  const nativeAttackerHolders = new Set();
  for (const entry of manifest.watch) {
    if (!exactKeys(entry, ["id", "token", "holder", "decimals", "role"]) || typeof entry.id !== "string" || !/^[0-9a-z-]{1,32}$/u.test(entry.id) || watchIds.has(entry.id)) fail("MANIFEST_WATCH_INVALID", "MANIFEST");
    if (entry.token !== NATIVE && !isAddress(entry.token)) fail("MANIFEST_WATCH_INVALID", "MANIFEST");
    if (!isAddress(entry.holder)) fail("MANIFEST_WATCH_INVALID", "MANIFEST");
    const decimals = decimal(entry.decimals, "MANIFEST_WATCH_INVALID");
    if (decimals > 36n) fail("MANIFEST_WATCH_INVALID", "MANIFEST");
    if (!["attacker", "protocol", "incumbent", "observer"].includes(entry.role)) fail("MANIFEST_WATCH_INVALID", "MANIFEST");
    const watchKey = `${entry.token}:${entry.holder}`;
    if (watchKeys.has(watchKey)) fail("MANIFEST_WATCH_INVALID", "MANIFEST");
    watchKeys.add(watchKey);
    if (entry.token === NATIVE && entry.role === "attacker") nativeAttackerHolders.add(entry.holder);
    watchIds.add(entry.id);
  }
  const requiredWatch = minimumBalanceWatch(manifest.calls);
  if (requiredWatch.some((entry) => !watchKeys.has(`${entry.token}:${entry.holder}`) || (entry.role === "attacker" && !nativeAttackerHolders.has(entry.holder)))) fail("MANIFEST_WATCH_COVERAGE_INVALID", "MANIFEST");
  const prices = manifest.pricesUsd === undefined ? [] : manifest.pricesUsd;
  if (!Array.isArray(prices)) fail("MANIFEST_PRICES_INVALID", "MANIFEST");
  const priceTokens = new Set();
  for (const row of prices) {
    if (!exactKeys(row, ["token", "usdPerToken"]) || (row.token !== NATIVE && !isAddress(row.token)) || typeof row.usdPerToken !== "string" || !/^(?:0|[1-9][0-9]{0,39})(?:\.[0-9]{1,18})?$/u.test(row.usdPerToken) || priceTokens.has(row.token)) fail("MANIFEST_PRICES_INVALID", "MANIFEST");
    priceTokens.add(row.token);
  }
  return manifest;
}
function calldataWatchAddresses(call) {
  const selector = call.data.slice(0, 10);
  const words = [];
  for (let offset = 10; offset + 64 <= call.data.length; offset += 64) {
    const candidate = `0x${call.data.slice(offset + 24, offset + 64)}`;
    words.push(isAddress(candidate) ? candidate : null);
  }
  if (["0xa9059cbb", "0x095ea7b3"].includes(selector)) return words.slice(0, 1).filter(Boolean);
  if (selector === "0x23b872dd") return words.slice(0, 2).filter(Boolean);
  return [];
}
function minimumBalanceWatch(calls) {
  const required = new Map();
  const add = (token, holder, role) => {
    const key = `${token}:${holder}`;
    if (!required.has(key) || role === "attacker") required.set(key, { token, holder, role });
  };
  for (const call of calls) {
    add(NATIVE, call.actor, "attacker");
    add(NATIVE, call.to, "observer");
    if (["0xa9059cbb", "0x095ea7b3", "0x23b872dd"].includes(call.data.slice(0, 10))) {
      add(call.to, call.actor, "attacker");
      for (const holder of calldataWatchAddresses(call)) add(call.to, holder, "observer");
    }
  }
  return [...required.values()];
}
function manifestCommitment(manifest) {
  return sha256(canonical(manifest));
}

function scopeCheck(batchStateResult, manifest) {
  if (batchStateResult.state !== batchTool.STATES.VALID) return { ok: false, state: batchStateResult.state, reason: batchStateResult.reason || batchStateResult.state };
  const batch = batchStateResult.batch;
  if (batch.chainId !== manifest.chainId) return { ok: false, state: "SCOPE_MISMATCH", reason: "SCOPE_CHAIN_MISMATCH" };
  if (batch.accountRef !== manifest.calls[0]?.actor) return { ok: false, state: "SCOPE_MISMATCH", reason: "SCOPE_ACTOR_MISMATCH" };
  if (manifest.calls.length !== batch.actions.length) return { ok: false, state: "SCOPE_MISMATCH", reason: "SCOPE_ACTION_COUNT_OR_ORDER_MISMATCH" };
  for (let index = 0; index < manifest.calls.length; index += 1) {
    const call = manifest.calls[index];
    const action = { chainId: manifest.chainId, from: call.actor, to: call.to, valueWei: call.valueWei, data: call.data, gasLimit: call.gasLimit, slippageBps: call.slippageBps };
    const scope = batchTool.checkAction(batch, action, index);
    if (!scope.ok) return { ok: false, state: "SCOPE_MISMATCH", reason: `${scope.reason}:${call.id}` };
  }
  return { ok: true, state: "VALID", batchCommitment: batchStateResult.batchCommitment, scopeCommitment: batchStateResult.scopeCommitment, approval: batchStateResult.approval };
}

async function createReadOnlyRelay(options) {
  const transport = options.transport;
  const limits = options.limits || LIMITS;
  const started = Date.now();
  let forwarded = 0, bytes = 0, denied = 0, active = 0;
  const deniedMethods = new Set();
  const forwardOne = async (row) => {
    const id = Object.hasOwn(row || {}, "id") ? row.id : null;
    const method = typeof row?.method === "string" ? row.method : "";
    if (!UPSTREAM_METHODS.has(method)) {
      denied += 1;
      deniedMethods.add(/^[a-zA-Z0-9_]{1,64}$/u.test(method) ? method : "INVALID_METHOD_NAME");
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "method-not-allowed" } };
    }
    if (++forwarded > limits.relayRequests || Date.now() - started > limits.totalMs || active >= 8) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: "relay-budget-exhausted" } };
    }
    active += 1;
    try {
      const response = await transport(options.upstreamUrl, { jsonrpc: "2.0", id, method, params: Array.isArray(row.params) ? row.params : [] }, limits.requestMs);
      if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > limits.messageBytes) throw new Error("relay-response-invalid");
      if ((bytes += response.bytes) > limits.relayBytes) throw new Error("relay-response-invalid");
      if (!response.value || response.value.jsonrpc !== "2.0" || response.value.id !== id) throw new Error("relay-response-invalid");
      return response.value;
    } catch (_) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: "upstream-read-failure" } };
    } finally {
      active -= 1;
    }
  };
  const server = http.createServer((request, response) => {
    const remote = request.socket.remoteAddress;
    if (request.method !== "POST" || (remote && !remote.includes("127.0.0.1") && remote !== "::1")) {
      response.writeHead(403).end();
      return;
    }
    let size = 0;
    const chunks = [];
    request.setTimeout(limits.requestMs, () => request.destroy());
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limits.messageBytes) chunks.push(chunk);
      else request.destroy();
    });
    request.on("end", async () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        if (!rows.length || rows.length > 64) throw new Error("invalid");
        const results = await Promise.all(rows.map(forwardOne));
        const payload = Buffer.from(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
        if (payload.length > limits.messageBytes) throw new Error("large");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(payload);
      } catch (_) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"invalid-request"}}');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const close = () => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish(new ForkError("RELAY_CLOSE_UNCONFIRMED", "RELAY_CLEANUP"));
    }, 1500);
    server.close((error) => finish(error ? new ForkError("RELAY_CLOSE_FAILED", "RELAY_CLEANUP") : null));
  });
  return { port: server.address().port, stats: () => ({ forwarded, bytes, denied, deniedMethods: [...deniedMethods].sort() }), close };
}

function sanitizedChildEnvironment(environment = process.env) {
  const result = {};
  for (const key of ["Path", "PATH", "SystemRoot", "WINDIR"]) {
    if (typeof environment[key] === "string" && environment[key] && !/:\/\//u.test(environment[key])) result[key] = environment[key];
  }
  result.TEMP = path.join(os.tmpdir(), "opencode");
  result.TMP = result.TEMP;
  return result;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function stopAnvil(child, waitMs = 1500) {
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  const waitExit = () => new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve(true);
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("exit", onExit);
      resolve(true);
    };
    const onExit = () => done();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener?.("exit", onExit);
      resolve(false);
    }, waitMs);
    child.once?.("exit", onExit);
  });
  try {
    child.kill();
  } catch (_) {
    fail("ANVIL_NORMAL_KILL_FAILED", "CHILD_CLEANUP");
  }
  if (await waitExit()) return true;
  try {
    child.kill("SIGKILL");
  } catch (_) {
    fail("ANVIL_FORCED_KILL_FAILED", "CHILD_CLEANUP");
  }
  if (await waitExit()) return true;
  fail("ANVIL_EXIT_UNCONFIRMED", "CHILD_CLEANUP");
}
function buildAnvilArgs(relayPort, localPort, chainId, pinBlockNumber) {
  const relay = `http://127.0.0.1:${relayPort}`;
  assertLocalhost(relay);
  return ["--host", "127.0.0.1", "--port", String(localPort), "--chain-id", String(chainId), "--accounts", "0", "--auto-impersonate", "--fork-url", relay, "--fork-block-number", String(pinBlockNumber), "--no-storage-caching", "--quiet", "--color", "never"];
}
function createLocalRpc(port, options = {}) {
  const endpoint = `http://127.0.0.1:${port}`;
  assertLocalhost(endpoint);
  const fetchImpl = options.fetch || fetch;
  const limits = options.limits || LIMITS;
  const started = Date.now();
  let requests = 0, bytes = 0;
  const call = async (method, params, timeoutMs = limits.requestMs) => {
    const stage = typeof method === "string" && /^[a-zA-Z0-9_]{1,64}$/u.test(method) ? `LOCAL_RPC_${method}` : "LOCAL_RPC_UNKNOWN";
    if (++requests > limits.localRequests || Date.now() - started > limits.totalMs) fail("LOCAL_RPC_BUDGET_EXHAUSTED", "LOCAL_RPC");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, limits.requestMs)));
    try {
      const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: requests, method, params }), signal: controller.signal, redirect: "error" });
      const buffer = Buffer.from(await response.arrayBuffer());
      bytes += buffer.length;
      if (!response.ok || buffer.length > limits.messageBytes || bytes > limits.localBytes) fail("LOCAL_RPC_RESPONSE_BUDGET", "LOCAL_RPC");
      const parsed = JSON.parse(buffer.toString("utf8"));
      if (parsed.error || parsed.id !== requests || !Object.hasOwn(parsed, "result")) {
        const failure = new ForkError("LOCAL_RPC_METHOD_FAILED", stage);
        failure.detail = sanitizeRpcDetail(parsed.error);
        throw failure;
      }
      return parsed.result;
    } catch (error) {
      if (error instanceof ForkError) throw error;
      fail("LOCAL_RPC_UNAVAILABLE", "LOCAL_RPC");
    } finally {
      clearTimeout(timer);
    }
  };
  return { call, stats: () => ({ requests, bytes }) };
}

async function readResponseBody(response, maxBytes) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) || BigInt(declaredLength) > BigInt(maxBytes))) throw new Error("response-too-large");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("response-too-large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}
async function defaultTransport(url, payload, timeoutMs, maxBytes = LIMITS.messageBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const origin = sharedRpc.getOrigin(url);
    const headers = { "content-type": "application/json" };
    if (origin) headers.origin = origin;
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error("upstream-http-failure");
    const buffer = await readResponseBody(response, maxBytes);
    return { value: JSON.parse(buffer.toString("utf8")), bytes: buffer.length };
  } finally {
    clearTimeout(timer);
  }
}

async function qualifyUpstream(url, manifest, transport = defaultTransport) {
  const read = async (id, method, params) => {
    let response;
    try {
      response = await transport(url, { jsonrpc: "2.0", id, method, params }, LIMITS.requestMs, LIMITS.messageBytes);
    } catch (_) {
      fail("UPSTREAM_QUALIFICATION_FAILED", "UPSTREAM");
    }
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > LIMITS.messageBytes || !response.value || response.value.jsonrpc !== "2.0" || response.value.id !== id || response.value.error || !Object.hasOwn(response.value, "result")) fail("UPSTREAM_QUALIFICATION_FAILED", "UPSTREAM");
    return response.value.result;
  };
  const chainId = await read(1, "eth_chainId", []);
  if (typeof chainId !== "string" || !/^0x[0-9a-f]+$/u.test(chainId) || BigInt(chainId) !== BigInt(manifest.chainId)) fail("UPSTREAM_CHAIN_MISMATCH", "UPSTREAM");
  const pin = await read(2, "eth_getBlockByNumber", [hexQuantity(manifest.pinBlockNumber), false]);
  if (!pin || pin.hash !== manifest.pinBlockHash || pin.stateRoot !== manifest.pinStateRoot || typeof pin.number !== "string" || !/^0x[0-9a-f]+$/u.test(pin.number) || BigInt(pin.number) !== BigInt(manifest.pinBlockNumber)) fail("UPSTREAM_PIN_MISMATCH", "UPSTREAM");
  const finalized = await read(3, "eth_getBlockByNumber", ["finalized", false]);
  if (!finalized || typeof finalized.number !== "string" || !/^0x[0-9a-f]+$/u.test(finalized.number) || BigInt(finalized.number) < BigInt(manifest.pinBlockNumber)) fail("UPSTREAM_FINALITY_UNCONFIRMED", "UPSTREAM");
  return { chainIdMatched: true, pinHashMatched: true, pinStateRootMatched: true, finalizedAtOrAfterPin: true };
}
function validateUpstreamQualification(value) {
  const keys = ["chainIdMatched", "pinHashMatched", "pinStateRootMatched", "finalizedAtOrAfterPin"];
  if (!exactKeys(value, keys) || keys.some((key) => value[key] !== true)) fail("UPSTREAM_QUALIFICATION_INVALID", "UPSTREAM");
  return value;
}

function defaultDeps() {
  return {
    loadAuthorization: ({ now }) => batchTool.batchState({ now }),
    consumeAuthorization: ({ expectedBatchCommitment, manifestCommitment: manifestCommitmentValue, runId, now }) => batchTool.consumeBatch({ expectedBatchCommitment, manifestCommitment: manifestCommitmentValue, runId, now }),
    resolveUpstream: (chainId) => sharedRpc.resolveRpc(Number(chainId)),
    transport: defaultTransport,
    qualifyUpstream: (url, manifest) => qualifyUpstream(url, manifest, defaultTransport),
    freePort,
    verifyAnvilIdentity,
    startAnvil: (_pin, identity, args, env) => new Promise((resolve, reject) => {
      if (!identity?.execPath || !identity?.fd) {
        reject(new ForkError("ANVIL_PATH_NOT_ABSOLUTE", "TOOLCHAIN"));
        return;
      }
      try {
        const before = fs.fstatSync(Number(identity.fd));
        if (!before.isFile() || before.size > 128 * 1024 * 1024 || String(before.dev) !== identity.dev || String(before.ino) !== identity.ino) fail("ANVIL_IDENTITY_CHANGED", "TOOLCHAIN");
        const digest = sha256(fs.readFileSync(Number(identity.fd)));
        const after = fs.fstatSync(Number(identity.fd));
        if (digest !== identity.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("ANVIL_IDENTITY_CHANGED", "TOOLCHAIN");
      } catch (error) { reject(error instanceof ForkError ? error : new ForkError("ANVIL_IDENTITY_READ_FAILED", "TOOLCHAIN")); return; }
      let child;
      try {
        child = childProcess.spawn(identity.execPath, args, { stdio: ["ignore", "ignore", "ignore", Number(identity.fd)], windowsHide: true, shell: false, env });
      } catch (_) {
        reject(new ForkError("ANVIL_START_FAILED", "ANVIL_START"));
        return;
      }
      child.once("spawn", () => resolve(child));
      child.once("error", () => reject(new ForkError("ANVIL_START_FAILED", "ANVIL_START")));
    }),
    stopAnvil: (child) => stopAnvil(child),
    createLocalRpc: (port) => createLocalRpc(port),
  };
}

function executableIdentity(pin) {
  if (!pin || !path.isAbsolute(pin.executablePath)) fail("ANVIL_PATH_NOT_ABSOLUTE", "TOOLCHAIN");
  if (process.platform !== "linux" || !Number.isInteger(fs.constants.O_NOFOLLOW)) fail("ANVIL_STABLE_EXECUTION_UNSUPPORTED", "TOOLCHAIN");
  const expected = path.resolve(pin.executablePath);
  let first, realPath, fd, retained = false;
  try {
    first = fs.lstatSync(expected);
    if (first.isSymbolicLink() || !first.isFile()) fail("ANVIL_PATH_UNSAFE", "TOOLCHAIN");
    realPath = fs.realpathSync(expected);
    if (realPath !== expected) fail("ANVIL_PATH_UNSAFE", "TOOLCHAIN");
    if (!Number.isFinite(first.dev) || !Number.isFinite(first.ino) || first.dev === 0 || first.ino === 0) fail("ANVIL_STABLE_EXECUTION_UNSUPPORTED", "TOOLCHAIN");
    fd = fs.openSync(expected, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (opened.size > 128 * 1024 * 1024) fail("ANVIL_SIZE_INVALID", "TOOLCHAIN");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (first.dev !== after.dev || first.ino !== after.ino || first.size !== after.size || first.mtimeMs !== after.mtimeMs) fail("ANVIL_IDENTITY_CHANGED", "TOOLCHAIN");
    retained = true;
    return { realPath, dev: String(after.dev), ino: String(after.ino), size: String(after.size), mtimeMs: String(after.mtimeMs), sha256: sha256(bytes), fd: String(fd), execPath: "/proc/self/fd/3" };
  } catch (error) {
    if (error instanceof ForkError) throw error;
    fail("ANVIL_IDENTITY_READ_FAILED", "TOOLCHAIN");
  } finally {
    if (fd !== undefined && !retained) {
      try { fs.closeSync(fd); } catch (_) { fail("ANVIL_DESCRIPTOR_CLOSE_FAILED", "TOOLCHAIN"); }
    }
  }
}
function sameExecutableIdentity(left, right) {
  return Boolean(left && right) && ["realPath", "dev", "ino", "size", "mtimeMs", "sha256"].every((key) => left[key] === right[key]);
}
function closeAnvilDescriptor(identity) {
  if (!identity || typeof identity.fd !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(identity.fd) || identity.fdClosed === true) return;
  const fd = Number(identity.fd);
  identity.fdClosed = true;
  try { fs.closeSync(fd); } catch (_) { fail("ANVIL_DESCRIPTOR_CLOSE_FAILED", "TOOLCHAIN"); }
}
function verifyAnvilIdentity(pin, expectedIdentity) {
  const current = executableIdentity(pin);
  try {
    if (expectedIdentity && !sameExecutableIdentity(current, expectedIdentity)) fail("ANVIL_IDENTITY_CHANGED", "TOOLCHAIN");
    if (current.sha256 !== pin.sha256) fail("ANVIL_DIGEST_MISMATCH", "TOOLCHAIN");
    const probe = childProcess.spawnSync(current.execPath, ["--version"], { encoding: "utf8", windowsHide: true, shell: false, env: sanitizedChildEnvironment(), timeout: 10_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe", Number(current.fd)] });
    if (probe.error || probe.status !== 0 || probe.signal || typeof probe.stdout !== "string" || probe.stdout.trim() !== pin.version) fail("ANVIL_VERSION_MISMATCH", "TOOLCHAIN");
    return { absolutePath: true, sha256Matched: true, versionMatched: true, identity: current };
  } catch (error) { closeAnvilDescriptor(current); throw error; }
}
function validateAnvilIdentity(value) {
  if (!exactKeys(value, ["absolutePath", "sha256Matched", "versionMatched", "identity"]) || value.absolutePath !== true || value.sha256Matched !== true || value.versionMatched !== true || !value.identity || !["realPath", "dev", "ino", "size", "mtimeMs", "sha256", "fd", "execPath"].every((key) => typeof value.identity[key] === "string" && value.identity[key])) fail("ANVIL_IDENTITY_INVALID", "TOOLCHAIN");
  return value;
}

async function waitReady(child, localRpc, manifest) {
  const deadline = Date.now() + LIMITS.startupMs;
  while (Date.now() < deadline) {
    if (child?.exitCode != null || child?.signalCode != null) fail("ANVIL_EXITED_DURING_STARTUP", "ANVIL_START");
    try {
      const chainId = await localRpc.call("eth_chainId", []);
      if (BigInt(chainId || 0) !== BigInt(manifest.chainId)) fail("LOCAL_FORK_CHAIN_MISMATCH", "FORK_PIN");
      const block = await localRpc.call("eth_getBlockByNumber", [hexQuantity(manifest.pinBlockNumber), false]);
      if (!block || block.hash !== manifest.pinBlockHash || block.stateRoot !== manifest.pinStateRoot) fail("LOCAL_FORK_PIN_MISMATCH", "FORK_PIN");
      return;
    } catch (error) {
      if (error instanceof ForkError && error.code !== "LOCAL_RPC_UNAVAILABLE") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("ANVIL_STARTUP_TIMEOUT", "ANVIL_START");
}
const balanceOfData = (holder) => `0x70a08231${holder.slice(2).padStart(64, "0")}`;
async function captureWatch(localRpc, watch) {
  const rows = {};
  for (const entry of watch) {
    if (entry.token === NATIVE) rows[entry.id] = await localRpc.call("eth_getBalance", [entry.holder, "latest"]);
    else rows[entry.id] = await localRpc.call("eth_call", [{ to: entry.token, data: balanceOfData(entry.holder) }, "latest"]);
  }
  return rows;
}
function parseRaw(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/u.test(value)) fail("BALANCE_READ_INVALID", "STATE");
  return BigInt(value);
}
function parseReceiptQuantity(value, code, stage) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/u.test(value)) fail(code, stage);
  return BigInt(value);
}
async function executeCalls(localRpc, manifest, batch) {
  const actors = [...new Set(manifest.calls.map((call) => call.actor))];
  const gasCeiling = BigInt(batch.gasCeiling);
  let gasUsedTotal = 0n;
  let completed = false;
  try {
    for (const actor of actors) {
      await localRpc.call("anvil_setBalance", [actor, "0x21e19e0c9bab2400000"]);
      await localRpc.call("anvil_impersonateAccount", [actor]);
    }
    const snapshot = await localRpc.call("evm_snapshot", []);
    const before = await captureWatch(localRpc, manifest.watch);
    const receipts = [];
    for (const call of manifest.calls) {
      const gasLimit = BigInt(call.gasLimit);
      if (gasLimit < 1n || gasLimit > gasCeiling - gasUsedTotal) fail("GAS_CEILING_EXCEEDED", `CALL_${call.id}`);
      const hash = await localRpc.call("eth_sendTransaction", [{ from: call.actor, to: call.to, data: call.data, value: hexQuantity(call.valueWei), gas: hexQuantity(gasLimit) }]);
      if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/u.test(hash)) fail("TRANSACTION_HASH_INVALID", `CALL_${call.id}`);
      const receipt = await localRpc.call("eth_getTransactionReceipt", [hash]);
      if (!receipt || receipt.status !== "0x1") fail("FORK_CALL_REVERTED", `CALL_${call.id}`);
      const gasUsed = parseReceiptQuantity(receipt.gasUsed, "RECEIPT_GAS_INVALID", `CALL_${call.id}`);
      const effectiveGasPrice = parseReceiptQuantity(receipt.effectiveGasPrice, "RECEIPT_GAS_PRICE_INVALID", `CALL_${call.id}`);
      gasUsedTotal += gasUsed;
      if (gasUsed > gasLimit || gasUsedTotal > gasCeiling) fail("GAS_CEILING_EXCEEDED", `CALL_${call.id}`);
      receipts.push({ id: call.id, to: call.to, selector: call.data.slice(0, 10), gasUsed: hexQuantity(gasUsed), effectiveGasPrice: hexQuantity(effectiveGasPrice) });
    }
    const after = await captureWatch(localRpc, manifest.watch);
    const revertResult = await localRpc.call("evm_revert", [snapshot]);
    if (revertResult !== true) fail("SNAPSHOT_REVERT_UNCONFIRMED", "ROLLBACK");
    const invalidationProbe = await localRpc.call("evm_revert", [snapshot]);
    if (invalidationProbe !== false) fail("SNAPSHOT_INVALIDATION_UNCONFIRMED", "ROLLBACK");
    completed = true;
    const rolledBack = await captureWatch(localRpc, manifest.watch);
    const rollbackVerified = manifest.watch.every((entry) => parseRaw(rolledBack[entry.id]) === parseRaw(before[entry.id]));
    if (!rollbackVerified) fail("SNAPSHOT_ROLLBACK_MISMATCH", "ROLLBACK");
    return { before, after, rolledBack, receipts, gasUsedTotal, rollbackVerified };
  } finally {
    for (const actor of actors) {
      try {
        await localRpc.call("anvil_stopImpersonatingAccount", [actor]);
      } catch (_) {
        if (completed) fail("IMPERSONATION_CLEANUP_FAILED", "CHILD_CLEANUP");
      }
    }
  }
}
function computeDeltas(manifest, before, after) {
  return manifest.watch.map((entry) => {
    const beforeRaw = parseRaw(before[entry.id]);
    const afterRaw = parseRaw(after[entry.id]);
    return { id: entry.id, token: entry.token, holder: entry.holder, role: entry.role, decimals: entry.decimals, beforeRaw: beforeRaw.toString(), afterRaw: afterRaw.toString(), deltaRaw: (afterRaw - beforeRaw).toString() };
  });
}
function floorDiv(value, divisor) {
  let result = value / divisor;
  if (value < 0n && value % divisor !== 0n) result -= 1n;
  return result;
}
function ceilDiv(value, divisor) {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}
function parsePrice(value) {
  const [whole, fraction = ""] = value.split(".");
  return { numerator: BigInt(`${whole}${fraction}`), scale: 10n ** BigInt(fraction.length) };
}
function formatMicros(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
}
function nativeExecutionCostsCaptured(manifest, deltas) {
  const nativeAttackerHolders = new Set(deltas.filter((row) => row.role === "attacker" && row.token === NATIVE).map((row) => row.holder));
  return manifest.calls.every((call) => nativeAttackerHolders.has(call.actor));
}
function computeNetUsdEstimate(manifest, deltas, gasCostNativeWei) {
  const prices = new Map((manifest.pricesUsd || []).map((row) => [row.token, row.usdPerToken]));
  let totalMicros = 0n;
  for (const row of deltas) {
    if (row.role !== "attacker") continue;
    if (!prices.has(row.token)) return null;
    const price = parsePrice(prices.get(row.token));
    const denominator = (10n ** BigInt(row.decimals)) * price.scale;
    totalMicros += floorDiv(BigInt(row.deltaRaw) * price.numerator * 1_000_000n, denominator);
  }
  const nativeCostsCaptured = nativeExecutionCostsCaptured(manifest, deltas);
  const callValueNativeWei = manifest.calls.reduce((total, call) => total + BigInt(call.valueWei), 0n);
  const separateNativeCostWei = nativeCostsCaptured ? 0n : gasCostNativeWei + callValueNativeWei;
  if (separateNativeCostWei > 0n) {
    if (!prices.has(NATIVE)) return null;
    const nativePrice = parsePrice(prices.get(NATIVE));
    totalMicros -= ceilDiv(separateNativeCostWei * nativePrice.numerator * 1_000_000n, (10n ** 18n) * nativePrice.scale);
  }
  return { value: formatMicros(totalMicros), positive: totalMicros > 0n, nativeExecutionCostsCaptured: nativeCostsCaptured };
}
function baseOutput(manifest, scope, manifestCommitmentValue, context) {
  return {
    schema: OUTPUT_SCHEMA,
    generatedAt: new Date(context.nowMs).toISOString(),
    manifestId: manifest.manifestId,
    manifestCommitment: manifestCommitmentValue,
    batchCommitment: scope.batchCommitment,
    scopeCommitment: scope.scopeCommitment,
    approval: scope.approval,
    authorizationStateAtRun: "VALID",
    batchExpiresAt: context.batchExpiresAt,
    chainId: manifest.chainId,
    pinBlockNumber: manifest.pinBlockNumber,
    pinBlockHash: manifest.pinBlockHash,
    pinStateRoot: manifest.pinStateRoot,
    pinFinality: manifest.pinFinality,
    status: "FORK_VALIDATION_INCOMPLETE",
    classification: "INCOMPLETE",
    routePositive: "unknown",
    executableNow: false,
    signedActionJustified: false,
    routePromotion: false,
    estimateOnly: true,
    economicsComplete: false,
    identifiedObligationsComplete: false,
    slippageEnforced: false,
    approvedSlippageDeclarationsBps: context.slippageDeclarationsBps,
    priceAuthority: manifest.pricesUsd?.length ? "MANIFEST_DECLARED_UNVERIFIED" : "UNPRICED",
    upstreamQualification: null,
    calls: [],
    deltas: [],
    gasUsedTotal: null,
    gasCostNativeWei: null,
    netUsdEstimate: null,
    netPositiveEstimate: false,
    nativeExecutionCostsCapturedByBalanceDeltas: false,
    watchedStateRollbackVerified: false,
    preStateWatchCommitment: null,
    postStateWatchCommitment: null,
    rollbackStateWatchCommitment: null,
    relay: null,
    localRpc: null,
    cleanup: { child: "NOT_STARTED", relay: "NOT_STARTED" },
    safety: { localForkOnly: true, keyless: true, signing: false, actorMode: "SYNTHETIC_IMPERSONATION", batchAccountUsedForSigning: false, syntheticChanges: ["ACTOR_NATIVE_BALANCE_FUNDED", "ACTOR_IMPERSONATED"], localForkTransactions: "0", liveTransactions: "0", broadcasts: "0", upstreamTransactions: "0", retries: "0", endpointMaterialPersisted: false },
  };
}

async function runForkValidation(options = {}) {
  if (Object.hasOwn(options, "batchPath")) fail("RUNNER_BATCH_PATH_OVERRIDE_REJECTED", "AUTHORIZATION");
  const expectationNames = ["expectedManifestBytesSha256", "expectedManifestCommitment", "expectedBatchCommitment"];
  const expectationCount = expectationNames.filter((name) => Object.hasOwn(options, name)).length;
  if (expectationCount !== 0 && expectationCount !== expectationNames.length) fail("RUNNER_EXPECTATIONS_INCOMPLETE", "AUTHORIZATION");
  if (expectationCount === expectationNames.length && expectationNames.some((name) => typeof options[name] !== "string" || !/^0x[0-9a-f]{64}$/u.test(options[name]))) fail("RUNNER_EXPECTATION_INVALID", "AUTHORIZATION");
  const io = options.io || fs;
  const now = options.now || Date.now;
  const deps = { ...defaultDeps(), ...(options.deps || {}) };
  const manifestPath = options.manifestPath;
  if (typeof manifestPath !== "string" || !manifestPath) fail("MANIFEST_REQUIRED", "MANIFEST");
  let manifestBytes;
  try {
    manifestBytes = io.readFileSync(manifestPath);
  } catch (_) {
    fail("MANIFEST_READ_FAILED", "MANIFEST");
  }
  if (!Buffer.isBuffer(manifestBytes)) manifestBytes = Buffer.from(manifestBytes);
  if (manifestBytes.length > LIMITS.manifestBytes) fail("MANIFEST_SIZE_INVALID", "MANIFEST");
  if (expectationCount && sha256(manifestBytes) !== options.expectedManifestBytesSha256) fail("MANIFEST_BYTES_COMMITMENT_MISMATCH", "AUTHORIZATION");
  let rawManifest;
  try { rawManifest = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes); }
  catch (_) { fail("MANIFEST_UTF8_INVALID", "MANIFEST"); }
  let manifest;
  try {
    manifest = JSON.parse(rawManifest);
  } catch (_) {
    fail("MANIFEST_JSON_INVALID", "MANIFEST");
  }
  validateManifest(manifest);
  const manifestCommitmentValue = manifestCommitment(manifest);
  if (expectationCount && manifestCommitmentValue !== options.expectedManifestCommitment) fail("MANIFEST_SEMANTIC_COMMITMENT_MISMATCH", "AUTHORIZATION");
  const authorization = await deps.loadAuthorization({ now });
  const scope = scopeCheck(authorization, manifest);
  if (!scope.ok) fail(scope.state === "VALID" ? scope.reason : `BATCH_NOT_VALID:${scope.state}${scope.reason ? `:${scope.reason}` : ""}`, "AUTHORIZATION");
  if (expectationCount && (scope.batchCommitment !== batchTool.commitment(authorization.batch) || scope.batchCommitment !== options.expectedBatchCommitment)) fail("BATCH_EXPECTED_COMMITMENT_MISMATCH", "AUTHORIZATION");
  const outPath = options.outPath || defaultOutPath(manifest.manifestId);
  const runId = typeof options.runId === "string" ? options.runId : crypto.randomUUID();
  const output = baseOutput(manifest, scope, manifestCommitmentValue, { nowMs: now(), batchExpiresAt: authorization.batch.expiresAt, slippageDeclarationsBps: authorization.batch.actions.map((action) => action.slippageBps) });
  let relay = null, child = null, localRpc = null, ownedAnvilIdentity = null;
  const cleanupFailures = [];
  try {
    const preflightIdentity = validateAnvilIdentity(await deps.verifyAnvilIdentity(authorization.batch.anvil));
    if (deps.verifyAnvilIdentity === verifyAnvilIdentity) ownedAnvilIdentity = preflightIdentity.identity;
    const upstreamUrl = await deps.resolveUpstream(manifest.chainId);
    if (!upstreamUrl) fail("UPSTREAM_UNAVAILABLE", "UPSTREAM");
    output.upstreamQualification = validateUpstreamQualification(await deps.qualifyUpstream(upstreamUrl, manifest));
    relay = await createReadOnlyRelay({ upstreamUrl, transport: deps.transport, limits: LIMITS });
    const localPort = await deps.freePort();
    child = await deps.startAnvil(authorization.batch.anvil, preflightIdentity.identity, buildAnvilArgs(relay.port, localPort, manifest.chainId, manifest.pinBlockNumber), sanitizedChildEnvironment());
    if (ownedAnvilIdentity) { closeAnvilDescriptor(ownedAnvilIdentity); ownedAnvilIdentity = null; }
    localRpc = deps.createLocalRpc(localPort);
    await waitReady(child, localRpc, manifest);
    const authorizationRecheck = await deps.loadAuthorization({ now });
    const scopeRecheck = scopeCheck(authorizationRecheck, manifest);
    if (!scopeRecheck.ok) fail(`BATCH_RECHECK_NOT_VALID:${scopeRecheck.state}:${scopeRecheck.reason}`, "AUTHORIZATION");
    if (scopeRecheck.batchCommitment !== scope.batchCommitment) fail("BATCH_RECHECK_COMMITMENT_MISMATCH", "AUTHORIZATION");
    const consumed = await deps.consumeAuthorization({ expectedBatchCommitment: scope.batchCommitment, manifestCommitment: manifestCommitmentValue, runId, now });
    if (!consumed || consumed.state !== batchTool.STATES.CONSUMED || consumed.batchCommitment !== scope.batchCommitment || consumed.manifestCommitment !== manifestCommitmentValue || consumed.runId !== runId) fail("BATCH_CONSUMPTION_INVALID", "AUTHORIZATION");
    output.authorizationStateAtRun = "CONSUMED";
    const execution = await executeCalls(localRpc, manifest, authorization.batch);
    output.calls = execution.receipts;
    output.deltas = computeDeltas(manifest, execution.before, execution.after);
    output.preStateWatchCommitment = sha256(canonical(execution.before));
    output.postStateWatchCommitment = sha256(canonical(execution.after));
    output.rollbackStateWatchCommitment = sha256(canonical(execution.rolledBack));
    const gasUsedTotal = execution.gasUsedTotal;
    const gasCostNativeWei = execution.receipts.reduce((acc, row) => acc + BigInt(row.gasUsed) * BigInt(row.effectiveGasPrice), 0n);
    output.gasUsedTotal = gasUsedTotal.toString();
    output.gasCostNativeWei = gasCostNativeWei.toString();
    const netEstimate = computeNetUsdEstimate(manifest, output.deltas, gasCostNativeWei);
    output.netUsdEstimate = netEstimate?.value || null;
    output.netPositiveEstimate = netEstimate?.positive === true;
    output.nativeExecutionCostsCapturedByBalanceDeltas = nativeExecutionCostsCaptured(manifest, output.deltas);
    output.watchedStateRollbackVerified = execution.rollbackVerified;
    output.safety.localForkTransactions = String(execution.receipts.length);
    output.status = "FORK_VALIDATION_COMPLETE";
    output.classification = output.netPositiveEstimate ? "INCOMPLETE_UNVERIFIED_ESTIMATE_POSITIVE" : "INCOMPLETE_UNVERIFIED_ESTIMATE_NONPOSITIVE_OR_UNPRICED";
    output.relay = relay.stats();
    output.localRpc = localRpc.stats();
    return { output, outPath };
  } catch (error) {
    output.firstFailure = error instanceof ForkError ? { stage: error.stage, code: error.code } : { stage: "UNCLASSIFIED", code: "UNEXPECTED_FAILURE" };
    output.classification = "INCOMPLETE";
    throw Object.assign(error, { output, outPath });
  } finally {
    if (ownedAnvilIdentity) { try { closeAnvilDescriptor(ownedAnvilIdentity); } catch (_) { cleanupFailures.push("ANVIL_DESCRIPTOR_CLOSE_FAILED"); } }
    if (child) {
      try {
        await deps.stopAnvil(child);
        if (output) output.cleanup.child = "STOPPED";
      } catch (error) {
        cleanupFailures.push(error instanceof ForkError ? error.code : "CHILD_CLEANUP_FAILED");
        if (output) output.cleanup.child = "FAILED";
      }
    }
    if (relay) {
      try {
        await relay.close();
        if (output) output.cleanup.relay = "CLOSED";
      } catch (error) {
        cleanupFailures.push(error instanceof ForkError ? error.code : "RELAY_CLEANUP_FAILED");
        if (output) output.cleanup.relay = "FAILED";
      }
    }
    if (cleanupFailures.length && output) {
      output.cleanupFailures = cleanupFailures;
      output.status = "FORK_VALIDATION_INCOMPLETE";
      output.classification = `INCOMPLETE / CLEANUP / ${cleanupFailures[0]}`;
    }
  }
}

function usage() {
  fail("USAGE_ERROR", "CLI");
}
function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) usage();
    if (name === "--manifest") options.manifestPath = value;
    else if (name === "--out") options.outPath = value;
    else usage();
  }
  if (!options.manifestPath) usage();
  return options;
}
async function runCli(argv = process.argv) {
  try {
    const options = parseArgs(argv.slice(2));
    const { output, outPath } = await runForkValidation(options);
    const bytes = writeOnce(outPath, output);
    process.stdout.write(`${JSON.stringify({ status: output.status, classification: output.classification, artifact: path.relative(ROOT, outPath), bytes: String(bytes.length), netUsdEstimate: output.netUsdEstimate, netPositiveEstimate: output.netPositiveEstimate })}\n`);
    if (output.status !== "FORK_VALIDATION_COMPLETE") process.exitCode = 1;
  } catch (error) {
    const output = error?.output;
    if (output && error?.outPath) {
      try {
        writeOnce(error.outPath, output);
      } catch (_) {
        /* retain original failure */
      }
    }
    process.stdout.write(`${JSON.stringify({ status: "FAIL_CLOSED", blocker: error instanceof ForkError ? error.code : "INTERNAL_FAILURE_REDACTED" })}\n`);
    process.exitCode = 1;
  }
}
if (require.main === module) runCli();

module.exports = {
  ROOT,
  OUT_DIR,
  MANIFEST_SCHEMA,
  OUTPUT_SCHEMA,
  LIMITS,
  ForkError,
  fail,
  canonical,
  leakGuard,
  sanitizeRpcDetail,
  UPSTREAM_METHODS,
  validateManifest,
  minimumBalanceWatch,
  calldataWatchAddresses,
  manifestCommitment,
  scopeCheck,
  createReadOnlyRelay,
  sanitizedChildEnvironment,
  freePort,
  stopAnvil,
  buildAnvilArgs,
  createLocalRpc,
  readResponseBody,
  defaultTransport,
  qualifyUpstream,
  validateUpstreamQualification,
  executableIdentity,
  sameExecutableIdentity,
  closeAnvilDescriptor,
  verifyAnvilIdentity,
  validateAnvilIdentity,
  defaultDeps,
  waitReady,
  captureWatch,
  executeCalls,
  computeDeltas,
  nativeExecutionCostsCaptured,
  computeNetUsdEstimate,
  runForkValidation,
  parseArgs,
  writeOnce,
  runCli,
};
