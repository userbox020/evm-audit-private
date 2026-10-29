#!/usr/bin/env node
"use strict";

// Existing ten regression cases plus a five-borrower mGLO fixture (no chain access).
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const single = require("./morpho-cbbtc-watch");
const { CBBTC, CORE, PRICE, IRM, FIXTURE_PARAMS, safeCode, safety, jsonBytes } = single.helpers;
const { captureMulti, validateList, parseArgs, makeTransport, persist, ENFORCEMENT, MARKETS, USDE_MARKET, MGLO_MARKET, MAX_REQUESTS } = require("./morpho-multi-watch");
const LIST = path.join(__dirname, "morpho-multi-watch.watch-list.json");
const FIXTURES = path.join(__dirname, "morpho-multi-watch.fixtures.json");
// Synthesized state, not a replay of the ora-13 observation.
const MGLO_FIXTURE = { debtRaw: 12479840560000n, collateralRaw: 14426357n * 10n ** 18n, price: 972453700000000000000000n,
  params: [FIXTURE_PARAMS[0], MARKETS[MGLO_MARKET].collateralToken, MARKETS[MGLO_MARKET].oracle, FIXTURE_PARAMS[3], 915000000000000000n] };
const fail = (code) => { throw new Error(code); };
function fixtureSend(fixtures, list, options = {}) {
  let headers = 0;
  return async (method, args) => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") {
      headers++;
      return { ...fixtures.block, number: args[0] === "finalized" ? fixtures.block.number : args[0], hash: options.drift && headers > 2 ? `0x${"22".repeat(32)}` : fixtures.block.hash };
    }
    assert.deepEqual(args[1], { blockHash: fixtures.block.hash, requireCanonical: true });
    const target = args[0].to, iface = target === single.MORPHO ? CORE : Object.values(MARKETS).some((row) => row.oracle === target) ? PRICE : IRM;
    const parsed = iface.parseTransaction({ data: args[0].data }), name = parsed.name;
    const usde = name === "price" ? target === MARKETS[USDE_MARKET].oracle : name === "borrowRateView" ? parsed.args[0][1].toLowerCase() === MARKETS[USDE_MARKET].collateralToken : parsed.args[0] === USDE_MARKET;
    const mglo = name === "price" ? target === MARKETS[MGLO_MARKET].oracle : name === "borrowRateView" ? parsed.args[0][1].toLowerCase() === MARKETS[MGLO_MARKET].collateralToken : parsed.args[0] === MGLO_MARKET;
    if (options.failUsde && usde && name === "price") fail("RPC_FAILURE");
    const assets = (mglo ? 20000000n : 1000000n) * 10n ** 6n, shares = assets * 1000000n;
    let position = [0n, 0n, 0n];
    if (name === "position") {
      const index = list.findIndex((row) => row.marketId === parsed.args[0] && row.borrower === parsed.args[1].toLowerCase());
      assert.ok(index >= 0);
      position = [0n, mglo ? MGLO_FIXTURE.debtRaw * 1000000n : BigInt(fixtures.debtUsdc[index]) * 10n ** 12n,
        mglo ? MGLO_FIXTURE.collateralRaw : usde ? 100000n * 10n ** 18n : 100000000n];
    }
    const values = { idToMarketParams: mglo ? MGLO_FIXTURE.params : usde ? fixtures.usdeParams : FIXTURE_PARAMS, position,
      market: [assets * 2n, shares * 2n, assets, shares, BigInt(fixtures.block.timestamp) - 3600n, 0n],
      price: [mglo ? MGLO_FIXTURE.price : usde ? 10n ** 24n : 100000n * 10n ** 34n], borrowRateView: [1000000000n] };
    return iface.encodeFunctionResult(name, values[name]);
  };
}
async function offlineTest() {
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES)), configuredList = validateList(JSON.parse(fs.readFileSync(LIST))), list = configuredList.slice(0, 4), cases = [];
  const previous = globalThis.fetch; globalThis.fetch = () => fail("METHOD_REJECTED");
  const test = async (id, fn) => { try { await fn(); cases.push({ id, passed: true }); } catch (_) { cases.push({ id, passed: false }); } };
  const run = (options = {}, selected = list) => captureMulti({ transport: makeTransport(fixtureSend(fixtures, selected, options), "dry-run"), watchList: selected, fixtureId: "multi-synthetic" });
  let capture;
  try {
    await test("four-pairs-one-pin-shared-reads", async () => {
      capture = await run(); assert.equal(capture.status, "COMPLETE"); assert.equal(capture.entries.length, 4);
      assert.equal(capture.diagnostics.requestCount, 18); assert.equal(capture.diagnostics.rpcCount, 0);
      assert.ok(capture.entries.every((row) => row.pin.valid && row.pin.hash === fixtures.block.hash));
      assert.equal(capture.entries[0].metrics.collateralCbBTC, "1.00000000");
      assert.equal(capture.entries[1].metrics.collateralAmount, "100000.000000000000000000");
      assert.equal(capture.entries[1].metrics.priceUsdcPerCollateral, "1.000000000000000000000000");
    });
    await test("consumer-summary-and-exact-threshold", () => {
      const value = JSON.parse(jsonBytes(capture)), s = value.crossPairSummary;
      assert.equal(s.captured, 4); assert.equal(s.incomplete, 0); assert.equal(s.closestToLiquidation.borrower, list[1].borrower);
      for (let i = 0; i < 4; i++) {
        const row = s.pairs[i], m = value.entries[i].metrics, price = BigInt(row.thresholdOraclePriceRaw), c = BigInt(m.collateralRaw), lltv = BigInt(m.lltvWad), debt = BigInt(m.debtRawUsdc);
        const max = (p) => (c * p / 10n ** 36n) * lltv / 10n ** 18n;
        assert.ok(max(price) >= debt); assert.ok(max(price - 1n) < debt); assert.equal(row.hf, m.hf);
      }
    });
    await test("historical-four-pair-pin-within-budget", async () => {
      const block = `0x${(BigInt(fixtures.block.number) - 1n).toString(16)}`;
      const value = await captureMulti({ transport: makeTransport(fixtureSend(fixtures, list), "dry-run"), watchList: list, block, fixtureId: "multi-synthetic" });
      assert.equal(value.status, "COMPLETE"); assert.equal(value.pin.number, Number(BigInt(block)));
      assert.equal(value.diagnostics.requestCount, 19);
      const current = await captureMulti({ transport: makeTransport(fixtureSend(fixtures, list), "dry-run"), watchList: list, block: fixtures.block.number });
      assert.equal(current.status, "COMPLETE"); assert.equal(current.diagnostics.requestCount, 18);
    });
    await test("single-default-preserves-legacy-fields", async () => {
      const value = await run({}, list.slice(0, 1)); assert.equal(value.status, "COMPLETE");
      assert.equal(value.entries[0].schema, single.SCHEMA); assert.equal(value.entries[0].kind, "LiveWatch");
      assert.equal(value.entries[0].identity.borrower, single.BORROWER); assert.ok("priceUsdcPerCbBTC" in value.entries[0].metrics);
      assert.equal(parseArgs(["--default-cbbtc"]).watchList.length, 1);
    });
    await test("partial-failure-never-zero-health", async () => {
      const value = await run({ failUsde: true }); assert.equal(value.status, "INCOMPLETE"); assert.equal(value.pin.valid, false);
      assert.equal(value.crossPairSummary.captured, 1); assert.equal(value.crossPairSummary.incomplete, 3);
      assert.ok(value.crossPairSummary.pairs.slice(1).every((row) => row.hf === null && row.thresholdOraclePriceRaw === null));
    });
    await test("drift-invalidates-every-pair", async () => {
      const value = await run({ drift: true }); assert.equal(value.reason, "PIN_DRIFT");
      assert.equal(value.crossPairSummary.captured, 0); assert.equal(value.crossPairSummary.closestToLiquidation, null);
    });
    await test("list-validation-and-live-gates", () => {
      for (const bad of [[], [...list, list[0]], [list[0], list[0]], [{ ...list[0], label: "https://redacted.invalid" }], [{ ...list[0], borrower: "bad" }]]) assert.throws(() => validateList(bad));
      assert.throws(() => parseArgs(["--live"])); assert.throws(() => parseArgs(["--once", "--live", "--offline-test"]));
      assert.deepEqual(parseArgs(["--watch-list", LIST]).watchList, configuredList);
    });
    await test("twenty-five-call-budget-and-write-method-denial", async () => {
      const transport = makeTransport(fixtureSend(fixtures, list), "dry-run");
      await assert.rejects(transport.rpc("eth_sendRawTransaction", []), /METHOD_REJECTED/);
      for (let i = 0; i < MAX_REQUESTS; i++) await transport.rpc("eth_chainId", []);
      await assert.rejects(transport.rpc("eth_chainId", []), /RPC_BUDGET_EXCEEDED/); assert.equal(transport.ledger.length, 25);
    });
    await test("shared-120-second-deadline", async () => {
      let clock = 0;
      const transport = single.createTransport({ mode: "dry-run", maxRequests: MAX_REQUESTS, now: () => clock,
        send: async () => { clock = single.MAX_MS; return "0x2105"; } });
      const value = await captureMulti({ transport, watchList: list });
      assert.equal(value.status, "INCOMPLETE"); assert.equal(value.reason, "TIME_BUDGET_EXCEEDED");
      assert.equal(value.crossPairSummary.captured, 0); assert.equal(transport.ledger.length, 1);
    });
    await test("endpoint-free-artifacts", () => {
      assert.throws(() => jsonBytes({ authorization: "Bearer redacted" }), /SANITIZATION_FAILED/);
      assert.throws(() => jsonBytes({ rpc: "https://redacted.invalid" }), /SANITIZATION_FAILED/);
      assert.equal(safeCode(new Error("https://redacted.invalid?key=redacted")), "RPC_FAILURE"); jsonBytes(capture);
    });
    await test("fifth-mglo-borrower-one-pin-within-budget", async () => {
      assert.equal(configuredList.length, 5);
      const value = await run({}, configuredList), row = value.crossPairSummary.pairs[4], m = value.entries[4].metrics;
      assert.equal(value.status, "COMPLETE"); assert.equal(value.crossPairSummary.captured, 5);
      assert.equal(value.diagnostics.requestCount, 24); assert.equal(value.diagnostics.rpcCount, 0);
      assert.ok(value.entries.every((entry) => entry.pin.valid && entry.pin.hash === fixtures.block.hash));
      assert.equal(row.marketId, MGLO_MARKET); assert.equal(row.borrower, "0x2e3dc205e5687e02eb4bea4f657c9572a83490e5");
      assert.equal(m.collateralRaw, MGLO_FIXTURE.collateralRaw.toString()); assert.equal(m.oraclePriceRaw, MGLO_FIXTURE.price.toString());
      assert.equal(m.priceUsdcPerCollateral, "0.972453700000000000000000");
      assert.ok(BigInt(m.debtRawUsdc) > MGLO_FIXTURE.debtRaw); assert.ok(Number(row.hf) > 1.02 && Number(row.hf) < 1.04);
      assert.equal(row.verdict, "NEAR_LIQUIDATION"); assert.equal(row.protocolLiquidatableAtPin, false);
      const price = BigInt(row.thresholdOraclePriceRaw), max = (p) => (MGLO_FIXTURE.collateralRaw * p / 10n ** 36n) * BigInt(m.lltvWad) / 10n ** 18n;
      assert.ok(max(price) >= BigInt(m.debtRawUsdc)); assert.ok(max(price - 1n) < BigInt(m.debtRawUsdc));
      const block = `0x${(BigInt(fixtures.block.number) - 1n).toString(16)}`;
      const historical = await captureMulti({ transport: makeTransport(fixtureSend(fixtures, configuredList), "dry-run"), watchList: configuredList, block });
      assert.equal(historical.status, "COMPLETE"); assert.equal(historical.diagnostics.requestCount, 25);
      jsonBytes(value);
    });
    const summary = { schema: "morpho-multi-watch-offline-test/v1", generatedAt: new Date().toISOString(), runId: crypto.randomBytes(8).toString("hex"),
      passed: cases.every((row) => row.passed), cases, rpcCount: 0, capture, enforcement: ENFORCEMENT, safety: safety() };
    const artifactPath = persist(summary);
    process.stdout.write(JSON.stringify({ passed: summary.passed, passedCount: cases.filter((row) => row.passed).length, total: cases.length, cases, artifactPath, rpcCount: 0 }) + "\n");
    if (!summary.passed) fail("OFFLINE_TEST_FAILED");
  } finally { globalThis.fetch = previous; }
}
module.exports = { offlineTest, fixtureSend };
