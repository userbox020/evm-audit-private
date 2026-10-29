"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("../node_modules/ethers");
const { EXTRA_V3_WEETH_USERS, wTaylorCompounded, createStickyResolver, checkOnce, computeV3WeEthSizing, computeV4Target1Sizing, computeV4SpokeCSizing } = require("../watch-top-whale-triggers.js");
const { UNIFIED_IFACE, selectCandidates, runPass } = require("../execute-top-whale-trigger.js");

test("watch-top-whale-triggers exports checkOnce as a function", () => {
  assert.equal(typeof checkOnce, "function");
});

function nextContext() {
  const parentNumber = Number(BigInt(ETH_HEADER.number)), parentTimestamp = Number(BigInt(ETH_HEADER.timestamp));
  return { chainId: 1, parentHash: ETH_HEADER.hash, parentNumber, parentTimestamp,
    number: parentNumber + 1, timestamp: parentTimestamp + 12, seconds: 12 };
}

function monitorFields(pin, quoteKind, eligibleForPreflight) {
  return { observationKind: "READ_ONLY_MONITOR", observationSource: "tools/watch-top-whale-triggers.js",
    chainId: pin.chainId, observationBlock: pin.number, observationHash: pin.hash,
    observationTimestamp: pin.timestamp, observationUtc: pin.utc,
    observationStatus: "COMPLETE", observationReason: null, refreshStatus: "COMPLETE", refreshReason: null,
    eligibleForPreflight, quoteKind, quoteObservation: quoteKind === "ONCHAIN_MEASURED" ? pin : null,
    quoteCurrent: quoteKind === "ONCHAIN_MEASURED" };
}

function quoteFields(provenance, pin = null) {
  return { provenance, observationBlock: pin?.number ?? null, observationHash: pin?.hash ?? null, observationUtc: pin?.utc ?? null };
}

function quoteValues(quote) {
  const { provenance, observationBlock, observationHash, observationUtc, ...values } = quote;
  assert.ok(["ONCHAIN_MEASURED", "MODEL_ESTIMATE", "HISTORICAL_REFERENCE"].includes(provenance));
  return values;
}

test("M1 healthy pin forecasts a +12 crossing without changing current calldata, eligibility or firing", async () => {
  const context = Object.freeze(nextContext());
  const options = { m1Position: [0n, (206400n * W - W / 10n) * 1000000n, 240000n * W], m1Rate: 100000000000n };
  const baseline = await captureFixture({ ...options, nextBlockContext: null });
  const { state, calls } = await captureFixture({ ...options, nextBlockContext: context });
  const row = state.targets.targetM1_Morpho_USDe_DAI;
  const { nextBlockForecast: forecast, ...current } = row;
  assert.deepEqual(current, baseline.state.targets.targetM1_Morpho_USDe_DAI);
  assert.deepEqual(state.firedTriggers, baseline.state.firedTriggers);
  assert.deepEqual(state.pin, baseline.state.pin);
  assert.deepEqual(calls, baseline.calls, "forecast adds no collector/RPC pass");
  assert.equal(row.liquidatableNow, false);
  assert.equal(forecast.context, context);
  assert.equal(forecast.evidence, "FORECAST_ONLY");
  assert.equal(forecast.eligibleForSimulation, true);
  assert.equal(forecast.currentHealth, "HEALTHY");
  assert.equal(forecast.projectedLiquidatable, true);
  assert.equal(forecast.projectionIsEstimate, true);
  const data = forecast.plans.readyExecuteMorphoBlueCalldata;
  assert.equal(data, row.m1Nomination.calldataTemplate);
  assert.equal(row.readyExecuteMorphoBlueCalldata, null);
  const plan = MORPHO_EXEC.decodeFunctionData("execute", data);
  assert.equal(plan.borrower.toLowerCase(), row.user.toLowerCase());
  assert.equal(plan.minProfitWei, 25n * W);
  assert.equal(plan.minOut, 0n, "tagged ceiling is not an executable quote");
  assert.equal(plan.marketParams.lltv, 860000000000000000n);
  assert.equal(plan.seizedAssets, 108500n * W);
  assert.equal(plan.repaidShares, 0n);
  assert.equal(state.firedTriggers.includes("TARGET_M1_MORPHO_USDE_DAI_LIQUIDATABLE"), false);
  assert.ok(state.targets.base_Morpho_Whales.every(target => !target.nextBlockForecast));
});

test("M1 raw boundary/zero rate remain candidates; missing source, future lastUpdate, no debt and mismatched context do not", async () => {
  const opts = { m1Position: [0n, (206400n * W - 1n) * 1000000n, 240000n * W], m1Rate: 0n };
  const { state } = await captureFixture(opts);
  const row = state.targets.targetM1_Morpho_USDe_DAI;
  assert.equal(row.healthFactor, 1, "display rounding is not the raw gate");
  assert.equal(row.nextBlockForecast.projectedLiquidatable, false);
  assert.equal(row.nextBlockForecast.currentDebtRaw, (206400n * W - 1n).toString());
  assert.deepEqual(row.nextBlockForecast.context, nextContext());
  const quoteFailed = await captureFixture({ ...opts, m1QuoteFailed: true });
  assert.deepEqual(quoteFailed.state.targets.targetM1_Morpho_USDe_DAI.m1Nomination, row.m1Nomination);
  assert.deepEqual(quoteFailed.state.targets.targetM1_Morpho_USDe_DAI.nextBlockForecast, row.nextBlockForecast);
  for (const change of [{ m1RateFailed: true }, { m1Price: 0n },
    { m1LastUpdate: BigInt(ETH_HEADER.timestamp) + 1n }, { m1Position: [0n, 0n, 240000n * W] },
    { m1Position: [0n, (206400n * W + 1n) * 1000000n, 240000n * W] },
    { nextBlockContext: { ...nextContext(), parentHash: BASE_HEADER.hash } },
    { nextBlockContext: { ...nextContext(), parentTimestamp: nextContext().parentTimestamp - 1 } }]) {
    const result = await captureFixture({ ...opts, ...change });
    assert.equal(result.state.targets.targetM1_Morpho_USDe_DAI.nextBlockForecast, undefined);
  }
});

test("focused and broad production collection share identical M1 health/nomination despite a failed ceiling quote", async () => {
  const options = { m1Position: [0n, (86000n * W - W / 100n) * 1000000n, 100000n * W], m1Rate: 100000000000n, m1QuoteFailed: true };
  const { state } = await captureFixture(options), context = nextContext(), focusedCalls = [];
  const first = MC.decodeFunctionResult("aggregate3", ethereumFixture(options))[0];
  const focused = await checkOnce({ m1Only: true, pin: state.pin, nextBlockContext: context, writeOut: true,
    resolveRpc: async chain => { assert.equal(chain, 1); return "offline"; }, rpcCall: async (_rpc, method, params) => {
      assert.equal(method, "eth_call"); assert.equal(params[1], state.pin.hash);
      const requests = MC.decodeFunctionData("aggregate3", params[0].data)[0]; focusedCalls.push(requests);
      return MC.encodeFunctionResult("aggregate3", [requests.length === 3 ? first.slice(59, 62) : [{ success: true, returnData: uints([options.m1Rate]) }]]);
    } });
  assert.deepEqual(focusedCalls.map(rows => rows.length), [3, 1]); assert.equal(focused.partial, true);
  assert.deepEqual(focused.targets.targetM1_Morpho_USDe_DAI, state.targets.targetM1_Morpho_USDe_DAI);
  assert.equal(selectCandidates(focused, [], { nextBlockContext: context }).length, 1);
});

test("M2 and buffered M7/M7B build forecast plans without forging current ready fields", async () => {
  const { state } = await captureFixture({ m2Position: [0n, (219600000000n - 1n) * 1000000n, 240000n * W], m2Rate: 100000000000n });
  const m2 = state.targets.targetM2_Morpho_reUSD_USDC;
  assert.equal(m2.liquidatableNow, false);
  assert.equal(m2.executableNow, false);
  assert.equal(m2.nextBlockForecast.plans.readyExecuteCurveUnwindCalldata, m2.readyExecuteCurveUnwindCalldata);
  const opts = { elapsed: 0n, rates: [0n, 0n, 100000000000n], m7Debt: 915n * W - 100000000000000n,
    m7bPosition: [0n, (915n * W / 100n - 1000000000000n) * 1000000n, 10n * W], includeM7B: true, bufferWeth: 2n * W };
  const forecasted = await captureExtendedFixture(opts);
  for (const key of [EXT_M7, "targetM7B_Morpho_ynETHx_msETH_0x9b13"]) {
    const row = forecasted.state.targets[key];
    assert.ok(row, key);
    assert.equal(row.liquidatableNow, false);
    assert.equal(row.executableNow, false);
    assert.equal(row.readyExecuteVaultRedeemCalldata, undefined);
    assert.ok(row.nextBlockForecast.plans.readyExecuteVaultRedeemCalldata.startsWith("0x"));
    assert.equal(row.nextBlockForecast.projectedLiquidatable, true);
  }
  const blocked = await captureExtendedFixture({ ...opts, bufferWeth: 0n });
  for (const row of Object.values(blocked.state.targets).filter(row => row?.rank === "#M7" || row?.rank === "#M7B"))
    assert.equal(row.nextBlockForecast, undefined);
});

test("same-hook Morpho M3-M6 and Aave 2A-2J retain existing sizing and guards", async () => {
  const near = W + 100000000000n;
  const base = await captureFixture({ v3HealthFactor: near, extraV3HealthFactor: near, extraV3QuoteOut: 2000n * W });
  for (const row of [base.state.targets.target2A_AaveV3_weETH_WETH_0x7231,
    base.state.targets.target2B_AaveV3_weETH_WETH_0x1A55, ...base.state.targets.additional_AaveV3_weETH_WETH]) {
    assert.equal(row.nextBlockForecast.projectedHealthFactorRaw, null);
    assert.equal(row.nextBlockForecast.plans.readyExecuteMorphoCalldata, row.readyExecuteMorphoCalldata);
    assert.equal(row.liquidatableNow, false);
  }
  const positions = [965n, 965n, 965n, 945n].map(lltv =>
    [0n, (1250n * W * lltv / 1000n - 100000000000000n) * 1000000n, 1000n * W]);
  const extended = await captureExtendedFixture({ elapsed: 0n, positions, hf2J: near, rates: [100000000000n, 100000000000n, 0n] });
  assert.equal(extended.state.targets.target2J_AaveV3_wstETH_WETH_0x037a.nextBlockForecast.projectedHealthFactorRaw, null);
  assert.equal(extended.state.targets.morpho_wstETH_WETH_Whales.length, 4);
  for (const row of extended.state.targets.morpho_wstETH_WETH_Whales) {
    assert.equal(row.liquidatableNow, false);
    assert.equal(row.nextBlockForecast.projectedLiquidatable, true);
    assert.equal(row.nextBlockForecast.plans.readyExecuteMorphoBlueCalldata, row.readyExecuteMorphoBlueCalldata);
  }
});

test("Aave #2K-Q and Spark #S1-4 use raw near HF and preserve conservative existing ABI constraints", async () => {
  const context = nextContext();
  const { state } = await captureFixture({ whaleForecast: {}, nextBlockContext: context });
  const rows = Object.values(state.targets).filter(row => /^#(?:2[K-Q]|S[1-4])$/.test(row?.rank));
  assert.equal(rows.length, 11);
  for (const row of rows) {
    const forecast = row.nextBlockForecast;
    assert.ok(forecast, row.rank);
    assert.equal(forecast.context, context);
    assert.equal(forecast.projectedHealthFactorRaw, null);
    assert.equal(forecast.projectedLiquidatable, null);
    assert.equal(row.liquidatableNow, false);
    assert.equal(row.executableNow, false);
    assert.equal(forecast.plans.readyExecuteMorphoCalldata, row.readyExecuteMorphoCalldata);
    const plan = UNIFIED_IFACE.decodeFunctionData("executeMorpho", forecast.plans.readyExecuteMorphoCalldata);
    assert.equal(plan[1].borrower.toLowerCase(), row.user.toLowerCase());
    assert.equal(plan[1].target.toLowerCase(), row.pool.toLowerCase());
    assert.ok(plan[1].minProfitDebtToken > 0n);
  }
  assert.equal(state.firedTriggers.some(t => /TARGET_(2[K-Q]|S[1-4])_/.test(t)), false);
  for (const whaleForecast of [{ hf: 0n }, { hf: W - 1n }, { hf: 101n * W / 100n }, { debt: 0n }, { debt: 1n }, { malformed: true }]) {
    const bad = await captureFixture({ whaleForecast });
    for (const row of Object.values(bad.state.targets).filter(row => /^#(?:2[K-Q]|S[1-4])$/.test(row?.rank)))
      assert.equal(row.nextBlockForecast, undefined);
  }
});

test("cached/failed and refreshed unknown whale rows lose forecasts; confirmed closed rows never get one", async () => {
  let delegate, collect;
  const collectorFactory = transport => {
    delegate = transport;
    collect ||= defaultTransportCollector((...args) => delegate(...args));
    return collect;
  };
  const options = { ...closureOptions({ debt: 0n }), collectorFactory };
  const first = await captureFixture({ ...options, whaleForecast: {} });
  const cached = await captureFixture({ ...options, whaleForecast: { failed: true } });
  const refreshed = await captureFixture({ ...options, whaleForecast: { hf: 0n } });
  for (const [key, row] of Object.entries(first.state.targets)) {
    if (/^#(?:2[K-Q]|S[1-4])$/.test(row?.rank)) {
      assert.ok(row.nextBlockForecast);
      assert.equal(cached.state.targets[key].nextBlockForecast, undefined);
      assert.equal(refreshed.state.targets[key].nextBlockForecast, undefined);
    }
  }
  for (const key of CLOSED_KEYS) assert.equal(first.state.targets[key].nextBlockForecast, undefined);
});

test("default-transport clock skew preserves actual pin and closure timestamps but suppresses all future-parent forecasts", async () => {
  const context = Object.freeze(nextContext());
  let current;
  for (const offset of [60, -60]) {
    const { state } = await captureFixture({ ...closureOptions({ debt: 0n }), whaleForecast: {},
      m1Position: [0n, (206400n * W - W / 10n) * 1000000n, 240000n * W], m1Rate: 100000000000n,
      nextBlockContext: context,
      collectorFactory: transport => defaultTransportCollector(transport, (context.parentTimestamp + offset) * 1000),
    });
    assert.equal(state.pin.timestamp, context.parentTimestamp);
    assert.equal(state.pin.utc, new Date(context.parentTimestamp * 1000).toISOString());
    assert.equal(Date.parse(state.generatedAt) / 1000, context.parentTimestamp + offset);
    for (const key of CLOSED_KEYS.slice(1)) {
      const row = state.targets[key];
      assert.equal(row.positionStatus, "CLOSED");
      assert.deepEqual(row.debtObservation, state.pin);
      assert.equal(row.debtObservation.timestamp, context.parentTimestamp);
      assert.equal(row.nextBlockForecast, undefined);
    }
    const row = state.targets.targetM1_Morpho_USDe_DAI;
    assert.equal(row.liquidatableNow, false);
    if (offset > 0) {
      assert.equal(row.nextBlockForecast.context, context);
      assert.equal(row.nextBlockForecast.context.parentTimestamp, state.pin.timestamp);
      const { nextBlockForecast, ...observed } = row;
      current = observed;
    } else {
      assert.deepEqual(row, current, "clock skew removes only advisory simulation eligibility");
      assert.equal(JSON.stringify(state.targets).includes('"nextBlockForecast"'), false);
      assert.equal(state.firedTriggers.some(t => /TARGET_(M1|2[K-Q]|S[1-4])_/.test(t)), false);
    }
  }
});

test("wTaylorCompounded matches three-term WAD arithmetic and integer truncation", () => {
  assert.equal(wTaylorCompounded(0n, 86400n), 0n);
  assert.equal(wTaylorCompounded(1234n, 0n), 0n);
  assert.equal(wTaylorCompounded(10n ** 18n, 1n), 1666666666666666666n);
  assert.equal(wTaylorCompounded(10n ** 17n, 3n), 349500000000000000n);
  assert.equal(wTaylorCompounded(2000000001n, 1n), 2000000003n);
});

test("computeV3WeEthSizing calculates 90 bps net bonus after 10% protocol fee on 1% eMode bonus", () => {
  const repayWeth = 649_417200000000000000n;
  const priceWeth = 241914806405n;
  const priceWeEth = 267569910811n;
  const seized = computeV3WeEthSizing(repayWeth, priceWeth, priceWeEth);
  // Base collateral = 649.4172 * 2419.14806405 / 2675.69910811 = 587.150045... weETH
  // Net collateral with 0.90% net bonus = ~592.43439 weETH
  assert.equal(seized > 592_000000000000000000n && seized < 593_000000000000000000n, true);
});

test("computeV4Target1Sizing restores targetHF 1.0332 and deducts 10% bonus fee shares", () => {
  const c1Acct = {
    healthFactor: "1000266033826587900",
    totalDebtValue: "87980765032263850000000000000000000000000000000000000000000"
  };
  const c1CollPos = { suppliedShares: "941023217776570529679178" };
  const c1DebtPos = { drawnShares: "869517943323", premiumShares: "0", premiumOffsetRay: "0" };
  const hubUsde = {
    liquidity: "28517032276128015091879941",
    realizedFees: "1246208985865723831232",
    addedShares: "28327516824892769706020527",
    swept: "0",
    premiumOffsetRay: "0",
    drawnShares: "7728840791307652589566",
    premiumShares: "0",
    liquidityFee: "2500",
    drawnIndex: "1020183869829367144596932120",
    drawnRate: "66000767831494676554491813",
    lastUpdateTimestamp: "1792287887",
    deficitRay: "0"
  };
  const hubUsdc = {
    liquidity: "350814708147",
    realizedFees: "3462593616",
    addedShares: "2972115800809",
    swept: "0",
    premiumOffsetRay: "0",
    drawnShares: "2614279695017",
    premiumShares: "0",
    liquidityFee: "1500",
    drawnIndex: "1011783498917631282792226050",
    drawnRate: "44145086023383177037356802",
    lastUpdateTimestamp: "1792265783",
    deficitRay: "0"
  };
  const out = computeV4Target1Sizing(c1Acct, c1CollPos, c1DebtPos, hubUsde, hubUsdc, 99867346n, 99988399n, 1792384727n);
  assert.equal(out.repayUsdcRaw > 345_000_000000n && out.repayUsdcRaw < 348_000_000000n, true);
  assert.equal(out.seizedUsdeToLiqRaw > 352_000_000000000000000000n && out.seizedUsdeToLiqRaw < 355_000_000000000000000000n, true);
});

test("computeV4SpokeCSizing applies targetHF 1.0191, bonus fee, debt and collateral caps", () => {
  const W = 10n ** 18n, R = 10n ** 27n;
  const ceil = (x, y) => (x + y - 1n) / y;
  const pinTs = 1792384727n;
  const price = 2000n * 10n ** 8n;
  const acct = { healthFactor: 1010000000000000000n, totalDebtValue: 955n * W * price * R };
  const collPos = { suppliedShares: 1010n * W };
  const debtPos = { drawnShares: 955n * W, premiumShares: 0n, premiumOffsetRay: 0n };
  const hubWeEth = {
    liquidity: 1010n * W,
    realizedFees: 0n,
    addedShares: 1010n * W,
    swept: 0n,
    premiumOffsetRay: 0n,
    drawnShares: 0n,
    premiumShares: 0n,
    liquidityFee: 1000n,
    drawnIndex: R,
    drawnRate: 0n,
    lastUpdateTimestamp: pinTs,
    deficitRay: 0n
  };
  const hubWeth = { ...hubWeEth, liquidity: 0n, drawnShares: debtPos.drawnShares };
  const out = computeV4SpokeCSizing(acct, collPos, debtPos, hubWeEth, hubWeth, price, price, pinTs);
  // Healthy HF 1.01 projects price to 0.99 of spot and HF to 0.9999.
  // Target gap / (target - penalty) = 0.0192 / 0.05455.
  const repay = ceil(955n * W * 1920n, 5455n);
  const gross = repay * 101n / 99n;
  assert.deepEqual(out, {
    repayWethRaw: repay,
    seizedWeEthToLiqRaw: gross - ceil(gross, 1010n),
    userSuppliedWeEth: 1010n * W,
    userDebtWethRaw: 955n * W
  });

  // Already-liquidatable borrowers use spot prices, not synthetic prices.
  const underwater = computeV4SpokeCSizing(
    { ...acct, healthFactor: 990000000000000000n }, { suppliedShares: 990n * W },
    debtPos, hubWeEth, hubWeth, price, price, pinTs
  );
  const underwaterRepay = ceil(955n * W * 2910n, 5455n);
  const underwaterGross = underwaterRepay * 101n / 100n;
  assert.equal(underwater.repayWethRaw, underwaterRepay);
  assert.equal(underwater.seizedWeEthToLiqRaw, underwaterGross - ceil(underwaterGross, 1010n));

  const debtCapped = computeV4SpokeCSizing(
    acct, collPos, { ...debtPos, drawnShares: W }, hubWeEth, hubWeth, price, price, pinTs
  );
  assert.equal(debtCapped.repayWethRaw, W);

  const collateralCapped = computeV4SpokeCSizing(
    { ...acct, healthFactor: W / 10n }, { suppliedShares: 100n * W },
    debtPos, hubWeEth, hubWeth, price, price, pinTs
  );
  assert.equal(collateralCapped.repayWethRaw, ceil(100n * W * 100n, 101n));
  assert.equal(collateralCapped.seizedWeEthToLiqRaw, 100n * W - ceil(100n * W, 1010n));
  assert.equal(collateralCapped.userSuppliedWeEth, 100n * W);

  const accrued = computeV4SpokeCSizing(
    acct, collPos, { ...debtPos, premiumShares: 2n * W, premiumOffsetRay: W * R / 2n },
    hubWeEth, { ...hubWeth, drawnRate: R / 10n }, price, price, pinTs + 31536000n
  );
  assert.equal(accrued.userDebtWethRaw, (957n * W * 11n / 10n) - W / 2n);

  const noRepayment = computeV4SpokeCSizing(
    { ...acct, healthFactor: W - 1n }, { suppliedShares: 2000n * W },
    debtPos, hubWeEth, hubWeth, price, price, pinTs
  );
  assert.equal(noRepayment.repayWethRaw, 0n);
  assert.equal(noRepayment.seizedWeEthToLiqRaw, 0n);
});

const MC = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[]) returns ((bool success,bytes returnData)[])"
]);
const MORPHO_EXEC = new ethers.Interface([
  "function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,address borrower,uint256 seizedAssets,uint256 repaidShares,uint256 minProfitWei,uint256 minOut,address router,bytes routerSwapData) external"
]);
const BLUE_IRM = new ethers.Interface([
  "function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)"
]);
const coder = ethers.AbiCoder.defaultAbiCoder();
const ETH_HEADER = { number: "0x1900000", hash: `0x${"11".repeat(32)}`, timestamp: "0x6ad00000" };
const BASE_HEADER = { number: "0x3200000", hash: `0x${"22".repeat(32)}`, timestamp: "0x6ad00002" };
const W = 10n ** 18n, R = 10n ** 27n;
const encode = (types, values) => coder.encode(types, values);
const uints = values => encode(values.map(() => "uint256"), values);
const aggregate = rows => MC.encodeFunctionResult("aggregate3", [rows.map(returnData => ({ success: true, returnData }))]);
const YOUSD = "0x0000000f2eb9f69274678c76222b35eec7588a65";
const YOUSD_MKT = "0x1a3e69d0109bb1be42b80e11034bb6ee98fc466721f26845dc83b2aa8d979137";
const YOUSD_ORACLE = "0x77f59c5c09e7abef6991b456170930324fe36222";
const YOUSD_USER = "0x108b853407284e77656c569677c82e8fed581299";
const A4_KEY = "targetA4_AaveV4_SameAsset_0xa429";
const A4_SPOKE = "0x94e7a5dcbe816e498b89ab752661904e2f56c485";
const A4_USER = "0xa4298746f662119a4df27fa57f20e18e44ccb767";
const A4_READ = new ethers.Interface(["function getUserAccountData(address)"]);
const SYRUP_SPOKE = "0x774b9655413c34809c1f1b16b654465a89ebe989";
const SYRUP_EXECUTOR = "0x61251a22540e7148cc8ba58cfb0916a898865e1f";
const SYRUP_EXEC = new ethers.Interface(require("../fork-poc/contracts/UniswapV4FlashLiquidator.compiled.json").abi);
const SYRUP_ROWS = [
  { key: "targetA5_AaveV4_syrupUSDG_USDG_0x080c", rank: "#A5", user: "0x080ccea8654fd4ff80b81e46cff2278689d88fb0",
    debtReserveId: 3n, flashAmount: 850000000000n, minCollateralSeized: 830000000000n, minSwapOut: 860000000000n, minProfit: 10000000000n },
  { key: "targetA6_AaveV4_syrupUSDG_USDG_0xbd81", rank: "#A6", user: "0xbd810c549c287c759ff9044efeb1712bc1a58edd",
    debtReserveId: 0n, flashAmount: 65000000000n, minCollateralSeized: 64000000000n, minSwapOut: 66000000000n, minProfit: 1000000000n,
    trigger: "TARGET_A6_AAVE_V4_0xBD81_LIQUIDATABLE",
    quote: { repayUsdc: 65000, seizedUsde: 65756.90, uniV3OutUsdc: 67434.50, grossSurplusUsdc: 2434.50 } },
  { key: "targetA7_AaveV4_syrupUSDG_USDG_0x28e8", rank: "#A7", user: "0x28e81c2230bf90ed002aa4a0451acbae49559e2b",
    debtReserveId: 0n, flashAmount: 850000000000n, minCollateralSeized: 830000000000n, minSwapOut: 860000000000n, minProfit: 10000000000n,
    trigger: "TARGET_A7_AAVE_V4_0x28E8_LIQUIDATABLE",
    quote: { repayUsdc: 850000, seizedUsde: 859898, uniV3OutUsdc: 881533.20, grossSurplusUsdc: 31533.20 } },
];
function syrupPlan(row) {
  return { mode: 0, target: SYRUP_SPOKE, collateralVault: ethers.ZeroAddress, collateralReserveId: 1n, debtReserveId: row.debtReserveId ?? 3n,
    borrower: row.user, debtAsset: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
    collateralAsset: "0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a", flashAmount: row.flashAmount, debtToCover: row.flashAmount,
    minCollateralSeized: row.minCollateralSeized, minSwapOut: row.minSwapOut, minProfit: row.minProfit, deadline: 9999999999n,
    poolKey: { currency0: "0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a", currency1: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
      fee: 800, tickSpacing: 5, hooks: ethers.ZeroAddress }, zeroForOne: true };
}
function syrupAccountResponse(data, options) {
  const user = A4_READ.decodeFunctionData("getUserAccountData", data)[0].toLowerCase();
  const row = SYRUP_ROWS.find(row => row.user === user);
  assert.ok(row, "only the three scoped syrup borrowers may be read");
  const failure = options.syrupFailures?.[row.rank];
  if (failure === "transport") throw new Error("SYRUP_OFFLINE_TRANSPORT_FAILURE");
  if (failure === "malformed") return "0x";
  return uints([0n, 9300n, options.syrupHealthFactors?.[row.rank] ?? 101n * W / 100n,
    18563n * 10n ** 27n, 17016n * 10n ** 54n, 1n, 1n]);
}
function a4ExpectedCalldata() {
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  return UNIFIED_IFACE.encodeFunctionData("executeMorpho", [755000000000000000n, {
    isAaveV3: false, target: A4_SPOKE, borrower: A4_USER, debtToken: weth, collateralToken: weth,
    collateralReserveId: 0n, debtReserveId: 0n, minCollateralSeized: 0n, swapKind: 0,
    swapTarget: ethers.ZeroAddress, swapSpender: ethers.ZeroAddress, uniFee: 0, curveI: 0, curveJ: 0,
    minDebtTokenOut: 0n, minProfitDebtToken: 10000000000000000n,
  }]);
}

