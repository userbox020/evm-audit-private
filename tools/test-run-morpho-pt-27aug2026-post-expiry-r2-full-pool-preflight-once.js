#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const wrapper = require("./run-morpho-pt-27aug2026-post-expiry-r2-full-pool-preflight-once.js");

const TEMP_PARENT = path.join(os.tmpdir(), "opencode");
const GOOD_ARGV = [process.execPath, __filename];
const FIXTURE_BYTES = Buffer.from("synthetic offline runner fixture\n", "utf8");
const FIXTURE_SHA256 = crypto.createHash("sha256").update(FIXTURE_BYTES).digest("hex");
let root;
let runner;

function execute(overrides = {}) {
  let spawns = 0;
  const spawnSync = overrides.spawnSync || (() => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: null }));
  const result = wrapper.runOnce({
    argv: GOOD_ARGV,
    fs,
    writeSync: () => { throw new Error("UNEXPECTED_WRITE"); },
    runner,
    expectedSha256: FIXTURE_SHA256,
    ...overrides,
    spawnSync: (...args) => { spawns++; return spawnSync(...args); },
  });
  return { result, spawns };
}

test.before(() => {
  fs.mkdirSync(TEMP_PARENT, { recursive: true });
  root = fs.mkdtempSync(path.join(TEMP_PARENT, "r2-preflight-once-unit-"));
  runner = path.join(root, "synthetic-runner.exe");
  fs.writeFileSync(runner, FIXTURE_BYTES, { flag: "wx", mode: 0o600 });
});

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

test("zero or trailing arguments fail before spawn", () => {
  for (const argv of [[], [...GOOD_ARGV, "trailing"]]) {
    const outcome = execute({ argv });
    assert.deepEqual(outcome, { result: 125, spawns: 0 });
  }
});

test("missing runner and wrong hash fail before spawn", () => {
  assert.deepEqual(execute({ runner: path.join(root, "missing.exe") }), { result: 125, spawns: 0 });
  assert.deepEqual(execute({ expectedSha256: "00".repeat(32) }), { result: 125, spawns: 0 });
});

test("non-regular or symbolic runner authority fails before spawn", () => {
  assert.deepEqual(execute({ runner: root }), { result: 125, spawns: 0 });
  const symbolic = { isFile: () => true, isSymbolicLink: () => true };
  assert.deepEqual(execute({ fs: { lstatSync: () => symbolic, readFileSync: () => { throw new Error("SYMLINK_READ_FORBIDDEN"); } } }), { result: 125, spawns: 0 });
});

test("one spawn uses the exact runner, empty args, and sealed options", () => {
  const stdout = Buffer.from("stdout"), stderr = Buffer.from("stderr"), writes = [];
  let observed;
  const outcome = execute({
    spawnSync(file, args, options) { observed = { file, args, options }; return { status: 7, stdout, stderr, error: null }; },
    writeSync(fd, bytes, offset, length) { writes.push({ fd, bytes: Buffer.from(bytes.subarray(offset, offset + length)) }); return length; },
  });
  assert.equal(outcome.result, 7);
  assert.equal(outcome.spawns, 1);
  assert.equal(observed.file, runner);
  assert.deepEqual(observed.args, []);
  assert.deepEqual(observed.options, { shell: false, input: Buffer.alloc(0), encoding: null, windowsHide: true, timeout: 160000, maxBuffer: 65536, env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" } });
  assert.deepEqual(writes, [{ fd: 1, bytes: stdout }, { fd: 2, bytes: stderr }]);
});

test("null streams are accepted without writes", () => {
  let writes = 0;
  const outcome = execute({ spawnSync: () => ({ status: 0, stdout: null, stderr: null, error: null }), writeSync: () => { writes++; return 0; } });
  assert.equal(outcome.result, 0);
  assert.equal(outcome.spawns, 1);
  assert.equal(writes, 0);
});

test("checked write loops tolerate EINTR and short synchronous writes", () => {
  const collected = { 1: [], 2: [] }, calls = { 1: 0, 2: 0 };
  const outcome = execute({
    spawnSync: () => ({ status: 0, stdout: Buffer.from("abcdef"), stderr: Buffer.from("xyz"), error: null }),
    writeSync(fd, bytes, offset, length) {
      calls[fd]++;
      if (fd === 1 && calls[fd] === 1) { const error = new Error("interrupted"); error.code = "EINTR"; throw error; }
      const count = Math.min(2, length);
      collected[fd].push(Buffer.from(bytes.subarray(offset, offset + count)));
      return count;
    },
  });
  assert.equal(outcome.result, 0);
  assert.equal(outcome.spawns, 1);
  assert.equal(Buffer.concat(collected[1]).toString(), "abcdef");
  assert.equal(Buffer.concat(collected[2]).toString(), "xyz");
});

test("timeout, spawn errors, missing results, and exact statuses map deterministically", () => {
  const rows = [
    [{ error: { code: "ETIMEDOUT" }, status: null, stdout: null, stderr: null }, 124],
    [{ error: { code: "ENOENT" }, status: null, stdout: null, stderr: null }, 125],
    [undefined, 125],
    [{ error: null, status: null, stdout: null, stderr: null }, 125],
    [{ error: null, status: -1, stdout: null, stderr: null }, 125],
    [{ error: null, status: 256, stdout: null, stderr: null }, 125],
    [{ error: null, status: 1.5, stdout: null, stderr: null }, 125],
    ...[0, 1, 2, 124, 125, 255].map((status) => [{ error: null, status, stdout: null, stderr: null }, status]),
  ];
  for (const [childResult, expected] of rows) {
    const outcome = execute({ spawnSync: () => childResult, writeSync: fs.writeSync });
    assert.equal(outcome.result, expected);
    assert.equal(outcome.spawns, 1);
  }
  const thrown = execute({ spawnSync: () => { throw new Error("synthetic spawn failure"); } });
  assert.deepEqual(thrown, { result: 125, spawns: 1 });
});

test("direct source sets exitCode and never calls process.exit", () => {
  const source = fs.readFileSync(path.join(__dirname, "run-morpho-pt-27aug2026-post-expiry-r2-full-pool-preflight-once.js"), "utf8");
  assert.match(source, /process\.exitCode\s*=/u);
  assert.doesNotMatch(source, /process\.exit\s*\(/u);
  assert.match(wrapper.RUNNER, /^C:\\_Work\\__EVM_AUDIT\\\.runtime\\morpho-pt-post-expiry-r2\\/u);
  assert.equal(wrapper.RUNNER_SHA256, "33db31277c403c18837f254a350996120c2cbaa97d9c944b312fbc3cfc1e2761");
});
