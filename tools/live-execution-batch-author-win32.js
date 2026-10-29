#!/usr/bin/env node
"use strict";

// Constructs and signs a canonical live-execution batch approval using the
// DPAPI-protected Ed25519 approver key.
//
// This tool is deliberately NOT an activation tool: it only emits a signed
// artifact at the caller-provided `--out` path. It never writes
// `coordination/live-execution-batch.json`, never creates a terminal marker,
// and never reports a `VALID` lifecycle state. Installing the signed artifact
// remains the job of `live-execution-batch.js activate`.
//
// The signed bytes are exactly the real module's canonical form:
//   approvalMessage(scopeCommitment(scope), { scheme:"Ed25519", approverId }, schema)
// The commitment is always derived by the real module; callers cannot supply a
// digest. The derived custody public key must match the pinned registry entry
// before a signature is produced.
//
// Why `--registry` exists: the batch module routes the canonical registry (and
// canonical batch) path through its secure-descriptor reader, which requires
// Linux. The DPAPI approver custody key only exists on Windows, so the canonical
// read can never succeed where this tool actually runs. The optional
// `propose --registry <absolute-path>` flag points BOTH this tool's own registry
// read and the `verifyApproval` round-trip at a caller-supplied absolute copy of
// the registry, avoiding the Linux-only canonical gate.
//
// The override does NOT weaken the trust anchor. The bytes read from the
// override path must still hash to the pinned canonical digest
// (`CANONICAL_REGISTRY_SHA256`) through the existing
// `batchTool.trustedRegistryDigest` mechanism, and the custody-derived public
// key must still equal the pinned registry entry before signing. A copy that is
// not byte-identical to the canonical registry is refused with
// `APPROVER_REGISTRY_TRUST_ANCHOR_MISMATCH`; the digest is never a CLI input.
// When `--registry` is omitted, every read uses the canonical path exactly as
// before.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const batchTool = require("./live-execution-batch.js");
const defaultCustody = require("./live-execution-custody-win32.js");

const PINNED_APPROVER_ID = defaultCustody.APPROVER_ID;
const SUPPORTED_SCHEMAS = new Set([batchTool.SCHEMA, batchTool.SCHEMA_V3]);
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/u;
const URL_VALUE_RE = /(?:https?|wss?|ftp|file):\/\//iu;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const TERMINAL_PREFIX = "live-execution-batch-terminal-";
const REGISTRY_MAX_BYTES = 64 * 1024;

class AuthorError extends Error {
  constructor(code) { super(code); this.name = "AuthorError"; this.code = code; }
}
const fail = (code) => { throw new AuthorError(code); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function publicError(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/u.test(error.code) ? error.code : "INTERNAL_FAILURE_REDACTED";
  return { ok: false, status: "FAIL_CLOSED", code };
}

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------
function assertLocalPath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) fail(code);
  if (CONTROL_RE.test(value)) fail(code);
  if (URL_VALUE_RE.test(value)) fail(code);
  if (!path.isAbsolute(value)) fail(code);
  const resolved = path.resolve(value);
  if (resolved === batchTool.BATCH_PATH) fail(code === "OUT_PATH_INVALID" ? "CANONICAL_BATCH_PATH_FORBIDDEN" : code);
  const coordinationDir = path.dirname(batchTool.BATCH_PATH);
  const lowerResolved = resolved.toLowerCase(), lowerDir = coordinationDir.toLowerCase();
  if (lowerResolved === lowerDir || lowerResolved.startsWith(`${lowerDir}${path.sep}`)) {
    if (code !== "OUT_PATH_INVALID") fail(code);
    fail("COORDINATION_PATH_FORBIDDEN");
  }
  if (path.basename(resolved).toLowerCase().startsWith(TERMINAL_PREFIX)) fail("TERMINAL_PATH_FORBIDDEN");
  return resolved;
}
const assertSpecPath = (value) => assertLocalPath(value, "SPEC_PATH_INVALID");
const assertOutPath = (value) => assertLocalPath(value, "OUT_PATH_INVALID");
const assertBatchPath = (value) => assertLocalPath(value, "BATCH_PATH_INVALID");
const assertRegistryPath = (value) => assertLocalPath(value, "REGISTRY_PATH_INVALID");

