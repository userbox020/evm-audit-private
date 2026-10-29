"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Interface } = require("../node_modules/ethers");
const runner = require("../execute-top-whale-trigger.js"), guard = require("../lib/wallet-execution-guard.js");
const SOURCE = fs.readFileSync(require.resolve("../execute-top-whale-trigger.js"), "utf8");
const W = 10n ** 18n, ZERO = "0x" + "00".repeat(20), NOW = Date.parse("2026-10-23T20:00:00Z");
const PIN = { chainId: 1, number: 1000, hash: "0x" + "11".repeat(32), timestamp: NOW / 1000 - 3, baseFeePerGas: "1" };

// Reuse the runner's public contract literals/ABIs without exporting additional
// production internals or importing another test suite and its fixtures.
function address(name) {
  const match = SOURCE.match(new RegExp(`\\b${name} = "(0x[0-9a-f]+)"`));
  assert.ok(match, name); return match[1];
}
function iface(name) {
  const match = SOURCE.match(new RegExp(`const ${name} = new Interface\\(\\["([^"]+)"\\]\\)`));
  assert.ok(match, name); return new Interface([match[1]]);
}
function encode(name, overrides, extra = []) {
  const abi = iface(name), defaults = Object.fromEntries(abi.getFunction("execute").inputs[0].components.map(p =>
    [p.name, p.type === "address" ? ZERO : p.type === "bytes" ? "0x" : p.type === "bool" ? false : 0n]));
  return abi.encodeFunctionData("execute", [{ ...defaults, ...overrides }, ...extra]);
}
function row(user, field, data) { return { user, liquidatableNow: true, executableNow: true, positionStatus: "OPEN", debtRaw: "1", [field]: data }; }
function branches() {
  const irm = address("M1_IRM"), lltv = 915000000000000000n;
  return [
    { kind: "MORPHO_BLUE_M2", key: "targetM2_Morpho_reUSD_USDC", row: row(address("M2_BORROWER"), "readyExecuteCurveUnwindCalldata",
      encode("M2_EXEC_IFACE", { loanToken: address("USDC"), collateralToken: address("REUSD"), oracle: address("M2_ORACLE"), irm, lltv,
        borrower: address("M2_BORROWER"), seizedAssets: 100000n * W, swapTarget: address("CURVE_REUSD_USDC"), minLoanOut: 100025000000n },
      [runner.CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, 100000n * W, 107460000000n])])) },
    { kind: "MORPHO_BLUE_M7", key: "targetM7_Morpho_ynETHx_msETH_Canary", row: row(address("M7_BORROWER"), "readyExecuteVaultRedeemCalldata",
      encode("M7_EXEC_IFACE", { loanToken: address("MSETH"), collateralToken: address("YNETHX"), oracle: address("M7_ORACLE"), irm, lltv,
        borrower: address("M7_BORROWER"), seizedAssets: W, intermediateToken: address("WETH"), curvePool: address("CURVE_MSETH_WETH"), curveI: 1, minLoanOut: 2n * W })) },
    { kind: "CURVE_BUY_VAULT_REDEEM_YN", key: "targetYnEthx_Curve_NavArb", row: row(address("CURVE_YNETHX_WETH"), "readyExecuteCurveRedeemCalldata",
      encode("YN_ARB_EXEC_IFACE", { loanToken: address("WETH"), vaultToken: address("YNETHX"), curvePool: address("CURVE_YNETHX_WETH"),
        curveI: 1, flashAmount: W, minSharesOut: W, minLoanOut: 2n * W })) },
    { kind: "EULER_EVK_E1", key: "targetE1_EulerV2_RLUSD_USDC_0xbf21", row: row(address("E1_BORROWER"), "readyExecuteEulerEvkCalldata",
      encode("EULER_EVK_EXEC_IFACE", { loanToken: address("RLUSD"), liabilityVault: address("E1_LIABILITY_VAULT"), collateralVault: address("E1_COLL_VAULT"),
        underlyingCollateral: address("USDC"), violator: address("E1_BORROWER"), repayAssets: W, minYieldShares: 1,
        unwindKind: 1, swapTarget: address("CURVE_USDC_RLUSD"), curveJ: 1, minLoanOut: 51n * W })) },
    { kind: "UNIV4_FLASH_LIQUIDATION", key: "targetA12_AaveV4_WBTC_USDT_0xac90", row: row(address("A12_BORROWER"), "readyExecuteUniV4FlashCalldata",
      encode("UNIV4_FLASH_EXEC_IFACE", { target: address("A12_SPOKE"), collateralReserveId: 1, debtReserveId: 5, borrower: address("A12_BORROWER"),
        debtAsset: address("USDT"), collateralAsset: address("WBTC"), flashAmount: 28000000000n, debtToCover: 28000000000n,
        minCollateralSeized: 35000000n, minSwapOut: 28500000000n, minProfit: 500000000n, deadline: 9999999999n,
        poolKey: { currency0: address("WBTC"), currency1: address("USDT"), fee: 500, tickSpacing: 10, hooks: ZERO }, zeroForOne: true })) },
    { kind: "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", key: "targetF1_Fluid_USDe_USDT_Vault93", row: row(address("F1_BORROWER"), "readyExecuteUniversalCalldata",
      encode("UNIVERSAL_EXEC_IFACE", { mode: 1, loanToken: address("USDT"), fluidVault: address("F1_VAULT_93"), borrower: address("F1_BORROWER"),
        flashAmount: 1000000000n, minProfit: 5000000n })) },
    { kind: "UNIVERSAL_EULER_EVK_LIQUIDATION", key: "targetE7_EulerV2_RLUSD_USDe_0x1066", row: row(address("E7_BORROWER"), "readyExecuteUniversalCalldata",
      encode("UNIVERSAL_EULER_EXEC_IFACE", { loanToken: address("RLUSD"), liabilityVault: address("E1_LIABILITY_VAULT"), collateralVault: address("E7_COL_VAULT"),
        underlyingCollateral: address("USDE"), violator: address("E7_BORROWER"), unwindKind: 2, repayAssets: W, minLoanOut: 2n * W })) },
    { kind: "MORPHO_PENDLE_PT_REDEEM", key: "targetM8_Morpho_PT_USDe_DAI", row: row(address("M8_BORROWER"), "readyExecutePendlePtCalldata",
      encode("PENDLE_PT_EXEC_IFACE", { loanToken: address("DAI"), collateralToken: address("PT_USDE"), oracle: address("PT_ORACLE"), irm, lltv,
        borrower: address("M8_BORROWER"), seizedAssets: 30000n * W, pendleYt: address("PENDLE_YT"), pendleSy: address("PENDLE_SY"),
        redeemedToken: address("USDE"), swapTarget: address("UNI_ROUTER"), minLoanOut: 30200n * W }, ["0x1234567890"])) },
    { kind: "MORPHO_BLUE_WSTETH", key: "morpho_wstETH_WETH_Whales", array: true, row: row("0xb224f589297a5a207e6069de5dafd4b120129817", "readyExecuteMorphoBlueCalldata",
      runner.MORPHO_EXEC_IFACE.encodeFunctionData("execute", [{ loanToken: address("WETH"), collateralToken: address("WSTETH"), oracle: address("WSTETH_MORPHO_ORACLE"),
        irm, lltv: 965000000000000000n }, "0xb224f589297a5a207e6069de5dafd4b120129817", W, 0, W / 20n, 2n * W, address("UNI_ROUTER"), address("WST_PATH")])) },
  ];
}
function batch() {
  return { schema: "live-execution-batch/v1", approved: true, approvedAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(), chainId: 1, chain: "ethereum",
    account: { address: guard.MAIN_ACCOUNT }, targets: runner.REQUIRED_TARGETS.map(address => ({ address })),
    actions: ["liquidator.executeMorpho(uint256 flashAmount, UnifiedLiquidationParams params) when net > 0"],
    caps: { maxExecutionGasLimit: 1500000, maxExecutionSpendWei: "2000000000000000", signedExecutionsPerDay: 3,
      slippageFloor: "minDebtTokenOut >= quoted * 0.995; minProfitDebtToken > 0", principalAtRisk: "zero (atomic settlement)" } };
}

