"use strict";

// Offline suite for the Morpho Blue Base liquidation (L class) vertical, mirroring
// tools/test-morpho-blue-l.js. No network: pure math, schema, wiring, compiled
// artifact, valuation venue, and scenario-assertion checks only.

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
const PRODUCER_ID = "morpho-blue-base-l";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CONTRACT = {
  name: "MorphoLiquidateUnwindBaseRoundTrip",
  sol: path.join(__dirname, "fork-poc", "contracts", "MorphoLiquidateUnwindBaseRoundTrip.sol"),
  compiled: path.join(__dirname, "fork-poc", "contracts", "MorphoLiquidateUnwindBaseRoundTrip.compiled.json"),
  scenario: path.join(__dirname, "fork-poc", "triggers", `${PRODUCER_ID}.js`),
};

test("Morpho L Base chain config is bound to the verified deployment", () => {
  const config = scanner.chainConfig(8453);
  assert.equal(config.chainId, 8453);
  assert.equal(config.deployBlock, 13977148);
  assert.equal(config.chainlinkEthUsd, "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70");
  assert.equal(config.logChunk, 12_000);
  assert.equal(config.backfillConcurrency, 10);
  assert.equal(config.coveragePath.endsWith("morpho-blue-base-l.json"), true);
  assert.equal(config.indexPath.endsWith("morpho-blue-l-base-index.json"), true);
  assert.equal(scanner.CHAINS[1].deployBlock, 18883124);
});

test("Morpho L Base exact math reuses Blue accrual and share offsets", () => {
  assert.equal(scanner.toAssetsUp(1_000_000n, 500n, 1_000_000n).toString(), "251");
  assert.equal(
    scanner.accruedBorrowAssets({ totalBorrowAssets: 10n ** 18n, borrowRate: 10n ** 16n, elapsedSeconds: 100n }).toString(),
    (2n * 10n ** 18n).toString(),
  );
  assert.equal(scanner.isLiquidatable({ borrowed: 101n, collateral: 1n, maxBorrow: 100n }), true);
  // Size-appropriate probe seize: repay the whole debt bounded by collateral.
  assert.equal(scanner.probeSeizeRaw({ borrowedRaw: "1000", oraclePriceRaw: (10n ** 36n).toString(), collateralRaw: "5000" }).toString(), "1000");
  assert.equal(scanner.probeSeizeRaw({ borrowedRaw: "9000", oraclePriceRaw: (10n ** 36n).toString(), collateralRaw: "5000" }).toString(), "5000");
});

test("Morpho L Base coverage evidence maps the enabled universe row", () => {
  const universeRows = UNIVERSE.rows.filter((row) => row.id === "base-morpho-blue-l");
  assert.equal(universeRows.length, 1);
  assert.equal(universeRows[0].onFire.enabled, true);
  assert.equal(universeRows[0].chainId, 8453);
  assert.equal(universeRows[0].artifactPath, "reports/monitor/trigger-coverage/morpho-blue-base-l.json");

  const artifact = {
    scannedAt: new Date().toISOString(), chainId: 8453,
    pin: { number: 1, hash: `0x${"1".repeat(64)}`, timestamp: new Date().toISOString() },
    historyStartBound: { block: 13977148, proven: true },
    enumeration: { activeNow: 2, oracleUnavailableNow: 1 },
    totals: {
      exactLiquidatable: 1, activeEvaluated: 2, rawDirectionalLiquidatable: 1, oracleUnavailable: 1,
      sampledVerification: { liquidatableConfirmed: 1, healthyConfirmed: 1, ambiguous: [] },
    },
    valuation: { status: "UNQUALIFIED_ROUTE", qualifiedRoutes: 0, routedCandidates: 0, unknownCandidates: 1, qualifiedCandidates: 0 },
    reads: { attempted: 10, succeeded: 10, failed: 0, unclassifiedFailures: 0 },
    coverage: { complete: true },
  };
  const evidence = scanner.coverageEvidence(artifact);
  assert.equal(evidence.chainId, 8453);
  const shape = coverage.genericEvidenceShape(evidence, universeRows[0]);
  assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
    && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
  // A wrong-chain binder must not satisfy the Base row.
  assert.equal(coverage.genericEvidenceShape({ ...evidence, chainId: 1 }, universeRows[0]).identity, false);
});

