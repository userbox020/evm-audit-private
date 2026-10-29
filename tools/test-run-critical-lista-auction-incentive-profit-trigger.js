#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const producer = require("./run-critical-lista-auction-incentive-profit-trigger.js");

const BLOCK = 120000000;
const INTERACTION_CODE = "0x6000";
const CLIP_CODE = "0x6001";
const DISTINCT_ACTOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DISTINCT_ID = 987654321012345678n;
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const uint = (value) => `0x${word(value)}`;
const tuple = (values) => `0x${values.map(word).join("")}`;
const slot = (value) => `0x${"0".repeat(24)}${value.slice(2).toLowerCase()}`;
const list = (values) => tuple([32n, BigInt(values.length), ...values]);
const header = (hashByte = "ab", stateByte = "cd") => ({
  number: ethers.toQuantity(BLOCK), hash: `0x${hashByte.repeat(32)}`,
  stateRoot: `0x${stateByte.repeat(32)}`, timestamp: ethers.toQuantity(1800000000)
});

function fixture(overrides = {}) {
  return {
    chainId: "0x38", finalized: header(), numeric: header(), interactionImplementation: producer.BASELINE.interactionImplementation,
    clipImplementation: producer.BASELINE.clipImplementation, interactionCode: INTERACTION_CODE, clipCode: CLIP_CODE,
    auctionWhitelistMode: 0n, stopped: 0n, tip: 5n * 10n ** 45n, chip: 0n, chost: 10n,
    peekValue: 100n * 10n ** 18n, peekValid: true, par: 10n ** 27n, active: [], statuses: {},
    ...overrides
  };
}
function activeFixture(status, overrides = {}) {
  return fixture({ active: [DISTINCT_ID], statuses: { [DISTINCT_ID.toString()]: status }, ...overrides });
}
function pairs(a = fixture(), b = fixture()) {
  return { "https://family-a.invalid/secret-token": a, "https://family-b.example/secret-token": b };
}

class FixtureRpc {
  constructor(rows) { this.rows = rows; this.calls = []; }
  async call(url, method, params) {
    this.calls.push({ url, method });
    const row = this.rows[url];
    if (!row) throw new Error("UNKNOWN_ENDPOINT");
    if (row.throwAlways) throw new Error("BOUNDED_FAILURE");
    if (method === "eth_chainId") return row.chainId;
    if (method === "eth_getBlockByNumber") return params[0] === "finalized" ? row.finalized : row.numeric;
    if (method === "eth_getStorageAt") return slot(params[0].toLowerCase() === producer.ADDRESSES.interaction ? row.interactionImplementation : row.clipImplementation);
    if (method === "eth_getCode") return params[0].toLowerCase() === row.interactionImplementation.toLowerCase() ? row.interactionCode : row.clipCode;
    if (method === "eth_call") return this.ethCall(row, params[0]);
    throw new Error(`UNEXPECTED_METHOD_${method}`);
  }
  ethCall(row, call) {
    const selector = call.data.slice(0, 10);
    if (selector === producer.ABI.auctionWhitelistMode) return uint(row.auctionWhitelistMode);
    if (selector === producer.ABI.count) return uint(row.active.length);
    if (selector === producer.ABI.stopped) return uint(row.stopped);
    if (selector === producer.ABI.tip) return uint(row.tip);
    if (selector === producer.ABI.chip) return uint(row.chip);
    if (selector === producer.ABI.chost) return uint(row.chost);
    if (selector === producer.ABI.peek) return tuple([row.peekValue, row.peekValid ? 1n : 0n]);
    if (selector === producer.ABI.par) return uint(row.par);
    if (selector === producer.ABI.list) return row.listRaw || list(row.active);
    if (selector === producer.ABI.getStatus) {
      const id = BigInt(`0x${call.data.slice(-64)}`).toString();
      const status = row.statuses[id];
      return row.statusRaw || tuple([status.needsRedo ? 1n : 0n, status.price || 1n, status.lot, status.tab]);
    }
    throw new Error(`UNEXPECTED_SELECTOR_${selector}`);
  }
}

