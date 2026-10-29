"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { compileFunction } = require("node:vm");
const { ethers } = require("../node_modules/ethers");
const deployment = require("../lib/m32-deployment.js");

const KEY = "targetM32_Morpho_sUSDe_USDtb";
const TRIGGER = "TARGET_M32_MORPHO_SUSDE_USDTB_LIQUIDATABLE";
const M2_EXECUTOR = "0x2d5bca1b846e89965544c7f03d09a25126803627";
const USER = "0xc17a3f83798c8dfe5b6bc4f05825fccf08889c65";
const MARKET = "0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742";
const NOTE = "Route configured (read-only; runner unverified) on 0x2c94...47c4 (dedicated MorphoM32CurveUnwindLiquidator; +279.34 USDtb gross / +$213.50 modeled net rehearsed).";
const REFERENCE_QUOTE = { repayUsdc: 11039.80, seizedReusd: 9025.94, curveOutUsdc: 11319.14,
  grossSurplusUsdc: 279.34, grossSurplusUsd: 213.50 };
const REFERENCE_METADATA = { provenance: "HISTORICAL_REFERENCE", observationBlock: null, observationHash: null, observationUtc: null };
const W = 10n ** 18n, R = 10n ** 27n, V = 1000000n;
const HEADER = { number: "0x1900000", hash: `0x${"11".repeat(32)}`, timestamp: "0x6ad00000" };
const MC = new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[]) returns ((bool success,bytes returnData)[])"]);
const M2_ABI = new ethers.Interface(["function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address swapTarget,uint256 minLoanOut) plan, bytes swapData)"]);
const UNIVERSAL_ABI = new ethers.Interface([
  "function execute((uint8 mode,address loanToken,uint256 flashAmount,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address fluidVault,uint256 token0DebtAmt,uint256 token1DebtAmt,uint256 debtSharesMin,uint256 colPerUnitDebt,uint256 token0ColAmtPerUnitShares,uint256 token1ColAmtPerUnitShares,bool absorb,address approveToken1,address target1,bytes data1,address approveToken2,address target2,bytes data2,uint256 minProfit) plan) returns (uint256 profitOut)",
]);
const CURVE_ROUTER_NG_ABI = new ethers.Interface([
  "function exchange(address[11] route,uint256[5][5] swapParams,uint256 amount,uint256 expected,address[5] pools,address receiver) payable returns (uint256)",
]);
const PENDLE_ROUTER_V4_ABI = new ethers.Interface([
  "function swapExactPtForToken(address receiver, address market, uint256 exactPtIn, (address tokenOut, uint256 minTokenOut, address tokenRedeemSy, address pendleSwap, (uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) output, (address limitRouter, uint256 epsSkipMarket, ((uint256,uint256,uint256,uint8,address,address,address,address,uint256,uint256,uint256,bytes),bytes,uint256)[] normalFills, ((uint256,uint256,uint256,uint8,address,address,address,address,uint256,uint256,uint256,bytes),bytes,uint256)[] flashFills, bytes optData) limit) returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)",
]);
const READS = new ethers.Interface(["function market(bytes32)", "function position(bytes32,address)", "function price()"]);
const SAVING = new ethers.Interface(["function currentPrice() view returns (uint256)", "function redeem(uint256 amount)"]);
const IRM = new ethers.Interface(["function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)"]);
const encode = (types, values) => ethers.AbiCoder.defaultAbiCoder().encode(types, values);
const uints = values => encode(values.map(() => "uint256"), values);
const aggregate = rows => MC.encodeFunctionResult("aggregate3", [rows.map(returnData => ({ success: true, returnData }))]);
const ceil = (n, d) => (n + d - 1n) / d;

