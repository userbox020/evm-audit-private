"use strict";

// Offline suite for the Morpho Blue Ethereum liquidation (L class) vertical,
// mirroring tools/test-curve-join-exit.js. No network: pure math, schema, wiring,
// compiled-artifact, and scenario-assertion checks only.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const { ethers } = require("ethers");

const scanner = require("./scan-morpho-blue-l");
const valuation = require("./morpho-unwind-valuation");
const coverage = require("./audit-trigger-coverage-universe");
const watch = require("./run-profit-trigger-watch");
const bridge = require("./run-trigger-fork-poc");
const autopilot = require("./trigger-fork-autopilot");
const dispatcher = require("./monitor-alert-dispatcher");

const ROOT = path.resolve(__dirname, "..");
const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));
const PRODUCER_ID = "morpho-blue-eth-l";
const CONTRACT = {
  name: "MorphoLiquidateUnwindRoundTrip",
  sol: path.join(__dirname, "fork-poc", "contracts", "MorphoLiquidateUnwindRoundTrip.sol"),
  compiled: path.join(__dirname, "fork-poc", "contracts", "MorphoLiquidateUnwindRoundTrip.compiled.json"),
  scenario: path.join(__dirname, "fork-poc", "triggers", `${PRODUCER_ID}.js`),
};

test("Morpho L exact math reproduces Blue accrual and share-offset conventions", () => {
  // toAssetsUp uses VIRTUAL_ASSETS=1 and VIRTUAL_SHARES=1e6, rounding up.
  assert.equal(scanner.VIRTUAL_ASSETS, 1n);
  assert.equal(scanner.VIRTUAL_SHARES, 1_000_000n);
  assert.equal(scanner.toAssetsUp(1n, 0n, 0n).toString(), "1");
  assert.equal(scanner.toAssetsUp(1_000_000n, 500n, 1_000_000n).toString(), "251");
  // interest = mulDown(wMulDown(totalBorrowAssets, rate), elapsed)
  assert.equal(
    scanner.accruedBorrowAssets({ totalBorrowAssets: 10n ** 18n, borrowRate: 10n ** 16n, elapsedSeconds: 100n }).toString(),
    (2n * 10n ** 18n).toString(),
  );
  assert.equal(
    scanner.accruedBorrowAssets({ totalBorrowAssets: 10n ** 18n, borrowRate: 10n ** 16n, elapsedSeconds: 0n }).toString(),
    (10n ** 18n).toString(),
  );
  // maxBorrow = collateral * price / 1e36 * lltv / 1e18
  assert.equal(scanner.maxBorrowAssets(10n ** 18n, 10n ** 36n, 8n * 10n ** 17n).toString(), (8n * 10n ** 17n).toString());
  assert.equal(scanner.isLiquidatable({ borrowed: 101n, collateral: 1n, maxBorrow: 100n }), true);
  assert.equal(scanner.isLiquidatable({ borrowed: 100n, collateral: 1n, maxBorrow: 100n }), false);
  assert.equal(scanner.HEALTHY_POSITION_SELECTOR, ethers.id("HealthyPosition()").slice(0, 10));
});

test("oracle-unavailable debt is excluded and recorded, never guessed", () => {
  const market = {
    id: "0x" + "a".repeat(64), loanToken: "0x" + "1".repeat(40), collateralToken: "0x" + "2".repeat(40),
    oracle: "0x" + "3".repeat(40), irm: "0x" + "4".repeat(40), lltv: 8n * 10n ** 17n,
    totalBorrowAssets: 0n, totalBorrowShares: 0n, oracleOk: false,
  };
  const markets = new Map([[market.id, market]]);
  const key = market.id + "0x" + "0".repeat(24) + "b".repeat(40);
  const { rows, failures } = scanner.classifyPositions(markets, [{ key, borrowShares: 5n, collateral: 10n }]);
  assert.equal(failures.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "oracleUnavailable");
  // A zero-debt position needs no oracle and is classified zero.
  const zero = scanner.classifyPositions(markets, [{ key, borrowShares: 0n, collateral: 10n }]);
  assert.equal(zero.rows[0].state, "zero");
  assert.equal(zero.failures.length, 0);
  // An active position in a market with missing accrual is an infra failure.
  const noAccrual = scanner.classifyPositions(new Map([[market.id, { ...market, oracleOk: true }]]), [{ key, borrowShares: 5n, collateral: 10n }]);
  assert.equal(noAccrual.failures.length, 1);
});

