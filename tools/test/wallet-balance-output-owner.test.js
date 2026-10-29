"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LOCK_NAME, acquireWalletBalanceOutputOwner, assertWalletBalanceOutputOwner } = require("../lib/wallet-balance-output-owner");
const collector = require("../watch-wallet-balances");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-owner-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outPath = path.join(directory, "wallet-balances.json");
  fs.writeFileSync(outPath, "prior snapshot\n");
  return { directory, outPath };
}

function options(outPath) {
  return {
    outPath, watchlist: { schema: "watch-addresses/v1", addresses: [{ address: `0x${"11".repeat(20)}` }] },
    chainEndpoints: new Map([[1, "synthetic"]]), stablecoins: {}, nativePrices: {},
    call: async (_url, method) => method === "eth_blockNumber" ? "0x10" : "0x1",
  };
}

test("competing owner is busy; exact owner alone can publish and release", t => {
  const { outPath, directory } = fixture(t);
  const owner = acquireWalletBalanceOutputOwner(outPath);
  assert.throws(() => acquireWalletBalanceOutputOwner(outPath), { code: "OUTPUT_BUSY" });
  assert.throws(() => collector.writeArtifact({}, outPath), { code: "OUTPUT_OWNERSHIP_LOST" });
  assert.throws(() => assertWalletBalanceOutputOwner({ check() {} }, outPath), { code: "OUTPUT_OWNERSHIP_LOST" });
  assert.throws(() => assertWalletBalanceOutputOwner(owner, path.join(directory, "other.json")), { code: "OUTPUT_OWNERSHIP_LOST" });
  collector.writeArtifact({ schema: "synthetic" }, outPath, fs, owner);
  assert.equal(JSON.parse(fs.readFileSync(outPath)).schema, "synthetic");
  assert.equal(owner.release(), true);
  assert.equal(owner.release(), false);
  const second = acquireWalletBalanceOutputOwner(outPath);
  assert.equal(second.release(), true);
});

test("foreign lock replacement prevents publish and is never removed", t => {
  const { outPath, directory } = fixture(t);
  const owner = acquireWalletBalanceOutputOwner(outPath);
  fs.renameSync(owner.lockDir, path.join(directory, "prior-owner"));
  const foreign = acquireWalletBalanceOutputOwner(outPath);
  assert.throws(() => collector.writeArtifact({}, outPath, fs, owner), { code: "OUTPUT_OWNERSHIP_LOST" });
  assert.equal(owner.release(), false);
  foreign.check();
  assert.equal(fs.readFileSync(outPath, "utf8"), "prior snapshot\n");
  assert.equal(foreign.release(), true);
});

test("owner metadata replacement is not same-owner cleanup", t => {
  const { outPath } = fixture(t);
  const owner = acquireWalletBalanceOutputOwner(outPath);
  const file = path.join(owner.lockDir, "owner.json");
  const metadata = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...metadata, token: "foreign" }));
  assert.equal(owner.release(), false);
  assert.throws(() => owner.check(), { code: "OUTPUT_OWNERSHIP_LOST" });
  assert.equal(JSON.parse(fs.readFileSync(file)).token, "foreign");
});

test("replacement output directory fails identity even if original lock is moved into it", t => {
  const { directory } = fixture(t);
  const monitor = path.join(directory, "monitor");
  const outPath = path.join(monitor, "wallet-balances.json");
  const owner = acquireWalletBalanceOutputOwner(outPath);
  const moved = path.join(directory, "old-monitor");
  fs.renameSync(monitor, moved);
  fs.mkdirSync(monitor);
  fs.renameSync(path.join(moved, LOCK_NAME), path.join(monitor, LOCK_NAME));
  assert.throws(() => owner.check(), { code: "OUTPUT_OWNERSHIP_LOST" });
  assert.equal(owner.release(), false);
  assert.equal(fs.existsSync(path.join(monitor, LOCK_NAME, "owner.json")), true);
});

test("ownership is rechecked immediately before atomic publication", t => {
  const { outPath } = fixture(t);
  const owner = acquireWalletBalanceOutputOwner(outPath);
  const fsImpl = { ...fs, writeFileSync(...args) {
    fs.writeFileSync(...args);
    fs.writeFileSync(path.join(owner.lockDir, "owner.json"), "{}");
  } };
  assert.throws(() => collector.writeArtifact({ replacement: true }, outPath, fsImpl, owner), { code: "OUTPUT_OWNERSHIP_LOST" });
  assert.equal(fs.readFileSync(outPath, "utf8"), "prior snapshot\n");
  assert.equal(owner.release(), false);
});

test("collection holds output ownership before reads until publication", async t => {
  const { outPath, directory } = fixture(t);
  let reads = 0;
  const result = await collector.collectAndWrite({ ...options(outPath), call: async (_url, method) => {
    reads += 1;
    assert.throws(() => acquireWalletBalanceOutputOwner(outPath), { code: "OUTPUT_BUSY" });
    assert.equal(fs.readFileSync(outPath, "utf8"), "prior snapshot\n");
    return method === "eth_blockNumber" ? "0x10" : "0x1";
  } });
  assert.equal(reads, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(outPath)), result.artifact);
  assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), false);
});

test("busy collector does not read watchlist, inventory, or modify artifact", async t => {
  const { outPath } = fixture(t);
  const owner = acquireWalletBalanceOutputOwner(outPath);
  await assert.rejects(collector.collectAndWrite({ outPath, fsImpl: { readFileSync() { assert.fail("unexpected read"); } } }), { code: "OUTPUT_BUSY" });
  assert.equal(fs.readFileSync(outPath, "utf8"), "prior snapshot\n");
  assert.equal(owner.release(), true);
});

test("timeout aborts and drains transport before releasing output lock", async t => {
  const { outPath, directory } = fixture(t);
  let aborted = false;
  let drained = false;
  await assert.rejects(collector.collectAndWrite({
    ...options(outPath), deadlineMs: 25,
    call: (_url, _method, _params, timeoutMs, { signal }) => new Promise(resolve => {
      assert.ok(timeoutMs > 0 && timeoutMs <= 25);
      signal.addEventListener("abort", () => {
        aborted = true;
        setTimeout(() => {
          assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), true);
          drained = true;
          resolve(null);
        }, 5);
      }, { once: true });
    }),
  }), { code: "TIMEOUT" });
  assert.equal(aborted, true);
  assert.equal(drained, true);
  assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), false);
  assert.equal(fs.readFileSync(outPath, "utf8"), "prior snapshot\n");
});

test("undrained work retains lock and cannot publish late", async t => {
  const { outPath, directory } = fixture(t);
  let finish;
  await assert.rejects(collector.collectAndWrite({
    ...options(outPath), deadlineMs: 25, drainGraceMs: 5,
    call: () => new Promise(resolve => { finish = resolve; }),
  }), { code: "DRAIN_UNCONFIRMED" });
  assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), true);
  assert.throws(() => acquireWalletBalanceOutputOwner(outPath), { code: "OUTPUT_BUSY" });
  finish("0x10");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.readFileSync(outPath, "utf8"), "prior snapshot\n");
  assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), true);
});

test("ordinary collection failure releases ownership without publication", async t => {
  const { outPath, directory } = fixture(t);
  await assert.rejects(collector.collectAndWrite({ ...options(outPath), nativePrices: undefined, priceFetcher: async () => { throw new Error("synthetic"); } }));
  assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), false);
  assert.equal(fs.readFileSync(outPath, "utf8"), "prior snapshot\n");
});
