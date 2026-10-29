"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { ethers } = require("ethers");
const originalFetch = globalThis.fetch;
let attemptedNetwork = 0;
globalThis.fetch = async () => { attemptedNetwork++; throw new Error("OFFLINE_NETWORK_FORBIDDEN"); };
test.after(() => { globalThis.fetch = originalFetch; assert.equal(attemptedNetwork, 0); });
const c = require("../check-ynethx-mseth-partial");
const { B, I } = c;
const WAD = 10n ** 18n, SCALE = 10n ** 36n;
const NOW = Date.parse("2026-10-18T06:40:00Z"), SECONDS = NOW / 1000 - 60;
const word = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const simple = { collateral: 1000n, borrowerShares: 600000000n, assets: 1000n, shares: 1000000000n, price: SCALE, lltv: B.lltv };

function fixture(options = {}) {
  const clock = { time: NOW }, calls = [];
  let numberHeaders = 0;
  const header = () => ({ number: "0x64", hash: word(100), parentHash: word(99), stateRoot: word(900), timestamp: `0x${SECONDS.toString(16)}` });
  const rpc = async (handle, method, params, timeout) => {
    calls.push({ method, params, timeout }); assert.ok(timeout > 0 && timeout <= 4000);
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") {
      const h = header();
      if (params[0] !== "finalized" && ++numberHeaders > 2 && options.reorg) h.hash = word(101);
      return h;
    }
    if (method === "eth_gasPrice") return options.missingGas ? "0x0" : "0x3b9aca00";
    if (method === "eth_getLogs") { assert.equal(params[0].blockHash, word(100)); return []; }
    assert.deepEqual(params.at(-1), { blockHash: word(100), requireCanonical: true });
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getStorageAt") return word(0);
    assert.equal(method, "eth_call");
    const tx = params[0], to = tx.to.toLowerCase();
    const encode = (iface, parsed, result) => iface.encodeFunctionResult(parsed.fragment, result);
    if (to === B.morpho) {
      const p = I.morpho.parseTransaction(tx);
      if (p.name === "idToMarketParams") return encode(I.morpho, p, [B.loan, options.marketMismatch ? B.weth : B.collateral, B.oracle, B.irm, B.lltv]);
      if (p.name === "market") return encode(I.morpho, p, [2000n * WAD, 2000n * WAD * 1000000n, 1000n * WAD, 1000n * WAD * 1000000n, BigInt(SECONDS - 60), 0]);
      if (p.name === "position") return encode(I.morpho, p, [0, options.settled ? 0 : (options.healthy ? 100n : 700n) * WAD * 1000000n, 700n * WAD]);
    }
    if (to === B.oracle) return I.oracle.encodeFunctionResult("price", [SCALE]);
    if (to === B.irm) {
      assert.equal(tx.from?.toLowerCase(), B.morpho, "sender-gated IRM must be read as canonical Morpho caller");
      if (options.irmRevert) throw { code: "CALL_EXCEPTION" };
      return I.irm.encodeFunctionResult("borrowRate", [options.rate || 0]);
    }
    if (to === B.curve) {
      const p = I.curve.parseTransaction(tx);
      if (p.name === "coins") {
        if (options.identityTransport) throw { code: "RPC_TRANSPORT", message: "secret raw diagnostic" };
        return encode(I.curve, p, [options.coinMismatch ? B.collateral : p.args[0] === 0n ? B.weth : B.loan]);
      }
      if (options.deadline) clock.time += 111000;
      if (options.failedQuote) throw { code: "CALL_EXCEPTION" };
      return encode(I.curve, p, [p.args[2] * 105n / 100n]);
    }
    const tokenCall = I.token.parseTransaction(tx);
    if (tokenCall) {
      if (tokenCall.name === "decimals") return encode(I.token, tokenCall, [18]);
      if (tokenCall.name === "balanceOf") {
        const owner = tokenCall.args[0].toLowerCase();
        return encode(I.token, tokenCall, [owner === B.diagnosticOwner ? 0 : 1000n * WAD]);
      }
    }
    if (to === B.collateral) {
      const p = I.vault.parseTransaction(tx);
      if (p.name === "asset") return encode(I.vault, p, [options.assetMismatch ? B.loan : B.weth]);
      if (p.name === "totalAssets" || p.name === "totalSupply") return encode(I.vault, p, [1000n * WAD]);
      if (p.name === "maxRedeem" || p.name === "maxWithdraw") {
        assert.equal(tx.from.toLowerCase(), p.args[0].toLowerCase());
        return encode(I.vault, p, [p.args[0].toLowerCase() === B.morpho ? options.cap ?? WAD : 0]);
      }
      if (p.name === "previewRedeem") return encode(I.vault, p, [p.args[0] * 11n / 10n]);
      if (p.name === "redeem") {
        assert.equal(tx.from.toLowerCase(), B.morpho); assert.equal(p.args[2].toLowerCase(), B.morpho);
        throw { code: "CALL_EXCEPTION" };
      }
      if (p.name === "cooldownDuration") throw { code: "CALL_EXCEPTION" };
    }
    throw new Error("Unexpected offline call");
  };
  return { clock, calls, input: { now: () => clock.time, rpc,
    candidates: [{ handle: "offline-1", operatorFamily: "alchemy" }, { handle: "offline-2", operatorFamily: "infura" }] } };
}

