"use strict";

// Offline loop regressions, not live readiness evidence. Inject already-admitted
// synthetic candidates and the guard boundary into an import-inert runner copy.
// All fee/cap checks are real; IO, custody, signing and submission are forbidden.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { compileFunction } = require("node:vm");
const { createRequire } = require("node:module");
const guard = require("../lib/wallet-execution-guard.js");
const FILE = path.resolve(__dirname, "../execute-top-whale-trigger.js"), native = createRequire(FILE);
const SOURCE = fs.readFileSync(FILE, "utf8").replace(/^#![^\n]*\n/, "");
const denied = () => assert.fail("offline loop attempted IO, custody, signing or submission");
const NOW = Date.parse("2026-10-27T20:00:00Z"), W = 10n ** 18n;
const LOW = 1000000000000n, POSITIVE = 1000000000000000n, BREAK_EVEN = 270000000000000n;
const ZERO = "0x" + "00".repeat(20), PIN_HASH = "0x" + "11".repeat(32);

function load(retention = null) {
  const state = { reconciled: 0, guarded: 0, prepared: [], simulations: [], estimates: [], fees: [], nonces: 0, writes: [] };
  const injectedGuard = { ...guard,
    atomicJson: (file, value) => { assert.ok(retention, "unexpected status write"); state.writes.push({ file, value: structuredClone(value) }); },
    reconcileWallet: async () => { state.reconciled++; },
    buildFees: (...args) => { state.fees.push(args); return guard.buildFees(...args); },
    executeGuarded: async options => {
      state.guarded++;
      const prepared = await options.prepare(); state.prepared.push({ ...prepared, intent: options.intent });
      guard.validateTransaction(prepared.transaction, await options.validate());
      assert.ok(prepared.conservativeProfitBeforeGasWei > prepared.transaction.gasLimit * prepared.transaction.maxFeePerGas);
      return { stage: "OFFLINE_UNSIGNED", intent: options.intent };
    },
  };
  const fixtureFs = new Proxy({}, { get: (_, key) => {
    if (retention && ["existsSync", "readFileSync"].includes(key)) return file => {
      assert.equal(file, retention.observationFile);
      return key === "existsSync" ? true : JSON.stringify(retention.previous);
    };
    return denied;
  } });
  const module = { exports: {} }, req = name => name === "node:fs" ? fixtureFs :
    name === "./lib/wallet-execution-guard.js" ? injectedGuard : name === "./lib/m32-attended-call.cjs" ? denied() :
    name === "./watch-top-whale-triggers.js" && retention ? { ...native(name), checkOnce: retention.collect } : native(name);
  const injection = `
    module.exports.fixture = { M2_EXEC_IFACE, PENDLE_PT_EXEC_IFACE, MORPHO_EXEC_IFACE, UNIVERSAL_EULER_EXEC_IFACE,
      UNIVERSAL_EXEC_IFACE, UNIV4_FLASH_EXEC_IFACE, YN_ARB_EXEC_IFACE, CURVE_EXCHANGE_IFACE, QUOTER_IFACE, CURVE_IFACE,
      M2_EXECUTOR, PENDLE_PT_EXECUTOR, MORPHO_EXECUTOR, ETH_UNIVERSAL_EULER_EXECUTOR, UNIVERSAL_EXECUTOR,
      UNIV4_FLASH_EXECUTOR, YN_ARB_EXECUTOR, BALANCER_VAULT, MORPHO_BLUE, WETH, USDC, REUSD, WSTETH,
      M2_ORACLE, M1_IRM, M2_BORROWER, CURVE_REUSD_USDC, WST_PATH, UNI_ROUTER, QUOTER_V2, CURVE_YNETHX_WETH,
      PENDLE_ROUTER_V4_IFACE, SYRUP_USDC, KYBER_ROUTER, M7_EXEC_IFACE, EULER_EVK_EXEC_IFACE,
      A5_SPOKE, USDG, SYRUP_USDG, E3_BORROWER, E3_LIABILITY_VAULT, E3_COLL_VAULT, YNETHX,
      M8_BORROWER, PT_USDE, PT_ORACLE, PENDLE_YT, PENDLE_SY, USDE, DAI,
      M14_BORROWER, M14_PT, M14_ORACLE, M14_YT, M14_SY, USDAT, CURVE_USDAT_USDC,
      M29_BORROWER, M29_PT, M29_ORACLE, M29_YT, M29_SY, SUSDE, CURVE_ROUTER_NG, CURVE_ROUTER_NG_IFACE,
      POOL, WEETH, CURVE, M32_BORROWER };
    module.exports.injectCandidates = rows => { selectCandidates = status => status.fixtureRows ? rows : []; };
    module.exports.retainFixture = retainExecutorObservation;
  `;
  compileFunction(SOURCE + injection, ["require", "module", "exports", "__dirname", "__filename", "fetch"], { filename: FILE })
    (req, module, module.exports, path.dirname(FILE), FILE, denied);
  return { api: module.exports, c: module.exports.fixture, state };
}

function candidateFixture(f, route, edits = {}) {
  const c = f.c, market = { loanToken: c.USDC, collateralToken: c.REUSD, oracle: c.M2_ORACLE, irm: c.M1_IRM, lltv: 915000000000000000n };
  const common = { ...market, borrower: c.M2_BORROWER, seizedAssets: 1000n, swapTarget: c.CURVE_REUSD_USDC, minLoanOut: 101000n };
  const swap = c.CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, 1000n, 100000n]);
  let iface, plan, data, executor, kind, id, amount, extras = {};
  if (route === "M2") {
    iface = c.M2_EXEC_IFACE; plan = common; data = iface.encodeFunctionData("execute", [plan, swap]);
    executor = c.M2_EXECUTOR; kind = "MORPHO_BLUE_M2"; id = "targetM2_Morpho_reUSD_USDC"; amount = call => iface.decodeFunctionData("execute", call)[0].seizedAssets;
    extras = { seizedAssets: 1000n, minLoanOut: plan.minLoanOut, minProfitUsdc: 1000n, minOutUsdc: 100000n };
  } else if (route === "PT") {
    iface = c.PENDLE_PT_EXEC_IFACE; plan = { ...common, pendleYt: c.REUSD, pendleSy: c.REUSD, redeemedToken: c.REUSD };
    data = iface.encodeFunctionData("execute", [plan, swap]); executor = c.PENDLE_PT_EXECUTOR;
    kind = "MORPHO_PENDLE_PT_REDEEM"; id = "targetM29_Morpho_PT_srUSDe_USDC"; amount = call => iface.decodeFunctionData("execute", call)[0].seizedAssets;
  } else if (route === "WST") {
    iface = c.MORPHO_EXEC_IFACE; data = iface.encodeFunctionData("execute", [
      { ...market, loanToken: c.WETH, collateralToken: c.WSTETH }, c.M2_BORROWER, 1000n, 0n, W / 25n, W, c.UNI_ROUTER, c.WST_PATH,
    ]);
    executor = c.MORPHO_EXECUTOR; kind = "MORPHO_BLUE_WSTETH"; id = "targetM11_Morpho_weETH_WETH";
    amount = call => iface.decodeFunctionData("execute", call)[2];
    extras = { seizedAssets: 1000n, minProfitWeth: W / 25n, minOutWeth: W, profitToken: c.WETH };
  } else if (route === "Euler") {
    iface = c.UNIVERSAL_EULER_EXEC_IFACE; plan = { loanToken: c.USDC, liabilityVault: c.MORPHO_BLUE, collateralVault: c.REUSD,
      underlyingCollateral: c.REUSD, violator: c.M2_BORROWER, repayAssets: 1000n, maxRepayAssets: 1000n, minYieldShares: 1n,
      unwindKind: 1, swapTarget: c.CURVE_REUSD_USDC, curveI: 0, curveJ: 1, swapPath: "0x", minLoanOut: 2000n };
    data = iface.encodeFunctionData("execute", [plan]); executor = c.ETH_UNIVERSAL_EULER_EXECUTOR;
    kind = "UNIVERSAL_EULER_EVK_LIQUIDATION"; id = "targetE7_EulerV2_WETH_ezETH"; amount = call => iface.decodeFunctionData("execute", call)[0].repayAssets;
  } else if (route === "Universal") {
    iface = c.UNIVERSAL_EXEC_IFACE; plan = { ...market, mode: 0, flashAmount: 1000n, borrower: c.M2_BORROWER, seizedAssets: 1000n,
      fluidVault: ZERO, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n, colPerUnitDebt: 0n,
      token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
      approveToken1: c.REUSD, target1: c.CURVE_REUSD_USDC, data1: swap, approveToken2: ZERO, target2: ZERO, data2: "0x", minProfit: 1000n };
    data = iface.encodeFunctionData("execute", [plan]); executor = c.UNIVERSAL_EXECUTOR;
    kind = "UNIVERSAL_FLUID_MORPHO_LIQUIDATION"; id = "targetM34_Morpho_beraSTONE_WETH"; amount = call => iface.decodeFunctionData("execute", call)[0].seizedAssets;
  } else if (route === "UniV4") {
    iface = c.UNIV4_FLASH_EXEC_IFACE; plan = { mode: 0, target: c.MORPHO_BLUE, collateralVault: ZERO, collateralReserveId: 0, debtReserveId: 0,
      borrower: c.M2_BORROWER, debtAsset: c.USDC, collateralAsset: c.REUSD, flashAmount: 1000n, debtToCover: 1000n,
      minCollateralSeized: 1000n, minSwapOut: 2000n, minProfit: 1000n, deadline: 9999999999n,
      poolKey: { currency0: c.USDC, currency1: c.REUSD, fee: 500, tickSpacing: 10, hooks: ZERO }, zeroForOne: true };
    data = iface.encodeFunctionData("execute", [plan]); executor = c.UNIV4_FLASH_EXECUTOR;
    kind = "UNIV4_FLASH_LIQUIDATION"; id = "targetE2_EulerV2_USDC_syrupUSDC_0x9f09"; amount = call => iface.decodeFunctionData("execute", call)[0].flashAmount;
  } else if (route === "YN") {
    iface = c.YN_ARB_EXEC_IFACE; plan = { loanToken: c.WETH, vaultToken: c.REUSD, curvePool: c.CURVE_YNETHX_WETH,
      curveI: 1, curveJ: 0, flashAmount: W, minSharesOut: W, minLoanOut: W + W / 100n };
    data = iface.encodeFunctionData("execute", [plan]); executor = c.YN_ARB_EXECUTOR;
    kind = "CURVE_BUY_VAULT_REDEEM_YN"; id = "curveBuyVaultRedeemYnETHx"; amount = call => iface.decodeFunctionData("execute", call)[0].flashAmount;
    extras = { flashAmount: W, minSharesOut: W, minProfitWeth: W / 100n, profitToken: c.WETH };
  } else assert.fail("unknown fixture route");
  const candidate = Object.freeze({ id, kind, executor, data, target: c.MORPHO_BLUE, borrower: c.M2_BORROWER,
    profitToken: c.USDC, minProfitRaw: 1000n, conservativeProfitBeforeGasWei: LOW,
    variantProfitByBps: Object.freeze(route === "YN" ? { 100000: LOW, 80000: POSITIVE } : { 10000: LOW, 5000: POSITIVE }), ...extras, ...edits });
  return { candidate, iface, amount, route };
}

