"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { classify, checkFile } = require("../sentinel-hypercore-nest-usdt0.js");

const NOW = 1790500000000;
const USDT = "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb";
const CORE_USDC = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24";
const NATIVE_USDC = "0xb88339cb7199b77e23dB6e890353e22632Ba630f";
const H = `0x${"e".repeat(64)}`;
const RAW = "100000000";

function fixture(direction = "CORE_BUY_NEST_SELL") {
  const snapshot = { schema: "hypercore-nest-usdt0/snapshot-v1",
    spotMeta: { tokens: [
      { index: 268, tokenId: "0x25faedc3f054130dbb4e4203aca63567", evmAddress: USDT,
        szDecimals: 2, weiDecimals: 8, evmExtraWeiDecimals: -2, verified: true },
      { index: 0, tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
        evmAddress: CORE_USDC, weiDecimals: 8, verified: true },
    ], pair: { index: 166, tokens: [268, 0] } },
    book: { coin: "@166", observedAtMs: NOW - 2000, receivedAtMs: NOW - 1000,
      bids: [{ priceRaw: "1000000", qtyLots: "100000" }],
      asks: [{ priceRaw: "1000000", qtyLots: "100000" }] },
    evm: { chainId: 999, block: 100, hash: H, timestampMs: NOW - 2500, finalized: true },
    pool: { address: "0x613bC619741354a6171692B04228C9640373e54b",
      factory: "0xF77Bd082c627aA54591cF2f2EaA811fd1AB3b1F3", codePresent: true,
      verified: true, block: 100, hash: H, token0: NATIVE_USDC, token1: USDT,
      token0Decimals: 6, token1Decimals: 6 },
    direction, sizeUsdcRaw: RAW,
    quote: { exactInput: true, feeIncluded: true, block: 100, hash: H,
      tokenIn: direction === "CORE_BUY_NEST_SELL" ? USDT : NATIVE_USDC,
      tokenOut: direction === "CORE_BUY_NEST_SELL" ? NATIVE_USDC : USDT,
      decimalsIn: 6, decimalsOut: 6, amountInRaw: RAW, amountOutRaw: "101000000" },
  };
  return snapshot;
}
const classifyNow = snapshot => classify(snapshot, { nowMs: NOW });
function blocked(result) {
  assert.equal(result.routePositive, "unknown");
  assert.equal(result.executableNow, "unknown");
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.signedActionJustified, false);
  assert.equal(result.probabilityPercent, null);
  assert.equal(result.conservativeNetUsdcRaw, null);
  assert.equal(Object.hasOwn(result, "modelLowerBoundUsdcRaw"), false);
}

test("official spot identities, native-USDC pool order and $100 size remain quote-only", () => {
  for (const direction of ["CORE_BUY_NEST_SELL", "NEST_BUY_CORE_SELL"]) {
    const result = classifyNow(fixture(direction));
    assert.equal(result.status, "QUOTED_DISCREPANCY_ONLY", JSON.stringify(result));
    assert.equal(result.quotedGrossUsdcRaw, "1000000");
    assert.match(result.blockers.join(" "), /DISTINCT/);
    blocked(result);
  }
});

test("without a current exact public Nest quote the sentinel is NOT_READY", () => {
  const s = fixture(); delete s.quote;
  const result = classifyNow(s);
  assert.equal(result.status, "NOT_READY");
  assert.deepEqual(result.blockers, ["NO_CURRENT_EXACT_PUBLIC_NEST_QUOTE"]);
  blocked(result);
});

