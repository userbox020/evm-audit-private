"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("../node_modules/ethers");
const { evaluateSentinel, isConfirmedConstant, continuousRun, historyCarry,
  qualifyDivergenceChain, evaluateChainSentinels, pinnedHistoryCarry } = require("../monitor-oracle-divergence.js");

const oracle = "0x" + "11".repeat(20);
const morpho = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const hyperMorpho = "0x68e37dE8d93d3496ae143F2E900490f6280C57cD";
const baseMorpho = "0x" + "55".repeat(20);
const loanToken = "0x" + "33".repeat(20);
const collateralToken = "0x" + "44".repeat(20);
const marketParams = [loanToken, collateralToken, oracle, morpho, 915000000000000000n];
const marketId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "address", "address", "address", "uint256"], marketParams));
const marketIf = new ethers.Interface([
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function idToMarketParams(bytes32) view returns ((address,address,address,address,uint256))",
]);
const priceIf = new ethers.Interface(["function price() view returns (uint256)"]);

const ctx = {
  async call(_to, data) {
    if (data.startsWith(priceIf.getFunction("price").selector)) {
      return priceIf.encodeFunctionResult("price", [10n ** 36n]);
    }
    if (data.startsWith(marketIf.getFunction("market").selector)) {
      return marketIf.encodeFunctionResult("market", [1000n, 1000n, 100n, 100n, 0n, 0n]);
    }
    if (data.startsWith(marketIf.getFunction("idToMarketParams").selector)) {
      return marketIf.encodeFunctionResult("idToMarketParams", [marketParams]);
    }
    throw new Error("unexpected read");
  },
};
const decimalsIf = new ethers.Interface(["function decimals() view returns (uint8)"]);
const pinnedSpec = { chainId: 1, oracle, marketId, sentinel: `div:1:${oracle.slice(2, 10)}`,
  pair: "historical-only", kind: "constant-oracle", provenanceConstant: true, pinned: true,
  collateralToken, loanToken };
function pinnedCtx(change) {
  return { feedCache: new Map(), dexCache: new Map(), refCache: new Map([
    [collateralToken.toLowerCase(), { price: 2, source: "independent-collateral",
      sourceAddresses: ["0x" + "a1".repeat(20)] }],
    [loanToken.toLowerCase(), { price: 1, source: "independent-loan",
      sourceAddresses: ["0x" + "a2".repeat(20)] }],
  ]), call(to, data) {
    const override = change?.(to, data);
    if (override !== undefined) return Promise.resolve(override);
    if (data.startsWith(decimalsIf.getFunction("decimals").selector))
      return Promise.resolve(decimalsIf.encodeFunctionResult("decimals", [18]));
    return ctx.call(to, data);
  } };
}
const nowMs = Date.parse("2026-09-24T23:00:00Z");
const key = `1:${oracle.toLowerCase()}`;
const history = {
  prices: { [key]: (10n ** 36n).toString() },
  priceStreak: { [key]: 4 },
  priceFirstSeen: { [key]: nowMs - 2 * 3600_000 },
  nowMs,
  lastAt: new Date(nowMs - 60_000).toISOString(),
  previousChains: { "1": 99 }, chainBlocks: { "1": 100 },
};
const spec = { chainId: 1, oracle, morpho, marketId, coll: null, loan: null };

test("unchanged live price over many runs is not proof of a feedless oracle", async () => {
  const row = await evaluateSentinel({ ...spec, kind: "api-market", provenanceConstant: false }, ctx, history);
  assert.equal(row.constantAcrossRuns, true);
  assert.equal(row.borrowsPositive, true);
  assert.equal(row.availableRaw, "900");
  assert.equal(row.measurements.marketBound, true);
  assert.equal(row.measurements.marketStateReadable, true);
  assert.equal(row.feedless, false);
  assert.equal(row.actionable, false);
  assert.equal(row.fired, false);
});