async function run(f, row, options = {}) {
  const { api, c, state } = f, { candidate, iface, amount } = row;
  if (!options.nomination) api.injectCandidates([candidate]);
  const base = { schema: "live-execution-batch/v1", approved: true, approvedAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(),
    chainId: 1, chain: "ethereum", account: { address: guard.MAIN_ACCOUNT } };
  const batch = { ...base, targets: api.REQUIRED_TARGETS.map(address => ({ address })),
    actions: ["liquidator.executeMorpho(uint256 flashAmount, UnifiedLiquidationParams params) when net > 0"],
    caps: { maxExecutionGasLimit: 1500000, maxExecutionSpendWei: "2000000000000000", signedExecutionsPerDay: 3,
      slippageFloor: "minDebtTokenOut >= quoted * 0.995; minProfitDebtToken > 0", principalAtRisk: "zero (atomic fixture)" } };
  const morphoBatch = { ...base, targets: [c.MORPHO_EXECUTOR, c.BALANCER_VAULT, candidate.executor].map(address => ({ address })),
    actions: ["executor.execute(MarketParams, borrower, seizedAssets, repaidShares, minProfitWei, minOut, router, routerSwapData) on verified trigger"],
    caps: { maxGasLimitPerTransaction: options.gasCap ?? 1500000, maxNativeSpendPerTransactionWei: options.spendCap ?? "2000000000000000", signedExecutionsPerDay: 3 } };
  const pin = { number: 100, hash: PIN_HASH, timestamp: NOW / 1000 - 10, baseFeePerGas: "100000000" };
  const pinned = { pin, assertUsable() {}, recheck: async () => {}, nonce: async () => { state.nonces++; return 0; },
    send: denied, receipt: denied, call: async call => {
      if (call.to === c.CURVE_REUSD_USDC || call.to === c.CURVE_YNETHX_WETH) {
        const input = c.CURVE_IFACE.decodeFunctionData("get_dy", call.data)[2];
        return c.CURVE_IFACE.encodeFunctionResult("get_dy", [call.to === c.CURVE_YNETHX_WETH ? input :
          input * (options.tightenPartialQuote && input < 1000n ? 110n : 100n)]);
      }
      if (call.to === c.QUOTER_V2) {
        const input = c.QUOTER_IFACE.decodeFunctionData("quoteExactInput", call.data)[1];
        return c.QUOTER_IFACE.encodeFunctionResult("quoteExactInput", [W * input / 1000n, [], [], 100000n]);
      }
      assert.equal(call.to, candidate.executor); state.simulations.push({ ...call, amount: amount(call.data) });
      return iface.encodeFunctionResult("execute", iface.getFunction("execute").outputs.length ? [10000n] : []);
    }, estimateGas: async call => { state.estimates.push(call); return 1000000n; } };
  return api.runPass({ execute: true, batch, morphoBatch, pinned, now: () => NOW, writeOut: false, signTransaction: denied,
    checkOnce: async collectOptions => ({ pin: { ...pin, chainId: 1 },
      targets: !collectOptions.m1Only && options.nomination ? { [options.nomination.id]: options.nomination.row } : {},
      fixtureRows: !collectOptions.m1Only }) });
}

