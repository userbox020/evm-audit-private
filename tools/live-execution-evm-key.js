#!/usr/bin/env node
"use strict";

// live-execution-evm-key.js
//
// Testnet EVM key bootstrap + strict signer loader for the live-execution lane.
//
//   generate({ outPath, force })  -> fresh secp256k1 EVM keypair, writes the
//                                    private key to outPath as a 0600,
//                                    single-hard-link, regular (non-symlink)
//                                    file under a 0700 parent on Linux, and
//                                    returns ONLY the derived checksummed
//                                    address. The private key is never printed,
//                                    logged, persisted elsewhere, or returned.
//   load({ keyPath })             -> strict, adapter-equivalent loader: Linux
//                                    only, absolute path, O_NOFOLLOW, regular
//                                    file, nlink === 1, mode 0600, bounded size,
//                                    parsed to a key buffer. Returns
//                                    { signer, keyBytes } so the caller can
//                                    zeroize keyBytes.
//
// The key file content is never echoed. The only diagnostic value the CLI emits
// is the derived address and the SHA-256 of the key file.
//
// Overwrite is refused unless `force` / `--force` is explicit. Paths that look
// like `.env`, endpoint inventories, approver registries, or key-custody blobs
// are refused before any read or write.
//
// Testability: the private helpers accept a context ({ platform, io, testOnly,
// meta }) so a POSIX metadata overlay can be injected on Windows; the offline
// suite in tools/test/live-execution-evm-key.test.js uses exactly that technique.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Wallet, getAddress, hexlify } = require("ethers");

const KEY_MODE = 0o600;
const PARENT_MODE = 0o700;
const MAX_KEY_FILE_BYTES = 4096;
const PRIVATE_KEY_HEX = /^(?:0x)?[0-9a-fA-F]{64}$/u;
const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/u;
const HEX_64 = /^0x[0-9a-f]{64}$/u;

// Endpoint inventories are process-only secrets; a key file must never be
// written into one of their names or into an approver registry path.
const INVENTORY_NAMES = Object.freeze(new Set([
  "rpc_endpoints.txt",
  "graphql_endpoints.txt",
  "base_full_stack_endpoints.md",
  "hyperevm_archive_endpoints.md",
]));

const BLOCKER = Object.freeze({
  ARGUMENTS_INVALID: "EVM_KEY_ARGUMENTS_INVALID",
  PLATFORM_REQUIRED: "EVM_KEY_PLATFORM_REQUIRED",
  PATH_INVALID: "EVM_KEY_PATH_INVALID",
  PATH_DENIED: "EVM_KEY_REFUSED_SENSITIVE_PATH",
  REFUSED_EXISTS: "EVM_KEY_REFUSED_EXISTS",
  PARENT_UNSAFE: "EVM_KEY_PARENT_UNSAFE",
  PARENT_MODE_INVALID: "EVM_KEY_PARENT_MODE_INVALID",
  WRITE_FAILED: "EVM_KEY_WRITE_FAILED",
  VERIFY_FAILED: "EVM_KEY_VERIFY_FAILED",
  SYMLINK_REFUSED: "EVM_KEY_SYMLINK_REFUSED",
  LINK_REFUSED: "EVM_KEY_LINK_REFUSED",
  MODE_REFUSED: "EVM_KEY_MODE_REFUSED",
  FILE_REFUSED: "EVM_KEY_FILE_REFUSED",
  SIZE_REFUSED: "EVM_KEY_SIZE_REFUSED",
  UNAVAILABLE: "EVM_KEY_UNAVAILABLE",
  MATERIAL_INVALID: "EVM_KEY_MATERIAL_INVALID",
  USAGE_ERROR: "USAGE_ERROR",
  INTERNAL: "INTERNAL_FAILURE_REDACTED",
});

class EvmKeyError extends Error {
  constructor(code) { super(code); this.name = "EvmKeyError"; this.code = code; }
}
function fail(code) { throw new EvmKeyError(code); }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function zeroize(buffer) {
  if (Buffer.isBuffer(buffer) || buffer instanceof Uint8Array) {
    try { buffer.fill(0); } catch (_) { /* best effort */ }
  }
}
function metaKey(file, ctx) {
  const resolved = path.resolve(file);
  return ctx.testOnly ? resolved.toLowerCase() : resolved;
}