test("changed pair/token full identities, wrong Core precision/wei conversion fail closed", () => {
  const variants = [
    s => { s.spotMeta.pair.tokens = [0, 268]; },
    s => { s.spotMeta.pair.index = 167; },
    s => { s.spotMeta.tokens[0].index = 267; },
    s => { s.spotMeta.tokens[0].tokenId = `0x25faedc3f054130d${"0".repeat(16)}`; },
    s => { s.spotMeta.tokens[0].evmAddress = `0x${"a".repeat(40)}`; },
    s => { s.spotMeta.tokens[1].tokenId = `0x${"f".repeat(32)}`; },
    s => { s.spotMeta.tokens[1].evmAddress = NATIVE_USDC; },
    s => { s.spotMeta.tokens[1].verified = false; },
    s => { s.spotMeta.tokens[0].szDecimals = 6; },
    s => { s.spotMeta.tokens[0].weiDecimals = 6; },
    s => { s.spotMeta.tokens[0].evmExtraWeiDecimals = 0; },
    s => { s.spotMeta.tokens[1].weiDecimals = 6; },
  ];
  for (const mutate of variants) {
    const s = fixture(); mutate(s);
    const result = classifyNow(s);
    assert.equal(result.status, "INCOMPLETE"); blocked(result);
  }
});

test("wrong pool binding, missing code/factory, and mixed quote/pool pins fail closed", () => {
  for (const mutate of [
    s => { s.pool.address = `0x${"a".repeat(40)}`; },
    s => { s.pool.factory = `0x${"a".repeat(40)}`; },
    s => { s.pool.token0 = CORE_USDC; },
    s => { s.pool.token0 = USDT; s.pool.token1 = NATIVE_USDC; },
    s => { s.pool.token1Decimals = 8; },
    s => { s.pool.codePresent = false; },
    s => { s.pool.verified = false; },
    s => { s.pool.block++; },
    s => { s.quote.hash = `0x${"f".repeat(64)}`; },
    s => { s.quote.block++; },
    s => { s.quote.feeIncluded = false; },
    s => { s.quote.exactInput = false; },
    s => { s.quote.tokenIn = CORE_USDC; },
  ]) { const s = fixture(); mutate(s); assert.equal(classifyNow(s).status, "INCOMPLETE"); }
});

test("book must bind @166, ordered 2-decimal lots, complete size and exact converted quote", () => {
  for (const mutate of [
    s => { s.book.coin = "@167"; },
    s => { s.book.asks[0].priceRaw = "NaN"; },
    s => { s.book.bids = []; },
    s => { s.book.asks.push({ priceRaw: "900000", qtyLots: "10" }); },
    s => { s.book.asks[0].qtyLots = "1.5"; },
    s => { s.book.asks[0].qtyLots = "1"; },
    s => { s.quote.amountInRaw = "99999999"; },
    s => { s.book.receivedAtMs = s.book.observedAtMs - 1; },
  ]) { const s = fixture(); mutate(s); assert.notEqual(classifyNow(s).status, "QUOTED_DISCREPANCY_ONLY"); }
});

test("forward lots cost actual spend, never fictional full budget or sub-lot USDT0", () => {
  const s = fixture();
  s.book.asks[0].priceRaw = "1000123"; // each 0.01 lot costs ceil(10001.23)=10002 USDC raw6
  s.quote.amountInRaw = "99980000"; // 9998 lots fit a $100 raw6 budget
  s.quote.amountOutRaw = "100010000";
  const r = classifyNow(s);
  assert.equal(r.status, "QUOTED_DISCREPANCY_ONLY");
  assert.equal(r.coreSpentUsdcRaw, "99999996");
  assert.equal(r.quotedGrossUsdcRaw, "10004");
  blocked(r);
  s.quote.amountInRaw = "99980001"; // fabricated 1 raw6 USDT0 sub-lot
  assert.equal(classifyNow(s).status, "INCOMPLETE");
});