function defaultTransportCollector(transport, nowMs = Number(BigInt(ETH_HEADER.timestamp)) * 1000 + 60000, previous = null) {
  // Exercise !options.rpcCall without reading endpoints or using the network.
  const filename = require.resolve("../watch-top-whale-triggers.js");
  const localRequire = require("node:module").createRequire(filename);
  // Offline fixtures start without a production snapshot to seed the target cache.
  const denied = () => { throw new Error("OFFLINE_FIXTURE_IO_DENIED"); };
  const fixtureFs = { existsSync: () => Boolean(previous), readFileSync: () => {
    assert.ok(previous); return JSON.stringify(previous);
  }, mkdirSync: denied, writeFileSync: denied, renameSync: denied, unlinkSync: denied };
  const module = { exports: {} };
  const source = require("node:fs").readFileSync(filename, "utf8").replace(/^#![^\n]*\n/, "");
  const fixtureDate = nowMs === undefined ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  };
  const load = require("node:vm").compileFunction(source, ["exports", "require", "module", "__filename", "__dirname", "Date", "fetch"], { filename });
  load(module.exports, name => name === "./shared-rpc.js" ? {
    rpcCall: transport, resolveRpc: () => { throw new Error("NO_ENDPOINT_LOOKUP_IN_TEST"); },
  } : name === "node:fs" ? fixtureFs : localRequire(name), module, filename, require("node:path").dirname(filename), fixtureDate, denied);
  return module.exports.checkOnce;
}

const CLOSED_KEYS = ["targetB14_Base_USDe_USDC_0x6efc", "targetM34_Morpho_beraSTONE_WETH", "targetE8_Euler_eUSDC2_eXAUt1"];
const closureOptions = closure => ({ armedBase: true, baseRates: [0n, 0n], closure });

test("B14/M34/E8 close only on successful pinned raw-zero debt and clear simulated readiness", async () => {
  const { state, calls } = await captureFixture(closureOptions({ debt: 0n }));
  for (const [i, key] of CLOSED_KEYS.entries()) {
    const row = state.targets[key];
    assert.ok(row, key);
    assert.equal(row.positionStatus, "CLOSED");
    assert.equal(row.inactive, true);
    assert.equal(row.debtRaw, "0");
    assert.equal(row.debtReadStatus, "COMPLETE");
    assert.equal(row.debtReadKind, i === 2 ? "EULER_DEBT_ASSETS" : "MORPHO_BORROW_SHARES");
    assert.equal(row.debtObservation.hash, i === 0 ? BASE_HEADER.hash : ETH_HEADER.hash);
    assert.equal(row.debtObservation.chainId, i === 0 ? 8453 : 1);
    assert.equal(row.armed, false);
    assert.equal(row.executableNow, false);
    assert.equal(row.liquidatableNow, false);
    assert.equal(row.liveQuote, null);
    assert.equal(row.readinessNote, "No outstanding debt at observed block");
    assert.equal(row.healthFactor, null);
    assert.equal(row.bpsToLiquidation, null);
    assert.ok(Object.entries(row).filter(([k]) => /^readyExecute.*Calldata$/.test(k)).every(([, v]) => v === null));
  }
  assert.equal(calls.filter(c => c.method === "eth_call" && c.params[0].to.toLowerCase() === "0x797dd80692c3b2dadabce8e30c07fde5307d48a9").length, 1);
  assert.equal(state.firedTriggers.some(t => /TARGET_(B14|M34|E8)_/.test(t)), false);
});

test("B14/M34/E8 positive raw dust remains OPEN even when debt valuation rounds to zero", async () => {
  const { state } = await captureFixture(closureOptions({ debt: 1n, e8Values: [W, 1n] }));
  for (const key of CLOSED_KEYS) {
    const row = state.targets[key];
    assert.ok(row, key);
    assert.equal(row.debtUsd, 0);
    assert.equal(row.debtRaw, "1");
    assert.equal(row.positionStatus, "OPEN");
    assert.equal(row.inactive, false);
    assert.equal(row.armed, false);
    assert.ok(row.liveQuote);
  }
});

test("failed/missing/malformed raw reads, null HF and zero Euler valuation do not prove closure", async () => {
  for (const failure of ["failed", "missing", "malformed", "transport"]) {
    const { state } = await captureFixture(closureOptions({ b14Failure: failure, m34Failure: failure, e8Failure: failure }));
    assert.equal(state.targets[CLOSED_KEYS[0]], undefined);
    assert.equal(state.targets[CLOSED_KEYS[1]], undefined);
    const e8 = state.targets[CLOSED_KEYS[2]];
    assert.equal(e8.healthFactor, null);
    assert.equal(e8.debtUsd, 0);
    assert.equal(e8.positionStatus, "UNKNOWN");
    assert.equal(e8.inactive, false);
    assert.equal(e8.debtRaw, null);
    assert.equal(e8.debtReadStatus, "UNAVAILABLE");
  }
});

test("raw-zero evidence closes M34/E8 without valuation and never fabricates or overwrites HF", async () => {
  const failed = await captureFixture(closureOptions({ debt: 0n, valuationFailure: true }));
  for (const key of CLOSED_KEYS.slice(1)) {
    assert.equal(failed.state.targets[key].positionStatus, "CLOSED");
    assert.equal(failed.state.targets[key].healthFactor, null);
  }
  const measured = await captureFixture(closureOptions({ debt: 0n, e8Values: [9n, 10n] }));
  const e8 = measured.state.targets[CLOSED_KEYS[2]];
  assert.equal(e8.healthFactor, 0.9);
  assert.equal(e8.liquidatableNow, false);
  assert.equal(measured.state.firedTriggers.includes("TARGET_E8_EULER_EUSDC2_EXAUT1_LIQUIDATABLE"), false);
  const reopened = await captureFixture(closureOptions({ debt: 1n, valuationFailure: true }));
  for (const key of CLOSED_KEYS.slice(1)) {
    const row = reopened.state.targets[key];
    assert.equal(row.positionStatus, "OPEN");
    assert.equal(row.inactive, false);
    assert.equal(row.debtRaw, "1");
    assert.equal(row.healthFactor, null);
    assert.equal(row.armed, false);
  }
});

test("closed B14/M34/E8 identities reopen on a positive read and cached failures are not current closure", async () => {
  let delegate, collect;
  const collectorFactory = transport => {
    delegate = transport;
    collect ||= defaultTransportCollector((...args) => delegate(...args));
    return collect;
  };
  const pass = closure => captureFixture({ ...closureOptions(closure), collectorFactory });
  const closed = await pass({ debt: 0n });
  const failed = await pass({ b14Failure: "failed", m34Failure: "failed", e8Failure: "transport", valuationFailure: true });
  for (const key of CLOSED_KEYS) {
    assert.equal(closed.state.targets[key].positionStatus, "CLOSED");
    const row = failed.state.targets[key];
    assert.ok(row, "cached identity is retained");
    assert.equal(row.positionStatus, "UNKNOWN");
    assert.equal(row.inactive, false);
    assert.equal(row.observationStatus, "INCOMPLETE");
    assert.equal(row.debtRaw, null);
    assert.equal(row.armed, false);
    assert.equal(row.liveQuote, null);
  }
  const reopened = await pass({ debt: 1n, e8Values: [W, 1n] });
  for (const key of CLOSED_KEYS) {
    const row = reopened.state.targets[key];
    assert.equal(row.positionStatus, "OPEN");
    assert.equal(row.inactive, false);
    assert.equal(row.debtRaw, "1");
    assert.equal(row.user, closed.state.targets[key].user);
    assert.equal(row.marketId, closed.state.targets[key].marketId);
    assert.equal(row.armed, false);
  }
});

function ethereumFixture(options = {}) {
  const price = 100_000_000n;
  const account = uints([0, 9300, 101n * W / 100n, 1030n * W * price, 955n * W * price * R, 1, 1]);
  const position = (supplied, drawn) => encode(["uint120", "uint120", "int200", "uint120", "uint32"], [drawn, 0, 0, supplied, 0]);
  const hub = (liquidity, shares, debt, decimals) => encode(
    ["uint120", "uint120", "uint8", "uint120", "uint120", "int256", "uint120", "uint120", "uint16", "uint120", "uint96", "uint40", "address", "address", "address", "address", "uint256"],
    [liquidity, 0, decimals, shares, 0, 0, debt, 0, 1000, R, 0, BigInt(ETH_HEADER.timestamp), ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, 0]
  );
  const feed = uints([1, price, BigInt(ETH_HEADER.timestamp), BigInt(ETH_HEADER.timestamp), 1]);
  const v3 = uints([2000n * price, 955n * price, 0, 0, 0, options.v3HealthFactor ?? 101n * W / 100n]);
  return aggregate([
    account, position(1030n * W, 0), position(0, 955_000000n),
    hub(1030n * W, 1030n * W, 0, 18), hub(0, 955_000000n, 955_000000n, 6),
    uints([price]), uints([price]), feed, feed, v3, v3, uints([955n * W]), uints([955n * W]),
    encode(["uint256[]"], [[price, price]]), uints([100_000000n, 0, 0, 0, 0, 0]), uints([1000_000000n]), uints([1000n * W]),
    hub(1010n * W, 1010n * W, 0, 18), hub(0, 955n * W, 955n * W, 18), uints([price]), uints([price]),
    ...Array.from({ length: 8 }, () => [account, position(1010n * W, 0), position(0, 955n * W)]).flat(),
    ...EXTRA_V3_WEETH_USERS.flatMap((_, i) => [
      uints([(2000n + BigInt(i) * 100n) * price, (1000n + BigInt(i) * 100n) * price, 0, 0, 0, options.extraV3HealthFactor ?? 101n * W / 100n]),
      uints([(1000n + BigInt(i) * 100n) * W]),
    ]),
    uints([1_000_000n * W, 0, 500_000n * W, 500_000n * W * 1_000_000n, options.m1LastUpdate ?? BigInt(ETH_HEADER.timestamp), 0]),
    uints(options.m1Position || [0, 200_000n * W * 1_000_000n, 240_000n * W]),
    uints([options.m1Price ?? 10n ** 36n]),
    uints([1_000_000000000n, 0, 500_000000000n, 500_000000000000000n, options.m2LastUpdate ?? BigInt(ETH_HEADER.timestamp), 0]),
    uints(options.m2Position || [0, 200_000000000000000n, 240_000n * W]),
    uints([options.m2Price ?? 10n ** 24n]),
  ]);
}

