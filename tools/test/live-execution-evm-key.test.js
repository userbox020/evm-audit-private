#!/usr/bin/env node
"use strict";

// live-execution-evm-key.test.js
//
// Offline coverage for tools/live-execution-evm-key.js. All keys are generated
// inside os.tmpdir() only. The suite is deterministic on Windows: the loader's
// filesystem context accepts an injected POSIX metadata overlay
// (`_test.createHarness`), the same technique used by
// tools/test/qualify-live-execution-workspace.test.js.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const keyTool = require("../live-execution-evm-key.js");

function tempBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "evm-key-"));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
  return base;
}

function linuxHarness(t) {
  const base = tempBase(t);
  const harness = keyTool._test.createHarness({ platform: "linux", io: fs });
  harness.seed(base, { isDir: true, isFile: false, isSymbolicLink: false, mode: 0o700, nlink: 1, size: 0 });
  return { base, harness };
}

function readKeyHex(file) {
  return fs.readFileSync(file, "utf8").trim().replace(/^0x/iu, "");
}

test("generate then load round-trips to the same address", (t) => {
  const { base, harness } = linuxHarness(t);
  const outPath = path.join(base, "base-sepolia.key");
  const address = harness.generate({ outPath });

  assert.match(address, /^0x[0-9a-fA-F]{40}$/u);
  const info = harness.describe(outPath);
  assert.equal(info.isFile, true);
  assert.equal(info.isSymbolicLink, false);
  assert.equal(info.nlink, 1);
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(readKeyHex(outPath).length, 64);

  const loaded = harness.load({ keyPath: outPath });
  try {
    assert.equal(loaded.signer.address, address);
    assert.equal(Buffer.isBuffer(loaded.keyBytes), true);
    assert.equal(loaded.keyBytes.length, 32);
  } finally {
    loaded.keyBytes.fill(0);
  }
});

test("file mode, hard-link, and symlink rules are enforced on load", (t) => {
  const { base, harness } = linuxHarness(t);
  const outPath = path.join(base, "rules.key");
  harness.generate({ outPath });

  const cases = [
    { meta: { isFile: true, isDir: false, isSymbolicLink: false, mode: 0o644, nlink: 1 }, code: "EVM_KEY_MODE_REFUSED" },
    { meta: { isFile: true, isDir: false, isSymbolicLink: false, mode: 0o600, nlink: 2 }, code: "EVM_KEY_LINK_REFUSED" },
    { meta: { isFile: true, isDir: false, isSymbolicLink: true, mode: 0o600, nlink: 1 }, code: "EVM_KEY_SYMLINK_REFUSED" },
  ];
  for (const item of cases) {
    harness.seed(outPath, item.meta);
    assert.throws(() => harness.load({ keyPath: outPath }), new RegExp(item.code, "u"), item.code);
    harness.seed(outPath, { isFile: true, isDir: false, isSymbolicLink: false, mode: 0o600, nlink: 1 });
  }

  const loaded = harness.load({ keyPath: outPath });
  loaded.keyBytes.fill(0);
});

test("overwrite is refused without --force and permitted with --force", (t) => {
  const { base, harness } = linuxHarness(t);
  const outPath = path.join(base, "overwrite.key");
  const first = harness.generate({ outPath });

  assert.throws(() => harness.generate({ outPath }), /EVM_KEY_REFUSED_EXISTS/u);

  const second = harness.generate({ outPath, force: true });
  assert.notEqual(second, first);
  assert.equal(readKeyHex(outPath).length, 64);
});

test("sensitive .env, inventory, and registry-like paths are refused", (t) => {
  const { base, harness } = linuxHarness(t);
  const denied = [
    ".env",
    path.join("nested", ".env.local"),
    "rpc_endpoints.txt",
    "graphql_endpoints.txt",
    "base_full_stack_endpoints.md",
    "hyperevm_archive_endpoints.md",
    "approver-registry.json",
    "live-execution-approvers.json",
  ];
  for (const name of denied) {
    const outPath = path.join(base, name);
    assert.throws(() => harness.generate({ outPath }), /EVM_KEY_REFUSED_SENSITIVE_PATH/u, name);
    assert.throws(() => harness.load({ keyPath: outPath }), /EVM_KEY_REFUSED_SENSITIVE_PATH/u, name);
  }
});