test("only source-confirmed constant oracles trigger the liquidity watch", async () => {
  const confirmed = { ...spec, kind: "constant-oracle", provenanceConstant: true };
  assert.equal(isConfirmedConstant(confirmed), true);
  assert.equal(isConfirmedConstant({ ...spec, kind: "custom-oracle", provenanceConstant: true }), false);
  const row = await evaluateSentinel(confirmed, ctx, history);
  assert.equal(row.feedless, true);
  assert.equal(row.actionable, true);
  assert.equal(row.fired, true);
});

test("chain-aware Morpho deployment is required before any market binding read", async () => {
  const observed = [];
  const local = { ...ctx, call: (to, data) => { observed.push(to); return ctx.call(to, data); } };
  const checkMarketTargets = (expected) => {
    assert.equal(observed.length, 3); // oracle price and two market reads
    assert.deepEqual(observed.slice(1), [expected, expected]);
    observed.length = 0;
  };
  const hyper = await evaluateSentinel({ ...spec, chainId: 999, morpho: undefined }, local, history);
  assert.equal(hyper.ok, true);
  assert.equal(hyper.measurements.marketBound, true);
  assert.equal(hyper.measurements.marketStateReadable, true);
  assert.equal(hyper.referenceOk, false); // no invented WHYPE reference
  checkMarketTargets(hyperMorpho);

  const ethereum = await evaluateSentinel({ ...spec, morpho: undefined }, local, history);
  assert.equal(ethereum.ok, true);
  assert.equal(ethereum.measurements.marketBound, true);
  checkMarketTargets(morpho);

  const base = await evaluateSentinel({ ...spec, chainId: 8453, morpho: undefined }, local, history);
  assert.equal(base.ok, true);
  assert.equal(base.measurements.marketBound, true);
  assert.equal(base.referenceOk, false); // no fabricated independent cbETH feed
  checkMarketTargets(morpho);

  const baseProvided = await evaluateSentinel({ ...spec, chainId: 8453, morpho }, local, history);
  assert.equal(baseProvided.ok, true);
  assert.equal(baseProvided.measurements.marketBound, true);
  checkMarketTargets(morpho);

  for (const chainId of [1, 8453, 999]) {
    const conflict = await evaluateSentinel({ ...spec, chainId, morpho: baseMorpho }, local, history);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "morpho-deployment-mismatch");
    assert.match(conflict.reason, /conflicts with the verified chain deployment/);
    assert.equal(conflict.measurements.marketBound, false);
    assert.equal(conflict.actionable, false);
    assert.deepEqual(observed, []);
  }
  const invalidBase = await evaluateSentinel({ ...spec, chainId: 8453, morpho: "bad-address" }, local, history);
  assert.equal(invalidBase.error, "morpho-deployment-mismatch");
  assert.deepEqual(observed, []);

  const unsupported = await evaluateSentinel({ ...spec, chainId: 42161, morpho: undefined }, local, history);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error, "morpho-deployment-unverified");
  assert.equal(unsupported.measurements.marketBound, false);
  assert.equal(unsupported.actionable, false);
  assert.deepEqual(observed, []);

  for (const [raw, error] of [
    ["0x", "market-params-unreadable"],
    [marketIf.encodeFunctionResult("idToMarketParams",
      [[loanToken, collateralToken, morpho, morpho, marketParams[4]]]), "oracle-mismatch"],
  ]) {
    const altered = { ...local, call: (to, data) => data.startsWith(marketIf.getFunction("idToMarketParams").selector)
      ? (observed.push(to), Promise.resolve(raw)) : local.call(to, data) };
    const row = await evaluateSentinel({ ...spec, chainId: 8453, morpho: undefined }, altered, history);
    assert.equal(row.ok, false);
    assert.equal(row.error, error);
    assert.equal(row.measurements.marketBound, false);
    assert.equal(row.actionable, false);
    checkMarketTargets(morpho);
  }
  const wrongBaseMarket = await evaluateSentinel({ ...spec, chainId: 8453, morpho: undefined,
    marketId: "0x" + "ab".repeat(32) }, local, history);
  assert.equal(wrongBaseMarket.error, "market-id-mismatch");
  assert.equal(wrongBaseMarket.measurements.marketBound, false);
  checkMarketTargets(morpho);

  for (const [raw, error] of [
    ["0x", "market-params-unreadable"],
    [marketIf.encodeFunctionResult("idToMarketParams",
      [[loanToken, collateralToken, morpho, morpho, marketParams[4]]]), "oracle-mismatch"],
  ]) {
    const altered = { ...local, call: (to, data) => data.startsWith(marketIf.getFunction("idToMarketParams").selector)
      ? (observed.push(to), Promise.resolve(raw)) : local.call(to, data) };
    const row = await evaluateSentinel({ ...spec, chainId: 999, morpho: undefined }, altered, history);
    assert.equal(row.ok, false);
    assert.equal(row.error, error);
    assert.equal(row.measurements.marketBound, false);
    assert.equal(row.actionable, false);
    checkMarketTargets(hyperMorpho);
  }
});