// ---------------------------------------------------------------------------
// POSIX metadata overlay (deterministic on non-Linux test hosts)
// ---------------------------------------------------------------------------
function describe(file, ctx) {
  let stat = null;
  try { stat = ctx.io.lstatSync(file); } catch (_) { stat = null; }
  const simulated = ctx.testOnly ? ctx.meta.get(metaKey(file, ctx)) : undefined;
  if (!stat && !simulated) {
    return { exist: false, isFile: false, isDirectory: false, isSymbolicLink: false, mode: 0, nlink: 0, size: 0 };
  }
  return {
    exist: true,
    isFile: simulated && simulated.isFile !== undefined ? simulated.isFile : (stat ? stat.isFile() : false),
    isDirectory: simulated && simulated.isDir !== undefined ? simulated.isDir : (stat ? stat.isDirectory() : false),
    isSymbolicLink: simulated && simulated.isSymbolicLink !== undefined ? simulated.isSymbolicLink : (stat ? stat.isSymbolicLink() : false),
    mode: ((simulated && simulated.mode !== undefined ? simulated.mode : (stat ? stat.mode : 0)) & 0o777),
    nlink: simulated && simulated.nlink !== undefined ? simulated.nlink : (stat ? stat.nlink : 0),
    size: stat ? stat.size : (simulated && simulated.size !== undefined ? simulated.size : 0),
  };
}
function recordMeta(file, ctx, meta) {
  if (ctx.testOnly) ctx.meta.set(metaKey(file, ctx), { ...meta });
}

// ---------------------------------------------------------------------------
// Deny boundary
// ---------------------------------------------------------------------------
function assertPathAllowed(target) {
  const segments = path.resolve(target).split(/[\\/]+/u).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment.toLowerCase().startsWith(".env")) fail(BLOCKER.PATH_DENIED);
  }
  const base = segments.length > 0 ? segments[segments.length - 1].toLowerCase() : "";
  if (INVENTORY_NAMES.has(base)) fail(BLOCKER.PATH_DENIED);
  if (base.includes("registry") || base.includes("approver")) fail(BLOCKER.PATH_DENIED);
  if (/\.(pem|pfx|p12|ppk)$/u.test(base)) fail(BLOCKER.PATH_DENIED);
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/u.test(base)) fail(BLOCKER.PATH_DENIED);
}

function requireAbsolutePath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) fail(code);
  if (value.includes("\0")) fail(code);
  if (!path.isAbsolute(value)) fail(code);
  return path.resolve(value);
}