const ROUTES = ["M2", "PT", "WST", "Euler", "Universal", "UniV4", "YN"];
for (const route of ROUTES) test(`${route}: simulation-positive but net-negative first size yields to independently proven smaller size`, async () => {
  const f = load(), row = candidateFixture(f, route), original = row.candidate.data;
  const out = await run(f, row);
  assert.equal(out.fired, true); assert.equal(f.state.guarded, 1); assert.equal(f.state.prepared.length, 1);
  assert.deepEqual(f.state.simulations.map(v => v.amount), route === "YN" ? [10n * W, 8n * W] : [1000n, 500n]);
  assert.deepEqual(f.state.fees.map(args => args[3]), [LOW, POSITIVE]);
  const chosen = f.state.prepared[0], tx = chosen.transaction;
  assert.equal(tx.data, f.state.simulations[1].data); assert.equal(tx.data, f.state.estimates[1].data);
  assert.equal(chosen.conservativeProfitBeforeGasWei, POSITIVE);
  assert.notEqual(tx.data, original); assert.equal(row.candidate.data, original); assert.equal(row.candidate.conservativeProfitBeforeGasWei, LOW);
  assert.deepEqual({ gasLimit: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }, guard.buildFees(...f.state.fees[1]));
  const floor = route === "M2" ? f.api.buildScaledM2Variants(row.candidate)[1].minProfitUsdc : route === "WST" ? W / 50n : route === "YN" ? W * 8n / 100n : 500n;
  assert.equal(chosen.intent.minProfitBeforeGasRaw, floor.toString()); assert.equal(tx.to, row.candidate.executor);
});

for (const route of ROUTES) test(`${route}: unknown, zero, negative and break-even size profits never enter prepare/sign`, async () => {
  for (const profit of [null, 0n, -1n, LOW, BREAK_EVEN]) {
    const f = load(), variantProfitByBps = Object.freeze(Object.fromEntries([10000, 5000, 2500, 100000, 80000, 50000, 30000, 20000].map(bps => [bps, profit])));
    const out = await run(f, candidateFixture(f, route, { variantProfitByBps }));
    assert.equal(out.fired, false); assert.equal(out.summary.reason, "NO_CANDIDATE_PASSED_PREFLIGHT");
    assert.equal(f.state.guarded, 0); assert.equal(f.state.prepared.length, 0); assert.equal(f.state.nonces, 0);
    assert.equal(f.state.reconciled, profit === LOW || profit === BREAK_EVEN ? 1 : 0);
    assert.equal(out.summary.preflightFailures[0].reason, profit === LOW || profit === BREAK_EVEN ? "PROFIT_NET_NONPOSITIVE" : "PROFIT_UNVERIFIED");
  }
});

for (const route of ROUTES) test(`${route}: absent per-size proof cannot inherit a rejected base profit`, async () => {
  const f = load(), row = candidateFixture(f, route, { variantProfitByBps: undefined });
  const out = await run(f, row);
  assert.equal(out.fired, false); assert.equal(f.state.guarded, 0); assert.equal(f.state.nonces, 0);
  assert.deepEqual(f.state.simulations.map(v => v.amount), route === "YN" ? [W] : [1000n]);
  assert.deepEqual(f.state.fees.map(args => args[3]), [LOW]);
});

test("M2 tightened exact-size slippage floor is simulated and prepared without mutating the base", async () => {
  const f = load(), row = candidateFixture(f, "M2"), original = row.candidate.data;
  const out = await run(f, row, { tightenPartialQuote: true }); assert.equal(out.fired, true);
  const chosen = f.state.prepared[0], decoded = f.c.M2_EXEC_IFACE.decodeFunctionData("execute", chosen.transaction.data);
  const swap = f.c.CURVE_EXCHANGE_IFACE.decodeFunctionData("exchange", decoded[1]);
  assert.equal(swap[2], 500n); assert.equal(swap[3], 53900n);
  assert.equal(chosen.transaction.data, f.state.simulations[1].data); assert.equal(chosen.conservativeProfitBeforeGasWei, POSITIVE);
  assert.equal(row.candidate.data, original);
});

