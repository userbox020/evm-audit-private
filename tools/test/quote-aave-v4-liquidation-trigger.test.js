"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("../node_modules/ethers");
const context = require("../lib/aave-v4-quote-context");
const topology = require("../scan-aave-v4-hubs");
const borrower = require("../scan-aave-v4-spoke-borrowers");
const watcher = require("../watch-aave-v4-liquidation-triggers");
const { openPinnedCollection, CollectionError } = require("../lib/aave-v4-pinned-collection");
const { REVIEWED_OPERATOR_FAMILY_IDS } = require("../lib/common-finalized-rpc-preflight");

// Never delegate to the real fetch implementation: optional subgraph discovery
// receives an empty offline result, while every EVM read uses the stub below.
const originalFetch = globalThis.fetch;
let interceptedFetchCalls = 0;
globalThis.fetch = async (_url, options) => {
  interceptedFetchCalls += 1;
  assert.ok(options.signal, "all discovery must have a bounded abort signal");
  return { ok: true, body: [Buffer.from(JSON.stringify({ data: { pools: [] } }))] };
};
test.after(() => { globalThis.fetch = originalFetch; });

// Pin only public, non-sensitive test settings while loading module constants.
const settingNames = ["AAVE_V4_LIQUIDATION_SIZE_FRACTIONS", "AAVE_V4_MIN_NET_PROFIT_USD", "AAVE_V4_LIQUIDATION_SLIPPAGE_BPS"];
const settings = settingNames.map(name => process.env[name]);
for (const name of settingNames) delete process.env[name];
let engine;
try { engine = require("../quote-aave-v4-liquidation-trigger"); }
finally {
  settingNames.forEach((name, index) => {
    if (settings[index] === undefined) delete process.env[name];
    else process.env[name] = settings[index];
  });
}
const fetchCallsOnImport = interceptedFetchCalls;

const registry = topology.loadAaveV4EthereumRegistry();
const HUB_A = registry.hubs[0].address.toLowerCase();
const HUB_B = registry.hubs[1].address.toLowerCase();
const COLLATERAL = "0x0000000000000000000000000000000000000101";
const DEBT = "0x0000000000000000000000000000000000000102";
const SPOKE = "0x0000000000000000000000000000000000000301";
const USER = "0x0000000000000000000000000000000000000401";
const ORACLE = "0x0000000000000000000000000000000000000501";
const SOURCE = "0x0000000000000000000000000000000000000502";
const MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const NOW = Date.parse("2026-10-18T06:00:00Z");
const word = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const PIN_SECONDS = NOW / 1000 - 60;
const PIN = { schema: "aave-v4-state-pin/v1", chainId: 1, blockNumber: 100, blockHash: word(100), stateRoot: word(900), finality: "finalized", terminalBlockNumber: 100, terminalBlockHash: word(100) };
const liveSessions = new Set();
test.afterEach(async () => {
  for (const session of liveSessions) if (!session.closed) await session.finalize();
  liveSessions.clear();
});
const MC_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";
const QUOTER_ADDRESS = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
const CURVE_POOL = "0x0000000000000000000000000000000000000601";
const BALANCER_POOL = "0x0000000000000000000000000000000000000602";
const BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const CURVE = new ethers.Interface(["function coins(uint256) view returns(address)",
  "function get_dy(int128,int128,uint256) view returns(uint256)", "function get_dy(uint256,uint256,uint256) view returns(uint256)"]);
const VAULT = new ethers.Interface(["function queryBatchSwap(uint8,(bytes32,uint256,uint256,uint256,bytes)[],address[],(address,bool,address,bool)) returns(int256[])"]);
const ERC4626 = new ethers.Interface(["function asset() view returns(address)", "function previewRedeem(uint256) view returns(uint256)", "function convertToAssets(uint256) view returns(uint256)"]);
const HUB = new ethers.Interface([
  "function previewAddByAssets(uint256 assetId,uint256 assets) view returns (uint256)",
  "function previewRemoveByShares(uint256 assetId,uint256 shares) view returns (uint256)",
]);
const MC = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
]);
const QUOTER = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const directPath = `${COLLATERAL}000064${DEBT.slice(2)}`;