test("constant-price liquidity requires exact market binding and readable state", async () => {
  const confirmed = { ...spec, kind: "constant-oracle", provenanceConstant: true };
  for (const missing of ["0x", "0x1234"]) {
    const noParams = { ...ctx, call: (to, data) => data.startsWith(marketIf.getFunction("idToMarketParams").selector)
      ? Promise.resolve(missing) : ctx.call(to, data) };
    const row = await evaluateSentinel(confirmed, noParams, history);
    assert.equal(row.borrowRaw, "100");
    assert.equal(row.availableRaw, "900");
    assert.equal(row.measurements.marketBound, false);
    assert.equal(row.actionable, false);
    assert.equal(row.fired, false);
    assert.equal(row.ok, false);
  }
  const wrong = { ...ctx, call: (to, data) => data.startsWith(marketIf.getFunction("idToMarketParams").selector)
    ? Promise.resolve(marketIf.encodeFunctionResult("idToMarketParams",
      [[loanToken, collateralToken, morpho, morpho, marketParams[4]]])) : ctx.call(to, data) };
  const mismatched = await evaluateSentinel(confirmed, wrong, history);
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.error, "oracle-mismatch");
  assert.equal(mismatched.actionable, false);
  const wrongId = await evaluateSentinel({ ...confirmed, marketId: "0x" + "ab".repeat(32) }, ctx, history);
  assert.equal(wrongId.error, "market-id-mismatch");
  assert.equal(wrongId.actionable, false);
  const noState = { ...ctx, call: (to, data) => data.startsWith(marketIf.getFunction("market").selector)
    ? Promise.resolve("0x") : ctx.call(to, data) };
  const unreadableState = await evaluateSentinel(confirmed, noState, history);
  assert.equal(unreadableState.measurements.marketBound, true);
  assert.equal(unreadableState.measurements.marketStateReadable, false);
  assert.equal(unreadableState.actionable, false);
  assert.equal(unreadableState.ok, false);
  const noLiquidity = { ...ctx, call: (to, data) => data.startsWith(marketIf.getFunction("market").selector)
    ? Promise.resolve(marketIf.encodeFunctionResult("market", [100n, 100n, 100n, 100n, 0n, 0n])) : ctx.call(to, data) };
  const paxg = await evaluateSentinel({ ...confirmed, pair: "PAXG/USDC" }, noLiquidity, history);
  assert.equal(paxg.measurements.marketBound, true);
  assert.equal(paxg.availableRaw, "0");
  assert.equal(paxg.actionable, false);
  assert.equal(paxg.fired, false);
});