test("per-size positive evidence does not bypass gas/spend caps or explicit unknown base-map entries", async () => {
  for (const options of [{ gasCap: 1000000 }, { spendCap: "1" }]) {
    const f = load(), out = await run(f, candidateFixture(f, "M2"), options);
    assert.equal(out.fired, false); assert.equal(f.state.guarded, 0); assert.equal(f.state.nonces, 0);
  }
  const f = load(), row = candidateFixture(f, "M2", { conservativeProfitBeforeGasWei: undefined,
    variantProfitByBps: Object.freeze({ 10000: null, 5000: POSITIVE }) });
  assert.equal((await run(f, row)).fired, true);
  assert.deepEqual(f.state.simulations.map(v => v.amount), [500n]); assert.equal(f.state.prepared[0].transaction.data, f.state.simulations[0].data);
});

test("legacy candidates still missing native valuation remain held before wallet reconciliation", async () => {
  for (const route of ROUTES) {
    const f = load(), out = await run(f, candidateFixture(f, route, { conservativeProfitBeforeGasWei: undefined, variantProfitByBps: undefined }));
    assert.equal(out.fired, false); assert.equal(out.summary.preflightFailures[0].reason, "PROFIT_UNVERIFIED");
    assert.equal(f.state.reconciled, 0); assert.equal(f.state.guarded, 0); assert.equal(f.state.simulations.length, 0);
  }
  // The two unscaled legacy routes have the same no-valuation admission hold.
  for (const [kind, ifaceName] of [["MORPHO_BLUE_M7", "M7_EXEC_IFACE"], ["EULER_EVK_E1", "EULER_EVK_EXEC_IFACE"]]) {
    const f = load(), iface = f.c[ifaceName];
    const plan = { loanToken: f.c.USDC, collateralToken: f.c.REUSD, oracle: f.c.M2_ORACLE, irm: f.c.M1_IRM,
      lltv: 915000000000000000n, borrower: f.c.M2_BORROWER, seizedAssets: 1000n, intermediateToken: f.c.WETH,
      curvePool: f.c.CURVE_REUSD_USDC, curveI: 0, curveJ: 1, minLoanOut: 2000n,
      liabilityVault: f.c.MORPHO_BLUE, collateralVault: f.c.REUSD, underlyingCollateral: f.c.REUSD,
      violator: f.c.M2_BORROWER, repayAssets: 1000n, minYieldShares: 1n, unwindKind: 1, swapTarget: f.c.CURVE_REUSD_USDC };
    const row = candidateFixture(f, "M2", { kind, data: iface.encodeFunctionData("execute", [plan]),
      conservativeProfitBeforeGasWei: undefined, variantProfitByBps: undefined });
    const out = await run(f, row);
    assert.equal(out.fired, false); assert.equal(out.summary.preflightFailures[0].reason, "PROFIT_UNVERIFIED");
    assert.equal(f.state.reconciled, 0); assert.equal(f.state.guarded, 0);
  }
});

for (const route of ROUTES) test(`${route}: effective supported size proof, not the base scalar, controls wallet admission`, async () => {
  for (const base of [undefined, null, 0n]) {
    const f = load(), bps = route === "YN" ? 80000 : 5000;
    const row = candidateFixture(f, route, { conservativeProfitBeforeGasWei: base,
      variantProfitByBps: Object.freeze({ 10000: null, [bps]: POSITIVE }) });
    const out = await run(f, row);
    assert.equal(out.fired, true); assert.equal(f.state.reconciled, 1);
    assert.deepEqual(f.state.simulations.map(v => v.amount), route === "YN" ? [8n * W] : [500n]);
    assert.deepEqual(f.state.fees.map(args => args[3]), [POSITIVE]);
    assert.equal(f.state.prepared[0].conservativeProfitBeforeGasWei, POSITIVE);
    assert.equal(f.state.prepared[0].transaction.data, f.state.simulations[0].data);
    assert.equal(row.candidate.conservativeProfitBeforeGasWei, base);
  }
  for (const variantProfitByBps of [null, {}, { 10000: null }, { 10000: 0n }, { 1234: POSITIVE }, { 9500: POSITIVE }]) {
    const f = load(), out = await run(f, candidateFixture(f, route, { conservativeProfitBeforeGasWei: POSITIVE, variantProfitByBps }));
    assert.equal(out.fired, false); assert.equal(out.summary.preflightFailures[0].reason, "PROFIT_UNVERIFIED");
    assert.equal(f.state.reconciled, 0); assert.equal(f.state.guarded, 0); assert.equal(f.state.simulations.length, 0);
  }
});

test("admission uses the opt-in M2/PT ladders, not a separate list of allowed profit keys", async () => {
  for (const route of ["M2", "PT"]) {
    const f = load(), row = candidateFixture(f, route, { conservativeProfitBeforeGasWei: undefined,
      useFullBpsLadder: true, variantProfitByBps: { 9500: POSITIVE } });
    assert.equal((await run(f, row)).fired, true); assert.equal(f.state.reconciled, 1);
    assert.deepEqual(f.state.simulations.map(v => v.amount), [950n]);
    assert.equal(f.state.prepared[0].transaction.data, f.state.simulations[0].data);
    assert.equal(f.state.prepared[0].conservativeProfitBeforeGasWei, POSITIVE);
  }
});

test("malformed calldata and unsupported full-share records cannot borrow profit-map admission", async () => {
  for (const route of ROUTES) for (const data of ["0x1234", candidateFixture(load(), route).candidate.data + "00"]) {
    const f = load(), row = candidateFixture(f, route, { data, conservativeProfitBeforeGasWei: POSITIVE });
    const out = await run(f, row);
    assert.equal(out.fired, false); assert.equal(out.summary.preflightFailures[0].reason, "EXECUTION_CALLDATA_INVALID");
    assert.equal(f.state.reconciled, 0); assert.equal(f.state.guarded, 0);
  }
  for (const fullRepaidSharesVariant of [{ conservativeProfitBeforeGasWei: POSITIVE }, { data: "0x1234", conservativeProfitBeforeGasWei: POSITIVE }]) {
    const f = load(), out = await run(f, candidateFixture(f, "M2", { fullRepaidSharesVariant, variantProfitByBps: null }));
    assert.equal(out.fired, false); assert.equal(f.state.reconciled, 0);
  }
});