async function captureFixture(options = {}) {
  const calls = [];
  let ethCalls = 0, baseCalls = 0;
  const transport = async (rpc, method, params) => {
      calls.push({ rpc, method, params });
      if (rpc === "offline-ethereum") {
        if (method === "eth_getBlockByNumber") return ETH_HEADER;
        assert.equal(method, "eth_call");
        assert.equal(params[1], ETH_HEADER.hash);
        if (params[0].to.toLowerCase() === SYRUP_SPOKE) return syrupAccountResponse(params[0].data, options);
        if (params[0].to.toLowerCase() === A4_SPOKE) {
          assert.equal(A4_READ.decodeFunctionData("getUserAccountData", params[0].data)[0].toLowerCase(), A4_USER);
          if (options.a4Failure === "transport") throw new Error("A4_OFFLINE_TRANSPORT_FAILURE");
          if (options.a4Failure === "malformed") return "0x";
          return uints([0n, 9300n, options.a4HealthFactor ?? 1004360000000000000n,
            1234567n * 10n ** 24n, 987654n * 10n ** 51n, 2n, 2n]);
        }
        if (options.closure && params[0].to.toLowerCase() === "0x797dd80692c3b2dadabce8e30c07fde5307d48a9") {
          assert.equal(params[0].data, new ethers.Interface(["function debtOf(address)"]).encodeFunctionData("debtOf", ["0x3a8306fb4fa0811a86955f4421600e3b500a9e44"]));
          if (options.closure.e8Failure === "transport") throw new Error("OFFLINE_DEBT_READ_FAILED");
          return options.closure.e8Failure ? "0x" : uints([options.closure.debt ?? 0n]);
        }
        const requests = MC.decodeFunctionData("aggregate3", params[0].data)[0];
        if ((options.closure || options.whaleForecast) && ethCalls >= 2) {
          const rows = requests.map(() => ({ success: false, returnData: "0x" }));
          if (options.whaleForecast && requests.length >= 114) {
            for (const [index, request] of requests.entries()) {
              if (!["0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", "0xc13e21b648a5ee794902342038ff3adab66be987"].includes(request.target.toLowerCase())) continue;
              if (!request.callData.startsWith(A4_READ.getFunction("getUserAccountData").selector)) continue;
              rows[index] = { success: !options.whaleForecast.failed, returnData: options.whaleForecast.malformed ? "0x" :
                uints([100000000000000n, options.whaleForecast.debt ?? 50000000000000n, 0n, 0n, 0n, options.whaleForecast.hf ?? W + 1n]) };
            }
          }
          if (options.closure && requests.length >= 114) {
            if (!options.closure.valuationFailure) {
              rows[63] = { success: true, returnData: uints([10n * W, 0n, W, W * 1000000n, BigInt(ETH_HEADER.timestamp), 0n]) };
              rows[64] = { success: true, returnData: uints([10n ** 36n]) };
              rows[106] = { success: true, returnData: uints(options.closure.e8Values ?? [W, 0n]) };
            }
            if (options.closure.m34Failure !== "missing") rows[65] = {
              success: options.closure.m34Failure !== "failed",
              returnData: options.closure.m34Failure ? "0x" : uints([0n, options.closure.debt ?? 0n, W]),
            };
          } else if (requests.length === 25) {
            rows[15] = { success: true, returnData: uints([0n]) };
          }
          return MC.encodeFunctionResult("aggregate3", [rows]);
        }
        if (options.armedBase && requests.length === 4) return "0x"; // Optional PT discovery unavailable.
        if (++ethCalls === 1) {
          assert.equal(requests.length, 65);
          return ethereumFixture(options);
        }
        if (options.armedBase && ethCalls === 3) {
          // The unrelated optional Ethereum enrichment is unavailable here.
          return MC.encodeFunctionResult("aggregate3", [requests.map(() => ({ success: false, returnData: "0x" }))]);
        }
        assert.equal(ethCalls, 2);
        assert.equal(requests.length, 22);
        const rows = [uints([1000_000000n, 0, 0, 0]), ...Array.from({ length: 10 }, () => uints([1000n * W])),
          ...EXTRA_V3_WEETH_USERS.map((_, i) => uints([options.extraV3QuoteOut ?? (1000n + BigInt(i) * 10n) * W])),
          encode(["uint256", "uint160[]", "uint32[]", "uint256"], [options.m1QuoteOut ?? 108_000n * W, [], [], 100_000]),
          uints([options.m1Rate ?? 0n]),
          uints([options.m2QuoteOut ?? 108_000000000n]), uints([options.m2Rate ?? 0n]),
        ];
        return MC.encodeFunctionResult("aggregate3", [rows.map((returnData, i) =>
          (options.extraV3QuoteFailed && i >= 11 && i < 18) || (options.m1QuoteFailed && i === 18) || (options.m1RateFailed && i === 19) ||
          (options.m2QuoteFailed && i === 20) || (options.m2RateFailed && i === 21)
            ? { success: false, returnData: "0x" } : { success: true, returnData })]);
      }
      assert.equal(rpc, "offline-base");
      if (method === "eth_chainId") return options.chainId || "0x2105";
      if (method === "eth_getBlockByNumber") {
        assert.deepEqual(params, ["latest", false]);
        return options.header || BASE_HEADER;
      }
      assert.equal(method, "eth_call");
      assert.deepEqual(params[1], { blockHash: BASE_HEADER.hash, requireCanonical: true });
      if (options.armedBase && params[0].to.toLowerCase() === "0x46415998764c29ab2a25cbea6254146d50d22687") {
        return options.yoRateMalformed ? "0x" : uints([options.yoRate ?? 2000000000n]);
      }
      const baseRequests = MC.decodeFunctionData("aggregate3", params[0].data)[0];
      if (++baseCalls === 2) {
        assert.equal(baseRequests.length, 2);
        if (options.baseRateMalformed) return "0x";
        if (options.baseRateWrongShape) return aggregate(Array.from({ length: 7 }, () => uints([0n])));
        if (!options.baseRates) throw new Error("OPTIONAL_RATE_TRANSPORT_ERROR_DO_NOT_PERSIST");
        return MC.encodeFunctionResult("aggregate3", [options.baseRates.map(rate => rate === null
          ? { success: false, returnData: "0x" } : { success: true, returnData: rate === "malformed" ? "0x" : uints([rate]) })]);
      }
      if (options.armedBase && baseCalls === 3) {
        assert.equal(baseRequests.length, 6);
        return aggregate([...Array.from({ length: 4 }, () => uints([0, 100_000000000000n, 1000n * W])),
          uints([344617_720000n, 0n, 0n, 100000n]), uints([685802_730000n, 0n, 0n, 100000n])]);
      }
      if (options.armedBase && baseCalls === 4) {
        assert.equal(baseRequests.length, 3);
        const rows = [uints(options.yoMarket ?? [100000_000000n, 0n, 50000_000000n, 50000_000000000000n,
          BigInt(BASE_HEADER.timestamp) - (options.yoElapsed ?? 0n), 0n]),
        uints([options.yoPrice ?? 10678n * 10n ** 32n]), uints(options.yoPosition ?? [0n, (options.yoDebt ?? 4318_000000n) * 1000000n, 4420_000000n])];
        return MC.encodeFunctionResult("aggregate3", [rows.map((returnData, i) => ({ success: options.yoFailedRead !== i, returnData }))]);
      }
      if (options.closure && baseCalls >= 5) {
        const rows = baseRequests.map(() => ({ success: false, returnData: "0x" }));
        if (baseRequests.length === 12 && options.closure.b14Failure !== "missing") rows[10] = {
          success: options.closure.b14Failure !== "failed",
          returnData: options.closure.b14Failure ? "0x" : uints([0n, options.closure.debt ?? 0n, W]),
        };
        return MC.encodeFunctionResult("aggregate3", [rows]);
      }
      assert.equal(baseRequests.length, 7);
      if (options.failRead) throw new Error("PRIVATE_TRANSPORT_ERROR_DO_NOT_PERSIST");
      if (options.failedSubcall) return MC.encodeFunctionResult("aggregate3", [[{ success: false, returnData: "0x" }]]);
      const market = options.market || [2_000_000000n, 0, 1_000_000000n, 1_000_000000000000n, 1, 0];
      const position = options.position || [0, 100_000000000000n, 1000n * W];
      const price = options.price ?? 10n ** 24n;
      return aggregate([uints(market), uints(market), uints([price]), uints([price]), ...Array.from({ length: 3 }, () => uints(position))]);
  };
  const collect = options.collectorFactory ? options.collectorFactory(transport) : options.armedBase ? defaultTransportCollector(transport) : checkOnce;
  const state = await collect({
    writeOut: false,
    includeA4: options.includeA4,
    includeA5: options.includeA5,
    includeA6A7: options.includeA6A7,
    includeM7B: options.includeM7B,
    includeEulerYn: options.includeEulerYn,
    includeM10M11: Boolean(options.closure || options.whaleForecast),
    includeV3Whales: Boolean(options.whaleForecast),
    includeSparkWhales: Boolean(options.whaleForecast),
    nextBlockContext: options.nextBlockContext,
    resolveRpc: async chainId => {
      calls.push({ resolve: chainId });
      if (chainId === 1) return "offline-ethereum";
      assert.equal(chainId, 8453);
      return options.missingRpc ? null : "offline-base";
    },
    ...(options.armedBase ? {} : { rpcCall: transport }),
  });
  return { state, calls };
}

test("A6/A7 opt-in preserves A5's single call and all existing targets", async () => {
  const baseline = await captureFixture();
  assert.ok(SYRUP_ROWS.every(row => baseline.state.targets[row.key] === undefined));
  const a5Only = await captureFixture({ includeA5: true });
  const both = await captureFixture({ includeA5: true, includeA6A7: true });
  const reads = fixture => fixture.calls.filter(call => call.method === "eth_call" && call.params[0].to.toLowerCase() === SYRUP_SPOKE);
  assert.equal(reads(a5Only).length, 1);
  assert.deepEqual(reads(both).map(call => A4_READ.decodeFunctionData("getUserAccountData", call.params[0].data)[0].toLowerCase()), SYRUP_ROWS.map(row => row.user));
  assert.ok(reads(both).every(call => call.rpc === "offline-ethereum" && call.params[1] === ETH_HEADER.hash));
  const { [SYRUP_ROWS[1].key]: a6, [SYRUP_ROWS[2].key]: a7, ...unchanged } = both.state.targets;
  assert.deepEqual(unchanged, a5Only.state.targets);
  assert.deepEqual(both.state.firedTriggers, []);
  for (const [i, row] of [a6, a7].entries()) {
    const expected = SYRUP_ROWS[i + 1];
    assert.equal(row.rank, expected.rank); assert.equal(row.user, expected.user); assert.equal(row.spoke, SYRUP_SPOKE);
    assert.equal(row.pair, "syrupUSDG / USDG (UniV4)");
    assert.equal(row.armed, false); assert.equal(row.observationOnly, false); assert.equal(row.executableNow, false);
    assert.equal(row.executor, SYRUP_EXECUTOR); assert.equal(row.deployedExecutor, SYRUP_EXECUTOR);
    assert.equal(row.collateralUsd, 185630); assert.equal(row.debtUsd, 170160);
    assert.deepEqual(quoteValues(row.liveQuote), expected.quote);
    assert.equal(row.readyExecuteUniV4FlashCalldata, SYRUP_EXEC.encodeFunctionData("execute", [syrupPlan(expected)]));
  }
});

test("A6/A7 use strictly positive underwater HF and select the scoped UniV4 candidates", async () => {
  for (const hf of [0n, 1n, W - 1n, W, W + 1n]) {
    const { state } = await captureFixture({ includeA6A7: true, syrupHealthFactors: { "#A6": hf, "#A7": hf } });
    const liquidatable = hf > 0n && hf < W;
    assert.deepEqual(state.firedTriggers, liquidatable ? SYRUP_ROWS.slice(1).map(row => row.trigger) : []);
    assert.equal(state.anyTriggerFired, liquidatable);
    for (const expected of SYRUP_ROWS.slice(1)) {
      const row = state.targets[expected.key];
      assert.equal(row.liquidatableNow, liquidatable); assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, liquidatable);
      assert.equal(row.healthFactor, Number(hf) / 1e18);
      assert.equal(row.bpsToLiquidation, hf > 0n ? +((1 - 1 / row.healthFactor) * 10000).toFixed(4) : null);
      const candidates = selectCandidates({ targets: { [expected.key]: row } }, ["--skip-aave-v4"]);
      assert.equal(candidates.length, liquidatable ? 1 : 0);
      if (liquidatable) {
        assert.equal(candidates[0].kind, "UNIV4_FLASH_LIQUIDATION");
        assert.equal(candidates[0].executor, SYRUP_EXECUTOR);
        assert.equal(candidates[0].borrower, expected.user); assert.equal(candidates[0].target, SYRUP_SPOKE);
        assert.equal(candidates[0].minProfitRaw, expected.minProfit);
        assert.equal(candidates[0].profitToken, syrupPlan(expected).debtAsset);
        assert.equal(candidates[0].data, row.readyExecuteUniV4FlashCalldata);
      }
    }
  }
});

test("A6/A7 failures omit only the unavailable borrower without affecting A5", async () => {
  const options = { includeA5: true, includeA6A7: true, syrupHealthFactors: { "#A6": W / 2n, "#A7": W / 2n } };
  const baseline = await captureFixture(options);
  for (const failed of SYRUP_ROWS.slice(1)) {
    for (const failure of ["transport", "malformed"]) {
      const { state } = await captureFixture({ ...options, syrupFailures: { [failed.rank]: failure } });
      const { [failed.key]: _, ...remaining } = baseline.state.targets;
      assert.deepEqual(state.targets, remaining);
      assert.deepEqual(state.firedTriggers, baseline.state.firedTriggers.filter(trigger => trigger !== failed.trigger));
      assert.equal(JSON.stringify(state).includes("SYRUP_OFFLINE_TRANSPORT_FAILURE"), false);
    }
  }
});

test("A6/A7 are read by the default transport without the injected-transport opt-in", async () => {
  const { state, calls } = await captureFixture({ armedBase: true, includeA6A7: false, baseRates: [0n, 0n] });
  for (const expected of SYRUP_ROWS.slice(1)) {
    assert.equal(state.targets[expected.key].executor, SYRUP_EXECUTOR);
    assert.equal(calls.filter(call => call.method === "eth_call" && call.params[0].to.toLowerCase() === SYRUP_SPOKE
      && call.params[0].data === A4_READ.encodeFunctionData("getUserAccountData", [expected.user])).length, 1);
  }
});

test("A6/A7 reject altered identity, route, amounts, floors, deadline and noncanonical calldata", async () => {
  const { state } = await captureFixture({ includeA6A7: true, syrupHealthFactors: { "#A6": W / 2n, "#A7": W / 2n } });
  for (const expected of SYRUP_ROWS.slice(1)) {
    const row = state.targets[expected.key], plan = syrupPlan(expected);
    const mutations = [
      { mode: 1 }, { target: A4_SPOKE }, { collateralVault: A4_SPOKE }, { collateralReserveId: 0n }, { debtReserveId: 4n },
      { borrower: A4_USER }, { debtAsset: A4_SPOKE }, { collateralAsset: A4_SPOKE },
      { flashAmount: plan.flashAmount - 1n }, { debtToCover: plan.debtToCover - 1n },
      { minCollateralSeized: plan.minCollateralSeized - 1n }, { minSwapOut: plan.minSwapOut - 1n },
      { minProfit: plan.minProfit - 1n }, { deadline: 1n }, { zeroForOne: false },
      ...Object.entries({ currency0: A4_SPOKE, currency1: A4_SPOKE, fee: 801, tickSpacing: 6, hooks: A4_SPOKE })
        .map(([key, value]) => ({ poolKey: { ...plan.poolKey, [key]: value } })),
    ];
    for (const change of mutations) {
      const data = SYRUP_EXEC.encodeFunctionData("execute", [{ ...plan, ...change }]);
      assert.throws(() => selectCandidates({ targets: { [expected.key]: { ...row, readyExecuteUniV4FlashCalldata: data } } }),
        /EXECUTION_TARGET_MISMATCH|EXECUTION_ROUTE_NOT_ALLOWED|PLAN_PROFIT_OR_SLIPPAGE_INVALID/);
    }
    assert.throws(() => selectCandidates({ targets: { [expected.key]: { ...row, user: A4_USER } } }), /COLLECTOR_TARGET_MISMATCH/);
    assert.throws(() => selectCandidates({ targets: { [expected.key]: { ...row, readyExecuteUniV4FlashCalldata: row.readyExecuteUniV4FlashCalldata + "00" } } }), /EXECUTION_CALLDATA_INVALID/);
    for (const change of [{ liquidatableNow: false }, { eligibleForPreflight: false }, { readyExecuteUniV4FlashCalldata: undefined }]) {
      assert.deepEqual(selectCandidates({ targets: { [expected.key]: { ...row, ...change } } }), []);
    }
  }
});

test("unified runner opts into A6/A7 discovery in an offline check-only pass", async () => {
  const pin = { hash: ETH_HEADER.hash, number: Number(BigInt(ETH_HEADER.number)) };
  let collected = false;
  const result = await runPass({ pinned: { pin, collectorOptions: {}, assertUsable() {}, async recheck() {} },
    checkOnce: async options => {
      collected = true; assert.equal(options.includeA5, true); assert.equal(options.includeA6A7, true);
      return { pin: { chainId: 1, ...pin }, targets: {} };
    } });
  assert.equal(collected, true); assert.equal(result.fired, false); assert.equal(result.summary.mode, "CHECK_ONLY");
});

test("A6/A7 batch metadata binds the exact borrowers, triggers, tokens and executor", () => {
  const batch = require("../../coordination/live-execution-batch-morpho-trigger.json");
  for (const expected of SYRUP_ROWS.slice(1)) {
    const plan = syrupPlan(expected);
    assert.ok(batch.targetRanks.includes(expected.rank)); assert.ok(batch.triggerConditions.includes(expected.trigger));
    assert.deepEqual(batch.targetWhales.find(row => row.rank === expected.rank), {
      rank: expected.rank, borrower: expected.user, trigger: expected.trigger, executor: SYRUP_EXECUTOR,
      action: "UNIV4_FLASH_LIQUIDATION", spoke: SYRUP_SPOKE, debtToken: plan.debtAsset, collateralToken: plan.collateralAsset,
    });
    assert.ok(batch.targets.some(t => t.address?.toLowerCase() === SYRUP_EXECUTOR));
  }
  assert.ok(batch.targetRanks.includes("#M10") && batch.targetRanks.includes("#M11"));
  assert.ok(batch.triggerConditions.includes("TARGET_M10_MORPHO_USDE_RLUSD_LIQUIDATABLE"));
  assert.ok(batch.triggerConditions.includes("TARGET_M11_MORPHO_WEETH_WETH_LIQUIDATABLE"));
});

test("A4 is absent from injected transports unless explicitly enabled, preserving all existing batch sizes", async () => {
  const basic = await captureFixture();
  const extended = await captureExtendedFixture({ pt: true });
  for (const fixture of [basic, extended]) {
    assert.equal(fixture.state.targets[A4_KEY], undefined);
    assert.equal(fixture.calls.some(c => c.method === "eth_call" && c.params[0].to.toLowerCase() === A4_SPOKE), false);
  }
  const batchSizes = fixture => fixture.calls.filter(c => c.rpc === "offline-ethereum" && c.method === "eth_call"
    && c.params[0].data.startsWith(MC.getFunction("aggregate3").selector))
    .map(c => MC.decodeFunctionData("aggregate3", c.params[0].data)[0].length);
  assert.deepEqual(batchSizes(basic), [65, 22]);
  assert.deepEqual(batchSizes(extended), [65, 22, 16, 5, 4]);
});

test("A4 opt-in uses one pinned direct spoke read and emits the non-authorizing fixed zero-swap plan", async () => {
  const baseline = await captureFixture();
  const { state, calls } = await captureFixture({ includeA4: true });
  const reads = calls.filter(c => c.method === "eth_call" && c.params[0].to.toLowerCase() === A4_SPOKE);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].rpc, "offline-ethereum");
  assert.deepEqual(reads[0].params, [{ to: A4_SPOKE,
    data: A4_READ.encodeFunctionData("getUserAccountData", [A4_USER]) }, ETH_HEADER.hash]);
  const row = state.targets[A4_KEY];
  assert.deepEqual(row, {
    rank: "#A4", user: A4_USER, spoke: A4_SPOKE, pair: "WETH / USDC (Same-Asset)",
    ...monitorFields(state.pin, "HISTORICAL_REFERENCE", false),
    observationOnly: false, armed: false, executableNow: false, executor: "0xf09a01a6c23b936d5a51abce87a6ec8442a44262",
    deployedExecutor: "0xf09a01a6c23b936d5a51abce87a6ec8442a44262",
    readinessNote: "Route configured (read-only; runner unverified) on Unified 0xf09a...4262 (same-asset WETH/WETH Reserve 0, ~0.0337 WETH / ~$82.64 bonus, 0.01 WETH min profit).",
    healthFactor: 1.00436, liquidatableNow: false,
    bpsToLiquidation: +((1 - 1 / 1.00436) * 10000).toFixed(4),
    collateralUsd: 12345.67, debtUsd: 9876.54,
    liveQuote: { ...quoteFields("HISTORICAL_REFERENCE"), repayUsdc: 1741.77, seizedUsde: 1812.31, uniV3OutUsdc: 1812.31, grossSurplusUsdc: 70.54 },
    readyExecuteMorphoCalldata: a4ExpectedCalldata(),
  });
  const { [A4_KEY]: _, ...others } = state.targets;
  assert.deepEqual(others, baseline.state.targets);
  assert.equal(calls.length, baseline.calls.length + 1);
  assert.deepEqual(state.firedTriggers, []);
  assert.equal(state.anyTriggerFired, false);
});

test("A4 raw HF threshold gates its trigger and candidate while keeping zero-safe bps and fixed calldata", async () => {
  for (const hf of [W + 1n, W, W - 1n, 99n * W / 100n, 0n]) {
    const { state } = await captureFixture({ includeA4: true, a4HealthFactor: hf });
    const row = state.targets[A4_KEY];
    assert.equal(row.healthFactor, Number(hf) / 1e18);
    assert.equal(row.liquidatableNow, hf < W);
    assert.equal(row.bpsToLiquidation, hf > 0n ? +((1 - 1 / row.healthFactor) * 10000).toFixed(4) : null);
    assert.equal(row.observationOnly, false); assert.equal(row.armed, false);
    assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, hf < W);
    assert.equal(row.readyExecuteMorphoCalldata, a4ExpectedCalldata());
    assert.deepEqual(state.firedTriggers, hf < W ? ["TARGET_A4_AAVE_V4_0xA429_LIQUIDATABLE"] : []);
    assert.equal(state.anyTriggerFired, hf < W);
    const selected = selectCandidates({ targets: { [A4_KEY]: row } }, ["--skip-aave-v4"]);
    assert.equal(selected.length, hf < W ? 1 : 0);
    if (hf < W) {
      assert.equal(selected[0].kind, "AAVE_V4_SAME_ASSET_WETH");
      assert.equal(selected[0].data, a4ExpectedCalldata());
    }
  }
});

test("A4 unavailable or malformed evidence omits only A4 and preserves existing targets", async () => {
  const baseline = await captureFixture();
  for (const a4Failure of ["transport", "malformed"]) {
    const { state } = await captureFixture({ includeA4: true, a4Failure });
    assert.deepEqual(state.targets, baseline.state.targets);
    assert.deepEqual(state.firedTriggers, baseline.state.firedTriggers);
    assert.equal(JSON.stringify(state).includes("A4_OFFLINE_TRANSPORT_FAILURE"), false);
  }
});

test("A4 default transport path reads the observation without an opt-in and without endpoint access", async () => {
  const { state, calls } = await captureFixture({ armedBase: true, includeA4: false, baseRates: [0n, 0n] });
  assert.equal(state.targets[A4_KEY].observationOnly, false); assert.equal(state.targets[A4_KEY].armed, false);
  assert.equal(state.targets[A4_KEY].executableNow, false);
  assert.equal(calls.filter(c => c.method === "eth_call" && c.params[0].to.toLowerCase() === A4_SPOKE).length, 1);
  assert.deepEqual(state.targets.extra_Base_USDe_Whales.map(row => row.rank), ["#B4", "#B5", "#B6", "#B7"]);
});