async function fixture(options = {}) {
  const target = options.target ?? 1.04;
  const collateralUsd = options.collateralUsd ?? 200000;
  const liquidationConfig = { targetHealthFactor: target };
  const hubs = { hubs: [
    { name: "Hub A", address: HUB_A, assets: [{
      assetId: 0, symbol: "DEBT", underlying: DEBT, decimals: 6, priceUsd: 1,
      spokeDirectory: { rows: [{ address: SPOKE, reserve: { reserveId: 3, liquidationConfig } }] },
    }] },
    { name: "Hub B", address: HUB_B, assets: [{
      assetId: 0, symbol: "COLLATERAL", underlying: COLLATERAL, decimals: 6, priceUsd: 1,
      spokeDirectory: { rows: [{ address: SPOKE, reserve: { reserveId: 9, liquidationConfig } }] },
    }] },
  ] };
  const reserve = {
    reserveId: 9, assetId: 0, symbol: "COLLATERAL", suppliedRaw: String(collateralUsd * 1000000),
    suppliedUsd: collateralUsd, debtUsd: 0, usingAsCollateral: true,
    liquidationBonusBps: 11000,
    dynamicConfig: { collateralFactorBps: options.collateralFactor ?? 8000,
      maxLiquidationBonusBps: 11000, ...(options.missingFee ? {} : { liquidationFeeBps: options.fee ?? 1000 }) },
  };
  const detail = {
    spoke: { hub: "Hub A", spoke: SPOKE }, // Deliberately not the collateral's Hub.
      user: { user: USER, spoke: SPOKE, account: { healthFactor: options.health ?? 0.99, healthFactorRaw: ethers.parseUnits(String(options.health ?? 0.99), 18).toString() }, reserves: [
      { reserveId: 3, assetId: 0, symbol: "DEBT", debtRaw: "100000000000", suppliedRaw: "0", debtUsd: 100000,
        suppliedUsd: 0, usingAsCollateral: false, dynamicConfig: { collateralFactorBps: 0, liquidationFeeBps: 0 } },
      reserve,
    ] },
  };
  reserve.debtRaw = "0";
  for (const hub of hubs.hubs) {
    hub.assetCountReadOk = true; hub.assetCount = hub.assets.length; hub.assetScanTruncated = false;
    for (const asset of hub.assets) {
      asset.status = "ok";
      asset.spokeDirectory.count = 1; asset.spokeDirectory.truncated = false; asset.spokeDirectory.error = null;
      const row = asset.spokeDirectory.rows[0];
      row.listed = true; row.listedError = null; row.config = { error: null };
      Object.assign(row.reserve, { reserveIdError: null, errors: {},
        reserve: { hub: hub.address, assetId: String(asset.assetId), underlying: asset.underlying, decimals: asset.decimals },
        oracleData: { spoke: SPOKE, address: ORACLE, source: SOURCE, decimals: 8, priceRaw: "100000000", errors: {} } });
    }
  }
  for (const registered of registry.hubs.slice(2)) hubs.hubs.push({ address: registered.address, assetCountReadOk: true, assetCount: 0, assetScanTruncated: false, assets: [] });
  const topologyCoverage = topology.buildTopologySourceCoverage(hubs.hubs, registry);
  topologyCoverage.observationPin = { ...PIN, stateReadsPinned: topologyCoverage.stateReadsAttempted };
  hubs.sourceCoverage = topologyCoverage; hubs.generatedAt = new Date(NOW - 1000).toISOString();
  const borrowerCoverage = borrower.buildSourceCoverage({ upstreamCoverage: topologyCoverage, topologyGeneratedAt: hubs.generatedAt,
    chainsExpected: 1, chainsObserved: 1, spokesObserved: 1,
    observedRange: { fromBlock: 10, toBlock: 100 }, historyScope: "DEPLOYMENT_TO_PIN",
    historyStartBound: { block: 10, proven: true, proof: "synthetic fixture" }, fullHistoryProven: true,
    logChunksAttempted: 1, logChunksSucceeded: 1, logChunksFailed: 0,
    discoveredBorrowers: 1, checkedBorrowers: 1, accountReadsAttempted: 1, accountReadsSucceeded: 1, accountReadsFailed: 0,
    reserveReadsAttempted: 6, reserveReadsSucceeded: 6, reserveReadsFailed: 0,
    truncationLimit: 20, wasTruncated: false, excludedSpokes: [], errors: [], observationPin: { ...PIN, stateReadsPinned: 7 } }, NOW);
  const borrowers = { generatedAt: new Date(NOW - 500).toISOString(), sourceCoverage: borrowerCoverage,
    topUsers: [detail.user], spokes: [{ ...detail.spoke, topUsers: [detail.user] }] };
  const quoteRow = { user: USER, hub: "Hub A", spoke: SPOKE, nearLiquidationPreQuote: options.near === true };
  const watchCoverage = watcher.sourceCoverageForArtifact(borrowers, { nowMs: NOW });
  const watch = { generatedAt: new Date(NOW).toISOString(), sourceCoverage: watchCoverage,
    latest: { generatedAt: new Date(NOW).toISOString(), sourceGeneratedAt: borrowers.generatedAt,
      sourceCoverage: watchCoverage, quoteRequiredRows: options.near ? [] : [quoteRow] } };
  const sources = { hubs, borrowers, watch };
  const chain = { id: 1, blockNumber: PIN.blockNumber, blockHash: PIN.blockHash, stateRoot: PIN.stateRoot, finality: "finalized", timestamp: PIN_SECONDS };
  hubs.chain = { ...chain }; borrowers.chain = { ...chain }; watch.latest.chain = { ...chain };
  const calls = [];
  const quoteInputs = [];
  function quoteResult(data) {
    const [path, amountIn] = QUOTER.decodeFunctionData("quoteExactInput", data);
    quoteInputs.push(amountIn);
    const accepted = options.curveHop ? `${engine.COMMON.WETH.toLowerCase()}000064${DEBT.slice(2)}` : directPath;
    if (options.noExit || path.toLowerCase() !== accepted) return { success: false, returnData: "0x" };
    // A deterministic 1:1 six-decimal collateral -> debt unwind.
    return { success: true, returnData: QUOTER.encodeFunctionResult("quoteExactInput", [amountIn, [], [], 123456n]) };
  }
  const unpinnedMock = { async call(transaction) {
    calls.push(transaction);
    const to = transaction.to.toLowerCase();
    if (to === HUB_B) {
      if (options.noSharePreview) throw new CollectionError("CALL_EXCEPTION");
      const parsed = HUB.parseTransaction(transaction);
      assert.equal(parsed.args[0], 0n, "Hub preview must use asset ID, not Spoke reserve ID");
      if (parsed.name === "previewAddByAssets") {
        // Non-identity conversion with a remainder exercises share-fee ceiling.
        return HUB.encodeFunctionResult(parsed.name, [parsed.args[1] * 2n + 1n]);
      }
      return HUB.encodeFunctionResult(parsed.name, [parsed.args[1] / 2n]);
    }
    if (to === MC_ADDRESS) {
      if (options.expireAtQuote) clock.time += options.expireAtQuote;
      if (options.reorgAtQuote) clock.reorg = true;
      if (options.mcRevert) throw new CollectionError("CALL_EXCEPTION");
      if (options.mcTransport) throw new CollectionError("RPC_TRANSPORT");
      const [entries] = MC.decodeFunctionData("aggregate3", transaction.data);
      assert.ok(entries.length <= 32);
      const results = entries.map(entry => {
        assert.equal(entry.target.toLowerCase(), QUOTER_ADDRESS);
        assert.equal(entry.allowFailure, true);
        return quoteResult(entry.callData);
      });
      return MC.encodeFunctionResult("aggregate3", [results]);
    }
    if (to === CURVE_POOL) {
      const parsed = CURVE.parseTransaction(transaction);
      if (parsed.name === "coins") {
        if (options.curveIdentityUnavailable) throw new CollectionError("CALL_EXCEPTION");
        if (options.curveIdentityTransport) throw new CollectionError("RPC_TRANSPORT");
        if (options.curveIdentityBudget) throw new CollectionError("COLLECTION_BUDGET_EXHAUSTED");
        if (options.curveIdentityMalformed) return "0x";
        const coins = options.curveIdentityMismatch ? [DEBT, COLLATERAL]
          : [COLLATERAL, options.curveHop ? engine.COMMON.WETH : DEBT];
        return CURVE.encodeFunctionResult(parsed.fragment, [coins[Number(parsed.args[0])]]);
      }
      if (options.curveUintDy && parsed.fragment.inputs[0].type === "int128") throw new CollectionError("CALL_EXCEPTION");
      return CURVE.encodeFunctionResult(parsed.fragment, [parsed.args[2] + 200n]);
    }
    if (to === BALANCER_VAULT && options.balancer) {
      const parsed = VAULT.parseTransaction(transaction);
      const amount = parsed.args[1][0][3];
      return VAULT.encodeFunctionResult(parsed.name, [[amount, -(amount + 300n)]]);
    }
    if (to === COLLATERAL && options.redeem) {
      const parsed = ERC4626.parseTransaction(transaction);
      return ERC4626.encodeFunctionResult(parsed.name, [parsed.name === "asset" ? DEBT : parsed.args[0] + 400n]);
    }
    if (to === QUOTER_ADDRESS) {
      const result = quoteResult(transaction.data);
      if (!result.success) throw new CollectionError("CALL_EXCEPTION");
      return result.returnData;
    }
    // Optional ERC4626 discovery must fail closed; no actual network fallback.
    throw new CollectionError("CALL_EXCEPTION");
  } };
  const clock = { time: NOW, reorg: false, transport: false, budget: false, opened: 0 };
  const rpcCalls = [];
  const header = () => ({ number: "0x64", hash: clock.reorg ? word(101) : PIN.blockHash, parentHash: word(99), stateRoot: PIN.stateRoot, timestamp: `0x${PIN_SECONDS.toString(16)}` });
  const rpc = async (_handle, method, params) => {
    rpcCalls.push({ method, params });
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return header();
    if (method === "eth_getLogs") { assert.equal(params[0].blockHash, PIN.blockHash); return []; }
    assert.deepEqual(params.at(-1), { blockHash: PIN.blockHash, requireCanonical: true }, "ALL state must use EIP1898 at source pin");
    if (clock.transport) throw new CollectionError("RPC_TRANSPORT");
    if (clock.budget) throw new CollectionError("COLLECTION_BUDGET_EXHAUSTED");
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getStorageAt") return options.proxy && params[0].toLowerCase() === ORACLE ? `0x${"0".repeat(24)}${SOURCE.slice(2)}` : word(0);
    assert.equal(method, "eth_call");
    const tx = params[0], to = tx.to.toLowerCase();
    if (tx.data === ethers.id("getAssetCount()").slice(0, 10)) return word(1);
    if (to === SPOKE) {
      const parsed = context.I.spoke.parseTransaction(tx), id = parsed.args.length ? Number(parsed.args[0]) : null;
      const isCollateral = id === 9;
      const encoded = values => context.I.spoke.encodeFunctionResult(parsed.name, values);
      if (parsed.name === "ORACLE") return encoded([ORACLE]);
      if (parsed.name === "getReserve") return encoded([isCollateral ? COLLATERAL : DEBT,
        options.identityMismatch ? HUB_A : isCollateral ? HUB_B : HUB_A, 0, 6, 0, 0, 99]);
      if (parsed.name === "getUserPosition") return encoded([[0, 0, 0, 0, 7]]);
      if (parsed.name === "getDynamicReserveConfig") {
        assert.equal(parsed.args[1], 7n, "must use USER key, not current key 99");
        if (options.missingFee) throw new CollectionError("CALL_EXCEPTION");
        return encoded([isCollateral ? options.collateralFactor ?? 8000 : 0, 11000, isCollateral ? options.fee ?? 1000 : 0]);
      }
      if (parsed.name === "getReserveConfig") return encoded([0, false, false, true, true]);
      if (parsed.name === "getLiquidationConfig") return encoded([ethers.parseUnits(String(target), 18), ethers.parseUnits("0.95", 18), 0]);
      if (parsed.name === "getLiquidationBonus") return encoded([11000]);
    }
    if (to === ORACLE) {
      const parsed = context.I.oracle.parseTransaction(tx);
      return context.I.oracle.encodeFunctionResult(parsed.name, parsed.name === "spoke" ? [SPOKE]
        : parsed.name === "decimals" ? [8] : parsed.name === "getReserveSource" ? [SOURCE] : [options.oraclePrice ?? 100000000]);
    }
    if (to === context.ETH_FEED) {
      const parsed = context.I.feed.parseTransaction(tx);
      return context.I.feed.encodeFunctionResult(parsed.name, parsed.name === "decimals" ? [8]
        : options.ethRound || [1, 250000000000n, PIN_SECONDS - 60, PIN_SECONDS - 30, 1]);
    }
    if (to === DEBT && tx.data.startsWith(context.I.token.getFunction("balanceOf").selector)) {
      assert.equal(context.I.token.decodeFunctionData("balanceOf", tx.data)[0].toLowerCase(), MORPHO);
      return context.I.token.encodeFunctionResult("balanceOf", [options.fundingBalance ?? 1000000000000n]);
    }
    return unpinnedMock.call(tx);
  };
  const openCollection = async supplied => {
    clock.opened += 1;
    const raw = await openPinnedCollection({ ...supplied,
      candidates: [0, 1].map(i => ({ handle: `offline-${i}`, operatorFamily: REVIEWED_OPERATOR_FAMILY_IDS[i] })), rpc });
    return raw;
  };
  const fundingEvidence = options.noFunding ? null : { address: MORPHO, runtimeKeccak256: ethers.keccak256("0x6000") };
  const runOptions = { sources, now: () => clock.time, openCollection, fundingEvidence,
    curvePools: [], includeNear: options.near, gasProjection: { chainId: 1, method: "eth_gasPrice", priceWei: "1000000000", observedAt: new Date(NOW).toISOString() } };
  assert.deepEqual(context.validateSources(sources, NOW).failures, [], "fixture must be genuinely COMPLETE");
  return { hubs, sources, reserve, detail, quoteRow, calls, quoteInputs, runOptions, clock, rpcCalls };
}

