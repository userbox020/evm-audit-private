#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const tool = require("../qualify-live-execution-workspace.js");

const UID = 4242;
const SCHEMA = tool.constants.MANIFEST_SCHEMA;
const TOOL_PATH = path.join(__dirname, "..", "qualify-live-execution-workspace.js");

function hash(bytes) { return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`; }

function makeEnv(options = {}) {
  const platform = options.platform || "linux";
  const uid = typeof options.uid === "number" ? options.uid : UID;
  const io = options.io || fs;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qlx-workspace-"));
  const parent = path.join(base, "parent");
  const source = path.join(base, "source");
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.mkdirSync(source, { mode: 0o700 });
  const harness = tool._test.createHarness({ platform, uid, io });
  harness.seed(parent, { mode: 0o700, uid, isDir: true });
  const target = path.join(parent, "workspace");
  return { base, parent, source, target, harness, io };
}
function rmEnv(env) { fs.rmSync(env.base, { recursive: true, force: true }); }
function writeSource(env, rel, content) {
  const file = path.join(env.source, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
function manifestFile(env, entries) {
  const manifestPath = path.join(env.base, "workspace-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ schema: SCHEMA, files: entries }));
  return manifestPath;
}
function entry(env, rel) {
  return { path: rel, sha256: hash(fs.readFileSync(path.join(env.source, ...rel.split("/")))) };
}
function materialize(env, manifestPath, extra = {}) {
  return env.harness.materialize({ sourceRoot: env.source, targetRoot: env.target, manifestPath, force: false, ...extra });
}

test("deny-listed secrets and endpoint inventories are refused before any read or copy", (t) => {
  const reads = [];
  const io = new Proxy(fs, {
    get(target, property) {
      if (property === "readFileSync") {
        return (file, ...rest) => { reads.push(path.resolve(String(file))); return target.readFileSync(file, ...rest); };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env = makeEnv({ io });
  t.after(() => rmEnv(env));
  writeSource(env, "notes.txt", "reviewed content");
  const decoys = [".env", "id_ed25519", "key.pem", "rpc_endpoints.txt"];
  for (const rel of decoys) writeSource(env, rel, `secret-${rel}`);
  const manifestPath = manifestFile(env, [entry(env, "notes.txt"), ...decoys.map((rel) => entry(env, rel))]);

  assert.throws(() => materialize(env, manifestPath), /DENY_/);
  assert.equal(fs.existsSync(env.target), false);
  const decoyPaths = new Set(decoys.map((rel) => path.resolve(path.join(env.source, rel))));
  assert.equal(reads.some((file) => decoyPaths.has(file)), false);
  assert.deepEqual(reads, [path.resolve(manifestPath)]);
});

test("digest mismatch aborts the whole run and leaves no partial workspace", (t) => {
  const env = makeEnv();
  t.after(() => rmEnv(env));
  writeSource(env, "alpha.txt", "alpha");
  writeSource(env, "beta.txt", "beta");
  const manifestPath = manifestFile(env, [entry(env, "alpha.txt"), { ...entry(env, "beta.txt"), sha256: hash(Buffer.from("different bytes")) }]);

  assert.throws(() => materialize(env, manifestPath), /SOURCE_DIGEST_MISMATCH/);
  assert.equal(fs.existsSync(env.target), false);
});

test("a write failure mid-copy removes only what the run created", (t) => {
  let writes = 0;
  const io = new Proxy(fs, {
    get(target, property) {
      if (property === "writeFileSync") {
        return (file, ...rest) => {
          writes += 1;
          if (writes === 2) { const error = new Error("injected write failure"); error.code = "EIO"; throw error; }
          return target.writeFileSync(file, ...rest);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env = makeEnv({ io });
  t.after(() => rmEnv(env));
  writeSource(env, "one.txt", "one");
  writeSource(env, "two.txt", "two");
  const manifestPath = manifestFile(env, [entry(env, "one.txt"), entry(env, "two.txt")]);

  assert.throws(() => materialize(env, manifestPath), /TARGET_WRITE_FAILED/);
  assert.equal(fs.existsSync(env.target), false);
  assert.equal(fs.existsSync(env.parent), true);
});

test("successful qualification yields 0700 directories, 0600 single-link files, and matching digests", (t) => {
  const env = makeEnv();
  t.after(() => rmEnv(env));
  writeSource(env, "README.md", "workspace readme");
  const script = "#!/usr/bin/env bash\necho ok\n";
  writeSource(env, "scripts/run.sh", script);
  const entries = [entry(env, "README.md"), entry(env, "scripts/run.sh")];
  const manifestPath = manifestFile(env, entries);

  const result = materialize(env, manifestPath);
  assert.equal(result.status, "QUALIFIED");
  assert.deepEqual(result.counts, { files: 2, directories: 1, bytes: Buffer.byteLength("workspace readme") + Buffer.byteLength(script) });
  for (const item of result.files) {
    assert.equal(item.mode, "0600");
    assert.equal(item.nlink, 1);
    assert.equal(item.sha256, entries.find((candidate) => candidate.path === item.path).sha256);
  }
  const rootInfo = env.harness.describe(env.target);
  assert.equal(rootInfo.mode & 0o777, 0o700);
  assert.equal(rootInfo.isDirectory, true);
  assert.equal(rootInfo.isSymbolicLink, false);
  for (const item of entries) {
    const file = path.join(env.target, ...item.path.split("/"));
    const info = env.harness.describe(file);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.nlink, 1);
    assert.equal(info.isFile, true);
    assert.equal(info.isSymbolicLink, false);
    assert.equal(hash(fs.readFileSync(file)), item.sha256);
  }
  assert.equal(env.harness.check({ targetRoot: env.target, manifestPath }).status, "VERIFIED");
});

test("--check passes on a good workspace and fails on a mutated file", (t) => {
  const env = makeEnv();
  t.after(() => rmEnv(env));
  writeSource(env, "config/app.json", "{\"ok\":true}\n");
  const manifestPath = manifestFile(env, [entry(env, "config/app.json")]);
  materialize(env, manifestPath);

  assert.equal(env.harness.check({ targetRoot: env.target, manifestPath }).status, "VERIFIED");
  fs.appendFileSync(path.join(env.target, "config", "app.json"), "\n");
  assert.throws(() => env.harness.check({ targetRoot: env.target, manifestPath }), /CHECK_FILE_DIGEST_MISMATCH/);
});

test("path traversal and absolute manifest paths are refused", (t) => {
  const traversal = makeEnv();
  t.after(() => rmEnv(traversal));
  writeSource(traversal, "ok.txt", "ok");
  const traversalManifest = manifestFile(traversal, [{ path: "../escape.txt", sha256: hash(Buffer.from("x")) }]);
  assert.throws(() => materialize(traversal, traversalManifest), /PATH_TRAVERSAL/);
  assert.equal(fs.existsSync(traversal.target), false);

  const absolute = makeEnv();
  t.after(() => rmEnv(absolute));
  writeSource(absolute, "ok.txt", "ok");
  const absoluteManifest = manifestFile(absolute, [{ path: "/tmp/escape.txt", sha256: hash(Buffer.from("x")) }]);
  assert.throws(() => materialize(absolute, absoluteManifest), /PATH_ABSOLUTE/);
  assert.equal(fs.existsSync(absolute.target), false);
});

test("platform guard rejects when the injected platform is not linux", (t) => {
  const env = makeEnv({ platform: "win32" });
  t.after(() => rmEnv(env));
  writeSource(env, "ok.txt", "ok");
  const manifestPath = manifestFile(env, [entry(env, "ok.txt")]);

  assert.throws(() => materialize(env, manifestPath), /LINUX_PLATFORM_REQUIRED/);
  assert.throws(() => env.harness.check({ targetRoot: env.target, manifestPath }), /LINUX_PLATFORM_REQUIRED/);
  assert.equal(fs.existsSync(env.target), false);
});

test("an existing target is refused unless --force re-materialization is passed", (t) => {
  const env = makeEnv();
  t.after(() => rmEnv(env));
  writeSource(env, "ok.txt", "first");
  const manifestPath = manifestFile(env, [entry(env, "ok.txt")]);
  materialize(env, manifestPath);

  assert.throws(() => materialize(env, manifestPath), /TARGET_EXISTS/);
  writeSource(env, "ok.txt", "second");
  const updatedManifest = manifestFile(env, [entry(env, "ok.txt")]);
  assert.equal(materialize(env, updatedManifest, { force: true }).status, "QUALIFIED");
  assert.equal(fs.readFileSync(path.join(env.target, "ok.txt"), "utf8"), "second");
});

test("production CLI on a non-linux host fails closed with a sanitized code", { skip: process.platform === "linux" }, () => {
  const result = spawnSync(process.execPath, [TOOL_PATH, "materialize", "--source", ".", "--target", ".", "--manifest", "missing.json"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { status: "FAIL_CLOSED", blocker: "LINUX_PLATFORM_REQUIRED" });
  assert.equal(result.stdout.includes(os.tmpdir()), false);
});

// --- Remediation coverage: separator-normalized secret-name deny rules ---

const SECRET_NAME_DECOYS = Object.freeze([
  "private_key.json",
  "secret_key.json",
  "mnemonic.txt",
  "mnemonic.json",
  "seed_phrase.txt",
  "credentials.json",
  "apikey.json",
  "api_key.json",
  "access_token.json",
]);
// Names that previously slipped through `assertNotDenied` because the
// credential stem rule was narrowed to an exact-stem match. Every one of these
// is now refused before any read: `.json` credential names via the broadened
// JSON subset rule and the conservative stem tokens, the dotfiles and
// GCP/AWS pairings via explicit exact-name rules, and `*.keystore` via the
// private-key extension rule.
const UNDER_BLOCK_DECOYS = Object.freeze([
  "my_credentials.json",
  "aws_credentials.json",
  "credentials-prod.json",
  "prod_credential.json",
  ".git-credentials",
  ".netrc",
  "service-account.json",
  "google-services.json",
  "node.keystore",
  "mywallet.json",
  "backup.wallet.json",
]);
const CASE_VARIANT_DECOYS = Object.freeze([
  "PRIVATE_KEY.JSON",
  "Mnemonic.TXT",
  "MY_CREDENTIALS.JSON",
  ".NETRC",
  "Service-Account.JSON",
  "GOOGLE-SERVICES.JSON",
  "NODE.KEYSTORE",
]);
const LEGACY_DECOYS = Object.freeze([
  ".env",
  "id_ed25519",
  "key.pem",
  "rpc_endpoints.txt",
  "graphql_endpoints.txt",
  "base_full_stack_endpoints.md",
  "hyperevm_archive_endpoints.md",
]);
// Deliberate CONSERVATIVE refusals: each stem contains a secret-material token,
// so the deny boundary refuses it regardless of extension even though the file
// is plausibly documentation/data. This list is asserted as intentional so the
// documented behavior and the implementation agree; do NOT weaken coverage to
// admit these names.
const CONSERVATIVE_REFUSAL_NAMES = Object.freeze([
  "password-policy.md",
  "seed-data.csv",
  "random-seed.md",
  "top-secret-notes.md",
  "secrets-management.md",
  "apikey-rotation.md",
  "wallet-addresses.md",
  "credentials-guide.md",
]);
// Genuinely innocuous names with no secret-material token: these must remain
// accepted so the allowlist stays usable.
const INNOCUOUS_NAMES = Object.freeze([
  "index.json",
  "manifest.json",
  "policy.json",
  "README.md",
]);

function trackingIo(reads) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === "readFileSync") {
        return (file, ...rest) => { reads.push(path.resolve(String(file))); return target.readFileSync(file, ...rest); };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function assertRefusedBeforeRead(t, rel) {
  const reads = [];
  const env = makeEnv({ io: trackingIo(reads) });
  t.after(() => rmEnv(env));
  writeSource(env, "notes.txt", "reviewed content");
  writeSource(env, rel, `secret-${rel}`);
  const manifestPath = manifestFile(env, [entry(env, "notes.txt"), entry(env, rel)]);
  assert.throws(() => materialize(env, manifestPath), /DENY_/, `${rel} must be refused`);
  assert.equal(fs.existsSync(env.target), false, `${rel} must not materialize a target`);
  const decoy = path.resolve(path.join(env.source, rel));
  assert.equal(reads.includes(decoy), false, `${rel} must not be read`);
  assert.deepEqual(reads, [path.resolve(manifestPath)], `${rel} must abort before any source read`);
}

test("separator-normalized secret names are refused before any read", (t) => {
  for (const rel of SECRET_NAME_DECOYS) assertRefusedBeforeRead(t, rel);
});

test("previously under-blocked credential names are now refused before any read", (t) => {
  for (const rel of UNDER_BLOCK_DECOYS) assertRefusedBeforeRead(t, rel);
});

test("uppercase secret-name variants are refused before any read", (t) => {
  for (const rel of CASE_VARIANT_DECOYS) assertRefusedBeforeRead(t, rel);
});

test("conservative refusal of secret-token documentation names is intentional before any read", (t) => {
  for (const rel of CONSERVATIVE_REFUSAL_NAMES) assertRefusedBeforeRead(t, rel);
});

test("endpoint inventories and legacy decoys remain refused before any read", (t) => {
  for (const rel of LEGACY_DECOYS) assertRefusedBeforeRead(t, rel);
});

test("the normalized deny list does not over-block genuinely innocuous workspace names", (t) => {
  const env = makeEnv();
  t.after(() => rmEnv(env));
  for (const rel of INNOCUOUS_NAMES) writeSource(env, rel, `content-${rel}`);
  const manifestPath = manifestFile(env, INNOCUOUS_NAMES.map((rel) => entry(env, rel)));
  const result = materialize(env, manifestPath);
  assert.equal(result.status, "QUALIFIED");
  assert.deepEqual(result.files.map((item) => item.path).sort(), [...INNOCUOUS_NAMES].sort());
  for (const rel of INNOCUOUS_NAMES) assert.equal(fs.existsSync(path.join(env.target, ...rel.split("/"))), true, rel);
});

test("deny list unit coverage: each secret spelling is denied and each innocuous name is allowed", () => {
  for (const rel of [...SECRET_NAME_DECOYS, ...UNDER_BLOCK_DECOYS, ...CASE_VARIANT_DECOYS, ...LEGACY_DECOYS]) {
    assert.throws(() => tool._test.assertNotDenied(rel), /DENY_/, rel);
  }
  for (const rel of INNOCUOUS_NAMES) {
    assert.doesNotThrow(() => tool._test.assertNotDenied(rel), rel);
  }
});

test("conservative denial is intentional: token-bearing documentation names are refused by design", () => {
  for (const rel of CONSERVATIVE_REFUSAL_NAMES) {
    assert.throws(() => tool._test.assertNotDenied(rel), /DENY_/, `${rel} is intentionally refused (conservative boundary)`);
  }
});