for (const [label, value] of [["missing", undefined], ["null", null], ["zero", 0n], ["negative", -1n], ["non-integer", 1.5],
  ["number", 1], ["boolean", true], ["object", {}], ["array", [1]], ["decimal string", "1.5"], ["zero string", "0"],
  ["negative string", "-1"], ["empty string", ""], ["whitespace", " 1"], ["hex", "0x1"], ["exponent", "1e3"], ["NaN", NaN]]) {
  test(`requireVerifiedCurrentProfit rejects ${label}`, () => {
    assert.throws(() => runner.requireVerifiedCurrentProfit(value), error => error instanceof guard.ExecutionError && error.code === "PROFIT_UNVERIFIED");
  });
}
test("requireVerifiedCurrentProfit accepts positive bigint and exact integer-string wei", () => {
  assert.equal(runner.requireVerifiedCurrentProfit(1n), 1n);
  assert.equal(runner.requireVerifiedCurrentProfit("9007199254740993"), 9007199254740993n);
});

async function runHeld(t, fixtures) {
  const forbidden = () => assert.fail("unverified CURRENT profit must hold before wallet/fee/nonce work");
  const spies = ["reconcileWallet", "acquireWalletLock", "executeGuarded", "buildFees", "signWithProcessKey"].map(name => t.mock.method(guard, name, forbidden));
  const state = { signs: 0, sends: 0, nonces: 0 }, targets = Object.fromEntries(fixtures.map(f => [f.key, f.array ? [f.row] : f.row]));
  const candidates = runner.selectCandidates({ targets });
  assert.deepEqual(candidates.map(c => c.kind).sort(), fixtures.map(f => f.kind).sort());
  assert.ok(candidates.every(c => c.conservativeProfitBeforeGasWei === undefined));
  const pinned = { pin: PIN, evidence: {}, assertUsable() {}, recheck: async () => {},
    call: forbidden, estimateGas: forbidden, nonce: async () => { state.nonces++; return "0x0"; }, send: async () => { state.sends++; return "0x"; } };
  const out = await runner.runPass({ execute: true, argv: ["--no-write"], batch: batch(), now: () => NOW, pinned,
    loadMorphoBatch: forbidden, signTransaction: async () => { state.signs++; return "0x"; },
    checkOnce: async options => ({ pin: PIN, targets: options.m1Only ? {} : targets }) });
  assert.equal(out.fired, false); assert.equal(out.summary.armed, false); assert.equal(out.summary.ok, true);
  assert.equal(out.summary.reason, "NO_CANDIDATE_PASSED_PREFLIGHT"); assert.equal(out.summary.candidateCount, fixtures.length);
  assert.deepEqual(out.summary.preflightFailures, candidates.map(c => ({ targetId: c.id, reason: "PROFIT_UNVERIFIED" })));
  assert.equal(out.summary.execution, undefined, "unsigned preflight creates no journal stage");
  assert.deepEqual(state, { signs: 0, sends: 0, nonces: 0 });
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
}
for (const f of branches()) {
  test(`${f.kind}: actual runner holds missing profit before any wallet work`, async t => runHeld(t, [f]));
  test(`${f.kind}: admission precedes legacy fees/prepare and final guard receives profit`, () => {
    const admissionBody = SOURCE.slice(SOURCE.indexOf("function requireVerifiedCurrentVariant("),
      SOURCE.indexOf("\nfunction ", SOURCE.indexOf("function requireVerifiedCurrentVariant(")));
    assert.match(admissionBody, new RegExp(`case "${f.kind}": [^\\n]*variants = [^\\n]+; break;`));
    assert.match(admissionBody, /variants\.some\(variant =>[\s\S]*requireVerifiedCurrentProfit\(variant\.conservativeProfitBeforeGasWei\)/);
    const runStart = SOURCE.indexOf("async function runPass(");
    const admission = SOURCE.indexOf("requireVerifiedCurrentVariant(candidate);", runStart);
    const wallet = SOURCE.indexOf("await guard.reconcileWallet(", runStart);
    const dispatch = SOURCE.indexOf(`if (candidate.kind === "${f.kind}") {`, admission);
    assert.ok(runStart >= 0 && admission > runStart && admission < wallet && wallet < dispatch);
    const branch = SOURCE.slice(dispatch, SOURCE.indexOf("\n      }", dispatch));
    const fees = branch.indexOf("guard.buildFees("), guarded = branch.indexOf("await guard.executeGuarded(");
    const prepare = branch.indexOf("prepare: async", guarded);
    assert.ok(fees >= 0 && fees < guarded && guarded < prepare);
    const chosen = ["MORPHO_BLUE_M7", "EULER_EVK_E1"].includes(f.kind) ? "candidate" : "chosenVariant";
    if (chosen === "chosenVariant") {
      const proof = branch.indexOf("requireVerifiedCurrentProfit(variant.conservativeProfitBeforeGasWei)");
      assert.ok(proof >= 0 && proof < fees, "each selected size needs its own proof before fee pricing");
    }
    const prepared = branch.slice(prepare, branch.indexOf("validate, signTransaction", prepare));
    assert.match(prepared, new RegExp(`data: ${chosen}\\.data`));
    assert.match(prepared, new RegExp(`conservativeProfitBeforeGasWei: ${chosen}\\.conservativeProfitBeforeGasWei`));
  });
}
test("all nine CURRENT holds accumulate without wallet work or a synthetic journal stage", async t => runHeld(t, branches()));

function unifiedFixture() {
  const { key, borrower } = runner.V3_TARGETS[0];
  const params = { isAaveV3: true, target: address("POOL"), borrower, debtToken: address("WETH"), collateralToken: address("WEETH"),
    collateralReserveId: 0, debtReserveId: 0, minCollateralSeized: 2n * W, swapKind: 2, swapTarget: address("CURVE"),
    swapSpender: address("CURVE"), uniFee: 0, curveI: 1, curveJ: 0, minDebtTokenOut: 101n * W / 100n, minProfitDebtToken: W / 100n };
  return { key, row: row(borrower, "readyExecuteMorphoCalldata", runner.UNIFIED_IFACE.encodeFunctionData("executeMorpho", [W, params])) };
}
function twoKFixture(liquidatableNow = true) {
  // Synthetic eligibility only; exact same-asset plan from the current #2K producer.
  const key = "target2K_AaveV3_WETH_WETH_0x7a05", borrower = "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3";
  const params = { isAaveV3: true, target: address("POOL"), borrower, debtToken: address("WETH"), collateralToken: address("WETH"),
    collateralReserveId: 0, debtReserveId: 0, minCollateralSeized: 0, swapKind: 0, swapTarget: ZERO,
    swapSpender: ZERO, uniFee: 0, curveI: 0, curveJ: 0, minDebtTokenOut: 0, minProfitDebtToken: W / 100n };
  return { key, row: { rank: "#2K", user: borrower, pool: address("POOL"), observationOnly: false, armed: true,
    liquidatableNow, executableNow: liquidatableNow,
    readyExecuteMorphoCalldata: runner.UNIFIED_IFACE.encodeFunctionData("executeMorpho", [5400000000000000000n, params]) } };
}
async function runUnified(t, { fixture = unifiedFixture(), rejectFullSize = false, expensiveGas = false, feeOverride } = {}) {
  const targets = { [fixture.key]: fixture.row }, approved = batch();
  if (expensiveGas) approved.caps.maxExecutionSpendWei = W.toString();
  const state = { prepared: null, intent: null, signs: 0, sends: 0, nonces: 0 };
  const feeSpy = t.mock.method(guard, "buildFees", feeOverride || guard.buildFees);
  t.mock.method(guard, "reconcileWallet", async () => {});
  const executionSpy = t.mock.method(guard, "executeGuarded", async options => {
    state.prepared = await options.prepare(); state.intent = options.intent;
    return { stage: "PREPARED" }; // Stop before signing; no wallet/journal writes.
  });
  const pinned = { pin: { ...PIN, baseFeePerGas: expensiveGas ? "100000000000" : PIN.baseFeePerGas }, evidence: {},
    assertUsable() {}, recheck: async () => {}, estimateGas: t.mock.fn(async () => 100000n),
    nonce: async account => { state.nonces++; assert.equal(account, guard.MAIN_ACCOUNT); return "0x0"; },
    send: async () => { state.sends++; assert.fail("offline only"); },
    call: t.mock.fn(async call => {
      if (call.to === address("CURVE")) {
        const [, , input] = runner.CURVE_IFACE.decodeFunctionData("get_dy", call.data);
        return runner.CURVE_IFACE.encodeFunctionResult("get_dy", [input * 101n / 200n]);
      }
      assert.equal(call.to, runner.DEPLOYED_EXECUTOR);
      const [flash] = runner.UNIFIED_IFACE.decodeFunctionData("executeMorpho", call.data);
      if (rejectFullSize && flash === W) throw new guard.ExecutionError("CALL_REVERTED");
      return "0x";
    }) };
  const checkOnce = t.mock.fn(async options => ({ pin: pinned.pin, targets: options.m1Only ? {} : targets }));
  const out = await runner.runPass({ execute: true, argv: ["--no-write"], batch: approved, now: () => NOW, pinned,
    loadMorphoBatch: () => assert.fail("Unified must not load another batch"),
    signTransaction: async () => { state.signs++; assert.fail("offline preparation only"); },
    checkOnce });
  assert.equal(state.signs, 0); assert.equal(state.sends, 0);
  return { out, state, feeSpy, executionSpy, fixture, approved, pinned, checkOnce };
}

test("Unified WETH: on-chain floor is enforced after repayment and before owner transfer", () => {
  const contract = fs.readFileSync(path.resolve(__dirname, "../../exploits/liquidation-bot/src/AaveV4FlashLoanLiquidator.sol"), "utf8");
  const execute = contract.slice(contract.indexOf("function executeMorpho("), contract.indexOf("function onMorphoFlashLoan("));
  assert.match(execute, /IMorphoMinimal\(MORPHO_BLUE\)\.flashLoan\(params\.debtToken, flashAmount, abi\.encode\(params\)\);[\s\S]*uint256 profit = IERC20Minimal\(params\.debtToken\)\.balanceOf\(address\(this\)\);\s*require\(profit >= params\.minProfitDebtToken, "profit below minimum"\);\s*if \(profit > 0\) _safeTransfer\(params\.debtToken, owner, profit\);/);
  assert.match(contract, /require\(debtBalance >= assets \+ p\.minProfitDebtToken, "insufficient debt token"\);/);
});
for (const rejectFullSize of [false, true]) {
  test(`Unified WETH: ${rejectFullSize ? "scaled chosen" : "original"} variant floor prices fees and reaches final prepare gate`, async t => {
    const { out, state, feeSpy, approved, pinned } = await runUnified(t, { rejectFullSize });
    assert.equal(out.fired, true);
    const [flash, chosen] = runner.UNIFIED_IFACE.decodeFunctionData("executeMorpho", state.prepared.transaction.data);
    const floor = rejectFullSize ? W / 200n : W / 100n;
    assert.equal(flash, rejectFullSize ? W / 2n : W); assert.equal(chosen.minProfitDebtToken, floor);
    assert.equal(feeSpy.mock.callCount(), 1);
    assert.deepEqual(feeSpy.mock.calls[0].arguments, [100000n, pinned.pin.baseFeePerGas, runner.validateAuthorization(approved, NOW), floor]);
    assert.equal(state.prepared.conservativeProfitBeforeGasWei, floor.toString());
    assert.equal(state.intent.minProfitBeforeGasRaw, floor.toString());
    const tx = state.prepared.transaction;
    assert.ok(tx.maxPriorityFeePerGas > guard.buildFeePolicy(tx.gasLimit, pinned.pin.baseFeePerGas, state.prepared.caps).maxPriorityFeePerGas);
    assert.ok(floor > tx.gasLimit * tx.maxFeePerGas);
  });
}
test("Unified WETH: floor below actual dynamic gas budget holds unsigned with the existing reason", async t => {
  const { out, state, executionSpy, fixture } = await runUnified(t, { expensiveGas: true });
  assert.equal(out.fired, false); assert.equal(out.summary.armed, false);
  assert.deepEqual(out.summary.preflightFailures, [{ targetId: fixture.key, reason: "PROFIT_FLOOR_BELOW_GAS_BUDGET" }]);
  assert.equal(executionSpy.mock.callCount(), 0); assert.equal(state.nonces, 0);
});
test("Unified WETH: retained floor check independently rejects an over-budget fee envelope", async t => {
  const { out, executionSpy, fixture } = await runUnified(t, {
    feeOverride: () => ({ gasLimit: 120000n, maxFeePerGas: W, maxPriorityFeePerGas: 1n }) });
  assert.equal(out.fired, false);
  assert.deepEqual(out.summary.preflightFailures, [{ targetId: fixture.key, reason: "PROFIT_FLOOR_BELOW_GAS_BUDGET" }]);
  assert.equal(executionSpy.mock.callCount(), 0);
});

test("2K CURRENT: exact synthetic eligible plan reaches actual prepare with the 0.01 WETH floor", async t => {
  const { out, state, feeSpy, executionSpy, fixture, approved, pinned } = await runUnified(t, { fixture: twoKFixture() });
  assert.equal(out.fired, true); assert.equal(out.summary.ok, true); assert.equal(out.summary.armed, false);
  assert.equal(out.summary.mode, "EXECUTE_IF_LIQUIDATABLE"); assert.equal(out.summary.candidateCount, 1);
  assert.equal(out.summary.preflightFailures, undefined); assert.deepEqual(out.summary.execution, { stage: "PREPARED" });
  assert.equal(executionSpy.mock.callCount(), 1); assert.equal(state.nonces, 1);
  const tx = state.prepared.transaction, floor = W / 100n;
  const [flash, chosen] = runner.UNIFIED_IFACE.decodeFunctionData("executeMorpho", tx.data);
  assert.equal(fixture.key, "target2K_AaveV3_WETH_WETH_0x7a05");
  assert.equal(flash, 5400000000000000000n); assert.equal(chosen.isAaveV3, true);
  assert.deepEqual([chosen.target, chosen.borrower, chosen.debtToken, chosen.collateralToken].map(v => v.toLowerCase()),
    [address("POOL"), "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3", address("WETH"), address("WETH")]);
  assert.deepEqual([chosen.collateralReserveId, chosen.debtReserveId, chosen.minCollateralSeized, chosen.swapKind,
    chosen.uniFee, chosen.curveI, chosen.curveJ, chosen.minDebtTokenOut], Array(8).fill(0n));
  assert.equal(chosen.swapTarget, ZERO); assert.equal(chosen.swapSpender, ZERO); assert.equal(chosen.minProfitDebtToken, floor);
  assert.equal(feeSpy.mock.callCount(), 1);
  assert.deepEqual(feeSpy.mock.calls[0].arguments, [100000n, pinned.pin.baseFeePerGas, runner.validateAuthorization(approved, NOW), floor]);
  assert.equal(state.prepared.conservativeProfitBeforeGasWei, floor.toString());
  assert.deepEqual(state.intent, { targetId: fixture.key, to: runner.DEPLOYED_EXECUTOR, profitToken: address("WETH"),
    pinHash: PIN.hash, simulatedProfitBeforeGasRaw: null, minProfitBeforeGasRaw: floor.toString() });
  assert.deepEqual(tx, { type: 2, chainId: 1, nonce: 0, to: runner.DEPLOYED_EXECUTOR,
    data: fixture.row.readyExecuteMorphoCalldata, value: 0n, ...feeSpy.mock.calls[0].result });
  const call = { from: guard.MAIN_ACCOUNT, to: tx.to, data: tx.data };
  assert.deepEqual(pinned.call.mock.calls.map(c => c.arguments), [[call]], "same-asset execution performs no swap quote");
  assert.deepEqual(pinned.estimateGas.mock.calls.map(c => c.arguments), [[call]]);
  assert.ok(floor > tx.gasLimit * tx.maxFeePerGas);
  // PREPARED spy only: no full guard, journal, real balance or live readiness claim.
});

test("2K CURRENT: identical healthy plan remains armed waiting without transaction work", async t => {
  const eligible = twoKFixture(), healthy = twoKFixture(false);
  assert.equal(healthy.row.readyExecuteMorphoCalldata, eligible.row.readyExecuteMorphoCalldata);
  assert.equal(runner.selectCandidates({ targets: { [eligible.key]: eligible.row } }).length, 1);
  assert.equal(healthy.row.liquidatableNow, false); assert.equal(healthy.row.executableNow, false);
  const { out, state, feeSpy, executionSpy, pinned, checkOnce } = await runUnified(t, { fixture: healthy });
  assert.equal(out.fired, false); assert.equal(out.summary.ok, true); assert.equal(out.summary.armed, true);
  assert.equal(out.summary.mode, "EXECUTE_IF_LIQUIDATABLE"); assert.equal(out.summary.candidateCount, 0);
  assert.equal(out.summary.partial, false); assert.equal(out.summary.reason, undefined);
  assert.equal(out.summary.preflightFailures, undefined); assert.equal(out.summary.execution, undefined);
  assert.equal(checkOnce.mock.callCount(), 2); assert.equal(checkOnce.mock.calls[0].arguments[0].m1Only, true);
  assert.deepEqual((await checkOnce.mock.calls[0].result).targets, {});
  assert.equal(checkOnce.mock.calls[1].arguments[0].m1Only, undefined);
  assert.deepEqual((await checkOnce.mock.calls[1].result).targets, { [healthy.key]: healthy.row });
  assert.equal(pinned.call.mock.callCount(), 0); assert.equal(pinned.estimateGas.mock.callCount(), 0);
  assert.equal(feeSpy.mock.callCount(), 0); assert.equal(executionSpy.mock.callCount(), 0);
  assert.deepEqual(state, { prepared: null, intent: null, signs: 0, sends: 0, nonces: 0 });
  // Safe top-level reconciliation/authorization is allowed; eligibility still gates preparation.
});

for (const [label, maxFeePerGas] of [["over-budget", W], ["zero-net", 100000000000n]]) {
  test(`2K CURRENT: ${label} fee envelope rejects before prepare or nonce`, async t => {
    const { out, state, feeSpy, executionSpy, fixture, pinned, approved } = await runUnified(t, { fixture: twoKFixture(),
      feeOverride: () => ({ gasLimit: 100000n, maxFeePerGas, maxPriorityFeePerGas: 1n }) });
    assert.equal(out.fired, false); assert.equal(out.summary.ok, true); assert.equal(out.summary.armed, false);
    assert.equal(out.summary.candidateCount, 1); assert.equal(out.summary.reason, "NO_CANDIDATE_PASSED_PREFLIGHT");
    assert.deepEqual(out.summary.preflightFailures, [{ targetId: fixture.key, reason: "PROFIT_FLOOR_BELOW_GAS_BUDGET" }]);
    assert.ok(feeSpy.mock.callCount() > 0);
    for (const call of feeSpy.mock.calls) {
      assert.deepEqual(call.arguments, [100000n, pinned.pin.baseFeePerGas, runner.validateAuthorization(approved, NOW), W / 100n]);
    }
    assert.equal(executionSpy.mock.callCount(), 0); assert.equal(out.summary.execution, undefined);
    assert.deepEqual(state, { prepared: null, intent: null, signs: 0, sends: 0, nonces: 0 });
  });
}

const unifiedStart = SOURCE.indexOf('      requireThat(batch.targets.some(t => t.address?.toLowerCase() === candidate.target), "BATCH_TARGET_NOT_APPROVED");');
const UNIFIED_CURRENT = SOURCE.slice(unifiedStart, SOURCE.indexOf('    return finish({ armed: false, reason: "NO_CANDIDATE_PASSED_PREFLIGHT" });', unifiedStart));
test("Unified WETH: exact source orders verified variant floor before pricing and forwards chosen floor", () => {
  assert.ok(unifiedStart > 0);
  assert.match(UNIFIED_CURRENT, /const vp = variant\.params;\s*\/\/[^\n]*\n\s*requireVerifiedCurrentProfit\(vp\.minProfitDebtToken\);/);
  assert.match(UNIFIED_CURRENT, /fees = guard\.buildFees\(await pinned\.estimateGas\(call\), pinned\.pin\.baseFeePerGas, caps, vp\.minProfitDebtToken\);\s*requireThat\(vp\.minProfitDebtToken > fees\.gasLimit \* fees\.maxFeePerGas, "PROFIT_FLOOR_BELOW_GAS_BUDGET"\);\s*chosenVariant = variant;/);
  assert.match(UNIFIED_CURRENT, /data: chosenVariant\.data[\s\S]*conservativeProfitBeforeGasWei: chosenVariant\.params\.minProfitDebtToken\.toString\(\)/);
  assert.doesNotMatch(UNIFIED_CURRENT, /conservativeProfitBeforeGasWei: candidate\./);
});
for (const floor of [undefined, null, 0n]) {
  test(`Unified WETH: extracted real branch holds ${String(floor)} floor as PROFIT_UNVERIFIED with zero signer calls`, async t => {
    // A missing floor cannot pass uint256 ABI admission. Exercise the exact branch
    // source with a malformed variant, not an end-to-end collector fixture.
    const forbidden = () => assert.fail("missing floor must hold before fee/preparation/signing work");
    const feeSpy = t.mock.method(guard, "buildFees", forbidden), executeSpy = t.mock.method(guard, "executeGuarded", forbidden);
    const signer = t.mock.fn(forbidden), candidate = { id: "missing-unified-floor", target: address("POOL"), params: { minProfitDebtToken: floor } };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const branch = new AsyncFunction("candidate", "buildScaledUnifiedWethVariants", "requireVerifiedCurrentProfit", "guard", "pinned", "batch", "requireThat", "safeError", "signTransaction",
      `const preflightFailures = []; for (const unused of [candidate]) {\n${UNIFIED_CURRENT}\nreturn preflightFailures;`);
    const failures = await branch(candidate, () => [candidate], runner.requireVerifiedCurrentProfit, guard,
      { assertUsable() {} }, batch(), guard.requireThat, guard.safeError, signer);
    assert.deepEqual(failures, [{ targetId: candidate.id, reason: "PROFIT_UNVERIFIED" }]);
    assert.equal(feeSpy.mock.callCount(), 0); assert.equal(executeSpy.mock.callCount(), 0); assert.equal(signer.mock.callCount(), 0);
  });
}

for (const net of [-1n, 0n]) {
  test(`cod-2: positive before-gas profit but final net ${net} never invokes signer`, async t => {
    const base = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir();
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, "current-profit-hold-")), journalDir = path.join(root, "journal");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = { signs: 0, sends: 0 }, caps = { gasCap: 1000000n, spendCap: W, feeCap: null, dailyCap: 3n };
    const transaction = { type: 2, chainId: 1, nonce: 0, to: runner.M2_EXECUTOR, data: "0x1234", value: 0n,
      ...guard.buildFees(50000n, 1n, caps) };
    const profit = runner.requireVerifiedCurrentProfit(transaction.gasLimit * transaction.maxFeePerGas + net);
    await assert.rejects(guard.executeGuarded({ lockRoot: path.join(root, "locks"), journalDir, now: () => NOW,
      intent: { targetId: "offline-current-profit", to: runner.M2_EXECUTOR, profitToken: address("USDC") },
      prepare: async () => ({ transaction, caps, conservativeProfitBeforeGasWei: profit }), validate: async () => caps,
      signTransaction: async () => { state.signs++; return "0x"; }, sendRawTransaction: async () => { state.sends++; return "0x"; },
      receiptRpc: async () => null }), error => error.code === "PROFIT_NET_NONPOSITIVE");
    assert.deepEqual(state, { signs: 0, sends: 0 }); assert.equal(fs.existsSync(journalDir), false);
  });
}
