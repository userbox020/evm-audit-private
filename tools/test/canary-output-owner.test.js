"use strict";

// Offline filesystem tests: synthetic temporary outputs only, no RPC or producer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireCanaryOutputOwner: acquire, assertCanaryOutputOwner, CanaryOutputOwnershipError, LOCK_NAME } =
  require("../lib/canary-output-owner.js");

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canary-owner-offline-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("exclusive owner covers alternate --out names in the same physical output directory", (t) => {
  const dir = temporary(t);
  const first = acquire(path.join(dir, "status.json"));
  first.check();
  assert.throws(() => acquire(path.join(dir, "alternate-status.json")), /EEXIST/);
  assert.equal(first.release(), true);
  const second = acquire(path.join(dir, "alternate-status.json"));
  second.check();
  assert.equal(second.release(), true);
});

test("only the acquired opaque owner is accepted for its exact output path", (t) => {
  const dir = temporary(t);
  const target = path.join(dir, "status.json");
  const owner = acquire(target);
  assert.doesNotThrow(() => assertCanaryOutputOwner(owner, target));
  for (const forged of [{ check() {} }, { ...owner }, null]) {
    assert.throws(() => assertCanaryOutputOwner(forged, target), CanaryOutputOwnershipError);
  }
  assert.throws(() => assertCanaryOutputOwner(owner, path.join(dir, "other.json")), CanaryOutputOwnershipError);
  assert.equal(owner.release(), true);
  assert.throws(() => assertCanaryOutputOwner(owner, target), CanaryOutputOwnershipError);
});

test("pre-existing stale lock and spoofed live PID never trigger automatic takeover", (t) => {
  const dir = temporary(t);
  const lock = path.join(dir, LOCK_NAME);
  fs.mkdirSync(lock);
  const marker = JSON.stringify({ token: "stale", pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z" });
  fs.writeFileSync(path.join(lock, "owner.json"), marker);
  assert.throws(() => acquire(path.join(dir, "status.json")), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(lock, "owner.json"), "utf8"), marker);
  assert.equal(fs.existsSync(path.join(dir, "status.json")), false);
});

test("lost owner identity stops before the next artifact write and cannot remove replacement", (t) => {
  const dir = temporary(t);
  const target = path.join(dir, "status.json");
  const owner = acquire(target);
  owner.check();
  fs.writeFileSync(target, "first-owned-write");
  const metadata = path.join(owner.lockDir, "owner.json");
  fs.writeFileSync(metadata, JSON.stringify({ token: "replacement", pid: process.pid,
    startedAt: new Date().toISOString() }));
  assert.throws(() => owner.check(), CanaryOutputOwnershipError);
  assert.equal(owner.release(), false);
  assert.equal(fs.readFileSync(target, "utf8"), "first-owned-write");
  assert.equal(fs.existsSync(owner.lockDir), true);
  assert.throws(() => acquire(path.join(dir, "other.json")), /EEXIST/);
});

test("heartbeat write failure loses ownership and fails closed without later output", (t) => {
  const dir = temporary(t);
  const owner = acquire(path.join(dir, "status.json"));
  fs.mkdirSync(path.join(owner.lockDir, "heartbeat")); // cannot write the heartbeat
  assert.throws(() => owner.check(), CanaryOutputOwnershipError);
  assert.equal(owner.release(), false);
  assert.equal(fs.existsSync(path.join(dir, "status.json")), false);
  assert.equal(fs.existsSync(owner.lockDir), true);
});

test("normal check/release enables reacquisition; reserved artifact names cannot be output", (t) => {
  const dir = temporary(t);
  for (const name of ["history.json", "runs.jsonl", LOCK_NAME]) {
    assert.throws(() => acquire(path.join(dir, name)), CanaryOutputOwnershipError);
  }
  const owner = acquire(path.join(dir, "status.json"));
  owner.check();
  owner.check();
  assert.equal(owner.release(), true);
  assert.equal(fs.existsSync(owner.lockDir), false);
  const again = acquire(path.join(dir, "status.json"));
  assert.equal(again.release(), true);
});

test("directory aliases and artifact symlinks cannot bypass the output owner", (t) => {
  const dir = temporary(t);
  const actual = path.join(dir, "actual");
  fs.mkdirSync(actual);
  const alias = path.join(dir, "alias");
  try { fs.symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("symlinks unavailable"); return; }
    throw error;
  }
  assert.throws(() => acquire(path.join(alias, "status.json")), CanaryOutputOwnershipError);
  const owner = acquire(path.join(actual, "status.json"));
  try { fs.symlinkSync(path.join(dir, "outside.json"), path.join(actual, "history.json"), "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      assert.equal(owner.release(), true); // junction alias rejection was still checked
      return;
    }
    throw error;
  }
  assert.throws(() => owner.check(), CanaryOutputOwnershipError);
  assert.equal(owner.release(), false);
  assert.equal(fs.existsSync(path.join(dir, "outside.json")), false);
});
