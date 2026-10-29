"use strict";

// Only wallet-balances.json is protected here, not the monitor directory or any
// financial wallet. A crashed/undrained writer requires attended lock recovery.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LOCK_NAME = ".wallet-balances-writer.lock";
const issuedOwners = new WeakMap();

class WalletBalanceOutputError extends Error {
  constructor(code = "OUTPUT_OWNERSHIP_LOST") {
    super(code);
    this.name = "WalletBalanceOutputError";
    this.code = code;
  }
}

function noSymlinks(target) {
  const resolved = path.resolve(target);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new WalletBalanceOutputError();
  }
}

function regularOrAbsent(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) { return error.code === "ENOENT"; }
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function acquireWalletBalanceOutputOwner(outPath) {
  const exactOutPath = path.resolve(outPath);
  const directory = path.dirname(exactOutPath);
  if (path.basename(outPath) === LOCK_NAME) throw new WalletBalanceOutputError();
  noSymlinks(directory);
  fs.mkdirSync(directory, { recursive: true });
  noSymlinks(directory);
  if (!regularOrAbsent(exactOutPath)) throw new WalletBalanceOutputError();
  const realDirectory = fs.realpathSync.native(directory);
  const directoryStat = fs.lstatSync(directory);
  const lockDir = path.join(directory, LOCK_NAME);
  try { fs.mkdirSync(lockDir); }
  catch (error) {
    if (error.code === "EEXIST") throw new WalletBalanceOutputError("OUTPUT_BUSY");
    throw new WalletBalanceOutputError("OUTPUT_LOCK_FAILED");
  }
  const original = fs.lstatSync(lockDir);
  const ownerFile = path.join(lockDir, "owner.json");
  const metadata = { token: crypto.randomBytes(32).toString("hex"), pid: process.pid, startedAt: new Date().toISOString() };
  // Initialization failure deliberately leaves an unclaimed lock, never takes over.
  fs.writeFileSync(ownerFile, JSON.stringify(metadata) + "\n", { flag: "wx" });
  const ownerStat = fs.lstatSync(ownerFile);
  let released = false;
  let lost = false;

  function matches() {
    try {
      noSymlinks(directory);
      if (fs.realpathSync.native(directory) !== realDirectory || !sameIdentity(fs.lstatSync(directory), directoryStat)) return false;
      if (!regularOrAbsent(exactOutPath)) return false;
      const stat = fs.lstatSync(lockDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, original)) return false;
      const savedStat = fs.lstatSync(ownerFile);
      if (!savedStat.isFile() || savedStat.isSymbolicLink() || savedStat.size > 512 || !sameIdentity(savedStat, ownerStat)) return false;
      const saved = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      return saved.token === metadata.token && saved.pid === metadata.pid && saved.startedAt === metadata.startedAt;
    } catch (_) { return false; }
  }

  function check() {
    if (released || lost || !matches()) { lost = true; throw new WalletBalanceOutputError(); }
  }

  function release() {
    if (released || lost || !matches()) return false;
    try {
      fs.unlinkSync(ownerFile);
      fs.rmdirSync(lockDir);
      released = true;
      return true;
    } catch (_) { return false; }
  }

  const owner = Object.freeze({ check, release, lockDir });
  issuedOwners.set(owner, exactOutPath);
  return owner;
}

function assertWalletBalanceOutputOwner(owner, outPath) {
  if (!owner || issuedOwners.get(owner) !== path.resolve(outPath)) throw new WalletBalanceOutputError();
  owner.check();
}

module.exports = { LOCK_NAME, WalletBalanceOutputError, acquireWalletBalanceOutputOwner, assertWalletBalanceOutputOwner };
