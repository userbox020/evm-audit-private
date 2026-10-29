#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  canonical,
  ceilDiv,
  correctedEconomics,
  normalize,
  sha256,
  simulateDustBatch,
  slotAddress
} = require("./run-critical-eigenlayer-steth-deployment-economics-step3");

let checks = 0;
function eq(actual, expected) { assert.deepStrictEqual(actual, expected); checks++; }
function ok(value) { assert.ok(value); checks++; }

eq(ceilDiv(0n, 7n), 0n);
eq(ceilDiv(1n, 7n), 1n);
eq(ceilDiv(8n, 7n), 2n);
eq(slotAddress(`0x${"0".repeat(24)}0000000000000000000000000000000000000001`), "0x0000000000000000000000000000000000000001");
eq(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
eq(normalize({ A: "0xAB", B: ["X"] }), { A: "0xab", B: ["x"] });
eq(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

const batch = simulateDustBatch({
  depositCount: 3,
  dustAmount: 1,
  strategyBalance: 120_000n * 10n ** 18n,
  strategyTotalShares: 120_000n * 10n ** 18n,
  internalEther: 24n * 10n ** 29n,
  internalShares: 2n * 10n ** 30n
});
eq(batch.depositWouldRevert, false);
eq(batch.aggregateMinted, "3");
eq(batch.amountOut, "2");
eq(batch.tokenSharesOut, "1");
eq(batch.pooledValueOut, "1");

const economics = correctedEconomics({
  maximumZeroShareAmount: 1,
  fixedPinBaseFeePerGasWei: 54_719_593,
  currentDustDepositAccepted: false,
  strategyBalance: 296_783_219_990_542_599_105_632n,
  strategyTotalShares: 270_012_125_927_953_752_547_264n,
  internalEther: 9_334_775_004_611_596_754_644_949n,
  internalShares: 7_526_542_146_093_785_039_907_267n,
  pooledPerOneTokenShare: 1,
  withdrawalDelay: 100_800
});
eq(economics.current.rawCapturePooledWei, "0");
ok(economics.current.batchSimulation.every(row => row.depositWouldRevert));
ok(economics.current.batchSimulation.every(row => row.currentCapturePooledWei === "0"));
eq(economics.hypotheticalHelperBatching.helperCanApproveAndSequentiallyCallDepositsThenQueueInOneTransaction, true);
eq(economics.hypotheticalHelperBatching.nonReentrantDoesNotBlockSequentialCalls, true);
eq(economics.hypotheticalHelperBatching.minimumProtocolPathTransactions, 2);
eq(economics.hypotheticalHelperBatching.perDepositExecutionGasLowerBound, null);
eq(economics.hypotheticalHelperBatching.blockGasBatchingCap, null);
eq(economics.hypotheticalHelperBatching.netEconomics, null);
eq(economics.hypotheticalHelperBatching.economicsResolved, false);
eq(economics.exactP0P1.minimumProtocolPathTransactions, 2);
eq(economics.exactP0P1.minimumProtocolPathIntrinsicGasUnitsLowerBound, "42000");
eq(economics.exactP0P1.transactionPlan.length, 2);
eq(economics.exactP0P1.rebaseOccursDuringWithdrawalQueueDelay, true);
eq(economics.exactP0P1.queueingBurnsStrategyBaseSharesUnderFactorOneModel, false);
eq(economics.exactP0P1.queueingRemovesStethCustodyUnderFactorOneModel, false);
eq(economics.exactP0P1.requiresExogenousExactRebaseResidue, true);
eq(economics.exactP0P1.conditionalFutureCase, true);
eq(economics.exactP0P1.currentRouteReproducedAtPin, false);
eq(economics.exactP0P1.intrinsicCostWeiLowerBoundAtExecution, null);
eq(economics.disposition.economicsClosed, false);

process.stdout.write(`${JSON.stringify({ ok: true, checks })}\n`);
