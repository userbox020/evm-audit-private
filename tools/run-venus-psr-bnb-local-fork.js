#!/usr/bin/env node
"use strict";

const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { spawn } = require("node:child_process");

const capture = require("./capture-venus-psr-bnb-fixed-block.js");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const FIXED_ARTIFACT_PATH = path.join(ROOT, "reports", "raw", "fast", "venus-psr-bnb-fixed-block.json");
const ALLOWED_OUTPUT_PATH = path.join(ROOT, "reports", "raw", "fast", "venus-psr-bnb-local-fork.json");
const INPUT_SCHEMA = "venus-psr-fixed-block/v1";
const OUTPUT_SCHEMA = "venus-psr-local-fork/v1";
const EXPECTED_PSR = "0xca01d5a9a248a830e9d93231e791b1affed7c446";
// Publicly derived from a fixed audit-only phrase; no private key exists or is used by this runner.
const ACTOR = "0xc1d45ea9613098278947f0e5d5ea5bd5e737e3a3";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const LIMITS = Object.freeze({
  upstreamQualificationRequests: 8,
  localhostRequests: 32,
  localhostElements: 64,
  totalRuntimeMs: 180_000,
  anvilStartMs: 30_000,
  rpcTimeoutMs: 30_000,
  responseBytes: 512 * 1024,
  relayRequests: 512,
  relayElements: 4_096,
  relayBodyBytes: 256 * 1024,
  readinessAttempts: 20,
  readinessBackoffMs: 100,
  cleanupMs: 5_000,
  childStderrBytes: 16 * 1024,
});

const SELECTORS = Object.freeze({
  psrUpdateAssetsState: "0x16faecec", // updateAssetsState(address,address,uint8)
  destinationUpdateAssetsState: "0xaac59a75", // updateAssetsState(address,address)
  executeBuyback: "0x9b0b8b4b", // executeBuyback(address,uint256,uint256,uint256,address,bytes,address)
  forwardBaseAsset: "0xf8e5d56d", // forwardBaseAsset(address,uint256)
  sweepToken: "0x64aff9ec", // sweepToken(address,address,uint256)
  protocolShareReserve: "0xccd42596", // PROTOCOL_SHARE_RESERVE()
});

const ACL_SELECTORS = Object.freeze({
  UnauthorizedCaller: "0xd86ad9cf",
  Unauthorized: "0x4a3fa293",
  OwnableUnauthorizedAccount: "0x118cdaa7",
  ErrorString: "0x08c379a0",
});

const KNOWN_ERROR_CLASSES = Object.freeze({
  OwnableCallerNotOwnerOZ4: "OWNABLE_CALLER_NOT_OWNER_OZ4",
});

const UPSTREAM_METHODS = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getStorageAt",
]);
const LOCAL_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
]);

const RELAY_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getBalance", "eth_getTransactionCount",
  "eth_getLogs", "eth_feeHistory", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_getProof",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockReceipts", "net_version",
  "eth_getBlockTransactionCountByHash", "eth_getBlockTransactionCountByNumber",
  "eth_getTransactionByBlockHashAndIndex", "eth_getTransactionByBlockNumberAndIndex",
  "eth_getUncleCountByBlockHash", "eth_getUncleCountByBlockNumber",
  "eth_getUncleByBlockHashAndIndex", "eth_getUncleByBlockNumberAndIndex",
  "eth_syncing", "eth_getAccountInfo", "net_listening", "web3_clientVersion",
]);

class SafeError extends Error {
  constructor(stage, errorClass) {
    super(errorClass);
    this.name = "SafeError";
    this.stage = stage;
    this.errorClass = errorClass;
  }
}

function safeError(stage, errorClass) {
  return new SafeError(stage, errorClass);
}

function sanitizedFailure(error) {
  if (!(error instanceof SafeError)) return { stage: "internal", errorClass: "UNEXPECTED" };
  const failure = { stage: error.stage, errorClass: error.errorClass };
  if (Number.isInteger(error.childExitCode) && error.childExitCode >= -255 && error.childExitCode <= 255) {
    failure.childExitCode = error.childExitCode;
  }
  if (Array.isArray(error.qualificationFailures)) {
    failure.qualificationFailures = error.qualificationFailures.map((entry) => ({
      candidateOrdinal: entry.candidateOrdinal,
      stage: entry.stage,
      errorClass: entry.errorClass,
    }));
  }
  return failure;
}

function assertMethod(scope, method) {
  const allowed = scope === "upstream" ? UPSTREAM_METHODS : LOCAL_METHODS;
  if (!allowed.has(method)) throw safeError("rpc_method", "FORBIDDEN_METHOD");
  if (/^(eth_send|personal_|wallet_|debug_|anvil_|hardhat_|evm_)/i.test(method)) {
    throw safeError("rpc_method", "FORBIDDEN_METHOD");
  }
}

function assertLocalTarget(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw safeError("localhost", "INVALID_LOCAL_TARGET");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw safeError("localhost", "NON_LOCAL_TARGET");
  }
}

function providerMarkers(endpoint) {
  try {
    const parsed = new URL(endpoint);
    const markers = new Set([endpoint, parsed.href, parsed.origin, parsed.hostname]);
    if (parsed.username) markers.add(parsed.username);
    if (parsed.password) markers.add(parsed.password);
    for (const segment of `${parsed.pathname}${parsed.search}`.split(/[^A-Za-z0-9._~-]+/)) {
      if (segment.length >= 6) markers.add(segment);
    }
    return [...markers].filter((value) => value.length >= 4);
  } catch {
    throw safeError("endpoint", "INVALID_ENDPOINT");
  }
}

function rejectReflection(text, endpoint) {
  const lower = text.toLowerCase();
  if (providerMarkers(endpoint).some((marker) => lower.includes(marker.toLowerCase()))) {
    throw safeError("response", "PROVIDER_REFLECTION");
  }
}

function errorSelector(data) {
  return typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)
    ? data.slice(0, 10).toLowerCase()
    : null;
}

function classifyKnownErrorData(data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]+$/.test(data)) return null;
  const normalized = data.toLowerCase();
  if (!normalized.startsWith(ACL_SELECTORS.ErrorString)) return null;
  const body = normalized.slice(10);
  if (body.length < 128 || body.length % 64 !== 0) return null;
  const offset = BigInt(`0x${body.slice(0, 64)}`);
  const length = BigInt(`0x${body.slice(64, 128)}`);
  const expected = Buffer.from("Ownable: caller is not the owner", "utf8");
  if (offset !== 32n || length !== BigInt(expected.length)) return null;
  const paddedBytes = Math.ceil(expected.length / 32) * 32;
  if (body.length !== 128 + paddedBytes * 2) return null;
  const encodedString = Buffer.from(body.slice(128, 128 + expected.length * 2), "hex");
  const padding = body.slice(128 + expected.length * 2);
  if (!encodedString.equals(expected) || !/^0*$/.test(padding)) return null;
  return KNOWN_ERROR_CLASSES.OwnableCallerNotOwnerOZ4;
}