test("generated output never contains private key material", (t) => {
  const { base, harness } = linuxHarness(t);
  const outPath = path.join(base, "material.key");
  const address = harness.generate({ outPath });
  const key = readKeyHex(outPath);
  assert.equal(key.length, 64);

  assert.equal(address.toLowerCase().includes(key.toLowerCase()), false);
  assert.equal(JSON.stringify({ command: "generate", address }).toLowerCase().includes(key.toLowerCase()), false);

  const loaded = harness.load({ keyPath: outPath });
  try {
    assert.equal(loaded.signer.privateKey.slice(2).toLowerCase(), key.toLowerCase());
  } finally {
    loaded.keyBytes.fill(0);
  }

  const source = fs.readFileSync(path.join(__dirname, "..", "live-execution-evm-key.js"), "utf8");
  assert.equal(source.includes(key), false, "module source must not contain a generated key");
});

test("generate and load require the linux platform", (t) => {
  const base = tempBase(t);
  const harness = keyTool._test.createHarness({ platform: "win32", io: fs });
  const outPath = path.join(base, "win.key");
  assert.throws(() => harness.generate({ outPath }), /EVM_KEY_PLATFORM_REQUIRED/u);
  assert.throws(() => harness.load({ keyPath: outPath }), /EVM_KEY_PLATFORM_REQUIRED/u);
});

test("load refuses relative, missing, oversized, and malformed key files", (t) => {
  const { base, harness } = linuxHarness(t);
  assert.throws(() => harness.load({ keyPath: "relative.key" }), /EVM_KEY_PATH_INVALID/u);
  assert.throws(() => harness.load({ keyPath: path.join(base, "missing.key") }), /EVM_KEY_UNAVAILABLE/u);

  const malformed = path.join(base, "malformed.key");
  fs.writeFileSync(malformed, "not-a-private-key\n");
  harness.seed(malformed, { isFile: true, isDir: false, isSymbolicLink: false, mode: 0o600, nlink: 1 });
  assert.throws(() => harness.load({ keyPath: malformed }), /EVM_KEY_MATERIAL_INVALID/u);

  const oversized = path.join(base, "oversized.key");
  fs.writeFileSync(oversized, "a".repeat(5000));
  harness.seed(oversized, { isFile: true, isDir: false, isSymbolicLink: false, mode: 0o600, nlink: 1, size: 5000 });
  assert.throws(() => harness.load({ keyPath: oversized }), /EVM_KEY_SIZE_REFUSED/u);
});

test("CLI refuses unknown commands with a sanitized code and no key material", () => {
  const tool = path.join(__dirname, "..", "live-execution-evm-key.js");
  const result = spawnSync(process.execPath, [tool, "bogus"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { status: "FAIL_CLOSED", blocker: "USAGE_ERROR" });
  assert.equal(/[0-9a-fA-F]{64}/u.test(result.stdout), false, "no key-shaped material may be printed");
});

test("CLI generate fails closed on non-linux without emitting key material", { skip: process.platform === "linux" }, (t) => {
  const base = tempBase(t);
  const outPath = path.join(base, "cli.key");
  const tool = path.join(__dirname, "..", "live-execution-evm-key.js");
  const result = spawnSync(process.execPath, [tool, "generate", "--out", outPath], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { status: "FAIL_CLOSED", blocker: "EVM_KEY_PLATFORM_REQUIRED" });
  assert.equal(fs.existsSync(outPath), false, "no key file is created off-platform");
  assert.equal(/[0-9a-fA-F]{64}/u.test(result.stdout), false);
});