test("opaque, foreign fixed Pendle, malformed-inner and over-cap YN sizes stay held before reconciliation", async () => {
  for (const route of ["M2", "PT", "Universal"]) for (const swapKind of ["opaque", "malformed", "fixed-pendle"]) {
    const f = load(), base = candidateFixture(f, route), decoded = base.iface.decodeFunctionData("execute", base.candidate.data);
    let swap = swapKind === "opaque" ? "0xe21fd0e9" + "00".repeat(64) : "0x3df02124";
    if (swapKind === "fixed-pendle") swap = f.c.PENDLE_ROUTER_V4_IFACE.encodeFunctionData("swapExactPtForToken", [
      f.c.M2_EXECUTOR, f.c.REUSD, 1000n, [f.c.USDC, 100000n, f.c.REUSD, f.c.M2_EXECUTOR, [2, f.c.KYBER_ROUTER, "0x123456", false]],
      [ZERO, 0, [], [], "0x"],
    ]);
    const data = route === "Universal" ? base.iface.encodeFunctionData("execute", [{ ...decoded[0].toObject(), data1: swap }]) :
      base.iface.encodeFunctionData("execute", [decoded[0], swap]);
    const row = candidateFixture(f, route, { data, conservativeProfitBeforeGasWei: POSITIVE, variantProfitByBps: { 5000: POSITIVE } });
    assert.equal((await run(f, row)).fired, false); assert.equal(f.state.reconciled, 0); assert.equal(f.state.guarded, 0);
  }
  // Even the recognized M31 pair has no supported partial calldata until rebuilt;
  // a mere map entry must not trigger reconciliation or the denied HTTP fixture.
  const f = load(), base = candidateFixture(f, "M2"), plan = base.iface.decodeFunctionData("execute", base.candidate.data)[0].toObject();
  const m31 = candidateFixture(f, "M2", { id: "targetM31_Morpho_syrupUSDC_USDC", skipCurveQuote: true,
    data: base.iface.encodeFunctionData("execute", [{ ...plan, collateralToken: f.c.SYRUP_USDC, swapTarget: f.c.KYBER_ROUTER }, "0xe21fd0e9" + "00".repeat(64)]),
    conservativeProfitBeforeGasWei: POSITIVE, variantProfitByBps: { 5000: POSITIVE } });
  assert.equal((await run(f, m31)).fired, false); assert.equal(f.state.reconciled, 0);
  const yn = load(), row = candidateFixture(yn, "YN", { flashAmount: 10n * W, conservativeProfitBeforeGasWei: POSITIVE,
    variantProfitByBps: { 100000: POSITIVE, 80000: POSITIVE, 50000: POSITIVE } });
  assert.equal((await run(yn, row)).fired, false); assert.equal(yn.state.reconciled, 0);
});