// Existing CommonJS/injected-transport seam, with all runtime filesystem/network access denied.
function loadWatcher(transport, cached) {
  const filename = require.resolve("../watch-top-whale-triggers.js");
  const localRequire = createRequire(filename);
  const source = fs.readFileSync(filename, "utf8").replace(/^#![^\n]*\n/, "");
  const module = { exports: {} };
  const denied = () => { throw new Error("OFFLINE_FIXTURE_ONLY"); };
  const fixtureFs = { existsSync: () => Boolean(cached), readFileSync: () => {
    assert.ok(cached);
    return JSON.stringify({ generatedAt: new Date().toISOString(), targets: { [KEY]: cached } });
  }, mkdirSync: denied, writeFileSync: denied, renameSync: denied };
  const nowMs = Number(BigInt(HEADER.timestamp)) * 1000 + 60000;
  const fixtureDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  };
  compileFunction(source, ["exports", "require", "module", "__filename", "__dirname", "fetch", "Date"], { filename })(
    module.exports, name => name === "./shared-rpc.js" ? { rpcCall: transport, resolveRpc: denied }
      : name === "node:fs" ? fixtureFs : localRequire(name), module, filename, path.dirname(filename), denied, fixtureDate);
  return module.exports;
}

// Same synthetic mandatory Ethereum batches as watch-top-whale-triggers.test.js.
function ethereumFixture(extraUsers) {
  const price = 100_000_000n;
  const account = uints([0, 9300, 101n * W / 100n, 1030n * W * price, 955n * W * price * R, 1, 1]);
  const position = (supplied, drawn) => encode(["uint120", "uint120", "int200", "uint120", "uint32"], [drawn, 0, 0, supplied, 0]);
  const hub = (liquidity, shares, debt, decimals) => encode(
    ["uint120", "uint120", "uint8", "uint120", "uint120", "int256", "uint120", "uint120", "uint16", "uint120", "uint96", "uint40", "address", "address", "address", "address", "uint256"],
    [liquidity, 0, decimals, shares, 0, 0, debt, 0, 1000, R, 0, BigInt(HEADER.timestamp), ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, 0]);
  const feed = uints([1, price, BigInt(HEADER.timestamp), BigInt(HEADER.timestamp), 1]);
  const v3 = uints([2000n * price, 955n * price, 0, 0, 0, 101n * W / 100n]);
  return aggregate([
    account, position(1030n * W, 0), position(0, 955_000000n),
    hub(1030n * W, 1030n * W, 0, 18), hub(0, 955_000000n, 955_000000n, 6),
    uints([price]), uints([price]), feed, feed, v3, v3, uints([955n * W]), uints([955n * W]),
    encode(["uint256[]"], [[price, price]]), uints([100_000000n, 0, 0, 0, 0, 0]), uints([1000_000000n]), uints([1000n * W]),
    hub(1010n * W, 1010n * W, 0, 18), hub(0, 955n * W, 955n * W, 18), uints([price]), uints([price]),
    ...Array.from({ length: 8 }, () => [account, position(1010n * W, 0), position(0, 955n * W)]).flat(),
    ...extraUsers.flatMap((_, i) => [uints([(2000n + BigInt(i) * 100n) * price, (1000n + BigInt(i) * 100n) * price, 0, 0, 0, 101n * W / 100n]), uints([(1000n + BigInt(i) * 100n) * W])]),
    uints([1_000_000n * W, 0, 500_000n * W, 500_000n * W * V, BigInt(HEADER.timestamp), 0]),
    uints([0, 200_000n * W * V, 240_000n * W]), uints([10n ** 36n]),
    uints([1_000_000000000n, 0, 500_000000000n, 500_000000000000000n, BigInt(HEADER.timestamp), 0]),
    uints([0, 200_000000000000000n, 240_000n * W]), uints([10n ** 24n]),
  ]);
}

