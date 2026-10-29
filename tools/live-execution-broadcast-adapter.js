#!/usr/bin/env node
"use strict";

// live-execution-broadcast-adapter.js
//
// Offline-testable EVM broadcast adapter for live-execution-batch/v3.
//
// Design constraints (see task):
//   - No implicit network I/O. The only way this module touches a chain is the
//     caller-injected `deps.transport`. `deps.transport` is REQUIRED; when it is
//     absent the run fails closed instead of falling back to a built-in network
//     transport. `defaultTransport` is exported for explicit production wiring
//     only and is never selected implicitly.
//   - The default send-endpoint resolver never consults the repo-wide public
//     fallback map and never returns a public fallback. It returns null (fail
//     closed).
//   - This module is intentionally NOT imported by the localhost-only fork
//     runner (`tools/run-approved-fork-validation.js`). It cannot be reached
//     from the fork runner's call graph.
//   - Before any signing or sending this adapter proves the canonical
//     at-most-once authority (the REAL `live-execution-batch` module, required
//     unconditionally) is already CONSUMED for exactly this batch and runId.
//     Callers may inject only the DATA-only `deps.batchOptions` path binding
//     (`batchPath`, `registryPath`, `registrySha256`); behavior injection via
//     `deps.batch` is rejected outright as adversarial. `batchState()` itself
//     runs `validateBatch` plus the registry-pinned `verifyApproval`, so a
//     forged batch can never reach VALID/CONSUMED; requiring CONSUMED therefore
//     transitively requires a verified approval against the pinned approver
//     registry. That transitivity holds ONLY because the real module is used
//     unconditionally, so module injection cannot shorten it.
//
// FIX 7 / overloading note (documentation only, no schema change): the
// canonical CONSUMED terminal marker stores the re-derived batch
// `scopeCommitment` in its `manifestCommitment` field. That marker field is
// overloaded versus the fork path (`run-approved-fork-validation.js`), which
// stores a separately supplied manifest commitment in the same field. We do not
// modify `live-execution-batch.js`; this adapter only binds the marker's
// `batchCommitment`/`state`/`runId`, while the dispatcher binds the overloaded
// `manifestCommitment` to the re-derived scope commitment.
//
// All signed material, private-key bytes and endpoint URLs stay process-only.
// The returned envelope is sanitized and contains no URL, key or credential.

const fs = require("node:fs");
const path = require("node:path");
const { Wallet, Transaction, getAddress, hexlify, keccak256 } = require("ethers");
const batchTool = require("./live-execution-batch.js");