function freezeTree(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeTree); Object.freeze(value); }
  return value;
}
test("restored Base/Aave observations remain incomplete and non-actionable beneath a fresh document", async () => {
  const oldPin = { chainId: 1, number: 10, hash: "0x" + "22".repeat(32), timestamp: NOW / 1000 - 7200,
    utc: new Date(NOW - 7200000).toISOString() };
  const basePin = { ...oldPin, chainId: 8453, number: 20, hash: "0x" + "33".repeat(32) };
  const quotePin = { ...oldPin, number: 9, hash: "0x" + "44".repeat(32), timestamp: oldPin.timestamp - 12,
    utc: new Date((oldPin.timestamp - 12) * 1000).toISOString() };
  const flags = { verified: true, executionVerified: true, eligibleForPreflight: true, quoteCurrent: true,
    armed: true, executableNow: true, liquidatableNow: true, observationStatus: "COMPLETE", refreshStatus: "COMPLETE",
    nextBlockForecast: { eligible: true, plans: [{ data: "0x1234", verified: true }] } };
  const unknown = { ...flags, observationSource: "legacy-monitor", quoteKind: "HISTORICAL_REFERENCE",
    liveQuote: { provenance: "HISTORICAL_REFERENCE", grossProfit: "123.45", modeledNetUsd: "99.00" } };
  const known = pin => ({ ...flags, observationSource: "original-monitor", chainId: pin.chainId,
    observationBlock: pin.number, observationHash: pin.hash, observationTimestamp: pin.timestamp, observationUtc: pin.utc,
    quoteKind: "ONCHAIN_MEASURED", quoteObservation: { ...quotePin, chainId: pin.chainId },
    liveQuote: { provenance: "ONCHAIN_MEASURED", observationBlock: quotePin.number, observationHash: quotePin.hash,
      observationUtc: quotePin.utc, grossProfit: "234.56", conservativeNetUsd: "200.01" } });
  const currentPin = { chainId: 1, number: 100, hash: PIN_HASH, timestamp: NOW / 1000 - 10, baseFeePerGas: "100000000" };
  for (const baseHasPin of [true, false]) {
    const previous = freezeTree({ generatedAt: oldPin.utc, pin: oldPin,
      baseObservation: { ...flags, status: "COMPLETE", reason: null, pin: baseHasPin ? basePin : null },
      targets: {
        targetB0_Base_USDe_USDC: { ...known(basePin), additionalBorrowers: [unknown] },
        extra_Base_USDe_Whales: [known(basePin), unknown],
        base_Morpho_Whales: [{ ...unknown, debtObservation: basePin }],
        targetC9_AaveV4_weETH_WETH_0x9f46: known(oldPin),
        targetA11_AaveV4_USDe_USDC_0x5c43: unknown,
      } });
    const original = JSON.stringify(previous), observationFile = "memory-observations.json", statusFile = "memory-status.json";
    const fresh = { generatedAt: new Date(NOW).toISOString(), pin: currentPin, targets: {},
      baseObservation: { status: "UNAVAILABLE", reason: "BASE_RPC_UNAVAILABLE", pin: null } };
    const f = load({ previous, observationFile, collect: async options => options.m1Only
      ? { pin: currentPin, targets: {} } : structuredClone(fresh) });
    // Direct frozen-input checks catch accidental mutation hidden by JSON parsing.
    for (const value of Object.values(previous.targets)) f.api.retainFixture(value);
    const out = await f.api.runPass({ execute: false, writeOut: true, observationFile, statusFile, now: () => NOW,
      pinned: { pin: currentPin, assertUsable() {}, recheck: async () => {}, call: denied, nonce: denied, send: denied, receipt: denied },
      signTransaction: denied });
    assert.equal(out.fired, false); assert.equal(out.summary.candidateCount, 0); assert.equal(f.state.reconciled, 0);
    const saved = f.state.writes.find(write => write.file === observationFile).value;
    assert.deepEqual(saved.pin, currentPin); assert.equal(saved.generatedAt, fresh.generatedAt);
    const checkRetained = (row, old) => {
      for (const field of ["armed", "executableNow", "eligibleForPreflight", "quoteCurrent"]) assert.equal(row[field], false, field);
      assert.equal(row.observationKind, "READ_ONLY_MONITOR"); assert.equal(row.observationStatus, "INCOMPLETE");
      assert.equal(row.refreshStatus, "INCOMPLETE");
      assert.equal(row.observationReason, "EXECUTOR_OBSERVATION_RETAINED"); assert.equal(row.refreshReason, row.observationReason);
      assert.equal(row.nextBlockForecast, undefined);
      assert.equal(row.observationTimestamp, old.observationTimestamp ?? old.debtObservation?.timestamp ?? null);
      assert.equal(row.observationBlock, old.observationBlock ?? old.debtObservation?.number ?? null);
      assert.equal(row.observationHash, old.observationHash ?? old.debtObservation?.hash ?? null);
      assert.equal(row.observationUtc, old.observationUtc ?? old.debtObservation?.utc ?? null);
      assert.deepEqual(row.quoteObservation, old.quoteObservation ?? null);
      assert.equal(row.liveQuote?.grossProfit, old.liveQuote?.grossProfit);
      assert.equal(row.liveQuote?.modeledNetUsd, old.liveQuote?.modeledNetUsd);
      assert.equal(row.liveQuote?.conservativeNetUsd, old.liveQuote?.conservativeNetUsd);
      assert.equal(row.liveQuote?.provenance, old.liveQuote?.provenance);
      assert.equal(row.liveQuote?.observationUtc, old.liveQuote?.observationUtc ?? null);
      assert.equal(row.liveQuote?.observationHash, old.liveQuote?.observationHash ?? null);
      assert.equal(row.observationSource, old.observationSource);
      if (old.additionalBorrowers) row.additionalBorrowers.forEach((child, i) => checkRetained(child, old.additionalBorrowers[i]));
    };
    for (const [key, value] of Object.entries(previous.targets)) {
      if (Array.isArray(value)) saved.targets[key].forEach((row, i) => checkRetained(row, value[i]));
      else checkRetained(saved.targets[key], value);
    }
    assert.equal(saved.baseObservation.status, "INCOMPLETE"); assert.equal(saved.baseObservation.reason, "EXECUTOR_OBSERVATION_RETAINED");
    assert.equal(saved.baseObservation.observationStatus, "INCOMPLETE"); assert.equal(saved.baseObservation.refreshStatus, "INCOMPLETE");
    assert.equal(saved.baseObservation.eligibleForPreflight, false); assert.equal(saved.baseObservation.armed, false);
    assert.equal(saved.baseObservation.executableNow, false); assert.equal(saved.baseObservation.quoteCurrent, false);
    assert.equal(saved.baseObservation.nextBlockForecast, undefined);
    assert.deepEqual(saved.baseObservation.pin, baseHasPin ? basePin : null);
    assert.equal(saved.baseObservation.observationTimestamp, baseHasPin ? basePin.timestamp : null);
    assert.equal(saved.baseObservation.observationUtc, baseHasPin ? basePin.utc : null);
    assert.equal(JSON.stringify(previous), original);
  }
});

test("restoration never replaces fresh Base/Aave rows or a complete current Base observation", async () => {
  const pin = { chainId: 1, number: 100, hash: PIN_HASH, timestamp: NOW / 1000 - 10, baseFeePerGas: "100000000" };
  const observationFile = "memory-observations.json", statusFile = "memory-status.json";
  const current = { pin, targets: { targetA11_AaveV4_USDe_USDC_0x5c43: { liquidatableNow: false, observationTimestamp: pin.timestamp },
    targetB0_Base_USDe_USDC: { executableNow: false, observationTimestamp: pin.timestamp } },
    baseObservation: { status: "COMPLETE", pin: { ...pin, chainId: 8453 } } };
  const previous = { pin: { ...pin, number: 1 }, targets: { targetA11_AaveV4_USDe_USDC_0x5c43: { stale: true },
    targetB0_Base_USDe_USDC: { stale: true } }, baseObservation: { status: "COMPLETE", pin: { ...pin, number: 1 } } };
  const f = load({ previous, observationFile, collect: async options => options.m1Only ? { pin, targets: {} } : structuredClone(current) });
  await f.api.runPass({ execute: false, writeOut: true, observationFile, statusFile, now: () => NOW,
    pinned: { pin, assertUsable() {}, recheck: async () => {}, call: denied, nonce: denied, send: denied, receipt: denied }, signTransaction: denied });
  const saved = f.state.writes.find(write => write.file === observationFile).value;
  assert.deepEqual(saved.targets, current.targets); assert.deepEqual(saved.baseObservation, current.baseObservation);
});

