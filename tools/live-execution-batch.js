#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BATCH_REL = "coordination/live-execution-batch.json";
const REGISTRY_REL = "coordination/live-execution-approvers.json";
const BATCH_PATH = path.join(ROOT, ...BATCH_REL.split("/"));
const REGISTRY_PATH = path.join(ROOT, ...REGISTRY_REL.split("/"));
const TERMINAL_PREFIX = "live-execution-batch-terminal-";
const ARCHIVE_DIR = "archive";
const SCHEMA = "live-execution-batch/v2";
const SCHEMA_V3 = "live-execution-batch/v3";
const REGISTRY_SCHEMA = "live-execution-approver-registry/v1";
const TERMINAL_SCHEMA = "live-execution-batch-terminal/v1";
const APPROVAL_DOMAIN = "EVM_AUDIT_LIVE_EXECUTION_BATCH_APPROVAL_V2\u0000";
const APPROVAL_DOMAIN_V3 = "EVM_AUDIT_LIVE_EXECUTION_BATCH_APPROVAL_V3\u0000";
const TRUST_ANCHOR_ENV = "LIVE_EXECUTION_APPROVER_REGISTRY_SHA256";
const CANONICAL_REGISTRY_SHA256 = "0x718e4b53c6b3d2b1f3308672b6aa5db1270b789e5c4e1975eebda745ac1e47ee";
const MODES = Object.freeze(["FORK_TESTNET"]);
const MODES_V3 = Object.freeze(["TESTNET", "PRODUCTION"]);
const STATES = Object.freeze({
  ABSENT: "ABSENT",
  INVALID: "INVALID",
  NOT_YET_VALID: "NOT_YET_VALID",
  VALID: "VALID",
  EXPIRED: "EXPIRED",
  CONSUMED: "CONSUMED",
  REVOKED: "REVOKED",
  SCOPE_MISMATCH: "SCOPE_MISMATCH",
});
const CAPS = Object.freeze({
  batchBytes: 128 * 1024,
  registryBytes: 64 * 1024,
  markerBytes: 8 * 1024,
  actions: 64,
  approvers: 32,
  maxValiditySeconds: 7 * 24 * 3600,
  refLength: 128,
  calldataBytes: 128 * 1024,
});
const FORBIDDEN_KEYS = new Set([
  "privatekey", "secretkey", "keypair", "keystore", "mnemonic", "seed", "seedphrase",
  "secret", "clientsecret", "apisecret", "password", "passphrase", "token", "accesstoken",
  "refreshtoken", "bearertoken", "authtoken", "apikey", "credential", "credentials",
  "authorization", "authorizationheader", "authheader", "header", "headers", "endpoint",
  "endpoints", "rpc", "rpcs", "rpcurl", "rpcurls", "rpcendpoint", "rpcendpoints",
  "provider", "providers", "providerurl", "providerurls", "providerendpoint",
  "providerendpoints", "url", "urls", "websocketurl", "websocketurls", "wsurl", "wsurls",
]);
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const BATCH_KEYS = ["schema", "batchId", "mode", "chainId", "accountRef", "actions", "gasCeiling", "anvil", "issuedAt", "notBefore", "expiresAt", "nonce", "approval"];
const SCOPE_KEYS = BATCH_KEYS.filter((key) => key !== "approval");
const BATCH_KEYS_V3 = ["schema", "batchId", "mode", "chainId", "accountRef", "actions", "gasCeiling", "feeCap", "issuedAt", "notBefore", "expiresAt", "nonce", "approval"];
const BATCH_KEYS_V3_ATTESTED = ["schema", "batchId", "mode", "chainId", "accountRef", "actions", "gasCeiling", "feeCap", "issuedAt", "notBefore", "expiresAt", "nonce", "testnetAttestation", "approval"];
const SCOPE_KEYS_V3 = BATCH_KEYS_V3.filter((key) => key !== "approval");
const SCOPE_KEYS_V3_ATTESTED = BATCH_KEYS_V3_ATTESTED.filter((key) => key !== "approval");
const FEE_CAP_KEYS = ["maxFeePerGasWei", "maxPriorityFeePerGasWei"];