async function defaultRpcBatch({ endpoint, calls, timeoutMs }) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw safeError("endpoint", "INVALID_ENDPOINT");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw safeError("endpoint", "UNSUPPORTED_PROTOCOL");
  }
  const payload = calls.map((call, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: call.method,
    params: call.params,
  }));
  const body = JSON.stringify(payload.length === 1 ? payload[0] : payload);
  const transport = parsed.protocol === "https:" ? https : http;
  const text = await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (errorClass) => {
      if (settled) return;
      settled = true;
      reject(safeError("transport", errorClass));
    };
    const request = transport.request(parsed, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > LIMITS.responseBytes) {
          request.destroy();
          fail("RESPONSE_TOO_LARGE");
        } else {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        if (settled) return;
        if (response.statusCode !== 200) return fail("HTTP_STATUS");
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      response.on("error", () => fail("NETWORK"));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      fail("TIMEOUT");
    });
    request.on("error", () => fail("NETWORK"));
    request.end(body);
  });
  rejectReflection(text, endpoint);
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw safeError("response", "MALFORMED_JSON");
  }
  const rows = Array.isArray(decoded) ? decoded : [decoded];
  if (rows.length !== payload.length) throw safeError("response", "BATCH_SHAPE");
  const byId = new Map(rows.map((row) => [row?.id, row]));
  return payload.map((request) => {
    const row = byId.get(request.id);
    if (!row || row.jsonrpc !== "2.0") throw safeError("response", "INVALID_ENVELOPE");
    if (row.error) {
      return {
        ok: false,
        errorClass: "RPC_REVERT_OR_ERROR",
        errorSelector: errorSelector(row.error.data),
        knownErrorClass: classifyKnownErrorData(row.error.data),
      };
    }
    if (!Object.prototype.hasOwnProperty.call(row, "result")) throw safeError("response", "MISSING_RESULT");
    return { ok: true, result: row.result };
  });
}

function relayForbidden(method) {
  return typeof method !== "string"
    || !RELAY_METHODS.has(method)
    || /^(eth_send|personal_|wallet_|debug_|admin_|miner_|txpool_|anvil_|hardhat_|evm_)/i.test(method);
}

function safeRelayMethodName(method) {
  return typeof method === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(method)
    ? method
    : "INVALID";
}

function recordRejectedRelayMethod(counters, method) {
  const safeName = safeRelayMethodName(method);
  counters.rejectedMethodCounts[safeName] = (counters.rejectedMethodCounts[safeName] || 0) + 1;
}

function recordUpstreamErrorMethod(counters, method) {
  const safeName = safeRelayMethodName(method);
  counters.upstreamErrorMethodCounts[safeName] = (counters.upstreamErrorMethodCounts[safeName] || 0) + 1;
}

function relayCounterSnapshot(counters) {
  return {
    requests: counters.requests,
    elements: counters.elements,
    forwardedRequests: counters.forwardedRequests,
    forwardedElements: counters.forwardedElements,
    rejectedElements: counters.rejectedElements,
    submissionAttemptsRejected: counters.submissionAttemptsRejected,
    rejectedMethods: Object.fromEntries(
      Object.entries(counters.rejectedMethodCounts || {}).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0),
    ),
    upstreamErrorMethods: Object.fromEntries(
      Object.entries(counters.upstreamErrorMethodCounts || {}).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0),
    ),
  };
}

function relayError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function defaultRelayForward({ endpoint, payload, timeoutMs }) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw safeError("relay_upstream", "INVALID_ENDPOINT");
  }
  const body = JSON.stringify(payload);
  const transport = parsed.protocol === "https:" ? https : http;
  const text = await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (errorClass) => {
      if (settled) return;
      settled = true;
      reject(safeError("relay_upstream", errorClass));
    };
    const request = transport.request(parsed, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > LIMITS.responseBytes) {
          request.destroy();
          fail("RESPONSE_TOO_LARGE");
        } else chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        if (response.statusCode !== 200) return fail("HTTP_STATUS");
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      response.on("error", () => fail("NETWORK"));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      fail("TIMEOUT");
    });
    request.on("error", () => fail("NETWORK"));
    request.end(body);
  });
  rejectReflection(text, endpoint);
  try {
    return JSON.parse(text);
  } catch {
    throw safeError("relay_upstream", "MALFORMED_JSON");
  }
}

async function startLocalRelay(upstreamEndpoint, options = {}, dependencies = {}) {
  const forward = dependencies.relayForward || defaultRelayForward;
  const counters = {
    requests: 0,
    elements: 0,
    forwardedRequests: 0,
    forwardedElements: 0,
    rejectedElements: 0,
    submissionAttemptsRejected: 0,
    rejectedMethodCounts: Object.create(null),
    upstreamErrorMethodCounts: Object.create(null),
  };
  const requestCap = Math.min(options.relayRequestCap || LIMITS.relayRequests, LIMITS.relayRequests);
  const elementCap = Math.min(options.relayElementCap || LIMITS.relayElements, LIMITS.relayElements);
  const server = http.createServer((request, response) => {
    const finish = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST") {
      finish(405, relayError(null, -32600, "invalid request"));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > LIMITS.relayBodyBytes) {
        rejected = true;
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", async () => {
      if (rejected) return;
      let decoded;
      try {
        decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        finish(400, relayError(null, -32700, "parse error"));
        return;
      }
      const batch = Array.isArray(decoded);
      const rows = batch ? decoded : [decoded];
      counters.requests += 1;
      counters.elements += rows.length;
      if (rows.length === 0 || counters.requests > requestCap || counters.elements > elementCap) {
        counters.rejectedElements += rows.length;
        for (const row of rows) recordRejectedRelayMethod(counters, row?.method);
        const errors = rows.map((row) => relayError(row?.id, -32005, "relay cap"));
        finish(200, batch ? errors : errors[0]);
        return;
      }
      const allowed = [];
      const blocked = new Map();
      for (const row of rows) {
        if (!row || row.jsonrpc !== "2.0" || relayForbidden(row.method)) {
          counters.rejectedElements += 1;
          recordRejectedRelayMethod(counters, row?.method);
          if (typeof row?.method === "string"
            && /^(eth_send|personal_|wallet_|anvil_|hardhat_|evm_|debug_|admin_)/i.test(row.method)) {
            counters.submissionAttemptsRejected += 1;
          }
          blocked.set(row?.id, relayError(row?.id, -32601, "method not allowed"));
        } else allowed.push(row);
      }
      let forwardedById = new Map();
      if (allowed.length > 0) {
        try {
          counters.forwardedRequests += 1;
          counters.forwardedElements += allowed.length;
          const forwarded = await forward({
            endpoint: upstreamEndpoint,
            payload: batch ? allowed : allowed[0],
            timeoutMs: LIMITS.rpcTimeoutMs,
          });
          const forwardedRows = Array.isArray(forwarded) ? forwarded : [forwarded];
          const allowedById = new Map(allowed.map((row) => [row.id, row.method]));
          for (const responseRow of forwardedRows) {
            if (responseRow && Object.prototype.hasOwnProperty.call(responseRow, "error")) {
              recordUpstreamErrorMethod(counters, allowedById.get(responseRow.id));
            }
          }
          forwardedById = new Map(forwardedRows.map((row) => [row?.id, row]));
        } catch {
          for (const row of allowed) forwardedById.set(row.id, relayError(row.id, -32000, "upstream unavailable"));
        }
      }
      const merged = rows.map((row) => blocked.get(row?.id)
        || forwardedById.get(row?.id)
        || relayError(row?.id, -32000, "upstream response missing"));
      finish(200, batch ? merged : merged[0]);
    });
    request.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  let closed = false;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    counters,
    close: async () => {
      if (closed) return true;
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      closed = true;
      return true;
    },
    isClosed: () => closed,
  };
}