const NOMINATION_PIN = Object.freeze({ chainId: 1, number: 100, hash: PIN_HASH, timestamp: NOW / 1000 - 10, baseFeePerGas: "100000000" });
function monitorNomination(f, route) {
  const c = f.c;
  let id, user, field, iface, plan, data;
  if (route === "A6") {
    id = "targetA6_AaveV4_syrupUSDG_USDG_0xbd81"; user = "0xbd810c549c287c759ff9044efeb1712bc1a58edd";
    field = "readyExecuteUniV4FlashCalldata"; iface = c.UNIV4_FLASH_EXEC_IFACE;
    plan = { mode: 0, target: c.A5_SPOKE, collateralVault: ZERO, collateralReserveId: 1, debtReserveId: 0,
      borrower: user, debtAsset: c.USDG, collateralAsset: c.SYRUP_USDG, flashAmount: 65000000000n, debtToCover: 65000000000n,
      minCollateralSeized: 64000000000n, minSwapOut: 66000000000n, minProfit: 1000000000n, deadline: 9999999999n,
      poolKey: { currency0: c.SYRUP_USDG, currency1: c.USDG, fee: 800, tickSpacing: 5, hooks: ZERO }, zeroForOne: true };
    data = iface.encodeFunctionData("execute", [plan]);
  } else if (route === "E3") {
    id = "targetE3_EulerV2_WETH_ynETHx_0x831e"; user = c.E3_BORROWER; field = "readyExecuteEulerEvkCalldata"; iface = c.EULER_EVK_EXEC_IFACE;
    plan = { loanToken: c.WETH, liabilityVault: c.E3_LIABILITY_VAULT, collateralVault: c.E3_COLL_VAULT,
      underlyingCollateral: c.YNETHX, violator: user, repayAssets: 515000000000000000n, minYieldShares: 505000000000000000n,
      unwindKind: 0, swapTarget: ZERO, curveI: 0, curveJ: 0, minLoanOut: 550000000000000000n };
    data = iface.encodeFunctionData("execute", [plan]);
  } else if (["M8", "M14", "M29"].includes(route)) {
    iface = c.PENDLE_PT_EXEC_IFACE; field = "readyExecutePendlePtCalldata";
    const defs = {
      M8: ["targetM8_Morpho_PT_USDe_DAI", c.M8_BORROWER, c.DAI, c.PT_USDE, c.PT_ORACLE, c.PENDLE_YT, c.PENDLE_SY, c.USDE, c.UNI_ROUTER, 30000n * W, 30200n * W],
      M14: ["targetM14_Morpho_PT_USDat_USDC", c.M14_BORROWER, c.USDC, c.M14_PT, c.M14_ORACLE, c.M14_YT, c.M14_SY, c.USDAT, c.CURVE_USDAT_USDC, 5400000000n, 5425000000n],
      M29: ["targetM29_Morpho_PT_srUSDe_USDC", c.M29_BORROWER, c.USDC, c.M29_PT, c.M29_ORACLE, c.M29_YT, c.M29_SY, c.SUSDE, c.CURVE_ROUTER_NG, 4200n * W, 4220000000n],
    };
    const [key, borrower, loanToken, collateralToken, oracle, pendleYt, pendleSy, redeemedToken, swapTarget, seizedAssets, minLoanOut] = defs[route];
    id = key; user = borrower; plan = { loanToken, collateralToken, oracle, irm: c.M1_IRM, lltv: 915000000000000000n,
      borrower, seizedAssets, pendleYt, pendleSy, redeemedToken, swapTarget, minLoanOut };
    let swap = c.CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [1, 0, seizedAssets, minLoanOut]);
    if (route === "M29") swap = c.CURVE_ROUTER_NG_IFACE.encodeFunctionData("exchange", [
      [c.SUSDE, c.CURVE_REUSD_USDC, c.REUSD, c.CURVE_USDAT_USDC, c.USDC, ...Array(6).fill(ZERO)],
      Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]), seizedAssets, minLoanOut, Array(5).fill(ZERO), c.PENDLE_PT_EXECUTOR,
    ]);
    data = iface.encodeFunctionData("execute", [plan, swap]);
  } else if (route === "V3") {
    const target = f.api.V3_TARGETS[0]; id = target.key; user = target.borrower;
    field = "readyExecuteMorphoCalldata"; iface = f.api.UNIFIED_IFACE;
    plan = { isAaveV3: true, target: c.POOL, borrower: user, debtToken: c.WETH, collateralToken: c.WEETH,
      collateralReserveId: 0, debtReserveId: 0, minCollateralSeized: W, swapKind: 2, swapTarget: c.CURVE,
      swapSpender: c.CURVE, uniFee: 0, curveI: 1, curveJ: 0, minDebtTokenOut: 1094500000000000000n, minProfitDebtToken: W / 100n };
    data = iface.encodeFunctionData("executeMorpho", [W, plan]);
  } else assert.fail("unknown nomination route");
  const row = { user, liquidatableNow: true, observationKind: "READ_ONLY_MONITOR", armed: false, executableNow: false,
    eligibleForPreflight: true, observationStatus: "COMPLETE", refreshStatus: "COMPLETE", chainId: 1,
    observationBlock: NOMINATION_PIN.number, observationHash: NOMINATION_PIN.hash, observationTimestamp: NOMINATION_PIN.timestamp,
    observationUtc: new Date(NOMINATION_PIN.timestamp * 1000).toISOString(), [field]: data };
  return { id, user, field, data, row, iface, plan };
}

