"use strict";

// An exclusive, non-recovering writer lock for the dedicated read-only canary.
// A crashed process leaves the lock for attended identity inspection/quarantine.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LOCK_NAME = ".exploit-rearm-canary-writer.lock";
const OWNER_NAME = "owner.json";
const HEARTBEAT_NAME = "heartbeat";
const issuedOwners = new WeakMap();

class CanaryOutputOwnershipError extends Error {
  constructor() { super("canary-output-ownership-lost"); this.name = "CanaryOutputOwnershipError"; }
}

function noSymlinkComponents(target) {
  const resolved = path.resolve(target);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new CanaryOutputOwnershipError();
  }
}

function regularOrAbsent(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return error.code === "ENOENT";
  }
}

function acquireCanaryOutputOwner(outPath) {
  const exactOutPath = path.resolve(outPath);
  const directory = path.resolve(path.dirname(outPath));
  const filename = path.basename(outPath);
  if (["history.json", "runs.jsonl", LOCK_NAME].includes(filename)) throw new CanaryOutputOwnershipError();
  noSymlinkComponents(directory);
  fs.mkdirSync(directory, { recursive: true });
  noSymlinkComponents(directory);
  for (const artifact of [filename, "history.json", "runs.jsonl"]) {
    if (!regularOrAbsent(path.join(directory, artifact))) throw new CanaryOutputOwnershipError();
  }
  const realDirectory = fs.realpathSync.native(directory);
  const lockDir = path.join(realDirectory, LOCK_NAME);
  // mkdir without recursive is the exclusive operation. Never take over a pre-existing lock.
  fs.mkdirSync(lockDir);
  const token = crypto.randomBytes(32).toString("hex");
  const metadata = { token, pid: process.pid, startedAt: new Date().toISOString() };
  const ownerFile = path.join(lockDir, OWNER_NAME);
  const heartbeatFile = path.join(lockDir, HEARTBEAT_NAME);
  fs.writeFileSync(ownerFile, JSON.stringify(metadata) + "\n", { flag: "wx" });
  const original = fs.lstatSync(lockDir);
  let lost = false;
  let released = false;

  function matches() {
    try {
      noSymlinkComponents(directory);
      if (fs.realpathSync.native(directory) !== realDirectory) return false;
      if (![filename, "history.json", "runs.jsonl"].every((file) => regularOrAbsent(path.join(directory, file)))) return false;
      const stat = fs.lstatSync(lockDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== original.dev || stat.ino !== original.ino) return false;
      const ownerStat = fs.lstatSync(ownerFile);
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 256) return false;
      const saved = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      return saved.token === token && saved.pid === metadata.pid && saved.startedAt === metadata.startedAt;
    } catch (_) { return false; }
  }

  function check() {
    if (released || lost || !matches()) { lost = true; throw new CanaryOutputOwnershipError(); }
    try {
      if (fs.existsSync(heartbeatFile) && (fs.lstatSync(heartbeatFile).isSymbolicLink() ||
          !fs.lstatSync(heartbeatFile).isFile())) throw new CanaryOutputOwnershipError();
      fs.writeFileSync(heartbeatFile, new Date().toISOString() + "\n");
    } catch (_) { lost = true; throw new CanaryOutputOwnershipError(); }
    if (!matches()) { lost = true; throw new CanaryOutputOwnershipError(); }
  }

  function release() {
    if (released || lost || !matches()) return false;
    try {
      for (const file of [heartbeatFile, ownerFile]) {
        if (fs.existsSync(file)) {
          if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) return false;
          fs.unlinkSync(file);
        }
      }
      fs.rmdirSync(lockDir);
      released = true;
      return true;
    } catch (_) { return false; } // Never force-remove an unknown/replaced lock.
  }

  const owner = Object.freeze({ check, release, lockDir });
  issuedOwners.set(owner, exactOutPath);
  return owner;
}

function assertCanaryOutputOwner(owner, outPath) {
  if (!owner || issuedOwners.get(owner) !== path.resolve(outPath)) throw new CanaryOutputOwnershipError();
  owner.check();
}

module.exports = { acquireCanaryOutputOwner, assertCanaryOutputOwner, CanaryOutputOwnershipError, LOCK_NAME };
