"use strict";

// Offline calldata transformations only. No runner entry, provider, inventory,
// authority, wallet, signing or network calls.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { createRequire } = require("node:module");
const { Interface } = require("../node_modules/ethers");
const FILE = path.resolve(__dirname, "../execute-top-whale-trigger.js"), native = createRequire(FILE), moduleFixture = { exports: {} };
const forbidden = () => assert.fail("scaling must not perform IO or load attended composition");
const req = name => name === "node:fs" ? new Proxy({}, { get: () => forbidden }) :
  name === "./lib/m32-attended-call.cjs" ? forbidden() : native(name);
vm.compileFunction(fs.readFileSync(FILE, "utf8").replace(/^#![^\n]*\n/, ""), ["require", "module", "exports", "__dirname", "__filename"], { filename: FILE })
  (req, moduleFixture, moduleFixture.exports, path.dirname(FILE), FILE);
const { buildScaledM2Variants, buildScaledPendlePtVariants } = moduleFixture.exports;
const M2 = new Interface(["function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address swapTarget,uint256 minLoanOut) plan,bytes swapData)"]);
const PT = new Interface(["function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address pendleYt,address pendleSy,address redeemedToken,address swapTarget,uint256 minLoanOut) plan,bytes swapData)"]);
const CURVE = new Interface(["function exchange(int128 i,int128 j,uint256 dx,uint256 min_dy) returns(uint256)"]);
const REDEEM = new Interface(["function redeem(uint256 shares,address receiver,address owner,uint256 maxLoss) returns(uint256)"]);
const ROUTER = new Interface(["function swapExactPtForToken(address receiver,address market,uint256 exactPtIn,(address tokenOut,uint256 minTokenOut,address tokenRedeemSy,address pendleSwap,(uint8 swapType,address extRouter,bytes extCalldata,bool needScale) swapData) output,(address limitRouter,uint256 epsSkipMarket,((uint256,uint256,uint256,uint8,address,address,address,address,uint256,uint256,uint256,bytes),bytes,uint256)[] normalFills,((uint256,uint256,uint256,uint8,address,address,address,address,uint256,uint256,uint256,bytes),bytes,uint256)[] flashFills,bytes optData) limit) returns(uint256,uint256,uint256)"]);
const CURVE_NG = new Interface(["function exchange(address[11] route,uint256[5][5] swaps,uint256 amount,uint256 expected,address[5] pools,address receiver) payable returns(uint256)"]);
const SHARES = new Interface(["function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,address borrower,uint256 seizedAssets,uint256 repaidShares,uint256 minProfitWei,uint256 minOut,address router,bytes routerSwapData)"]);
const address = n => "0x" + BigInt(n).toString(16).padStart(40, "0"), ZERO = address(0), EXECUTOR = address(9);
const BPS = [10000, 9500, 9000, 8000, 7000, 5000, 2500];
const floor = (value, bps) => value * BigInt(bps) / 10000n;
const ceil = (value, bps) => (value * BigInt(bps) + 9999n) / 10000n;
const profitFloor = (value, bps) => floor(value, bps) > 0n ? floor(value, bps) : 1n;
function fixture(kind) {
  const plan = { loanToken: address(1), collateralToken: address(2), oracle: address(3), irm: address(4), lltv: 915000000000000000n,
    borrower: address(5), seizedAssets: 1003n * 10n ** 18n + 7n, swapTarget: address(6), minLoanOut: 10007n };
  const innerMin = 21011n;
  let swap;
  if (kind === "Curve") swap = CURVE.encodeFunctionData("exchange", [0, 1, plan.seizedAssets, innerMin]);
  else if (kind === "M25" || kind === "M18") swap = REDEEM.encodeFunctionData("redeem", [plan.seizedAssets, EXECUTOR, EXECUTOR, 37n]);
  else swap = ROUTER.encodeFunctionData("swapExactPtForToken", [EXECUTOR, address(7), plan.seizedAssets,
    [address(1), innerMin, address(2), address(8), [2, address(10), "0x123456", true]], [ZERO, 0, [], [], "0xabcd"]]);
  const candidate = { id: kind === "Curve" ? "targetM2_Morpho_reUSD_USDC" : `target${kind}_Morpho_USD3_USDC`,
    kind: "MORPHO_BLUE_M2", mode: "seizedAssets", executor: EXECUTOR, data: M2.encodeFunctionData("execute", [plan, swap]),
    seizedAssets: plan.seizedAssets, minLoanOut: plan.minLoanOut, minOutUsdc: 10009n, innerSwapMinOut: innerMin,
    minProfitUsdc: 103n, conservativeProfitBeforeGasWei: 456n };
  const fullRepaidSharesVariant = Object.freeze({ id: candidate.id, mode: "repaidShares", executor: EXECUTOR, seizedAssets: 0n, repaidShares: 987654321n,
    conservativeProfitBeforeGasWei: 789n, data: SHARES.encodeFunctionData("execute", [[plan.loanToken, plan.collateralToken, plan.oracle, plan.irm, plan.lltv],
      plan.borrower, 0n, 987654321n, 1n, candidate.minOutUsdc, plan.swapTarget, swap]) });
  return { candidate, plan, swap, kind, fullRepaidSharesVariant };
}
function checkM2Variant(f, variant, bps) {
  const c = f.candidate, [p, swap] = M2.decodeFunctionData("execute", variant.data);
  for (const key of ["loanToken", "collateralToken", "oracle", "irm", "lltv", "borrower", "swapTarget"])
    assert.equal(p[key], M2.decodeFunctionData("execute", c.data)[0][key]);
  const minProfit = profitFloor(c.minProfitUsdc, bps), minLoan = floor(f.plan.minLoanOut - c.minProfitUsdc, bps) + minProfit;
  assert.equal(p.seizedAssets, floor(f.plan.seizedAssets, bps)); assert.equal(variant.seizedAssets, p.seizedAssets);
  assert.equal(p.minLoanOut, minLoan); assert.equal(variant.minLoanOut, minLoan); assert.equal(variant.minProfitUsdc, minProfit);
  assert.equal(variant.minOutUsdc, ceil(c.minOutUsdc, bps)); assert.equal(variant.innerSwapMinOut, ceil(c.innerSwapMinOut, bps));
  if (f.kind === "Curve") assert.deepEqual(Array.from(CURVE.decodeFunctionData("exchange", swap)),
    [0n, 1n, floor(f.plan.seizedAssets, bps), ceil(c.innerSwapMinOut, bps)]);
  else if (f.kind === "M25" || f.kind === "M18") assert.deepEqual(Array.from(REDEEM.decodeFunctionData("redeem", swap)),
    [floor(f.plan.seizedAssets, bps), EXECUTOR, EXECUTOR, 37n]);
  else {
    const original = ROUTER.decodeFunctionData("swapExactPtForToken", f.swap), scaled = ROUTER.decodeFunctionData("swapExactPtForToken", swap);
    assert.equal(scaled[0], original[0]); assert.equal(scaled[1], original[1]); assert.equal(scaled[2], floor(original[2], bps));
    assert.equal(scaled[3].minTokenOut, ceil(c.innerSwapMinOut, bps));
    for (const key of ["tokenOut", "tokenRedeemSy", "pendleSwap"]) assert.equal(scaled[3][key], original[3][key]);
    assert.deepEqual(scaled[3].swapData.toArray(true), original[3].swapData.toArray(true));
    assert.deepEqual(scaled[4].toArray(true), original[4].toArray(true));
  }
}
test("shared M2 defaults retain the original candidate and 100/50/25 sizes for every supported route", () => {
  for (const kind of ["Curve", "M25", "M18", "M22"]) {
    const f = fixture(kind), candidate = Object.freeze(f.candidate), variants = buildScaledM2Variants(candidate);
    assert.equal(variants.length, 3); assert.equal(variants[0], candidate); assert.equal(variants[0].bps, undefined);
    assert.deepEqual(variants.slice(1).map(v => v.bps), [5000, 2500]);
    variants.forEach((v, i) => { checkM2Variant(f, v, [10000, 5000, 2500][i]); assert.equal(v.conservativeProfitBeforeGasWei, i === 0 ? 456n : null); });
  }
});
for (const kind of ["Curve", "M25", "M18", "M22"]) test(`${kind} opts into an exact full-share variant plus all seven seizure sizes and mapped profits`, () => {
  const f = fixture(kind), profits = Object.freeze({ 10000: 1000n, 9500: 950n, 9000: 0n, 8000: null, 5000: 500n, 2500: 250n });
  const candidate = Object.freeze({ ...f.candidate, useFullBpsLadder: true, fullRepaidSharesVariant: f.fullRepaidSharesVariant, variantProfitByBps: profits });
  const variants = buildScaledM2Variants(candidate);
  assert.equal(variants.length, 8); assert.equal(variants[0], f.fullRepaidSharesVariant);
  assert.equal(SHARES.decodeFunctionData("execute", variants[0].data)[3], 987654321n);
  assert.deepEqual(variants.slice(1).map(v => v.bps), BPS);
  variants.slice(1).forEach((v, i) => {
    assert.equal(v.mode, "seizedAssets"); checkM2Variant(f, v, BPS[i]);
    assert.equal(v.conservativeProfitBeforeGasWei, profits[BPS[i]] ?? null);
  });
  assert.equal(variants[1].data, candidate.data); assert.equal(candidate.bps, undefined); assert.equal(candidate.conservativeProfitBeforeGasWei, 456n);
});
test("M32 keeps its automatic full ladder while other candidates require a literal true opt-in", () => {
  const f = fixture("Curve"), variants = buildScaledM2Variants({ ...f.candidate, id: "targetM32_Morpho_sUSDe_USDtb" });
  assert.deepEqual(variants.map(v => v.bps), BPS); variants.forEach((v, i) => checkM2Variant(f, v, BPS[i]));
  for (const useFullBpsLadder of [false, 1, "true"]) assert.equal(buildScaledM2Variants({ ...f.candidate, useFullBpsLadder }).length, 3);
});
test("profit-by-bps mapping also applies to non-M32 default ladders, preserving zero and explicit unknown", () => {
  const f = fixture("M25"), candidate = Object.freeze({ ...f.candidate, variantProfitByBps: { 10000: 100n, 5000: 0n, 2500: null } });
  const variants = buildScaledM2Variants(candidate);
  assert.equal(variants.length, 3); assert.deepEqual(variants.map(v => v.conservativeProfitBeforeGasWei), [100n, 0n, null]);
  assert.equal(candidate.conservativeProfitBeforeGasWei, 456n);
});
test("an explicit M2 profit map cannot fall back to the base profit for missing/null entries", () => {
  for (const variantProfitByBps of [null, {}, { 10000: null }, { 10000: undefined }, { 5000: 17n }]) {
    const candidate = Object.freeze({ ...fixture("M18").candidate, variantProfitByBps });
    const variants = buildScaledM2Variants(candidate);
    assert.deepEqual(variants.map(v => v.conservativeProfitBeforeGasWei), [null, variantProfitByBps?.[5000] ?? null, null]);
    assert.equal(candidate.conservativeProfitBeforeGasWei, 456n);
  }
});
test("full ladder does not force unsafe fixed external Pendle calldata through the existing scaler", () => {
  const f = fixture("M22"), decoded = ROUTER.decodeFunctionData("swapExactPtForToken", f.swap);
  const output = { ...decoded[3].toObject(), swapData: { ...decoded[3].swapData.toObject(), needScale: false } };
  const swap = ROUTER.encodeFunctionData("swapExactPtForToken", [decoded[0], decoded[1], decoded[2], output, decoded[4]]);
  const candidate = { ...f.candidate, useFullBpsLadder: true, fullRepaidSharesVariant: f.fullRepaidSharesVariant,
    data: M2.encodeFunctionData("execute", [f.plan, swap]) };
  const variants = buildScaledM2Variants(candidate);
  assert.equal(variants.length, 2); assert.equal(variants[0], f.fullRepaidSharesVariant); assert.equal(variants[1].data, candidate.data);
});
function ptFixture() {
  const plan = { loanToken: address(1), collateralToken: address(2), oracle: address(3), irm: address(4), lltv: 915000000000000000n,
    borrower: address(5), seizedAssets: 17003n * 10n ** 18n + 7n, pendleYt: address(6), pendleSy: address(7),
    redeemedToken: address(8), swapTarget: address(10), minLoanOut: 15007n };
  const route = [plan.redeemedToken, address(11), address(12), address(13), plan.loanToken, ...Array(6).fill(ZERO)];
  const swaps = [[1, 0, 1, 10, 2], [0, 1, 1, 10, 2], ...Array.from({ length: 3 }, () => [0, 0, 0, 0, 0])];
  const swap = CURVE_NG.encodeFunctionData("exchange", [route, swaps, 14001n * 10n ** 18n + 3n, 16011n, [address(11), address(13), ZERO, ZERO, ZERO], EXECUTOR]);
  return { plan, swap, data: PT.encodeFunctionData("execute", [plan, swap]), minProfit: 103n };
}
function checkPtVariant(f, variant, bps) {
  const [p, swap] = PT.decodeFunctionData("execute", variant.data), original = PT.decodeFunctionData("execute", f.data)[0];
  for (const key of Object.keys(f.plan).filter(k => !["seizedAssets", "minLoanOut"].includes(k))) assert.equal(p[key], original[key]);
  assert.equal(p.seizedAssets, floor(f.plan.seizedAssets, bps)); assert.equal(variant.minProfitRaw, profitFloor(f.minProfit, bps));
  assert.equal(p.minLoanOut, floor(f.plan.minLoanOut - f.minProfit, bps) + variant.minProfitRaw);
  const inner = CURVE_NG.decodeFunctionData("exchange", swap), base = CURVE_NG.decodeFunctionData("exchange", f.swap);
  assert.equal(inner[2], floor(base[2], bps)); assert.equal(inner[3], floor(base[3], bps));
  for (const i of [0, 1, 4]) assert.deepEqual(inner[i].toArray(true), base[i].toArray(true));
  assert.equal(inner[5], base[5]);
}
test("M29 two-argument PT scaling retains three sizes with explicit unknown native profit", () => {
  const f = ptFixture(), variants = buildScaledPendlePtVariants(f.data, f.minProfit);
  assert.equal(variants.length, 3); assert.deepEqual(variants[0], { data: f.data, minProfitRaw: f.minProfit, conservativeProfitBeforeGasWei: null });
  variants.forEach((v, i) => { assert.equal(v.bps, undefined); assert.equal(v.conservativeProfitBeforeGasWei, null); checkPtVariant(f, v, [10000, 5000, 2500][i]); });
  assert.deepEqual(buildScaledPendlePtVariants(f.data, 1n).map(v => v.minProfitRaw), [1n, 1n, 1n]);
});
test("PT profits never inherit or scale the full-size proof, including explicit null, missing and zero entries", () => {
  const f = ptFixture();
  for (const [options, expected] of [
    [{ conservativeProfitBeforeGasWei: 456n }, [456n, null, null]],
    [{ conservativeProfitBeforeGasWei: 456n, variantProfitByBps: null }, [null, null, null]],
    [{ conservativeProfitBeforeGasWei: 456n, variantProfitByBps: {} }, [null, null, null]],
    [{ conservativeProfitBeforeGasWei: 456n, variantProfitByBps: { 10000: null, 5000: 0n, 2500: 7n } }, [null, 0n, 7n]],
  ]) assert.deepEqual(buildScaledPendlePtVariants(f.data, f.minProfit, Object.freeze(options)).map(v => v.conservativeProfitBeforeGasWei), expected);
});
test("M29 opts into seven PT sizes with bps and per-size profit metadata", () => {
  const f = ptFixture(), profits = Object.freeze(Object.fromEntries(BPS.map(bps => [bps, BigInt(bps)])));
  const variants = buildScaledPendlePtVariants(f.data, f.minProfit, { useFullBpsLadder: true, variantProfitByBps: profits });
  assert.deepEqual(variants.map(v => v.bps), BPS); assert.equal(variants[0].data, f.data);
  variants.forEach((v, i) => { checkPtVariant(f, v, BPS[i]); assert.equal(v.conservativeProfitBeforeGasWei, profits[BPS[i]]); });
});