test("divergence and identical-price streaks require recent, increasing per-chain pins", async () => {
  const markets = { ...ctx, refCache: new Map([
    [collateralToken.toLowerCase(), { price: 2, source: "synthetic-collateral" }],
    [loanToken.toLowerCase(), { price: 1, source: "synthetic-loan" }],
  ]) };
  const dynamic = { ...spec, coll: { address: collateralToken, decimals: 18, symbol: "ETH" },
    loan: { address: loanToken, decimals: 18, symbol: "USDC" } };
  const previous = { ...history, consecutiveOver: { [key]: 1 } };
  for (const partial of [
    { lastAt: new Date(nowMs - 16 * 60_000).toISOString() },
    { previousChains: { "1": 100 } },
    { previousChains: { "1": 101 } },
    { lastAt: "not-a-timestamp" },
  ]) {
    const carry = { ...previous, ...partial };
    assert.equal(continuousRun(carry, 1), false);
    const row = await evaluateSentinel(dynamic, markets, carry);
    assert.equal(row.ok, true);
    assert.equal(row.consecutiveOver, 1);
    assert.equal(row.sustained, false);
    assert.equal(row.fired, false);
    assert.equal(row.measurements.priceStreak, 1);
    assert.equal(row.constantAcrossRuns, false);
  }
  assert.equal(continuousRun(previous, 1), true);
  assert.equal(continuousRun({ ...previous, lastAt: new Date(nowMs - 15 * 60_000).toISOString() }, 1), true);
  assert.equal(continuousRun({ ...previous, lastAt: new Date(nowMs - 15 * 60_000 - 1).toISOString() }, 1), false);
  const sustained = await evaluateSentinel(dynamic, markets, previous);
  assert.equal(sustained.ok, true);
  assert.equal(sustained.consecutiveOver, 2);
  assert.equal(sustained.sustained, true);
  assert.equal(sustained.fired, true);
  assert.equal(sustained.constantAcrossRuns, true);
  const quiet = await evaluateSentinel(dynamic, { ...markets, refCache: new Map([
    [collateralToken.toLowerCase(), { price: 1, source: "synthetic-collateral" }],
    [loanToken.toLowerCase(), { price: 1, source: "synthetic-loan" }],
  ]) }, previous);
  assert.equal(quiet.ok, true);
  assert.equal(quiet.fired, false);
  assert.equal(quiet.consecutiveOver, 0);
  assert.equal(quiet.reason.startsWith("dormant:"), true);
  const last = { at: previous.lastAt, chains: previous.previousChains, prices: previous.prices,
    consecutiveOver: previous.consecutiveOver, priceStreak: previous.priceStreak,
    priceFirstSeen: previous.priceFirstSeen };
  assert.equal(continuousRun({ ...historyCarry({ runs: [last] }), nowMs, chainBlocks: { "1": 100 } }, 1), true);
});

test("invalid or stale chain headers leave every row unavailable and unable to fire", async () => {
  const at = Math.floor(nowMs / 1000);
  const base = { number: "0x64", hash: "0x" + "ab".repeat(32), timestamp: "0x" + at.toString(16) };
  const constant = { ...spec, kind: "constant-oracle", provenanceConstant: true };
  for (const bad of [null, { ...base, number: "0x63" }, { ...base, hash: "0x1" },
    { ...base, timestamp: "0x" + (at - 301).toString(16) },
    { ...base, timestamp: "0x" + (at + 31).toString(16) }]) {
    const result = await qualifyDivergenceChain(1, { nowSec: at,
      resolveRpc: async () => "synthetic-transport",
      rpcCall: async (_url, method) => method === "eth_blockNumber" ? "0x64" : bad });
    assert.equal(result.chain.qualified, false);
    assert.equal(result.ctx, null);
    const rows = await evaluateChainSentinels(1, [constant, { ...spec, oracle: morpho }], result.ctx, history);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.ok === false && row.fired === false && row.actionable === false));
    assert.ok(rows.every((row) => row.scaleSuspect === false && row.oracleRatio === null && row.referenceRatio === null));
  }
  const accepted = await qualifyDivergenceChain(1, { nowSec: at,
    resolveRpc: async () => "synthetic-transport",
    rpcCall: async (_url, method) => method === "eth_blockNumber" ? "0x64" : base });
  assert.equal(accepted.chain.qualified, true);
  assert.equal(accepted.chain.block, 100);
});