const RESULT_SCHEMA = "live-execution-broadcast-result/v1";
const CONSUMER = "BROADCAST";
const STATUS = Object.freeze({
  COMPLETED: "COMPLETED",
  INCOMPLETE: "INCOMPLETE",
  FAIL_CLOSED: "FAIL_CLOSED",
});
const SEND_STATUS = Object.freeze({
  SUCCESS: "SUCCESS",
  REVERTED: "REVERTED",
  UNKNOWN: "UNKNOWN",
  HASH_MISMATCH: "HASH_MISMATCH",
});
const BLOCKER = Object.freeze({
  OPTIONS_INVALID: "BROADCAST_OPTIONS_INVALID",
  BATCH_MODULE_INJECTED: "BROADCAST_BATCH_MODULE_INJECTED",
  BATCH_OPTIONS_INVALID: "BROADCAST_BATCH_OPTIONS_INVALID",
  BATCH_INVALID: "BROADCAST_BATCH_INVALID",
  COMMITMENT_MISMATCH: "BROADCAST_BATCH_COMMITMENT_MISMATCH",
  SCOPE_COMMITMENT_MISMATCH: "BROADCAST_SCOPE_COMMITMENT_MISMATCH",
  NOT_CONSUMED: "BROADCAST_NOT_CONSUMED",
  ENDPOINT_UNAVAILABLE: "BROADCAST_ENDPOINT_UNAVAILABLE",
  ENDPOINT_INVALID: "BROADCAST_ENDPOINT_INVALID",
  SIGNER_UNAVAILABLE: "BROADCAST_SIGNER_UNAVAILABLE",
  ACCOUNT_MISMATCH: "BROADCAST_ACCOUNT_MISMATCH",
  CHAIN_UNAVAILABLE: "BROADCAST_CHAIN_UNAVAILABLE",
  CHAIN_MISMATCH: "BROADCAST_CHAIN_MISMATCH",
  NONCE_UNAVAILABLE: "BROADCAST_NONCE_UNAVAILABLE",
  NONCE_MISMATCH: "BROADCAST_NONCE_MISMATCH",
  CAPS_EXCEEDED: "BROADCAST_CAPS_EXCEEDED",
  FEE_CAP_INVALID: "BROADCAST_FEE_CAP_INVALID",
  SCOPE_MISMATCH: "BROADCAST_SCOPE_MISMATCH",
  SEND_TRANSPORT_FAILURE: "BROADCAST_SEND_TRANSPORT_FAILURE",
  SEND_RESPONSE_INVALID: "BROADCAST_SEND_RESPONSE_INVALID",
  SEND_HASH_MISMATCH: "BROADCAST_SEND_HASH_MISMATCH",
  SEND_REVERTED: "BROADCAST_SEND_REVERTED",
  RECEIPT_UNAVAILABLE: "BROADCAST_RECEIPT_UNAVAILABLE",
  RECEIPT_HASH_MISMATCH: "BROADCAST_RECEIPT_HASH_MISMATCH",
  TRANSPORT_UNAVAILABLE: "BROADCAST_TRANSPORT_UNAVAILABLE",
  OUTPUT_SANITIZATION_FAILURE: "BROADCAST_OUTPUT_SANITIZATION_FAILURE",
  INTERNAL: "BROADCAST_INTERNAL_FAILURE_REDACTED",
});
const TRANSPORT_ALLOWLIST = Object.freeze(new Set([
  "eth_chainId",
  "eth_getTransactionCount",
  "eth_sendRawTransaction",
  "eth_getTransactionReceipt",
]));
const HEX_QUANTITY = /^0x[0-9a-f]+$/iu;
const HEX_COMMITMENT = /^0x[0-9a-f]{64}$/u;
const HEX_TX_HASH = /^0x[0-9a-f]{64}$/iu;
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/u;
// R1: the only caller-controlled batch inputs are DATA. `deps.batch` (behavior
// injection) is rejected; `deps.batchOptions` is allowlisted to path binding.
const BATCH_OPTION_KEYS = Object.freeze(new Set(["batchPath", "registryPath", "registrySha256"]));
const MAX_REF_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const MAX_KEY_FILE_BYTES = 4096;
const DEFAULT_RECEIPT_ATTEMPTS = 1;
const MAX_RECEIPT_ATTEMPTS = 64;
const DEFAULT_TRANSPORT_TIMEOUT_MS = 15_000;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\//iu;
const WINDOWS_PATH = /[A-Za-z]:\\/u;
const POSIX_ABS_PATH = /(?:^|[\s"'(])\/(?:home|root|mnt|users|var|etc|tmp|opt|coordination)\//iu;
const RUN_ID_CHARS = /^[A-Za-z0-9._:@~-]+$/u;
const FILE_REF_CHARS = /^[A-Za-z0-9._:@/\\~-]+$/u;

class BroadcastError extends Error {
  constructor(code) {
    super(code);
    this.name = "BroadcastError";
    this.code = code;
  }
}
const fail = (code) => { throw new BroadcastError(code); };
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function codeOf(error, fallback = BLOCKER.INTERNAL) {
  if (error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)) return error.code;
  return fallback;
}
function sanitizeBlocker(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : BLOCKER.INTERNAL;
}
function precheckRef(value, chars) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_REF_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
  if (URL_LIKE.test(value) || WINDOWS_PATH.test(value)) return null;
  if (!chars.test(value)) return null;
  return value;
}
// FIX 5: runId (and symbolic endpoint refs) must never carry path separators or
// traversal, so a caller-supplied runId cannot reflect path-like content.
function safeRef(value) {
  const checked = precheckRef(value, RUN_ID_CHARS);
  if (checked === null) return null;
  if (checked.includes("..")) return null;
  return checked;
}
// Signer refs are absolute OS paths for the Linux-only default signer loader, so
// they deliberately keep the path-separator allowance.
function safeFileRef(value) {
  return precheckRef(value, FILE_REF_CHARS);
}
function safeCommitment(value) {
  return typeof value === "string" && HEX_COMMITMENT.test(value) ? value : null;
}
function parseQuantity(value) {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch (_) {
    return null;
  }
}
function bytesOf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string" && /^(?:0x)?[0-9a-fA-F]{64}$/u.test(value)) return Buffer.from(value.replace(/^0x/u, ""), "hex");
  return null;
}
function walletFromKeyBytes(bytes) {
  return new Wallet(hexlify(bytes));
}
function zeroize(buffer) {
  if (Buffer.isBuffer(buffer) || buffer instanceof Uint8Array) {
    try { buffer.fill(0); } catch (_) { /* best effort */ }
  }
}
function isApprovedLocalhostHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
function validateSendEndpointUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_URL_LENGTH) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return null;
  let parsed;
  try { parsed = new URL(value); } catch (_) { return null; }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol === "https:") return value;
  if (parsed.protocol === "http:" && isApprovedLocalhostHost(parsed.hostname)) return value;
  return null;
}
// FIX 5: total, non-throwing sanitization. Any failure (bad JSON, URL, Windows or
// absolute path, or repo leakGuard rejection) returns the fixed fail-closed
// envelope instead of throwing out of runBroadcast.
function fixedFailClosedEnvelope() {
  return Object.freeze({
    schema: RESULT_SCHEMA,
    status: STATUS.FAIL_CLOSED,
    blocker: BLOCKER.OUTPUT_SANITIZATION_FAILURE,
    consumer: CONSUMER,
    runId: null,
    batchCommitment: null,
    scopeCommitment: null,
    sends: [],
    counts: { actions: 0, attempts: 0, sends: 0, confirmations: 0 },
    safety: { signed: false, broadcast: false, endpointPersisted: false, urlOnArgv: false },
  });
}
function guardEnvelope(envelope) {
  try {
    const serialized = JSON.stringify(envelope);
    if (typeof serialized !== "string") return fixedFailClosedEnvelope();
    if (URL_LIKE.test(serialized) || WINDOWS_PATH.test(serialized) || POSIX_ABS_PATH.test(serialized)) return fixedFailClosedEnvelope();
    if (typeof batchTool.leakGuard === "function") batchTool.leakGuard(envelope);
    return envelope;
  } catch (_) {
    return fixedFailClosedEnvelope();
  }
}