function isHex(value, bytes = null) {
  return typeof value === "string"
    && /^0x[0-9a-fA-F]*$/.test(value)
    && value.length % 2 === 0
    && (bytes === null || value.length === 2 + bytes * 2);
}

function address(value, stage) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw safeError(stage, "INVALID_ADDRESS");
  }
  return value.toLowerCase();
}

function quantity(value, stage) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw safeError(stage, "INVALID_QUANTITY");
  }
  return BigInt(value);
}

function blockResult(value, stage) {
  if (!value || typeof value !== "object") throw safeError(stage, "MISSING_BLOCK");
  if (!isHex(value.hash, 32)) throw safeError(stage, "INVALID_BLOCK_HASH");
  return { number: quantity(value.number, stage), hash: value.hash.toLowerCase() };
}

function containsProviderMaterial(value, key = "") {
  if (/^(endpoint|rpcUrl|providerUrl|headers)$/i.test(key)) return true;
  if (typeof value === "string") return /(?:https?|wss?):\/\//i.test(value);
  if (Array.isArray(value)) return value.some((entry) => containsProviderMaterial(entry));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([childKey, entry]) => containsProviderMaterial(entry, childKey));
  }
  return false;
}

function validateFixedArtifact(raw) {
  if (!raw || typeof raw !== "object" || raw.schema !== INPUT_SCHEMA) throw safeError("artifact", "SCHEMA_MISMATCH");
  if (containsProviderMaterial(raw)) throw safeError("artifact", "PROVIDER_MATERIAL_PRESENT");
  if (raw.chain?.chainId !== 56) throw safeError("artifact", "WRONG_CHAIN");
  if (raw.routePositive !== "unknown") throw safeError("artifact", "ROUTE_NOT_UNKNOWN");
  const selected = raw.chain?.selectedFinalizedBlock;
  const terminal = raw.chain?.terminalRecheck;
  if (!Number.isSafeInteger(selected?.number) || selected.number < 0 || !isHex(selected?.hash, 32)) {
    throw safeError("artifact", "INVALID_FIXED_BLOCK");
  }
  if (terminal?.exactHashMatch !== true || terminal.hash?.toLowerCase() !== selected.hash.toLowerCase()
    || terminal.number !== selected.number) {
    throw safeError("artifact", "TERMINAL_HASH_MISMATCH");
  }
  const psr = address(raw.candidate?.protocolShareReserve, "artifact_psr");
  if (psr !== EXPECTED_PSR) throw safeError("artifact", "PSR_MISMATCH");
  const rows = raw.distribution?.rows;
  const classifications = raw.destinationClassifications;
  if (!raw.distribution?.complete || !Array.isArray(rows) || !Array.isArray(classifications)
    || raw.distribution.reportedTotal !== rows.length || raw.distribution.capturedTotal !== rows.length) {
    throw safeError("artifact", "DISTRIBUTION_INCOMPLETE");
  }
  if (rows.length > 32) throw safeError("artifact", "DISTRIBUTION_CAP");
  const sums = { 0: 0, 1: 0 };
  const positiveList = [];
  for (const row of rows) {
    if (row.schema !== 0 && row.schema !== 1) throw safeError("artifact", "INVALID_SCHEMA");
    if (!Number.isInteger(row.percentage) || row.percentage < 0 || row.percentage > 10_000) {
      throw safeError("artifact", "INVALID_PERCENTAGE");
    }
    const destination = address(row.destination, "artifact_destination");
    if (destination === ZERO_ADDRESS) throw safeError("artifact", "ZERO_DESTINATION");
    sums[row.schema] += row.percentage;
    if (row.percentage > 0) positiveList.push(destination);
  }
  for (const schema of [0, 1]) {
    if (sums[schema] !== 0 && sums[schema] !== 10_000) throw safeError("artifact", "INVALID_SCHEMA_SUM");
  }
  const positive = [...new Set(positiveList)];
  if (positive.length > 20) throw safeError("artifact", "DESTINATION_CAP");
  const classMap = new Map();
  for (const record of classifications) {
    const destination = address(record.destination, "artifact_classification");
    if (classMap.has(destination) || typeof record.classification !== "string") {
      throw safeError("artifact", "CLASSIFICATION_SET_MISMATCH");
    }
    classMap.set(destination, record.classification);
  }
  if (classMap.size !== positive.length || positive.some((destination) => !classMap.has(destination))) {
    throw safeError("artifact", "CLASSIFICATION_SET_MISMATCH");
  }
  const core = address(raw.getters?.CORE_POOL_COMPTROLLER?.value, "artifact_core");
  const wbnb = address(raw.getters?.WBNB?.value, "artifact_wbnb");
  return {
    blockNumber: selected.number,
    blockHash: selected.hash.toLowerCase(),
    blockNumberHex: `0x${selected.number.toString(16)}`,
    psr,
    core,
    wbnb,
    destinations: positive.map((destination) => ({ destination, classification: classMap.get(destination) })),
  };
}

function wordAddress(value) {
  return address(value, "calldata_address").slice(2).padStart(64, "0");
}