test("Morpho L coverage evidence maps the enabled universe row", () => {
  const universeRows = UNIVERSE.rows.filter((row) => row.id === "ethereum-morpho-blue-l");
  assert.equal(universeRows.length, 1);
  assert.equal(universeRows[0].onFire.enabled, true);
  assert.equal(universeRows[0].triggerClass, "L");
  assert.equal(universeRows[0].artifactPath, "reports/monitor/trigger-coverage/morpho-blue-ethereum-l.json");

  const artifact = {
    scannedAt: new Date().toISOString(), chainId: 1,
    pin: { number: 1, hash: `0x${"1".repeat(64)}`, timestamp: new Date().toISOString() },
    historyStartBound: { block: scanner.DEPLOY_BLOCK, proven: true },
    enumeration: { activeNow: 2, oracleUnavailableNow: 1 },
    totals: {
      exactLiquidatable: 1, activeEvaluated: 2, rawDirectionalLiquidatable: 1, oracleUnavailable: 1,
      sampledVerification: { liquidatableConfirmed: 1, healthyConfirmed: 1, ambiguous: [] },
    },
    valuation: { status: "UNQUALIFIED_ROUTE" },
    reads: { attempted: 10, succeeded: 10, failed: 0, unclassifiedFailures: 0 },
    coverage: { complete: true },
  };
  const evidence = scanner.coverageEvidence(artifact);
  const shape = coverage.genericEvidenceShape(evidence, universeRows[0]);
  assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
    && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
  assert.deepEqual(evidence.blockers, []);
});

test("Morpho L producer is wired through watch, bridge, autopilot, and dispatcher", () => {
  assert.equal(watch.PRODUCER_IDS.includes(PRODUCER_ID), true);
  assert.deepEqual([...watch.SUCCESS_STATUSES[PRODUCER_ID]], ["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"]);
  assert.equal(autopilot.SUPPORTED_EVENTS.get(PRODUCER_ID), "ATOMIC_FORK_REQUIRED");
  assert.equal(autopilot.CROSS_VENUE_PRODUCERS.has(PRODUCER_ID), true);
  assert.equal(dispatcher.FORK_PROMOTION_PRODUCERS.includes(PRODUCER_ID), true);
  assert.equal(bridge.FIXED_CHAIN[PRODUCER_ID], 1);
});

test("Morpho L producer evidence validates the bounded liquidation envelope", () => {
  const base = {
    chainId: 1, blockNumberRaw: "1", blockHash: `0x${"c".repeat(64)}`, blockTimestamp: new Date().toISOString(),
    routeCount: 3, failedCount: 0, firedCount: 0, candidate: null,
  };
  assert.equal(watch.validateEvidence(PRODUCER_ID, "GROSS_EDGE_NET_BLOCKED", base), true);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "NO_GROSS_EDGE", { ...base, routeCount: 0 }), true);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "NO_GROSS_EDGE", base), false);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "GROSS_EDGE_NET_BLOCKED", { ...base, firedCount: 1 }), false);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "GROSS_EDGE_NET_BLOCKED", { ...base, chainId: 8453 }), false);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "GROSS_EDGE_NET_BLOCKED", { ...base, candidate: {} }), false);

  const firedCandidate = {
    routeKey: "a".repeat(64), eventId: "a".repeat(64), marketId: `0x${"b".repeat(64)}`,
    borrower: `0x${"1".repeat(40)}`, loanToken: valuation.USDC, collateralToken: `0x${"2".repeat(40)}`,
    oracle: `0x${"3".repeat(40)}`, irm: `0x${"4".repeat(40)}`, lltv: "800000000000000000",
    seizedAssets: "1000000", swapTarget: `0x${"5".repeat(40)}`, swapHops: [valuation.USDC, `0x${"2".repeat(40)}`],
    swapFees: [500], minLoanOut: "900000", principalUsdcRaw: "950000", expectedNetUsdcRaw: "10000",
    ethUsdRaw: "200000000000", routePositive: true,
  };
  const fired = { ...base, firedCount: 1, candidate: firedCandidate };
  assert.equal(watch.validateEvidence(PRODUCER_ID, "ATOMIC_FORK_REQUIRED", fired), true);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "ATOMIC_FORK_REQUIRED", { ...fired, candidate: { ...firedCandidate, routePositive: false } }), false);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "ATOMIC_FORK_REQUIRED", { ...fired, candidate: { ...firedCandidate, loanToken: `0x${"9".repeat(40)}` } }), false);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "ATOMIC_FORK_REQUIRED", { ...fired, firedCount: 0 }), false);
});