async function rowsFor(options = {}) {
  const f = await fixture(options);
  const session = await context.begin(f.sources, f.runOptions); liveSessions.add(session);
  const hydrated = await session.prepareUser(f.detail, f.quoteRow);
  const rows = await engine.quotePair(session.provider, [], { valid: true, gasUsd: 5 }, f.quoteRow, hydrated.detail, hydrated.assetIndex);
  return { ...f, session, provider: session.provider, assetIndex: hydrated.assetIndex, detail: hydrated.detail, rows };
}

test("import is inert and COMMON contains the three requested stablecoin bindings", () => {
  assert.equal(fetchCallsOnImport, 0);
  assert.equal(engine.COMMON.USDe, "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3");
  assert.equal(engine.COMMON.sUSDe, "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497");
  assert.equal(engine.COMMON.USDG, "0xe343167631d89B6Ffc58B88d6b7fB0228795491D");
});

test("candidatePaths bounds direct fees and distinct COMMON intermediaries before dispatch", () => {
  const paths = engine.candidatePaths(engine.COMMON.USDe, engine.COMMON.USDC);
  const direct = paths.filter(path => path.tokens.length === 2);
  assert.deepEqual(direct.map(path => path.fees[0]), [100, 500, 3000, 10000]);
  assert.equal(paths.length, context.LIMITS.paths);
  assert.ok(new Set(paths.filter(path => path.tokens.length === 3).map(path => path.tokens[1])).size <= context.LIMITS.mids);
  for (const path of paths) {
    assert.equal(path.tokens[0], engine.COMMON.USDe);
    assert.equal(path.tokens.at(-1), engine.COMMON.USDC);
    assert.equal(path.tokens.length, path.fees.length + 1);
    assert.equal(new Set(path.tokens.map(token => token.toLowerCase())).size, path.tokens.length);
  }
});

test("pinned spoke/reserve identity wins cross-Hub collisions and uses user dynamic key", async () => {
  const f = await rowsFor();
  const meta = engine.tokenMeta(f.assetIndex, "Hub A", f.reserve, SPOKE);
  assert.equal(meta.address, COLLATERAL);
  assert.equal(meta.hubAddress, HUB_B);
  assert.equal(meta.collateralFactorBps, 8000);
  assert.equal(meta.liquidationFeeBps, 1000);
  assert.equal(meta.liquidationConfig.targetHealthFactor, 1.04);
  const zero = await rowsFor({ fee: 0 });
  assert.equal(engine.tokenMeta(zero.assetIndex, "Hub A", zero.reserve, SPOKE).liquidationFeeBps, 0);
  assert.equal(meta.positionDynamicConfigKey, 7);
  assert.equal(meta.currentDynamicConfigKey, 99);
  const missing = await fixture({ missingFee: true });
  const artifact = await engine.runQuotes(missing.runOptions);
  assert.equal(artifact.status, "UNAVAILABLE");
  assert.equal(artifact.rows.length, 0);
  assert.throws(() => engine.tokenMeta(engine.buildAssetIndex(f.hubs), "Hub A", f.reserve, SPOKE), /PINNED_IDENTITY_REQUIRED/);
});