async function capture(options = {}) {
  let batches = 0, savingPriceReads = 0;
  const rate = options.missingRate ? null : options.rate ?? 0n;
  const elapsed = options.elapsed ?? 0n;
  const market = [1000000n * W, 0n, 500000n * W, 500000n * W * V, BigInt(HEADER.timestamp) - elapsed, 0n];
  const position = [0n, (options.debt ?? 1000n * W) * V, 1100n * W];
  const price = 10n ** 36n;
  const transport = async (rpc, method, params) => {
    assert.equal(rpc, "offline-ethereum");
    if (method === "eth_getBlockByNumber") return HEADER;
    assert.equal(method, "eth_call");
    assert.equal(params[1], HEADER.hash);
    if (options.reservoirPrice !== undefined && params[0].to.toLowerCase() === "0x5475611dffb8ef4d697ae39df9395513b6e947d7") {
      assert.equal(params[0].data, SAVING.encodeFunctionData("currentPrice")); savingPriceReads++;
      return SAVING.encodeFunctionResult("currentPrice", [options.reservoirPrice]);
    }
    const requests = MC.decodeFunctionData("aggregate3", params[0].data)[0];
    if (++batches === 1) { assert.equal(requests.length, 65); return ethereumFixture(watcher.EXTRA_V3_WEETH_USERS); }
    if (batches === 2) {
      assert.equal(requests.length, 22);
      return aggregate([uints([1000_000000n, 0, 0, 0]), ...Array.from({ length: 10 }, () => uints([1000n * W])),
        ...watcher.EXTRA_V3_WEETH_USERS.map((_, i) => uints([(1000n + BigInt(i) * 10n) * W])),
        encode(["uint256", "uint160[]", "uint32[]", "uint256"], [108000n * W, [], [], 100000n]), uints([0n]), uints([108_000000000n]), uints([0n])]);
    }
    const rows = requests.map(() => ({ success: false, returnData: "0x" }));
    const put = (index, values) => { rows[index] = { success: true, returnData: uints(values) }; };
    if (requests.length >= 114) {
      assert.equal(READS.decodeFunctionData("market", requests[57].callData)[0], MARKET);
      assert.equal(READS.decodeFunctionData("position", requests[59].callData)[1].toLowerCase(), USER);
      if (!options.missingM32) { put(57, market); put(58, [price]); put(59, position); }
      if (!options.cached) {
        put(53, [1_000_000000000n, 0n, 500_000000000n, 500_000000000000000n, BigInt(HEADER.timestamp), 0n]);
        put(54, [11n * 10n ** 35n]); put(55, [0n, 1000n * 10n ** 12n, 1000n * 10n ** 6n]);
      }
      if (options.pendleCurve) {
        put(34, market); put(35, [price]); put(36, position);
        put(38, [1_000_000000000n, 0n, 500_000000000n, 500_000000000000000n, BigInt(HEADER.timestamp), 0n]);
        put(39, [price]); put(40, [0n, 1000n * 10n ** 12n, 1100n * 10n ** 6n]);
      }
      if (options.curveRouterNg) {
        const curveMarket = [1_000_000000000n, 0n, 500_000000000n, 500_000000000000000n, BigInt(HEADER.timestamp), 0n];
        const curvePosition = [0n, 100_000n * 10n ** 12n, 200_000n * W];
        put(73, curveMarket); put(74, [11n * 10n ** 23n]); put(75, curvePosition); put(82, curvePosition);
        put(95, curveMarket); put(96, [11n * 10n ** 23n]); put(97, curvePosition);
      }
      if (options.reservoirPrice !== undefined) {
        put(92, [1_000_000000000n, 0n, 500_000000000n, 500_000000000000000n, BigInt(HEADER.timestamp), 0n]);
        put(93, [11666n * 10n ** 20n]); put(94, [0n, 30000n * 10n ** 12n, 25000n * W]);
      }
    } else if (requests.length === 25) {
      if (!options.missingM32) {
        const [params] = IRM.decodeFunctionData("borrowRateView", requests[13].callData);
        assert.equal(params[0].toLowerCase(), "0xc139190f447e929f090edeb554d95abb8b18ac1c");
        assert.equal(params[4], 915000000000000000n);
        if (rate !== null) put(13, [rate]);
      }
      if (!options.cached) put(12, [0n]);
    }
    return MC.encodeFunctionResult("aggregate3", [rows]);
  };
  const watcher = loadWatcher(transport, options.cached);
  const state = await watcher.checkOnce({ includeM10M11: true, writeOut: false,
    resolveRpc: async chain => { assert.ok(chain === 1 || chain === 8453); return chain === 1 ? "offline-ethereum" : null; },
    ...(options.cached || options.reservoirPrice !== undefined ? {} : { rpcCall: transport }),
  });
  assert.ok(batches >= 4);
  return { state, market, position, price, rate, elapsed, savingPriceReads, compounded: watcher.wTaylorCompounded };
}