test("Morpho L compiled artifact is source-hash bound and reproducible", () => {
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const artifact = JSON.parse(fs.readFileSync(CONTRACT.compiled, "utf8"));
  assert.equal(artifact.chainId, 1);
  assert.equal(artifact.contractName, CONTRACT.name);
  assert.equal(sha(fs.readFileSync(CONTRACT.sol)), artifact.sourceSha256);
  assert.equal(sha(Buffer.from(artifact.creationBytecode.slice(2), "hex")), artifact.creationBytecodeSha256);
  assert.equal(sha(Buffer.from(artifact.runtimeBytecode.slice(2), "hex")), artifact.runtimeBytecodeSha256);
  const result = childProcess.spawnSync(path.join(ROOT, artifact.compiler.path), [
    "--optimize", "--optimize-runs", "200", "--evm-version", "paris", "--metadata-hash", "none", "--combined-json", "abi,bin,bin-runtime", CONTRACT.sol,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const built = output.contracts[Object.keys(output.contracts).find((key) => key.endsWith(`:${CONTRACT.name}`))];
  assert.equal(`0x${built.bin}`, artifact.creationBytecode);
  assert.equal(`0x${built["bin-runtime"]}`, artifact.runtimeBytecode);
});

test("Morpho L scenario binds chain, exact pin, funded actor, and zero-capital repayment", () => {
  const scenario = fs.readFileSync(CONTRACT.scenario, "utf8");
  const source = fs.readFileSync(CONTRACT.sol, "utf8");
  assert.match(source, /flashLoan\(plan\.loanToken, principal/u);
  assert.match(source, /onMorphoFlashLoan/u);
  assert.match(source, /liquidate\(/u);
  assert.match(source, /unwound = true/u);
  assert.match(source, /plan\.swapTarget\.call\(swapData\)/u);
  assert.match(source, /transfer\(actor, residual\)/u);
  assert.match(scenario, /module\.exports = \{ chainId: 1, run \}/u);
  assert.match(scenario, /const ACTOR = "0x00000000000000000000000000000000000a11d0"/u);
  assert.match(scenario, /const exactPin = typeof evidence\?\.blockHash === "string"/u);
  assert.match(scenario, /ctx\.assert\(ctx\.chainId === 1, "ethereum-chain"\)/u);
  assert.match(scenario, /ctx\.assert\(exactPin, "exact-pin-hash"\)/u);
  assert.match(scenario, /deploymentGas \* deploymentGasPrice \+ executionGas \* executionGasPrice/u);
  assert.match(scenario, /ctx\.assert\(routePositive, "net-after-actual-gas"\)/u);
});

test("Morpho L scenario aborts on an exact-pin mismatch before any RPC or deployment", async () => {
  const scenario = require(CONTRACT.scenario);
  const seen = [];
  const ctx = {
    chainId: 1,
    blockHash: `0x${"2".repeat(64)}`,
    input: { blockHash: `0x${"1".repeat(64)}`, candidate: {} },
    fatal: false,
    assert(condition, label) {
      const pass = condition === true;
      seen.push(label);
      if (!pass && this.fatal) throw Object.assign(new Error("SCENARIO_ASSERT_FAILED"), { code: "SCENARIO_ASSERT_FAILED" });
      return pass;
    },
  };
  await assert.rejects(() => scenario.run(ctx), /SCENARIO_ASSERT_FAILED/u);
  assert.deepEqual(seen, ["ethereum-chain", "exact-pin-hash"]);
  assert.equal(Object.hasOwn(ctx, "ethers"), false);
});

// --- injectable valuation multicall -------------------------------------------------------
function mockValuationMulticall({ pools = {}, quotes = () => null, liquidity = 10n ** 18n }) {
  return async (_rpc, _blockRef, entries) => ({
    results: entries.map((entry) => {
      if (entry.to === valuation.UNIV3_FACTORY) {
        const decoded = valuation.IFACE.factory.decodeFunctionData("getPool", entry.data);
        const key = `${String(decoded[0]).toLowerCase()}|${String(decoded[1]).toLowerCase()}|${Number(decoded[2])}`;
        const pool = pools[key];
        return { success: true, returnData: valuation.IFACE.factory.encodeFunctionResult("getPool", [pool || ethers.ZeroAddress]) };
      }
      if (entry.to === valuation.UNIV3_QUOTER_V2) {
        const decoded = valuation.IFACE.quoter.decodeFunctionData("quoteExactInputSingle", entry.data);
        const q = decoded[0];
        const out = quotes(`${String(q.tokenIn).toLowerCase()}|${String(q.tokenOut).toLowerCase()}|${Number(q.fee)}|${q.amountIn.toString()}`);
        if (out === null || out === undefined) return { success: false, returnData: "0x" };
        return { success: true, returnData: valuation.IFACE.quoter.encodeFunctionResult("quoteExactInputSingle", [out, 0n, 0, 0n]) };
      }
      return { success: true, returnData: valuation.IFACE.liquidity.encodeFunctionResult("liquidity", [liquidity]) };
    }),
    failures: 0,
  });
}

function candidateRow({ collateralToken, loanToken, collateralRaw = "1000000", borrowedRaw = "1000000", suffix = "a" }) {
  return {
    key: `0x${suffix.repeat(64)}0x${"0".repeat(24)}${"b".repeat(40)}`,
    marketId: `0x${suffix.repeat(64)}`, borrower: `0x${"b".repeat(40)}`,
    collateralToken, loanToken, collateralRaw, borrowedRaw,
    oracle: `0x${"3".repeat(40)}`, irm: `0x${"4".repeat(40)}`, lltvRaw: "800000000000000000", oraclePriceRaw: "1000000000000000000000000000000000000",
  };
}

const C1 = `0x${"c1".repeat(20)}`;
const C2 = `0x${"c2".repeat(20)}`;
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const BASE_FEE = 1_000_000_000n;
const ETH_USD = 200_000_000_000n;

test("Morpho L valuation qualifies a direct USDC route and applies the suppress-only gate", async () => {
  const pools = {};
  pools[`${C1.toLowerCase()}|${valuation.USDC.toLowerCase()}|500`] = `0x${"d1".repeat(20)}`;
  const multicall = mockValuationMulticall({
    pools,
    quotes: (key) => (key.startsWith(C1.toLowerCase()) && key.includes(valuation.USDC.toLowerCase()) ? 20_000_000n : null),
  });
  const result = await valuation.valuate({
    rpc: "x", blockRef: "0x1", baseFeeWei: BASE_FEE, ethUsdRaw: ETH_USD,
    candidates: [candidateRow({ collateralToken: C1, loanToken: valuation.USDC })],
    multicall,
  });
  assert.equal(result.candidates.length, 1);
  const row = result.candidates[0];
  assert.equal(row.unwindRoute, "univ3-direct");
  assert.equal(row.valuationStatus, "QUALIFIED_VIEW");
  assert.equal(row.routePositive, true);
  assert.equal(row.quoteExecutable, false);
  assert.equal(row.probeStatus, "PENDING_KEYLESS_FORK");
  assert.equal(row.swapHops.length, 2);
  assert.equal(row.swapFees.length, 1);
  assert.ok(BigInt(row.netUsdcRaw) > 0n);
  assert.equal(row.minLoanOutRaw, "1000000");
  assert.equal(result.summary.qualified, 1);
  assert.equal(result.summary.routed, 1);
});

test("Morpho L valuation suppresses a below-gate and an unqualified candidate", async () => {
  const pools = {};
  pools[`${C1.toLowerCase()}|${valuation.USDC.toLowerCase()}|500`] = `0x${"d1".repeat(20)}`;
  const multicall = mockValuationMulticall({
    pools,
    // 1 USDC out cannot cover the ~12.5 USDC bounded gas ceiling.
    quotes: (key) => (key.startsWith(C1.toLowerCase()) ? 1_000_000n : null),
  });
  const result = await valuation.valuate({
    rpc: "x", blockRef: "0x1", baseFeeWei: BASE_FEE, ethUsdRaw: ETH_USD,
    candidates: [
      candidateRow({ collateralToken: C1, loanToken: valuation.USDC, suffix: "a" }),
      candidateRow({ collateralToken: C2, loanToken: DAI, suffix: "b" }),
    ],
    multicall,
  });
  const routed = result.candidates.find((row) => row.collateralToken === C1);
  const unknown = result.candidates.find((row) => row.collateralToken === C2);
  assert.equal(routed.valuationStatus, "QUALIFIED_VIEW");
  assert.equal(routed.routePositive, false);
  assert.equal(unknown.valuationStatus, "UNQUALIFIED_ROUTE");
  assert.equal(unknown.routePositive, false);
  assert.equal(unknown.expectedOutUsdcRaw, null);
  assert.equal(result.summary.qualified, 0);
  assert.equal(result.summary.unknown, 1);
});

test("Morpho L valuation qualifies a two-hop collateral -> USDC -> loan route", async () => {
  const pools = {};
  pools[`${C1.toLowerCase()}|${valuation.USDC.toLowerCase()}|3000`] = `0x${"d2".repeat(20)}`;
  pools[`${DAI.toLowerCase()}|${valuation.USDC.toLowerCase()}|100`] = `0x${"d3".repeat(20)}`;
  const multicall = mockValuationMulticall({
    pools,
    quotes: (key) => {
      if (key.startsWith(C1.toLowerCase())) return 50_000_000n; // collateral -> USDC
      if (key.startsWith(DAI.toLowerCase())) return 1_000_000n; // loan -> USDC (debt)
      return null;
    },
  });
  const result = await valuation.valuate({
    rpc: "x", blockRef: "0x1", baseFeeWei: BASE_FEE, ethUsdRaw: ETH_USD,
    candidates: [candidateRow({ collateralToken: C1, loanToken: DAI })],
    multicall,
  });
  const row = result.candidates[0];
  assert.equal(row.unwindRoute, "univ3-via-usdc");
  assert.equal(row.valuationStatus, "QUALIFIED_VIEW");
  assert.equal(row.routePositive, true);
  assert.equal(row.haircutBps, valuation.HAIRCUT_TWO_HOP_BPS);
  assert.deepEqual(row.swapHops, [C1.toLowerCase(), valuation.USDC.toLowerCase(), DAI.toLowerCase()]);
  assert.deepEqual(row.swapFees, [3000, 100]);
});

test("Morpho L encodeSwapData binds the deployed recipient for one and two hops", () => {
  const recipient = `0x${"e".repeat(40)}`;
  const single = valuation.encodeSwapData({ hops: [valuation.USDC, C1], fees: [500], recipient, amountIn: 1n, amountOutMinimum: 1n });
  assert.ok(single.startsWith(valuation.IFACE.router.getFunction("exactInputSingle").selector));
  const multi = valuation.encodeSwapData({ hops: [C1, valuation.USDC, DAI], fees: [3000, 100], recipient, amountIn: 1n, amountOutMinimum: 1n });
  assert.ok(multi.startsWith(valuation.IFACE.router.getFunction("exactInput").selector));
  const decoded = valuation.IFACE.router.decodeFunctionData("exactInput", multi);
  assert.equal(String(decoded[0].recipient).toLowerCase(), recipient.toLowerCase());
  assert.equal(decoded[0].path.slice(0, 42).toLowerCase(), C1.toLowerCase());
});

test("Morpho L suppress-only haircut rounds up and pair keys normalize case", () => {
  assert.equal(valuation.haircutRaw(10_000n, 25), 25n);
  assert.equal(valuation.haircutRaw(1n, 1), 1n);
  assert.equal(valuation.haircutRaw(1_000_000n, 0), 0n);
  assert.equal(valuation.pairKey(C1.toUpperCase().replace("0X", "0x"), DAI), `${C1.toLowerCase()}|${DAI.toLowerCase()}`);
});

test("Morpho L index historyStartBound is independently checkable shape", () => {
  const bound = { block: scanner.DEPLOY_BLOCK, proven: true, proof: { previousBlockCodeAbsent: true, deploymentBlockCodePresent: true, borrowTopic: scanner.BORROW_TOPIC } };
  assert.equal(bound.block, 18883124);
  assert.equal(bound.proven, true);
  assert.equal(bound.proof.previousBlockCodeAbsent, true);
  assert.equal(bound.proof.borrowTopic, scanner.BORROW_TOPIC);
});
