"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { main } = require("../morpho-find-liquidatable");
const blue = require("../scan-morpho-blue-l");
const unwind = require("../morpho-unwind-valuation");
const aave = require("../scan-aave-v3-l");

const MARKET_A = `0x${"11".repeat(32)}`;
const MARKET_B = `0x${"22".repeat(32)}`;
const ORACLE_WORD = `0x${"0".repeat(63)}1`;
const silentConsole = { log() {}, error() {} };

function borrowerTopic(index) {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function borrowLog(index, marketId = MARKET_A) {
  return { topics: ["0xtopic", marketId, borrowerTopic(index)] };
}

function dependencies(logs, overrides = {}) {
  const blockHex = overrides.blockHex || "0x3e8";
  return {
    console: silentConsole,
    resolveRpc: async () => "offline-rpc",
    rpcCall: async (_rpc, method) => {
      if (method === "eth_blockNumber") return blockHex;
      if (method === "eth_getLogs") return logs;
      if (method === "eth_call") return ORACLE_WORD;
      throw new Error(`unexpected method ${method}`);
    },
    getMarketParams: async () => ({
      oracle: "0x0000000000000000000000000000000000000001",
      loanToken: "0x0000000000000000000000000000000000000002",
      collateralToken: "0x0000000000000000000000000000000000000003",
      lltvRaw: "800000000000000000",
      lltv: 0.8,
    }),
    getMarketState: async () => ({ totalBorrowAssets: 1n, totalBorrowShares: 1n }),
    scanBorrower: async (_rpc, _market, borrower) => ({
      readSucceeded: true,
      position: {
        borrower,
        borrowAssetsRaw: "100",
        collateralRaw: "90",
        isLiquidatable: true,
        healthFactor: 0.9,
        valuationStatus: "unavailable",
      },
    }),
    writeArtifact: false,
    setExitCode: false,
    now: "2026-08-25T12:00:00.000Z",
    ...overrides,
  };
}

test("more than 500 Borrow logs is an incomplete bounded sample", async () => {
  const artifact = await main(dependencies(Array.from({ length: 501 }, (_, index) => borrowLog(index + 1))));

  assert.equal(artifact.classification, "BOUNDED_WINDOW_INCOMPLETE");
  assert.equal(artifact.complete, false);
  assert.deepEqual(artifact.coverage.caps, { borrowLogs: 500, borrowersPerMarket: 30 });
  assert.equal(artifact.coverage.borrowLogs.discovered, 501);
  assert.equal(artifact.coverage.borrowLogs.processed, 500);
  assert.equal(artifact.coverage.borrowLogs.omittedByCap, 1);
  assert.equal(artifact.coverage.borrowLogs.wasTruncated, true);
  assert.equal(artifact.coverage.markets.discoveryScope, "processedBorrowLogs");
  assert.equal(artifact.coverage.borrowers.discoveryScope, "processedBorrowLogs");
  assert.equal(artifact.coverage.borrowers.discoveredMarketBorrowerPairs, 500);
  assert.equal(artifact.coverage.borrowers.wasTruncated, true);
  assert.equal(artifact.results.promotionEligible, false);
});

test("more than 30 borrowers leaves discovered positions explicitly unchecked", async () => {
  const artifact = await main(dependencies(Array.from({ length: 31 }, (_, index) => borrowLog(index + 1))));

  assert.equal(artifact.classification, "BOUNDED_WINDOW_INCOMPLETE");
  assert.equal(artifact.complete, false);
  assert.equal(artifact.coverage.borrowLogs.wasTruncated, false);
  assert.equal(artifact.coverage.borrowers.discoveredMarketBorrowerPairs, 31);
  assert.equal(artifact.coverage.borrowers.selectedForCheck, 30);
  assert.equal(artifact.coverage.borrowers.omittedByCap, 1);
  assert.equal(artifact.coverage.borrowers.wasTruncated, true);
  assert.equal(artifact.coverage.positions.successfullyChecked, 30);
  assert.equal(artifact.coverage.positions.unchecked, 1);
  assert.equal(artifact.coverage.positions.uncheckedDueToBorrowerCap, 1);
});

test("failed market and position reads are counted and prevent completion", async () => {
  const logs = [borrowLog(1, MARKET_A), borrowLog(2, MARKET_B)];
  const artifact = await main(dependencies(logs, {
    getMarketParams: async (_rpc, marketId) => marketId === MARKET_B ? null : {
      oracle: "0x0000000000000000000000000000000000000001",
      lltvRaw: "800000000000000000",
      lltv: 0.8,
    },
    scanBorrower: async () => ({ readSucceeded: false, position: null }),
  }));

  assert.equal(artifact.classification, "BOUNDED_WINDOW_INCOMPLETE");
  assert.equal(artifact.complete, false);
  assert.equal(artifact.coverage.markets.discovered, 2);
  assert.equal(artifact.coverage.markets.resolved, 1);
  assert.equal(artifact.coverage.markets.unresolved, 1);
  assert.deepEqual(artifact.coverage.reads.byKind.marketParams, { attempts: 2, successes: 1, failures: 1 });
  assert.deepEqual(artifact.coverage.reads.byKind.position, { attempts: 1, successes: 0, failures: 1 });
  assert.equal(artifact.coverage.reads.failures, 2);
  assert.equal(artifact.coverage.positions.discovered, 2);
  assert.equal(artifact.coverage.positions.successfullyChecked, 0);
  assert.equal(artifact.coverage.positions.unchecked, 2);
  assert.equal(artifact.coverage.positions.uncheckedDueToUnresolvedMarket, 1);
  assert.equal(artifact.errors, 2);
});

test("small fully read fixture is exhaustive and emits raw, unvalued telemetry", async () => {
  const artifact = await main(dependencies([borrowLog(1), borrowLog(2)]));

  assert.equal(artifact.classification, "EXHAUSTIVE_COMPLETE");
  assert.equal(artifact.complete, true);
  assert.equal(artifact.currentBlock, 1000);
  assert.deepEqual(artifact.coverage.observedRange, { fromBlock: 0, toBlock: 1000 });
  assert.equal(artifact.coverage.historyScope, "GENESIS_TO_TIP");
  assert.equal(artifact.coverage.fullHistoryProven, true);
  assert.deepEqual(artifact.coverage.borrowLogs, { discovered: 2, processed: 2, omittedByCap: 0, malformed: 0, wasTruncated: false });
  assert.deepEqual(artifact.coverage.markets, {
    discoveryScope: "processedBorrowLogs",
    discovered: 1,
    attempted: 1,
    resolved: 1,
    unresolved: 0,
  });
  assert.equal(artifact.coverage.positions.discovered, 2);
  assert.equal(artifact.coverage.positions.successfullyChecked, 2);
  assert.equal(artifact.coverage.positions.unchecked, 0);
  assert.deepEqual(artifact.coverage.reads, {
    attempts: 7,
    successes: 7,
    failures: 0,
    byKind: {
      blockNumber: { attempts: 1, successes: 1, failures: 0 },
      borrowLogs: { attempts: 1, successes: 1, failures: 0 },
      marketParams: { attempts: 1, successes: 1, failures: 0 },
      marketState: { attempts: 1, successes: 1, failures: 0 },
      oraclePrice: { attempts: 1, successes: 1, failures: 0 },
      position: { attempts: 2, successes: 2, failures: 0 },
    },
  });
  assert.equal(artifact.results.valuationStatus, "unavailable");
  assert.equal(artifact.results.valuationEvidence, null);
  assert.equal(artifact.results.promotionEligible, false);
  assert.equal(artifact.results.liquidatablePositions.length, 2);
  for (const position of artifact.results.liquidatablePositions) {
    assert.equal(position.borrowAssetsRaw, "100");
    assert.equal(position.valuationStatus, "unavailable");
    assert.equal("profitUsd" in position, false);
    assert.equal("profit" in position, false);
  }
  assert.equal(JSON.stringify(artifact).includes("Usd"), false);
});

test("recent-window zero logs cannot become complete", async () => {
  const artifact = await main(dependencies([], { blockHex: "0x2710" }));

  assert.equal(artifact.classification, "BOUNDED_WINDOW_INCOMPLETE");
  assert.equal(artifact.complete, false);
  assert.deepEqual(artifact.coverage.observedRange, { fromBlock: 5000, toBlock: 10000 });
  assert.equal(artifact.coverage.historyScope, "RECENT_BLOCK_SUFFIX");
  assert.equal(artifact.coverage.fullHistoryProven, false);
  assert.match(artifact.blocker, /recent block suffix/i);
  assert.equal(artifact.results.promotionEligible, false);
});

test("injected non-genesis full history requires explicit exact-bound proof", async () => {
  const unproven = await main(dependencies([], {
    blockHex: "0x2710",
    historyStartBound: { block: 250, proven: true, proof: "" },
  }));
  assert.equal(unproven.complete, false);
  assert.equal(unproven.coverage.fullHistoryProven, false);

  const proven = await main(dependencies([], {
    blockHex: "0x2710",
    historyStartBound: { block: 250, kind: "deployment", proven: true, proof: "synthetic exact deployment bound" },
  }));
  assert.equal(proven.classification, "EXHAUSTIVE_COMPLETE");
  assert.equal(proven.complete, true);
  assert.deepEqual(proven.coverage.observedRange, { fromBlock: 250, toBlock: 10000 });
  assert.equal(proven.coverage.historyScope, "PROVEN_START_TO_TIP");
  assert.equal(proven.coverage.fullHistoryProven, true);
});

test("Morpho accrual matches all three Taylor terms and rounds only after compounding", () => {
  assert.equal(blue.wTaylorCompounded(1000000000000000n, 100n), 105166666666666666n);
  assert.equal(blue.accruedBorrowAssets({ totalBorrowAssets: 1000n, borrowRate: 1000000000000000n, elapsedSeconds: 100n }), 1105n);
  // Linear per-second flooring used to lose all of this interest.
  assert.equal(blue.accruedBorrowAssets({ totalBorrowAssets: 10n, borrowRate: 10000000000000000n, elapsedSeconds: 10n }), 11n);
  assert.equal(blue.accruedBorrowAssets({ totalBorrowAssets: 1000n, borrowRate: 0n, elapsedSeconds: 100n }), 1000n);
  assert.equal(blue.accruedBorrowAssets({ totalBorrowAssets: 1000n, borrowRate: 10n, elapsedSeconds: 0n }), 1000n);
});

function liquidationFixture(overrides = {}) {
  return {
    key: "fixture", marketId: MARKET_A, borrower: "0x0000000000000000000000000000000000000001",
    collateralToken: "0x0000000000000000000000000000000000000002", loanToken: unwind.USDC,
    oracle: "0x0000000000000000000000000000000000000003", irm: "0x0000000000000000000000000000000000000004",
    collateralRaw: "100", oraclePriceRaw: (10n ** 36n).toString(), lltvRaw: "800000000000000000",
    totalBorrowAssetsAccruedRaw: "1000", totalBorrowSharesRaw: "1000000000", borrowShares: "500000000", borrowedRaw: "500",
    ...overrides,
  };
}

test("Morpho collateral-limited repayment excludes socialized bad debt and applies LIF cap", () => {
  const amount = unwind.liquidationAmounts(liquidationFixture());
  assert.deepEqual(amount, {
    // LIF itself rounds down: 100 / floored-LIF is just above 94, hence 95.
    seizedCollateralRaw: "100", repaidDebtRaw: "95", repaidSharesRaw: "95000000",
    fullDebtRaw: "500", badDebtSocializedRaw: "405", liquidationIncentiveFactorRaw: "1063829787234042553",
  });
  const capped = unwind.liquidationAmounts(liquidationFixture({ lltvRaw: "0" }));
  assert.equal(capped.liquidationIncentiveFactorRaw, "1150000000000000000");
  assert.equal(capped.repaidDebtRaw, "87");
  assert.equal(capped.badDebtSocializedRaw, "413");
});

test("Morpho debt-limited seizure uses the repaid-shares branch, not all collateral", () => {
  const amount = unwind.liquidationAmounts(liquidationFixture({ collateralRaw: "1000" }));
  assert.equal(amount.seizedCollateralRaw, "531");
  assert.equal(amount.repaidDebtRaw, "500");
  assert.equal(amount.badDebtSocializedRaw, "0");
  assert.throws(() => unwind.liquidationAmounts(liquidationFixture({ totalBorrowSharesRaw: undefined })));
  const zeroPrice = unwind.liquidationAmounts(liquidationFixture({ oraclePriceRaw: "0" }));
  assert.equal(zeroPrice.repaidDebtRaw, "0");
  assert.equal(zeroPrice.badDebtSocializedRaw, "500");
});

test("Morpho socializes post-repayment share-rounded debt, not fullDebt minus repayment", () => {
  const result = unwind.liquidationAmounts(liquidationFixture({
    collateralRaw: "1", totalBorrowAssetsAccruedRaw: "100", totalBorrowSharesRaw: "99000000", borrowShares: "10000000", borrowedRaw: "11",
  }));
  assert.equal(result.fullDebtRaw, "11");
  assert.equal(result.repaidSharesRaw, "990100");
  assert.equal(result.repaidDebtRaw, "2");
  assert.equal(result.badDebtSocializedRaw, "10");
});

test("Morpho unwind quotes actual seizure and records the corrected repayment/minimum", async () => {
  const sizes = [];
  const multicall = async (_rpc, _pin, entries) => ({ failures: 0, results: entries.map(entry => {
    const selector = entry.data.slice(0, 10);
    let returnData;
    if (selector === unwind.IFACE.factory.getFunction("getPool").selector) {
      returnData = unwind.IFACE.factory.encodeFunctionResult("getPool", ["0x0000000000000000000000000000000000000005"]);
    } else if (selector === unwind.IFACE.liquidity.getFunction("liquidity").selector) {
      returnData = unwind.IFACE.liquidity.encodeFunctionResult("liquidity", [1000n]);
    } else {
      const [quote] = unwind.IFACE.quoter.decodeFunctionData("quoteExactInputSingle", entry.data);
      sizes.push(quote.amountIn);
      returnData = unwind.IFACE.quoter.encodeFunctionResult("quoteExactInputSingle", [quote.amountIn * 2n, 0n, 0n, 0n]);
    }
    return { success: true, returnData };
  }) });
  const result = await unwind.valuate({ rpc: "offline", blockRef: "0x1", baseFeeWei: 0n, priorityFeeWei: 0n,
    ethUsdRaw: 1n, candidates: [liquidationFixture()], multicall });
  const row = result.candidates[0];
  assert.deepEqual(sizes, [100n]);
  assert.equal(row.repaidDebtRaw, "95");
  assert.equal(row.repaidUsdcRaw, "95");
  assert.equal(row.minLoanOutRaw, "95");
  assert.equal(row.fullDebtRaw, "500");
  assert.equal(row.netUsdcRaw, "104");
  assert.equal(row.quoteExecutable, false);
  assert.equal(row.probeStatus, "PENDING_KEYLESS_FORK");
});

test("Aave close-factor boundary and small-position exceptions use 8-decimal USD", () => {
  const large = 2000n * 10n ** 8n;
  assert.equal(aave.closeFactorBps(950000000000000000n, large, large), 10000n);
  assert.equal(aave.closeFactorBps(950000000000000001n, large, large), 5000n);
  assert.equal(aave.closeFactorBps(990000000000000000n, large - 1n, large), 10000n);
  assert.equal(aave.closeFactorBps(990000000000000000n, large, large - 1n), 10000n);
});

test("Aave reserve IDs and bitmap roles identify collateral rather than debt", () => {
  const reserves = [{ asset: "debt", reserveId: 2 }, { asset: "collateral", reserveId: 7 }];
  const config = (1n << 4n) | (1n << 15n);
  assert.deepEqual(aave.decodeUserConfiguration(config, reserves), { collateralAssets: ["collateral"], borrowAssets: ["debt"] });
  const flag = aave.decodeReserveConfiguration((11000n << 32n) | (1000n << 152n));
  assert.equal(flag.liquidationBonusRaw, "11000");
  assert.equal(flag.liquidationProtocolFeeRaw, "1000");
});

test("Aave bonus comes from collateral/eMode and protocol fee applies to bonus only", () => {
  const flags = new Map([
    ["collateral", { reserveId: 7, liquidationBonusRaw: "11000", liquidationProtocolFeeRaw: "1000" }],
    ["debt", { reserveId: 2, liquidationBonusRaw: "15000", liquidationProtocolFeeRaw: "0" }],
  ]);
  const row = { healthFactorRaw: "970000000000000000", totalDebtBaseRaw: "1000000000000", collateralAssets: ["collateral"], borrowAssets: ["debt"] };
  const values = new Map([["collateral", 1000000000000n]]);
  const ordinary = aave.liquidationBound(row, flags, "0", undefined, values, 0n);
  assert.equal(ordinary.maxLiquidationBonusBps, "11000");
  assert.equal(ordinary.grossBonusBoundBaseRaw, "50000000000");
  assert.equal(ordinary.liquidationProtocolFeeBaseRaw, "5000000000");
  assert.equal(ordinary.netBoundBaseRaw, "45000000000");
  const category = { collateralBitmap: 1n << 7n, liquidationBonusRaw: "10100" };
  const mode = aave.liquidationBound(row, flags, "1", category, values, 0n);
  assert.equal(mode.maxLiquidationBonusBps, "10100");
  assert.equal(mode.netBoundBaseRaw, "4500000000");
  const outside = aave.liquidationBound(row, flags, "1", { ...category, collateralBitmap: 1n << 2n }, values, 0n);
  assert.equal(outside.maxLiquidationBonusBps, "11000");
  for (const result of [aave.liquidationBound(row, flags, null, undefined, values, 0n),
    aave.liquidationBound(row, flags, "1", undefined, values, 0n),
    aave.liquidationBound(row, flags, "0", undefined, new Map(), 0n)]) {
    assert.equal(result.netBoundBaseRaw, null);
    assert.equal(result.boundPositive, false);
  }
});

test("Aave evaluates each collateral's size exception and caps repayment by its capacity", () => {
  const flags = new Map([["small", { reserveId: 0, liquidationBonusRaw: "11000", liquidationProtocolFeeRaw: "0" }]]);
  const row = { healthFactorRaw: "990000000000000000", totalDebtBaseRaw: "1000000000000", collateralAssets: ["small"] };
  const result = aave.liquidationBound(row, flags, "0", undefined, new Map([["small", 100000000000n]]), 0n);
  assert.equal(result.closeFactorBps, "10000");
  assert.equal(result.debtToCoverBaseRaw, "90909090909");
  assert.equal(result.grossBonusBoundBaseRaw, "9090909090");
});