test("Morpho L Base producer is wired through watch, bridge, autopilot, and dispatcher", () => {
  assert.equal(watch.PRODUCER_IDS.includes(PRODUCER_ID), true);
  assert.deepEqual([...watch.SUCCESS_STATUSES[PRODUCER_ID]], ["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"]);
  assert.equal(autopilot.SUPPORTED_EVENTS.get(PRODUCER_ID), "ATOMIC_FORK_REQUIRED");
  assert.equal(autopilot.CROSS_VENUE_PRODUCERS.has(PRODUCER_ID), true);
  assert.equal(dispatcher.FORK_PROMOTION_PRODUCERS.includes(PRODUCER_ID), true);
  assert.equal(bridge.FIXED_CHAIN[PRODUCER_ID], 8453);
});

test("Morpho L Base producer evidence validates the bounded liquidation envelope", () => {
  const base = {
    chainId: 8453, blockNumberRaw: "1", blockHash: `0x${"c".repeat(64)}`, blockTimestamp: new Date().toISOString(),
    routeCount: 3, failedCount: 0, firedCount: 0, candidate: null,
  };
  assert.equal(watch.validateEvidence(PRODUCER_ID, "GROSS_EDGE_NET_BLOCKED", base), true);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "NO_GROSS_EDGE", { ...base, routeCount: 0 }), true);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "NO_GROSS_EDGE", base), false);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "GROSS_EDGE_NET_BLOCKED", { ...base, chainId: 1 }), false);

  const firedCandidate = {
    routeKey: "a".repeat(64), eventId: "a".repeat(64), marketId: `0x${"b".repeat(64)}`,
    borrower: `0x${"1".repeat(40)}`, loanToken: BASE_USDC, collateralToken: `0x${"2".repeat(40)}`,
    oracle: `0x${"3".repeat(40)}`, irm: `0x${"4".repeat(40)}`, lltv: "800000000000000000",
    seizedAssets: "1000000", swapTarget: `0x${"5".repeat(40)}`, swapHops: [BASE_USDC, `0x${"2".repeat(40)}`],
    swapFees: [500], minLoanOut: "900000", principalUsdcRaw: "950000", expectedNetUsdcRaw: "10000",
    ethUsdRaw: "200000000000", routePositive: true,
  };
  const fired = { ...base, firedCount: 1, candidate: firedCandidate };
  assert.equal(watch.validateEvidence(PRODUCER_ID, "ATOMIC_FORK_REQUIRED", fired), true);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "ATOMIC_FORK_REQUIRED", { ...fired, candidate: { ...firedCandidate, loanToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" } }), false);
});

test("Morpho L Base valuation venue binds the Base Uniswap V3 deployment", () => {
  const venue = valuation.venueFor(8453);
  assert.equal(venue.factory, "0x33128a8fC17869897dcE68Ed026d694621f6FDfD");
  assert.equal(venue.quoter, "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a");
  assert.equal(venue.router, "0x2626664c2603336E57B271c5C0b26F421741e481");
  assert.equal(venue.usdc.toLowerCase(), BASE_USDC);
  // Ethereum venue is unchanged.
  assert.equal(valuation.venueFor(1).factory, valuation.UNIV3_FACTORY);
});