test("Base captures all three whales through injected transport at a distinct validated pin", async () => {
  const { state, calls } = await captureFixture();
  assert.deepEqual(state.baseObservation, {
    status: "COMPLETE", reason: null,
    pin: { chainId: 8453, number: Number(BigInt(BASE_HEADER.number)), hash: BASE_HEADER.hash,
      timestamp: Number(BigInt(BASE_HEADER.timestamp)), utc: new Date(Number(BigInt(BASE_HEADER.timestamp)) * 1000).toISOString() }
  });
  assert.notEqual(state.pin.hash, state.baseObservation.pin.hash);
  assert.equal(calls.some(call => call.resolve === 8453), true);
  assert.equal(state.targets.base_Morpho_Whales.length, 3);
  assert.equal(state.targets.extra_Base_USDe_Whales, undefined);
  for (const row of state.targets.base_Morpho_Whales) {
    assert.equal(row.chainId, 8453);
    assert.equal(row.observationBlock, state.baseObservation.pin.number);
    assert.equal(row.observationHash, BASE_HEADER.hash);
    assert.equal(row.observationTimestamp, state.baseObservation.pin.timestamp);
    assert.equal(row.observationUtc, state.baseObservation.pin.utc);
    assert.equal(row.observationOnly, true);
    assert.equal(row.executableNow, false);
    assert.equal(row.executor, null);
    assert.equal(row.conservativeNetUsd, null);
    assert.equal(row.liquidatableNow, null);
    assert.equal(row.healthIsEstimate, true);
    assert.equal(row.storedHealthFactor, row.healthFactor);
    assert.equal(row.borrowAprPct, null); assert.equal(row.passiveHoursToCrossing, null);
    assert.match(row.readinessNote, /unaccrued interest/);
    assert.equal("readyExecuteMorphoCalldata" in row, false);
    assert.equal("grossBonusUsd" in row, false);
    assert.equal("collateralUsd" in row, false);
  }
  assert.equal(state.targets.spokeC_AaveV4_weETH_WETH.length, 8);
  assert.equal(state.targets.additional_AaveV3_weETH_WETH.length, 7);
});

test("default Base enrichment captures B7 at its own pinned six-decimal yoUSD market with accrued health", async () => {
  const elapsed = 7200n, rate = 2000000000n;
  const { state, calls } = await captureFixture({ armedBase: true, baseRates: [0n, 0n], yoElapsed: elapsed, yoRate: rate });
  assert.deepEqual(state.targets.extra_Base_USDe_Whales.map(row => row.rank), ["#B4", "#B5", "#B6", "#B7"]);
  const row = state.targets.extra_Base_USDe_Whales[3];
  assert.equal(row.user, YOUSD_USER); assert.equal(row.marketId, YOUSD_MKT);
  assert.equal(row.pair, "yoUSD / USDC (Base)"); assert.equal(row.chainId, 8453);
  assert.equal(row.deployedExecutor, "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32");
  assert.equal(row.armed, false); assert.equal(row.observationOnly, false); assert.equal(row.healthIsEstimate, false);
  assert.equal(row.observationStatus, "COMPLETE"); assert.equal(row.observationHash, BASE_HEADER.hash);
  assert.equal(row.observationBlock, Number(BigInt(BASE_HEADER.number)));
  const accrued = 50000_000000n + 50000_000000n * wTaylorCompounded(rate, elapsed) / W;
  const denominator = 50000_000000000000n + 1000000n;
  const debt = (4318_000000000000n * (accrued + 1n) + denominator - 1n) / denominator;
  const maxBorrow = 4420_000000n * 10678n / 10000n * 915n / 1000n;
  assert.equal(row.debtUsdcRaw, debt.toString());
  assert.equal(row.healthFactor, Number(maxBorrow) / Number(debt));
  assert.ok(row.healthFactor < row.storedHealthFactor);
  assert.equal(row.liquidatableNow, false); assert.equal(row.executableNow, false);
  assert.equal(row.bpsToLiquidation, +(Number(maxBorrow - debt) / Number(maxBorrow) * 10000).toFixed(4));
  assert.equal(row.passiveHoursToCrossing, +(Number(maxBorrow - debt) / Number(debt * rate / W) / 3600).toFixed(2));
  const ceil = (a, b) => (a + b - 1n) / b;
  const discounted = ceil(4377980000n * W, 1026167265264238070n);
  const repaidShares = ceil(discounted * denominator, accrued + 1n);
  const repay = ceil(repaidShares * (accrued + 1n), denominator);
  const netOut = 4377980000n - ceil(4377980000n * 10000000000000n, 1000010000000000000n);
  const surplus = +(Number(netOut - repay) / 1e6).toFixed(2);
  assert.deepEqual(quoteValues(row.liveQuote), { repayUsdc: +(Number(repay) / 1e6).toFixed(2), seizedUsde: 4100,
    uniV3OutUsdc: +(Number(netOut) / 1e6).toFixed(2), grossSurplusUsdc: surplus, grossSurplusUsd: surplus });
  const reads = new ethers.Interface(["function market(bytes32)", "function position(bytes32,address)", "function price()"]);
  const baseCalls = calls.filter(c => c.rpc === "offline-base" && c.method === "eth_call");
  const yoCalls = MC.decodeFunctionData("aggregate3", baseCalls[3].params[0].data)[0];
  assert.equal(reads.decodeFunctionData("market", yoCalls[0].callData)[0], YOUSD_MKT);
  assert.equal(yoCalls[1].target.toLowerCase(), YOUSD_ORACLE); assert.equal(yoCalls[1].callData, reads.encodeFunctionData("price"));
  const pos = reads.decodeFunctionData("position", yoCalls[2].callData);
  assert.equal(pos[0], YOUSD_MKT); assert.equal(pos[1].toLowerCase(), YOUSD_USER);
  const irm = BLUE_IRM.decodeFunctionData("borrowRateView", baseCalls[4].params[0].data);
  assert.deepEqual(Array.from(irm[0]).slice(0, 4).map(v => v.toLowerCase()), ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    YOUSD, YOUSD_ORACLE, "0x46415998764c29ab2a25cbea6254146d50d22687"]);
  assert.equal(irm[0][4], 915000000000000000n);
  assert.equal(irm[1][4], BigInt(BASE_HEADER.timestamp) - elapsed);
  assert.deepEqual(state.firedTriggers, []);
});

test("B7 C3 watcher quote derives share-capped seizure, rounded repayment and redemption fee from the pinned inputs", async () => {
  const borrowerShares = 3727803099418226n, accrued = 273899777069n, totalShares = 252041854962215031n;
  const price = 1067877000000000000000000000000000000n;
  const ceil = (a, b) => (a + b - 1n) / b;
  for (const [shares, collateral, seize] of [[borrowerShares, 4162749493n, 3892861030n],
    [borrowerShares, 1000_000000n, 1000_000000n], [0n, 4162749493n, 0n]]) {
    const { state } = await captureFixture({ armedBase: true, baseRates: [0n, 0n], yoRate: 0n, yoPrice: price,
      yoMarket: [300000_000000n, 0n, accrued, totalShares, BigInt(BASE_HEADER.timestamp), 0n],
      yoPosition: [0n, shares, collateral] });
    const row = state.targets.extra_Base_USDe_Whales.find(r => r.rank === "#B7");
    const discounted = ceil(ceil(seize * price, 10n ** 36n) * W, 1026167265264238070n);
    const repaidShares = ceil(discounted * (totalShares + 1000000n), accrued + 1n);
    const repay = ceil(repaidShares * (accrued + 1n), totalShares + 1000000n);
    const gross = seize * price / (10n ** 36n);
    const net = gross - ceil(gross * 10000000000000n, 1000010000000000000n);
    const surplus = +(Number(net - repay) / 1e6).toFixed(2);
    assert.ok(repaidShares <= shares);
    if (seize === 3892861030n) assert.equal(repay, 4051090793n);
    assert.deepEqual(quoteValues(row.liveQuote), { repayUsdc: +(Number(repay) / 1e6).toFixed(2),
      seizedUsde: +(Number(seize) / 1e6).toFixed(6), uniV3OutUsdc: +(Number(net) / 1e6).toFixed(2),
      grossSurplusUsdc: surplus, grossSurplusUsd: surplus });
    assert.equal(row.observationHash, BASE_HEADER.hash);
  }
});

test("B7 enrichment fails closed on missing market/price/position or rate while preserving USDe whales", async () => {
  for (const options of [{ yoFailedRead: 0 }, { yoFailedRead: 1 }, { yoFailedRead: 2 }, { yoPrice: 0n }, { yoRateMalformed: true }]) {
    const { state } = await captureFixture({ armedBase: true, baseRates: [0n, 0n], ...options });
    assert.deepEqual(state.targets.extra_Base_USDe_Whales.map(row => row.rank), ["#B4", "#B5", "#B6"]);
    assert.equal(state.targets.targetB0_Base_USDe_USDC.rank, "#B0");
  }
  const { state } = await captureFixture({ armedBase: true, baseRates: [0n, 0n], yoDebt: 4500_000000n });
  const row = state.targets.extra_Base_USDe_Whales[3];
  assert.equal(row.liquidatableNow, true); assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, true);
  assert.equal(row.passiveHoursToCrossing, 0);
});

test("seven additional V3 whales keep ordered account/debt sizing, Curve quotes and borrower-bound calldata", async () => {
  const { state, calls } = await captureFixture();
  const rows = state.targets.additional_AaveV3_weETH_WETH;
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map(row => row.rank), ["#2C", "#2D", "#2E", "#2F", "#2G", "#2H", "#2I"]);
  assert.deepEqual(rows.map(row => row.user), EXTRA_V3_WEETH_USERS);
  const ethCalls = calls.filter(call => call.rpc === "offline-ethereum" && call.method === "eth_call");
  const first = MC.decodeFunctionData("aggregate3", ethCalls[0].params[0].data)[0];
  const second = MC.decodeFunctionData("aggregate3", ethCalls[1].params[0].data)[0];
  const reads = new ethers.Interface(["function getUserAccountData(address)", "function balanceOf(address)", "function get_dy(int128,int128,uint256)"]);
  const primary = UNIFIED_IFACE.decodeFunctionData("executeMorpho", state.targets.target2A_AaveV3_weETH_WETH_0x7231.readyExecuteMorphoCalldata)[1];
  for (const [i, row] of rows.entries()) {
    const repay = (1000n + BigInt(i) * 100n) * W / 2n, seized = computeV3WeEthSizing(repay, 100_000_000n, 100_000_000n);
    const out = (1000n + BigInt(i) * 10n) * W;
    assert.equal(first[45 + i * 2].target.toLowerCase(), row.pool.toLowerCase());
    assert.equal(reads.decodeFunctionData("getUserAccountData", first[45 + i * 2].callData)[0].toLowerCase(), row.user);
    assert.equal(reads.decodeFunctionData("balanceOf", first[46 + i * 2].callData)[0].toLowerCase(), row.user);
    assert.deepEqual(Array.from(reads.decodeFunctionData("get_dy", second[11 + i].callData)), [1n, 0n, seized]);
    assert.equal(row.healthFactor, 1.01); assert.equal(row.liquidatableNow, false);
    assert.equal(row.bpsToLiquidation, 99.0099);
    assert.equal(row.collateralUsd, 2000 + i * 100); assert.equal(row.debtUsd, 1000 + i * 100);
    assert.deepEqual(quoteValues(row.liveQuote), { repayWeth: Number(repay) / 1e18, seizedWeEth: Number(ethers.formatUnits(seized, 18)),
      curveOutWeth: Number(out) / 1e18, grossSurplusWeth: Number(out - repay) / 1e18, grossSurplusUsd: Number(out - repay) / 1e18 });
    assert.equal(row.readyExecuteMorphoCalldata, UNIFIED_IFACE.encodeFunctionData("executeMorpho", [repay, {
      ...primary.toObject(), borrower: row.user, minCollateralSeized: seized * 9950n / 10000n, minDebtTokenOut: out * 9950n / 10000n,
    }]));
  }
  assert.deepEqual(state.firedTriggers, []);
});

test("additional V3 triggers require both liquidatable health and sufficient successful quote surplus", async () => {
  const { state } = await captureFixture({ extraV3HealthFactor: 99n * W / 100n });
  assert.deepEqual(state.firedTriggers, EXTRA_V3_WEETH_USERS.map((user, i) =>
    `TARGET_2${String.fromCharCode(67 + i)}_AAVE_V3_${user.slice(0, 6)}_LIQUIDATABLE`));
  assert.equal(state.anyTriggerFired, true);
  for (const options of [{ extraV3QuoteOut: 1n }, { extraV3QuoteFailed: true }]) {
    const { state: blocked } = await captureFixture({ ...options, extraV3HealthFactor: 99n * W / 100n });
    assert.ok(blocked.targets.additional_AaveV3_weETH_WETH.every(row => row.liquidatableNow && row.liveQuote.grossSurplusWeth < 0));
    assert.deepEqual(blocked.firedTriggers, []); assert.equal(blocked.anyTriggerFired, false);
  }
});

test("Ethereum Morpho M1 captures stored health and the fixed USDe-USDC-DAI quote with dedicated executor calldata", async () => {
  const { state, calls } = await captureFixture(), row = state.targets.targetM1_Morpho_USDe_DAI;
  const market = "0xc581c5f70bd1afa283eed57d1418c6432cbff1d862f94eaf58fdd4e46afbb67f";
  const user = "0xa3609cf7872faa7804281c7c5edb8b2d33001089";
  const usde = "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const dai = "0x6b175474e89094c44da98b954eedeac495271d0f", oracle = "0xae4750d0813b5e37a51f7629beedd72af1f9ca35";
  const swapPath = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [usde, 100, usdc, 100, dai]);
  const reads = new ethers.Interface(["function market(bytes32)", "function position(bytes32,address)", "function price()", "function quoteExactInput(bytes,uint256)"]);
  const ethCalls = calls.filter(call => call.rpc === "offline-ethereum" && call.method === "eth_call");
  const first = MC.decodeFunctionData("aggregate3", ethCalls[0].params[0].data)[0];
  const second = MC.decodeFunctionData("aggregate3", ethCalls[1].params[0].data)[0];
  assert.equal(first[59].target.toLowerCase(), "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb");
  assert.equal(first[60].target, first[59].target);
  assert.equal(reads.decodeFunctionData("market", first[59].callData)[0], market);
  const positionArgs = reads.decodeFunctionData("position", first[60].callData);
  assert.equal(positionArgs[0], market); assert.equal(positionArgs[1].toLowerCase(), user);
  assert.equal(first[61].target.toLowerCase(), oracle);
  assert.equal(first[61].callData, reads.encodeFunctionData("price"));
  assert.equal(second[18].target.toLowerCase(), "0x61ffe014ba17989e743c5f6cb21bf9697530b21e");
  assert.deepEqual(Array.from(reads.decodeFunctionData("quoteExactInput", second[18].callData)), [swapPath, 108500n * W]);
  assert.equal(row.rank, "#M1"); assert.equal(row.user, user); assert.equal(row.marketId, market);
  assert.equal(row.pair, "USDe / DAI"); assert.equal(row.healthFactor, 1.032); assert.equal(row.liquidatableNow, false);
  assert.equal(row.bpsToLiquidation, 310.0775); assert.equal(row.collateralUsd, 240000); assert.equal(row.debtUsd, 200000);
  assert.equal(row.deployedExecutor, "0xaf5b033e23ac555c09096bf39979a855e09907ba");
  const repay = (108500n * W * W + 1043841336116910229n - 1n) / 1043841336116910229n;
  const gain = +(Number(108000n * W - repay) / 1e18).toFixed(2);
  assert.ok(repay < 104900n * W);
  assert.deepEqual(quoteValues(row.liveQuote), { repayDai: +(Number(repay) / 1e18).toFixed(2), seizedUsde: 108500,
    uniV3OutDai: 108000, grossSurplusDai: gain, grossSurplusUsd: gain });
  const decoded = MORPHO_EXEC.decodeFunctionData("execute", row.m1Nomination.calldataTemplate);
  assert.deepEqual(Array.from(decoded[0]).slice(0, 4).map(value => value.toLowerCase()),
    [dai, usde, oracle, "0x870ac11d48b15db9a138cf899d20f13f79ba00bc"]);
  assert.equal(decoded[0][4], 860000000000000000n);
  assert.equal(decoded[1].toLowerCase(), user); assert.equal(decoded[2], 108500n * W);
  assert.equal(decoded[3], 0n); assert.equal(decoded[4], 25n * W); assert.equal(decoded[5], 0n);
  assert.equal(decoded[6].toLowerCase(), "0xe592427a0aece92de3edee1f18e0157c05861564"); assert.equal(decoded[7], swapPath);
  assert.equal(second[19].target.toLowerCase(), "0x870ac11d48b15db9a138cf899d20f13f79ba00bc");
  const irmArgs = BLUE_IRM.decodeFunctionData("borrowRateView", second[19].callData);
  assert.deepEqual(Array.from(irmArgs[0]), Array.from(decoded[0]));
  assert.deepEqual(Array.from(irmArgs[1]), [1_000_000n * W, 0n, 500_000n * W, 500_000n * W * 1_000_000n, BigInt(ETH_HEADER.timestamp), 0n]);
  assert.equal(row.storedHealthFactor, 1.032);
  assert.equal(row.borrowAprPct, 0); assert.equal(row.passiveHoursToCrossing, null);
  assert.equal(row.readyExecuteMorphoBlueCalldata, null);
  assert.equal(row.m1Nomination.calldataTemplate.slice(0, 10), "0x834cbf54");
  assert.ok(row.m1Nomination.calldataTemplate.length >= 650);
  assert.deepEqual(state.firedTriggers, []);
});

test("M1 oracle-priced repayment decreases below par and fires when health crosses with sufficient surplus", async () => {
  const m1Position = [0, 200_000n * W * 1_000_000n, 232_600n * W];
  const price = 998800000000000000000000000000000000n;
  const { state: par } = await captureFixture({ m1Position });
  const { state } = await captureFixture({ m1Position, m1Price: price });
  const row = state.targets.targetM1_Morpho_USDe_DAI, parRow = par.targets.targetM1_Morpho_USDe_DAI;
  const quoted = (108500n * W * price + 10n ** 36n - 1n) / (10n ** 36n);
  const repay = (quoted * W + 1043841336116910229n - 1n) / 1043841336116910229n;
  assert.equal(row.liveQuote.repayDai, +(Number(repay) / 1e18).toFixed(2));
  assert.equal(row.liveQuote.grossSurplusDai, +(Number(108000n * W - repay) / 1e18).toFixed(2));
  assert.ok(row.liveQuote.repayDai < parRow.liveQuote.repayDai);
  assert.ok(row.liveQuote.grossSurplusDai > parRow.liveQuote.grossSurplusDai);
  assert.equal(row.liveQuote.seizedUsde, 108500);
  assert.equal(parRow.liquidatableNow, false); assert.deepEqual(par.firedTriggers, []);
  assert.equal(row.liquidatableNow, true);
  assert.deepEqual(state.firedTriggers, ["TARGET_M1_MORPHO_USDE_DAI_LIQUIDATABLE"]);
  assert.equal(state.anyTriggerFired, true);
});

test("M1 caps the pinned quote and executor calldata to available collateral", async () => {
  const seize = 50000n * W, out = 49800n * W;
  const { state, calls } = await captureFixture({ m1Position: [0, 50_000n * W * 1_000_000n, seize], m1QuoteOut: out });
  const row = state.targets.targetM1_Morpho_USDe_DAI;
  const quoteCall = calls.filter(call => call.rpc === "offline-ethereum" && call.method === "eth_call")[1];
  const requests = MC.decodeFunctionData("aggregate3", quoteCall.params[0].data)[0];
  const quoter = new ethers.Interface(["function quoteExactInput(bytes,uint256)"]);
  const quote = quoter.decodeFunctionData("quoteExactInput", requests[18].callData);
  const decoded = MORPHO_EXEC.decodeFunctionData("execute", row.m1Nomination.calldataTemplate);
  assert.equal(requests[18].target.toLowerCase(), "0x61ffe014ba17989e743c5f6cb21bf9697530b21e");
  assert.equal(quote[1], seize); assert.equal(decoded[2], seize);
  assert.equal(decoded[7], quote[0]);
  assert.equal(decoded[3], 0n); assert.equal(decoded[4], 25n * W);
  assert.equal(decoded[5], 0n);
  const repay = (seize * W + 1043841336116910229n - 1n) / 1043841336116910229n;
  assert.deepEqual(quoteValues(row.liveQuote), { repayDai: +(Number(repay) / 1e18).toFixed(2), seizedUsde: 50000,
    uniV3OutDai: 49800, grossSurplusDai: +(Number(out - repay) / 1e18).toFixed(2), grossSurplusUsd: +(Number(out - repay) / 1e18).toFixed(2) });
  assert.equal(row.liquidatableNow, true);
  assert.deepEqual(state.firedTriggers, ["TARGET_M1_MORPHO_USDE_DAI_LIQUIDATABLE"]);
});

test("M1 trigger requires liquidatable health and at least 25 DAI of successful quoted surplus", async () => {
  const repay = (108500n * W * W + 1043841336116910229n - 1n) / 1043841336116910229n;
  for (const [options, fires] of [
    [{ m1QuoteOut: repay + 25n * W }, true],
    [{ m1QuoteOut: repay + 2499n * W / 100n }, false],
    [{ m1QuoteOut: repay - W }, false],
    [{ m1QuoteFailed: true }, false],
    [{ m1Position: [0, 200_000n * W * 1_000_000n, 240_000n * W] }, false],
  ]) {
    const { state } = await captureFixture({ m1Position: [0, 200_000n * W * 1_000_000n, 232_000n * W], ...options });
    assert.deepEqual(state.firedTriggers, fires ? ["TARGET_M1_MORPHO_USDE_DAI_LIQUIDATABLE"] : []);
    assert.equal(state.anyTriggerFired, fires);
  }
});