test("near quote computes gross-bonus target fraction and exact fee-on-bonus Hub shares", async () => {
  const f = await rowsFor({ health: 1.001, near: true });
  assert.equal(f.rows.length, 1);
  const row = f.rows[0];
  const expectedFraction = (1.04 - 0.9999) / (1.04 - 1.1 * 0.8);
  assert.ok(Math.abs(row.targetHfCloseFraction - expectedFraction) < 1e-12);
  assert.equal(row.observedHealthFactor, 1.001);
  assert.equal(row.modeledHealthFactor, 0.9999);
  assert.equal(row.targetHealthFactor, 1.04);
  assert.equal(row.repay.amountRaw, 25062500000n);
  assert.equal(row.collateral.grossSeizedRaw, 27568750000n);
  assert.equal(row.collateral.grossSharesRaw, 55137500001n);
  assert.equal(row.collateral.liquidationFeeSharesRaw, 501250001n);
  assert.equal(row.collateral.liquidatorReceivedSharesRaw, 54636250000n);
  assert.equal(row.collateral.liquidatorReceivedRaw, 27318125000n);
  assert.equal(row.collateral.seizedRaw, row.collateral.liquidatorReceivedRaw);
  assert.equal(row.collateral.netBonusBps, 10900);
  assert.equal(row.collateral.exactShareFee, true);
  assert.ok(f.quoteInputs.every(amount => amount === row.collateral.liquidatorReceivedRaw));
  assert.equal(row.netProfitUsd, 2000);
  assert.equal(row.nearLiquidationPreQuote, true);
  assert.equal(row.hypotheticalResearchPositive, false, "positive arithmetic is NOT oracle/funding qualification");
  assert.equal(row.researchPositive, false);
  assert.equal(row.routePositive, false);
  assert.equal(row.executableNow, false);
});

test("actionable HF evaluates the four-size ladder without granting execution", async () => {
  const { rows } = await rowsFor();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.fraction).sort((a, b) => a - b), [0.1, 0.25, 0.5, 1]);
  for (const row of rows) {
    assert.equal(row.modeledHealthFactor, 0.99);
    assert.ok(Math.abs(row.targetHfCloseFraction - 0.3125) < 1e-12);
    assert.equal(row.nearLiquidationPreQuote, false);
    assert.equal(row.collateral.exactShareFee, true);
    assert.ok(row.netProfitUsd > 25);
    assert.equal(row.researchPositive, false);
    assert.equal(row.hypotheticalResearchPositive, false);
    assert.equal(row.routePositive, false);
    assert.equal(row.executableNow, false);
  }
});

test("zero fee preserves the bonus and a full bonus fee never taxes principal", async () => {
  const zero = await rowsFor({ fee: 0, health: 1.001, near: true });
  assert.equal(zero.rows[0].collateral.liquidationFeeSharesRaw, 0n);
  assert.equal(zero.rows[0].collateral.netBonusBps, 11000);
  assert.equal(zero.rows[0].collateral.liquidatorReceivedRaw, zero.rows[0].collateral.grossSeizedRaw);
  const full = await rowsFor({ fee: 10000, health: 1.001, near: true });
  const row = full.rows[0];
  assert.equal(row.collateral.netBonusBps, 10000);
  assert.equal(row.collateral.liquidatorReceivedRaw, row.repay.amountRaw);
  assert.ok(row.netProfitUsd < 0);
  assert.equal(row.hypotheticalResearchPositive, false);
});

test("unavailable required share previews invalidate the current artifact", async () => {
  for (const mode of [{ health: 0.99 }, { health: 1.001, near: true }]) {
    const f = await fixture({ ...mode, noSharePreview: true });
    const artifact = await engine.runQuotes(f.runOptions);
    assert.equal(artifact.status, "UNAVAILABLE");
    assert.deepEqual(artifact.rows, []);
    assert.ok(artifact.failures.includes("REQUIRED_HUB_PREVIEW_UNAVAILABLE"));
  }
});

test("missing exit quotes and healthy users without opt-in cannot produce positives", async () => {
  const missing = await rowsFor({ noExit: true, near: true, health: 1.001 });
  assert.equal(missing.rows.length, 1);
  assert.equal(missing.rows[0].quote, null);
  assert.equal(missing.rows[0].netProfitUsd, null, "no route is unavailable economics, not zero profit");
  assert.equal(missing.rows[0].hypotheticalResearchPositive, false);
  const healthy = await rowsFor({ health: 1.001 });
  assert.deepEqual(healthy.rows, []);
  assert.equal(healthy.calls.length, 0);
});

test("invalid fee/config fails closed before economic quote reads", async () => {
  for (const options of [{ fee: 10001 }, { fee: -1 }, { missingFee: true }]) {
    const f = await fixture(options);
    const result = await engine.runQuotes(f.runOptions);
    assert.equal(result.status, "UNAVAILABLE");
    assert.deepEqual(result.rows, []);
    assert.equal(f.calls.length, 0);
  }
  const zeroCf = await rowsFor({ collateralFactor: 0 });
  assert.deepEqual(zeroCf.rows, []);
});

test("target fraction is capped at full debt and repayment respects collateral capacity", async () => {
  const full = await rowsFor({ health: 0.3 });
  const largest = full.rows.find(row => row.fraction === 1);
  assert.equal(largest.targetHfCloseFraction, 1);
  assert.equal(largest.repay.amountRaw, 100000000000n);
  const limited = await rowsFor({ health: 1.001, near: true, collateralUsd: 11000 });
  assert.equal(limited.rows[0].repay.amountRaw, 10000000000n);
  assert.equal(limited.rows[0].collateral.grossSeizedRaw, 11000000000n);
});

function closedGates(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["routePositive", "executableNow", "signedActionJustified", "researchPositive", "hypotheticalResearchPositive", "currentQualified", "freshnessQualified"].includes(key)) assert.ok(child === false || child === 0, key);
    else closedGates(child);
  }
}

test("complete same-pin run attests every economic/config/funding read and closes gates", async () => {
  const f = await fixture();
  const artifact = await engine.runQuotes(f.runOptions);
  assert.equal(artifact.status, "PINNED_VIEW_UNQUALIFIED");
  assert.equal(artifact.rows.length, 4);
  assert.equal(artifact.capture.terminal, true);
  assert.equal(artifact.pin.timestamp, PIN_SECONDS);
  assert.equal(artifact.observationPin.blockHash, PIN.blockHash);
  assert.equal(artifact.observationPin.stateRoot, PIN.stateRoot);
  assert.equal(artifact.observationPin.stateReadsPinned, artifact.capture.quoteReads.attempted);
  assert.equal(artifact.capture.statistics.stateTransportFailures, 0);
  assert.equal(artifact.rows[0].funding.status, "PASS");
  assert.equal(artifact.rows[0].funding.semantics, "PINNED_BALANCE_COVERAGE_ONLY");
  assert.equal(artifact.gas.projection.method, "eth_gasPrice");
  assert.equal(artifact.gas.measuredGas, false);
  assert.deepEqual(artifact.oracleQualification, { denomination: "UNKNOWN", heartbeat: "UNKNOWN", reviewedRuntime: "UNKNOWN" });
  assert.ok(artifact.capture.runtimes.some(runtime => runtime.address === ORACLE));
  assert.ok(artifact.capture.runtimes.some(runtime => runtime.address === HUB_B));
  assert.ok(artifact.capture.runtimes.every(runtime => runtime.reviewedSourceEquivalence === "UNKNOWN"));
  assert.ok(artifact.capture.quoteReads.attempted > 30);
  assert.equal(f.rpcCalls.some(call => JSON.stringify(call.params).includes('"latest"')), false);
  closedGates(artifact);
});

