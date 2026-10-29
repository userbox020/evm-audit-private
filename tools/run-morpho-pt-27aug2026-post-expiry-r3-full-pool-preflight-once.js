#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");

const RUNNER = "C:\\_Work\\__EVM_AUDIT\\.runtime\\morpho-pt-post-expiry-r3-preflight\\morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32.exe";
const RUNNER_SHA256 = "3ef3a9b30837c58d4b8cfa2281fda523dcf7540b2f24a0c001622ccd59219459";
const SPAWN_OPTIONS = Object.freeze({
  shell: false,
  input: Buffer.alloc(0),
  encoding: null,
  windowsHide: true,
  timeout: 160000,
  maxBuffer: 65536,
  env: Object.freeze({ SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" }),
});

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function verifyRunner(fsImpl, runner, expectedSha256) {
  const before = fsImpl.lstatSync(runner);
  if (!before.isFile() || before.isSymbolicLink()) return false;
  const bytes = fsImpl.readFileSync(runner);
  const after = fsImpl.lstatSync(runner);
  return sameIdentity(before, after) && crypto.createHash("sha256").update(bytes).digest("hex") === expectedSha256;
}

function outputBytes(value) {
  if (value === null || value === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("INVALID_CHILD_OUTPUT");
}

function writeAll(writeSync, fd, value) {
  const bytes = outputBytes(value);
  let offset = 0;
  while (offset < bytes.length) {
    let written;
    try {
      written = writeSync(fd, bytes, offset, bytes.length - offset, null);
    } catch (error) {
      if (error && error.code === "EINTR") continue;
      throw error;
    }
    if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error("INVALID_SYNCHRONOUS_WRITE");
    offset += written;
  }
}

function exitStatus(result) {
  if (!result || typeof result !== "object") return 125;
  if (result.error) return result.error.code === "ETIMEDOUT" ? 124 : 125;
  return Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : 125;
}

function runOnce(dependencies = {}) {
  const argv = dependencies.argv || process.argv;
  const fsImpl = dependencies.fs || fs;
  const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
  const writeSync = dependencies.writeSync || fs.writeSync;
  const runner = dependencies.runner || RUNNER;
  const expectedSha256 = dependencies.expectedSha256 || RUNNER_SHA256;
  if (!Array.isArray(argv) || argv.length !== 2) return 125;
  try {
    if (!verifyRunner(fsImpl, runner, expectedSha256)) return 125;
  } catch (_) {
    return 125;
  }
  let result;
  try {
    result = spawnSync(runner, [], {
      shell: SPAWN_OPTIONS.shell,
      input: Buffer.alloc(0),
      encoding: SPAWN_OPTIONS.encoding,
      windowsHide: SPAWN_OPTIONS.windowsHide,
      timeout: SPAWN_OPTIONS.timeout,
      maxBuffer: SPAWN_OPTIONS.maxBuffer,
      env: { SystemRoot: SPAWN_OPTIONS.env.SystemRoot, WINDIR: SPAWN_OPTIONS.env.WINDIR },
    });
  } catch (_) {
    return 125;
  }
  try {
    writeAll(writeSync, 1, result && result.stdout);
    writeAll(writeSync, 2, result && result.stderr);
  } catch (_) {
    return 125;
  }
  return exitStatus(result);
}

function main() {
  process.exitCode = runOnce({
    argv: process.argv,
    fs,
    spawnSync: childProcess.spawnSync,
    writeSync: fs.writeSync,
    runner: RUNNER,
    expectedSha256: RUNNER_SHA256,
  });
}

if (require.main === module) main();

module.exports = Object.freeze({ RUNNER, RUNNER_SHA256, SPAWN_OPTIONS, sameIdentity, verifyRunner, outputBytes, writeAll, exitStatus, runOnce });