test("M1 accrues borrow assets before share rounding, distinguishes stored HF and estimates passive crossing", async () => {
  const rate = 10n ** 12n, storedBorrow = 500_000n * W, shares = 500_000n * W * 1_000_000n;
  const userShares = 200_000n * W * 1_000_000n, maxBorrow = 206_400n * W;
  for (const [elapsed, liquidatable] of [[3600n, false], [40000n, true]]) {
    const lastUpdate = BigInt(ETH_HEADER.timestamp) - elapsed;
    const { state, calls } = await captureFixture({ m1Rate: rate, m1LastUpdate: lastUpdate });
    const row = state.targets.targetM1_Morpho_USDe_DAI;
    const accruedBorrow = storedBorrow + storedBorrow * wTaylorCompounded(rate, elapsed) / W;
    const denominator = shares + 1_000_000n;
    const debt = (userShares * (accruedBorrow + 1n) + denominator - 1n) / denominator;
    const growth = debt * rate / W;
    const hours = liquidatable ? 0 : +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2);
    assert.equal(row.storedHealthFactor, 1.032);
    assert.equal(row.healthFactor, Number(maxBorrow * 1_000_000n / debt) / 1e6);
    assert.ok(row.healthFactor < row.storedHealthFactor);
    assert.equal(row.debtUsd, +(Number(debt) / 1e18).toFixed(2));
    assert.equal(row.liquidatableNow, liquidatable);
    assert.equal(row.borrowAprPct, 3153.6);
    assert.equal(row.passiveHoursToCrossing, hours);
    if (!liquidatable) assert.ok(hours > 0);
    const quoteCall = calls.filter(call => call.rpc === "offline-ethereum" && call.method === "eth_call")[1];
    const requests = MC.decodeFunctionData("aggregate3", quoteCall.params[0].data)[0];
    assert.equal(BLUE_IRM.decodeFunctionData("borrowRateView", requests[19].callData)[1][4], lastUpdate);
  }
});

test("M1 zero rate remains observed; unavailable rate/future lastUpdate holds health and nomination", async () => {
  const lastUpdate = BigInt(ETH_HEADER.timestamp) - 40000n;
  for (const options of [{ m1Rate: 0n }, { m1Rate: 10n ** 12n, m1RateFailed: true }]) {
    const { state } = await captureFixture({ m1LastUpdate: lastUpdate, ...options });
    const row = state.targets.targetM1_Morpho_USDe_DAI;
    assert.equal(row.healthFactor, row.storedHealthFactor);
    assert.equal(row.debtUsd, options.m1RateFailed ? null : 200000);
    assert.equal(row.liquidatableNow, false);
    assert.equal(row.borrowAprPct, options.m1RateFailed ? null : 0);
    assert.equal(row.passiveHoursToCrossing, null);
    if (options.m1RateFailed) assert.equal(row.m1Nomination, undefined);
  }
  const { state } = await captureFixture({ m1LastUpdate: BigInt(ETH_HEADER.timestamp) + 1n, m1Rate: 10n ** 12n });
  const row = state.targets.targetM1_Morpho_USDe_DAI;
  assert.equal(row.healthFactor, row.storedHealthFactor);
  assert.equal(row.debtUsd, null);
  assert.equal(row.passiveHoursToCrossing, null);
  assert.equal(row.m1Nomination, undefined);
});

test("M1 health handles underwater and debt-free positions; failed quotes do not claim surplus", async () => {
  const { state: underwater } = await captureFixture({ m1Position: [0, 200_000n * W * 1_000_000n, 232_000n * W] });
  assert.equal(underwater.targets.targetM1_Morpho_USDe_DAI.healthFactor, 0.9976);
  assert.equal(underwater.targets.targetM1_Morpho_USDe_DAI.liquidatableNow, true);
  assert.equal(underwater.targets.targetM1_Morpho_USDe_DAI.passiveHoursToCrossing, 0);
  const { state: repaid } = await captureFixture({ m1Position: [0, 0, 240_000n * W], m1Rate: 10n ** 12n });
  assert.equal(repaid.targets.targetM1_Morpho_USDe_DAI.healthFactor, null);
  assert.equal(repaid.targets.targetM1_Morpho_USDe_DAI.storedHealthFactor, null);
  assert.equal(repaid.targets.targetM1_Morpho_USDe_DAI.passiveHoursToCrossing, null);
  assert.equal(repaid.targets.targetM1_Morpho_USDe_DAI.bpsToLiquidation, null);
  assert.equal(repaid.targets.targetM1_Morpho_USDe_DAI.liquidatableNow, false);
  const { state: failed } = await captureFixture({ m1QuoteFailed: true });
  const row = failed.targets.targetM1_Morpho_USDe_DAI;
  assert.equal(row.liveQuote, null); assert.ok(row.m1Nomination);
  assert.equal(MORPHO_EXEC.decodeFunctionData("execute", row.m1Nomination.calldataTemplate)[5], 0n);
  assert.deepEqual(failed.firedTriggers, []);
});

const M2_EXEC = new ethers.Interface(["function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address swapTarget,uint256 minLoanOut) plan, bytes swapData) external"]);
const M2_EXCHANGE = new ethers.Interface(["function exchange(int128 i,int128 j,uint256 dx,uint256 min_dy) returns (uint256)"]);
const M2_EXECUTOR = "0x2d5bca1b846e89965544c7f03d09a25126803627";

test("M2 reads its exact market and Curve exit and encodes the deployed Curve-unwind plan", async () => {
  const price = 11n * 10n ** 23n + 1n;
  const { state, calls } = await captureFixture({ m2Price: price });
  const row = state.targets.targetM2_Morpho_reUSD_USDC;
  const market = "0x4565ac05d38b19374ccbb04c17cca60ca9353cd41824f0803d0fc7704f60eaed";
  const user = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5";
  const oracle = "0xa66a4f03fd8031973f8c7718904ce32385f54e70";
  const reads = new ethers.Interface(["function market(bytes32)", "function position(bytes32,address)", "function price()", "function get_dy(int128,int128,uint256)"]);
  const ethCalls = calls.filter(call => call.rpc === "offline-ethereum" && call.method === "eth_call");
  const first = MC.decodeFunctionData("aggregate3", ethCalls[0].params[0].data)[0];
  const second = MC.decodeFunctionData("aggregate3", ethCalls[1].params[0].data)[0];
  assert.equal(first[62].target.toLowerCase(), "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb");
  assert.equal(first[63].target, first[62].target);
  assert.equal(reads.decodeFunctionData("market", first[62].callData)[0], market);
  const position = reads.decodeFunctionData("position", first[63].callData);
  assert.equal(position[0], market); assert.equal(position[1].toLowerCase(), user);
  assert.equal(first[64].target.toLowerCase(), oracle);
  assert.equal(first[64].callData, reads.encodeFunctionData("price"));
  assert.equal(second[20].target.toLowerCase(), "0xf74c91b36c26543a0aa820bef407a577e5498bf0");
  assert.deepEqual(Array.from(reads.decodeFunctionData("get_dy", second[20].callData)), [0n, 1n, 100000n * W]);
  assert.equal(second[21].target.toLowerCase(), "0x870ac11d48b15db9a138cf899d20f13f79ba00bc");
  const args = BLUE_IRM.decodeFunctionData("borrowRateView", second[21].callData);
  assert.deepEqual(Array.from(args[0]).slice(0, 4).map(v => v.toLowerCase()), ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0x5086bf358635b81d8c47c66d1c8b9e567db70c72", oracle, "0x870ac11d48b15db9a138cf899d20f13f79ba00bc"]);
  assert.equal(args[0][4], 915000000000000000n);
  assert.deepEqual(Array.from(args[1]), [1_000_000000000n, 0n, 500_000000000n, 500_000000000000000n, BigInt(ETH_HEADER.timestamp), 0n]);
  assert.equal(row.rank, "#M2"); assert.equal(row.user, user); assert.equal(row.marketId, market); assert.equal(row.pair, "reUSD / USDC");
  const quoted = (100000n * W * price + 10n ** 36n - 1n) / (10n ** 36n);
  assert.equal(quoted, 110_000000001n); // Oracle conversion is rounded up before the LIF division.
  const repay = (quoted * W + 1026167265264238070n - 1n) / 1026167265264238070n;
  const gain = +((Number(108_000000000n) - Number(repay)) / 1e6).toFixed(2);
  assert.deepEqual(quoteValues(row.liveQuote), { repayUsdc: +(Number(repay) / 1e6).toFixed(2), seizedReusd: 100000,
    curveOutUsdc: 108000, grossSurplusUsdc: gain, grossSurplusUsd: gain });
  assert.equal(row.collateralUsd, 264000); assert.equal(row.debtUsd, 200000);
  assert.equal(row.healthFactor, 1.2078); assert.equal(row.storedHealthFactor, row.healthFactor);
  assert.equal(row.liquidatableNow, false); assert.equal(row.borrowAprPct, 0); assert.equal(row.passiveHoursToCrossing, null);
  assert.equal(row.observationOnly, false); assert.equal(row.armed, false); assert.equal(row.executableNow, false);
  assert.equal(row.executor, M2_EXECUTOR); assert.equal(row.deployedExecutor, M2_EXECUTOR);
  assert.match(row.readinessNote, /Route configured .* on Curve-unwind executor/);
  const swapData = M2_EXCHANGE.encodeFunctionData("exchange", [0, 1, 100000n * W, 108_000000000n * 9950n / 10000n]);
  assert.equal(row.readyExecuteCurveUnwindCalldata, M2_EXEC.encodeFunctionData("execute", [[
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0x5086bf358635b81d8c47c66d1c8b9e567db70c72", oracle,
    "0x870ac11d48b15db9a138cf899d20f13f79ba00bc", 915000000000000000n, user,
    100000n * W, "0xf74c91b36c26543a0aa820bef407a577e5498bf0", 100000n * W * price / (10n ** 36n) + 25000000n,
  ], swapData]));
  assert.deepEqual(state.firedTriggers, []);
});

test("M2 accrues before share rounding and enables execution only after profitable crossing", async () => {
  const rate = 10n ** 12n, storedBorrow = 500_000000000n, shares = 500_000000000000000n, userShares = 200_000000000000000n;
  for (const [elapsed, liquidatable] of [[3600n, false], [120000n, true]]) {
    const { state } = await captureFixture({ m2Rate: rate, m2LastUpdate: BigInt(ETH_HEADER.timestamp) - elapsed });
    const row = state.targets.targetM2_Morpho_reUSD_USDC;
    const accrued = storedBorrow + storedBorrow * wTaylorCompounded(rate, elapsed) / W, denominator = shares + 1000000n;
    const debt = (userShares * (accrued + 1n) + denominator - 1n) / denominator;
    const maxBorrow = 219_600000000n, growth = debt * rate / W;
    assert.equal(row.storedHealthFactor, 1.098);
    assert.equal(row.healthFactor, Number(maxBorrow * 1000000n / debt) / 1e6);
    assert.equal(row.debtUsd, +(Number(debt) / 1e6).toFixed(2));
    assert.equal(row.liquidatableNow, liquidatable);
    assert.equal(row.passiveHoursToCrossing, liquidatable ? 0 : +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2));
    assert.equal(row.borrowAprPct, 3153.6); assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, liquidatable);
    assert.equal(row.armed, false);
    const candidates = require("../execute-top-whale-trigger.js").selectCandidates({ targets: { targetM2_Morpho_reUSD_USDC: row } });
    assert.equal(candidates.length, liquidatable ? 1 : 0);
    if (liquidatable) assert.equal(candidates[0].data, row.readyExecuteCurveUnwindCalldata);
    assert.deepEqual(state.firedTriggers, []);
  }
});

test("M2 zero price/debt, failed rate/quote and future lastUpdate keep bounded unknowns", async () => {
  for (const options of [{ m2Price: 0n }, { m2Position: [0, 0, 240000n * W] }]) {
    const { state } = await captureFixture({ ...options, m2Rate: 10n ** 12n });
    const row = state.targets.targetM2_Morpho_reUSD_USDC;
    assert.equal(row.healthFactor, null); assert.equal(row.storedHealthFactor, null);
    assert.equal(row.bpsToLiquidation, null); assert.equal(row.passiveHoursToCrossing, null); assert.equal(row.liquidatableNow, false);
  }
  const { state: failed } = await captureFixture({ m2RateFailed: true, m2QuoteFailed: true, m2Rate: 10n ** 12n, m2LastUpdate: 1n });
  const row = failed.targets.targetM2_Morpho_reUSD_USDC;
  assert.equal(row.healthFactor, row.storedHealthFactor); assert.equal(row.borrowAprPct, 0); assert.equal(row.passiveHoursToCrossing, null);
  assert.equal(row.liveQuote.curveOutUsdc, 0); assert.ok(row.liveQuote.grossSurplusUsdc < 0);
  assert.equal(row.readyExecuteCurveUnwindCalldata, null); assert.equal(row.executableNow, false);
  const { state: future } = await captureFixture({ m2Rate: 10n ** 12n, m2LastUpdate: BigInt(ETH_HEADER.timestamp) + 1n });
  assert.equal(future.targets.targetM2_Morpho_reUSD_USDC.healthFactor, 1.098);
  assert.ok(future.targets.targetM2_Morpho_reUSD_USDC.passiveHoursToCrossing > 0);
});

test("M2's 25 USDC gross threshold gates underwater execution and failed quotes omit calldata", async () => {
  const repay = (100_000000000n * W + 1026167265264238070n - 1n) / 1026167265264238070n;
  for (const profit of [24999999n, 25000000n, 25000001n]) {
    const { state } = await captureFixture({ m2Rate: 10n ** 12n, m2LastUpdate: BigInt(ETH_HEADER.timestamp) - 120000n, m2QuoteOut: repay + profit });
    const row = state.targets.targetM2_Morpho_reUSD_USDC;
    assert.ok(row.healthFactor < 1);
    assert.equal(row.armed, false); assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, profit >= 25000000n);
    assert.equal(row.liquidatableNow, profit >= 25000000n);
    assert.ok(row.readyExecuteCurveUnwindCalldata);
  }
  const { state } = await captureFixture({ m2Rate: 10n ** 12n, m2LastUpdate: 1n, m2QuoteFailed: true });
  const row = state.targets.targetM2_Morpho_reUSD_USDC;
  assert.equal(row.armed, false); assert.equal(row.executableNow, false); assert.equal(row.liquidatableNow, false);
  assert.equal(row.readyExecuteCurveUnwindCalldata, null);
});

test("Base optional IRM reads bind both markets to the Base pin and accrue all three whale debts", async () => {
  const rate = 10n ** 12n, storedBorrow = 1_000_000000n, shares = 1_000_000000000000n, userShares = 900_000000000000n;
  for (const elapsed of [3600n, 40000n]) {
    const market = [2_000_000000n, 0, storedBorrow, shares, BigInt(BASE_HEADER.timestamp) - elapsed, 0];
    const { state, calls } = await captureFixture({ market, position: [0, userShares, 1000n * W], baseRates: [rate, rate * 2n] });
    const baseCalls = calls.filter(c => c.rpc === "offline-base" && c.method === "eth_call");
    assert.equal(baseCalls.length, 2);
    for (const call of baseCalls) assert.deepEqual(call.params[1], { blockHash: BASE_HEADER.hash, requireCanonical: true });
    const requests = MC.decodeFunctionData("aggregate3", baseCalls[1].params[0].data)[0];
    for (const [i, request] of requests.entries()) {
      assert.equal(request.target.toLowerCase(), "0x46415998764c29ab2a25cbea6254146d50d22687");
      const args = BLUE_IRM.decodeFunctionData("borrowRateView", request.callData);
      assert.deepEqual(Array.from(args[0]).slice(0, 4).map(v => v.toLowerCase()), ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        i === 0 ? "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34" : "0xfcc9cc1209651ed8867332d6f664cf82743a2584",
        i === 0 ? "0xf4b17c79492d68775e22e8dd0a2bb22854a39a47" : "0x182e072f2c9c58c6f19f144c97986f7496c6a109", request.target.toLowerCase()]);
      assert.equal(args[0][4], 915000000000000000n);
      assert.deepEqual(Array.from(args[1]), market.map(BigInt));
    }
    for (const [i, row] of state.targets.base_Morpho_Whales.entries()) {
      const r = i < 2 ? rate : rate * 2n;
      const accrued = storedBorrow + storedBorrow * wTaylorCompounded(r, elapsed) / W;
      const denominator = shares + 1000000n, debt = (userShares * (accrued + 1n) + denominator - 1n) / denominator;
      const maxBorrow = 915_000000n, growth = debt * r / W, liquidatable = maxBorrow < debt;
      assert.equal(row.debtUsdcRaw, debt.toString()); assert.equal(row.debtUsdc, Number(debt) / 1e6);
      assert.equal(row.storedHealthFactor, 915 / 900); assert.equal(row.healthFactor, Number(maxBorrow) / Number(debt));
      assert.equal(row.healthIsEstimate, false); assert.equal(row.liquidatableNow, liquidatable);
      assert.equal(row.borrowAprPct, i < 2 ? 3153.6 : 6307.2);
      assert.equal(row.passiveHoursToCrossing, liquidatable ? 0 : +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2));
      assert.equal(row.readinessNote, "Observation only; no Base liquidator deployed or live batch approved.");
      assert.equal(row.observationOnly, true); assert.equal(row.executableNow, false); assert.equal(row.executor, null);
    }
    assert.deepEqual(state.firedTriggers, []);
  }
});

test("Base unavailable, malformed or partial IRM results retain stored health per market", async () => {
  for (const options of [{}, { baseRateMalformed: true }, { baseRateWrongShape: true }, { baseRates: [null, null] }]) {
    const { state } = await captureFixture(options);
    assert.equal(state.baseObservation.status, "COMPLETE");
    for (const row of state.targets.base_Morpho_Whales) {
      assert.equal(row.healthIsEstimate, true); assert.equal(row.healthFactor, row.storedHealthFactor);
      assert.equal(row.borrowAprPct, null); assert.equal(row.passiveHoursToCrossing, null); assert.equal(row.liquidatableNow, null);
    }
    assert.doesNotMatch(JSON.stringify(state), /OPTIONAL_RATE_TRANSPORT_ERROR/);
  }
  for (const baseRates of [[0n, "malformed"], [null, 0n]]) {
    const { state } = await captureFixture({ baseRates });
    for (const [i, row] of state.targets.base_Morpho_Whales.entries()) {
      const available = baseRates[i < 2 ? 0 : 1] === 0n;
      assert.equal(row.healthIsEstimate, !available); assert.equal(row.borrowAprPct, available ? 0 : null);
      assert.equal(row.liquidatableNow, available ? false : null); assert.equal(row.passiveHoursToCrossing, null);
    }
  }
});

test("Base accrued observations handle future timestamps, zero rates, zero price and repaid debt", async () => {
  const market = [2_000_000000n, 0, 1_000_000000n, 1_000_000000000000n, BigInt(BASE_HEADER.timestamp) + 1n, 0];
  for (const options of [{ market, baseRates: [10n ** 12n, 10n ** 12n] }, { baseRates: [0n, 0n] },
    { price: 0n, baseRates: [10n ** 12n, 10n ** 12n] }, { position: [0, 0, 1000n * W], baseRates: [10n ** 12n, 10n ** 12n] }]) {
    const { state } = await captureFixture(options);
    for (const row of state.targets.base_Morpho_Whales) {
      assert.equal(row.healthIsEstimate, false);
      assert.equal(row.healthFactor, row.storedHealthFactor);
      assert.equal(row.liquidatableNow, options.price === 0n || options.position ? null : false);
      if (!options.market) assert.equal(row.passiveHoursToCrossing, null);
    }
  }
});

test("Base failure is optional but explicitly incomplete, sanitized and not healthy", async () => {
  for (const option of [{ failRead: true }, { failedSubcall: true }]) {
    const { state } = await captureFixture(option);
    assert.equal(state.baseObservation.status, "INCOMPLETE");
    assert.equal(state.baseObservation.reason, "BASE_READ_FAILED");
    assert.equal(state.baseObservation.pin.hash, BASE_HEADER.hash);
    assert.deepEqual(state.targets.base_Morpho_Whales, []);
    assert.equal(JSON.stringify(state).includes("PRIVATE_TRANSPORT_ERROR"), false);
    assert.ok(state.targets.target1_AaveV4_USDe_USDC);
  }
});

test("Base missing RPC, wrong chain and invalid header are unavailable before contract reads", async () => {
  for (const [options, reason] of [
    [{ missingRpc: true }, "BASE_RPC_UNAVAILABLE"],
    [{ chainId: "0x1" }, "BASE_CHAIN_UNVERIFIED"],
    [{ header: { ...BASE_HEADER, hash: "0x12" } }, "BASE_HEADER_UNAVAILABLE"],
    [{ header: { ...BASE_HEADER, number: "0x20000000000000" } }, "BASE_HEADER_UNAVAILABLE"],
  ]) {
    const { state, calls } = await captureFixture(options);
    assert.deepEqual(state.baseObservation, { status: "UNAVAILABLE", reason, pin: null });
    assert.deepEqual(state.targets.base_Morpho_Whales, []);
    assert.equal(calls.some(call => call.rpc === "offline-base" && call.method === "eth_call"), false);
  }
});