test("conflicting reference marks/cached USD/config do not affect canonical pin arithmetic", async () => {
  const normal = await fixture({ near: true, health: 1.001 });
  const changed = await fixture({ near: true, health: 1.001 });
  for (const reserve of changed.detail.user.reserves) {
    reserve.oracleData = { referencePriceUsd: 999999, price: 0.0001 };
    reserve.debtUsd = 9e15; reserve.suppliedUsd = 1;
    reserve.dynamicConfig = { collateralFactorBps: 1, liquidationFeeBps: 9999 };
  }
  const a = await engine.runQuotes(normal.runOptions);
  const b = await engine.runQuotes(changed.runOptions);
  assert.equal(b.status, "PINNED_VIEW_UNQUALIFIED");
  assert.equal(a.preQuotes.rows[0].repay.amountRaw, b.preQuotes.rows[0].repay.amountRaw);
  assert.equal(a.preQuotes.rows[0].netProfitUsd, b.preQuotes.rows[0].netProfitUsd);
  assert.equal(b.preQuotes.rows[0].repay.oraclePriceRaw, "100000000");
  assert.equal(b.preQuotes.rows[0].collateral.liquidationFeeBps, 1000);
  assert.deepEqual(b.rows, [], "near quotes never leak into default actionable rows");
  closedGates(b);
});

test("missing/incomplete/malformed/stale captures fail before collector open even with empty triggers", async () => {
  const mutations = [
    x => { x.borrowers = null; },
    x => { x.hubs.sourceCoverage.sampleComplete = false; },
    x => { x.borrowers.sourceCoverage.complete = false; },
    x => { x.borrowers.sourceCoverage.observationPin.blockHash = word(999); },
    x => { delete x.hubs.sourceCoverage.observationPin.stateRoot; },
    x => { x.hubs.sourceCoverage.topologyUniverse.inventoryDigest = "0".repeat(64); },
    x => { x.hubs.generatedAt = new Date(NOW - 600001).toISOString(); },
    x => { x.borrowers.generatedAt = new Date(NOW - 600001).toISOString(); },
    x => { x.watch.generatedAt = new Date(NOW - 600001).toISOString(); },
    x => { x.watch.latest.sourceGeneratedAt = new Date(NOW - 9).toISOString(); },
    x => { x.hubs.hubs[0].assets[0].underlying = COLLATERAL; },
    x => { x.hubs.hubs.pop(); },
    x => { delete x.watch.latest.quoteRequiredRows; },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    const sources = structuredClone(f.sources);
    sources.watch.latest.quoteRequiredRows = [];
    mutate(sources);
    const artifact = await engine.runQuotes({ ...f.runOptions, sources });
    assert.equal(artifact.status, "UNAVAILABLE");
    assert.equal(f.clock.opened, 0, "invalid source must not trigger a broadened reread");
    assert.deepEqual(artifact.rows, []);
    assert.ok(artifact.failures.length);
    closedGates(artifact);
  }
});

test("consumer TTL can tighten but never widen topology ten-minute cap", async () => {
  const f = await fixture();
  assert.equal(context.validateSources(f.sources, NOW + 600000, 3600000).valid, false);
  assert.equal(context.validateSources(f.sources, NOW, 100).valid, false);
  assert.equal(context.validateSources(f.sources, NOW, 3600000).provenance.sourceTtlMs, 600000);
});

test("valid empty trigger list still gets terminal binding, not universal liquidation absence", async () => {
  const f = await fixture(); f.sources.watch.latest.quoteRequiredRows = [];
  const artifact = await engine.runQuotes(f.runOptions);
  assert.equal(artifact.status, "PINNED_VIEW_UNQUALIFIED");
  assert.equal(artifact.capture.terminal, true);
  assert.deepEqual(artifact.rows, []);
  assert.ok(artifact.constraints.some(text => /not universal/.test(text)));
  closedGates(artifact);
});

test("pinned identity mismatch and symbol/name fallback cannot qualify", async () => {
  const f = await fixture({ identityMismatch: true });
  const artifact = await engine.runQuotes(f.runOptions);
  assert.equal(artifact.status, "UNAVAILABLE");
  assert.ok(artifact.failures.includes("PINNED_IDENTITY_MISMATCH"));
  assert.equal(f.calls.length, 0);
  closedGates(artifact);
});

test("expiry during quote execution or terminal publication removes current rows", async () => {
  const f = await fixture({ expireAtQuote: 600001, near: true, health: 1.001 });
  const artifact = await engine.runQuotes(f.runOptions);
  assert.equal(artifact.status, "UNAVAILABLE");
  assert.ok(artifact.failures.includes("TOPOLOGY_STALE_OR_UNDATED"));
  assert.ok(artifact.failures.includes("QUOTE_RUN_DEADLINE"));
  assert.equal(artifact.summary.currentPreQuoteRows, 0);
  closedGates(artifact);
  const duringTerminal = await fixture();
  const open = duringTerminal.runOptions.openCollection;
  const result = await engine.runQuotes({ ...duringTerminal.runOptions, openCollection: async opts => {
    const raw = await open(opts);
    return { ...raw, confirmPin: async () => { const pin = await raw.confirmPin(); duringTerminal.clock.time += 600001; return pin; } };
  } });
  assert.equal(result.status, "UNAVAILABLE");
  assert.ok(result.failures.includes("BORROWER_STALE_OR_UNDATED"));
});

test("reorg at terminal confirmation rejects current economics", async () => {
  const f = await fixture({ reorgAtQuote: true });
  const artifact = await engine.runQuotes(f.runOptions);
  assert.equal(artifact.status, "UNAVAILABLE");
  assert.equal(artifact.capture.terminal, false);
  assert.equal(artifact.observationPin, null);
  assert.ok(artifact.failures.includes("TERMINAL_PIN_CONFIRMATION_FAILED"));
  assert.deepEqual(artifact.rows, []);
});

test("late reads after terminal confirmation cannot reach provider, even cached funding", async () => {
  const f = await rowsFor({ near: true, health: 1.001 });
  await f.session.finalize();
  const before = f.rpcCalls.length;
  await assert.rejects(f.provider.call({ to: DEBT, data: "0x" }), /QUOTE_CONTEXT_CLOSED/);
  await assert.rejects(f.session.funding(DEBT, 1n), /QUOTE_CONTEXT_CLOSED/);
  await assert.rejects(engine.quotePair(f.provider, [], { valid: true, gasUsd: 5 }, f.quoteRow, f.detail, f.assetIndex), /QUOTE_CONTEXT_CLOSED/);
  assert.equal(f.rpcCalls.length, before);
});