test.before(() => {
  const prior = require("../reports/raw/fast/critical-lista-v52-mbtc-auction-incentive-step2-passa.json");
  assert.equal(prior.chain.contracts.find((row) => row.address === producer.BASELINE.clipImplementation).runtime.keccak256, producer.BASELINE.clipImplementationRuntimeHash);
});
async function runCase(rows, candidateUrls = Object.keys(rows), baseline = null) {
  const rpc = new FixtureRpc(rows);
  const artifact = await producer.runTrigger({
    candidateUrls, rpcCall: rpc.call.bind(rpc), now: () => 1800000000000,
    baseline: baseline || { ...producer.BASELINE, clipImplementationRuntimeHash: ethers.keccak256(CLIP_CODE) }
  });
  assert.equal(producer.validateArtifact(artifact), true);
  assert.equal(artifact.safety.networkCalls, rpc.calls.length);
  assert.ok(rpc.calls.length <= producer.MAX_NETWORK_CALLS);
  const serialized = JSON.stringify(artifact);
  assert.equal(/https?:\/\/|family-[ab]|secret-token|aaaaaaaa|987654321012345678|transactionHash|"(?:usr|user|actor|borrower|auctionId|ids)"/i.test(serialized), false);
  assert.equal(rpc.calls.some((entry) => /send|transaction|sign|fork|logs/i.test(entry.method)), false);
  assert.equal(artifact.safety.automaticRetries, 0);
  return { artifact, rpc };
}

test("prior-pin whitelist blocks before no-active-auction", async () => {
  const prior = fixture({ auctionWhitelistMode: 1n });
  const { artifact } = await runCase(pairs(prior, structuredClone(prior)));
  assert.equal(artifact.trigger.status, "BLOCKED_WHITELIST");
  assert.equal(artifact.controls.auctionWhitelistModeRaw, "1");
});

test("unchanged public runtime with no active auction is blocked", async () => {
  const { artifact } = await runCase(pairs());
  assert.equal(artifact.runtime.changedFromBaseline, false);
  assert.equal(artifact.trigger.status, "BLOCKED_NO_ACTIVE_AUCTION");
  assert.equal(artifact.auctions.scanComplete, true);
});

test("active auction that does not need redo is ineligible", async () => {
  const row = activeFixture({ needsRedo: false, lot: 1n, tab: 100n });
  const { artifact } = await runCase(pairs(row, structuredClone(row)));
  assert.equal(artifact.auctions.needsRedoCount, 0);
  assert.equal(artifact.trigger.status, "BLOCKED_NO_ELIGIBLE_REDO");
});

test("eligible redo with positive reward warrants a keyless fork", async () => {
  const row = activeFixture({ needsRedo: true, lot: 1n, tab: 100n });
  const { artifact } = await runCase(pairs(row, structuredClone(row)));
  assert.equal(artifact.trigger.status, "POSITIVE_GROSS_FORK_WARRANTED");
  assert.equal(artifact.trigger.positive, true);
  assert.equal(artifact.economics.maximumGrossRewardRad, (5n * 10n ** 45n).toString());
  assert.equal(artifact.economics.maximumGrossRewardLisUSDRaw, (5n * 10n ** 18n).toString());
  assert.equal(artifact.economics.conservativeNetRaw, null);
  assert.equal(artifact.gates.keylessForkJustified, "PASS");
});

test("chost requires both tab and lot-times-feed coverage", async (t) => {
  await t.test("tab below chost", async () => {
    const row = activeFixture({ needsRedo: true, lot: 1n, tab: 9n });
    const { artifact } = await runCase(pairs(row, structuredClone(row)));
    assert.equal(artifact.trigger.status, "BLOCKED_NO_ELIGIBLE_REDO");
  });
  await t.test("lot times feed below chost", async () => {
    const row = activeFixture({ needsRedo: true, lot: 0n, tab: 100n });
    const { artifact } = await runCase(pairs(row, structuredClone(row)));
    assert.equal(artifact.trigger.status, "BLOCKED_NO_ELIGIBLE_REDO");
  });
});

test("stopped level two blocks otherwise eligible redo", async () => {
  const row = activeFixture({ needsRedo: true, lot: 1n, tab: 100n }, { stopped: 2n });
  const { artifact } = await runCase(pairs(row, structuredClone(row)));
  assert.equal(artifact.trigger.status, "BLOCKED_STOPPED");
});

test("runtime drift takes precedence over whitelist and stopped", async () => {
  const row = fixture({ auctionWhitelistMode: 1n, stopped: 3n, clipImplementation: "0x1111111111111111111111111111111111111111" });
  const { artifact } = await runCase(pairs(row, structuredClone(row)));
  assert.equal(artifact.runtime.changedFromBaseline, true);
  assert.equal(artifact.trigger.status, "RUNTIME_DRIFT_REVIEW");
});

test("more than 32 active auctions is blocked before list enumeration", async () => {
  const row = fixture({ active: Array.from({ length: 33 }, (_, index) => BigInt(index + 1)) });
  const { artifact, rpc } = await runCase(pairs(row, structuredClone(row)));
  assert.equal(artifact.trigger.status, "BLOCKED_SCAN_CAP");
  assert.equal(artifact.auctions.scanComplete, false);
  assert.equal(rpc.calls.filter((entry) => entry.method === "eth_call").length, 16);
});