function assertM32Binding(row) {
  assert.equal(row.executor, deployment.EXECUTOR);
  assert.equal(row.deployedExecutor, deployment.EXECUTOR);
  assert.equal(row.kind, "MORPHO_BLUE_M32");
  assert.equal(row.observationOnly, false);
  assert.equal(row.armed, false);
  assert.equal(row.executableNow, false);
  assert.equal(row.observationKind, "READ_ONLY_MONITOR");
  assert.equal(row.quoteKind, "HISTORICAL_REFERENCE");
  assert.equal(row.liveQuote.provenance, "HISTORICAL_REFERENCE");
  assert.equal(row.quoteCurrent, false);
  assert.equal(row.quoteObservation, null);
  assert.equal(row.readinessNote, NOTE);
  assert.equal(row.liveQuote.grossSurplusUsdc, 279.34);
  assert.equal(row.liveQuote.grossSurplusUsd, 213.50);
  assert.equal(Object.keys(row).some(key => /^readyExecute.*Calldata$/.test(key)), false);
}

test("M32 public identity exports are frozen, import-inert and exact", () => {
  const module = { exports: {} };
  compileFunction(fs.readFileSync(require.resolve("../lib/m32-deployment.js"), "utf8"), ["module"])(module);
  assert.ok(Object.isFrozen(module.exports));
  assert.deepEqual(module.exports, deployment);
  assert.deepEqual(deployment, {
    CHAIN_ID: 1, EXECUTOR: "0x2c94b422884c0495cae3cef9ce7ab337fac247c4",
    OWNER: "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a",
    RUNTIME_KECCAK256: "0x2b3e40560e4e0ce96999b35d6f0141def9d7cba00baf7aa3caa7f22cd3f4a191",
    CONTRACT_NAME: "MorphoM32CurveUnwindLiquidator",
    DEPLOYMENT_TX: "0xf3188a029fcf991aa215c428109d94180f50338e07aaec05449a76155a969c3c",
  });
});

for (const [name, options, liquidatable] of [
  ["healthy", {}, false], ["accrued underwater", { rate: 10n ** 12n, elapsed: 10000n }, true],
  ["missing rate", { missingRate: true, debt: 1200n * W }, false], ["no debt", { debt: 0n }, false],
]) test(`M32 ${name} keeps non-authorizing reference gains and observed health without ready calldata`, async () => {
  const { state, market, position, price, rate, elapsed, compounded } = await capture(options);
  const row = state.targets[KEY];
  assert.equal(row.user, USER); assert.equal(row.marketId, MARKET);
  const accrued = market[2] + market[2] * compounded(rate ?? 0n, elapsed) / W;
  const debt = ceil(position[1] * (accrued + 1n), market[3] + V);
  assertM32Binding(row);
  assert.deepEqual(row.liveQuote, { ...REFERENCE_QUOTE, ...REFERENCE_METADATA }, "current debt must never be added to fixed historical gain");
  assert.equal(row.observationStatus, "COMPLETE");
  const storedDebt = ceil(position[1] * (market[2] + 1n), market[3] + V);
  const collVal = position[2] * price / (10n ** 36n);
  const maxBorrow = collVal * 915000000000000000n / W;
  const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
  const growth = debt * (rate ?? 0n) / W;
  assert.equal(row.healthFactor, hf);
  assert.equal(row.storedHealthFactor, storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null);
  assert.equal(row.healthIsEstimate, rate === null);
  assert.equal(row.borrowAprPct, rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null);
  assert.equal(row.borrowApyPct, rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null);
  assert.equal(row.passiveHoursToCrossing, liquidatable ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null);
  assert.equal(row.bpsToLiquidation, hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null);
  assert.equal(row.collateralUsd, +(Number(collVal) / 1e18).toFixed(2));
  assert.equal(row.debtUsd, +(Number(debt) / 1e18).toFixed(2));
  assert.equal(row.liquidatableNow, liquidatable);
  assert.equal(state.firedTriggers.includes(TRIGGER), liquidatable);
});