class BatchError extends Error {
  constructor(code) {
    super(code);
    this.name = "BatchError";
    this.code = code;
  }
}
const fail = (code) => { throw new BatchError(code); };
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "number") fail("NONCANONICAL_NUMBER");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isPlainObject(value)) fail("NONCANONICAL_VALUE");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function assertNoNumbers(value) {
  if (typeof value === "number") fail("NONCANONICAL_NUMBER");
  if (Array.isArray(value)) value.forEach(assertNoNumbers);
  else if (isPlainObject(value)) Object.values(value).forEach(assertNoNumbers);
}
function decimal(value, code) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) fail(code);
  return BigInt(value);
}
function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/u.test(value) && value !== ZERO_ADDRESS;
}
function isHexData(value) {
  return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/u.test(value) && value.length >= 10 && (value.length - 2) / 2 <= CAPS.calldataBytes;
}
function isoSeconds(value, code) {
  if (typeof value !== "string") fail(code);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail(code);
  const iso = new Date(ms).toISOString();
  if (value !== iso && value !== iso.replace(".000Z", "Z")) fail(code);
  return Math.floor(ms / 1000);
}
const normalizeSensitiveKey = (key) => String(key).replace(/[^a-z0-9]/giu, "").toLowerCase();
function leakGuard(value, key = "") {
  if (FORBIDDEN_KEYS.has(normalizeSensitiveKey(key))) fail("BATCH_SECRET_FIELD_REJECTED");
  if (typeof value === "string") {
    if (/(?:https?|wss?):\/\//iu.test(value)) fail("BATCH_URL_REJECTED");
    return;
  }
  if (Array.isArray(value)) value.forEach((child) => leakGuard(child, key));
  else if (isPlainObject(value)) Object.entries(value).forEach(([name, child]) => leakGuard(child, name));
}
function validRef(ref) {
  return typeof ref === "string" && ref.length >= 1 && ref.length <= CAPS.refLength && !/[\u0000-\u001f\u007f]/u.test(ref) && !/(?:https?|wss?):\/\//iu.test(ref);
}
function validateActions(batch) {
  if (!Array.isArray(batch.actions) || batch.actions.length < 1 || batch.actions.length > CAPS.actions) fail("BATCH_ACTIONS_INVALID");
  const actionCommitments = new Set();
  let totalGas = 0n;
  for (const action of batch.actions) {
    if (!exactKeys(action, ["from", "to", "valueWei", "data", "gasLimit", "slippageBps"]) || action.from !== batch.accountRef || !isAddress(action.from) || !isAddress(action.to) || !isHexData(action.data)) fail("BATCH_ACTIONS_INVALID");
    const value = decimal(action.valueWei, "BATCH_ACTIONS_INVALID");
    const gas = decimal(action.gasLimit, "BATCH_ACTIONS_INVALID");
    const slippage = decimal(action.slippageBps, "BATCH_ACTIONS_INVALID");
    if (value > (1n << 256n) - 1n || gas < 1n || gas > (1n << 256n) - 1n || slippage > 10000n) fail("BATCH_ACTIONS_INVALID");
    totalGas += gas;
    const actionCommitment = canonical(action);
    if (actionCommitments.has(actionCommitment)) fail("BATCH_ACTION_REUSE_INVALID");
    actionCommitments.add(actionCommitment);
  }
  const gasCeiling = decimal(batch.gasCeiling, "BATCH_GAS_INVALID");
  if (gasCeiling < 1n || gasCeiling > (1n << 256n) - 1n || totalGas > gasCeiling) fail("BATCH_GAS_INVALID");
}
function validateApprovalEnvelope(batch) {
  if (!exactKeys(batch.approval, ["scheme", "approverId", "scopeCommitment", "signature"]) || batch.approval.scheme !== "Ed25519" || !validRef(batch.approval.approverId) || !/^0x[0-9a-f]{64}$/u.test(batch.approval.scopeCommitment) || typeof batch.approval.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/u.test(batch.approval.signature)) fail("BATCH_APPROVAL_INVALID");
}
function validateBatchV2(batch) {
  if (!exactKeys(batch, BATCH_KEYS) || batch.schema !== SCHEMA) fail("BATCH_SCHEMA_INVALID");
  if (typeof batch.batchId !== "string" || !/^[0-9a-f]{8,32}$/u.test(batch.batchId)) fail("BATCH_ID_INVALID");
  if (!MODES.includes(batch.mode)) fail("BATCH_MODE_INVALID");
  const chainId = decimal(batch.chainId, "BATCH_CHAIN_INVALID");
  if (chainId < 1n || chainId > (1n << 63n)) fail("BATCH_CHAIN_INVALID");
  if (!isAddress(batch.accountRef)) fail("BATCH_ACCOUNT_INVALID");
  validateActions(batch);
  if (!exactKeys(batch.anvil, ["executablePath", "sha256", "version"]) || typeof batch.anvil.executablePath !== "string" || !path.isAbsolute(batch.anvil.executablePath) || typeof batch.anvil.sha256 !== "string" || !/^0x[0-9a-f]{64}$/u.test(batch.anvil.sha256) || !validRef(batch.anvil.version)) fail("BATCH_ANVIL_PIN_INVALID");
  const issuedAt = isoSeconds(batch.issuedAt, "BATCH_TIME_INVALID");
  const notBefore = isoSeconds(batch.notBefore, "BATCH_TIME_INVALID");
  const expiresAt = isoSeconds(batch.expiresAt, "BATCH_TIME_INVALID");
  if (issuedAt > notBefore || notBefore > expiresAt) fail("BATCH_WINDOW_INVALID");
  if (expiresAt - notBefore > CAPS.maxValiditySeconds || expiresAt - issuedAt > CAPS.maxValiditySeconds) fail("BATCH_WINDOW_TOO_LONG");
  if (typeof batch.nonce !== "string" || !/^[0-9a-f]{8,32}$/u.test(batch.nonce)) fail("BATCH_NONCE_INVALID");
  validateApprovalEnvelope(batch);
  assertNoNumbers(batch);
  leakGuard(batch);
  return true;
}
function validateBatchV3(batch) {
  if (!isPlainObject(batch) || batch.schema !== SCHEMA_V3) fail("BATCH_SCHEMA_INVALID");
  if (!MODES_V3.includes(batch.mode)) fail("BATCH_MODE_INVALID");
  if (!exactKeys(batch, batch.mode === "PRODUCTION" ? BATCH_KEYS_V3_ATTESTED : BATCH_KEYS_V3)) fail("BATCH_SCHEMA_INVALID");
  if (typeof batch.batchId !== "string" || !/^[0-9a-f]{8,32}$/u.test(batch.batchId)) fail("BATCH_ID_INVALID");
  const chainId = decimal(batch.chainId, "BATCH_CHAIN_INVALID");
  if (chainId < 1n || chainId > (1n << 63n)) fail("BATCH_CHAIN_INVALID");
  if (!isAddress(batch.accountRef)) fail("BATCH_ACCOUNT_INVALID");
  validateActions(batch);
  if (!exactKeys(batch.feeCap, FEE_CAP_KEYS)) fail("BATCH_FEE_CAP_INVALID");
  const maxFeePerGasWei = decimal(batch.feeCap.maxFeePerGasWei, "BATCH_FEE_CAP_INVALID");
  const maxPriorityFeePerGasWei = decimal(batch.feeCap.maxPriorityFeePerGasWei, "BATCH_FEE_CAP_INVALID");
  if (maxFeePerGasWei > (1n << 256n) - 1n || maxPriorityFeePerGasWei > (1n << 256n) - 1n) fail("BATCH_FEE_CAP_INVALID");
  if (batch.mode === "PRODUCTION" && (typeof batch.testnetAttestation !== "string" || !/^0x[0-9a-f]{64}$/u.test(batch.testnetAttestation))) fail("BATCH_TESTNET_ATTESTATION_INVALID");
  const issuedAt = isoSeconds(batch.issuedAt, "BATCH_TIME_INVALID");
  const notBefore = isoSeconds(batch.notBefore, "BATCH_TIME_INVALID");
  const expiresAt = isoSeconds(batch.expiresAt, "BATCH_TIME_INVALID");
  if (issuedAt > notBefore || notBefore > expiresAt) fail("BATCH_WINDOW_INVALID");
  if (expiresAt - notBefore > CAPS.maxValiditySeconds || expiresAt - issuedAt > CAPS.maxValiditySeconds) fail("BATCH_WINDOW_TOO_LONG");
  if (typeof batch.nonce !== "string" || !/^[0-9a-f]{8,32}$/u.test(batch.nonce)) fail("BATCH_NONCE_INVALID");
  validateApprovalEnvelope(batch);
  assertNoNumbers(batch);
  leakGuard(batch);
  return true;
}
function validateBatch(batch) {
  if (isPlainObject(batch) && batch.schema === SCHEMA_V3) return validateBatchV3(batch);
  return validateBatchV2(batch);
}
function scopeView(batch) {
  if (isPlainObject(batch) && batch.schema === SCHEMA_V3) {
    const keys = Object.hasOwn(batch, "testnetAttestation") ? SCOPE_KEYS_V3_ATTESTED : SCOPE_KEYS_V3;
    return Object.fromEntries(keys.map((key) => [key, batch[key]]));
  }
  return Object.fromEntries(SCOPE_KEYS.map((key) => [key, batch[key]]));
}
function scopeCommitment(batch) {
  return `0x${crypto.createHash("sha256").update(canonical(scopeView(batch))).digest("hex")}`;
}
function commitment(batch) {
  return `0x${crypto.createHash("sha256").update(canonical(batch)).digest("hex")}`;
}
function approvalMessage(scopeCommitmentValue, approval, schema = SCHEMA) {
  if (!approval || approval.scheme !== "Ed25519" || !validRef(approval.approverId)) fail("BATCH_APPROVAL_INVALID");
  const domain = schema === SCHEMA_V3 ? APPROVAL_DOMAIN_V3 : APPROVAL_DOMAIN;
  return Buffer.from(`${domain}${canonical({ scheme: approval.scheme, approverId: approval.approverId, scopeCommitment: scopeCommitmentValue })}`, "utf8");
}
function isReparse(stat) {
  return stat.isSymbolicLink() || (stat.mode & 0o170000) === 0o120000;
}
function identity(stat, realPath) {
  if (!stat || !Number.isFinite(stat.dev) || !Number.isFinite(stat.ino) || stat.dev === 0 || stat.ino === 0) fail("FILESYSTEM_IDENTITY_UNAVAILABLE");
  return { realPath, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeMs: String(stat.mtimeMs) };
}
function sameIdentity(left, right) {
  return Boolean(left && right) && left.realPath === right.realPath && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
function checkedPath(file, io = fs, kind = "file", allowAbsent = false) {
  const expected = path.resolve(file);
  let first;
  try { first = io.lstatSync(expected); } catch (error) { if (allowAbsent && error?.code === "ENOENT") return null; fail("FILESYSTEM_PATH_UNAVAILABLE"); }
  if (isReparse(first) || (kind === "file" ? !first.isFile() : !first.isDirectory())) fail("FILESYSTEM_PATH_UNSAFE");
  let realPath;
  try { realPath = io.realpathSync(expected); } catch (_) { fail("FILESYSTEM_PATH_UNSAFE"); }
  if (realPath !== expected) fail("FILESYSTEM_PATH_UNSAFE");
  const parent = path.dirname(expected);
  let parentStat;
  try { parentStat = io.lstatSync(parent); } catch (_) { fail("FILESYSTEM_PARENT_UNSAFE"); }
  if (isReparse(parentStat) || !parentStat.isDirectory()) fail("FILESYSTEM_PARENT_UNSAFE");
  return identity(first, realPath);
}
function secureFilesystemSupported(io = fs) {
  return process.platform === "linux" && Number.isInteger(io.constants?.O_NOFOLLOW || fs.constants.O_NOFOLLOW) && typeof io.fstatSync === "function" && typeof io.readSync === "function";
}
function checkedRead(file, io = fs, allowAbsent = false) {
  const canonicalPath = path.resolve(file) === BATCH_PATH || path.resolve(file) === REGISTRY_PATH;
  const before = checkedPath(file, io, "file", allowAbsent);
  if (!before) return null;
  if (canonicalPath && !secureFilesystemSupported(io)) fail("FILESYSTEM_SECURE_IDENTITY_UNSUPPORTED");
  let fd;
  try {
    const noFollow = io.constants?.O_NOFOLLOW || fs.constants.O_NOFOLLOW || 0;
    fd = io.openSync(file, (io.constants?.O_RDONLY ?? fs.constants.O_RDONLY) | (secureFilesystemSupported(io) ? noFollow : 0));
    const fdBefore = io.fstatSync(fd);
    const fdIdentity = identity(fdBefore, before.realPath);
    if (!sameIdentity(before, fdIdentity)) fail("FILESYSTEM_IDENTITY_CHANGED");
    if (fdBefore.size > CAPS.batchBytes) fail("FILESYSTEM_READ_SIZE_INVALID");
    const bytes = Buffer.alloc(fdBefore.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = io.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(read) || read <= 0) fail("FILESYSTEM_READ_INCOMPLETE");
      offset += read;
    }
    const fdAfter = io.fstatSync(fd);
    const after = checkedPath(file, io, "file");
    const afterIdentity = identity(fdAfter, before.realPath);
    if (!sameIdentity(before, after) || !sameIdentity(fdIdentity, afterIdentity)) fail("FILESYSTEM_IDENTITY_CHANGED");
    return { bytes, identity: after };
  } catch (error) {
    if (error instanceof BatchError) throw error;
    fail("FILESYSTEM_READ_FAILED");
  } finally { if (fd !== undefined) try { io.closeSync(fd); } catch (_) { fail("FILESYSTEM_READ_CLOSE_FAILED"); } }
}
function canonicalRegistryDigest(sourcePin, envAssertion) {
  if (typeof sourcePin !== "string" || !/^0x[0-9a-f]{64}$/u.test(sourcePin)) fail("APPROVER_REGISTRY_TRUST_ANCHOR_UNAVAILABLE");
  if (envAssertion === undefined) return sourcePin;
  if (typeof envAssertion !== "string" || !/^0x[0-9a-f]{64}$/u.test(envAssertion)) fail("APPROVER_REGISTRY_ENV_ASSERTION_INVALID");
  if (envAssertion !== sourcePin) fail("APPROVER_REGISTRY_ENV_ASSERTION_MISMATCH");
  return sourcePin;
}
function trustedRegistryDigest(options = {}) {
  const registryPath = path.resolve(options.registryPath || REGISTRY_PATH);
  if (registryPath === REGISTRY_PATH) return canonicalRegistryDigest(CANONICAL_REGISTRY_SHA256, process.env[TRUST_ANCHOR_ENV]);
  const value = options.registrySha256 || options.trustedRegistrySha256;
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/u.test(value)) fail("APPROVER_REGISTRY_TRUST_ANCHOR_UNAVAILABLE");
  return value;
}
function readRegistry(options, io) {
  const registryPath = options.registryPath || REGISTRY_PATH;
  if (path.resolve(options.batchPath || BATCH_PATH) === BATCH_PATH && path.resolve(registryPath) !== REGISTRY_PATH) fail("CANONICAL_REGISTRY_REQUIRED");
  const expectedRegistryDigest = trustedRegistryDigest({ ...options, registryPath });
  let read;
  try { read = checkedRead(registryPath, io); } catch (error) { if (error.code === "FILESYSTEM_PATH_UNAVAILABLE") fail("APPROVER_REGISTRY_UNAVAILABLE"); throw error; }
  const raw = read.bytes.toString("utf8");
  if (read.bytes.length > CAPS.registryBytes) fail("APPROVER_REGISTRY_INVALID");
  const registryFingerprint = `0x${crypto.createHash("sha256").update(read.bytes).digest("hex")}`;
  if (registryFingerprint !== expectedRegistryDigest) fail("APPROVER_REGISTRY_TRUST_ANCHOR_MISMATCH");
  let registry;
  try { registry = JSON.parse(raw); } catch (_) { fail("APPROVER_REGISTRY_INVALID"); }
  if (!exactKeys(registry, ["schema", "approvers"]) || registry.schema !== REGISTRY_SCHEMA || !Array.isArray(registry.approvers) || registry.approvers.length < 1 || registry.approvers.length > CAPS.approvers) fail("APPROVER_REGISTRY_INVALID");
  const ids = new Set(), keys = new Set();
  for (const row of registry.approvers) {
    if (!exactKeys(row, ["approverId", "algorithm", "publicKeySpkiDerBase64"]) || !validRef(row.approverId) || row.algorithm !== "Ed25519" || typeof row.publicKeySpkiDerBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(row.publicKeySpkiDerBase64) || ids.has(row.approverId)) fail("APPROVER_REGISTRY_INVALID");
    let exported;
    try {
      const bytes = Buffer.from(row.publicKeySpkiDerBase64, "base64");
      if (bytes.toString("base64") !== row.publicKeySpkiDerBase64) fail("APPROVER_REGISTRY_INVALID");
      const key = crypto.createPublicKey({ key: bytes, format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") fail("APPROVER_REGISTRY_INVALID");
      exported = key.export({ format: "der", type: "spki" }).toString("base64");
    } catch (error) { if (error instanceof BatchError) throw error; fail("APPROVER_REGISTRY_INVALID"); }
    if (keys.has(exported)) fail("APPROVER_REGISTRY_DUPLICATE_KEY");
    row.publicKeySpkiDerBase64 = exported;
    ids.add(row.approverId); keys.add(exported);
  }
  assertNoNumbers(registry);
  return { registry, registryFingerprint, identity: read.identity };
}
function verifyApproval(batch, options, io) {
  const expectedScopeCommitment = scopeCommitment(batch);
  if (batch.approval.scopeCommitment !== expectedScopeCommitment) fail("BATCH_APPROVAL_SCOPE_MISMATCH");
  const { registry, registryFingerprint } = readRegistry(options, io);
  const approver = registry.approvers.find((row) => row.approverId === batch.approval.approverId);
  if (!approver) fail("BATCH_APPROVER_UNTRUSTED");
  let key;
  let signature;
  try {
    const keyBytes = Buffer.from(approver.publicKeySpkiDerBase64, "base64");
    if (keyBytes.toString("base64") !== approver.publicKeySpkiDerBase64) fail("APPROVER_REGISTRY_INVALID");
    key = crypto.createPublicKey({ key: keyBytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") fail("APPROVER_REGISTRY_INVALID");
    signature = Buffer.from(batch.approval.signature, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== batch.approval.signature) fail("BATCH_APPROVAL_INVALID");
  } catch (error) {
    if (error instanceof BatchError) throw error;
    fail("BATCH_APPROVAL_INVALID");
  }
  if (!crypto.verify(null, approvalMessage(expectedScopeCommitment, batch.approval, batch.schema), key, signature)) fail("BATCH_APPROVAL_SIGNATURE_INVALID");
  return { approverId: batch.approval.approverId, registryFingerprint, keyFingerprint: `0x${crypto.createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex")}`, scopeCommitment: expectedScopeCommitment };
}
function terminalPathFor(batchCommitment, batchPath = BATCH_PATH) {
  if (typeof batchCommitment !== "string" || !/^0x[0-9a-f]{64}$/u.test(batchCommitment)) fail("BATCH_COMMITMENT_INVALID");
  return path.join(path.dirname(batchPath), `${TERMINAL_PREFIX}${batchCommitment.slice(2)}.json`);
}
function summary(batch) {
  return { schema: batch.schema, batchId: batch.batchId, mode: batch.mode, chainId: batch.chainId, accountRef: batch.accountRef, actionCount: String(batch.actions.length), gasCeiling: batch.gasCeiling, issuedAt: batch.issuedAt, notBefore: batch.notBefore, expiresAt: batch.expiresAt };
}
function report(stateResult) {
  const row = { authorizationState: stateResult.state };
  if (stateResult.reason) row.reason = stateResult.reason;
  if (stateResult.batchCommitment) row.batchCommitment = stateResult.batchCommitment;
  if (stateResult.scopeCommitment) row.scopeCommitment = stateResult.scopeCommitment;
  if (stateResult.approval) row.approval = stateResult.approval;
  if (stateResult.batch) row.batch = summary(stateResult.batch);
  if (stateResult.terminal) row.terminal = { state: stateResult.terminal.state, terminalAt: stateResult.terminal.terminalAt };
  return row;
}
function parseTerminal(raw, batch, batchCommitmentValue) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > CAPS.markerBytes) fail("TERMINAL_MARKER_INVALID");
  let marker;
  try { marker = JSON.parse(raw); } catch (_) { fail("TERMINAL_MARKER_INVALID"); }
  const commonValid = marker.schema === TERMINAL_SCHEMA && marker.batchId === batch.batchId && marker.batchCommitment === batchCommitmentValue;
  if (marker.state === STATES.CONSUMED) {
    if (!commonValid || !exactKeys(marker, ["schema", "state", "batchId", "batchCommitment", "manifestCommitment", "runId", "terminalAt"]) || !/^0x[0-9a-f]{64}$/u.test(marker.manifestCommitment) || !validRef(marker.runId)) fail("TERMINAL_MARKER_INVALID");
  } else if (marker.state === STATES.REVOKED) {
    if (!commonValid || !exactKeys(marker, ["schema", "state", "batchId", "batchCommitment", "revocationRef", "terminalAt"]) || !validRef(marker.revocationRef)) fail("TERMINAL_MARKER_INVALID");
  } else fail("TERMINAL_MARKER_INVALID");
  isoSeconds(marker.terminalAt, "TERMINAL_MARKER_INVALID");
  assertNoNumbers(marker);
  leakGuard(marker);
  return marker;
}
function batchState(options = {}) {
  const io = options.io || fs;
  const batchPath = options.batchPath || BATCH_PATH;
  const now = options.now || Date.now;
  let read;
  try { read = checkedRead(batchPath, io, true); }
  catch (error) { return { state: STATES.INVALID, reason: error instanceof BatchError ? error.code : "BATCH_READ_FAILED" }; }
  if (!read) return { state: STATES.ABSENT };
  const raw = read.bytes.toString("utf8");
  if (read.bytes.length > CAPS.batchBytes) return { state: STATES.INVALID, reason: "BATCH_SIZE_INVALID" };
  let batch;
  try { batch = JSON.parse(raw); } catch (_) { return { state: STATES.INVALID, reason: "BATCH_JSON_INVALID" }; }
  let batchCommitmentValue, approval;
  try {
    validateBatch(batch);
    approval = verifyApproval(batch, options, io);
    batchCommitmentValue = commitment(batch);
  } catch (error) {
    return { state: STATES.INVALID, reason: error instanceof BatchError ? error.code : "BATCH_VALIDATION_FAILED" };
  }
  const markerPath = terminalPathFor(batchCommitmentValue, batchPath);
  try {
    const markerRead = checkedRead(markerPath, io, true);
    if (markerRead) {
      const marker = parseTerminal(markerRead.bytes.toString("utf8"), batch, batchCommitmentValue);
      return { state: marker.state, batch, batchCommitment: batchCommitmentValue, scopeCommitment: approval.scopeCommitment, approval, terminal: marker };
    }
  } catch (error) {
    return { state: STATES.INVALID, reason: error instanceof BatchError ? error.code : "TERMINAL_MARKER_INVALID" };
  }
  const nowSeconds = Math.floor(now() / 1000);
  if (nowSeconds < isoSeconds(batch.notBefore, "BATCH_TIME_INVALID")) return { state: STATES.NOT_YET_VALID, batch, batchCommitment: batchCommitmentValue, scopeCommitment: approval.scopeCommitment, approval };
  if (nowSeconds >= isoSeconds(batch.expiresAt, "BATCH_TIME_INVALID")) return { state: STATES.EXPIRED, batch, batchCommitment: batchCommitmentValue, scopeCommitment: approval.scopeCommitment, approval };
  return { state: STATES.VALID, batch, batchCommitment: batchCommitmentValue, scopeCommitment: approval.scopeCommitment, approval };
}
function checkAction(batch, action, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= batch.actions.length) return { ok: false, reason: "SCOPE_ACTION_COUNT_OR_ORDER_MISMATCH" };
  if (!exactKeys(action, ["chainId", "from", "to", "valueWei", "data", "gasLimit", "slippageBps"])) return { ok: false, reason: "ACTION_INVALID" };
  if (action.chainId !== batch.chainId) return { ok: false, reason: "SCOPE_CHAIN_MISMATCH" };
  const expected = batch.actions[index];
  const fields = [["from", "SCOPE_ACTOR_MISMATCH"], ["to", "SCOPE_TARGET_MISMATCH"], ["valueWei", "SCOPE_VALUE_MISMATCH"], ["data", "SCOPE_CALLDATA_MISMATCH"], ["gasLimit", "SCOPE_GAS_MISMATCH"], ["slippageBps", "SCOPE_SLIPPAGE_MISMATCH"]];
  for (const [field, reason] of fields) if (action[field] !== expected[field]) return { ok: false, reason };
  return { ok: true };
}
function authorizationRow(options = {}) { return report(batchState(options)); }
function fsyncParent(file, io = fs) {
  let fd;
  try { fd = io.openSync(path.dirname(file), "r"); io.fsyncSync(fd); return "SUPPORTED"; }
  catch (_) { return "UNSUPPORTED"; }
  finally { if (fd !== undefined) try { io.closeSync(fd); } catch (_) { /* fail closed at caller */ } }
}
function durableExclusiveWrite(file, bytes, options = {}) {
  const io = options.io || fs;
  const strict = options.requireDurable === true;
  if (strict && fsyncParent(file, io) !== "SUPPORTED") fail("DURABILITY_UNSUPPORTED");
  const staging = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let fd;
  let stagingCreated = false;
  const close = () => {
    if (fd === undefined) return;
    const openFd = fd;
    fd = undefined;
    try { io.closeSync(openFd); } catch (_) { fail("DURABLE_CLOSE_FAILED"); }
  };
  const cleanup = () => {
    if (!stagingCreated) return;
    try { io.unlinkSync(staging); } catch (error) { if (error?.code !== "ENOENT") fail("DURABLE_CLEANUP_FAILED"); }
    stagingCreated = false;
  };
  try {
    fd = io.openSync(staging, "wx", 0o600);
    stagingCreated = true;
    let offset = 0;
    while (offset < bytes.length) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) fail("DURABLE_WRITE_INCOMPLETE");
      offset += written;
    }
    io.fsyncSync(fd);
  } catch (error) {
    try { close(); } catch (closeError) { cleanup(); throw closeError; }
    cleanup();
    if (error instanceof BatchError) throw error;
    if (error?.code === "EEXIST") fail("BATCH_ALREADY_EXISTS");
    fail("DURABLE_WRITE_FAILED");
  }
  try { close(); } catch (error) { cleanup(); throw error; }
  let reread;
  try {
    reread = checkedRead(staging, io);
    if (!reread.bytes.equals(bytes)) fail("DURABLE_READBACK_MISMATCH");
  } catch (error) { cleanup(); throw error; }
  try {
    io.linkSync(staging, file);
  } catch (error) {
    cleanup();
    if (error?.code === "EEXIST") fail("BATCH_ALREADY_EXISTS");
    fail("DURABLE_PUBLISH_FAILED");
  }
  try {
    const published = checkedRead(file, io);
    const matchesStagedFile = (identity) => reread.identity.dev === identity.dev && reread.identity.ino === identity.ino && reread.identity.size === identity.size && reread.identity.mtimeMs === identity.mtimeMs;
    if (!published.bytes.equals(bytes) || !matchesStagedFile(published.identity)) fail("DURABLE_READBACK_MISMATCH");
    cleanup();
    const parentDurability = fsyncParent(file, io);
    if (strict && parentDurability !== "SUPPORTED") fail("DURABILITY_COMMIT_INDETERMINATE");
    const afterParentFsync = checkedRead(file, io);
    if (!afterParentFsync.bytes.equals(bytes) || !matchesStagedFile(afterParentFsync.identity)) fail("DURABLE_READBACK_MISMATCH");
    return { identity: afterParentFsync.identity, parentDurability, committed: true };
  } catch (error) {
    try { cleanup(); } catch (cleanupError) { if (strict) fail("DURABILITY_COMMIT_INDETERMINATE"); throw cleanupError; }
    if (strict) fail("DURABILITY_COMMIT_INDETERMINATE");
    throw error;
  }
}
function writeBatch(batch, options = {}) {
  validateBatch(batch);
  const io = options.io || fs;
  const batchPath = options.batchPath || BATCH_PATH;
  verifyApproval(batch, options, io);
  checkedPath(path.dirname(batchPath), io, "directory");
  const bytes = Buffer.from(`${JSON.stringify(batch, null, 2)}\n`);
  if (bytes.length > CAPS.batchBytes) fail("BATCH_SIZE_INVALID");
  const durable = durableExclusiveWrite(batchPath, bytes, { io, requireDurable: options.requireDurable ?? path.resolve(batchPath) === BATCH_PATH });
  return { batchPath, bytes: String(bytes.length), parentDurability: durable.parentDurability };
}
function terminalize(options, terminal) {
  const io = options.io || fs;
  const batchPath = options.batchPath || BATCH_PATH;
  const now = options.now || Date.now;
  const state = batchState({ ...options, io, batchPath, now });
  if (state.state !== STATES.VALID) fail(`BATCH_TERMINAL_${state.state}${state.reason ? `_${state.reason}` : ""}`);
  if (options.expectedBatchCommitment !== state.batchCommitment) fail("BATCH_COMMITMENT_MISMATCH");
  const marker = { schema: TERMINAL_SCHEMA, state: terminal.state, batchId: state.batch.batchId, batchCommitment: state.batchCommitment, ...terminal.fields, terminalAt: new Date(now()).toISOString() };
  const markerPath = terminalPathFor(state.batchCommitment, batchPath);
  checkedPath(path.dirname(markerPath), io, "directory");
  try { durableExclusiveWrite(markerPath, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`), { io, requireDurable: options.requireDurable ?? path.resolve(batchPath) === BATCH_PATH }); }
  catch (error) { if (error.code === "BATCH_ALREADY_EXISTS") fail("BATCH_ALREADY_TERMINAL"); throw error; }
  const finalState = batchState({ ...options, io, batchPath, now });
  if (finalState.state !== terminal.state || finalState.batchCommitment !== state.batchCommitment) fail("BATCH_TERMINAL_RECHECK_FAILED");
  return marker;
}
function consumeBatch(options = {}) {
  if (!/^0x[0-9a-f]{64}$/u.test(options.expectedBatchCommitment || "")) fail("BATCH_COMMITMENT_INVALID");
  if (!/^0x[0-9a-f]{64}$/u.test(options.manifestCommitment || "")) fail("BATCH_MANIFEST_COMMITMENT_INVALID");
  if (!validRef(options.runId)) fail("BATCH_RUN_ID_INVALID");
  return terminalize(options, { state: STATES.CONSUMED, fields: { manifestCommitment: options.manifestCommitment, runId: options.runId } });
}
function revokeBatch(options = {}) {
  if (!/^0x[0-9a-f]{64}$/u.test(options.expectedBatchCommitment || "")) fail("BATCH_COMMITMENT_INVALID");
  if (!validRef(options.revocationRef)) fail("BATCH_REF_INVALID");
  const io = options.io || fs;
  const batchPath = options.batchPath || BATCH_PATH;
  const marker = terminalize(options, { state: STATES.REVOKED, fields: { revocationRef: options.revocationRef } });
  const archive = `${batchPath}.revoked-${marker.batchCommitment.slice(2)}`;
  const before = checkedPath(batchPath, io, "file");
  try { io.renameSync(batchPath, archive); } catch (_) { return { archive: null, archiveStatus: "ARCHIVE_NOT_COMPLETED", marker }; }
  const after = checkedPath(archive, io, "file");
  if (before.dev !== after.dev || before.ino !== after.ino) fail("BATCH_REVOKE_IDENTITY_CHANGED");
  if (fsyncParent(archive, io) !== "SUPPORTED" && (options.requireDurable ?? path.resolve(batchPath) === BATCH_PATH)) return { archive, archiveStatus: "ARCHIVE_DURABILITY_UNCONFIRMED", marker };
  return { archive, archiveStatus: "ARCHIVED", marker };
}
function archiveDirectoryFor(batchPath = BATCH_PATH) {
  return path.join(path.dirname(path.resolve(batchPath)), ARCHIVE_DIR);
}
function archivedBatchPathFor(batchCommitment, batchPath = BATCH_PATH) {
  if (typeof batchCommitment !== "string" || !/^0x[0-9a-f]{64}$/u.test(batchCommitment)) fail("BATCH_COMMITMENT_INVALID");
  return path.join(archiveDirectoryFor(batchPath), `${path.basename(batchPath)}.${batchCommitment.slice(2)}`);
}
function archivedTerminalPathFor(batchCommitment, batchPath = BATCH_PATH) {
  if (typeof batchCommitment !== "string" || !/^0x[0-9a-f]{64}$/u.test(batchCommitment)) fail("BATCH_COMMITMENT_INVALID");
  return path.join(archiveDirectoryFor(batchPath), `${TERMINAL_PREFIX}${batchCommitment.slice(2)}.json`);
}
function ensureArchiveDirectory(archiveDir, io = fs) {
  let existing = null;
  try { existing = checkedPath(archiveDir, io, "directory", true); }
  catch (_) { fail("CLEAR_CONSUMED_ARCHIVE_UNAVAILABLE"); }
  if (existing) return { archiveDir, created: false };
  try { checkedPath(path.dirname(archiveDir), io, "directory"); }
  catch (_) { fail("CLEAR_CONSUMED_ARCHIVE_UNAVAILABLE"); }
  try { io.mkdirSync(archiveDir, { mode: 0o700 }); }
  catch (error) {
    if (error?.code !== "EEXIST") fail("CLEAR_CONSUMED_ARCHIVE_UNAVAILABLE");
    try { checkedPath(archiveDir, io, "directory"); return { archiveDir, created: false }; }
    catch (_) { fail("CLEAR_CONSUMED_ARCHIVE_UNAVAILABLE"); }
  }
  try { checkedPath(archiveDir, io, "directory"); }
  catch (_) { fail("CLEAR_CONSUMED_ARCHIVE_UNAVAILABLE"); }
  return { archiveDir, created: true };
}
function clearConsumedBatch(options = {}) {
  const io = options.io || fs;
  const batchPath = options.batchPath || BATCH_PATH;
  const now = options.now || Date.now;
  const requireDurable = options.requireDurable ?? (path.resolve(batchPath) === BATCH_PATH);
  const state = batchState({ ...options, io, batchPath, now });
  if (state.state === STATES.ABSENT) {
    return { ok: true, authorizationState: STATES.ABSENT, cleared: false, archive: null };
  }
  if (state.state === STATES.VALID) fail("CLEAR_CONSUMED_REFUSED_VALID");
  if (state.state !== STATES.CONSUMED) fail(`CLEAR_CONSUMED_REFUSED_${state.state}`);
  const batchCommitment = state.batchCommitment;
  if (typeof batchCommitment !== "string" || !/^0x[0-9a-f]{64}$/u.test(batchCommitment)) fail("BATCH_COMMITMENT_INVALID");
  const markerPath = terminalPathFor(batchCommitment, batchPath);
  const archiveDir = archiveDirectoryFor(batchPath);
  const archiveBatchPath = archivedBatchPathFor(batchCommitment, batchPath);
  const archiveTerminalPath = archivedTerminalPathFor(batchCommitment, batchPath);
  ensureArchiveDirectory(archiveDir, io);
  let archiveBatchPresent;
  let archiveTerminalPresent;
  try {
    archiveBatchPresent = checkedPath(archiveBatchPath, io, "file", true);
    archiveTerminalPresent = checkedPath(archiveTerminalPath, io, "file", true);
  } catch (_) { fail("CLEAR_CONSUMED_ARCHIVE_UNSAFE"); }
  if (archiveBatchPresent || archiveTerminalPresent) fail("CLEAR_CONSUMED_ARCHIVE_EXISTS");
  const batchBefore = checkedPath(batchPath, io, "file");
  const markerBefore = checkedPath(markerPath, io, "file");
  try { io.renameSync(batchPath, archiveBatchPath); }
  catch (error) { if (error instanceof BatchError) throw error; fail("CLEAR_CONSUMED_ARCHIVE_MOVE_FAILED"); }
  const batchAfter = checkedPath(archiveBatchPath, io, "file");
  if (batchBefore.dev !== batchAfter.dev || batchBefore.ino !== batchAfter.ino) fail("CLEAR_CONSUMED_IDENTITY_CHANGED");
  try { io.renameSync(markerPath, archiveTerminalPath); }
  catch (error) { if (error instanceof BatchError) throw error; fail("CLEAR_CONSUMED_ARCHIVE_MOVE_FAILED"); }
  const markerAfter = checkedPath(archiveTerminalPath, io, "file");
  if (markerBefore.dev !== markerAfter.dev || markerBefore.ino !== markerAfter.ino) fail("CLEAR_CONSUMED_IDENTITY_CHANGED");
  const durability = fsyncParent(archiveTerminalPath, io);
  const archiveStatus = durability === "SUPPORTED" || !requireDurable ? "ARCHIVED" : "ARCHIVE_DURABILITY_UNCONFIRMED";
  const finalState = batchState({ ...options, io, batchPath, now });
  if (finalState.state !== STATES.ABSENT) fail("CLEAR_CONSUMED_RECHECK_FAILED");
  return { ok: true, authorizationState: STATES.ABSENT, cleared: true, batchCommitment, archive: { batch: archiveBatchPath, terminal: archiveTerminalPath }, archiveStatus };
}
function statusCommand(args) { if (args.length) fail("USAGE_ERROR"); return { ok: true, ...report(batchState()) }; }
function validateCommand(args) { if (args.length) fail("USAGE_ERROR"); const result = batchState(); return { ok: result.state === STATES.VALID, ...report(result) }; }
function activateCommand(args) {
  if (args.length !== 1 || !path.isAbsolute(args[0])) fail("USAGE_ERROR");
  const read = checkedRead(args[0]);
  let batch;
  try { batch = JSON.parse(read.bytes.toString("utf8")); } catch (_) { fail("BATCH_JSON_INVALID"); }
  const installed = writeBatch(batch, { requireDurable: true });
  const state = batchState();
  if (state.state !== STATES.VALID || state.batchCommitment !== commitment(batch)) fail("BATCH_ACTIVATION_RECHECK_FAILED");
  return { ok: true, authorizationState: state.state, batchCommitment: state.batchCommitment, scopeCommitment: state.scopeCommitment, parentDurability: installed.parentDurability };
}
function revokeCommand(args) {
  if (args.length !== 2) fail("USAGE_ERROR");
  const result = revokeBatch({ expectedBatchCommitment: args[0], revocationRef: args[1], requireDurable: true });
  return { ok: true, archive: result.archive ? path.basename(result.archive) : null, archiveStatus: result.archiveStatus, terminal: { state: result.marker.state, batchCommitment: result.marker.batchCommitment } };
}
function clearConsumedCommand(args) {
  if (args.length) fail("USAGE_ERROR");
  const result = clearConsumedBatch({ requireDurable: true });
  const row = { ok: true, authorizationState: result.authorizationState, cleared: result.cleared };
  if (result.archive) {
    row.archive = { batch: path.basename(result.archive.batch), terminal: path.basename(result.archive.terminal) };
    row.archiveStatus = result.archiveStatus;
  } else {
    row.reason = "CLEAR_CONSUMED_ABSENT_NOOP";
  }
  return row;
}
function runCli(argv = process.argv) {
  try {
    const command = argv[2] || "status";
    const args = argv.slice(3);
    let result;
    if (command === "status") result = statusCommand(args);
    else if (command === "validate") result = validateCommand(args);
    else if (command === "activate") result = activateCommand(args);
    else if (command === "revoke") result = revokeCommand(args);
    else if (command === "clear-consumed") result = clearConsumedCommand(args);
    else fail("USAGE_ERROR");
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    const blocker = error instanceof BatchError ? error.code : "INTERNAL_FAILURE_REDACTED";
    process.stdout.write(`${JSON.stringify({ status: blocker === "DURABILITY_COMMIT_INDETERMINATE" ? "INDETERMINATE_COMMIT" : "FAIL_CLOSED", blocker })}\n`);
    process.exitCode = 1;
  }
}
if (require.main === module) runCli();

module.exports = {
  ROOT, BATCH_REL, REGISTRY_REL, BATCH_PATH, REGISTRY_PATH, SCHEMA, SCHEMA_V3, REGISTRY_SCHEMA, TERMINAL_SCHEMA, APPROVAL_DOMAIN, APPROVAL_DOMAIN_V3, TRUST_ANCHOR_ENV, CANONICAL_REGISTRY_SHA256,
  MODES, MODES_V3, STATES, CAPS, BatchError, fail, canonical, exactKeys, assertNoNumbers, decimal, isAddress, isoSeconds,
  leakGuard, validRef, validateBatch, validateBatchV2, validateBatchV3, scopeView, scopeCommitment, commitment, approvalMessage, canonicalRegistryDigest, trustedRegistryDigest, verifyApproval, checkedPath, checkedRead, sameIdentity, durableExclusiveWrite,
  terminalPathFor, summary, report, batchState, checkAction, authorizationRow, writeBatch, consumeBatch, revokeBatch,
  ARCHIVE_DIR, archiveDirectoryFor, archivedBatchPathFor, archivedTerminalPathFor, ensureArchiveDirectory, clearConsumedBatch,
  statusCommand, validateCommand, activateCommand, revokeCommand, clearConsumedCommand, runCli,
};