test("Base zero debt, total shares, collateral and price avoid division errors or false eligibility", async () => {
  for (const options of [
    { market: [0, 0, 0, 0, 0, 0], position: [0, 0, 0] },
    { position: [0, 0, 1000n * W] },
    { price: 0n },
    { position: [0, 1, 0] },
  ]) {
    const { state } = await captureFixture(options);
    assert.equal(state.targets.base_Morpho_Whales.length, 3);
    for (const row of state.targets.base_Morpho_Whales) {
      assert.equal(row.liquidatableNow, null);
      assert.equal(row.bpsToLiquidation, null);
      assert.ok(row.healthFactor === null || row.healthFactor === 0);
      assert.equal(row.executableNow, false);
      if (options.price === 0n) {
        assert.equal(row.collateralValueUsdc, null);
        assert.equal(state.baseObservation.status, "INCOMPLETE");
        assert.equal(state.baseObservation.reason, "BASE_ZERO_ORACLE_PRICE");
      } else {
        assert.equal(state.baseObservation.status, "COMPLETE");
      }
    }
  }
});

test("Base debt uses virtual assets/shares with ceil at the health boundary", async () => {
  const { state } = await captureFixture({ market: [0, 0, 999999, 1000000, 1, 0], position: [0, 999999, 546448n * 10n ** 12n] });
  for (const row of state.targets.base_Morpho_Whales) {
    assert.equal(row.debtUsdcRaw, "500000"); // ceil(999999 * (999999 + 1) / (1000000 + 1000000))
    assert.equal(row.debtUsdc, 0.5);
    assert.equal(row.healthFactor, 499999 / 500000);
    assert.equal(row.bpsToLiquidation, -0.02);
    assert.equal(row.liquidatableNow, null); // Stored totals still lack accrual.
  }
});

test("PAXG liquidity remains observation-only above the former execution threshold", async () => {
  const { state } = await captureFixture();
  const row = state.targets.target3_Morpho_PAXG_USDC;
  assert.equal(row.availableUsdc, 100);
  assert.equal(row.observationOnly, true);
  assert.equal(row.executableNow, false);
  assert.equal(row.liquidatableNow, false);
  assert.equal(row.executor, null);
  assert.equal(row.conservativeNetUsd, null);
  assert.equal(Object.keys(row).some(key => /calldata|supply|borrow|threshold/i.test(key)), false);
  assert.deepEqual(state.firedTriggers, []);
  assert.equal(state.anyTriggerFired, false);
});

test("createStickyResolver caches per-chain RPCs and supports per-chain or full invalidation", async () => {
  const counts = { 1: 0, 8453: 0 };
  const sticky = createStickyResolver(async (chainId) => {
    counts[chainId] = (counts[chainId] || 0) + 1;
    return `rpc-${chainId}-${counts[chainId]}`;
  });
  assert.equal(await sticky(1), "rpc-1-1");
  assert.equal(await sticky(1), "rpc-1-1");
  assert.equal(await sticky(8453), "rpc-8453-1");
  assert.equal(await sticky(8453), "rpc-8453-1");
  assert.deepEqual(counts, { 1: 1, 8453: 1 });
  sticky.invalidate(8453);
  assert.equal(await sticky(1), "rpc-1-1");
  assert.equal(await sticky(8453), "rpc-8453-2");
  assert.deepEqual(counts, { 1: 1, 8453: 2 });
  sticky.invalidate();
  assert.equal(await sticky(1), "rpc-1-2");
  assert.equal(await sticky(8453), "rpc-8453-3");
  assert.deepEqual(counts, { 1: 2, 8453: 3 });
});

const EXT = {
  weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  wsteth: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
  oracle: "0xbd60a6770b27e084e8617335dde769241b0e71d8",
  irm: "0x870ac11d48b15db9a138cf899d20f13f79ba00bc",
  router: "0xe592427a0aece92de3edee1f18e0157c05861564",
  quoter: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e",
  morpho: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
  executor: "0xaf5b033e23ac555c09096bf39979a855e09907ba",
  user2J: "0x037a4486b28f0e3b34a4a6e7c4a915280e731a45",
  userA3: "0x1d9c4116e5784036dbd15bced8aff88970b4a598",
  userM7: "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550",
  ynethx: "0x657d9aba1dbb59e53f9f3ecaa878447dcfc96dcb",
  mseth: "0x64351fc9810adad17a690e4e1717df5e7e085160",
  oracleM7: "0xc28f86c86f79282e2d2a1f45442339c55f7eb22d",
  buffer: "0x9a8bc3b04b7f3d87cfc09ba407dced575f2d61d8",
  executorM7: "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4",
  curveM7: "0xa4c567c662349bec3d0fb94c4e7f85ba95e208e4",
};
const EXT_MARKETS = [
  "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e",
  "0xd0e50cdac92fe2172043f5e0c36532c6369d24947e40968f34a5e8819ca9ec5d",
  "0xd2630c0ebf33ba83c82e8cd400a8e6345370238ca695ce58773b2d3e43de1b0a",
];
const EXT_WHALES = [
  ["#M3", "0xb224f589297a5a207e6069de5dafd4b120129817", 0, 965000000000000000n, 1010611420612813370n],
  ["#M4", "0x4b441cd7c5085d0c255eff3db7ec3417cca1a1a0", 0, 965000000000000000n, 1010611420612813370n],
  ["#M5", "0xfb74196eccf35a260dd5cfd300baa37ae058b6c0", 0, 965000000000000000n, 1010611420612813370n],
  ["#M6", "0x4b441cd7c5085d0c255eff3db7ec3417cca1a1a0", 1, 945000000000000000n, 1016776817488561260n],
];
const EXT_PATH = ethers.solidityPacked(["address", "uint24", "address"], [EXT.wsteth, 100, EXT.weth]);
const EXT_2J = "target2J_AaveV3_wstETH_WETH_0x037a";
const EXT_A3 = "targetA3_AaveV4_USDe_USDC_0x1d9c";
const EXT_M7 = "targetM7_Morpho_ynETHx_msETH_Canary";
const EXT_M7B = "targetM7B_Morpho_ynETHx_msETH_0x9b13";
const M7B_USER = "0x9b1303ebf09bc51b7fac376c9e421e8daae63b82";
const M7_EXEC = new ethers.Interface([
  "function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address intermediateToken,address curvePool,int128 curveI,int128 curveJ,uint256 minLoanOut) plan) external",
]);
const EXT_READS = new ethers.Interface([
  "function getUserAccountData(address)",
  "function balanceOf(address)",
  "function getAssetsPrices(address[])",
  "function market(bytes32)",
  "function position(bytes32,address)",
  "function price()",
  "function quoteExactInput(bytes,uint256)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96))",
]);
const PT_MARKET = "0x760b14c9003f08ac4bf0cfb02596ee4d6f0548a4fde5826bfd56befb9ed62ae9";
const PT_ORACLE = "0xfcae69bef9b6c96d89d58664d8aea84bddce2e5c";
const PT_TOKEN = "0x917459337caac939d41d7493b3999f571d20d667";
const PT_USERS = ["0x9b75df7f7cd5b74b8f0f0de8f4751c3f8e9695bb", "0x64d85278a093ee5c57739c6c0de6c4eef53a1e02"];
const PT_KEYS = ["targetM8_Morpho_PT_USDe_DAI", "targetM9_Morpho_PT_USDe_DAI"];
const YN_KEY = "targetYnEthx_Curve_NavArb";
const YN_EXECUTOR = "0x91a07a51ca9c2abd333d80ca876f0dfde4d8cd35";
const YN_EXEC = new ethers.Interface([
  "function execute((address loanToken,address vaultToken,address curvePool,int128 curveI,int128 curveJ,uint256 flashAmount,uint256 minSharesOut,uint256 minLoanOut) plan) external",
]);
const EULER_KEYS = ["targetE1_EulerV2_RLUSD_USDC_0xbf21", "targetE2_EulerV2_USDC_syrupUSDC_0x9f09"];
const YN_CURVE = "0xd65ed4bce447195187f37ce7d82f56adf1826f8f";
const EULER_USERS = ["0xbf21702d7213bc7a95fc0ecb1e4a4e43c2380772", "0x9f09502a0b68edbccdff5e6c59270ad150def361"];
const EULER_VAULTS = ["0xe1ce9af672f8854845e5474400b6ddc7ae458a10", "0x9bd52f2805c6af014132874124686e7b248c2cbb"];
const EULER_EXECUTOR = "0xac262ce4319b887aeac069730c7978c98a8c5fe6";
const EULER_EXEC = new ethers.Interface([
  "function execute((address loanToken,address liabilityVault,address collateralVault,address underlyingCollateral,address violator,uint256 repayAssets,uint256 minYieldShares,uint8 unwindKind,address swapTarget,int128 curveI,int128 curveJ,uint256 minLoanOut) plan) external",
]);
const EULER_EXT_KEYS = ["targetE3_EulerV2_WETH_ynETHx_0x831e", "targetE4_EulerV2_WETH_ynETHx_0x8062", "targetE5_EulerV2_USDC_USDT_0xd1ed", "targetE6_EulerV2_USDT_USDC_0x079d"];
const EULER_EXT_PLANS = [
  [EXT.weth, "0x45c3b59d53e2e148aaa6a857521059676d5c0489", "0x6d18f74aad8494b789ae34b5455816f79664d209", EXT.ynethx,
    "0x831ec4f2aba6deab29fb1aefdf9b049721d3c366", 515000000000000000n, 505000000000000000n, 0n, "0x0000000000000000000000000000000000000000", 0n, 0n, 550000000000000000n],
  [EXT.weth, "0x45c3b59d53e2e148aaa6a857521059676d5c0489", "0x6d18f74aad8494b789ae34b5455816f79664d209", EXT.ynethx,
    "0x8062511602a163fe84d1d2300117ea8cc1600cbd", 202000000000000000n, 195000000000000000n, 0n, "0x0000000000000000000000000000000000000000", 0n, 0n, 212000000000000000n],
  ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xe0a80d35bb6618cba260120b279d357978c42bce", "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8", "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0xd1edf7fc3d913c94e6c649985ce36bbc2e871d0f", 1400000000n, 1300000000n, 1n, "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85", 1n, 0n, 1410000000n],
  ["0xdac17f958d2ee523a2206206994597c13d831ec7", "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8", "0xe0a80d35bb6618cba260120b279d357978c42bce", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0x079dfb0a62b4723b45166abb7892fe362543ad8d", 5450000000n, 5100000000n, 1n, "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85", 0n, 1n, 5465000000n],
];
const EULER_EXT_VALUES = [[1000n * W, 1100n * W], [400n * W, 440n * W], [1350n * W, 136825n * W / 100n], [5300n * W, 538944n * W / 100n]];
const YN_EULER_READS = new ethers.Interface([
  "function get_dy(int128,int128,uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function accountLiquidity(address,bool) view returns (uint256,uint256)",
]);

async function captureExtendedFixture(options = {}) {
  const calls = [], elapsed = options.elapsed ?? 40000n;
  const lastUpdate = BigInt(ETH_HEADER.timestamp) - elapsed;
  const markets = [5000n, 8000n, 2000n].map(borrow => [
    borrow * 2n * W, 0n, borrow * W, borrow * W * 1000000n, lastUpdate, 0n,
  ]);
  const positions = options.positions ?? [[1000n, 850n], [1100n, 940n], [1200n, 1020n], [1000n, 870n]]
    .map(([debt, collateral]) => [0n, debt * W * 1000000n, collateral * W]);
  const m7Position = [0n, (options.m7Debt ?? 900n * W) * 1000000n, 1000n * W];
  const m7bPosition = options.m7bPosition ?? [0n, 9n * W * 1000000n + 1n, 10n * W + 1n];
  const rates = options.rates || [10n ** 12n, 2n * 10n ** 12n, 10n ** 12n];
  const price = 125n * 10n ** 34n + 1n;
  const quote = amount => encode(["uint256", "uint160[]", "uint32[]", "uint256"], [amount, [], [], 100000n]);
  const result = (rows, failed = []) => MC.encodeFunctionResult("aggregate3", [
    rows.map((returnData, i) => failed.includes(i)
      ? { success: false, returnData: "0x" } : { success: true, returnData }),
  ]);
  const ptMarket = [1000000n * W, 0n, 500000n * W, 500000n * W * 1000000n,
    BigInt(ETH_HEADER.timestamp) - (options.ptElapsed ?? 0n), 0n];
  const ptPositions = [
    [0n, 364584678n * 10n ** 20n, 40000n * W],
    [0n, 136687275n * 10n ** 20n, 15000n * W],
  ];
  const ptRate = options.ptRate ?? 10n ** 12n;
  let ethCalls = 0;
  const transport = async (rpc, method, params) => {
      calls.push({ rpc, method, params });
      assert.equal(rpc, "offline-ethereum");
      if (method === "eth_getBlockByNumber") {
        assert.deepEqual(params, ["latest", false]);
        return ETH_HEADER;
      }
      assert.equal(method, "eth_call"); assert.equal(params[1], ETH_HEADER.hash);
      if (params[0].to.toLowerCase() === EXT.buffer) {
        assert.deepEqual([{ ...params[0], to: params[0].to.toLowerCase() }, params[1]],
          [{ to: EXT.buffer, data: YN_EULER_READS.encodeFunctionData("maxWithdraw", [EXT.ynethx]) }, ETH_HEADER.hash]);
        return uints([options.bufferWeth ?? 1234567n * 10n ** 12n]);
      }
      if (params[0].to.toLowerCase() === SYRUP_SPOKE) return syrupAccountResponse(params[0].data, options);
      if (params[0].to.toLowerCase() === A4_SPOKE) {
        assert.equal(A4_READ.decodeFunctionData("getUserAccountData", params[0].data)[0].toLowerCase(), A4_USER);
        return uints([0n, 9300n, 1004360000000000000n, 1234567n * 10n ** 24n, 987654n * 10n ** 51n, 2n, 2n]);
      }
      if (params[0].to.toLowerCase() === EXT.morpho) {
        const [market, borrower] = EXT_READS.decodeFunctionData("position", params[0].data);
        assert.equal(market, EXT_MARKETS[2]); assert.equal(borrower.toLowerCase(), M7B_USER);
        if (options.m7bFailure === "transport") throw new Error("M7B_OFFLINE_TRANSPORT_FAILURE");
        return options.m7bFailure === "malformed" ? "0x" : uints(m7bPosition);
      }
      if (params[0].to.toLowerCase() === EXT.irm) {
        assert.ok(options.pt);
        return options.ptRateMalformed ? "0x" : uints([ptRate]);
      }
      if (params[0].to.toLowerCase() === YN_CURVE) {
        assert.deepEqual(Array.from(YN_EULER_READS.decodeFunctionData("get_dy", params[0].data)), [1n, 0n, 10n * W]);
        if (options.ynFailure === "transport") throw new Error("YN_OFFLINE_TRANSPORT_FAILURE");
        return options.ynFailure === "curve" ? "0x" : uints([options.ynBought ?? 11n * W]);
      }
      if (params[0].to.toLowerCase() === EXT.ynethx) {
        assert.equal(YN_EULER_READS.decodeFunctionData("previewRedeem", params[0].data)[0], options.ynBought ?? 11n * W);
        return options.ynFailure === "redeem" ? "0x" : uints([options.wethRedeem ?? 12n * W]);
      }
      const requests = MC.decodeFunctionData("aggregate3", params[0].data)[0];
      if (requests.length === 4 && requests[0].callData.startsWith(YN_EULER_READS.getFunction("accountLiquidity").selector)) {
        assert.equal(params[0].to.toLowerCase(), "0xca11bde05977b3631167028862be2a173976ca11");
        for (const [i, request] of requests.entries()) {
          assert.equal(request.target.toLowerCase(), EULER_EXT_PLANS[i][1]);
          assert.equal(request.allowFailure, true);
          assert.equal(request.callData, YN_EULER_READS.encodeFunctionData("accountLiquidity", [EULER_EXT_PLANS[i][4], true]));
        }
        if (options.eulerExtendedFailure === "transport") throw new Error("EULER_EXT_OFFLINE_TRANSPORT_FAILURE");
        if (options.eulerExtendedFailure === "malformed") return "0x";
        return result((options.eulerExtendedValues ?? EULER_EXT_VALUES).map((value, i) =>
          options.eulerExtendedMalformed === i ? "0x" : uints(value)), options.eulerExtendedFailed);
      }
      if (requests.length === 2) {
        assert.equal(params[0].to.toLowerCase(), "0xca11bde05977b3631167028862be2a173976ca11");
        for (const [i, request] of requests.entries()) {
          assert.equal(request.target.toLowerCase(), EULER_VAULTS[i]);
          assert.equal(request.allowFailure, true);
          assert.equal(request.callData, YN_EULER_READS.encodeFunctionData("accountLiquidity", [EULER_USERS[i], true]));
        }
        if (options.eulerFailure === "transport") throw new Error("EULER_OFFLINE_TRANSPORT_FAILURE");
        if (options.eulerFailure === "malformed") return "0x";
        const values = options.eulerValues ?? [[114500n * W, 113499n * W], [402700n * W, 398154n * W]];
        return result(values.map((value, i) => options.eulerMalformed === i ? "0x" : uints(value)), options.eulerFailed);
      }
      if (requests.length === 4) {
        assert.equal(EXT_READS.decodeFunctionData("market", requests[0].callData)[0], PT_MARKET);
        if (!options.pt || options.ptMalformed) return "0x";
        const positions = options.ptPositions || ptPositions;
        return result([uints(ptMarket), uints([options.ptPrice ?? 10n ** 36n]), ...positions.map(uints)], options.ptFailed);
      }
      switch (++ethCalls) {
        case 1:
          assert.equal(requests.length, 65);
          return ethereumFixture();
        case 2:
          assert.equal(requests.length, 22);
          return aggregate([
            uints([1000_000000n, 0, 0, 0]),
            ...Array.from({ length: 10 }, () => uints([1000n * W])),
            ...EXTRA_V3_WEETH_USERS.map((_, i) => uints([(1000n + BigInt(i) * 10n) * W])),
            quote(108000n * W), uints([0n]), uints([108_000000000n]), uints([0n]),
          ]);
        case 3:
          assert.equal(requests.length, 16);
          return result([
            uints([3_000_000n * 10n ** 8n, 2_000_000n * 10n ** 8n, 0, 0, 0, options.hf2J ?? 99n * W / 100n]),
            uints([1000n * W + 1n]),
            encode(["uint256[]"], [[2000n * 10n ** 8n, 2500n * 10n ** 8n]]),
            uints([0, 9300, 99n * W / 100n, 2_000_000n * 10n ** 26n, 123_456_789n * 10n ** 51n, 1, 1]),
            uints(markets[0]), uints(markets[1]), uints([price]),
            ...positions.map(uints),
            quote(options.wstQuoteOut ?? 625n * W),
            uints(markets[2]), uints(m7Position), uints([options.m7Price ?? 10n ** 36n]),
            uints([options.bufferWeth ?? 1234567n * 10n ** 12n]),
          ], options.failed3);
        case 4:
          assert.equal(requests.length, 5);
          return result([
            quote(options.quote2J ?? 504n * W),
            uints([206242_300000n, 0, 0, 100000]),
            ...rates.map(rate => uints([rate])),
          ], options.failed4);
        default:
          assert.fail("unplanned offline call");
      }
  };
  const collect = options.defaultTransport ? defaultTransportCollector(transport) : checkOnce;
  const state = await collect({
    includeExtendedDiscoveries: true, includeA4: options.includeA4, includeM7B: options.includeM7B, includeEulerYn: options.includeEulerYn,
    includeEulerExtended: options.includeEulerExtended,
    nextBlockContext: options.nextBlockContext,
    writeOut: false,
    resolveRpc: async chainId => {
      assert.ok(chainId === 1 || chainId === 8453);
      return chainId === 1 ? "offline-ethereum" : null;
    },
    ...(options.defaultTransport ? {} : { rpcCall: transport }),
  });
  assert.equal(ethCalls, 4);
  const batches = calls.filter(c => c.method === "eth_call" && c.params[0].data.startsWith(MC.getFunction("aggregate3").selector))
    .map(c => MC.decodeFunctionData("aggregate3", c.params[0].data)[0]).filter(batch => batch.length !== 4 && batch.length !== 2);
  assert.deepEqual(batches.map(b => b.length), [65, 22, 16, 5]);
  return { state, calls, batches, markets, positions, m7Position, m7bPosition, rates, price, ptMarket, ptPositions, ptRate };
}

test("YN/Euler discovery leaves injected default transports unchanged and requires the M7 observation", async () => {
  for (const fixture of [await captureExtendedFixture(), await captureFixture({ includeEulerYn: true }),
    await captureExtendedFixture({ includeEulerYn: true, failed3: [13] })]) {
    for (const key of [YN_KEY, ...EULER_KEYS]) assert.equal(fixture.state.targets[key], undefined);
    assert.equal(fixture.calls.some(c => c.method === "eth_call" && c.params[0].to.toLowerCase() === YN_CURVE), false);
    assert.equal(fixture.calls.some(c => c.rpc === "offline-ethereum" && c.method === "eth_call" && c.params[0].data.startsWith(MC.getFunction("aggregate3").selector)
      && MC.decodeFunctionData("aggregate3", c.params[0].data)[0].length === 2), false);
  }
});

test("YN/Euler opt-in adds exactly three pinned reads with requested quotes and arms YN on 0x91a0...cd35", async () => {
  const baseline = await captureExtendedFixture();
  const { state, calls } = await captureExtendedFixture({ includeEulerYn: true });
  assert.equal(calls.length, baseline.calls.length + 3);
  const expectedFlash = W;
  const expectedMinShares = (11n * W * expectedFlash * 9900n) / (10n * W * 10000n);
  const expectedScaledRedeem = (12n * W * expectedFlash * 9900n) / (10n * W * 10000n);
  assert.deepEqual(state.targets[YN_KEY], {
    rank: "#YN", user: YN_CURVE, marketId: YN_CURVE, pair: "WETH -> ynETHx -> Redeem (Curve/NAV)",
    ...monitorFields(state.pin, "ONCHAIN_MEASURED", true),
    observationOnly: false, armed: false, executor: YN_EXECUTOR, executableNow: false, liquidatableNow: true, hfUnderwaterNow: true,
    protocolLiquidatable: false, routeExecutable: true,
    bufferMaxWithdrawWeth: (1234567n * 10n ** 12n).toString(), bufferReadStatus: "OK",
    healthFactor: .833333, bpsToLiquidation: -2000, collateralUsd: 24000, debtUsd: 20000, ynEthxBufferWeth: 1.234567,
    readinessNote: "Route configured (read-only; runner unverified) on 0x91a0...cd35: buffer observed; fresh Curve->ynETHx->redeem preflight required.",
    liveQuote: { ...quoteFields("ONCHAIN_MEASURED", state.pin), collateralSeizedFormatted: "11.00 ynETHx bought", debtOutcomeFormatted: "+2.0000 WETH (10 WETH flash)", estimatedProfitUsd: 4000 },
    readyExecuteCurveRedeemCalldata: YN_EXEC.encodeFunctionData("execute", [[
      EXT.weth, EXT.ynethx, YN_CURVE, 1, 0, expectedFlash, expectedMinShares, expectedScaledRedeem,
    ]]),
  });
  const [ynCand] = selectCandidates({ targets: { [YN_KEY]: state.targets[YN_KEY] } });
  assert.equal(ynCand.id, YN_KEY);
  assert.equal(ynCand.kind, "CURVE_BUY_VAULT_REDEEM_YN");
  assert.equal(ynCand.executor, YN_EXECUTOR);
  const collateral = [114500, 402700], liability = [113499, 398154];
  const quotes = [
    { collateralSeizedFormatted: "109,505 eUSDC-22", debtOutcomeFormatted: "113,499 RLUSD", estimatedProfitUsd: 1135 },
    { collateralSeizedFormatted: "370,166 esyrupUSDC-4", debtOutcomeFormatted: "398,154 USDC", estimatedProfitUsd: 3980 },
  ];
  for (const [i, key] of EULER_KEYS.entries()) {
    const row = state.targets[key], hf = collateral[i] / liability[i];
    assert.equal(row.rank, `#E${i + 1}`); assert.equal(row.user, EULER_USERS[i]); assert.equal(row.marketId, EULER_VAULTS[i]);
    assert.equal(row.pair, ["eUSDC-22 / eRLUSD-1 (Euler V2)", "esyrupUSDC-4 / eUSDC-70 (Euler V2)"][i]);
    assert.equal(row.collateralUsd, collateral[i]); assert.equal(row.debtUsd, liability[i]);
    assert.equal(row.healthFactor, hf); assert.equal(row.bpsToLiquidation, +((1 - 1 / hf) * 10000).toFixed(4));
    assert.equal(row.liquidatableNow, false); assert.equal(row.executableNow, false);
    assert.deepEqual(quoteValues(row.liveQuote), quotes[i]);
    if (i === 0) {
      assert.equal(row.observationOnly, false); assert.equal(row.armed, false);
      assert.equal(row.executor, "0xac262ce4319b887aeac069730c7978c98a8c5fe6");
    } else {
      assert.equal(row.observationOnly, true); assert.equal(row.armed, false);
      assert.equal(Object.keys(row).some(key => /calldata|executor/i.test(key)), false);
      assert.deepEqual(selectCandidates({ targets: { [key]: row } }), []);
    }
  }
  const others = Object.fromEntries(Object.entries(state.targets).filter(([key]) => ![YN_KEY, ...EULER_KEYS].includes(key)));
  assert.deepEqual(others, baseline.state.targets);
  assert.deepEqual(state.firedTriggers, baseline.state.firedTriggers);
});

test("YN buffer threshold is exact and quote ROI truncates using integer arithmetic", async () => {
  for (const bufferWeth of [0n, 1216099999999999999n, 1216100000000000000n]) {
    const { state } = await captureExtendedFixture({ includeEulerYn: true, bufferWeth, wethRedeem: 12161099999999999999n });
    const yn = state.targets[YN_KEY];
    assert.equal(yn.executableNow, false); assert.equal(yn.eligibleForPreflight, bufferWeth >= 1216100000000000000n);
    assert.equal(yn.liquidatableNow, yn.eligibleForPreflight); assert.equal(yn.hfUnderwaterNow, true);
    assert.equal(yn.bpsToLiquidation, -2161); assert.equal(yn.healthFactor, +(10000 / 12161).toFixed(6));
    assert.equal(yn.liveQuote.estimatedProfitUsd, 4322.2); assert.equal(yn.armed, false);
  }
});

test("Euler strict liquidation boundary arms E1 and keeps E2 observation-only", async () => {
  for (const [col, liab] of [[99n * W, 100n * W], [W, W], [W, 0n], [0n, W]]) {
    const { state } = await captureExtendedFixture({ includeEulerYn: true, eulerValues: [[col, liab], [col, liab]] });
    for (const [i, key] of EULER_KEYS.entries()) {
      const row = state.targets[key], hf = liab > 0n ? Number(col) / Number(liab) : null;
      const liq = liab > 0n && col < liab;
      assert.equal(row.healthFactor, hf); assert.equal(row.liquidatableNow, liq);
      assert.equal(row.bpsToLiquidation, hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null);
      if (i === 0) {
        assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, liq); assert.equal(row.armed, false); assert.equal(row.observationOnly, false);
      } else {
        assert.equal(row.executableNow, false); assert.equal(row.armed, false); assert.equal(row.observationOnly, true);
      }
    }
  }
});