test("Morpho L Base valuation qualifies a direct USDC route through the Base venue", async () => {
  const CB = `0x${"b1".repeat(20)}`;
  const pools = {};
  pools[`${CB.toLowerCase()}|${BASE_USDC}|500`] = `0x${"e1".repeat(20)}`;
  const multicall = async (_rpc, _blockRef, entries) => ({
    results: entries.map((entry) => {
      if (entry.to === valuation.venueFor(8453).factory) {
        const decoded = valuation.IFACE.factory.decodeFunctionData("getPool", entry.data);
        const key = `${String(decoded[0]).toLowerCase()}|${String(decoded[1]).toLowerCase()}|${Number(decoded[2])}`;
        const pool = pools[key];
        return { success: true, returnData: valuation.IFACE.factory.encodeFunctionResult("getPool", [pool || ethers.ZeroAddress]) };
      }
      if (entry.to === valuation.venueFor(8453).quoter) {
        const decoded = valuation.IFACE.quoter.decodeFunctionData("quoteExactInputSingle", entry.data);
        const q = decoded[0];
        const out = String(q.tokenIn).toLowerCase() === CB.toLowerCase() ? 20_000_000n : null;
        if (out === null) return { success: false, returnData: "0x" };
        return { success: true, returnData: valuation.IFACE.quoter.encodeFunctionResult("quoteExactInputSingle", [out, 0n, 0, 0n]) };
      }
      return { success: true, returnData: valuation.IFACE.liquidity.encodeFunctionResult("liquidity", [10n ** 18n]) };
    }),
    failures: 0,
  });
  const result = await valuation.valuate({
    rpc: "x", blockRef: "0x1", chainId: 8453, baseFeeWei: 1_000_000_000n, ethUsdRaw: 200_000_000_000n,
    candidates: [{
      key: `0x${"a".repeat(64)}0x${"0".repeat(24)}${"b".repeat(40)}`,
      marketId: `0x${"a".repeat(64)}`, borrower: `0x${"b".repeat(40)}`,
      collateralToken: CB, loanToken: BASE_USDC, collateralRaw: "1000000", borrowedRaw: "1000000",
      oracle: `0x${"3".repeat(40)}`, irm: `0x${"4".repeat(40)}`, lltvRaw: "800000000000000000", oraclePriceRaw: "1000000000000000000000000000000000000",
    }],
    multicall,
  });
  const row = result.candidates[0];
  assert.equal(row.unwindRoute, "univ3-direct");
  assert.equal(row.valuationStatus, "QUALIFIED_VIEW");
  assert.equal(row.routePositive, true);
  assert.equal(row.quoteExecutable, false);
  assert.equal(row.swapTarget, valuation.venueFor(8453).router.toLowerCase());
  assert.deepEqual(row.swapHops, [CB.toLowerCase(), BASE_USDC]);
});