test("expected route reverts permit same-pin direct fallback but swallowed transport errors invalidate", async () => {
  const fallback = await fixture({ mcRevert: true });
  const good = await engine.runQuotes(fallback.runOptions);
  assert.equal(good.status, "PINNED_VIEW_UNQUALIFIED");
  assert.ok(good.capture.quoteReads.expectedReverts > 0);
  assert.ok(good.rows.every(row => row.quote?.pathKind === "uniswap-v3-direct"));
  const transport = await fixture({ mcTransport: true });
  const bad = await engine.runQuotes(transport.runOptions);
  assert.equal(bad.status, "UNAVAILABLE");
  assert.ok(bad.failures.includes("PINNED_TRANSPORT_OR_BUDGET_FAILURE"));
  assert.ok(bad.capture.statistics.stateTransportFailures > 0);
  assert.deepEqual(bad.rows, []);
});

test("collector request/time exhaustion remains fatal when quote helpers catch it", async () => {
  for (const mode of ["transport", "budget"]) {
    const f = await fixture();
    const open = f.runOptions.openCollection;
    const artifact = await engine.runQuotes({ ...f.runOptions, openCollection: async opts => {
      const raw = await open(opts);
      f.clock[mode] = true;
      return raw;
    } });
    assert.equal(artifact.status, "UNAVAILABLE");
    assert.ok(artifact.failures.includes("PINNED_TRANSPORT_OR_BUDGET_FAILURE"));
    assert.deepEqual(artifact.rows, []);
  }
  const f = await fixture();
  const session = await context.begin(f.sources, f.runOptions); liveSessions.add(session);
  f.clock.time += context.LIMITS.maxMs;
  await assert.rejects(session.provider.call({ to: DEBT, data: "0x" }), /QUOTE_BUDGET_EXHAUSTED/);
  const result = await session.finalize();
  assert.ok(result.failures.includes("QUOTE_RUN_DEADLINE"));
});

test("missing and insufficient funding are explicit balance-only blockers", async () => {
  for (const options of [{ noFunding: true }, { fundingBalance: 1n }]) {
    const f = await fixture(options);
    const artifact = await engine.runQuotes(f.runOptions);
    assert.equal(artifact.status, "PINNED_VIEW_UNQUALIFIED");
    assert.equal(artifact.rows[0].funding.status, options.noFunding ? "UNKNOWN" : "FAIL");
    assert.equal(artifact.rows[0].funding.executionProof, false);
    assert.ok(artifact.rows[0].blockers.includes("Funding balance coverage missing or insufficient"));
    closedGates(artifact);
  }
});

test("invalid required ETH/USD state discards rows; missing gas retains unpriced observations without fallback", async () => {
  for (const round of [
    [0, 250000000000n, PIN_SECONDS - 60, PIN_SECONDS - 30, 1],
    [1, 0, PIN_SECONDS - 60, PIN_SECONDS - 30, 1],
    [2, 250000000000n, PIN_SECONDS - 60, PIN_SECONDS - 30, 1],
    [1, 250000000000n, 0, PIN_SECONDS - 30, 1],
    [1, 250000000000n, PIN_SECONDS - 60, PIN_SECONDS + 1, 1],
    [1, 250000000000n, PIN_SECONDS - 4000, PIN_SECONDS - 3700, 1],
  ]) {
    const f = await fixture({ ethRound: round });
    const artifact = await engine.runQuotes(f.runOptions);
    assert.equal(artifact.status, "UNAVAILABLE");
    assert.ok(artifact.failures.includes("ETH_USD_ROUND_INVALID_OR_STALE"));
    assert.deepEqual(artifact.rows, []);
  }
  const f = await fixture();
  const artifact = await engine.runQuotes({ ...f.runOptions, gasProjection: undefined });
  assert.equal(artifact.status, "PINNED_VIEW_UNPRICED_UNQUALIFIED");
  assert.equal(artifact.gas.valid, false);
  assert.equal(artifact.gas.gasUsd, null);
  assert.ok(artifact.economics.reasons.includes("CURRENT_ECONOMICS_UNAVAILABLE"));
  assert.deepEqual(artifact.failures, []);
  assert.equal(artifact.rows.length, 4);
  for (const row of artifact.rows) {
    assert.ok(row.quote.amountOutRaw > 0n);
    assert.equal(row.gasUsd, null); assert.equal(row.netProfitUsd, null);
    assert.equal(row.economicsStatus, "UNAVAILABLE");
    assert.ok(!row.blockers.includes("Exact collateral-exit quote is not profitable after gas/slippage"));
  }
  closedGates(artifact);
  assert.equal(context.validGasProjection({ ...f.runOptions.gasProjection, priceWei: "0" }, NOW), false);
  assert.equal(context.validGasProjection(f.runOptions.gasProjection, NOW + 60001), false);
});

test("failed refresh retains original historical preQuotes timestamp/pin and never counts positives", async () => {
  const f = await fixture();
  const previous = { preQuotes: { generatedAt: "2026-10-17T01:00:00.000Z", pin: { number: 1, hash: word(1) },
    rows: [{ netProfitUsd: 123, hypotheticalResearchPositive: true, researchPositive: true, routePositive: true }] } };
  const original = structuredClone(previous);
  const artifact = await engine.runQuotes({ ...f.runOptions, sources: null, previous,
    // explicit invalid fixture, not default on-disk source loading
    ...{ sources: { ...f.sources, hubs: null } } });
  assert.equal(artifact.status, "UNAVAILABLE");
  assert.deepEqual(previous, original);
  assert.equal(artifact.preQuotes.generatedAt, original.preQuotes.generatedAt);
  assert.deepEqual(artifact.preQuotes.pin, original.preQuotes.pin);
  assert.equal(artifact.preQuotes.status, "HISTORICAL_UNVERIFIED");
  assert.equal(artifact.summary.rowsQuoted, 0);
  assert.equal(artifact.summary.currentPreQuoteRows, 0);
  assert.equal(artifact.summary.hypotheticalResearchPositiveRoutes, 0);
  closedGates(artifact);
});

test("all optional Curve/Balancer/ERC4626 views remain at the source hash and never prove redemption cash", async t => {
  for (const kind of ["curve", "balancer", "redeem"]) {
    const f = await fixture({ near: true, health: 1.001, [kind]: true });
    if (kind === "curve") f.runOptions.curvePools = [{ address: CURVE_POOL, source: "offline curve", coins: [
      { address: COLLATERAL, index: 0 }, { address: DEBT, index: 1 }], usdTotal: 1 }];
    if (kind === "balancer") t.mock.method(globalThis, "fetch", async (_url, options) => {
      assert.ok(options.signal);
      return { ok: true, body: [Buffer.from(JSON.stringify({ data: { pools: [{ id: word(1), address: BALANCER_POOL }] } }))] };
    });
    const artifact = await engine.runQuotes(f.runOptions);
    t.mock.restoreAll();
    assert.equal(artifact.status, "PINNED_VIEW_UNQUALIFIED");
    assert.equal(artifact.preQuotes.rows[0].quote.pathKind,
      kind === "curve" ? "curve-direct" : kind === "balancer" ? "balancer-v2-single" : "erc4626-redeem-direct");
    assert.ok(artifact.preQuotes.rows[0].blockers.some(text => /redemption cash/.test(text)));
    closedGates(artifact);
  }
});