test("M32 nomination does not change other targets or M31 shared-M2 calldata bytes", async () => {
  const before = (await capture({ missingM32: true })).state;
  const after = (await capture({ rate: 10n ** 12n, elapsed: 10000n })).state;
  const others = { ...after.targets }; delete others[KEY];
  assert.deepEqual(others, before.targets);
  assert.deepEqual(after.firedTriggers.filter(value => value !== TRIGGER), before.firedTriggers);
  for (const key of ["targetM2_Morpho_reUSD_USDC", "targetM31_Morpho_syrupUSDC_USDC"]) {
    assert.equal(after.targets[key].executor, M2_EXECUTOR);
    assert.equal(after.targets[key].armed, false);
    assert.equal(after.targets[key].observationOnly, false);
  }
  const expected = M2_ABI.encodeFunctionData("execute", [[
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
    "0x80032f4cb6e3573b9ed61e888af658e48fb790cc", "0x870ac11d48b15db9a138cf899d20f13f79ba00bc", 915000000000000000n,
    "0x950fd558f47e234a2fde23b7d61f7ccdbcb4a86f", 740000000n,
    "0x6131b5fae19ea4f9d964eac0408e4408b66337b5", 819000000n,
  ], "0xe21fd0e9"]);
  assert.equal(after.targets.targetM31_Morpho_syrupUSDC_USDC.readyExecuteCurveUnwindCalldata, expected);
  assert.equal(after.targets.targetM31_Morpho_syrupUSDC_USDC.readyExecuteReusdCalldata, expected);
});

for (const binding of ["m2", "curve", "reusd"]) test(`legacy cached M32 ${binding} replaces old profit and strips M2 binding and all ready calls`, async () => {
  const cached = { rank: "#M32", user: USER, marketId: MARKET, pair: "sUSDe / USDtb", healthFactor: .99,
    liquidatableNow: true, observationOnly: false, armed: true, executableNow: true,
    executor: binding === "m2" ? M2_EXECUTOR : deployment.EXECUTOR,
    deployedExecutor: binding === "m2" ? M2_EXECUTOR : deployment.EXECUTOR,
    liveQuote: { repayUsdc: 9000, seizedReusd: 8000, curveOutUsdc: 9276.80, grossSurplusUsdc: 276.80, grossSurplusUsd: 276.80 },
    readyExecuteMorphoBlueCalldata: "0x12345678" };
  if (binding !== "m2") cached[binding === "curve" ? "readyExecuteCurveUnwindCalldata" : "readyExecuteReusdCalldata"] = "0x12345678";
  const { state } = await capture({ missingM32: true, cached });
  assertM32Binding(state.targets[KEY]);
  assert.deepEqual(state.targets[KEY].liveQuote, { ...REFERENCE_QUOTE, ...REFERENCE_METADATA });
  assert.equal(JSON.stringify(state.targets[KEY]).includes("276.8"), false);
  assert.equal(state.targets[KEY].observationStatus, "INCOMPLETE");
  assert.equal(state.targets[KEY].healthFactor, cached.healthFactor);
  assert.equal(state.firedTriggers.includes(TRIGGER), false);
});

test("M21 and M23 ready Curve unwind calldata keeps needScale false for raw Curve.exchange selector", async () => {
  const { state } = await capture({ pendleCurve: true });
  for (const key of ["targetM21_Morpho_PT_apyUSD_apxUSD", "targetM23_Morpho_PT_reUSD_USDC"]) {
    const row = state.targets[key];
    assert.ok(row?.readyExecuteCurveUnwindCalldata, key);
    const [plan, swapData] = M2_ABI.decodeFunctionData("execute", row.readyExecuteCurveUnwindCalldata);
    assert.equal(plan.swapTarget.toLowerCase(), "0x888888888889758f76e7103c6cbf23abbf58f946");
    const decoded = PENDLE_ROUTER_V4_ABI.decodeFunctionData("swapExactPtForToken", swapData);
    assert.equal(decoded.exactPtIn, plan.seizedAssets);
    assert.equal(decoded.output.swapData.swapType, 1n);
    assert.equal(decoded.output.swapData.needScale, false, key);
  }
});