function parseFlags(args, allowed, required = allowed) {
  if (!Array.isArray(args) || args.length % 2 !== 0) fail("USAGE_ERROR");
  const out = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--")) fail("USAGE_ERROR");
    const name = flag.slice(2);
    if (!allowed.includes(name) || Object.hasOwn(out, name)) fail("USAGE_ERROR");
    out[name] = value;
  }
  for (const name of required) if (!Object.hasOwn(out, name)) fail("USAGE_ERROR");
  return out;
}
function parseCommand(argv) {
  if (!Array.isArray(argv) || argv.length < 1) fail("USAGE_ERROR");
  const command = argv[0], rest = argv.slice(1);
  if (command === "propose") {
    const flags = parseFlags(rest, ["spec", "out", "registry"], ["spec", "out"]);
    return { command, specPath: flags.spec, outPath: flags.out, registryPath: flags.registry };
  }
  if (command === "verify-scope") {
    const flags = parseFlags(rest, ["batch"]);
    return { command, batchPath: flags.batch };
  }
  fail("USAGE_ERROR");
}

// ---------------------------------------------------------------------------
// Registry and file reads
// ---------------------------------------------------------------------------
function readRegistryBytes(registryPath, io = fs) {
  const resolved = path.resolve(registryPath);
  let stat;
  try { stat = io.lstatSync(resolved); } catch (_) { fail("APPROVER_REGISTRY_UNAVAILABLE"); }
  if (stat.isSymbolicLink() || (stat.mode & 0o170000) === 0o120000 || !stat.isFile()) fail("APPROVER_REGISTRY_INVALID");
  const parent = path.dirname(resolved);
  let parentStat;
  try { parentStat = io.lstatSync(parent); } catch (_) { fail("APPROVER_REGISTRY_UNAVAILABLE"); }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail("APPROVER_REGISTRY_INVALID");
  let real;
  try { real = io.realpathSync(resolved); } catch (_) { fail("APPROVER_REGISTRY_UNAVAILABLE"); }
  if (real !== resolved) fail("APPROVER_REGISTRY_INVALID");
  let bytes;
  try { bytes = io.readFileSync(resolved); } catch (_) { fail("APPROVER_REGISTRY_UNAVAILABLE"); }
  if (bytes.length > REGISTRY_MAX_BYTES) fail("APPROVER_REGISTRY_INVALID");
  return bytes;
}
function readPinnedApprover(options = {}) {
  const io = options.io || fs;
  const registryPath = options.registryPath || batchTool.REGISTRY_PATH;
  const bytes = readRegistryBytes(registryPath, io);
  const digest = batchTool.trustedRegistryDigest({ ...options, registryPath });
  const fingerprint = `0x${sha256(bytes)}`;
  if (fingerprint !== digest) fail("APPROVER_REGISTRY_TRUST_ANCHOR_MISMATCH");
  let registry;
  try { registry = JSON.parse(bytes.toString("utf8")); } catch (_) { fail("APPROVER_REGISTRY_INVALID"); }
  if (!batchTool.exactKeys(registry, ["schema", "approvers"]) || registry.schema !== batchTool.REGISTRY_SCHEMA || !Array.isArray(registry.approvers) || registry.approvers.length < 1) fail("APPROVER_REGISTRY_INVALID");
  const row = registry.approvers.find((entry) => entry.approverId === PINNED_APPROVER_ID);
  if (!row) fail("APPROVER_UNPINNED");
  if (!batchTool.exactKeys(row, ["approverId", "algorithm", "publicKeySpkiDerBase64"]) || row.algorithm !== "Ed25519" || typeof row.publicKeySpkiDerBase64 !== "string") fail("APPROVER_REGISTRY_INVALID");
  try {
    const keyBytes = Buffer.from(row.publicKeySpkiDerBase64, "base64");
    if (keyBytes.toString("base64") !== row.publicKeySpkiDerBase64) fail("APPROVER_REGISTRY_INVALID");
    const key = crypto.createPublicKey({ key: keyBytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") fail("APPROVER_REGISTRY_INVALID");
  } catch (error) {
    if (error instanceof AuthorError) throw error;
    fail("APPROVER_REGISTRY_INVALID");
  }
  return { publicKeySpkiDerBase64: row.publicKeySpkiDerBase64, fingerprint, registryPath };
}
function readJsonFile(file, io, code) {
  let read;
  try { read = batchTool.checkedRead(file, io); } catch (_) { fail(code); }
  let value;
  try { value = JSON.parse(read.bytes.toString("utf8")); } catch (_) { fail(code); }
  return value;
}
function writeExclusive(file, bytes, io = fs) {
  let fd, created = false;
  try {
    fd = io.openSync(file, "wx", 0o600);
    created = true;
    let offset = 0;
    while (offset < bytes.length) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) fail("OUTPUT_WRITE_INCOMPLETE");
      offset += written;
    }
    io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    if (!io.readFileSync(file).equals(bytes)) fail("OUTPUT_READBACK_MISMATCH");
  } catch (error) {
    if (fd !== undefined) { try { io.closeSync(fd); } catch (_) { /* fall through to sanitized error */ } }
    try { if (created && io.existsSync(file)) io.unlinkSync(file); } catch (_) { /* approval artifact only */ }
    if (error instanceof AuthorError) throw error;
    if (error?.code === "EEXIST") fail("OUTPUT_EXISTS");
    fail("OUTPUT_WRITE_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function propose(options = {}) {
  const io = options.io || fs;
  const specPath = assertSpecPath(options.specPath);
  const outPath = assertOutPath(options.outPath);
  if (specPath === outPath) fail("PATH_COLLISION");
  // Registry override resolution. When `--registry` is supplied, both this
  // tool's own read and the verifyApproval round-trip must use the non-canonical
  // path; the pinned canonical digest is applied unless a test has injected an
  // explicit digest (the CLI never accepts a digest from argv).
  const registryOverride = options.registryPath === undefined ? undefined : assertRegistryPath(options.registryPath);
  const resolvedOptions = registryOverride === undefined ? { ...options } : { ...options, registryPath: registryOverride };
  if (registryOverride !== undefined && typeof resolvedOptions.registrySha256 !== "string" && typeof resolvedOptions.trustedRegistrySha256 !== "string") {
    resolvedOptions.registrySha256 = batchTool.CANONICAL_REGISTRY_SHA256;
  }
  const spec = readJsonFile(specPath, io, "SPEC_READ_FAILED");
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail("SPEC_INVALID");
  if (Object.hasOwn(spec, "approval")) fail("SPEC_APPROVAL_PRESENT");
  if (!SUPPORTED_SCHEMAS.has(spec.schema)) fail("SPEC_SCHEMA_UNSUPPORTED");
  const stubApproval = { scheme: "Ed25519", approverId: PINNED_APPROVER_ID, scopeCommitment: `0x${"0".repeat(64)}`, signature: Buffer.alloc(64).toString("base64") };
  try { batchTool.validateBatch({ ...spec, approval: stubApproval }); }
  catch (error) { fail(error instanceof batchTool.BatchError ? error.code : "SPEC_INVALID"); }
  const scopeCommitment = batchTool.scopeCommitment(spec);
  const message = batchTool.approvalMessage(scopeCommitment, { scheme: "Ed25519", approverId: PINNED_APPROVER_ID }, spec.schema);
  const approver = readPinnedApprover(resolvedOptions);
  const custody = options.custody || defaultCustody;
  let signed;
  try {
    signed = custody.signApprovalMessage(message, { ...resolvedOptions, expectedPublicKeySpkiDerBase64: approver.publicKeySpkiDerBase64 });
  } catch (error) {
    if (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/u.test(error.code)) fail(error.code);
    fail("CUSTODY_SIGNING_FAILED");
  }
  if (!signed || !Buffer.isBuffer(signed.signature) || signed.signature.length !== 64) fail("SIGNATURE_INVALID");
  if (signed.publicKeySpkiDerBase64 !== approver.publicKeySpkiDerBase64) fail("CUSTODY_IDENTITY_MISMATCH");
  const signature = signed.signature.toString("base64");
  if (!SIGNATURE_RE.test(signature)) fail("SIGNATURE_INVALID");
  const batch = { ...spec, approval: { scheme: "Ed25519", approverId: PINNED_APPROVER_ID, scopeCommitment, signature } };
  try { batchTool.validateBatch(batch); batchTool.verifyApproval(batch, { ...resolvedOptions, batchPath: outPath }); }
  catch (error) { fail(error instanceof batchTool.BatchError ? error.code : "APPROVAL_VERIFICATION_FAILED"); }
  const bytes = Buffer.from(`${JSON.stringify(batch, null, 2)}\n`, "utf8");
  if (bytes.length > batchTool.CAPS.batchBytes) fail("BATCH_SIZE_INVALID");
  writeExclusive(outPath, bytes, io);
  const result = {
    ok: true,
    status: "PROPOSED",
    approverId: PINNED_APPROVER_ID,
    schema: spec.schema,
    scopeCommitment,
    batchCommitment: batchTool.commitment(batch),
    publicKeyFingerprint: `0x${sha256(Buffer.from(approver.publicKeySpkiDerBase64, "base64"))}`,
    outFile: path.basename(outPath),
  };
  batchTool.leakGuard(result);
  return result;
}
function verifyScope(options = {}) {
  const io = options.io || fs;
  const batchPath = assertBatchPath(options.batchPath);
  const batch = readJsonFile(batchPath, io, "BATCH_READ_FAILED");
  if (!batch || typeof batch !== "object" || Array.isArray(batch) || !batch.approval || typeof batch.approval.scopeCommitment !== "string") {
    const mismatch = { ok: false, status: "SCOPE_MISMATCH", matches: false };
    batchTool.leakGuard(mismatch);
    return mismatch;
  }
  let computed;
  try { computed = batchTool.scopeCommitment(batch); } catch (_) {
    const invalid = { ok: false, status: "SCOPE_INVALID", matches: false };
    batchTool.leakGuard(invalid);
    return invalid;
  }
  const matches = computed === batch.approval.scopeCommitment;
  const result = { ok: matches, status: matches ? "SCOPE_MATCH" : "SCOPE_MISMATCH", matches, scopeCommitment: computed };
  batchTool.leakGuard(result);
  return result;
}
function runCli(argv, options = {}) {
  const parsed = parseCommand(argv);
  if (parsed.command === "propose") {
    const proposeOptions = { ...options, specPath: parsed.specPath, outPath: parsed.outPath };
    if (parsed.registryPath !== undefined) proposeOptions.registryPath = parsed.registryPath;
    return { ...propose(proposeOptions), exitCode: 0 };
  }
  const scope = verifyScope({ ...options, batchPath: parsed.batchPath });
  return { ...scope, exitCode: scope.ok ? 0 : 1 };
}
if (require.main === module) {
  try {
    const result = runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  PINNED_APPROVER_ID,
  parseCommand,
  propose,
  verifyScope,
  runCli,
  publicError,
  readPinnedApprover,
  constants: Object.freeze({ PINNED_APPROVER_ID, TERMINAL_PREFIX }),
};