test("header and state disagreement fail closed", async (t) => {
  await t.test("same provider family is not independent", async () => {
    const rows = {
      "https://a.same-provider.com/secret-token": fixture(),
      "https://b.same-provider.com/secret-token": fixture()
    };
    const { artifact } = await runCase(rows);
    assert.equal(artifact.trigger.status, "INCOMPLETE");
    assert.equal(artifact.pin.headerFamilies, 0);
  });
  await t.test("header hash disagreement", async () => {
    const { artifact } = await runCase(pairs(fixture({ numeric: header("aa") }), fixture({ numeric: header("bb") })));
    assert.equal(artifact.trigger.status, "INCOMPLETE");
    assert.equal(artifact.pin.headerFamilies, 0);
  });
  await t.test("state disagreement", async () => {
    const { artifact } = await runCase(pairs(fixture(), fixture({ tip: 7n })));
    assert.equal(artifact.trigger.status, "INCOMPLETE");
    assert.equal(artifact.pin.headerFamilies, 2);
    assert.equal(artifact.pin.stateFamilies, 1);
  });
});

test("arithmetic and strict decoding cover boundaries", () => {
  assert.equal(producer.reward(101n, 5n, 10n ** 18n), 106n);
  assert.equal(producer.feedPrice(2n, 10n ** 27n), 2n * 10n ** 9n);
  assert.deepEqual(producer.decodeStatus(tuple([1n, 2n, 3n, 4n])), { needsRedo: true, price: "2", lot: "3", tab: "4" });
  assert.deepEqual(producer.decodeList(list([4n, 9n])), [4n, 9n]);
  assert.throws(() => producer.decodeStatus(tuple([2n, 0n, 0n, 0n])), /ABI_BOOL_INVALID/);
  assert.throws(() => producer.decodeList(`${list([1n])}00`), /ABI_LIST_LENGTH_INVALID/);
});

test("duplicate ids and malformed status decoding fail closed", async (t) => {
  await t.test("duplicate list", async () => {
    const row = fixture({ active: [1n, 1n] });
    const { artifact } = await runCase(pairs(row, structuredClone(row)));
    assert.equal(artifact.trigger.status, "INCOMPLETE");
  });
  await t.test("malformed bool", async () => {
    const row = activeFixture({ needsRedo: true, lot: 1n, tab: 100n }, { statusRaw: tuple([2n, 1n, 1n, 100n]) });
    const { artifact } = await runCase(pairs(row, structuredClone(row)));
    assert.equal(artifact.trigger.status, "INCOMPLETE");
  });
});

test("candidate cap, zero retries, and endpoint actor/id leak controls hold", async () => {
  const rows = {}, candidates = [];
  for (let index = 0; index < 6; index += 1) {
    const url = `https://wrong-${index}.invalid/secret-token`;
    rows[url] = fixture({ chainId: "0x1", throwAlways: index === 0 }); candidates.push(url);
  }
  const good = activeFixture({ needsRedo: true, lot: 1n, tab: 100n });
  const goodA = "https://family-a.invalid/secret-token", goodB = "https://family-b.example/secret-token";
  rows[goodA] = good; rows[goodB] = structuredClone(good); candidates.push(goodA, goodB);
  const { artifact, rpc } = await runCase(rows, candidates);
  assert.equal(artifact.trigger.status, "POSITIVE_GROSS_FORK_WARRANTED");
  assert.ok(rpc.calls.length <= producer.MAX_NETWORK_CALLS);
  assert.equal(rpc.calls.filter((entry) => entry.url.includes("wrong-0")).length, 1);
  assert.equal(artifact.safety.borrowerScanning, false);
  assert.equal(artifact.safety.auctionIdsPersisted, false);
  assert.equal(JSON.stringify(artifact).includes(DISTINCT_ACTOR.slice(2)), false);
  assert.equal(JSON.stringify(artifact).includes(DISTINCT_ID.toString()), false);
});

test("inventory selection accepts only bounded direct BSC-labeled HTTPS rows", () => {
  const text = [
    "Ethereum https://eth.invalid/x", "BSC testnet https://test.invalid/x", "BSC http://plain.invalid/x",
    "BSC https://one.com/x", "BSC https://two.net/x", "BSC https://one.com/x"
  ].join("\n");
  const rows = producer.parseInventoryText(text);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.startsWith("https://")), true);
});