test("M36, M38 and M45 encode deterministic three-hop CurveRouterNG universal calldata", async () => {
  const { state } = await capture({ curveRouterNg: true });
  const zero = ethers.ZeroAddress, executor = "0xc50321a07dab061d59b992e57a2ef4dca0d33089";
  const susde = "0x9d39a5de30e57443bff2a8307a4256c8797a3497", crvusd = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e";
  const middlePool = "0x57064f49ad7123c92560882a45518374ad982e85";
  for (const [key, isReusde] of [["targetM36_Morpho_sUSDS_USDT", false], ["targetM38_Morpho_sUSDS_USDT", false], ["targetM45_Morpho_reUSDe_USDC", true]]) {
    const row = state.targets[key];
    assert.ok(row?.readyExecuteUniversalCalldata, key);
    const [plan] = UNIVERSAL_ABI.decodeFunctionData("execute", row.readyExecuteUniversalCalldata);
    assert.equal(plan.target1.toLowerCase(), "0x16c6521dff6bab339122a0fe25a9116693265353", key);
    assert.equal(plan.approveToken1, plan.collateralToken);
    assert.equal(plan.seizedAssets, (isReusde ? 30000n : 40000n) * W);
    assert.equal(plan.target2, zero); assert.equal(plan.data2, "0x");
    const swap = CURVE_ROUTER_NG_ABI.decodeFunctionData("exchange", plan.data1);
    const firstPool = isReusde ? "0x43b98eea5c689f0036918f590a4b55f22d853734" : "0x3cef1afc0e8324b57293a6e7ce663781bbefbb79";
    const lastPool = isReusde ? "0x4dece678ceceb27446b35c672dc7d61f30bad69e" : "0x390f3595bca2df7d23783dfd126427cceb997bf4";
    assert.deepEqual(Array.from(swap.route, value => value.toLowerCase()),
      [plan.collateralToken.toLowerCase(), firstPool, susde, middlePool, crvusd, lastPool, plan.loanToken.toLowerCase(), zero, zero, zero, zero]);
    assert.deepEqual(Array.from(swap.pools, value => value.toLowerCase()), [firstPool, middlePool, lastPool, zero, zero]);
    assert.deepEqual(Array.from(swap.swapParams, values => Array.from(values)),
      [isReusde ? [0n, 1n, 1n, 20n, 2n] : [1n, 0n, 1n, 10n, 2n], [1n, 0n, 1n, 10n, 2n], [1n, 0n, 1n, 10n, 2n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n]]);
    assert.equal(swap.amount, plan.seizedAssets);
    assert.equal(swap.expected, plan.flashAmount + (isReusde ? 100000000n : 50000000n));
    assert.equal(swap.receiver.toLowerCase(), executor);
    const repay = ceil(ceil(plan.seizedAssets * 11n * 10n ** 23n, 10n ** 36n) * W, isReusde ? 1074113856068743286n : 1010611419909044972n);
    const out = isReusde ? 41053110000n : 44499240000n;
    assert.deepEqual(row.liveQuote, { provenance: "MODEL_ESTIMATE", observationBlock: null, observationHash: null, observationUtc: null,
      repayUsdc: +(Number(repay) / 1e6).toFixed(2), seizedReusd: isReusde ? 30000 : 40000,
      curveOutUsdc: +(Number(out) / 1e6).toFixed(2), grossSurplusUsdc: +((Number(out) - Number(repay)) / 1e6).toFixed(2),
       grossSurplusUsd: +((Number(out) - Number(repay)) / 1e6).toFixed(2) });
    assert.equal(row.quoteKind, "MODEL_ESTIMATE");
    assert.equal(row.quoteCurrent, false);
    assert.match(row.readinessNote, /CurveRouterNG/);
  }
});

for (const reservoirPrice of [116660000n, 1166600000000000000n]) test(`M44 uses the 2bps redemption haircut and aligned whole-unit legs (price ${reservoirPrice})`, async () => {
  const { state, savingPriceReads } = await capture({ reservoirPrice });
  assert.equal(savingPriceReads, 1);
  const row = state.targets.targetM44_Morpho_srUSD_USDC;
  const [plan] = UNIVERSAL_ABI.decodeFunctionData("execute", row.readyExecuteUniversalCalldata);
  assert.equal(plan.seizedAssets, 22000n * W);
  assert.equal(plan.target1.toLowerCase(), "0x5475611dffb8ef4d697ae39df9395513b6e947d7");
  assert.equal(plan.target2.toLowerCase(), "0x4809010926aec940b550d34a46a52739f996d75d");
  const gross = plan.seizedAssets * 116660000n / 100000000n;
  const units = gross * 9998n / 10000n / W;
  assert.equal(SAVING.decodeFunctionData("redeem", plan.data1)[0], units * W);
  assert.equal(SAVING.decodeFunctionData("redeem", plan.data2)[0], units * 1000000n);
  assert.equal(units, 25660n); assert.equal(units - gross * 9995n / 10000n / W, 8n);
  // Synthetic fee/price arithmetic, not a claim of actual on-chain proceeds.
  const netAvailable = gross * (1000000n - 167n) / 1000000n;
  assert.ok(units * W <= netAvailable);
  const residualShares = ceil((netAvailable - units * W) * 100000000n, 116660000n);
  assert.ok(residualShares < 11n * W / 10n);
});

