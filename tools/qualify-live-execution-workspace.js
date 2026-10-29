#!/usr/bin/env node
"use strict";

// Fail-closed materializer for the Linux-only live-execution workspace.
// It copies an explicit reviewed allowlist (relative path + SHA-256) from a
// source root into an operational target root on native ext4/Linux hosts.
// It never reads, copies, prints, or persists deny-listed secret/endpoint
// paths, and it leaves no partially materialized workspace on failure.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_SCHEMA = "live-execution-workspace-manifest/v1";
const DIGEST = /^0x[0-9a-f]{64}$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const ENDPOINT_INVENTORY = Object.freeze(new Set([
  "rpc_endpoints.txt",
  "graphql_endpoints.txt",
  "base_full_stack_endpoints.md",
  "hyperevm_archive_endpoints.md",
]));

class WorkspaceError extends Error {
  constructor(code) { super(code); this.name = "WorkspaceError"; this.code = code; }
}
function fail(code) { throw new WorkspaceError(code); }
function exactKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function hashBytes(bytes) { return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`; }

// Explicit deny rules keyed by the normalized relative path. A path is refused
// before it is read or copied; these are deny rules, not allow heuristics.
//
// normalizeName removes separators (`_`, whitespace, `.`, `-`) so a single stem
// comparison catches the common spellings of the same secret filename:
// `private_key.json`, `private-key.json`, `private.key.json`, and
// `private key.json` all normalize to `privatekeyjson`. The dot is removed as
// well, which is why extension checks use the raw lowercased `base` separately.
function normalizeName(value) { return value.toLowerCase().replace(/[_\s.\-]/gu, ""); }

// Secret-material tokens compared as substrings of the separator-stripped stem.
// This is deliberately CONSERVATIVE and extension-agnostic: any filename whose
// normalized stem contains one of these tokens is refused no matter what
// extension it carries. As a direct consequence, documentation-style names that
// merely mention a secret concept are refused too (for example
// `password-policy.md`, `secrets-management.md`, `apikey-rotation.md`,
// `wallet-addresses.md`, `credentials-guide.md`). That is intended behavior for
// a deny boundary, not a regression, so there is no uninspectable allow
// heuristic. The only names guaranteed to pass are ones whose stem contains no
// secret-material token at all, such as `index.json`, `manifest.json`,
// `policy.json`, and `README.md`. An operator who needs one of the refused
// documentation names inside the workspace must rename it so the stem no longer
// contains a token.
const SECRET_STEMS = Object.freeze([
  "privatekey", "secretkey", "mnemonic", "seedphrase", "seed", "apikey",
  "accesstoken", "secret", "keystore", "keypair", "password", "passphrase",
  "wallet", "credentials", "credential",
]);
// Credential-file names that carry no generic secret token inside the stem
// itself and therefore need explicit exact-stem coverage. The leading dot of
// `.git-credentials` and `.netrc` is stripped by normalizeName, giving
// `gitcredentials`/`netrc`; `serviceaccount`/`googleservices` cover the
// GCP/AWS-style `service-account.json` and `google-services.json` pairings.
const CREDENTIAL_NAMES = Object.freeze(["gitcredentials", "netrc", "serviceaccount", "googleservices"]);
// Raw lowercased basenames for the dotfile spellings, so the rule still holds
// if a host reports a leading-dot name in an unexpected extname shape.
const CREDENTIAL_BASENAMES = Object.freeze([".git-credentials", ".netrc"]);

const DENY_RULES = Object.freeze([
  // Unchanged: any path segment beginning with `.env`.
  Object.freeze({ code: "DENY_ENV_FILE", test: (_rel, _base, segments) => segments.some((segment) => segment.toLowerCase().startsWith(".env")) }),
  // Existing private-key rule (id_* SSH keys and .key/.priv/.ppk extensions).
  // The old `privatekey`/`private-key` substring checks are now covered by the
  // normalized stem, which additionally catches `private_key` and `private key`.
  // `.keystore` is included so `*.keystore` files are refused even though their
  // stem carries no `keystore` token.
  Object.freeze({ code: "DENY_PRIVATE_KEY", test: (_rel, base, segments, names) => segments.some((segment) => /^id_(rsa|dsa|ecdsa|ed25519)$/iu.test(segment))
    || /\.(key|priv|ppk|keystore)$/u.test(base) || names.normStem.includes("privatekey") }),
  // Unchanged explicit extension rule.
  Object.freeze({ code: "DENY_PEM", test: (_rel, base) => base.endsWith(".pem") }),
  // Keypair/keystore/wallet/credential JSON subset rule and id.json/keypair.
  // `credential` was added so `my_credentials.json`, `aws_credentials.json`,
  // `credentials-prod.json`, and `prod_credential.json` are refused even when
  // the stem does not normalize to the bare guarded stem.
  Object.freeze({ code: "DENY_KEYPAIR_JSON", test: (_rel, base) => (base.endsWith(".json") && /(keypair|keystore|wallet|credential)/u.test(base)) || base === "id.json" || base.endsWith(".keypair") }),
  // Existing custody rule. The raw `seed` substring moved into the normalized
  // stem rule below so underscore/dot/hyphen spellings are covered consistently.
  Object.freeze({ code: "DENY_CUSTODY_BLOB", test: (_rel, base) => /(dpapi|custody)/u.test(base) || /\.(blob|pfx|p12|dpapi)$/u.test(base) }),
  // New: normalized secret-material stems (see SECRET_STEMS).
  Object.freeze({ code: "DENY_SECRET_STEM", test: (_rel, _base, _segments, names) => SECRET_STEMS.some((stem) => names.normStem.includes(stem)) }),
  // New: explicit credential names/dotfiles with no generic secret token in the
  // stem (see CREDENTIAL_NAMES/CREDENTIAL_BASENAMES).
  Object.freeze({ code: "DENY_CREDENTIAL_NAME", test: (_rel, base, _segments, names) => CREDENTIAL_NAMES.includes(names.normStem) || CREDENTIAL_BASENAMES.includes(base) }),
  // Unchanged exact endpoint-inventory names.
  Object.freeze({ code: "DENY_ENDPOINT_INVENTORY", test: (_rel, base) => ENDPOINT_INVENTORY.has(base) }),
]);
const DENY_RULE_CODES = Object.freeze(DENY_RULES.map((rule) => rule.code));

function assertNotDenied(relativePath) {
  const segments = relativePath.split("/");
  const base = segments[segments.length - 1].toLowerCase();
  const extension = path.posix.extname(base);
  const stem = extension ? base.slice(0, base.length - extension.length) : base;
  const names = { normStem: normalizeName(stem) };
  for (const rule of DENY_RULES) { if (rule.test(relativePath, base, segments, names)) fail(rule.code); }
}

function normalizeRel(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail("PATH_INVALID");
  if (value.includes("\\")) fail("PATH_INVALID");
  if (path.posix.isAbsolute(value) || value.startsWith("//") || /^[A-Za-z]:/u.test(value)) fail("PATH_ABSOLUTE");
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) fail("PATH_TRAVERSAL");
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === "" || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) fail("PATH_TRAVERSAL");
  assertNotDenied(normalized);
  return normalized;
}

function within(root, candidate, ctx) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const compareRoot = ctx && ctx.testOnly ? resolvedRoot.toLowerCase() : resolvedRoot;
  const compareCandidate = ctx && ctx.testOnly ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  return compareCandidate === compareRoot || compareCandidate.startsWith(`${compareRoot}${path.sep}`);
}
function samePath(left, right, ctx) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return ctx && ctx.testOnly ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function pathExists(file, ctx) {
  try { ctx.io.lstatSync(file); return true; }
  catch (error) { if (error && error.code === "ENOENT") return false; fail("PATH_UNAVAILABLE"); }
}

function describe(file, ctx) {
  let stat = null;
  let error = null;
  try { stat = ctx.io.lstatSync(file); } catch (caught) { error = caught; }
  const simulated = ctx.testOnly ? ctx.meta.get(path.resolve(file)) : undefined;
  if (!stat && !simulated) {
    if (error && error.code !== "ENOENT") fail("PATH_UNAVAILABLE");
    return { exists: false, isFile: false, isDirectory: false, isSymbolicLink: false, mode: 0, uid: -1, nlink: 0, size: 0 };
  }
  return {
    exists: true,
    isFile: stat ? stat.isFile() : Boolean(simulated.isFile),
    isDirectory: stat ? stat.isDirectory() : Boolean(simulated.isDir),
    isSymbolicLink: stat ? stat.isSymbolicLink() : false,
    mode: (simulated ? simulated.mode : (stat ? stat.mode : 0)) & 0o7777,
    uid: simulated ? simulated.uid : (stat ? stat.uid : -1),
    nlink: simulated ? simulated.nlink : (stat ? stat.nlink : 0),
    size: stat ? stat.size : (simulated ? simulated.size : 0),
  };
}
function recordRoot(dir, ctx) {
  if (!ctx.testOnly) return;
  ctx.meta.set(path.resolve(dir), { mode: 0o700, uid: ctx.uid, nlink: 1, isDir: true, isFile: false, size: 0 });
}
function recordDirectory(dir, ctx, created) {
  if (ctx.testOnly) ctx.meta.set(path.resolve(dir), { mode: 0o700, uid: ctx.uid, nlink: 1, isDir: true, isFile: false, size: 0 });
  created.dirs.push(dir);
}
function recordFile(file, ctx, size) {
  if (ctx.testOnly) ctx.meta.set(path.resolve(file), { mode: 0o600, uid: ctx.uid, nlink: 1, isDir: false, isFile: true, size });
}

function assertLinux(ctx) {
  if (ctx.platform !== "linux") fail("LINUX_PLATFORM_REQUIRED");
  if (!ctx.testOnly && typeof ctx.uid !== "number") fail("SECURE_HOST_REQUIRED");
}
function resolveRoot(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return path.resolve(value);
}

function loadManifest(manifestPath, ctx) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) fail("MANIFEST_INVALID");
  let bytes;
  try { bytes = ctx.io.readFileSync(manifestPath); } catch (_) { fail("MANIFEST_UNAVAILABLE"); }
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) fail("MANIFEST_INVALID");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch (_) { fail("MANIFEST_INVALID"); }
  let value;
  try { value = JSON.parse(text); } catch (_) { fail("MANIFEST_INVALID"); }
  return validateManifest(value);
}
function validateManifest(value) {
  if (!exactKeys(value, ["schema", "files"]) || value.schema !== MANIFEST_SCHEMA) fail("MANIFEST_SCHEMA_INVALID");
  if (!Array.isArray(value.files) || value.files.length === 0) fail("MANIFEST_EMPTY");
  const seen = new Set();
  return value.files.map((entry) => {
    if (!exactKeys(entry, ["path", "sha256"]) || typeof entry.path !== "string" || typeof entry.sha256 !== "string") fail("MANIFEST_ENTRY_INVALID");
    const relativePath = normalizeRel(entry.path);
    if (seen.has(relativePath)) fail("MANIFEST_DUPLICATE_PATH");
    seen.add(relativePath);
    if (!DIGEST.test(entry.sha256)) fail("MANIFEST_ENTRY_INVALID");
    return Object.freeze({ path: relativePath, sha256: entry.sha256 });
  });
}

function qualifySourceRoot(sourceRoot, ctx) {
  const info = describe(sourceRoot, ctx);
  if (!info.exists || !info.isDirectory || info.isSymbolicLink) fail("SOURCE_ROOT_INVALID");
  let real;
  try { real = path.resolve(ctx.io.realpathSync(sourceRoot)); } catch (_) { fail("SOURCE_ROOT_INVALID"); }
  if (!samePath(real, sourceRoot, ctx)) fail("SOURCE_ROOT_INVALID");
}
function qualifyRoot(root, ctx, codes) {
  const info = describe(root, ctx);
  if (!info.exists || !info.isDirectory || info.isSymbolicLink) fail(codes.invalid);
  if ((info.mode & 0o777) !== 0o700) fail(codes.mode);
  if (info.uid !== ctx.uid) fail(codes.owner);
  let real;
  try { real = path.resolve(ctx.io.realpathSync(root)); } catch (_) { fail(codes.invalid); }
  if (!samePath(real, path.resolve(root), ctx)) fail(codes.realpath);
}
function checkParentSafety(target, ctx, code) {
  const parent = path.dirname(path.resolve(target));
  let stat;
  try { stat = ctx.io.lstatSync(parent); } catch (_) { fail(code); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
  let real;
  try { real = path.resolve(ctx.io.realpathSync(parent)); } catch (_) { fail(code); }
  if (!samePath(real, path.resolve(parent), ctx)) fail(code);
  const info = describe(parent, ctx);
  if (info.uid !== ctx.uid || (info.mode & 0o022) !== 0) fail(code);
}
function fsyncDirectory(dir, ctx) {
  if (ctx.testOnly || ctx.platform !== "linux") return;
  let fd;
  try { fd = ctx.io.openSync(dir, "r"); ctx.io.fsyncSync(fd); }
  catch (_) { fail("TARGET_DURABILITY_UNSUPPORTED"); }
  finally { if (fd !== undefined) try { ctx.io.closeSync(fd); } catch (_) { /* already failing closed */ } }
}

function readVerifiedSource(sourceRoot, entry, ctx) {
  const absolute = path.join(sourceRoot, ...entry.path.split("/"));
  if (!within(sourceRoot, absolute, ctx)) fail("PATH_ESCAPE");
  assertNotDenied(entry.path);
  const info = describe(absolute, ctx);
  if (!info.exists) fail("SOURCE_FILE_MISSING");
  if (!info.isFile || info.isSymbolicLink) fail("SOURCE_FILE_INVALID");
  let real;
  try { real = path.resolve(ctx.io.realpathSync(absolute)); } catch (_) { fail("SOURCE_FILE_INVALID"); }
  if (!within(path.resolve(ctx.io.realpathSync(sourceRoot)), real, ctx)) fail("SOURCE_SYMLINK_ESCAPE");
  let bytes;
  try { bytes = ctx.io.readFileSync(absolute); } catch (_) { fail("SOURCE_READ_FAILED"); }
  if (hashBytes(bytes) !== entry.sha256) fail("SOURCE_DIGEST_MISMATCH");
  return bytes;
}

function ensureDirectory(targetRoot, relativeDir, ctx, created) {
  let current = path.resolve(targetRoot);
  for (const segment of relativeDir.split("/")) {
    if (!segment || segment === ".") continue;
    current = path.join(current, segment);
    if (!pathExists(current, ctx)) {
      try { ctx.io.mkdirSync(current, { mode: 0o700 }); } catch (_) { fail("TARGET_DIR_CREATE_FAILED"); }
      try { ctx.io.chmodSync(current, 0o700); } catch (_) { fail("TARGET_DIR_CREATE_FAILED"); }
      recordDirectory(current, ctx, created);
    } else {
      const info = describe(current, ctx);
      if (!info.isDirectory || info.isSymbolicLink) fail("TARGET_PATH_INVALID");
      let real;
      try { real = path.resolve(ctx.io.realpathSync(current)); } catch (_) { fail("TARGET_PATH_INVALID"); }
      if (!within(path.resolve(ctx.io.realpathSync(targetRoot)), real, ctx)) fail("TARGET_REALPATH_ESCAPE");
    }
  }
}
function copyIntoWorkspace(targetRoot, item, ctx, created, force) {
  const relativePath = item.entry.path;
  // Second deny check immediately before any target write, so the deny list is
  // enforced at every copy enforcement point even if a future caller bypasses
  // manifest validation.
  assertNotDenied(relativePath);
  const relativeDir = path.posix.dirname(relativePath);
  if (relativeDir && relativeDir !== ".") ensureDirectory(targetRoot, relativeDir, ctx, created);
  const targetFile = path.join(targetRoot, ...relativePath.split("/"));
  if (!within(targetRoot, targetFile, ctx)) fail("PATH_ESCAPE");
  const existed = pathExists(targetFile, ctx);
  if (existed) {
    if (!force) fail("TARGET_EXISTS");
    const before = describe(targetFile, ctx);
    if (!before.isFile || before.isSymbolicLink) fail("TARGET_FILE_INVALID");
  }
  try { ctx.io.writeFileSync(targetFile, item.bytes, { mode: 0o600, flag: existed ? "w" : "wx" }); }
  catch (_) { fail("TARGET_WRITE_FAILED"); }
  try { ctx.io.chmodSync(targetFile, 0o600); } catch (_) { fail("TARGET_WRITE_FAILED"); }
  recordFile(targetFile, ctx, item.bytes.length);
  const info = describe(targetFile, ctx);
  if (!info.exists || !info.isFile || info.isSymbolicLink) fail("TARGET_FILE_INVALID");
  if (info.nlink !== 1) fail("TARGET_FILE_LINK_INVALID");
  if ((info.mode & 0o777) !== 0o600) fail("TARGET_FILE_MODE_INVALID");
  if (info.uid !== ctx.uid) fail("TARGET_FILE_OWNER_INVALID");
  let real;
  try { real = path.resolve(ctx.io.realpathSync(targetFile)); } catch (_) { fail("TARGET_FILE_INVALID"); }
  if (!samePath(real, path.resolve(targetFile), ctx)) fail("TARGET_REALPATH_INVALID");
  if (!within(path.resolve(ctx.io.realpathSync(targetRoot)), real, ctx)) fail("TARGET_REALPATH_ESCAPE");
  if (!existed) created.files.push(targetFile);
  let persisted;
  try { persisted = ctx.io.readFileSync(targetFile); } catch (_) { fail("TARGET_WRITE_FAILED"); }
  if (hashBytes(persisted) !== item.entry.sha256) fail("TARGET_FILE_DIGEST_MISMATCH");
  return item.bytes.length;
}
function qualifyWorkspace(targetRoot, entries, ctx) {
  for (const entry of entries) {
    assertNotDenied(entry.path);
    const file = path.join(targetRoot, ...entry.path.split("/"));
    const info = describe(file, ctx);
    if (!info.exists || !info.isFile || info.isSymbolicLink) fail("TARGET_FILE_INVALID");
    if (info.nlink !== 1) fail("TARGET_FILE_LINK_INVALID");
    if ((info.mode & 0o777) !== 0o600) fail("TARGET_FILE_MODE_INVALID");
    if (info.uid !== ctx.uid) fail("TARGET_FILE_OWNER_INVALID");
    let real;
    try { real = path.resolve(ctx.io.realpathSync(file)); } catch (_) { fail("TARGET_FILE_INVALID"); }
    if (!samePath(real, path.resolve(file), ctx)) fail("TARGET_REALPATH_INVALID");
    if (!within(path.resolve(ctx.io.realpathSync(targetRoot)), real, ctx)) fail("TARGET_REALPATH_ESCAPE");
  }
}
function cleanupCreated(created, createdRoot, targetRoot, ctx) {
  for (const file of created.files.slice().reverse()) { try { ctx.io.rmSync(file, { force: true }); } catch (_) { /* best effort */ } }
  for (const dir of created.dirs.slice().reverse()) {
    try { if (ctx.io.readdirSync(dir).length === 0) ctx.io.rmdirSync(dir); } catch (_) { /* best effort */ }
  }
  if (createdRoot) {
    try { if (ctx.io.readdirSync(targetRoot).length === 0) ctx.io.rmdirSync(targetRoot); } catch (_) { /* best effort */ }
  }
}
function distinctDirectoryCount(entries) {
  const dirs = new Set();
  for (const entry of entries) {
    const relativeDir = path.posix.dirname(entry.path);
    if (!relativeDir || relativeDir === ".") continue;
    let accumulated = "";
    for (const segment of relativeDir.split("/")) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      dirs.add(accumulated);
    }
  }
  return dirs.size;
}
function report(status, entries, bytes) {
  return {
    status,
    files: entries.map((entry) => ({ path: entry.path, sha256: entry.sha256, mode: "0600", nlink: 1 })).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    counts: { files: entries.length, directories: distinctDirectoryCount(entries), bytes },
  };
}

function materializeImpl(options, ctx) {
  assertLinux(ctx);
  if (!exactKeys(options, ["sourceRoot", "targetRoot", "manifestPath", "force"]) || typeof options.force !== "boolean") fail("MATERIALIZE_ARGUMENTS_INVALID");
  const sourceRoot = resolveRoot(options.sourceRoot, "SOURCE_ROOT_INVALID");
  const targetRoot = resolveRoot(options.targetRoot, "TARGET_ROOT_INVALID");
  const entries = loadManifest(options.manifestPath, ctx);
  qualifySourceRoot(sourceRoot, ctx);
  const targetExists = pathExists(targetRoot, ctx);
  const codes = { invalid: "TARGET_ROOT_INVALID", mode: "TARGET_ROOT_MODE_INVALID", owner: "TARGET_ROOT_OWNER_INVALID", realpath: "TARGET_ROOT_REALPATH_INVALID" };
  if (targetExists) {
    if (!options.force) fail("TARGET_EXISTS");
    qualifyRoot(targetRoot, ctx, codes);
  } else {
    checkParentSafety(targetRoot, ctx, "TARGET_PARENT_UNSAFE");
  }
  const created = { files: [], dirs: [] };
  let createdRoot = false;
  try {
    const verified = entries.map((entry) => ({ entry, bytes: readVerifiedSource(sourceRoot, entry, ctx) }));
    if (!targetExists) {
      try { ctx.io.mkdirSync(targetRoot, { mode: 0o700 }); } catch (_) { fail("TARGET_DIR_CREATE_FAILED"); }
      createdRoot = true;
      recordRoot(targetRoot, ctx);
      fsyncDirectory(path.dirname(targetRoot), ctx);
    }
    let totalBytes = 0;
    for (const item of verified) totalBytes += copyIntoWorkspace(targetRoot, item, ctx, created, options.force);
    qualifyRoot(targetRoot, ctx, codes);
    qualifyWorkspace(targetRoot, entries, ctx);
    fsyncDirectory(targetRoot, ctx);
    return report("QUALIFIED", entries, totalBytes);
  } catch (error) {
    cleanupCreated(created, createdRoot, targetRoot, ctx);
    throw error;
  }
}

function checkImpl(options, ctx) {
  assertLinux(ctx);
  if (!exactKeys(options, ["targetRoot", "manifestPath"])) fail("CHECK_ARGUMENTS_INVALID");
  const targetRoot = resolveRoot(options.targetRoot, "TARGET_ROOT_INVALID");
  const entries = loadManifest(options.manifestPath, ctx);
  const codes = { invalid: "CHECK_ROOT_INVALID", mode: "CHECK_ROOT_MODE_INVALID", owner: "CHECK_ROOT_OWNER_INVALID", realpath: "CHECK_ROOT_REALPATH_INVALID" };
  if (!pathExists(targetRoot, ctx)) fail("CHECK_ROOT_INVALID");
  qualifyRoot(targetRoot, ctx, codes);
  checkParentSafety(targetRoot, ctx, "CHECK_ROOT_PARENT_UNSAFE");
  const realRoot = path.resolve(ctx.io.realpathSync(targetRoot));
  for (const entry of entries) {
    assertNotDenied(entry.path);
    const file = path.join(targetRoot, ...entry.path.split("/"));
    if (!within(targetRoot, file, ctx)) fail("CHECK_REALPATH_ESCAPE");
    const info = describe(file, ctx);
    if (!info.exists) fail("CHECK_FILE_MISSING");
    if (!info.isFile || info.isSymbolicLink) fail("CHECK_FILE_INVALID");
    if (info.nlink !== 1) fail("CHECK_FILE_LINK_INVALID");
    if ((info.mode & 0o777) !== 0o600) fail("CHECK_FILE_MODE_INVALID");
    if (info.uid !== ctx.uid) fail("CHECK_FILE_OWNER_INVALID");
    let real;
    try { real = path.resolve(ctx.io.realpathSync(file)); } catch (_) { fail("CHECK_FILE_INVALID"); }
    if (!samePath(real, path.resolve(file), ctx)) fail("CHECK_FILE_REALPATH_INVALID");
    if (!within(realRoot, real, ctx)) fail("CHECK_REALPATH_ESCAPE");
    let bytes;
    try { bytes = ctx.io.readFileSync(file); } catch (_) { fail("CHECK_FILE_INVALID"); }
    if (hashBytes(bytes) !== entry.sha256) fail("CHECK_FILE_DIGEST_MISMATCH");
  }
  return report("VERIFIED", entries, entries.length === 0 ? 0 : Object.freeze(entries).reduce((sum, entry) => {
    try { return sum + ctx.io.readFileSync(path.join(targetRoot, ...entry.path.split("/"))).length; } catch (_) { return sum; }
  }, 0));
}

function productionContext() {
  return { platform: process.platform, io: fs, uid: typeof process.getuid === "function" ? process.getuid() : null, testOnly: false, meta: new Map() };
}
function materializeWorkspace(options) { return materializeImpl(options, productionContext()); }
function checkWorkspace(options) { return checkImpl(options, productionContext()); }

function parseCli(args) {
  const command = args[0] === "materialize" ? "materialize" : (args[0] === "check" || args[0] === "--check") ? "check" : null;
  if (!command) fail("USAGE_ERROR");
  const allowed = command === "materialize" ? new Set(["--source", "--target", "--manifest", "--force"]) : new Set(["--target", "--manifest"]);
  const flags = { force: false };
  const rest = args.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!allowed.has(token)) fail("USAGE_ERROR");
    if (token === "--force") { flags.force = true; continue; }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) fail("USAGE_ERROR");
    flags[token.slice(2)] = value;
    index += 1;
  }
  if (!flags.target || !flags.manifest) fail("USAGE_ERROR");
  if (command === "materialize") {
    if (!flags.source) fail("USAGE_ERROR");
    return { command, options: { sourceRoot: flags.source, targetRoot: flags.target, manifestPath: flags.manifest, force: flags.force } };
  }
  return { command, options: { targetRoot: flags.target, manifestPath: flags.manifest } };
}
function runCli(argv = process.argv) {
  try {
    const parsed = parseCli(argv.slice(2));
    const result = parsed.command === "materialize" ? materializeWorkspace(parsed.options) : checkWorkspace(parsed.options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    const blocker = error instanceof WorkspaceError ? error.code : "INTERNAL_FAILURE_REDACTED";
    process.stdout.write(`${JSON.stringify({ status: "FAIL_CLOSED", blocker })}\n`);
    process.exitCode = 1;
    return null;
  }
}
if (require.main === module) runCli();

function createHarness(options) {
  const io = options.io || fs;
  const ctx = { platform: options.platform, uid: options.uid, io, testOnly: true, meta: options.meta || new Map() };
  return Object.freeze({
    materialize: (value) => materializeImpl(value, ctx),
    check: (value) => checkImpl(value, ctx),
    describe: (file) => describe(file, ctx),
    seed: (file, meta) => {
      ctx.meta.set(path.resolve(file), {
        mode: meta.mode, uid: typeof meta.uid === "number" ? meta.uid : ctx.uid,
        nlink: typeof meta.nlink === "number" ? meta.nlink : 1,
        isDir: meta.isDir === true, isFile: meta.isFile === true, size: typeof meta.size === "number" ? meta.size : 0,
      });
    },
  });
}

module.exports = Object.freeze({
  materializeWorkspace, checkWorkspace, runCli, parseCli, WorkspaceError,
  constants: Object.freeze({ MANIFEST_SCHEMA, DIGEST, MAX_MANIFEST_BYTES, ENDPOINT_INVENTORY, DENY_RULE_CODES }),
  _test: Object.freeze({ createHarness, validateManifest, normalizeRel, assertNotDenied, hashBytes, describe, DENY_RULES }),
});