// ---------------------------------------------------------------------------
// Parent directory safety (0700, non-symlink, on Linux)
// ---------------------------------------------------------------------------
function ensureParent(target, ctx) {
  const parent = path.dirname(path.resolve(target));
  let info = describe(parent, ctx);
  if (!info.exist) {
    try { ctx.io.mkdirSync(parent, { recursive: true, mode: PARENT_MODE }); }
    catch (_) { fail(BLOCKER.WRITE_FAILED); }
    try { ctx.io.chmodSync(parent, PARENT_MODE); } catch (_) { /* best effort on non-ext4 */ }
    recordMeta(parent, ctx, { isDir: true, isFile: false, isSymbolicLink: false, mode: PARENT_MODE, nlink: 1, size: 0 });
    info = describe(parent, ctx);
  }
  if (!info.isDirectory || info.isSymbolicLink) fail(BLOCKER.PARENT_UNSAFE);
  if ((info.mode & 0o777) !== PARENT_MODE) fail(BLOCKER.PARENT_MODE_INVALID);
  return parent;
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------
function generateImpl(options, ctx) {
  if (!isPlainObject(options)) fail(BLOCKER.ARGUMENTS_INVALID);
  if (ctx.platform !== "linux") fail(BLOCKER.PLATFORM_REQUIRED);
  const outPath = requireAbsolutePath(options.outPath, BLOCKER.PATH_INVALID);
  const force = options.force === true;
  assertPathAllowed(outPath);
  ensureParent(outPath, ctx);

  const before = describe(outPath, ctx);
  if (before.exist && !force) fail(BLOCKER.REFUSED_EXISTS);
  if (before.exist && before.isSymbolicLink) fail(BLOCKER.SYMLINK_REFUSED);
  if (before.exist && !before.isFile) fail(BLOCKER.FILE_REFUSED);

  let keyBytes = null;
  let fileBytes = null;
  try {
    const wallet = Wallet.createRandom();
    const address = getAddress(wallet.address);
    keyBytes = Buffer.from(wallet.privateKey.slice(2), "hex");
    fileBytes = Buffer.from(`${keyBytes.toString("hex")}\n`, "utf8");
    const flag = before.exist ? "w" : "wx";
    try { ctx.io.writeFileSync(outPath, fileBytes, { mode: KEY_MODE, flag }); }
    catch (error) {
      if (error && error.code === "EEXIST") fail(BLOCKER.REFUSED_EXISTS);
      fail(BLOCKER.WRITE_FAILED);
    }
    try { ctx.io.chmodSync(outPath, KEY_MODE); } catch (_) { /* best effort on non-ext4 */ }
    recordMeta(outPath, ctx, { isFile: true, isDir: false, isSymbolicLink: false, mode: KEY_MODE, nlink: 1, size: fileBytes.length });
    if (!ctx.testOnly && typeof ctx.io.fsyncSync === "function") {
      let fd;
      try { fd = ctx.io.openSync(outPath, "r"); ctx.io.fsyncSync(fd); }
      catch (_) { /* durability best effort */ }
      finally { if (fd !== undefined) { try { ctx.io.closeSync(fd); } catch (_) { /* best effort */ } } }
    }
    const info = describe(outPath, ctx);
    if (!info.exist || !info.isFile || info.isSymbolicLink) fail(BLOCKER.VERIFY_FAILED);
    if (info.nlink !== 1) fail(BLOCKER.LINK_REFUSED);
    if ((info.mode & 0o777) !== KEY_MODE) fail(BLOCKER.MODE_REFUSED);
    if (info.size < 1 || info.size > MAX_KEY_FILE_BYTES) fail(BLOCKER.SIZE_REFUSED);
    return address;
  } finally {
    zeroize(keyBytes);
    zeroize(fileBytes);
  }
}

// ---------------------------------------------------------------------------
// load (strict; mirrors the adapter's default Linux loader)
// ---------------------------------------------------------------------------
function loadImpl(options, ctx) {
  if (!isPlainObject(options)) fail(BLOCKER.ARGUMENTS_INVALID);
  if (ctx.platform !== "linux") fail(BLOCKER.PLATFORM_REQUIRED);
  const keyPath = requireAbsolutePath(options.keyPath, BLOCKER.PATH_INVALID);
  assertPathAllowed(keyPath);

  const pre = describe(keyPath, ctx);
  if (!pre.exist) fail(BLOCKER.UNAVAILABLE);
  if (pre.isSymbolicLink) fail(BLOCKER.SYMLINK_REFUSED);
  if (!pre.isFile) fail(BLOCKER.FILE_REFUSED);
  if (pre.nlink !== 1) fail(BLOCKER.LINK_REFUSED);
  if ((pre.mode & 0o777) !== KEY_MODE) fail(BLOCKER.MODE_REFUSED);
  if (pre.size < 1 || pre.size > MAX_KEY_FILE_BYTES) fail(BLOCKER.SIZE_REFUSED);

  let fd;
  let raw = null;
  let keyBytes = null;
  try {
    const constants = ctx.io.constants || {};
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const readOnly = typeof constants.O_RDONLY === "number" ? constants.O_RDONLY : fs.constants.O_RDONLY;
    try { fd = ctx.io.openSync(keyPath, readOnly | noFollow); }
    catch (_) { fail(BLOCKER.UNAVAILABLE); }
    // Re-describe through the overlay so the post-open checks match the same
    // policy as the pre-open checks on a non-Linux test host.
    const opened = describe(keyPath, ctx);
    if (!opened.isFile || opened.isSymbolicLink) fail(BLOCKER.FILE_REFUSED);
    if (opened.nlink !== 1) fail(BLOCKER.LINK_REFUSED);
    if ((opened.mode & 0o777) !== KEY_MODE) fail(BLOCKER.MODE_REFUSED);
    if (opened.size < 1 || opened.size > MAX_KEY_FILE_BYTES) fail(BLOCKER.SIZE_REFUSED);

    raw = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < raw.length) {
      const read = ctx.io.readSync(fd, raw, offset, raw.length - offset, offset);
      if (!Number.isInteger(read) || read <= 0) fail(BLOCKER.UNAVAILABLE);
      offset += read;
    }
    const text = raw.toString("utf8").trim();
    if (!PRIVATE_KEY_HEX.test(text)) fail(BLOCKER.MATERIAL_INVALID);
    keyBytes = Buffer.from(text.replace(/^0x/iu, ""), "hex");
    const signer = new Wallet(hexlify(keyBytes));
    if (!ADDRESS_HEX.test(signer.address)) fail(BLOCKER.MATERIAL_INVALID);
    return { signer, keyBytes };
  } catch (error) {
    zeroize(keyBytes);
    if (error instanceof EvmKeyError) throw error;
    throw new EvmKeyError(BLOCKER.UNAVAILABLE);
  } finally {
    if (fd !== undefined) { try { ctx.io.closeSync(fd); } catch (_) { /* best effort */ } }
    zeroize(raw);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function fileSha256(file) {
  const bytes = fs.readFileSync(file);
  try { return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`; }
  finally { zeroize(bytes); }
}

function parseFlags(rest, allowed, booleanFlags) {
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!allowed.has(token)) fail(BLOCKER.USAGE_ERROR);
    if (booleanFlags.has(token)) { flags[token.slice(2)] = true; continue; }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) fail(BLOCKER.USAGE_ERROR);
    flags[token.slice(2)] = value;
    index += 1;
  }
  return flags;
}

function parseCli(args) {
  if (!Array.isArray(args) || args.length === 0) fail(BLOCKER.USAGE_ERROR);
  const command = args[0];
  if (command === "generate") {
    const flags = parseFlags(args.slice(1), new Set(["--out", "--force"]), new Set(["--force"]));
    if (typeof flags.out !== "string") fail(BLOCKER.USAGE_ERROR);
    return { command, options: { outPath: flags.out, force: flags.force === true } };
  }
  if (command === "address") {
    const flags = parseFlags(args.slice(1), new Set(["--key"]), new Set());
    if (typeof flags.key !== "string") fail(BLOCKER.USAGE_ERROR);
    return { command, options: { keyPath: flags.key } };
  }
  fail(BLOCKER.USAGE_ERROR);
}

function writeFailure(error) {
  const code = error instanceof EvmKeyError ? error.code
    : error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code
      : BLOCKER.INTERNAL;
  process.stdout.write(`${JSON.stringify({ status: "FAIL_CLOSED", blocker: code })}\n`);
  process.exitCode = 1;
}

function runCli(argv = process.argv) {
  let parsed;
  try { parsed = parseCli(argv.slice(2)); }
  catch (error) { writeFailure(error); return null; }
  try {
    if (parsed.command === "generate") {
      const address = generate(parsed.options);
      const sha256 = fileSha256(parsed.options.outPath);
      process.stdout.write(`${JSON.stringify({ command: "generate", address, sha256 })}\n`);
      return { address, sha256 };
    }
    const loaded = load(parsed.options);
    try {
      const address = getAddress(loaded.signer.address);
      process.stdout.write(`${JSON.stringify({ command: "address", address })}\n`);
      return { address };
    } finally {
      zeroize(loaded.keyBytes);
    }
  } catch (error) {
    writeFailure(error);
    return null;
  }
}
if (require.main === module) runCli();

// ---------------------------------------------------------------------------
// Public entry points + test harness
// ---------------------------------------------------------------------------
function productionContext() {
  return { platform: process.platform, io: fs, testOnly: false, meta: new Map() };
}
function generate(options) { return generateImpl(options, productionContext()); }
function load(options) { return loadImpl(options, productionContext()); }

function createHarness(options = {}) {
  const io = options.io || fs;
  const ctx = { platform: typeof options.platform === "string" ? options.platform : "linux", io, testOnly: true, meta: options.meta || new Map() };
  return Object.freeze({
    generate: (value) => generateImpl({ ...value, force: value && value.force === true }, ctx),
    load: (value) => loadImpl(value, ctx),
    describe: (file) => describe(file, ctx),
    seed: (file, meta) => { recordMeta(file, ctx, meta); },
  });
}

module.exports = Object.freeze({
  generate,
  load,
  runCli,
  parseCli,
  fileSha256,
  EvmKeyError,
  constants: Object.freeze({
    KEY_MODE,
    PARENT_MODE,
    MAX_KEY_FILE_BYTES,
    PRIVATE_KEY_HEX,
    ADDRESS_HEX,
    HEX_64,
    INVENTORY_NAMES,
    BLOCKER,
  }),
  _test: Object.freeze({ createHarness, describe, assertPathAllowed, BLOCKER }),
});