test("import and explicit run gate perform no IO/network", async t => {
  let reads = 0;
  t.mock.method(fs, "existsSync", () => { reads++; throw new Error("NO_IO"); });
  assert.deepEqual(await c.main([]), { status: "NOT_RUN_EXPLICIT_GATE_REQUIRED" });
  assert.equal(reads, 0); assert.equal(attemptedNetwork, 0);
});
test("market tuple exact addresses, LLTV and ABI hash bind to retained ID", () => {
  assert.equal(c.verifyMarket([B.loan, B.collateral, B.oracle, B.irm, B.lltv])[1], B.collateral);
  assert.throws(() => c.verifyMarket([B.loan, B.collateral, B.oracle, B.irm, B.lltv - 1n]), /MARKET_BINDING_MISMATCH/);
});
test("known answers retain each ceil and virtual offsets; no linear repayment scaling", () => {
  assert.equal(c.partialAmounts(simple, 1n).repayRaw, 1n);
  const a = c.partialAmounts(simple, 100n);
  assert.equal(a.lifRaw, 1026167265264238070n);
  assert.equal(a.collateralValueUpRaw, 100n); assert.equal(a.repaymentValueUpRaw, 98n);
  assert.equal(a.repaidSharesRaw, 98000000n); assert.equal(a.repayRaw, 98n);
  assert.equal(c.partialAmounts(simple, 615n).repayRaw, 600n);
  assert.notEqual(a.repayRaw, c.partialAmounts(simple, 615n).repayRaw * 100n / 615n);
  const priceCeil = c.partialAmounts({ ...simple, price: SCALE + 1n }, 100n);
  assert.equal(priceCeil.collateralValueUpRaw, 101n); assert.equal(priceCeil.repayRaw, 99n);
  const doubleCeil = c.partialAmounts({ ...simple, assets: 1001n }, 100n);
  assert.equal(doubleCeil.repaidSharesRaw, 97902196n); assert.equal(doubleCeil.repayRaw, 99n);
});
test("exact inverse bounds borrower shares and collateral; LIF is capped", () => {
  assert.equal(c.feasibleSeizure(simple), 615n);
  assert.throws(() => c.partialAmounts(simple, 616n), /BORROWER_SHARES/);
  assert.equal(c.feasibleSeizure({ ...simple, collateral: 100n }), 100n);
  assert.equal(c.partialAmounts({ ...simple, lltv: 0n }, 100n).lifRaw, 1150000000000000000n);
  assert.throws(() => c.partialAmounts(simple, 0n), /NOT_FEASIBLE/);
  assert.throws(() => c.partialAmounts(simple, 1001n), /NOT_FEASIBLE/);
});
test("<=5 sizes fixed/deduped before quotes, owner cap only heuristic; rejection recorded", () => {
  const s = c.chooseSizes(simple, 100n);
  assert.equal(s.accepted.length, 5); assert.equal(s.accepted[0].seizedRaw, 50n); assert.equal(s.accepted[1].seizedRaw, 100n);
  assert.equal(s.ownerCapHeuristicOnly, true);
  const oversized = c.chooseSizes(simple, 2000n);
  assert.equal(oversized.rejected.filter(row => row.reason === "EXCEEDS_PROTOCOL_CAP").length, 2);
  const tiny = c.chooseSizes({ ...simple, collateral: 1n }, 1n);
  assert.equal(tiny.accepted.length, 1); assert.ok(tiny.rejected.length > 0);
});
test("one complete offline batch pins all state, five observations and terminal headers under cap", async () => {
  const f = fixture(); const a = await c.check(f.input);
  assert.deepEqual(a.failures, []);
  assert.equal(a.status, "PINNED_CONDITIONAL_OBSERVATIONS"); assert.equal(a.eligibility.eligible, true);
  assert.equal(a.rows.length, 5); assert.equal(a.pin.hash, word(100)); assert.equal(a.pin.stateRoot, word(900));
  assert.equal(a.terminalCanonicality, "CONFIRMED_TWO_HEADERS");
  assert.ok(a.networkRequests <= 100); assert.equal(a.networkRequests, f.calls.length);
  assert.ok(a.rows.every(row => row.rawMargin > 0n && row.netRaw === null));
  assert.ok(a.rows.every(row => row.directRedeemEthCall.status === "REVERT"));
  assert.equal(a.observations.ownerContexts[2].maxRedeem.value, 0n);
  assert.ok(a.rows.every(row => row.newOwnerCapacity.includes("UNKNOWN")));
  assert.equal(a.executableNow, "unknown"); assert.equal(a.routePositive, "unknown"); assert.equal(a.signedActionJustified, false);
  assert.equal(a.requestLedger.some(entry => entry.status === "PENDING"), false);
  assert.equal(f.calls.some(call => JSON.stringify(call.params).includes('"latest"')), false);
});
test("healthy/settled positions stop before amount-specific exits/funding", async () => {
  for (const mode of ["healthy", "settled"]) {
    const f = fixture({ [mode]: true }); const a = await c.check(f.input);
    assert.equal(a.status, "PINNED_NOT_CURRENTLY_ELIGIBLE"); assert.deepEqual(a.rows, []);
    assert.equal(f.calls.some(call => call.method === "eth_gasPrice"), false);
  }
});
test("current debt uses the repaired three-term Taylor accrual at the same pin", async () => {
  const f = fixture({ rate: 1000000000000n }); const a = await c.check(f.input);
  assert.deepEqual(a.failures, []);
  assert.equal(a.observations.elapsedSeconds, 60n);
  assert.equal(a.observations.totalBorrowAssetsAccruedRaw, 1000n * WAD + 60001800036000000n);
  assert.deepEqual(a.observations.borrowRateRead, { caller: B.morpho, status: "OBSERVED" });
});
test("IRM revert preserves successful raw core views and is not reported as provider denial or zero accrual", async () => {
  const f = fixture({ irmRevert: true }); const a = await c.check(f.input);
  assert.equal(a.status, "UNAVAILABLE"); assert.equal(a.currentValidated, false);
  assert.ok(a.failures.includes("IRM_BORROW_RATE_REVERT"));
  assert.ok(!a.failures.includes("TRANSPORT_FAILURE_RETAINED"));
  assert.equal(a.observations.params[0].toLowerCase(), B.loan);
  assert.equal(a.observations.marketStored[2], 1000n * WAD);
  assert.equal(a.observations.position[1], 700n * WAD * 1000000n);
  assert.equal(a.observations.oraclePriceRaw, SCALE);
  assert.equal(a.observations.elapsedSeconds, 60n);
  assert.deepEqual(a.observations.borrowRateRead, { caller: B.morpho, status: "REVERT" });
  assert.equal(a.observations.ratePerSecondRaw, undefined);
  assert.equal(a.observations.totalBorrowAssetsAccruedRaw, undefined);
  assert.equal(a.eligibility, null); assert.deepEqual(a.rows, []);
  assert.equal(a.terminalCanonicality, "CONFIRMED_TWO_HEADERS");
  const persisted = JSON.parse(c.stringify(a));
  assert.equal(persisted.observations.oraclePriceRaw, SCALE.toString());
  assert.equal(persisted.observations.marketStored.length, 6);
  assert.equal(persisted.observations.position.length, 3);
});
test("failed quotes are UNKNOWN/null proceeds, not measured zero", async () => {
  const f = fixture({ failedQuote: true }); const a = await c.check(f.input);
  assert.deepEqual(a.failures, []); assert.equal(a.rows.length, 5);
  for (const row of a.rows) { assert.equal(row.exitQuoteRaw, null); assert.equal(row.rawMargin, null); assert.equal(row.netRaw, null); }
});
test("unavailable gas projection leaves net/cost unknown, never zero", async () => {
  const f = fixture({ missingGas: true }); const a = await c.check(f.input);
  assert.equal(a.projection, null); assert.equal(a.rows.length, 5);
  for (const row of a.rows) { assert.equal(row.gasAllowanceLoanRaw, null); assert.equal(row.estimatedNetBeforeUnknownFundingFeesRaw, null); }
});
test("identity mismatches, transport failures and terminal reorgs cannot validate current economics", async () => {
  for (const options of [{ coinMismatch: true }, { assetMismatch: true }, { identityTransport: true }, { reorg: true }, { marketMismatch: true }]) {
    const f = fixture(options); const a = await c.check(f.input);
    assert.equal(a.status, "UNAVAILABLE"); assert.equal(a.currentValidated, false);
    assert.ok(a.failures.length > 0); assert.ok(a.networkRequests <= 100);
    assert.doesNotMatch(c.stringify(a), /secret raw diagnostic|offline-1|offline-2/);
  }
});
test("wall-time exhaustion and caught errors remain explicit, terminal controls awaited", async () => {
  const f = fixture({ deadline: true }); const a = await c.check(f.input);
  assert.equal(a.status, "UNAVAILABLE"); assert.ok(a.failures.includes("OBSERVATION_BUDGET_EXHAUSTED"));
  assert.ok(a.networkRequests <= 100); assert.equal(a.requestLedger.at(-1).phase, "TERMINAL");
});