test("discovery abort/caps are bounded and invalidate current output, without leaked raw error text", async t => {
  const f = await fixture();
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("secret endpoint detail"));
      signal.addEventListener("abort", () => reject(new Error("secret endpoint detail")), { once: true });
    });
  });
  const artifact = await engine.runQuotes(f.runOptions);
  t.mock.restoreAll();
  assert.equal(artifact.status, "UNAVAILABLE");
  assert.ok(artifact.failures.includes("DISCOVERY_TIMEOUT"));
  assert.doesNotMatch(JSON.stringify(artifact), /secret endpoint detail/);
  const bounded = await fixture();
  const session = await context.begin(bounded.sources, bounded.runOptions); liveSessions.add(session);
  for (let i = 0; i < context.LIMITS.discoveries; i++) await session.discover(async () => ({}));
  await assert.rejects(session.discover(async () => ({})), /DISCOVERY_CAP/);
});

test("candidate/pair/size dispatch bounds are explicit and source time is not quote time", async () => {
  const f = await fixture();
  f.sources.watch.latest.quoteRequiredRows = [f.quoteRow, f.quoteRow, f.quoteRow];
  const artifact = await engine.runQuotes(f.runOptions);
  assert.ok(artifact.summary.rowsQuoted <= context.LIMITS.candidates * context.LIMITS.pairs * context.LIMITS.sizes);
  assert.ok(artifact.capture.truncatedSearch.includes("CANDIDATE_CAP"));
  assert.equal(artifact.sources.borrowers.generatedAt, f.sources.borrowers.generatedAt);
  assert.notEqual(artifact.generatedAt, artifact.sources.borrowers.generatedAt);
  assert.equal(artifact.sources.borrowers.ageMs, 500);
  assert.equal(artifact.pin.ageMs, 60000);
});

test("oracle capture mismatch fails closed; runtime/proxy code hashes never imply source equivalence", async () => {
  const mismatch = await fixture({ oraclePrice: 99999999 });
  const bad = await engine.runQuotes(mismatch.runOptions);
  assert.equal(bad.status, "UNAVAILABLE");
  assert.ok(bad.failures.includes("ORACLE_CAPTURE_BINDING_MISMATCH"));
  const proxy = await fixture({ proxy: true });
  const good = await engine.runQuotes(proxy.runOptions);
  const runtime = good.capture.runtimes.find(row => row.address === ORACLE);
  assert.equal(runtime.implementation, SOURCE);
  assert.equal(runtime.codeHash, ethers.keccak256("0x6000"));
  assert.equal(runtime.implementationCodeHash, ethers.keccak256("0x6000"));
  assert.equal(runtime.reviewedSourceEquivalence, "UNKNOWN");
  closedGates(good);
});

test("source TTL and finalized-header age are distinct and both fail closed", async () => {
  const f = await fixture();
  const sources = structuredClone(f.sources);
  for (const artifact of [sources.hubs, sources.borrowers, sources.watch.latest]) artifact.chain.timestamp -= 1800000 / 1000;
  const result = await engine.runQuotes({ ...f.runOptions, sources });
  assert.equal(result.status, "UNAVAILABLE");
  assert.ok(result.failures.includes("BORROWER_FINALIZED_PIN_STALE"));
  assert.equal(f.clock.opened, 0);
  assert.equal(result.sources.borrowers.ageMs, 500, "recent capture does not repair an old finalized header");
});

test("discovery HTTP/parse failures still abort the response lifetime", async () => {
  const f = await fixture();
  const session = await context.begin(f.sources, f.runOptions); liveSessions.add(session);
  let signal;
  await assert.rejects(session.discover(async observed => {
    signal = observed;
    throw new Error("offline parse failure");
  }), /DISCOVERY_UNAVAILABLE/);
  assert.equal(signal.aborted, true);
});

test("production main reads CLI output argument and fixed input paths without gas injection, retaining unpriced observations", async t => {
  const f = await fixture();
  const root = path.resolve(__dirname, "../..");
  const output = path.join(root, "offline-pinned-observations.json");
  const inputs = new Map([
    ["aave-v4-liquidation-watch.json", f.sources.watch],
    ["aave-v4-spoke-borrowers.json", f.sources.borrowers],
    ["aave-v4-hubs.json", f.sources.hubs],
    ["aave-v4-liquidation-quotes.json", {}],
    ["aave-v4-whale-liquidation-prestage-20261018.json", { funding: f.runOptions.fundingEvidence }],
  ].map(([name, value]) => [path.join(root, "reports/raw/fast", name), JSON.stringify(value)]));
  const files = new Map(inputs), reads = [], writes = [];
  const previousArgv = process.argv;
  process.argv = [process.execPath, path.join(root, "tools/quote-aave-v4-liquidation-trigger.js"), "--output", output];
  try {
    // Exercise real main/loadJson/atomic publication, but all filesystem IO is in
    // memory. Only clock/RPC are injected into main; no sources, gas, venue list,
    // funding override or arbitrary input path is passed programmatically.
    t.mock.method(fs, "existsSync", file => files.has(path.resolve(file)));
    t.mock.method(fs, "readFileSync", file => {
      const key = path.resolve(file); assert.ok(inputs.has(key), "unexpected filesystem read");
      reads.push(key); return files.get(key);
    });
    t.mock.method(fs, "mkdirSync", () => {});
    t.mock.method(fs, "writeFileSync", (file, value) => {
      const key = path.resolve(file); assert.equal(key, `${output}.${process.pid}.tmp`);
      files.set(key, value); writes.push(key);
    });
    t.mock.method(fs, "renameSync", (from, to) => {
      assert.equal(path.resolve(to), output);
      files.set(output, files.get(path.resolve(from))); files.delete(path.resolve(from));
    });
    t.mock.method(fs, "unlinkSync", file => { files.delete(path.resolve(file)); });
    t.mock.method(console, "log", () => {});
    const artifact = await engine.main({ now: f.runOptions.now, openCollection: f.runOptions.openCollection });
    const published = JSON.parse(files.get(output));
    assert.equal(artifact.status, "PINNED_VIEW_UNPRICED_UNQUALIFIED");
    assert.equal(published.status, artifact.status);
    assert.equal(published.rows.length, 4);
    assert.equal(published.capture.terminal, true);
    assert.equal(published.observationPin.blockHash, PIN.blockHash);
    assert.equal(published.economics.status, "UNAVAILABLE");
    assert.equal(published.gas.projection, null); assert.equal(published.gas.gasUsd, null);
    assert.ok(published.rows.every(row => row.quote && row.gasUsd === null && row.netProfitUsd === null));
    assert.equal(writes.length, 1);
    assert.deepEqual(new Set(reads), new Set(inputs.keys()));
    for (const [file, bytes] of inputs) assert.equal(files.get(file), bytes, "fixed inputs and standing output stay unchanged");
    closedGates(published);
  } finally { t.mock.restoreAll(); process.argv = previousArgv; }
});

