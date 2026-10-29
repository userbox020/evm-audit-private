"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { test } = require("node:test");
const watch = require("../aave-v3-borrower-watch.js");

const CHAIN_IDS = [1, 42161, 10, 137];
const SEEDS = path.resolve(__dirname, "../../bounded-research/2026-10-17-aave-v3-borrower-seed");

function blockNetwork(t) {
  let attempts = 0;
  const blocked = () => { attempts++; throw new Error("NETWORK_FORBIDDEN"); };
  t.mock.method(net.Socket.prototype, "connect", blocked);
  t.mock.method(globalThis, "fetch", blocked);
  t.after(() => assert.equal(attempts, 0, "no real network or unmocked fetch attempts"));
}

function fourChainFixture() {
  return watch.fixtureSetup({ rows: watch.allFourChainsList().map((row) => ({
    chainId: row.chainId, userNumber: BigInt(row.user), hf: "2000000000000000000",
  })) });
}

// Exercise the producer's transport branch, but replace fetch before it can do any I/O.
// The producer calls this branch "live"; every response below is synthetic and socket I/O is blocked.
function mockRoutes(t, setup, failure = null) {
  const rpcUrls = Object.fromEntries(CHAIN_IDS.map((id) => [id, ["https:", "", `offline-chain-${id}.invalid`, ""].join("/")]));
  const routes = new Map(CHAIN_IDS.map((id) => [rpcUrls[id], id]));
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const chainId = routes.get(String(url));
    assert.ok(chainId, "only configured mock routes are allowed");
    const request = JSON.parse(options.body);
    calls.push({ chainId, method: request.method });
    assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_call"].includes(request.method));
    if (failure === "unavailable" && chainId === 42161 && request.method === "eth_call") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "MOCK_UNAVAILABLE" } }));
    }
    const result = failure === "wrong-chain" && chainId === 10 && request.method === "eth_chainId"
      ? "0x1" : await setup.sendByChain[chainId](request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  return { rpcUrls, calls };
}

test("four-chain seed loading preserves exact identities and explicit projections", (t) => {
  blockNetwork(t);
  const list = watch.allFourChainsList();
  assert.equal(list.length, 83);
  assert.deepEqual(Object.fromEntries(CHAIN_IDS.map((id) => [id, list.filter((r) => r.chainId === id).length])),
    { 1: 27, 42161: 2, 10: 27, 137: 27 });
  for (const [chainId, name] of [[1, "ethereum"], [42161, "arbitrum"], [10, "optimism"], [137, "polygon"]]) {
    const seed = JSON.parse(fs.readFileSync(path.join(SEEDS, `seed-${name}.json`)));
    const expected = watch.validateList(seed.borrower_market_pairs.map((r) => ({ chainId, market: r.market_address, user: r.borrower })));
    const actual = list.filter((r) => r.chainId === chainId);
    if (chainId === 1) {
      assert.deepEqual(actual.slice(0, 25), expected);
      assert.deepEqual(actual.slice(25).map((r) => r.user), list.filter((r) => r.chainId === 42161).map((r) => r.user));
    } else assert.deepEqual(actual, expected);
  }
});

for (const mutation of ["wrong-chain", "wrong-base-unit", "wrong-pool", "missing-row"]) {
  test(`four-chain seed loading rejects ${mutation}`, (t) => {
    blockNetwork(t);
    const file = path.join(SEEDS, "seed-optimism.json");
    const originalRead = fs.readFileSync;
    const seed = JSON.parse(originalRead(file));
    if (mutation === "wrong-chain") seed.chain_id = 1;
    if (mutation === "wrong-base-unit") seed.oracle_base_currency_unit = "1";
    if (mutation === "wrong-pool") seed.borrower_market_pairs[0].market_address = "0x0000000000000000000000000000000000000001";
    if (mutation === "missing-row") seed.borrower_market_pairs.pop();
    t.mock.method(fs, "readFileSync", (target, ...args) =>
      path.resolve(String(target)) === file ? JSON.stringify(seed) : originalRead(target, ...args));
    assert.throws(() => watch.allFourChainsList(), /INVALID_ARGUMENTS/);
  });
}

test("four-chain mock endpoint routing keeps independent pins and all 83 rows", async (t) => {
  blockNetwork(t);
  const setup = fourChainFixture();
  const { rpcUrls, calls } = mockRoutes(t, setup);
  const value = await watch.capture({ watchList: setup.watchList, mode: "live", rpcUrls });
  assert.equal(value.status, "COMPLETE");
  assert.equal(value.crossSectionSummary.completeCount, 83);
  assert.equal(value.diagnostics.rpcCount, 16); // Logical mock requests, not network traffic.
  assert.equal(new Set(Object.values(value.pins).map((p) => p.hash)).size, 4);
  for (const chainId of CHAIN_IDS) {
    assert.deepEqual(calls.filter((r) => r.chainId === chainId).map((r) => r.method),
      ["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getBlockByNumber"]);
    assert.ok(value.pins[chainId].valid && value.pins[chainId].rechecked && value.pins[chainId].chainIdVerified);
  }
  assert.equal(value.safety.signing, false);
  assert.equal(value.safety.submission, false);
  assert.equal(value.safety.simulation, false);
  assert.equal(value.safety.forkExecution, false);
  assert.doesNotMatch(JSON.stringify(value), /https?:\/\/|offline-chain-/);
});

for (const failure of ["wrong-chain", "unavailable"]) {
  test(`four-chain mock endpoint ${failure} invalidates only the affected chain`, async (t) => {
    blockNetwork(t);
    const setup = fourChainFixture();
    const { rpcUrls, calls } = mockRoutes(t, setup, failure);
    const value = await watch.capture({ watchList: setup.watchList, mode: "live", rpcUrls });
    const failedChain = failure === "wrong-chain" ? 10 : 42161;
    assert.equal(value.status, "INCOMPLETE");
    assert.equal(value.pins[failedChain].valid, false);
    for (const row of value.borrowers) {
      assert.equal(row.status, row.chainId === failedChain ? "INCOMPLETE" : "COMPLETE");
      assert.equal(row.reason, row.chainId !== failedChain ? null : failure === "wrong-chain" ? "CHAIN_MISMATCH" : "RPC_SHAPE_INVALID");
    }
    if (failure === "wrong-chain") assert.equal(calls.filter((r) => r.chainId === failedChain).length, 1);
    assert.equal(value.diagnostics.retries, 0);
    assert.doesNotMatch(JSON.stringify(value), /https?:\/\/|offline-chain-/);
  });
}

test("missing offline chain route never falls back to a real endpoint", async (t) => {
  blockNetwork(t);
  const setup = fourChainFixture();
  delete setup.sendByChain[137];
  const value = await watch.capture({ watchList: setup.watchList, sendByChain: setup.sendByChain });
  assert.equal(value.status, "INCOMPLETE");
  assert.equal(value.diagnostics.networkRequestCount, 0);
  assert.equal(value.diagnostics.rpcCount, 12);
  assert.ok(value.borrowers.filter((r) => r.chainId === 137).every((r) => r.reason === "READ_FAILED"));
  assert.ok(value.borrowers.filter((r) => r.chainId !== 137).every((r) => r.status === "COMPLETE"));
});
