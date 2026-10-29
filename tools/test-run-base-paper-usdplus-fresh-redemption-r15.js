"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const r15 = require("./run-base-paper-usdplus-fresh-redemption-r15");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

test("CLI is explicit and output is no-overwrite", async () => {
  assert.equal(r15.parseCli(["--run-once"]), true); assert.throws(() => r15.parseCli([]), /EXPLICIT_RUN_ONCE_REQUIRED/); assert.throws(() => r15.parseCli(["--run-once", "x"]));
  await assert.rejects(() => r15.runOnce({ exists: () => true }), /OUTPUT_EXISTS_NO_OVERWRITE/);
});

test("provenance binds ordinary execution to current R15 source", () => {
  const p = r15.provenance(); assert.equal(p.schema, r15.SCHEMA); assert.equal(p.version, 15); assert.equal(p.runnerSha256, hash(fs.readFileSync(require.resolve("./run-base-paper-usdplus-fresh-redemption-r15"))));
});

function pin(number = 100n, timestamp = 1000n, byte = "11") { return { number: number.toString(), hash: `0x${byte.repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, stateRoot: `0x${"33".repeat(32)}`, timestamp: timestamp.toString() }; }
function raw(p) { return { number: `0x${BigInt(p.number).toString(16)}`, hash: p.hash, parentHash: p.parentHash, stateRoot: p.stateRoot, timestamp: `0x${BigInt(p.timestamp).toString(16)}` }; }
function qualificationFixture(options = {}) {
  const now = 1_100_000, p = pin(100n, 1000n), candidates = [{ url: new URL("https://one.invalid/x"), family: "a" }, { url: new URL("https://two.invalid/y"), family: options.sameFamily ? "a" : "b" }], calls = [];
  const transport = async (url, body) => { calls.push({ url, body }); let result = body.method === "eth_chainId" ? "0x2105" : body.method === "eth_getBlockByNumber" ? raw(options.disagree && url === candidates[1].url ? pin(101n, 1000n, "44") : p) : body.method === "eth_getCode" ? "0x6000" : { address: r15.A.usdPlus };
    return { value: { jsonrpc: "2.0", id: body.id, result }, bytes: 100 }; };
  return { now: () => now, p, candidates, calls, transport, budget: r15.makeBudget(transport, () => now) };
}

test("fresh qualification requires coherent distinct families", async () => {
  const f = qualificationFixture(), out = await r15.freshPinAndPair({ candidates: f.candidates, budget: f.budget, now: f.now }); assert.equal(out.stats.selectedFamilyCount, 2); assert.deepEqual(out.pin, f.p);
  for (const options of [{ sameFamily: true }, { disagree: true }]) { const x = qualificationFixture(options); await assert.rejects(() => r15.freshPinAndPair({ candidates: x.candidates, budget: x.budget, now: x.now }), /TWO_FAMILY_COHERENT_PIN_UNAVAILABLE/); }
});

test("freshness and terminal reorg disagreement fail closed", async () => {
  const stale = qualificationFixture(); stale.now = () => 5_000_000; stale.budget = r15.makeBudget(stale.transport, stale.now); await assert.rejects(() => r15.freshPinAndPair({ candidates: stale.candidates, budget: stale.budget, now: stale.now }), /ARCHIVE_FRESH_STATE_UNAVAILABLE/);
  const p = pin(), pair = [{ candidate: {} }, { candidate: {} }], budget = { rpc: async () => raw(pin(100n, 1000n, "44")) };
  await assert.rejects(() => r15.terminalPinRecheck(pair, p, budget), /HEADER_CHANGED/);
});

test("all material qualification state reads use EIP-1898 block hash", async () => {
  const f = qualificationFixture(); await r15.freshPinAndPair({ candidates: f.candidates, budget: f.budget, now: f.now });
  const material = f.calls.filter(x => ["eth_getCode", "eth_getProof"].includes(x.body.method)); assert.equal(material.length, 4); assert.equal(material.every(x => x.body.params.at(-1).requireCanonical === true && x.body.params.at(-1).blockHash === f.p.hash), true);
  assert.equal(f.budget.state.eip1898Reads, 4);
});

function goodView() {
  return { runtime: { tier1Exact: true }, core: { bindingsExact: true, paused: false, locksClear: true }, manager: { bindingsExact: true, privateAssetDerived: true, privateAsset: r15.A.usdc }, cash: { bindingsExact: true },
    capacity: [1, 2, 3].map(() => ({ liquidationStrict: true, scaledSufficient: true, virtualSufficient: true, actualSufficient: true })), aave: { bindingsExact: true, incentivesControllerBound: true }, archiveCapable: true };
}
for (const [gate, mutate] of [["G1", v => v.runtime.tier1Exact = false], ["G2", v => v.core.paused = true], ["G3", v => v.manager.privateAssetDerived = false], ["G4", v => v.capacity[2].liquidationStrict = false], ["G5", v => v.aave.incentivesControllerBound = false]]) test(`${gate} failure blocks the conjunctive pre-fork gate`, () => { const v = goodView(); mutate(v); const out = r15.evaluateGates(v); assert.equal(out.allPass, false); assert.equal(out.firstFailure.stage, `PREFORK_${gate}`); });
test("all G1-G5 must pass together", () => { const out = r15.evaluateGates(goodView()); assert.equal(out.allPass, true); assert.equal(out.firstFailure, null); });
test("Tier-1 drift, private asset mismatch, and unbound reward each stop", () => {
  const tier = goodView(); tier.runtime.tier1Exact = false; assert.equal(r15.evaluateGates(tier).firstFailure.stage, "PREFORK_G1");
  const asset = goodView(); asset.manager.privateAsset = "0x0000000000000000000000000000000000000000"; assert.equal(r15.evaluateGates(asset).firstFailure.stage, "PREFORK_G3");
  const reward = goodView(); reward.aave.incentivesControllerBound = false; assert.equal(r15.evaluateGates(reward).firstFailure.stage, "PREFORK_G5");
});

test("private manager asset slot requires exact compiler layout", () => {
  const input = JSON.stringify({ settings: {} }), compile = () => JSON.stringify({ contracts: { "contracts/PortfolioManager.sol": { PortfolioManager: { storageLayout: { storage: [{ label: "asset", slot: "252", offset: 0, type: "t_contract(IERC20)1" }] } } } } });
  assert.deepEqual(r15.deriveManagerAssetSlot(input, { compile }), { slotDecimal: "252", slotHex: "0xfc", label: "asset", source: "EXACT_SOLC_STORAGE_LAYOUT" });
  assert.throws(() => r15.deriveManagerAssetSlot(input, { compile: () => "{}" }), /PRIVATE_ASSET_SLOT_DERIVATION_MISSING/);
  assert.throws(() => r15.deriveManagerAssetSlot(input, { compile: () => compile().replace('"252"', '"253"') }), /PRIVATE_ASSET_SLOT_DERIVATION_MISSING/);
});

test("exact rebase decimals and FREE_RIDER semantics include one raw unit", () => {
  const base = { assetDecimals: "6", usdPlusDecimals: "6", feeRate: "10", feeDenominator: "100000", freeRider: false };
  assert.deepEqual(r15.payoutFor(1n, base), { x: "1", assetAmount: "1", fee: "0", payout: "1" });
  assert.equal(r15.payoutFor(100_000_000n, base).payout, "99990000"); assert.equal(r15.payoutFor(100_000_000n, { ...base, freeRider: true }).payout, "100000000");
  assert.equal(r15.payoutFor(1_000_000n, { ...base, assetDecimals: "18" }).assetAmount, "1000000000000000000");
});

test("capacity requires strict liquidation greater-than payout and exact ceil scaling", () => {
  const view = { payoutInputs: { assetDecimals: "6", usdPlusDecimals: "6", feeRate: "0", feeDenominator: "1", freeRider: false }, cash: { liquidationValue: "100000001" }, aave: { nextLiquidityIndex: (3n * 10n ** 27n).toString(), scaledBalance: "100000000", virtualUnderlying: "100000001", actualUnderlying: "100000001" } };
  const rows = r15.capacityRows(view); assert.deepEqual(rows.map(x => x.x), ["1", "1000000", "100000000"]); assert.equal(rows[0].scaledP, "1"); assert.equal(rows[2].scaledP, "33333334"); assert.equal(rows.every(x => x.liquidationStrict), true);
  view.cash.liquidationValue = "100000000"; assert.equal(r15.capacityRows(view)[2].liquidationStrict, false);
});

test("ordered trace preserves call order and excludes balancing", () => {
  const node = (from, to, calls = []) => ({ from, to, type: "CALL", input: "0x12345678", calls });
  const trace = node(r15.A.actor, r15.A.exchange, [node(r15.A.exchange, r15.A.manager, [node(r15.A.manager, r15.A.cash, [node(r15.A.cash, r15.A.pool, [node(r15.A.pool, r15.A.aToken, [node(r15.A.aToken, r15.A.usdc)])])])])]);
  const calls = r15.orderedCalls(trace); assert.deepEqual(calls.map(x => x.order), [0, 1, 2, 3, 4, 5]); assert.equal(r15.validateOrderedCashPath(calls).pass, true);
  calls.push({ order: 6, caller: r15.A.manager, callee: r15.A.m2m, success: true }); assert.equal(r15.validateOrderedCashPath(calls).code, "PATH_EXPANDED_TO_PORTFOLIO_BALANCING");
});

function conservationRow(x) {
  const p = BigInt(x), pristineSupply = 1000_000_000n, liq = 2n * 10n ** 27n, scaled = (p * 10n ** 27n + liq - 1n) / liq;
  return { x: p.toString(), payout: p.toString(), nextLiquidityIndex: liq.toString(), pristine: { usdPlusSupply: pristineSupply.toString() }, before: { usdPlusActor: p.toString(), usdPlusSupply: (pristineSupply + p).toString(), usdcActor: "0", usdcAToken: "1000000000", usdcCash: "0", usdcManager: "0", usdcExchange: "0", usdcSupply: "9999999999", scaledCash: (1000000000n + scaled).toString(), virtualUnderlying: "1000000000", actualUnderlying: "1000000000" },
    after: { usdPlusActor: "0", usdPlusSupply: pristineSupply.toString(), usdcActor: p.toString(), usdcAToken: (1000000000n - p).toString(), usdcCash: "0", usdcManager: "0", usdcExchange: "0", usdcSupply: "9999999999", scaledCash: "1000000000", virtualUnderlying: (1000000000n - p).toString(), actualUnderlying: (1000000000n - p).toString() },
    rolledBack: { usdPlusSupply: pristineSupply.toString() }, transfers: [[r15.A.aToken, r15.A.cash], [r15.A.cash, r15.A.manager], [r15.A.manager, r15.A.exchange], [r15.A.exchange, r15.A.actor]].map(([from, to]) => ({ token: r15.A.usdc, from, to, value: p.toString() })),
    burnTransfer: true, poolWithdraw: true, strategyUnstake: true, reserveUpdated: true, isBalanced: false, balanceEvent: false, rollbackComplete: true };
}
for (const size of r15.SIZES) test(`conservation, rounding, and rollback hold for size ${size}`, () => { const row = conservationRow(size), out = r15.validateConservation(row); assert.equal(out.pass, true); });
test("conservation rejects rollback and balancing evidence", () => { const row = conservationRow(1n); row.rollbackComplete = false; assert.equal(r15.validateConservation(row).pass, false); const other = conservationRow(1n); other.isBalanced = true; assert.equal(r15.validateConservation(other).pass, false); });

function authority() { return { immutable: {}, baselineHashes: {}, bindings: {}, root: "X" }; }
function preResult(now, allPass = true) { const p = pin(200n, BigInt(Math.floor(now / 1000) - 10)); return { pin: p, pinEvidence: { ...p, observedAt: new Date(now).toISOString(), freshnessExpiresAt: new Date((Number(p.timestamp) + 3600) * 1000).toISOString() }, pair: [{ candidate: {} }, { candidate: {} }], stats: { attempted: 2, qualified: 2, selectedFamilyCount: 2, failures: {} }, evaluation: allPass ? { allPass: true, gates: r15.evaluateGates(goodView()).gates, firstFailure: null } : r15.evaluateGates({ ...goodView(), runtime: { tier1Exact: false } }) }; }

test("real-mode candidate pool reader is called at most once", async () => { let reads = 0; const now = Date.now(); const out = await r15.runOnce({ exists: () => false, preflight: authority(), layout: {}, readCandidates: () => { reads++; return [{}, {}]; }, establish: async () => preResult(now, false), now: () => now }); assert.equal(reads, 1); assert.equal(out.safety.inventoryReads, 1); assert.equal(out.progress.relayReached, false); });

test("every pre-fork gate failure blocks relay and Anvil creation", async () => {
  for (const gate of ["G1", "G2", "G3", "G4", "G5"]) { let relay = 0, child = 0; const now = Date.now(), evaluation = { allPass: false, gates: {}, firstFailure: { stage: `PREFORK_${gate}`, code: `BLOCK_${gate}` } };
    const out = await r15.runOnce({ exists: () => false, preflight: authority(), layout: {}, candidates: [{}, {}], establish: async () => ({ ...preResult(now), evaluation }), now: () => now, relayFactory: async () => { relay++; }, startChild: async () => { child++; } });
    assert.equal(relay, 0); assert.equal(child, 0); assert.equal(out.firstFailure.stage, `PREFORK_${gate}`); }
});

test("archive failure after fresh state does not start relay or Anvil", async () => { let relay = 0; const now = Date.now(), error = new r15.R15Error("ARCHIVE_SELECTION", "ARCHIVE_CAPABILITY_UNAVAILABLE"); error.stats = { attempted: 2, qualified: 0, selectedFamilyCount: 0, failures: { ARCHIVE_CODE_UNAVAILABLE: 2 } };
  const out = await r15.runOnce({ exists: () => false, preflight: authority(), layout: {}, candidates: [{}, {}], establish: async () => { throw error; }, relayFactory: async () => { relay++; }, now: () => now }); assert.equal(relay, 0); assert.deepEqual(out.qualification, error.stats); });

test("fresh R15 pin, not R14 pin, reaches Anvil args and readiness lane", async () => { const now = Date.now(), pre = preResult(now), expected = pre.pin.number; let argsSeen, executed = 0;
  const relay = { port: 41000, close: async () => {}, closed: () => true }, child = new EventEmitter(); child.exitCode = 0;
  const out = await r15.runOnce({ exists: () => false, preflight: authority(), layout: {}, candidates: [{}, {}], establish: async () => pre, now: () => now, relayFactory: async () => relay, freePort: async () => 41001,
    startChild: async args => { argsSeen = args; return child; }, executeFork: async ({ progress }) => { executed++; progress.mintReached = true; progress.redemptionReached = true; return { rows: [1, 2, 3] }; } });
  assert.equal(argsSeen[argsSeen.indexOf("--fork-block-number") + 1], expected); assert.notEqual(expected, "50931239"); assert.equal(executed, 1); assert.equal(out.fullExitVerified, true); assert.equal(out.quoteEligible, true); assert.equal(out.routePositive, "unknown"); assert.equal(out.executableNow, "unknown");
});

test("cleanup uncertainty downgrades otherwise successful work", async () => { const now = Date.now(), relay = { port: 41000, close: async () => { throw new r15.R15Error("RELAY_CLEANUP", "CLOSE_FAILED"); } }, child = { exitCode: 0 };
  const out = await r15.runOnce({ exists: () => false, preflight: authority(), layout: {}, candidates: [{}, {}], establish: async () => preResult(now), now: () => now, relayFactory: async () => relay, freePort: async () => 41001, startChild: async () => child, executeFork: async () => ({ rows: [1, 2, 3] }) });
  assert.equal(out.fullExitVerified, false); assert.equal(out.quoteEligible, false); assert.equal(out.cleanup.relay, "FAILED"); assert.equal(out.classification, "INCOMPLETE / RELAY_CLEANUP / CLOSE_FAILED");
});

test("sanitizer, localhost child argv, and WATCH route semantics remain closed", () => { assert.equal(r15.sanitized({ routePositive: "unknown" }), true); assert.equal(r15.sanitized("https://secret.invalid"), false); assert.throws(() => r15.localhost("https://127.0.0.1")); const args = r15.buildAnvilArgs(1, 2, pin()); assert.equal(args.includes("http://127.0.0.1:1"), true); const out = r15.baseOutput(); assert.equal(out.routePositive, "unknown"); assert.equal(out.executableNow, "unknown"); assert.equal(out.profitabilityClaim, false); assert.equal(out.signedActionJustified, false); });