test("invalid or absent cost projections retain bound observations but never numeric net economics", async () => {
  const f = await fixture({ near: true, health: 1.001 });
  for (const projection of [undefined, null, {}, { ...f.runOptions.gasProjection, chainId: 8453 },
    { ...f.runOptions.gasProjection, priceWei: "0" }, { ...f.runOptions.gasProjection, priceWei: "1" + "0".repeat(400) },
    { ...f.runOptions.gasProjection, observedAt: new Date(NOW - 60001).toISOString() }]) {
    const artifact = await engine.runQuotes({ ...f.runOptions, gasProjection: projection });
    assert.equal(artifact.status, "PINNED_VIEW_UNPRICED_UNQUALIFIED");
    assert.deepEqual(artifact.failures, []);
    assert.equal(artifact.economics.status, "UNAVAILABLE");
    assert.equal(artifact.gas.gasUsd, null);
    assert.equal(artifact.preQuotes.status, artifact.status);
    assert.equal(artifact.preQuotes.rows.length, 1);
    assert.deepEqual(artifact.rows, []);
    for (const row of artifact.preQuotes.rows) { assert.equal(row.gasUsd, null); assert.equal(row.netProfitUsd, null); }
    closedGates(artifact);
  }
  const invalidSources = structuredClone(f.sources);
  invalidSources.borrowers.generatedAt = new Date(NOW - 600001).toISOString();
  const bad = await engine.runQuotes({ ...f.runOptions, sources: invalidSources, gasProjection: undefined });
  assert.equal(bad.status, "UNAVAILABLE");
  assert.deepEqual(bad.rows, []); assert.equal(bad.summary.currentPreQuoteRows, 0);
  assert.equal(bad.preQuotes, undefined);
  assert.ok(bad.failures.includes("BORROWER_STALE_OR_UNDATED"));
});

test("projection expiry at terminal publication nulls prior arithmetic without discarding valid observations", async () => {
  const f = await fixture();
  const open = f.runOptions.openCollection;
  const artifact = await engine.runQuotes({ ...f.runOptions, openCollection: async options => {
    const raw = await open(options);
    return { ...raw, confirmPin: async () => { const pin = await raw.confirmPin(); f.clock.time += 60001; return pin; } };
  } });
  assert.equal(artifact.status, "PINNED_VIEW_UNPRICED_UNQUALIFIED");
  assert.deepEqual(artifact.failures, []);
  assert.ok(artifact.economics.reasons.includes("GAS_PROJECTION_STALE_AT_PUBLICATION"));
  assert.equal(artifact.rows.length, 4); assert.equal(artifact.capture.terminal, true);
  assert.equal(artifact.gas.valid, false); assert.equal(artifact.gas.gasUsd, null);
  assert.ok(artifact.rows.every(row => row.quote && row.gasUsd === null && row.netProfitUsd === null));
  closedGates(artifact);
});

function discoveredCurvePool(tokenOut = DEBT) {
  return { address: CURVE_POOL, source: "offline candidate discovery", coins: [
    { address: COLLATERAL, index: 0 }, { address: tokenOut, index: 1 }], usdTotal: 1000000 };
}

test("Curve promising discovery/get_dy cannot substitute for pinned matching coin identity", async () => {
  for (const options of [{ curveIdentityMismatch: true }, { curveIdentityUnavailable: true }, { curveIdentityMalformed: true }]) {
    const f = await fixture({ ...options, near: true, health: 1.001 });
    const artifact = await engine.runQuotes({ ...f.runOptions, curvePools: [discoveredCurvePool()] });
    assert.equal(artifact.status, "PINNED_VIEW_UNQUALIFIED");
    assert.equal(artifact.preQuotes.rows[0].quote.pathKind, "uniswap-v3-direct", "exclude unbound Curve, not the valid pinned fallback");
    const curveCalls = f.calls.filter(call => call.to.toLowerCase() === CURVE_POOL).map(call => CURVE.parseTransaction(call));
    assert.ok(curveCalls.some(call => call.name === "coins"));
    assert.equal(curveCalls.some(call => call.name === "get_dy"), false, "identity must be bound before valuing output");
    assert.equal(artifact.capture.statistics.stateTransportFailures, 0);
    closedGates(artifact);
  }
  const valid = await fixture({ near: true, health: 1.001, curveUintDy: true });
  const artifact = await engine.runQuotes({ ...valid.runOptions, curvePools: [discoveredCurvePool()] });
  assert.equal(artifact.status, "PINNED_VIEW_UNQUALIFIED");
  const quote = artifact.preQuotes.rows[0].quote;
  assert.equal(quote.pathKind, "curve-direct");
  assert.deepEqual(quote.path.identity, { status: "PINNED_COIN_INDICES", signature: "coins(uint256)", indices: [0, 1], tokens: [COLLATERAL, DEBT] });
  const curveCalls = valid.calls.filter(call => call.to.toLowerCase() === CURVE_POOL).map(call => CURVE.parseTransaction(call));
  assert.deepEqual(curveCalls.slice(0, 2).map(call => call.name), ["coins", "coins"]);
  assert.equal(curveCalls.filter(call => call.name === "get_dy").length, 2, "get_dy ABI fallback is also pinned");
  closedGates(artifact);
});

test("Curve indices are strict, bounded, distinct integers, with no metadata fallback", async () => {
  for (const index of [-1, 0.5, "0", 8, Number.MAX_SAFE_INTEGER]) {
    const f = await fixture({ near: true, health: 1.001 });
    const pool = discoveredCurvePool(); pool.coins[0].index = index;
    const artifact = await engine.runQuotes({ ...f.runOptions, curvePools: [pool] });
    assert.equal(artifact.preQuotes.rows[0].quote.pathKind, "uniswap-v3-direct");
    assert.equal(f.calls.some(call => call.to.toLowerCase() === CURVE_POOL), false);
  }
});

test("Curve identity transport/budget errors poison current observations even when optional route catches them", async () => {
  for (const mode of ["curveIdentityTransport", "curveIdentityBudget"]) {
    const f = await fixture({ [mode]: true });
    const artifact = await engine.runQuotes({ ...f.runOptions, gasProjection: undefined, curvePools: [discoveredCurvePool()] });
    assert.equal(artifact.status, "UNAVAILABLE");
    assert.deepEqual(artifact.rows, []);
    assert.ok(artifact.failures.includes("PINNED_TRANSPORT_OR_BUDGET_FAILURE"));
    assert.ok(artifact.capture.statistics.stateTransportFailures > 0);
    closedGates(artifact);
  }
});

test("Curve hop legs inherit pinned coins identity checks and reject unbound heads", async () => {
  for (const mismatch of [false, true]) {
    const f = await fixture({ near: true, health: 1.001, curveHop: true, curveIdentityMismatch: mismatch });
    const artifact = await engine.runQuotes({ ...f.runOptions, curvePools: [discoveredCurvePool(engine.COMMON.WETH)] });
    assert.equal(artifact.status, "PINNED_VIEW_UNQUALIFIED");
    const quote = artifact.preQuotes.rows[0].quote;
    if (mismatch) assert.equal(quote, null);
    else {
      assert.equal(quote.pathKind, "curve-to-uniswap-v3");
      assert.deepEqual(quote.path.legs[0].identity.tokens, [COLLATERAL, engine.COMMON.WETH.toLowerCase()]);
    }
    const curveCalls = f.calls.filter(call => call.to.toLowerCase() === CURVE_POOL).map(call => CURVE.parseTransaction(call));
    assert.equal(curveCalls.some(call => call.name === "get_dy"), !mismatch);
    closedGates(artifact);
  }
});