const NOMINATION_ROUTES = ["A6", "E3", "M8", "M14", "M29", "V3"];
for (const route of NOMINATION_ROUTES) test(`${route}: complete monitor eligibility nominates only a strictly validated current plan`, () => {
  const f = load(), n = monitorNomination(f, route);
  const select = (row, pin = NOMINATION_PIN) => f.api.selectCandidates({ pin, targets: { [n.id]: row } });
  const [candidate] = select(freezeTree(n.row));
  assert.ok(candidate); assert.equal(candidate.id, n.id); assert.equal(candidate.data, n.data);
  assert.equal(candidate.conservativeProfitBeforeGasWei, undefined); assert.equal(candidate.executionMode, undefined);
  assert.equal(n.row.armed, false); assert.equal(n.row.executableNow, false);
  assert.equal(f.api.selectCandidates({ targets: { [n.id]: n.row } }).length, 1, "a selection-only caller may omit the document pin");
  assert.throws(() => select({ ...n.row, user: ZERO }), /COLLECTOR_TARGET_MISMATCH/);
  assert.throws(() => select({ ...n.row, [n.field]: n.data + "00" }), /EXECUTION_CALLDATA_INVALID/);
  const decoded = n.iface.decodeFunctionData(route === "V3" ? "executeMorpho" : "execute", n.data);
  const changed = route === "V3" ? n.iface.encodeFunctionData("executeMorpho", [decoded[0], { ...decoded[1].toObject(), minProfitDebtToken: 0n }]) :
    n.iface.encodeFunctionData("execute", [{ ...decoded[0].toObject(), ...(route === "A6" ? { minProfit: 0n } : { minLoanOut: 0n }) }, ...decoded.slice(1)]);
  assert.throws(() => select({ ...n.row, [n.field]: changed }), /PLAN_PROFIT_OR_SLIPPAGE_INVALID|EXECUTION_TARGET_MISMATCH/);
  for (const change of [{ eligibleForPreflight: false }, { eligibleForPreflight: undefined }, { observationStatus: "INCOMPLETE" },
    { refreshStatus: "INCOMPLETE" }, { refreshStatus: undefined }, { observationBlock: 99 }, { observationHash: "0x" + "55".repeat(32) },
    { observationTimestamp: NOMINATION_PIN.timestamp - 12 }, { observationTimestamp: null }, { chainId: 8453 }]) {
    const row = { ...n.row, ...change, executableNow: true, armed: true, verified: true, [n.field]: "0x1234" };
    assert.deepEqual(select(row), [], "display/readiness flags cannot bypass current observation eligibility");
  }
  assert.deepEqual(select(n.row, { ...NOMINATION_PIN, number: 101 }), []);
  const retained = f.api.retainFixture(n.row);
  assert.deepEqual(select({ ...retained, eligibleForPreflight: true, executableNow: true, armed: true }), []);
  const legacy = { user: n.user, liquidatableNow: true, executableNow: true, eligibleForPreflight: false, [n.field]: n.data };
  assert.equal(select(legacy).length, 1, "unmarked legacy rows retain their previous contract");
  assert.equal(select({ ...legacy, executableNow: false }).length, route === "V3" ? 1 : 0);
});

test("new monitor nomination never supplies native-profit proof or reaches the wallet for the held adapters", async () => {
  for (const route of NOMINATION_ROUTES.filter(route => route !== "V3")) {
    const f = load(), nomination = monitorNomination(f, route);
    nomination.row = { ...nomination.row, conservativeProfitBeforeGasWei: POSITIVE, verified: true, routePositive: true };
    const out = await run(f, candidateFixture(f, "M2"), { nomination });
    assert.equal(out.fired, false); assert.equal(out.summary.candidateCount, 1);
    assert.deepEqual(out.summary.preflightFailures, [{ targetId: nomination.id, reason: "PROFIT_UNVERIFIED" }]);
    assert.equal(f.state.reconciled, 0); assert.equal(f.state.guarded, 0); assert.equal(f.state.nonces, 0); assert.equal(f.state.simulations.length, 0);
  }
});

test("healthy monitor current-ineligibility does not veto an exact eligible forecast proposal", () => {
  const context = { chainId: 1, parentNumber: NOMINATION_PIN.number, parentHash: NOMINATION_PIN.hash, parentTimestamp: NOMINATION_PIN.timestamp,
    number: NOMINATION_PIN.number + 1, timestamp: NOMINATION_PIN.timestamp + 12, seconds: 12 };
  for (const route of NOMINATION_ROUTES) {
    const f = load(), n = monitorNomination(f, route);
    const row = freezeTree({ ...n.row, eligibleForPreflight: false, liquidatableNow: false, hfUnderwaterNow: false,
      healthFactorRaw: (W + 1n).toString(), [n.field]: "0x1234", nextBlockForecast: {
        context, evidence: "FORECAST_ONLY", eligibleForSimulation: true, currentHealth: "HEALTHY", requiresExactSimulation: true,
        currentHealthFactorRaw: (W + 1n).toString(), plans: { [n.field]: n.data },
      } });
    const status = { pin: NOMINATION_PIN, targets: { [n.id]: row } };
    assert.deepEqual(f.api.selectCandidates(status), []);
    const [candidate] = f.api.selectCandidates(status, [], { nextBlockContext: context });
    assert.ok(candidate, route); assert.equal(candidate.data, n.data); assert.equal(candidate.executionMode, "NEXT_BLOCK_PASSIVE");
    assert.equal(candidate.conservativeProfitBeforeGasWei, undefined);
    assert.equal(Boolean(f.api.forecastRoute(candidate)), route === "V3", "unsupported future adapters remain held downstream");
    assert.equal(row.eligibleForPreflight, false); assert.equal(row.executableNow, false); assert.equal(row[n.field], "0x1234");
    for (const change of [{ refreshStatus: "INCOMPLETE" }, { observationStatus: "INCOMPLETE" }, { observationTimestamp: NOMINATION_PIN.timestamp - 12 },
      { nextBlockForecast: { ...row.nextBlockForecast, requiresExactSimulation: false } }]) {
      assert.deepEqual(f.api.selectCandidates({ ...status, targets: { [n.id]: { ...row, ...change } } }, [], { nextBlockContext: context }), []);
    }
  }
});

test("complete M32 monitor nominations stay dedicated-only; stale and ineligible rows cannot nominate", async () => {
  const f = load(), row = { ...monitorNomination(f, "V3").row, user: f.c.M32_BORROWER,
    marketId: "0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742" };
  delete row.readyExecuteMorphoCalldata;
  const id = "targetM32_Morpho_sUSDe_USDtb", select = value => f.api.selectCandidates({ pin: NOMINATION_PIN, targets: { [id]: value } });
  assert.deepEqual(select(row).map(candidate => candidate.kind), ["MORPHO_BLUE_M32"]);
  for (const change of [{ eligibleForPreflight: false }, { observationStatus: "INCOMPLETE" }, { observationTimestamp: NOMINATION_PIN.timestamp - 12 }])
    assert.deepEqual(select({ ...row, ...change, executableNow: true }), []);
  const out = await run(f, candidateFixture(f, "M2"), { nomination: { id, row } });
  assert.equal(out.fired, false); assert.deepEqual(out.summary.preflightFailures, [{ targetId: id, reason: "M32_DEDICATED_ONLY_REQUIRED" }]);
  assert.equal(f.state.reconciled, 0); assert.equal(f.state.guarded, 0);
});