for (const hasQuote of [true, false]) test(`dedicated cached M32 restores the fixed rehearsal reference (legacy quote ${hasQuote})`, async () => {
  const liveQuote = { ...REFERENCE_QUOTE, repayUsdc: 12000, seizedReusd: 10000, curveOutUsdc: 12279.34 };
  const cached = { rank: "#M32", user: USER, marketId: MARKET, pair: "sUSDe / USDtb", healthFactor: 1.01,
    liquidatableNow: false, observationOnly: true, armed: false, executableNow: true,
    executor: deployment.EXECUTOR, deployedExecutor: deployment.EXECUTOR,
    ...(hasQuote ? { liveQuote } : {}) };
  const { state } = await capture({ missingM32: true, cached });
  assertM32Binding(state.targets[KEY]);
  assert.deepEqual(state.targets[KEY].liveQuote, { ...REFERENCE_QUOTE, ...REFERENCE_METADATA });
  assert.equal(state.targets[KEY].observationTimestamp, null);
  assert.equal(state.targets[KEY].observationHash, null);
  assert.equal(state.targets[KEY].refreshStatus, "INCOMPLETE");
  assert.equal(state.targets[KEY].observationStatus, "INCOMPLETE");
  assert.equal(state.targets[KEY].debtUsd, undefined);
  assert.equal(state.targets[KEY].healthFactor, cached.healthFactor);
  assert.equal(state.firedTriggers.includes(TRIGGER), false);
});

test("M32 restart retains its prior pin and historicalReference without claiming a fresh refresh", async () => {
  const original = (await capture()).state.targets[KEY];
  const historicalReference = { source: "m32_historical_local_rehearsal", modeledNetUsd: "213.49892698" };
  const cached = { ...original, historicalReference, observationTimestamp: original.observationTimestamp - 12,
    observationBlock: original.observationBlock - 1, observationHash: `0x${"77".repeat(32)}`,
    observationUtc: new Date((original.observationTimestamp - 12) * 1000).toISOString() };
  const { state } = await capture({ missingM32: true, cached });
  const row = state.targets[KEY];
  assertM32Binding(row);
  assert.equal(row.observationHash, cached.observationHash);
  assert.equal(row.observationBlock, cached.observationBlock);
  assert.equal(row.observationTimestamp, cached.observationTimestamp);
  assert.equal(row.observationUtc, cached.observationUtc);
  assert.notEqual(row.observationHash, state.pin.hash);
  assert.equal(row.refreshStatus, "INCOMPLETE");
  assert.equal(row.refreshReason, "TARGET_REFRESH_FAILED");
  assert.deepEqual(row.historicalReference, historicalReference);
  assert.deepEqual(row.liveQuote, { ...REFERENCE_QUOTE, ...REFERENCE_METADATA });
});

test("explicitly measured cached M32 quote keeps its original provenance but is not current", async () => {
  const { state: original } = await capture();
  const liveQuote = { repayUsdc: 1000, seizedReusd: 1100, curveOutUsdc: 1005, grossSurplusUsdc: 5,
    provenance: "ONCHAIN_MEASURED", observationBlock: original.pin.number, observationHash: original.pin.hash, observationUtc: original.pin.utc };
  const cached = { ...original.targets[KEY], liveQuote, quoteKind: "ONCHAIN_MEASURED", quoteObservation: original.pin };
  const { state } = await capture({ missingM32: true, cached });
  const row = state.targets[KEY];
  assert.deepEqual(row.liveQuote, liveQuote);
  assert.deepEqual(row.quoteObservation, original.pin);
  assert.equal(row.quoteKind, "ONCHAIN_MEASURED");
  assert.equal(row.quoteCurrent, false);
  assert.equal(row.armed, false);
  assert.equal(row.executableNow, false);
  assert.equal(row.refreshStatus, "INCOMPLETE");
});