test("Morpho L Base compiled artifact is source-hash bound and reproducible", () => {
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const artifact = JSON.parse(fs.readFileSync(CONTRACT.compiled, "utf8"));
  assert.equal(artifact.chainId, 8453);
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

test("Morpho L Base scenario binds Base chain, exact pin, USDC settle, and zero-capital repayment", () => {
  const scenario = fs.readFileSync(CONTRACT.scenario, "utf8");
  const source = fs.readFileSync(CONTRACT.sol, "utf8");
  assert.match(source, /flashLoan\(plan\.loanToken, principal/u);
  assert.match(source, /onMorphoFlashLoan/u);
  assert.match(source, /liquidate\(/u);
  assert.match(source, /unwound = true/u);
  assert.match(source, /transfer\(actor, residual\)/u);
  assert.match(scenario, /module\.exports = \{ chainId: 8453, run \}/u);
  assert.match(scenario, /const ACTOR = "0x00000000000000000000000000000000000a11d0"/u);
  assert.match(scenario, /ctx\.assert\(ctx\.chainId === 8453, "base-chain"\)/u);
  assert.match(scenario, /ctx\.assert\(exactPin, "exact-pin-hash"\)/u);
  assert.match(scenario, /candidate\?\.loanToken === USDC/u);
  assert.match(scenario, /ctx\.assert\(routePositive, "net-after-actual-gas"\)/u);
});

test("Morpho L Base scenario aborts on an exact-pin mismatch before any RPC or deployment", async () => {
  const scenario = require(CONTRACT.scenario);
  const seen = [];
  const ctx = {
    chainId: 8453,
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
  assert.deepEqual(seen, ["base-chain", "exact-pin-hash"]);
  assert.equal(Object.hasOwn(ctx, "ethers"), false);
});

test("Morpho L Base read-failure accounting is per-chunk and reconciles a legacy scalar", () => {
  const scanner2 = require("./scan-morpho-blue-l");
  // A sticky legacy scalar from aborted passes is replaced by the real per-chunk
  // state, with the old count preserved as explicit evidence (never silent).
  const reconciled = scanner2.computeFailureAccounting({
    legacyFailures: 5, failedChunks: [], fetchedChunks: 3131, totalChunks: 3131,
    reconciledAt: "2026-09-20T01:21:06.117Z",
  });
  assert.equal(reconciled.failures, 0);
  assert.equal(reconciled.reconciliation.legacyFailures, 5);
  assert.equal(reconciled.reconciliation.remainingFailedChunks, 0);
  assert.equal(reconciled.reconciliation.fetchedChunks, 3131);
  assert.match(reconciled.reconciliation.reason, /subsequently fetched/u);

  // A still-missing chunk is counted honestly and claims no reconciliation.
  const pending = scanner2.computeFailureAccounting({
    legacyFailures: 0, failedChunks: [7, 9], fetchedChunks: 3129, totalChunks: 3131,
    reconciledAt: "2026-09-20T01:21:06.117Z",
  });
  assert.equal(pending.failures, 2);
  assert.equal(pending.reconciliation, null);

  // A legacy scalar with a residual missing chunk keeps the residual counted.
  const partial = scanner2.computeFailureAccounting({
    legacyFailures: 3, failedChunks: [4], fetchedChunks: 3130, totalChunks: 3131,
    reconciledAt: "2026-09-20T01:21:06.117Z",
  });
  assert.equal(partial.failures, 1);
  assert.equal(partial.reconciliation.legacyFailures, 3);
  assert.equal(partial.reconciliation.remainingFailedChunks, 1);
  assert.match(partial.reconciliation.reason, /per-chunk/u);
});

test("Morpho L Base backfill retries a failed chunk without aborting the pass", async () => {
  const os = require("node:os");
  const scanner2 = require("./scan-morpho-blue-l");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-base-backfill-"));
  try {
    const config = { ...scanner2.chainConfig(8453), deployBlock: 0 };
    const index = scanner2.emptyIndex(config);
    const indexPath = path.join(directory, "index.json");
    let attempts = 0;
    await scanner2.backfillParallel(index, {
      rpc: "x", config, finalized: 3, chunkSize: 1, concurrency: 1, indexPath, fsImpl: fs,
      fetchChunk: async (from) => {
        attempts += 1;
        if (from === 1) throw new scanner2.ScanFailure("LOG_READ_FAILED");
        return [];
      },
    });
    assert.equal(attempts, 4, "every chunk is attempted once");
    assert.equal(index.failures, 1, "only the unresolved chunk is counted");
    assert.deepEqual(index.backfill.failed, [1]);
    assert.equal(index.backfill.done.includes(1), false);
    assert.equal(index.cursor, config.deployBlock, "cursor does not advance past a missing chunk");
    // A later pass that retrieves the chunk clears the failure with no new ones.
    await scanner2.backfillParallel(index, {
      rpc: "x", config, finalized: 3, chunkSize: 1, concurrency: 1, indexPath, fsImpl: fs,
      fetchChunk: async () => [],
    });
    assert.equal(index.failures, 0);
    assert.deepEqual(index.backfill.failed, []);
    assert.equal(index.cursor, 4);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Morpho L Base producer refuses an incomplete read accounting", () => {
  const base = {
    chainId: 8453, blockNumberRaw: "1", blockHash: `0x${"c".repeat(64)}`, blockTimestamp: new Date().toISOString(),
    routeCount: 3, failedCount: 0, firedCount: 0, candidate: null,
  };
  assert.equal(watch.validateEvidence(PRODUCER_ID, "GROSS_EDGE_NET_BLOCKED", base), true);
  // The regression that aborted the scheduled publish: a non-zero failed count
  // must fail closed rather than persist an incomplete binder.
  assert.equal(watch.validateEvidence(PRODUCER_ID, "GROSS_EDGE_NET_BLOCKED", { ...base, failedCount: 5 }), false);
});

test("Morpho L Base producer fails closed on an incomplete read accounting", async () => {
  const incomplete = {
    pin: { number: 1, hash: `0x${"a".repeat(64)}`, timestamp: new Date().toISOString() },
    totals: { exactLiquidatable: 0, activeEvaluated: 1, rawDirectionalLiquidatable: 0, oracleUnavailable: 0 },
    valuation: { status: "NO_CANDIDATE", candidates: [] },
    reads: { failed: 1 },
    coverage: { complete: false },
  };
  let published = 0;
  await assert.rejects(
    () => watch.runMorphoBlueBaseL({ scanMorphoBlueBaseL: async () => incomplete, publishMorphoBlueBaseL: () => { published += 1; } }),
    (error) => error.code === "INCOMPLETE",
  );
  assert.equal(published, 1, "binder is published before the row fails closed");
  const complete = { ...incomplete, reads: { failed: 0 }, coverage: { complete: true } };
  const ok = await watch.runMorphoBlueBaseL({ scanMorphoBlueBaseL: async () => complete, publishMorphoBlueBaseL: () => {} });
  assert.equal(ok.status, "NO_GROSS_EDGE");
});