test("pinned market tokens/decimals and reference fail closed; historical constant is never actionable", async () => {
  const good = await evaluateSentinel(pinnedSpec, pinnedCtx(), history);
  assert.equal(good.ok, true);
  assert.equal(good.referenceOk, true);
  assert.equal(good.actionable, false);
  assert.equal(good.feedless, false);
  assert.equal(good.consecutiveOver, 1);
  assert.equal(good.fired, false);
  assert.equal(good.noRouteProof, true);
  for (const [variant, error] of [
    [{ loanToken: oracle }, "historical-token-mismatch"],
    [{ marketId: "0x" + "ab".repeat(32) }, "market-id-mismatch"],
  ]) {
    const bad = await evaluateSentinel({ ...pinnedSpec, ...variant }, pinnedCtx(), history);
    assert.equal(bad.error, error);
    assert.equal(bad.ok, false);
    assert.equal(bad.fired, false);
    assert.equal(bad.sustained, false);
  }
  for (const value of ["0x", decimalsIf.encodeFunctionResult("decimals", [255])]) {
    const bad = await evaluateSentinel(pinnedSpec,
      pinnedCtx((to, data) => to.toLowerCase() === loanToken.toLowerCase() &&
        data.startsWith(decimalsIf.getFunction("decimals").selector) ? value : undefined), history);
    assert.equal(bad.error, "token-decimals-unreadable");
    assert.equal(bad.fired, false);
  }
  const missingRef = pinnedCtx();
  missingRef.refCache.set(collateralToken.toLowerCase(), null);
  const noReference = await evaluateSentinel(pinnedSpec, missingRef, history);
  assert.equal(noReference.ok, true);
  assert.equal(noReference.referenceOk, false);
  assert.equal(noReference.structuralVerified, true);
  assert.equal(noReference.structuralCandidate, true);
  assert.match(noReference.reason, /structural-only\/reference-unavailable/);
  assert.equal(noReference.fired, false);
  const unsupported = await evaluateSentinel({ ...pinnedSpec, chainId: 42161 }, pinnedCtx(), history);
  assert.equal(unsupported.error, "morpho-deployment-unverified");
});

test("two continuous pinned reference observations sustain FIRE without route authority", async () => {
  const first = await evaluateSentinel(pinnedSpec, pinnedCtx(), history);
  const pinnedHistory = { ...history, consecutiveOver: { [key]: first.consecutiveOver } };
  const second = await evaluateSentinel(pinnedSpec, pinnedCtx(), pinnedHistory);
  assert.equal(second.consecutiveOver, 2);
  assert.equal(second.sustained, true);
  assert.equal(second.fired, true);
  assert.equal(second.actionable, false);
  assert.equal(second.noRouteProof, true);
});