function wordUint(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function callData(selector, ...words) {
  return `${selector}${words.join("")}`;
}

function harmlessExecuteBuybackCallData() {
  return callData(
    SELECTORS.executeBuyback,
    wordAddress(ZERO_ADDRESS),
    wordUint(0),
    wordUint(0),
    wordUint(0),
    wordAddress(ZERO_ADDRESS),
    wordUint(7 * 32),
    wordAddress(ZERO_ADDRESS),
    wordUint(0),
  );
}

function decodeAddressResult(result) {
  if (!isHex(result, 32) || !/^0x0{24}[0-9a-fA-F]{40}$/.test(result)) return null;
  return `0x${result.slice(-40).toLowerCase()}`;
}

function sanitizedCall(row) {
  return row?.ok
    ? { success: true, reverted: false, errorClass: null, errorSelector: null, knownErrorClass: null }
    : {
      success: false,
      reverted: true,
      errorClass: row?.errorClass || "RPC_REVERT_OR_ERROR",
      errorSelector: row?.errorSelector || null,
      knownErrorClass: row?.knownErrorClass || null,
    };
}

function authorizationControl(row, proof) {
  const call = sanitizedCall(row);
  const authorizationProtected = call.reverted
    && (
      (call.errorSelector !== null && proof.selectors?.has(call.errorSelector))
      || (call.knownErrorClass !== null && proof.knownErrorClasses?.has(call.knownErrorClass))
    );
  return { ...call, authorizationProtected };
}

function buildAnvilArgs(relayEndpoint, blockNumber) {
  return [
    "--fork-url", relayEndpoint,
    "--fork-block-number", String(blockNumber),
    "--host", "127.0.0.1",
    "--port", "0",
    "--chain-id", "56",
  ];
}

function defaultSpawnAnvil({ relayEndpoint, blockNumber }) {
  return spawn("anvil", buildAnvilArgs(relayEndpoint, blockNumber), {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
}

function childExited(child) {
  return Boolean(child) && (
    (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function waitForChildExit(child, milliseconds) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(childExited(child)), milliseconds);
    child.once("exit", () => finish(true));
    child.once("close", () => finish(true));
  });
}

async function defaultForceKillTree(child, platform = process.platform) {
  if (platform === "win32" && Number.isInteger(child?.pid)) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    await waitForChildExit(killer, 1_000);
  } else if (child && !childExited(child)) child.kill("SIGKILL");
}

async function terminateChildProcess(child, dependencies = {}) {
  if (!child) return true;
  if (childExited(child)) return true;
  const forceKillTree = dependencies.forceKillTree || defaultForceKillTree;
  try { child.kill("SIGTERM"); } catch {}
  if (await waitForChildExit(child, 750)) return true;
  await forceKillTree(child, dependencies.platform || process.platform);
  return waitForChildExit(child, 1_500);
}

function parseAnvilPortFromText(text) {
  const match = /(?:Listening on|listening on)\s+127\.0\.0\.1:(\d{1,5})/.exec(text);
  if (!match) return null;
  const port = Number(match[1]);
  return port > 0 && port <= 65_535 ? port : null;
}

function scrubChildStderrForClassification(text) {
  return String(text)
    .replace(/https?:\/\/[^\s"'<>]+/gi, " ")
    .replace(/\b(?:api[_-]?key|token|secret|credential|authorization|bearer|password|username|user)\s*[:=]\s*[^\s]+/gi, " ")
    .slice(-LIMITS.childStderrBytes);
}

function classifyAnvilStartFailure(text) {
  const safe = scrubChildStderrForClassification(text);
  if (/missing trie node|historical state.{0,40}(?:unavailable|missing)|archive state|pruned state|state.{0,30}pruned/i.test(safe)) {
    return "ARCHIVE_STATE_UNAVAILABLE";
  }
  if (/fork block.{0,40}(?:not found|unavailable|missing)|failed to (?:get|fetch) block|unknown block/i.test(safe)) {
    return "FORK_BLOCK_UNAVAILABLE";
  }
  if (/invalid chain response|invalid chain id|chain id.{0,30}(?:invalid|mismatch)|failed to decode chain/i.test(safe)) {
    return "INVALID_CHAIN_RESPONSE";
  }
  if (/-32601|method.{0,30}(?:not found|unsupported)|unsupported.{0,20}method/i.test(safe)) {
    return "UPSTREAM_METHOD_UNSUPPORTED";
  }
  if (/-320\d\d|upstream.{0,40}(?:rpc|error)|rpc error|server error/i.test(safe)) {
    return "UPSTREAM_RPC_ERROR";
  }
  return "ANVIL_UNKNOWN_START_FAILURE";
}

function captureBoundedAnvilStderr(child) {
  let captured = Buffer.alloc(0);
  const onData = (chunk) => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    captured = Buffer.concat([captured, incoming]);
    if (captured.length > LIMITS.childStderrBytes) captured = captured.subarray(captured.length - LIMITS.childStderrBytes);
  };
  if (child?.stderr && typeof child.stderr.on === "function") child.stderr.on("data", onData);
  return {
    classify: () => classifyAnvilStartFailure(captured.toString("utf8")),
    bufferedBytes: () => captured.length,
    stop: () => {
      if (child?.stderr && typeof child.stderr.removeListener === "function") child.stderr.removeListener("data", onData);
      captured.fill(0);
      captured = Buffer.alloc(0);
    },
  };
}

function awaitAnvilPort(child, milliseconds) {
  if (!child?.stdout || typeof child.stdout.on !== "function") {
    return Promise.reject(safeError("anvil", "ANVIL_STDOUT_UNAVAILABLE"));
  }
  return new Promise((resolve, reject) => {
    let captured = "";
    let settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve(port);
    };
    const onData = (chunk) => {
      captured = `${captured}${chunk.toString("utf8")}`.slice(-8_192);
      const port = parseAnvilPortFromText(captured);
      if (port) finish(null, port);
    };
    const onError = () => finish(safeError("anvil", "ANVIL_SPAWN_FAILED"));
    const onExit = () => finish(safeError("anvil", "ANVIL_EXITED_BEFORE_LISTEN"));
    const timer = setTimeout(() => finish(safeError("anvil", "ANVIL_START_TIMEOUT")), milliseconds);
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function timeoutPromise(promise, milliseconds, stage, errorClass) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(safeError(stage, errorClass)), milliseconds);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function executeLocalFork(candidates, rawArtifact, options = {}, dependencies = {}) {
  const startedAt = Date.now();
  const runtimeMs = Math.min(options.totalRuntimeMs || LIMITS.totalRuntimeMs, LIMITS.totalRuntimeMs);
  const startMs = Math.min(options.anvilStartMs || LIMITS.anvilStartMs, LIMITS.anvilStartMs);
  const localCap = Math.min(options.localElementCap || LIMITS.localhostElements, LIMITS.localhostElements);
  const rpcBatch = dependencies.rpcBatch || defaultRpcBatch;
  const startRelay = dependencies.startRelay || startLocalRelay;
  const spawnAnvil = dependencies.spawnAnvil || defaultSpawnAnvil;
  const getAnvilPort = dependencies.awaitAnvilPort || awaitAnvilPort;
  const terminateChild = dependencies.terminateChild || ((child) => terminateChildProcess(child, dependencies));
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const budget = {
    upstreamQualificationRequests: 0,
    upstreamRecheckRequests: 0,
    localhostRequests: 0,
    readinessElements: 0,
    controlElements: 0,
  };
  let child = null;
  let stderrCapture = null;
  let relay = null;
  let anvilTerminated = false;
  let relayClosed = false;
  let result;

  const remaining = () => Math.max(1, runtimeMs - (Date.now() - startedAt));
  const invoke = async (scope, endpoint, calls, phase) => {
    for (const call of calls) assertMethod(scope, call.method);
    if (scope === "localhost") {
      assertLocalTarget(endpoint);
      if (budget.localhostRequests + 1 > LIMITS.localhostRequests) {
        throw safeError("localhost_budget", "LOCAL_REQUEST_CAP");
      }
      budget.localhostRequests += 1;
      if (phase === "readiness") {
        const readinessCap = LIMITS.readinessAttempts * 2;
        if (budget.readinessElements + calls.length > readinessCap) {
          throw safeError("localhost_budget", "READINESS_ELEMENT_CAP");
        }
        budget.readinessElements += calls.length;
      } else {
        if (budget.controlElements + calls.length > localCap) {
          throw safeError("localhost_budget", "LOCAL_ELEMENT_CAP");
        }
        budget.controlElements += calls.length;
      }
    } else if (phase === "qualification") {
      if (budget.upstreamQualificationRequests + 1 > LIMITS.upstreamQualificationRequests) {
        throw safeError("upstream_budget", "UPSTREAM_QUALIFICATION_CAP");
      }
      budget.upstreamQualificationRequests += 1;
    } else {
      budget.upstreamRecheckRequests += 1;
    }
    return timeoutPromise(
      Promise.resolve(rpcBatch({
        endpoint,
        calls,
        scope,
        phase,
        timeoutMs: Math.min(LIMITS.rpcTimeoutMs, remaining()),
      })),
      Math.min(LIMITS.rpcTimeoutMs, remaining()),
      scope,
      "TIMEOUT",
    );
  };

  try {
    const artifact = validateFixedArtifact(rawArtifact);
    const requiredControlElements = 10 + artifact.destinations.length * 5;
    if (requiredControlElements > localCap) throw safeError("preflight", "LOCAL_ELEMENT_CAP");
    if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 8) {
      throw safeError("inventory", "CANDIDATE_SET_INVALID");
    }
    let selectedEndpoint = null;
    const qualificationFailures = [];
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        const rows = await invoke("upstream", candidates[index], [
          { method: "eth_chainId", params: [] },
          { method: "eth_getBlockByNumber", params: [artifact.blockNumberHex, false] },
          { method: "eth_getBalance", params: [artifact.psr, artifact.blockNumberHex] },
          { method: "eth_getCode", params: [artifact.psr, artifact.blockNumberHex] },
          { method: "eth_getTransactionCount", params: [artifact.psr, artifact.blockNumberHex] },
          {
            method: "eth_getStorageAt",
            params: [artifact.psr, EIP1967_IMPLEMENTATION_SLOT, artifact.blockNumberHex],
          },
          { method: "eth_getBalance", params: [ACTOR, artifact.blockNumberHex] },
          { method: "eth_getCode", params: [ACTOR, artifact.blockNumberHex] },
          { method: "eth_getTransactionCount", params: [ACTOR, artifact.blockNumberHex] },
        ], "qualification");
        if (rows.slice(0, 6).some((row) => !row?.ok)) {
          throw safeError("upstream_qualification", "STATE_READ_UNAVAILABLE");
        }
        if (rows.slice(6, 9).some((row) => !row?.ok)) {
          throw safeError("upstream_qualification", "ACTOR_STATE_NONZERO");
        }
        let upstreamChain;
        let upstreamBlock;
        try {
          upstreamChain = quantity(rows[0].result, "upstream_chain");
          upstreamBlock = blockResult(rows[1].result, "upstream_block");
        } catch {
          throw safeError("upstream_qualification", "INVALID_STATE");
        }
        if (upstreamChain !== 56n) throw safeError("upstream_qualification", "WRONG_CHAIN");
        if (upstreamBlock.hash !== artifact.blockHash) {
          throw safeError("upstream_qualification", "BLOCK_HASH_MISMATCH");
        }
        try {
          quantity(rows[2].result, "upstream_psr_balance");
          if (!isHex(rows[3].result) || rows[3].result === "0x") throw safeError("upstream_qualification", "INVALID_STATE");
          quantity(rows[4].result, "upstream_psr_nonce");
          if (!isHex(rows[5].result, 32)
            || `0x${rows[5].result.slice(-40).toLowerCase()}` === ZERO_ADDRESS) {
            throw safeError("upstream_qualification", "INVALID_STATE");
          }
        } catch (error) {
          if (error instanceof SafeError && error.errorClass === "INVALID_STATE") throw error;
          throw safeError("upstream_qualification", "INVALID_STATE");
        }
        try {
          if (quantity(rows[6].result, "upstream_actor_balance") !== 0n
            || rows[7].result !== "0x"
            || quantity(rows[8].result, "upstream_actor_nonce") !== 0n) {
            throw safeError("upstream_qualification", "ACTOR_STATE_NONZERO");
          }
        } catch (error) {
          if (error instanceof SafeError && error.errorClass === "ACTOR_STATE_NONZERO") throw error;
          throw safeError("upstream_qualification", "ACTOR_STATE_NONZERO");
        }
        selectedEndpoint = candidates[index];
        break;
      } catch (error) {
        qualificationFailures.push({ candidateOrdinal: index + 1, ...sanitizedFailure(error) });
      }
    }
    if (!selectedEndpoint) {
      const error = safeError("upstream_qualification", "NO_PASSING_CANDIDATE");
      error.qualificationFailures = qualificationFailures;
      throw error;
    }

    relay = await timeoutPromise(
      Promise.resolve(startRelay(selectedEndpoint, options, dependencies)),
      Math.min(LIMITS.rpcTimeoutMs, remaining()),
      "relay",
      "RELAY_START_TIMEOUT",
    );
    assertLocalTarget(relay.endpoint);
    child = spawnAnvil({ relayEndpoint: relay.endpoint, blockNumber: artifact.blockNumber });
    stderrCapture = captureBoundedAnvilStderr(child);
    let port;
    try {
      port = await timeoutPromise(
        Promise.resolve(getAnvilPort(child, Math.min(startMs, remaining()))),
        Math.min(startMs, remaining()),
        "anvil",
        "ANVIL_START_TIMEOUT",
      );
    } catch {
      const classified = safeError("anvil", stderrCapture.classify());
      if (Number.isInteger(child?.exitCode) && child.exitCode >= -255 && child.exitCode <= 255) {
        classified.childExitCode = child.exitCode;
      }
      throw classified;
    }
    stderrCapture.stop();
    stderrCapture = null;
    const localEndpoint = `http://127.0.0.1:${port}`;
    const readinessDeadline = Date.now() + Math.min(startMs, remaining());
    let ready = false;
    let readinessAttempts = 0;
    while (Date.now() < readinessDeadline && readinessAttempts < LIMITS.readinessAttempts) {
      readinessAttempts += 1;
      if (childExited(child)) throw safeError("anvil", "ANVIL_EXITED");
      try {
        const rows = await invoke("localhost", localEndpoint, [
          { method: "eth_chainId", params: [] },
          { method: "eth_getBlockByNumber", params: [artifact.blockNumberHex, false] },
        ], "readiness");
        const chainOk = rows[0]?.ok && quantity(rows[0].result, "local_chain") === 56n;
        const localBlock = rows[1]?.ok ? blockResult(rows[1].result, "local_block") : null;
        if (chainOk && localBlock?.hash === artifact.blockHash) {
          ready = true;
          break;
        }
      } catch (error) {
        if (error instanceof SafeError && error.errorClass === "READINESS_ELEMENT_CAP") throw error;
      }
      await sleep(Math.max(100, LIMITS.readinessBackoffMs));
    }
    if (!ready) throw safeError("anvil", "ANVIL_START_TIMEOUT");

    const actorBeforeRows = await invoke("localhost", localEndpoint, [
      { method: "eth_getBalance", params: [ACTOR, artifact.blockNumberHex] },
      { method: "eth_getCode", params: [ACTOR, artifact.blockNumberHex] },
      { method: "eth_getTransactionCount", params: [ACTOR, artifact.blockNumberHex] },
    ], "control");
    if (!actorBeforeRows[0]?.ok || quantity(actorBeforeRows[0].result, "actor_balance") !== 0n
      || !actorBeforeRows[1]?.ok || actorBeforeRows[1].result !== "0x"
      || !actorBeforeRows[2]?.ok || quantity(actorBeforeRows[2].result, "actor_nonce") !== 0n) {
      throw safeError("actor", "ACTOR_NOT_ZERO_FUNDED");
    }

    const psrRows = await invoke("localhost", localEndpoint, [
      {
        method: "eth_call",
        params: [{
          from: ACTOR,
          to: artifact.psr,
          data: callData(
            SELECTORS.psrUpdateAssetsState,
            wordAddress(artifact.core),
            wordAddress(artifact.wbnb),
            wordUint(0),
          ),
        }, artifact.blockNumberHex],
      },
      {
        method: "eth_call",
        params: [{
          from: ACTOR,
          to: artifact.psr,
          data: callData(
            SELECTORS.psrUpdateAssetsState,
            wordAddress(artifact.core),
            wordAddress(artifact.wbnb),
            wordUint(1),
          ),
        }, artifact.blockNumberHex],
      },
    ], "control");

    const destinationCalls = [];
    for (const destination of artifact.destinations) {
      destinationCalls.push({ method: "eth_call", params: [{ from: ACTOR, to: destination.destination, data: SELECTORS.protocolShareReserve }, artifact.blockNumberHex] });
      destinationCalls.push({ method: "eth_call", params: [{ from: ACTOR, to: destination.destination, data: callData(SELECTORS.destinationUpdateAssetsState, wordAddress(artifact.core), wordAddress(artifact.wbnb)) }, artifact.blockNumberHex] });
      destinationCalls.push({ method: "eth_call", params: [{ from: ACTOR, to: destination.destination, data: harmlessExecuteBuybackCallData() }, artifact.blockNumberHex] });
      destinationCalls.push({ method: "eth_call", params: [{ from: ACTOR, to: destination.destination, data: callData(SELECTORS.forwardBaseAsset, wordAddress(artifact.core), wordUint(0)) }, artifact.blockNumberHex] });
      destinationCalls.push({ method: "eth_call", params: [{ from: ACTOR, to: destination.destination, data: callData(SELECTORS.sweepToken, wordAddress(artifact.wbnb), wordAddress(ACTOR), wordUint(0)) }, artifact.blockNumberHex] });
    }
    const destinationRows = destinationCalls.length === 0
      ? []
      : await invoke("localhost", localEndpoint, destinationCalls, "control");
    const destinationResults = artifact.destinations.map((destination, index) => {
      const rows = destinationRows.slice(index * 5, index * 5 + 5);
      const getterAddress = rows[0]?.ok ? decodeAddressResult(rows[0].result) : null;
      const controls = {
        updateAssetsState: authorizationControl(rows[1], {
          selectors: new Set([ACL_SELECTORS.UnauthorizedCaller]),
        }),
        executeBuyback: authorizationControl(
          rows[2],
          { selectors: new Set([ACL_SELECTORS.Unauthorized]) },
        ),
        forwardBaseAsset: authorizationControl(
          rows[3],
          { selectors: new Set([ACL_SELECTORS.Unauthorized]) },
        ),
        sweepToken: authorizationControl(
          rows[4],
          {
            selectors: new Set([ACL_SELECTORS.OwnableUnauthorizedAccount]),
            knownErrorClasses: new Set([KNOWN_ERROR_CLASSES.OwnableCallerNotOwnerOZ4]),
          },
        ),
      };
      return {
        destination: destination.destination,
        fixedBlockClassification: destination.classification,
        getterMatch: getterAddress === artifact.psr,
        authorizationControlCount: Object.keys(controls).length,
        allUnauthorizedCallsReverted: Object.values(controls).every((row) => row.reverted),
        allAuthorizationProtectionsRecognized:
          Object.values(controls).every((row) => row.authorizationProtected),
        unauthorizedCalls: controls,
      };
    });

    const actorAfterRows = await invoke("localhost", localEndpoint, [
      { method: "eth_getBalance", params: [ACTOR, artifact.blockNumberHex] },
      { method: "eth_getCode", params: [ACTOR, artifact.blockNumberHex] },
      { method: "eth_getTransactionCount", params: [ACTOR, artifact.blockNumberHex] },
    ], "control");
    const balanceAfter = actorAfterRows[0]?.ok ? quantity(actorAfterRows[0].result, "actor_balance") : -1n;
    const codeAfter = actorAfterRows[1]?.ok ? actorAfterRows[1].result : null;
    const nonceAfter = actorAfterRows[2]?.ok ? quantity(actorAfterRows[2].result, "actor_nonce") : -1n;
    const localRecheckRows = await invoke("localhost", localEndpoint, [
      { method: "eth_blockNumber", params: [] },
      { method: "eth_getBlockByNumber", params: [artifact.blockNumberHex, false] },
    ], "recheck");
    if (!localRecheckRows[0]?.ok || quantity(localRecheckRows[0].result, "local_head") !== BigInt(artifact.blockNumber)
      || !localRecheckRows[1]?.ok
      || blockResult(localRecheckRows[1].result, "local_recheck").hash !== artifact.blockHash) {
      throw safeError("local_recheck", "BLOCK_HASH_MISMATCH");
    }
    const upstreamRecheckRows = await invoke("upstream", selectedEndpoint, [
      { method: "eth_getBlockByNumber", params: [artifact.blockNumberHex, false] },
    ], "recheck");
    if (!upstreamRecheckRows[0]?.ok
      || blockResult(upstreamRecheckRows[0].result, "upstream_recheck").hash !== artifact.blockHash) {
      throw safeError("upstream_recheck", "BLOCK_HASH_MISMATCH");
    }

    const unexpectedPublicPath = destinationResults.some((row) =>
      Object.values(row.unauthorizedCalls).some((call) => call.success));
    const authorizationCalls = destinationResults.flatMap((row) => Object.values(row.unauthorizedCalls));
    const allGetterMatches = destinationResults.every((row) => row.getterMatch);
    const allAclRecognized = destinationResults.every((row) => row.allAuthorizationProtectionsRecognized);
    const psrPublicCalls = {
      spread: sanitizedCall(psrRows[0]),
      liquidation: sanitizedCall(psrRows[1]),
    };
    const psrCallsObserved = psrPublicCalls.spread.success && psrPublicCalls.liquidation.success;
    const actorUnchanged = balanceAfter === 0n && codeAfter === "0x" && nonceAfter === 0n;
    const pass = !unexpectedPublicPath && allGetterMatches && allAclRecognized && psrCallsObserved && actorUnchanged;
    const status = pass ? "LOCAL_FORK_PERMISSION_CONTROL_PASS" : "PARTIAL";
    const disposition = unexpectedPublicPath
      ? "UNEXPECTED_PUBLIC_PATH"
      : pass
        ? "NO_PUBLIC_TOKENBUYBACK_PAYOUT_PATH_OBSERVED"
        : "CONTROL_INCONCLUSIVE";
    result = {
      ok: true,
      artifact: {
        schema: OUTPUT_SCHEMA,
        status,
        disposition,
        result: `${status} / ${disposition}`,
        fixedBlock: { number: artifact.blockNumber, hash: artifact.blockHash },
        destinationCount: artifact.destinations.length,
        controlCounts: {
          psrPublicCalls: 2,
          destinationGetterCalls: artifact.destinations.length,
          destinationAuthorizationCalls: authorizationCalls.length,
          executeBuybackAuthorizationCalls: artifact.destinations.length,
          totalEthCalls: 2 + artifact.destinations.length * 5,
        },
        destinationAggregates: {
          getterMatches: destinationResults.filter((row) => row.getterMatch).length,
          authorizationControls: authorizationCalls.length,
          authorizationProtected: authorizationCalls.filter((row) => row.authorizationProtected).length,
          authorizationReverted: authorizationCalls.filter((row) => row.reverted).length,
          authorizationSucceeded: authorizationCalls.filter((row) => row.success).length,
          authorizationInconclusive: authorizationCalls.filter((row) => !row.authorizationProtected).length,
          allGetterMatches,
          allAuthorizationProtectionsRecognized: allAclRecognized,
        },
        actor: ACTOR,
        actorState: {
          queriedAtFixedBlock: true,
          balanceBefore: "0",
          balanceAfter: balanceAfter.toString(),
          codeBefore: "0x",
          codeAfter,
          nonceBefore: "0",
          nonceAfter: nonceAfter.toString(),
          unchanged: actorUnchanged,
        },
        psrPublicCalls,
        destinations: destinationResults,
        anvilTerminated: false,
        providerMaterialAbsent: true,
        sourceBinding: "CANDIDATE_UNBOUND_FROM_FIXED_BLOCK_ARTIFACT",
        routePositive: "unknown",
        executableNow: false,
        signedActionJustified: false,
        liveProductionMutation: false,
        upstreamTransactions: 0,
        upstreamTransactionsBasis: "PARENT_RELAY_FORWARDED_READ_ONLY_METHODS_ONLY",
        upstreamQualificationFailures: qualificationFailures,
        relay: {
          ...relayCounterSnapshot(relay.counters),
          closed: false,
        },
        budget: {
          upstreamQualificationRequests: budget.upstreamQualificationRequests,
          upstreamRecheckRequests: budget.upstreamRecheckRequests,
          localhostRpcRequests: budget.localhostRequests,
          localhostRpcRequestCap: LIMITS.localhostRequests,
          readinessRpcElements: budget.readinessElements,
          localhostRpcElements: budget.controlElements,
          localhostRpcElementCap: LIMITS.localhostElements,
          preflightRequiredControlElements: requiredControlElements,
          totalRuntimeCapMs: LIMITS.totalRuntimeMs,
        },
      },
    };
  } catch (error) {
    result = {
      ok: false,
      artifact: {
        schema: OUTPUT_SCHEMA,
        status: "LOCAL_FORK_PERMISSION_CONTROL_REJECTED",
        failure: sanitizedFailure(error),
        anvilTerminated: false,
        providerMaterialAbsent: true,
        sourceBinding: "CANDIDATE_UNBOUND_FROM_FIXED_BLOCK_ARTIFACT",
        routePositive: "unknown",
        executableNow: false,
        signedActionJustified: false,
        liveProductionMutation: false,
        upstreamTransactions: 0,
        upstreamTransactionsBasis: "PARENT_RELAY_FORWARDED_READ_ONLY_METHODS_ONLY",
        relay: relay ? { ...relayCounterSnapshot(relay.counters), closed: false } : null,
        budget: {
          upstreamQualificationRequests: budget.upstreamQualificationRequests,
          upstreamRecheckRequests: budget.upstreamRecheckRequests,
          localhostRpcRequests: budget.localhostRequests,
          readinessRpcElements: budget.readinessElements,
          localhostRpcElements: budget.controlElements,
        },
      },
    };
  } finally {
    if (stderrCapture) {
      stderrCapture.stop();
      stderrCapture = null;
    }
    if (child) {
      try {
        const terminationReported = await timeoutPromise(
          Promise.resolve(terminateChild(child)),
          LIMITS.cleanupMs,
          "anvil_cleanup",
          "TERMINATION_TIMEOUT",
        );
        anvilTerminated = terminationReported === true && childExited(child);
      } catch {
        anvilTerminated = false;
      }
    } else {
      anvilTerminated = true;
    }
    if (relay) {
      try {
        const closeReported = await timeoutPromise(
          Promise.resolve(relay.close()),
          LIMITS.cleanupMs,
          "relay_cleanup",
          "RELAY_CLOSE_TIMEOUT",
        );
        relayClosed = closeReported === true && (typeof relay.isClosed !== "function" || relay.isClosed());
      } catch {
        relayClosed = false;
      }
    } else relayClosed = true;
    if (result?.artifact) result.artifact.anvilTerminated = anvilTerminated === true;
    if (result?.artifact?.relay) {
      result.artifact.relay = { ...relayCounterSnapshot(relay.counters), closed: relayClosed === true };
    }
    if (result?.artifact) result.artifact.relayClosed = relayClosed === true;
    if ((child && !anvilTerminated) || (relay && !relayClosed)) {
      result.ok = false;
      result.artifact.status = "LOCAL_FORK_PERMISSION_CONTROL_REJECTED";
      result.artifact.failure = !anvilTerminated
        ? { stage: "anvil_cleanup", errorClass: "TERMINATION_FAILED" }
        : { stage: "relay_cleanup", errorClass: "RELAY_CLOSE_FAILED" };
    }
  }
  return result;
}