// ---------------------------------------------------------------------------
// Canonical at-most-once precondition
// ---------------------------------------------------------------------------
// R1: the canonical module is fixed. `deps.batch` is adversarial behavior
// injection and is refused; `deps.batchOptions` only relocates the DATA path
// (temp-path testability) and never changes which module is consulted.
function resolveBatchOptions(deps) {
  if (Object.hasOwn(deps, "batch")) return { ok: false, code: BLOCKER.BATCH_MODULE_INJECTED };
  const raw = deps.batchOptions;
  if (raw === undefined) return { ok: true, options: {} };
  if (!isPlainObject(raw)) return { ok: false, code: BLOCKER.BATCH_OPTIONS_INVALID };
  for (const key of Object.keys(raw)) {
    if (!BATCH_OPTION_KEYS.has(key)) return { ok: false, code: BLOCKER.BATCH_OPTIONS_INVALID };
  }
  if (raw.batchPath !== undefined && (typeof raw.batchPath !== "string" || raw.batchPath.length === 0)) return { ok: false, code: BLOCKER.BATCH_OPTIONS_INVALID };
  if (raw.registryPath !== undefined && (typeof raw.registryPath !== "string" || raw.registryPath.length === 0)) return { ok: false, code: BLOCKER.BATCH_OPTIONS_INVALID };
  if (raw.registrySha256 !== undefined && !HEX_COMMITMENT.test(raw.registrySha256)) return { ok: false, code: BLOCKER.BATCH_OPTIONS_INVALID };
  return { ok: true, options: { ...raw } };
}
// R4: mirror the dispatcher's terminal binding exactly: the terminal marker must
// bind the same batchId, batchCommitment, manifestCommitment (scope) and runId.
function consumedForThisRun(state, options) {
  if (!isPlainObject(state) || state.state !== "CONSUMED") return false;
  if (state.batchCommitment !== options.expectedBatchCommitment) return false;
  const terminal = state.terminal;
  if (!isPlainObject(terminal) || terminal.state !== "CONSUMED") return false;
  if (terminal.batchId !== options.batchId) return false;
  if (terminal.batchCommitment !== options.expectedBatchCommitment) return false;
  if (terminal.manifestCommitment !== options.scopeCommitment) return false;
  if (terminal.runId !== options.runId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// F1: pure request-level validator
// ---------------------------------------------------------------------------
// `validateBroadcastRequest` performs EXACTLY the request-level validation that
// `runBroadcast` applies before it signs anything: option/type checks, ref
// grammar (including the `..` refusal that `safeRef` enforces), commitment and
// scope binding, batch validity, fee-cap ordering and per-action caps. It has NO
// side effects (no batchState read, no transport, no signer load, no registry
// read, no state mutation) and never throws: it returns a sanitized blocker code
// or null. The dispatcher calls it BEFORE consuming the one-shot authority so a
// condition the adapter would reject after consumption is instead refused with
// zero sends and an unburned batch. `runBroadcast` calls the same function, so
// the preflight and the adapter cannot diverge on a pure check.
function validateBroadcastRequest(options) {
  try {
    if (!isPlainObject(options) || !isPlainObject(options.batch) || !isPlainObject(options.deps)) return BLOCKER.OPTIONS_INVALID;
    const deps = options.deps;
    if (typeof deps.transport !== "function") return BLOCKER.OPTIONS_INVALID;
    const batchResolution = resolveBatchOptions(deps);
    if (!batchResolution.ok) return batchResolution.code;
    const runIdValue = safeRef(options.runId);
    const expectedCommitment = safeCommitment(options.expectedBatchCommitment);
    const scopeCommitmentValue = safeCommitment(options.scopeCommitment);
    if (runIdValue === null) return BLOCKER.OPTIONS_INVALID;
    if (expectedCommitment === null) return BLOCKER.OPTIONS_INVALID;
    if (scopeCommitmentValue === null) return BLOCKER.OPTIONS_INVALID;
    if (safeFileRef(options.signerRef) === null) return BLOCKER.OPTIONS_INVALID;
    if (safeRef(options.endpointRef) === null) return BLOCKER.OPTIONS_INVALID;

    const batch = options.batch;
    try { batchTool.validateBatch(batch); } catch (error) { return codeOf(error, BLOCKER.BATCH_INVALID); }
    if (!isPlainObject(batch.approval)) return BLOCKER.SCOPE_COMMITMENT_MISMATCH;
    if (batchTool.commitment(batch) !== expectedCommitment) return BLOCKER.COMMITMENT_MISMATCH;
    const computedScope = batchTool.scopeCommitment(batch);
    if (computedScope !== scopeCommitmentValue) return BLOCKER.SCOPE_COMMITMENT_MISMATCH;
    if (batch.approval.scopeCommitment !== computedScope) return BLOCKER.SCOPE_COMMITMENT_MISMATCH;

    const maxFee = BigInt(batch.feeCap.maxFeePerGasWei);
    const maxPriority = BigInt(batch.feeCap.maxPriorityFeePerGasWei);
    if (maxPriority > maxFee) return BLOCKER.FEE_CAP_INVALID;
    let totalGas = 0n;
    const gasCeiling = BigInt(batch.gasCeiling);
    for (const action of batch.actions) {
      const value = BigInt(action.valueWei);
      const gas = BigInt(action.gasLimit);
      if (value < 0n || gas < 1n) return BLOCKER.CAPS_EXCEEDED;
      totalGas += gas;
      if (totalGas > gasCeiling) return BLOCKER.CAPS_EXCEEDED;
    }
    return null;
  } catch (error) {
    return sanitizeBlocker(codeOf(error, BLOCKER.INTERNAL));
  }
}

// ---------------------------------------------------------------------------
// Signer normalization
// ---------------------------------------------------------------------------
function normalizeSigner(loaded) {
  if (loaded && typeof loaded === "object" && loaded.signer && typeof loaded.signer.signTransaction === "function") {
    return { signer: loaded.signer, keyBytes: bytesOf(loaded.keyBytes) || bytesOf(loaded.signer.privateKey) };
  }
  if (loaded && typeof loaded === "object" && typeof loaded.signTransaction === "function" && typeof loaded.address === "string") {
    return { signer: loaded, keyBytes: bytesOf(loaded.privateKey) };
  }
  if (loaded && typeof loaded === "object" && Object.hasOwn(loaded, "privateKey")) {
    const bytes = bytesOf(loaded.privateKey);
    if (!bytes || bytes.length !== 32) fail(BLOCKER.SIGNER_UNAVAILABLE);
    return { signer: walletFromKeyBytes(bytes), keyBytes: bytes };
  }
  const bytes = bytesOf(loaded);
  if (bytes && bytes.length === 32) return { signer: walletFromKeyBytes(bytes), keyBytes: bytes };
  fail(BLOCKER.SIGNER_UNAVAILABLE);
}
function signerAddress(signer) {
  try {
    return getAddress(signer.address);
  } catch (_) {
    fail(BLOCKER.SIGNER_UNAVAILABLE);
  }
}
// F1(d): non-throwing, side-effect-free address derivation used by the
// dispatcher's read-only pre-consume signer probe. It deliberately does NOT
// zeroize the derived key bytes: `bytesOf` returns the caller's Buffer by
// reference for an already-Buffer `keyBytes`, so zeroizing here could destroy
// signer material the adapter later reuses. The adapter zeroizes its own copy.
function signerAddressOf(loaded) {
  try {
    return signerAddress(normalizeSigner(loaded).signer);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default dependencies (explicit wiring only; never implicitly networked)
// ---------------------------------------------------------------------------
function defaultResolveSendEndpoint(_chainId, _endpointRef) {
  // Deliberately fail closed. No send-capable endpoint inventory is bound in
  // this adapter and the repo-wide public fallback map is never consulted. A
  // production lane injects a resolver after its own qualification.
  return null;
}

async function defaultTransport(url, method, params) {
  if (!TRANSPORT_ALLOWLIST.has(method)) fail(BLOCKER.TRANSPORT_UNAVAILABLE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TRANSPORT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    let payload;
    try { payload = await response.json(); } catch (_) { fail(BLOCKER.TRANSPORT_UNAVAILABLE); }
    if (!response.ok || !isPlainObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== 1 || Object.hasOwn(payload, "error") === Object.hasOwn(payload, "result")) fail(BLOCKER.TRANSPORT_UNAVAILABLE);
    if (payload.error) fail(BLOCKER.TRANSPORT_UNAVAILABLE);
    return payload.result ?? null;
  } catch (error) {
    if (error instanceof BroadcastError) throw error;
    throw new BroadcastError(BLOCKER.TRANSPORT_UNAVAILABLE);
  } finally {
    clearTimeout(timer);
  }
}

function parsePrivateKey(raw) {
  if (!raw || raw.length === 0) return null;
  const text = raw.toString("utf8").trim();
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/u.test(text)) return null;
  return Buffer.from(text.replace(/^0x/iu, ""), "hex");
}

function defaultLoadSigner(signerRef) {
  if (process.platform !== "linux") fail(BLOCKER.SIGNER_UNAVAILABLE);
  if (typeof signerRef !== "string" || !path.isAbsolute(signerRef)) fail(BLOCKER.SIGNER_UNAVAILABLE);
  let stat;
  try { stat = fs.lstatSync(signerRef); } catch (_) { fail(BLOCKER.SIGNER_UNAVAILABLE); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(BLOCKER.SIGNER_UNAVAILABLE);
  if (stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail(BLOCKER.SIGNER_UNAVAILABLE);
  let fd;
  let raw = null;
  let keyBytes = null;
  try {
    fd = fs.openSync(signerRef, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600 || opened.size < 1 || opened.size > MAX_KEY_FILE_BYTES) fail(BLOCKER.SIGNER_UNAVAILABLE);
    raw = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < raw.length) {
      const read = fs.readSync(fd, raw, offset, raw.length - offset, offset);
      if (!Number.isInteger(read) || read <= 0) fail(BLOCKER.SIGNER_UNAVAILABLE);
      offset += read;
    }
    keyBytes = parsePrivateKey(raw);
    if (!keyBytes) fail(BLOCKER.SIGNER_UNAVAILABLE);
    const signer = walletFromKeyBytes(keyBytes);
    return { signer, keyBytes };
  } catch (error) {
    zeroize(keyBytes);
    if (error instanceof BroadcastError) throw error;
    throw new BroadcastError(BLOCKER.SIGNER_UNAVAILABLE);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* best effort */ } }
    zeroize(raw);
  }
}

// ---------------------------------------------------------------------------
// Core broadcast
// ---------------------------------------------------------------------------
function buildTransaction(batch, action, nonce, maxFee, maxPriority) {
  return {
    type: 2,
    chainId: BigInt(batch.chainId),
    nonce: Number(nonce),
    to: action.to,
    value: BigInt(action.valueWei),
    data: action.data,
    gasLimit: BigInt(action.gasLimit),
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriority,
  };
}

function verifySignedTransaction(signedHex, batch, action, index, accountRef, expectedNonce, maxFee, maxPriority) {
  let decoded;
  try { decoded = Transaction.from(signedHex); } catch (_) { return { ok: false, blocker: BLOCKER.SCOPE_MISMATCH }; }
  if (decoded.type !== 2) return { ok: false, blocker: BLOCKER.SCOPE_MISMATCH };
  if (BigInt(decoded.chainId ?? -1) !== BigInt(batch.chainId)) return { ok: false, blocker: BLOCKER.CHAIN_MISMATCH };
  if (BigInt(decoded.nonce) !== expectedNonce) return { ok: false, blocker: BLOCKER.NONCE_MISMATCH };
  let decodedFrom;
  let decodedTo;
  try {
    decodedFrom = getAddress(decoded.from);
    decodedTo = decoded.to ? getAddress(decoded.to) : null;
  } catch (_) {
    return { ok: false, blocker: BLOCKER.SCOPE_MISMATCH };
  }
  if (decodedFrom.toLowerCase() !== accountRef.toLowerCase()) return { ok: false, blocker: BLOCKER.ACCOUNT_MISMATCH };
  if (!decodedTo) return { ok: false, blocker: BLOCKER.SCOPE_MISMATCH };
  const observed = {
    chainId: BigInt(decoded.chainId).toString(),
    from: decodedFrom.toLowerCase(),
    to: decodedTo.toLowerCase(),
    valueWei: BigInt(decoded.value).toString(),
    data: typeof decoded.data === "string" ? decoded.data.toLowerCase() : "0x",
    gasLimit: BigInt(decoded.gasLimit).toString(),
    slippageBps: action.slippageBps,
  };
  const scopeVerdict = batchTool.checkAction(batch, observed, index);
  if (!scopeVerdict.ok) return { ok: false, blocker: scopeVerdict.reason || BLOCKER.SCOPE_MISMATCH };
  if (BigInt(decoded.maxFeePerGas ?? 0n) > maxFee) return { ok: false, blocker: BLOCKER.FEE_CAP_INVALID };
  if (BigInt(decoded.maxPriorityFeePerGas ?? 0n) > maxPriority) return { ok: false, blocker: BLOCKER.FEE_CAP_INVALID };
  return { ok: true };
}

async function readChainId(transport, url) {
  let result;
  try { result = await transport(url, "eth_chainId", []); } catch (_) { return null; }
  return parseQuantity(result);
}

async function confirmReceipt(transport, url, txHash, deps) {
  const requested = Number.isSafeInteger(deps.receiptAttempts) && deps.receiptAttempts > 0 ? Math.min(deps.receiptAttempts, MAX_RECEIPT_ATTEMPTS) : DEFAULT_RECEIPT_ATTEMPTS;
  const intervalMs = Number.isSafeInteger(deps.receiptIntervalMs) && deps.receiptIntervalMs >= 0 ? Math.min(deps.receiptIntervalMs, 30_000) : 0;
  const delay = typeof deps.delay === "function" ? deps.delay : null;
  for (let attempt = 0; attempt < requested; attempt += 1) {
    let receipt;
    try { receipt = await transport(url, "eth_getTransactionReceipt", [txHash]); } catch (_) { receipt = null; }
    if (isPlainObject(receipt)) {
      const status = parseQuantity(receipt.status);
      if (status === 1n || status === 0n) {
        // FIX 6: a confirming receipt must reference the exact transaction hash
        // returned by the node and bound to the signed raw transaction.
        if (typeof receipt.transactionHash !== "string" || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
          return SEND_STATUS.HASH_MISMATCH;
        }
        return status === 1n ? SEND_STATUS.SUCCESS : SEND_STATUS.REVERTED;
      }
    }
    if (attempt + 1 < requested && delay) await delay(intervalMs);
  }
  return SEND_STATUS.UNKNOWN;
}

async function runBroadcast(options = {}) {
  const state = {
    actions: 0,
    attempts: 0,
    submitted: 0,
    confirmations: 0,
    sends: [],
    signed: false,
    broadcast: false,
  };
  let runId = safeRef(options && options.runId);
  let batchCommitment = safeCommitment(options && options.expectedBatchCommitment);
  let scopeCommitmentValue = safeCommitment(options && options.scopeCommitment);
  let keyBytes = null;

  const finish = (status, blocker) => guardEnvelope({
    schema: RESULT_SCHEMA,
    status,
    blocker: blocker == null ? null : sanitizeBlocker(blocker),
    consumer: CONSUMER,
    runId,
    batchCommitment,
    scopeCommitment: scopeCommitmentValue,
    sends: state.sends.map((entry) => ({ index: entry.index, txHash: entry.txHash, status: entry.status })),
    counts: {
      actions: state.actions,
      attempts: state.attempts,
      sends: state.submitted,
      confirmations: state.confirmations,
    },
    safety: { signed: state.signed, broadcast: state.broadcast, endpointPersisted: false, urlOnArgv: false },
  });

  try {
    // F1: the exported pure validator is the single source of truth for
    // request-level rejection; the checks below are retained verbatim as the
    // long-standing inline path they were factored from.
    const requestBlocker = validateBroadcastRequest(options);
    if (requestBlocker) return finish(STATUS.FAIL_CLOSED, requestBlocker);
    if (!isPlainObject(options) || !isPlainObject(options.batch) || !isPlainObject(options.deps)) return finish(STATUS.FAIL_CLOSED, BLOCKER.OPTIONS_INVALID);
    const deps = options.deps;
    if (typeof deps.transport !== "function") return finish(STATUS.FAIL_CLOSED, BLOCKER.OPTIONS_INVALID);
    const batchResolution = resolveBatchOptions(deps);
    if (!batchResolution.ok) return finish(STATUS.FAIL_CLOSED, batchResolution.code);
    const batchOptions = batchResolution.options;
    if (runId === null || batchCommitment === null || scopeCommitmentValue === null) return finish(STATUS.FAIL_CLOSED, BLOCKER.OPTIONS_INVALID);
    if (safeFileRef(options.signerRef) === null || safeRef(options.endpointRef) === null) return finish(STATUS.FAIL_CLOSED, BLOCKER.OPTIONS_INVALID);

    const batch = options.batch;
    const transport = deps.transport;
    const resolveSendEndpoint = typeof deps.resolveSendEndpoint === "function" ? deps.resolveSendEndpoint : defaultResolveSendEndpoint;
    const loadSigner = typeof deps.loadSigner === "function" ? deps.loadSigner : defaultLoadSigner;

    try { batchTool.validateBatch(batch); } catch (error) { return finish(STATUS.FAIL_CLOSED, codeOf(error, BLOCKER.BATCH_INVALID)); }
    state.actions = batch.actions.length;

    if (batchTool.commitment(batch) !== batchCommitment) return finish(STATUS.FAIL_CLOSED, BLOCKER.COMMITMENT_MISMATCH);
    const computedScope = batchTool.scopeCommitment(batch);
    if (computedScope !== scopeCommitmentValue) return finish(STATUS.FAIL_CLOSED, BLOCKER.SCOPE_COMMITMENT_MISMATCH);
    if (batch.approval.scopeCommitment !== computedScope) return finish(STATUS.FAIL_CLOSED, BLOCKER.SCOPE_COMMITMENT_MISMATCH);

    const maxFee = BigInt(batch.feeCap.maxFeePerGasWei);
    const maxPriority = BigInt(batch.feeCap.maxPriorityFeePerGasWei);
    if (maxPriority > maxFee) return finish(STATUS.FAIL_CLOSED, BLOCKER.FEE_CAP_INVALID);

    let totalGas = 0n;
    const gasCeiling = BigInt(batch.gasCeiling);
    for (const action of batch.actions) {
      const value = BigInt(action.valueWei);
      const gas = BigInt(action.gasLimit);
      if (value < 0n || gas < 1n) return finish(STATUS.FAIL_CLOSED, BLOCKER.CAPS_EXCEEDED);
      totalGas += gas;
      if (totalGas > gasCeiling) return finish(STATUS.FAIL_CLOSED, BLOCKER.CAPS_EXCEEDED);
    }

    // FIX 1 / R1: prove the canonical at-most-once authority was already
    // consumed for exactly this batch, scope and run before ANY signing,
    // endpoint resolution, or network call. The REAL
    // `./live-execution-batch.js` module is used unconditionally; `deps.batch`
    // is rejected above, so `deps.batchOptions` can only relocate the temp path
    // and cannot substitute a permissive batchState(). batchState() runs
    // validateBatch + registry-pinned verifyApproval, so requiring CONSUMED
    // transitively requires a verified approval against the pinned registry.
    let canonicalState;
    try { canonicalState = batchTool.batchState({ ...batchOptions, now: typeof deps.now === "function" ? deps.now : Date.now }); }
    catch (_) { return finish(STATUS.FAIL_CLOSED, BLOCKER.NOT_CONSUMED); }
    if (!consumedForThisRun(canonicalState, {
      expectedBatchCommitment: batchCommitment,
      scopeCommitment: scopeCommitmentValue,
      runId,
      batchId: batch.batchId,
    })) return finish(STATUS.FAIL_CLOSED, BLOCKER.NOT_CONSUMED);

    let resolvedEndpoint;
    try { resolvedEndpoint = await resolveSendEndpoint(batch.chainId, options.endpointRef); } catch (_) { return finish(STATUS.FAIL_CLOSED, BLOCKER.ENDPOINT_UNAVAILABLE); }
    const endpointUrl = validateSendEndpointUrl(resolvedEndpoint);
    if (!endpointUrl) return finish(STATUS.FAIL_CLOSED, BLOCKER.ENDPOINT_INVALID);

    let loaded;
    try { loaded = await loadSigner(options.signerRef); } catch (error) { return finish(STATUS.FAIL_CLOSED, codeOf(error, BLOCKER.SIGNER_UNAVAILABLE)); }
    const normalized = normalizeSigner(loaded);
    keyBytes = normalized.keyBytes;
    const signer = normalized.signer;
    const accountRef = getAddress(batch.accountRef);
    const derivedAddress = signerAddress(signer);
    if (derivedAddress.toLowerCase() !== accountRef.toLowerCase()) return finish(STATUS.FAIL_CLOSED, BLOCKER.ACCOUNT_MISMATCH);

    let nonceResult;
    try { nonceResult = await transport(endpointUrl, "eth_getTransactionCount", [accountRef, "pending"]); } catch (_) { return finish(STATUS.FAIL_CLOSED, BLOCKER.NONCE_UNAVAILABLE); }
    const baseNonce = parseQuantity(nonceResult);
    if (baseNonce === null || baseNonce > BigInt(Number.MAX_SAFE_INTEGER)) return finish(STATUS.FAIL_CLOSED, BLOCKER.NONCE_MISMATCH);

    const expectedChainId = BigInt(batch.chainId);
    for (let index = 0; index < batch.actions.length; index += 1) {
      const action = batch.actions[index];
      const expectedNonce = baseNonce + BigInt(index);

      const chainBeforeSign = await readChainId(transport, endpointUrl);
      if (chainBeforeSign === null) return finish(STATUS.FAIL_CLOSED, BLOCKER.CHAIN_UNAVAILABLE);
      if (chainBeforeSign !== expectedChainId) return finish(STATUS.FAIL_CLOSED, BLOCKER.CHAIN_MISMATCH);

      let signedHex;
      try { signedHex = await signer.signTransaction(buildTransaction(batch, action, expectedNonce, maxFee, maxPriority)); } catch (_) { return finish(STATUS.FAIL_CLOSED, BLOCKER.SIGNER_UNAVAILABLE); }
      if (typeof signedHex !== "string") return finish(STATUS.FAIL_CLOSED, BLOCKER.SIGNER_UNAVAILABLE);
      state.signed = true;

      const verdict = verifySignedTransaction(signedHex, batch, action, index, accountRef, expectedNonce, maxFee, maxPriority);
      if (!verdict.ok) return finish(STATUS.FAIL_CLOSED, verdict.blocker);

      const signedTxHash = keccak256(signedHex);

      const chainBeforeSend = await readChainId(transport, endpointUrl);
      if (chainBeforeSend === null) return finish(STATUS.FAIL_CLOSED, BLOCKER.CHAIN_UNAVAILABLE);
      if (chainBeforeSend !== expectedChainId) return finish(STATUS.FAIL_CLOSED, BLOCKER.CHAIN_MISMATCH);

      state.attempts += 1;
      state.broadcast = true;
      let txHash;
      try { txHash = await transport(endpointUrl, "eth_sendRawTransaction", [signedHex]); } catch (_) {
        state.sends.push({ index, txHash: null, status: SEND_STATUS.UNKNOWN });
        return finish(STATUS.INCOMPLETE, BLOCKER.SEND_TRANSPORT_FAILURE);
      }
      if (typeof txHash !== "string" || !HEX_TX_HASH.test(txHash)) {
        state.sends.push({ index, txHash: null, status: SEND_STATUS.UNKNOWN });
        return finish(STATUS.INCOMPLETE, BLOCKER.SEND_RESPONSE_INVALID);
      }
      state.submitted += 1;
      // FIX 6: the node-reported hash must equal the hash of the signed raw
      // transaction; anything else is terminal INCOMPLETE and never confirmed.
      if (txHash.toLowerCase() !== signedTxHash.toLowerCase()) {
        state.sends.push({ index, txHash, status: SEND_STATUS.HASH_MISMATCH });
        return finish(STATUS.INCOMPLETE, BLOCKER.SEND_HASH_MISMATCH);
      }
      const confirmed = await confirmReceipt(transport, endpointUrl, txHash, deps);
      if (confirmed === SEND_STATUS.SUCCESS) state.confirmations += 1;
      state.sends.push({ index, txHash, status: confirmed });
      if (confirmed !== SEND_STATUS.SUCCESS) {
        const blocker = confirmed === SEND_STATUS.REVERTED
          ? BLOCKER.SEND_REVERTED
          : confirmed === SEND_STATUS.HASH_MISMATCH
            ? BLOCKER.RECEIPT_HASH_MISMATCH
            : BLOCKER.RECEIPT_UNAVAILABLE;
        return finish(STATUS.INCOMPLETE, blocker);
      }
    }
    return finish(STATUS.COMPLETED, null);
  } catch (error) {
    return finish(STATUS.FAIL_CLOSED, codeOf(error));
  } finally {
    zeroize(keyBytes);
  }
}

module.exports = {
  RESULT_SCHEMA,
  CONSUMER,
  STATUS,
  SEND_STATUS,
  BLOCKER,
  runBroadcast,
  validateBroadcastRequest,
  signerAddressOf,
  guardEnvelope,
  defaultResolveSendEndpoint,
  defaultTransport,
  defaultLoadSigner,
  validateSendEndpointUrl,
};