test("YN and Euler transport, malformed and failed subcalls are isolated from other observations", async () => {
  const baseline = await captureExtendedFixture();
  for (const options of [{ ynFailure: "transport" }, { ynFailure: "curve" }, { ynFailure: "redeem" },
    { eulerFailure: "transport" }, { eulerFailure: "malformed" }, { eulerFailed: [0] }, { eulerFailed: [1] },
    { eulerMalformed: 0 }, { eulerMalformed: 1 }]) {
    const { state } = await captureExtendedFixture({ includeEulerYn: true, ...options });
    assert.equal(Boolean(state.targets[YN_KEY]), !options.ynFailure);
    for (const [i, key] of EULER_KEYS.entries()) {
      assert.equal(Boolean(state.targets[key]), !options.eulerFailure && !options.eulerFailed?.includes(i) && options.eulerMalformed !== i);
    }
    for (const [key, row] of Object.entries(baseline.state.targets)) assert.deepEqual(state.targets[key], row);
    assert.deepEqual(state.firedTriggers, baseline.state.firedTriggers);
    assert.equal(JSON.stringify(state).includes("OFFLINE_TRANSPORT_FAILURE"), false);
  }
});

test("YN/Euler default transport discovers targets without opt-in or endpoint access", async () => {
  const { state } = await captureExtendedFixture({ defaultTransport: true });
  assert.equal(state.targets[YN_KEY].observationOnly, false);
  assert.equal(state.targets[YN_KEY].armed, false);
  assert.equal(state.targets[YN_KEY].executor, YN_EXECUTOR);
  assert.equal(state.targets[EULER_KEYS[0]].observationOnly, false);
  assert.equal(state.targets[EULER_KEYS[0]].armed, false);
  assert.equal(state.targets[EULER_KEYS[0]].executor, "0xac262ce4319b887aeac069730c7978c98a8c5fe6");
  assert.equal(state.targets[EULER_KEYS[1]].observationOnly, true);
  assert.equal(state.targets[EULER_KEYS[1]].armed, false);
  for (const key of EULER_EXT_KEYS) assert.equal(state.targets[key].executor, EULER_EXECUTOR);
});

test("extended Euler discovery is separately opt-in, M7-dependent, and preserves the legacy two-call batch", async () => {
  for (const options of [{}, { includeEulerYn: true }, { includeEulerExtended: true, failed3: [13] }]) {
    const { state } = await captureExtendedFixture(options);
    for (const key of EULER_EXT_KEYS) assert.equal(state.targets[key], undefined);
  }
  const baseline = await captureExtendedFixture({ includeEulerYn: true, pt: true });
  const { state, calls } = await captureExtendedFixture({ includeEulerYn: true, includeEulerExtended: true, pt: true });
  assert.equal(calls.length, baseline.calls.length + 1);
  for (const [key, row] of Object.entries(baseline.state.targets)) assert.deepEqual(state.targets[key], row);
  const standalone = await captureExtendedFixture({ includeEulerExtended: true });
  assert.equal(standalone.state.targets[EULER_KEYS[0]], undefined);
  assert.ok(standalone.state.targets[EULER_EXT_KEYS[0]]);
});

test("extended Euler targets use exact plans, liquidity units, triggers and native-token profit floors", async () => {
  const { state } = await captureExtendedFixture({ includeEulerExtended: true });
  const quotes = [
    { collateralSeizedFormatted: "0.5100 eynETHx-2", debtOutcomeFormatted: "0.5102 WETH (+0.0486 WETH net)", estimatedProfitUsd: 119 },
    { collateralSeizedFormatted: "0.1972 eynETHx-2", debtOutcomeFormatted: "0.1996 WETH (+0.0164 WETH net)", estimatedProfitUsd: 40.25 },
    { collateralSeizedFormatted: "1,330.56 eUSDT-9", debtOutcomeFormatted: "1,368.25 USDC", estimatedProfitUsd: 13.68 },
    { collateralSeizedFormatted: "5,217.78 eUSDC-22", debtOutcomeFormatted: "5,389.44 USDT", estimatedProfitUsd: 53.89 },
  ];
  for (const [i, key] of EULER_EXT_KEYS.entries()) {
    const row = state.targets[key], plan = EULER_EXT_PLANS[i], [col, liab] = EULER_EXT_VALUES[i], unit = 1e18;
    assert.equal(row.rank, `#E${i + 3}`); assert.equal(row.user, plan[4]); assert.equal(row.marketId, plan[1]);
    assert.equal(row.collateralVault, plan[2]); assert.equal(row.underlyingCollateral, plan[3]);
    assert.equal(row.pair, i < 2 ? "eynETHx-2 / eWETH-22 (Euler V2)" : i === 2 ? "eUSDT-9 / eUSDC-22 (Euler V2)" : "eUSDC-22 / eUSDT-9 (Euler V2)");
    assert.equal(row.healthFactor, Number(col) / Number(liab));
    assert.equal(row.collateralUsd, +(Number(col) / unit).toFixed(2)); assert.equal(row.debtUsd, +(Number(liab) / unit).toFixed(2));
    assert.equal(row.armed, false); assert.equal(row.observationOnly, false); assert.equal(row.executor, EULER_EXECUTOR);
    assert.equal(row.hfUnderwaterNow, true); assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, true); assert.equal(row.liquidatableNow, true);
    assert.deepEqual(quoteValues(row.liveQuote), quotes[i]);
    assert.equal(row.readyExecuteEulerEvkCalldata, EULER_EXEC.encodeFunctionData("execute", [plan]));
    assert.ok(state.firedTriggers.includes(`TARGET_E${i + 3}_EULER_V2_${plan[4].slice(0, 6)}_LIQUIDATABLE`));
    const [candidate] = selectCandidates({ targets: { [key]: row } });
    assert.equal(candidate.id, key); assert.equal(candidate.kind, "EULER_EVK_E1"); assert.equal(candidate.executor, EULER_EXECUTOR);
    assert.equal(candidate.profitToken, plan[0]); assert.equal(candidate.minProfitRaw, plan[11] - plan[5]);
    assert.equal(candidate.flashAmount, i < 2 ? plan[5] : plan[5] * 10n ** 12n / 2400n);
  }
});

test("Euler E3/E4 buffer boundaries are raw-wei exact while stablecoin legs do not depend on the buffer", async () => {
  for (const bufferWeth of [0n, 219999999999999999n, 220000000000000000n, 559999999999999999n, 560000000000000000n]) {
    const { state } = await captureExtendedFixture({ includeEulerExtended: true, bufferWeth });
    for (const [i, key] of EULER_EXT_KEYS.entries()) {
      const row = state.targets[key], ready = i >= 2 || bufferWeth >= [560000000000000000n, 220000000000000000n][i];
      assert.equal(row.hfUnderwaterNow, true); assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, ready); assert.equal(row.liquidatableNow, ready);
      assert.equal(Boolean(row.readyExecuteEulerEvkCalldata), ready);
      assert.equal(selectCandidates({ targets: { [key]: row } }).length, ready ? 1 : 0);
      assert.equal(state.firedTriggers.includes(`TARGET_E${i + 3}_EULER_V2_${row.user.slice(0, 6)}_LIQUIDATABLE`), ready);
      if (i < 2) assert.equal(row.ynEthxBufferWeth, +(Number(bufferWeth) / 1e18).toFixed(6));
    }
  }
});

test("extended Euler strict health boundaries and failed reads cannot emit executable plans", async () => {
  for (const [col, liab] of [[W, W], [W + 1n, W], [W, 0n], [0n, 0n], [0n, W], [W - 1n, W]]) {
    const { state } = await captureExtendedFixture({ includeEulerExtended: true, eulerExtendedValues: Array(4).fill([col, liab]) });
    for (const key of EULER_EXT_KEYS) {
      const row = state.targets[key], ready = liab > 0n && col < liab;
      assert.equal(row.healthFactor, liab > 0n ? Number(col) / Number(liab) : null);
      assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, ready); assert.equal(Boolean(row.readyExecuteEulerEvkCalldata), ready);
    }
  }
  const baseline = await captureExtendedFixture({ includeEulerYn: true });
  for (const options of [{ eulerExtendedFailure: "transport" }, { eulerExtendedFailure: "malformed" },
    ...[0, 1, 2, 3].flatMap(i => [{ eulerExtendedFailed: [i] }, { eulerExtendedMalformed: i }])]) {
    const { state } = await captureExtendedFixture({ includeEulerYn: true, includeEulerExtended: true, ...options });
    for (const [key, row] of Object.entries(baseline.state.targets)) assert.deepEqual(state.targets[key], row);
    for (const [i, key] of EULER_EXT_KEYS.entries()) {
      const present = !options.eulerExtendedFailure && !options.eulerExtendedFailed?.includes(i) && options.eulerExtendedMalformed !== i;
      assert.equal(Boolean(state.targets[key]), present);
      assert.equal(state.firedTriggers.includes(`TARGET_E${i + 3}_EULER_V2_${EULER_EXT_PLANS[i][4].slice(0, 6)}_LIQUIDATABLE`), present);
    }
    assert.equal(JSON.stringify(state).includes("OFFLINE_TRANSPORT_FAILURE"), false);
  }
});

test("extended Euler selection rejects mismatched targets, routes, repayment sizes and weak profit floors", async () => {
  const { state } = await captureExtendedFixture({ includeEulerExtended: true });
  for (const [i, key] of EULER_EXT_KEYS.entries()) {
    const row = state.targets[key];
    for (const field of ["eligibleForPreflight", "liquidatableNow"]) assert.deepEqual(selectCandidates({ targets: { [key]: { ...row, [field]: false } } }), []);
    assert.throws(() => selectCandidates({ targets: { [key]: { ...row, user: EULER_USERS[0] } } }), /COLLECTOR_TARGET_MISMATCH/);
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const plan = [...EULER_EXT_PLANS[i]];
      plan[index] = typeof plan[index] === "string" ? EULER_EXECUTOR : index === 6 ? 0n : index === 11 ? plan[11] - 1n : plan[index] + 1n;
      assert.throws(() => selectCandidates({ targets: { [key]: { ...row, readyExecuteEulerEvkCalldata: EULER_EXEC.encodeFunctionData("execute", [plan]) } } }),
        /EXECUTION_TARGET_MISMATCH|EXECUTION_ROUTE_NOT_ALLOWED|PLAN_PROFIT_OR_SLIPPAGE_INVALID/);
    }
  }
});

test("M7B injected discovery requires both explicit opt-in and a computed M7 parent", async () => {
  for (const fixture of [await captureExtendedFixture(), await captureFixture({ includeM7B: true }),
    await captureExtendedFixture({ includeM7B: true, failed3: [13] })]) {
    assert.equal(fixture.state.targets[EXT_M7B], undefined);
    assert.equal(fixture.calls.some(c => c.method === "eth_call" && c.params[0].to.toLowerCase() === EXT.morpho), false);
  }
});

test("M7B reuses M7 pinned evidence with exactly one companion position read and unchanged batches", async () => {
  const options = { pt: true, m7Price: 105n * 10n ** 34n };
  const baseline = await captureExtendedFixture(options);
  const { state, calls, markets, m7bPosition: pos, rates } = await captureExtendedFixture({ ...options, includeM7B: true });
  const reads = calls.filter(c => c.method === "eth_call" && c.params[0].to.toLowerCase() === EXT.morpho);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].rpc, "offline-ethereum");
  assert.equal(reads[0].params[1], ETH_HEADER.hash);
  assert.equal(reads[0].params[0].data, EXT_READS.encodeFunctionData("position", [EXT_MARKETS[2], M7B_USER]));
  assert.equal(calls.length, baseline.calls.length + 1);
  const batches = calls.filter(c => c.method === "eth_call" && c.params[0].data.startsWith(MC.getFunction("aggregate3").selector));
  assert.deepEqual(batches.map(c => MC.decodeFunctionData("aggregate3", c.params[0].data)[0].length), [65, 22, 16, 5, 4]);
  const market = markets[2], rate = rates[2], ceil = (a, b) => (a + b - 1n) / b;
  const accrued = market[2] + market[2] * wTaylorCompounded(rate, BigInt(ETH_HEADER.timestamp) - market[4]) / W;
  const debt = ceil(pos[1] * (accrued + 1n), market[3] + 1000000n);
  const stored = ceil(pos[1] * (market[2] + 1n), market[3] + 1000000n);
  const coll = pos[2] * options.m7Price / (10n ** 36n), maxBorrow = coll * 915n / 1000n;
  const hf = Number(maxBorrow * 1000000n / debt) / 1e6;
  assert.deepEqual(state.targets[EXT_M7B], {
    rank: "#M7B", user: M7B_USER, marketId: EXT_MARKETS[2], pair: "ynETHx / msETH",
    ...monitorFields(state.pin, "HISTORICAL_REFERENCE", false),
    observationOnly: false, armed: false, executor: EXT.executorM7, executableNow: false,
    protocolLiquidatable: false, routeExecutable: false,
    bufferMaxWithdrawWeth: (1234567n * 10n ** 12n).toString(), bufferReadStatus: "OK",
    readinessNote: "Route configured (read-only; runner unverified) on 0xc063...2eb4: buffer observed; fresh execution preflight required.",
    healthFactor: hf, storedHealthFactor: Number(maxBorrow * 1000000n / stored) / 1e6,
    borrowAprPct: +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2),
    passiveHoursToCrossing: maxBorrow < debt ? 0 : null, liquidatableNow: false, hfUnderwaterNow: maxBorrow < debt,
    bpsToLiquidation: +((1 - 1 / hf) * 10000).toFixed(4),
    collateralUsd: +(Number(coll) / 1e18 * 2000).toFixed(2), debtUsd: +(Number(debt) / 1e18 * 2000).toFixed(2),
    ynEthxBufferWeth: 1.234567,
    liveQuote: { ...quoteFields("HISTORICAL_REFERENCE"), collateralSeizedFormatted: "5.69 ynETHx (buffer refill)", debtOutcomeFormatted: "+0.8612 msETH (pre-gas)", estimatedProfitUsd: 2080.15 },
  });
  assert.ok(state.targets[EXT_M7B].healthFactor < state.targets[EXT_M7B].storedHealthFactor);
  const { [EXT_M7B]: _, ...others } = state.targets;
  assert.deepEqual(others, baseline.state.targets);
  assert.deepEqual(state.firedTriggers, baseline.state.firedTriggers);
});

