#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { POLICY, POLICY_HASH, canonical } = require("./morpho-pt-27aug2026-post-expiry-r2-production-policy.js");
const adapter = require("./lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js");

const ROOT = "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2";
const SELF = `${ROOT}/tools/issue-morpho-pt-27aug2026-post-expiry-r2-production-permit.js`;
const NODE = `${ROOT}/runtime/bin/node`;
const LIFETIME_MS = 600000;
const EXT4_MAGIC = 0xef53;

class PermitIssueError extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new PermitIssueError(code); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function validateNonceLine(value) {
  if (!Buffer.isBuffer(value) || value.length !== 65 || value[64] !== 0x0a) fail("NONCE_STDIN");
  const nonce = value.subarray(0, 64).toString("ascii");
  if (!/^[0-9a-f]{64}$/u.test(nonce) || new Set(nonce.match(/../gu)).size < 8) fail("NONCE_STDIN");
  return nonce;
}

function validateDirectInvocation({ argv, execArgv, env, execPath, filename, platform, uid, euid, gid, egid }) {
  if (platform !== "linux" || uid !== 1000 || euid !== 1000 || gid !== 1000 || egid !== 1000 || execPath !== NODE || filename !== SELF || !Array.isArray(argv) || argv.length !== 2 || argv[0] !== NODE || argv[1] !== SELF || !Array.isArray(execArgv) || execArgv.length !== 0) fail("INVOCATION");
  if (!env || canonical(env) !== canonical({ LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" })) fail("ENV");
  return true;
}

function buildPermit({ nonce, bindings, now }) {
  if (!Number.isSafeInteger(now) || now < POLICY.expiryTimestamp * 1000) fail("TIME");
  const body = {
    schema: POLICY.permit.schema,
    mode: POLICY.mode,
    approvalNonceCommitment: sha256(`morpho-production-nonce/v1\0${nonce}`),
    issuedAt: now,
    notBefore: now,
    expiresAt: now + LIFETIME_MS,
    policyHash: POLICY_HASH,
    productionHashes: clone(bindings.productionHashes),
    offlineHashes: clone(bindings.offlineHashes),
    runtime: clone(bindings.runtime),
    bridge: clone(bindings.bridge),
    policy: { hash: POLICY_HASH, profileHash: POLICY.profileHash, chainId: POLICY.chainId, expiryTimestamp: POLICY.expiryTimestamp, inputMode: POLICY.input.mode },
    limits: clone(POLICY.limits),
    schemas: clone(POLICY.schemas),
    output: clone(POLICY.output),
    hardStops: clone(POLICY.hardStops),
  };
  const permitId = sha256(canonical({ domain: "morpho-pt-27aug2026-post-expiry-r2-production-permit-id/v1", permit: body }));
  const permit = { schema: body.schema, permitId, ...Object.fromEntries(Object.entries(body).slice(1)) };
  adapter.validatePermit(permit, { nonce, bindings, now });
  return permit;
}

function defaultFsType(file, fsOps) { return Number(fsOps.statfsSync(file).type); }
function qualifyDirectory(file, fsOps, authority) {
  const real = fsOps.realpathSync(file), stat = fsOps.lstatSync(file);
  const secureMode = authority.directorySecure ? authority.directorySecure(stat) : (stat.mode & 0o022) === 0;
  if (real !== file || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== authority.uid || !secureMode || authority.fsType(file, fsOps) !== EXT4_MAGIC) fail("DIRECTORY_AUTHORITY");
  return stat;
}
function writeAll(fsOps, fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    let count;
    try { count = fsOps.writeSync(fd, bytes, offset, bytes.length - offset, null); }
    catch (error) { if (error && error.code === "EINTR") continue; throw error; }
    if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) fail("WRITE");
    offset += count;
  }
}

function issuePermit(options) {
  const fsOps = options.fsOps || fs, root = options.root, authority = options.authority || { uid: 1000, fsType: defaultFsType };
  const nonce = validateNonceLine(options.stdinBytes), now = options.clock(), permit = buildPermit({ nonce, bindings: options.bindings, now });
  const permitPath = path.join(root, POLICY.permit.path), permitParent = path.dirname(permitPath), outputRoot = path.join(root, POLICY.output.root);
  qualifyDirectory(root, fsOps, authority); qualifyDirectory(permitParent, fsOps, authority); qualifyDirectory(outputRoot, fsOps, authority);
  const outputFd = fsOps.openSync(outputRoot, (fsOps.constants || fs.constants).O_RDONLY | (fsOps.constants || fs.constants).O_DIRECTORY); try { if (authority.fsyncDirectory) authority.fsyncDirectory(outputFd, fsOps); else fsOps.fsyncSync(outputFd); } finally { fsOps.closeSync(outputFd); }
  const outputEntries = fsOps.readdirSync(outputRoot);
  if (outputEntries.length !== 0 || fsOps.existsSync(path.join(outputRoot, POLICY.output.lock)) || fsOps.existsSync(path.join(outputRoot, POLICY.output.commitMarker)) || outputEntries.some((name) => name.startsWith(POLICY.output.runPrefix))) fail("OUTPUT_NOT_CLEAN");
  if (fsOps.existsSync(permitPath)) fail("PERMIT_EXISTS");
  const bytes = Buffer.from(canonical(permit), "utf8");
  if (bytes.length > POLICY.permit.maxBytes || bytes.includes(0x0a)) fail("PERMIT_BYTES");
  const temporary = path.join(permitParent, `.${path.basename(permitPath)}.${permit.permitId}.tmp`);
  if (fsOps.existsSync(temporary)) fail("TEMP_EXISTS");
  let fd, linked = false;
  try {
    fd = fsOps.openSync(temporary, (fsOps.constants || fs.constants).O_WRONLY | (fsOps.constants || fs.constants).O_CREAT | (fsOps.constants || fs.constants).O_EXCL | (fsOps.constants || fs.constants).O_NOFOLLOW, 0o600);
    writeAll(fsOps, fd, bytes); fsOps.fsyncSync(fd); fsOps.fchmodSync(fd, 0o444); fsOps.fsyncSync(fd); fsOps.closeSync(fd); fd = undefined;
    const temp = fsOps.lstatSync(temporary);
    if (!temp.isFile() || temp.isSymbolicLink() || temp.uid !== authority.uid || temp.nlink !== 1 || (temp.mode & 0o777) !== 0o444 || authority.fsType(temporary, fsOps) !== EXT4_MAGIC || sha256(fsOps.readFileSync(temporary)) !== sha256(bytes)) fail("TEMP_AUTHORITY");
    fsOps.linkSync(temporary, permitPath); linked = true;
    if (authority.unlinkTemporary) authority.unlinkTemporary(temporary, permitPath, fsOps); else fsOps.unlinkSync(temporary);
    const parentFd = fsOps.openSync(permitParent, (fsOps.constants || fs.constants).O_RDONLY | (fsOps.constants || fs.constants).O_DIRECTORY); try { if (authority.fsyncDirectory) authority.fsyncDirectory(parentFd, fsOps); else fsOps.fsyncSync(parentFd); } finally { fsOps.closeSync(parentFd); }
  } catch (error) {
    if (fd !== undefined) try { fsOps.closeSync(fd); } catch (_) {}
    if (!linked) try { if (fsOps.existsSync(temporary)) fsOps.unlinkSync(temporary); } catch (_) {}
    if (error instanceof PermitIssueError) throw error;
    fail("PERMIT_WRITE");
  }
  const final = fsOps.lstatSync(permitPath);
  if (fsOps.realpathSync(permitPath) !== permitPath || !final.isFile() || final.isSymbolicLink() || final.uid !== authority.uid || final.nlink !== 1 || (final.mode & 0o777) !== 0o444 || authority.fsType(permitPath, fsOps) !== EXT4_MAGIC || !fsOps.readFileSync(permitPath).equals(bytes)) fail("FINAL_AUTHORITY");
  return { permit, permitPath, bytes };
}

function readNonceFd(fsOps = fs, fd = 0) {
  const output = Buffer.alloc(66); let used = 0;
  while (used < output.length) { const count = fsOps.readSync(fd, output, used, output.length - used, null); if (count === 0) break; used += count; }
  if (used !== 65) fail("NONCE_STDIN");
  return output.subarray(0, used);
}

function main() {
  try {
    validateDirectInvocation({ argv: process.argv, execArgv: process.execArgv, env: process.env, execPath: process.execPath, filename: __filename, platform: process.platform, uid: process.getuid?.(), euid: process.geteuid?.(), gid: process.getgid?.(), egid: process.getegid?.() });
    const input = fs.fstatSync(0); if (!input.isFIFO()) fail("NONCE_STDIN");
    const capture = require("./capture-morpho-pt-27aug2026-post-expiry-r2-production.js");
    issuePermit({ root: ROOT, stdinBytes: readNonceFd(fs), bindings: capture.bindings(ROOT), clock: Date.now, fsOps: fs, authority: { uid: 1000, fsType: defaultFsType } });
    process.exitCode = 0;
  } catch (_) { process.exitCode = 2; }
}

if (require.main === module) main();
module.exports = Object.freeze({ ROOT, SELF, NODE, LIFETIME_MS, EXT4_MAGIC, PermitIssueError, sha256, validateNonceLine, validateDirectInvocation, buildPermit, qualifyDirectory, writeAll, issuePermit, readNonceFd });