test("nested quote provenance rejects watched oracle at any depth or unknown provenance", async () => {
  const pool = "0x" + "b1".repeat(20);
  const weth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const usdt = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const dexIf = new ethers.Interface([
    "function getPool(address,address,uint24) view returns (address)",
    "function token0() view returns (address)", "function token1() view returns (address)",
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  const nested = (quoteSources) => {
    const local = pinnedCtx();
    local.refCache.delete(collateralToken.toLowerCase());
    local.refCache.set(usdc.toLowerCase(), null);
    local.refCache.set(usdt.toLowerCase(), null);
    local.refCache.set(weth.toLowerCase(), { price: 2000, source: "nested-quote", sourceAddresses: quoteSources });
    const original = local.call;
    local.call = (to, data) => {
      if (data.startsWith(dexIf.getFunction("getPool").selector)) {
        const args = dexIf.decodeFunctionData("getPool", data);
        return dexIf.encodeFunctionResult("getPool", [args[1].toLowerCase() === weth.toLowerCase()
          ? pool : ethers.ZeroAddress]);
      }
      if (to.toLowerCase() === pool.toLowerCase()) {
        if (data.startsWith(dexIf.getFunction("token0").selector))
          return dexIf.encodeFunctionResult("token0", [collateralToken]);
        if (data.startsWith(dexIf.getFunction("token1").selector))
          return dexIf.encodeFunctionResult("token1", [weth]);
        if (data.startsWith(dexIf.getFunction("slot0").selector))
          return dexIf.encodeFunctionResult("slot0", [2n ** 96n, 0, 0, 0, 0, 0, true]);
      }
      if (to.toLowerCase() === weth.toLowerCase() && data.startsWith(dexIf.getFunction("balanceOf").selector))
        return dexIf.encodeFunctionResult("balanceOf", [100n * 10n ** 18n]);
      return original(to, data);
    };
    return local;
  };
  const circular = await evaluateSentinel(pinnedSpec, nested([oracle.toLowerCase()]), history);
  assert.equal(circular.referenceOk, false);
  assert.equal(circular.ok, true);
  assert.equal(circular.fired, false);
  const unknown = await evaluateSentinel(pinnedSpec, nested(null), history);
  assert.equal(unknown.referenceOk, false);
  assert.equal(unknown.ok, true);
  const independent = await evaluateSentinel(pinnedSpec, nested(["0x" + "a3".repeat(20)]), history);
  assert.equal(independent.referenceOk, true);
  assert.equal(independent.ok, true);
  assert.equal(independent.fired, false); // first run only
});

test("forged prior structural zero never fires; only independently referenced divergence can FIRE", async () => {
  const noReference = () => {
    const local = pinnedCtx();
    local.refCache.set(collateralToken.toLowerCase(), null);
    return local;
  };
  const zeroCtx = noReference();
  const original = zeroCtx.call;
  zeroCtx.call = (to, data) => data.startsWith(marketIf.getFunction("market").selector)
    ? marketIf.encodeFunctionResult("market", [100n, 100n, 100n, 100n, 0n, 0n]) : original(to, data);
  const zero = await evaluateSentinel(pinnedSpec, zeroCtx, history);
  assert.equal(zero.structuralVerified, true);
  assert.equal(zero.borrowsPositive, true);
  assert.equal(zero.availableRaw, "0");
  assert.equal(zero.fired, false);
  const structuralKey = `${key}:${marketId.toLowerCase()}`;
  const prior = { ...history, structuralZero: { [structuralKey]: true } };
  const candidate = await evaluateSentinel(pinnedSpec, noReference(), prior);
  assert.equal(candidate.ok, true);
  assert.equal(candidate.structuralCandidate, true);
  assert.equal(candidate.fired, false);
  assert.equal(candidate.signalType, undefined);
  assert.equal(candidate.referenceOk, false);
  assert.equal(candidate.sustained, false);
  assert.equal(candidate.consecutiveOver, 0);
  assert.equal(candidate.actionable, false);
  assert.equal(candidate.noRouteProof, true);
  assert.match(candidate.reason, /structural-only\/reference-unavailable/);
  assert.doesNotMatch(candidate.reason, /edge/);
  for (const override of [
    { lastAt: new Date(nowMs - 16 * 60_000).toISOString() },
    { previousChains: { "1": 100 } },
    { previousChains: { "1": 101 } },
    { structuralZero: {} },
  ]) {
    const row = await evaluateSentinel(pinnedSpec, noReference(), { ...prior, ...override });
    assert.equal(row.structuralCandidate, true);
    assert.equal(row.fired, false);
    assert.equal(row.signalType, undefined);
  }
  const noEvidence = await evaluateSentinel({ ...pinnedSpec, provenanceConstant: false }, noReference(), prior);
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.structuralVerified, false);
  assert.equal(noEvidence.fired, false);
  const referenced = await evaluateSentinel(pinnedSpec, pinnedCtx(), { ...prior, consecutiveOver: {} });
  assert.equal(referenced.referenceOk, true);
  assert.equal(referenced.structuralCandidate, true);
  assert.equal(referenced.fired, false); // a forged zero is irrelevant to reference divergence
  assert.equal(referenced.consecutiveOver, 1);
  const divergence = await evaluateSentinel(pinnedSpec, pinnedCtx(), {
    ...prior, consecutiveOver: { [key]: 1 },
  });
  assert.equal(divergence.referenceOk, true);
  assert.equal(divergence.fired, true);
  assert.equal(divergence.sustained, true);
  assert.equal(divergence.signalType, undefined);
  assert.match(divergence.reason, /divergence/);
  const previous = { pinnedUniverseSha256: "a".repeat(64), sourceConstantSha256: "b".repeat(64),
    at: history.lastAt, chains: history.previousChains, structuralZero: prior.structuralZero };
  for (const digest of ["c".repeat(64), undefined]) {
    assert.equal(pinnedHistoryCarry({ runs: [previous] }, "a".repeat(64), digest).structuralZero, undefined);
  }
  assert.equal(pinnedHistoryCarry({ runs: [previous] }, "a".repeat(64), "b".repeat(64)).structuralZero,
    undefined);
});