test("M7B stays non-authorizing while health, zero debt/collateral and buffer readiness gate candidate calldata", async () => {
  for (const options of [{ bufferWeth: 0n }, { bufferWeth: 60n * W }, { rates: [0n, 0n, 0n] },
    { m7bPosition: [0n, 0n, 10n * W] }, { m7bPosition: [0n, 9n * W * 1000000n, 0n] }]) {
    const { state, m7bPosition: pos } = await captureExtendedFixture({ includeM7B: true, ...options });
    const row = state.targets[EXT_M7B];
    const underwater = pos[1] > 0n && !options.rates;
    const executable = underwater && pos[2] > 0n && options.bufferWeth !== 0n;
    assert.equal(row.liquidatableNow, executable); assert.equal(row.hfUnderwaterNow, underwater);
    assert.equal(row.passiveHoursToCrossing, underwater ? 0 : null);
    assert.equal(row.observationOnly, false); assert.equal(row.armed, false); assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, executable);
    assert.equal(Object.hasOwn(row, "readyExecuteVaultRedeemCalldata"), executable);
    assert.equal(state.firedTriggers.some(trigger => /M7B/.test(trigger)), false);
    if (pos[1] === 0n) {
      assert.equal(row.healthFactor, null); assert.equal(row.storedHealthFactor, null); assert.equal(row.debtUsd, 0);
    }
    if (pos[2] === 0n) assert.equal(row.healthFactor, 0);
    if (pos[1] === 0n || pos[2] === 0n) assert.equal(row.bpsToLiquidation, null);
    if (options.rates) assert.equal(row.healthFactor, row.storedHealthFactor);
    if (options.bufferWeth === 60n * W) assert.equal(state.targets[EXT_M7].eligibleForPreflight, true);
  }
});

test("M7B missing or malformed position is isolated from the existing M7 and other discoveries", async () => {
  const baseline = await captureExtendedFixture();
  for (const m7bFailure of ["transport", "malformed"]) {
    const { state } = await captureExtendedFixture({ includeM7B: true, m7bFailure });
    assert.deepEqual(state.targets, baseline.state.targets);
    assert.deepEqual(state.firedTriggers, baseline.state.firedTriggers);
    assert.equal(JSON.stringify(state).includes("M7B_OFFLINE_TRANSPORT_FAILURE"), false);
  }
});

test("M7B default transport reads the companion after A4 without opt-in or endpoint access", async () => {
  const { state, calls } = await captureExtendedFixture({ defaultTransport: true, includeM7B: false });
  assert.ok(state.targets[EXT_M7]); assert.ok(state.targets[A4_KEY]); assert.ok(state.targets[EXT_M7B]);
  const a4Index = calls.findIndex(c => c.method === "eth_call" && c.params[0].to.toLowerCase() === A4_SPOKE);
  const companion = calls.filter(c => c.method === "eth_call" && c.params[0].to.toLowerCase() === EXT.morpho);
  assert.equal(companion.length, 1); assert.ok(calls.indexOf(companion[0]) > a4Index);
  assert.equal(state.targets[EXT_M7B].armed, false); assert.equal(state.targets[EXT_M7B].executableNow, false); assert.equal(state.targets[EXT_M7B].eligibleForPreflight, true);
});

test("M7B dynamic plan respects share, collateral, buffer and 50-token bounds with exact minLoanOut", async () => {
  const ceil = (a, b) => (a + b - 1n) / b;
  const minimumBuffer = ceil(W * 10000n, 9000n);
  const cases = [
    { bound: "shares", bufferWeth: 60n * W },
    { bound: "shares", bufferWeth: 60n * W, m7Price: 110n * 10n ** 34n, m7bPosition: [0n, 10n * W * 1000000n, 10n * W] },
    { bound: "collateral", bufferWeth: 60n * W, m7bPosition: [0n, 20n * W * 1000000n, 569n * W / 100n] },
    { bound: "buffer", bufferWeth: 2n * W },
    { bound: "cap", bufferWeth: 100n * W, m7bPosition: [0n, 100n * W * 1000000n, 100n * W] },
    { bound: "buffer", bufferWeth: minimumBuffer },
    { bound: "buffer", bufferWeth: minimumBuffer - 1n },
    { bound: "collateral", bufferWeth: 60n * W, m7bPosition: [0n, W * 1000000n, W / 2n] },
    { bound: "shares", bufferWeth: 0n, m7Price: 0n },
  ];
  for (const options of cases) {
    const { state, markets, m7bPosition: pos, rates } = await captureExtendedFixture({ includeM7B: true, ...options });
    const row = state.targets[EXT_M7B], market = markets[2], price = options.m7Price ?? 10n ** 36n;
    const accrued = market[2] + market[2] * wTaylorCompounded(rates[2], BigInt(ETH_HEADER.timestamp) - market[4]) / W;
    const dMax = pos[1] * (accrued + 1n) / (market[3] + 1000000n);
    const qMax = dMax * 1026167265264238070n / W;
    const shareCap = price > 0n ? qMax * (10n ** 36n) / price : 0n;
    const bounds = { shares: shareCap, collateral: pos[2], buffer: options.bufferWeth * 9n / 10n, cap: 50n * W };
    const seize = Object.values(bounds).reduce((a, b) => a < b ? a : b);
    assert.equal(seize, bounds[options.bound]);
    assert.equal(row.hfUnderwaterNow, true);
    assert.equal(row.liquidatableNow, seize >= W); assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, seize >= W);
    assert.equal(row.armed, false); assert.equal(row.observationOnly, false);
    assert.equal(Object.hasOwn(row, "readyExecuteVaultRedeemCalldata"), seize >= W);
    if (seize < W) {
      assert.match(row.readinessNote, /dynamic 1-5\.69 ynETHx.*fires on MCwETH buffer refill/);
      assert.deepEqual(selectCandidates({ targets: { [EXT_M7B]: row } }), []);
      continue;
    }
    const principal = seize * price / (10n ** 36n), floor = seize * 50000000000000000n / W;
    const plan = M7_EXEC.decodeFunctionData("execute", row.readyExecuteVaultRedeemCalldata)[0];
    assert.equal(plan.borrower.toLowerCase(), M7B_USER); assert.equal(plan.seizedAssets, seize);
    assert.equal(plan.minLoanOut, principal + (floor > W / 20n ? floor : W / 20n));
    assert.equal(row.readyExecuteVaultRedeemCalldata, M7_EXEC.encodeFunctionData("execute", [[
      EXT.mseth, EXT.ynethx, EXT.oracleM7, EXT.irm, 915000000000000000n, M7B_USER, seize,
      EXT.weth, EXT.curveM7, 1n, 0n, plan.minLoanOut,
    ]]));
    const repay = ceil(ceil(seize * price, 10n ** 36n) * W, 1026167265264238070n);
    const repaidShares = ceil(repay * (market[3] + 1000000n), accrued + 1n);
    assert.ok(repaidShares <= pos[1]);
    if (options.bound === "shares") {
      const oldSeize = bounds.buffer < 50n * W ? bounds.buffer : 50n * W;
      const oldRepay = ceil(ceil(oldSeize * price, 10n ** 36n) * W, 1026167265264238070n);
      assert.ok(ceil(oldRepay * (market[3] + 1000000n), accrued + 1n) > pos[1]);
    }
    const [candidate] = selectCandidates({ targets: { [EXT_M7B]: row } });
    assert.equal(candidate.kind, "MORPHO_BLUE_M7"); assert.equal(candidate.id, EXT_M7B);
    assert.equal(candidate.borrower, M7B_USER); assert.equal(candidate.seizedAssets, seize);
    assert.equal(candidate.data, row.readyExecuteVaultRedeemCalldata);
  }
});

test("extended M8/M9 read the exact PT market and frozen oracle without changing the existing 16-row batch", async () => {
  const { state, calls, batches } = await captureExtendedFixture({ pt: true });
  assert.equal(batches[2].length, 16);
  const ptCall = calls.find(c => c.method === "eth_call" && c.params[0].data.startsWith(MC.getFunction("aggregate3").selector)
    && MC.decodeFunctionData("aggregate3", c.params[0].data)[0].length === 4);
  const requests = MC.decodeFunctionData("aggregate3", ptCall.params[0].data)[0];
  assert.equal(ptCall.params[1], ETH_HEADER.hash);
  assert.equal(requests[0].target.toLowerCase(), EXT.morpho);
  assert.equal(EXT_READS.decodeFunctionData("market", requests[0].callData)[0], PT_MARKET);
  assert.equal(requests[1].target.toLowerCase(), PT_ORACLE);
  assert.equal(requests[1].callData, EXT_READS.encodeFunctionData("price"));
  const rateCall = calls.find(c => c.method === "eth_call" && c.params[0].to.toLowerCase() === EXT.irm);
  const args = BLUE_IRM.decodeFunctionData("borrowRateView", rateCall.params[0].data);
  assert.equal(rateCall.params[1], ETH_HEADER.hash);
  assert.deepEqual(Array.from(args[0]).slice(0, 4).map(v => v.toLowerCase()), ["0x6b175474e89094c44da98b954eedeac495271d0f", PT_TOKEN, PT_ORACLE, EXT.irm]);
  assert.equal(args[0][4], 915000000000000000n);
  for (const [i, key] of PT_KEYS.entries()) {
    const row = state.targets[key], posArgs = EXT_READS.decodeFunctionData("position", requests[i + 2].callData);
    assert.equal(posArgs[0], PT_MARKET); assert.equal(posArgs[1].toLowerCase(), PT_USERS[i]);
    assert.equal(row.rank, `#M${i + 8}`); assert.equal(row.user, PT_USERS[i]); assert.equal(row.marketId, PT_MARKET);
    assert.equal(row.pair, "PT-USDe-31JUL2025 / DAI"); assert.equal(row.chainId, 1);
    assert.equal(row.oraclePriceRaw, (10n ** 36n).toString());
    assert.equal(row.bpsToLiquidation, [38.67, 41][i]);
    assert.equal(row.observationHash, ETH_HEADER.hash); assert.equal(row.observationBlock, Number(BigInt(ETH_HEADER.number)));
    assert.equal(row.observationStatus, "COMPLETE"); assert.equal(row.healthIsEstimate, false);
    assert.equal(row.observationOnly, true); assert.equal(row.armed, false); assert.equal(row.executableNow, false);
    assert.equal(row.executor, null); assert.equal(row.conservativeNetUsd, null); assert.equal(row.liquidatableNow, false);
    assert.equal(row.readinessNote, "Staged & fork-proven via MorphoPendlePtRedeemUnwindRoundTrip (+882.71 / +338.44 DAI at block 26231521); frozen 1.00 oracle, passive accrual watch.");
    assert.equal(Object.keys(row).some(name => /calldata|liveQuote|deployedExecutor/i.test(name)), false);
  }
});

test("PT accrual distinguishes stored health and never arms or fires even after crossing", async () => {
  for (const elapsed of [3600n, 40000n]) {
    const { state, ptMarket: market, ptPositions: positions, ptRate: rate } = await captureExtendedFixture({ pt: true, ptElapsed: elapsed });
    const accrued = market[2] + market[2] * wTaylorCompounded(rate, elapsed) / W;
    for (const [i, key] of PT_KEYS.entries()) {
      const row = state.targets[key], denom = market[3] + 1000000n;
      const debt = (positions[i][1] * (accrued + 1n) + denom - 1n) / denom;
      const maxBorrow = positions[i][2] * 915n / 1000n, liquidatable = maxBorrow < debt;
      assert.equal(row.debtDaiRaw, debt.toString()); assert.equal(row.healthFactor, Number(maxBorrow) / Number(debt));
      assert.ok(row.healthFactor < row.storedHealthFactor);
      assert.equal(row.liquidatableNow, liquidatable);
      assert.equal(row.passiveHoursToCrossing, liquidatable ? 0 : +(Number(maxBorrow - debt) / Number(debt * rate / W) / 3600).toFixed(2));
      assert.equal(row.executableNow, false); assert.equal(row.observationOnly, true); assert.equal(row.armed, false);
    }
    assert.equal(state.firedTriggers.some(name => /TARGET_M[89]_/.test(name)), false);
  }
});

test("optional PT failures preserve older discoveries, omit failed borrowers and mark missing accrual as estimated", async () => {
  for (const options of [{ pt: false }, { ptMalformed: true }, { ptFailed: [0] }, { ptFailed: [1] }, { ptPrice: 0n }]) {
    const { state } = await captureExtendedFixture({ pt: true, ...options });
    for (const key of PT_KEYS) assert.equal(state.targets[key], undefined);
    assert.ok(state.targets[EXT_M7]); assert.equal(state.targets.morpho_wstETH_WETH_Whales.length, 4);
  }
  const partial = await captureExtendedFixture({ pt: true, ptFailed: [2] });
  assert.equal(partial.state.targets[PT_KEYS[0]], undefined); assert.ok(partial.state.targets[PT_KEYS[1]]);
  const estimated = await captureExtendedFixture({ pt: true, ptRateMalformed: true, ptElapsed: 40000n });
  for (const key of PT_KEYS) {
    const row = estimated.state.targets[key];
    assert.equal(row.healthIsEstimate, true); assert.equal(row.healthFactor, row.storedHealthFactor);
    assert.equal(row.liquidatableNow, null); assert.equal(row.passiveHoursToCrossing, null); assert.equal(row.borrowAprPct, null);
  }
});

test("extended discoveries bind 2J wstETH sizing/calldata and scale observation-only A3 debt by 1e53", async () => {
  const { state, batches } = await captureExtendedFixture();
  const first = batches[2], second = batches[3], row = state.targets[EXT_2J], a3 = state.targets[EXT_A3];
  assert.ok(row); assert.ok(a3);
  const repay = 500n * W, seized = computeV3WeEthSizing(repay, 2000n * 10n ** 8n, 2500n * 10n ** 8n);
  assert.equal(second[0].target.toLowerCase(), EXT.quoter);
  assert.deepEqual(Array.from(EXT_READS.decodeFunctionData("quoteExactInput", second[0].callData)), [EXT_PATH, seized]);
  assert.equal(row.rank, "#2J"); assert.equal(row.user, EXT.user2J); assert.equal(row.pair, "wstETH / WETH");
  assert.equal(row.healthFactor, 0.99); assert.equal(row.liquidatableNow, true);
  assert.equal(row.collateralUsd, 3000000); assert.equal(row.debtUsd, 2000000);
  assert.equal(row.readyExecuteMorphoCalldata, UNIFIED_IFACE.encodeFunctionData("executeMorpho", [repay, {
    isAaveV3: true, target: row.pool, borrower: EXT.user2J, debtToken: EXT.weth, collateralToken: EXT.wsteth,
    collateralReserveId: 0n, debtReserveId: 0n, minCollateralSeized: seized * 9950n / 10000n,
    swapKind: 1, swapTarget: EXT.router, swapSpender: EXT.router, uniFee: 100, curveI: 0, curveJ: 0,
    minDebtTokenOut: 504n * W * 9950n / 10000n, minProfitDebtToken: W / 100n,
  }]));
  assert.ok(state.firedTriggers.includes("TARGET_2J_AAVE_V3_0x037A_LIQUIDATABLE"));
  assert.equal(a3.rank, "#A3"); assert.equal(a3.user, EXT.userA3); assert.equal(a3.pair, "USDe / USDC");
  assert.equal(a3.collateralUsd, 2000000); assert.equal(a3.debtUsd, 1234567.89);
  assert.equal(a3.observationOnly, true); assert.equal(a3.executableNow, false);
});

test("extended M3-M6 bind both markets, accrue with wTaylorCompounded and encode the exact wstETH route", async () => {
  const ceil = (x, y) => (x + y - 1n) / y;
  for (const [elapsed, liquidatable] of [[3600n, false], [40000n, true]]) {
    const { state, markets, positions, rates, price } = await captureExtendedFixture({ elapsed, hf2J: W });
    const rows = state.targets.morpho_wstETH_WETH_Whales;
    assert.deepEqual(rows.map(row => row.rank), ["#M3", "#M4", "#M5", "#M6"]);
    for (const [i, [rank, user, marketIndex, lltv, lif]] of EXT_WHALES.entries()) {
      const row = rows[i], market = markets[marketIndex], rate = rates[marketIndex], position = positions[i];
      const accrued = market[2] + market[2] * wTaylorCompounded(rate, elapsed) / W;
      const storedDebt = ceil(position[1] * (market[2] + 1n), market[3] + 1000000n);
      const debt = ceil(position[1] * (accrued + 1n), market[3] + 1000000n);
      const collateralValue = position[2] * price / (10n ** 36n), maxBorrow = collateralValue * lltv / W;
      assert.equal(row.rank, rank); assert.equal(row.user, user); assert.equal(row.marketId, EXT_MARKETS[marketIndex]);
      assert.equal(row.pair, "wstETH / WETH"); assert.equal(row.deployedExecutor, EXT.executor);
      assert.equal(row.storedHealthFactor, Number(maxBorrow * 1000000n / storedDebt) / 1e6);
      assert.equal(row.healthFactor, Number(maxBorrow * 1000000n / debt) / 1e6);
      assert.ok(row.healthFactor < row.storedHealthFactor);
      assert.equal(row.liquidatableNow, liquidatable);
      const quoted = ceil(500n * W * price, 10n ** 36n), repay = ceil(quoted * W, lif);
      assert.equal(row.readyExecuteMorphoBlueCalldata, MORPHO_EXEC.encodeFunctionData("execute", [
        [EXT.weth, EXT.wsteth, EXT.oracle, EXT.irm, lltv], user, 500n * W, 0n, W / 20n,
        625n * W * 9950n / 10000n, EXT.router, EXT_PATH,
      ]));
      assert.equal(row.liveQuote.repayWeth, +(Number(repay) / 1e18).toFixed(4));
    }
    assert.deepEqual(state.firedTriggers, liquidatable
      ? EXT_WHALES.map(([rank]) => `TARGET_${rank.slice(1)}_MORPHO_WSTETH_WETH_LIQUIDATABLE`) : []);
  }
});

test("extended M7 stays non-authorizing while buffer-gated and encodes the dynamic 1-50 ynETHx plan on refill", async () => {
  for (const options of [
    { bufferWeth: 0n }, { bufferWeth: W }, { bufferWeth: 1111111111111111111n },
    { bufferWeth: 1111111111111111112n }, { bufferWeth: 1234567n * 10n ** 12n },
    { bufferWeth: 1267n * W / 100n }, { bufferWeth: 60n * W }, { failed3: [15] },
  ]) {
    const { state } = await captureExtendedFixture({ hf2J: W, rates: [0n, 0n, 10n ** 12n], ...options });
    const row = state.targets[EXT_M7];
    const buffer = options.failed3 ? 0n : options.bufferWeth;
    const rawSeize = buffer * 9000n / 10000n, seize = rawSeize > 50n * W ? 50n * W : rawSeize;
    const ready = seize >= W;
    assert.ok(row);
    assert.equal(row.rank, "#M7"); assert.equal(row.user, EXT.userM7); assert.equal(row.marketId, EXT_MARKETS[2]);
    assert.equal(row.pair, "ynETHx / msETH"); assert.equal(row.storedHealthFactor, 1.016666);
    assert.equal(row.hfUnderwaterNow, true);
    assert.equal(row.liquidatableNow, ready);
    assert.equal(row.ynEthxBufferWeth, +(Number(buffer) / 1e18).toFixed(6));
    assert.equal(row.observationOnly, false); assert.equal(row.armed, false);
    assert.equal(row.executableNow, false); assert.equal(row.eligibleForPreflight, ready); assert.equal(row.executor, EXT.executorM7);
    assert.equal(Object.hasOwn(row, "readyExecuteVaultRedeemCalldata"), ready);
    assert.deepEqual(quoteValues(row.liveQuote), {
      collateralSeizedFormatted: "11.34 ynETHx (idle refill) / 50.00 ynETHx (full)",
      debtOutcomeFormatted: "+1.8939 msETH (idle) / +7.5315 msETH (full)", estimatedProfitUsd: 4431.62,
    });
    if (ready) {
      const floor = seize * 50000000000000000n / W;
      const expected = [EXT.mseth, EXT.ynethx, EXT.oracleM7, EXT.irm, 915000000000000000n,
        EXT.userM7, seize, EXT.weth, EXT.curveM7, 1n, 0n, seize + floor];
      assert.equal(row.readyExecuteVaultRedeemCalldata, M7_EXEC.encodeFunctionData("execute", [expected]));
      assert.match(row.readinessNote, /buffer observed; fresh execution preflight required/);
    } else {
      assert.match(row.readinessNote, /fires on MCwETH buffer refill/);
    }
  }
});

test("M7 uses oracle-scaled principal and never encodes executable calldata for a healthy account", async () => {
  const m7Price = 105n * 10n ** 34n, bufferWeth = 60n * W;
  const { state } = await captureExtendedFixture({ m7Price, m7Debt: 1200n * W, bufferWeth });
  const row = state.targets[EXT_M7], plan = M7_EXEC.decodeFunctionData("execute", row.readyExecuteVaultRedeemCalldata)[0];
  assert.equal(plan.seizedAssets, 50n * W);
  assert.equal(plan.minLoanOut, 50n * W * m7Price / (10n ** 36n) + 50n * W / 20n);
  const healthy = (await captureExtendedFixture({ bufferWeth, rates: [0n, 0n, 0n] })).state.targets[EXT_M7];
  assert.equal(healthy.armed, false);
  assert.equal(healthy.hfUnderwaterNow, false);
  assert.equal(healthy.liquidatableNow, false);
  assert.equal(healthy.executableNow, false);
  assert.equal(Object.hasOwn(healthy, "readyExecuteVaultRedeemCalldata"), false);
});