function parseCli(argv) {
  const parsed = { authorized: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--use-authorized-inventory") parsed.authorized = true;
    else if (arg === "--check-only") continue;
    else if (arg === "--output") {
      const value = argv[++index];
      if (!value) throw safeError("cli", "MISSING_OUTPUT_VALUE");
      const resolved = path.resolve(ROOT, value);
      if (resolved !== ALLOWED_OUTPUT_PATH) throw safeError("cli", "OUTPUT_PATH_NOT_ALLOWED");
      parsed.output = resolved;
    }
    else throw safeError("cli", "UNKNOWN_ARGUMENT");
  }
  return parsed;
}

async function publishNoReplaceAtomic(outputPath, artifact, publisher = capture.publishNoReplaceAtomic) {
  if (outputPath !== ALLOWED_OUTPUT_PATH) throw safeError("publication", "OUTPUT_PATH_NOT_ALLOWED");
  if (containsProviderMaterial(artifact)) throw safeError("publication", "PROVIDER_MATERIAL_PRESENT");
  try {
    await publisher(outputPath, artifact);
  } catch (error) {
    if (error?.stage === "publication" && error?.errorClass === "OUTPUT_EXISTS") {
      throw safeError("publication", "OUTPUT_EXISTS");
    }
    throw safeError("publication", "PUBLICATION_FAILED");
  }
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const writeStdout = dependencies.writeStdout || ((text) => process.stdout.write(text));
  let cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    const artifact = { schema: OUTPUT_SCHEMA, status: "CLI_REJECTED", failure: sanitizedFailure(error), routePositive: "unknown" };
    writeStdout(`${JSON.stringify(artifact)}\n`);
    return { exitCode: 2, artifact };
  }
  if (!cli.authorized) {
    const artifact = {
      schema: OUTPUT_SCHEMA,
      status: "AUTHORIZATION_REQUIRED",
      failure: { stage: "inventory", errorClass: "AUTHORIZED_INVENTORY_FLAG_REQUIRED" },
      inventoryOpened: false,
      spawnCount: 0,
      routePositive: "unknown",
      executableNow: false,
      signedActionJustified: false,
    };
    writeStdout(`${JSON.stringify(artifact)}\n`);
    return { exitCode: 0, artifact };
  }
  const readInventory = dependencies.readInventory || (() => fsp.readFile(INVENTORY_PATH, "utf8"));
  const readArtifact = dependencies.readArtifact || (() => fsp.readFile(FIXED_ARTIFACT_PATH, "utf8"));
  let inventoryText;
  let rawArtifact;
  try {
    inventoryText = await readInventory();
    rawArtifact = JSON.parse(await readArtifact());
  } catch {
    const artifact = { schema: OUTPUT_SCHEMA, status: "INPUT_REJECTED", failure: { stage: "input", errorClass: "READ_OR_PARSE_FAILED" }, routePositive: "unknown" };
    writeStdout(`${JSON.stringify(artifact)}\n`);
    return { exitCode: 1, artifact };
  }
  let candidates;
  try {
    candidates = capture.parseAuthorizedBnbHttpsInventory(inventoryText);
  } catch (error) {
    const artifact = { schema: OUTPUT_SCHEMA, status: "INPUT_REJECTED", failure: sanitizedFailure(error), routePositive: "unknown" };
    writeStdout(`${JSON.stringify(artifact)}\n`);
    return { exitCode: 1, artifact };
  } finally {
    inventoryText = null;
  }
  const executor = dependencies.executeLocalFork || executeLocalFork;
  const result = await executor(candidates, rawArtifact, dependencies.options || {}, dependencies);
  rawArtifact = null;
  if (cli.output) {
    try {
      const publisher = dependencies.publishArtifact || capture.publishNoReplaceAtomic;
      await publishNoReplaceAtomic(cli.output, result.artifact, publisher);
    } catch (error) {
      result.ok = false;
      result.artifact = containsProviderMaterial(result.artifact)
        ? {
          schema: OUTPUT_SCHEMA,
          status: "PUBLICATION_REJECTED",
          failure: sanitizedFailure(error),
          providerMaterialAbsent: true,
          routePositive: "unknown",
          executableNow: false,
          signedActionJustified: false,
        }
        : {
          ...result.artifact,
          status: "PUBLICATION_REJECTED",
          failure: sanitizedFailure(error),
        };
    }
  }
  writeStdout(`${JSON.stringify(result.artifact)}\n`);
  return { exitCode: result.ok ? 0 : 1, artifact: result.artifact };
}

if (require.main === module) {
  runCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stdout.write(`${JSON.stringify({
      schema: OUTPUT_SCHEMA,
      status: "LOCAL_FORK_PERMISSION_CONTROL_REJECTED",
      failure: { stage: "internal", errorClass: "UNEXPECTED" },
      routePositive: "unknown",
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  INPUT_SCHEMA,
  OUTPUT_SCHEMA,
  EXPECTED_PSR,
  ACTOR,
  ALLOWED_OUTPUT_PATH,
  LIMITS,
  SELECTORS,
  ACL_SELECTORS,
  KNOWN_ERROR_CLASSES,
  executeLocalFork,
  publishNoReplaceAtomic,
  runCli,
  _test: {
    assertMethod,
    assertLocalTarget,
    validateFixedArtifact,
    defaultRpcBatch,
    containsProviderMaterial,
    startLocalRelay,
    relayForbidden,
    safeRelayMethodName,
    relayCounterSnapshot,
    parseAnvilPortFromText,
    buildAnvilArgs,
    classifyAnvilStartFailure,
    captureBoundedAnvilStderr,
    awaitAnvilPort,
    terminateChildProcess,
    authorizationControl,
    classifyKnownErrorData,
    harmlessExecuteBuybackCallData,
  },
};