test("reverse discards unsellable dust and refuses missing Core lot capacity", () => {
  const s = fixture("NEST_BUY_CORE_SELL");
  s.quote.amountOutRaw = "101000099"; // 99 raw6 token dust cannot be sold on Core
  const r = classifyNow(s);
  assert.equal(r.status, "QUOTED_DISCREPANCY_ONLY");
  assert.equal(r.quotedGrossUsdcRaw, "1000000"); blocked(r);
  s.quote.amountOutRaw = "9999";
  assert.equal(classifyNow(s).status, "NOT_READY");
  s.quote.amountOutRaw = "101000000";
  s.book.bids[0].qtyLots = "1";
  assert.equal(classifyNow(s).status, "NOT_READY");
});

test("stale/future book or EVM pin, large cross-surface skew, nonfinal pin reject", () => {
  for (const mutate of [
    s => { s.book.observedAtMs = NOW - 30001; },
    s => { s.book.observedAtMs = NOW + 1; s.book.receivedAtMs = NOW + 2; },
    s => { s.evm.timestampMs = NOW + 1; },
    s => { s.evm.timestampMs = NOW - 29000; },
    s => { s.evm.finalized = false; },
  ]) { const s = fixture(); mutate(s); assert.notEqual(classifyNow(s).status, "QUOTED_DISCREPANCY_ONLY"); }
});

test("fabricated public/finalized/zero-cost settlement flags cannot upgrade a quote", () => {
  const s = fixture("NEST_BUY_CORE_SELL");
  s.settlement = { coreToEvm: { verified: true, public: true, deliveredRaw: RAW },
    evmToCore: { verified: true, public: true, deliveredRaw: RAW },
    rebalance: { verified: true, public: true, deliveredRaw: RAW } };
  s.costs = { evmGasEntry: { bounded: true, amountUsdcRaw: "0" },
    evmGasExit: { bounded: true, amountUsdcRaw: "0" },
    financing: { bounded: true, amountUsdcRaw: "0" } };
  const result = classifyNow(s);
  assert.equal(result.status, "QUOTED_DISCREPANCY_ONLY");
  assert.equal(result.quotedGrossUsdcRaw, "1000000");
  blocked(result);
});

test("oversize and cyclic caller inputs fail closed without echo or side effects", () => {
  const huge = fixture(); huge.extra = "PRIVATE_ENDPOINT_MARKER".repeat(15000);
  const result = classifyNow(huge);
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(JSON.stringify(result).includes("PRIVATE_ENDPOINT_MARKER"), false);
  const cyclic = fixture(); cyclic.loop = cyclic;
  assert.equal(classifyNow(cyclic).status, "INCOMPLETE");
});

test("quoted gross zero/negative is NOT_READY independent of bogus zero costs", () => {
  for (const value of [RAW, "99999999"]) {
    const s = fixture(); s.quote.amountOutRaw = value;
    s.costs = { all: { bounded: true, amountUsdcRaw: "0" } };
    const result = classifyNow(s);
    assert.equal(result.status, "NOT_READY");
    assert.match(result.blockers.join(" "), /NONPOSITIVE_QUOTED_GROSS/);
    blocked(result);
  }
});

test("June historical negative directions cannot become profit even with artificial fresh pins", () => {
  const forward = fixture(); forward.quote.amountOutRaw = "99450400";
  const reverse = fixture("NEST_BUY_CORE_SELL"); reverse.quote.amountOutRaw = "99332700";
  for (const [s, gross] of [[forward, "-549600"], [reverse, "-670000"]]) {
    const result = classifyNow(s);
    assert.equal(result.status, "NOT_READY");
    assert.equal(result.quotedGrossUsdcRaw, gross);
    blocked(result);
  }
});

test("CLI accepts only --check absolute path and never echoes supplied file or argument", () => {
  assert.equal(checkFile("relative.json", NOW).status, "INCOMPLETE");
  const script = path.resolve(__dirname, "..", "sentinel-hypercore-nest-usdt0.js");
  for (const args of [[], ["--check", "relative.json"], ["--network"], ["--check", "PRIVATE_URL"]]) {
    const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout).status, "INCOMPLETE");
    assert.equal(run.stdout.includes("PRIVATE_URL"), false);
  }
});
