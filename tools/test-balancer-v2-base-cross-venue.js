"use strict";

// Offline suite for the Base Balancer V2 <-> Uniswap V3 cross-venue vertical,
// mirroring tools/test-balancer-v2-eth-cross-venue.js and
// tools/test-usdc-usdt-base-cross-venue.js. No network: all RPC and fork deps are
// injected mocks. RPC endpoint material never appears in assertions or output.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const { ethers } = require("ethers");

const scanner = require("./scan-cross-dex-arbitrage");
const economics = require("./frax-usdc-cross-venue-economics");
const coverage = require("./audit-trigger-coverage-universe");
const watch = require("./run-profit-trigger-watch");
const bridge = require("./run-trigger-fork-poc");
const autopilot = require("./trigger-fork-autopilot");
const dispatcher = require("./monitor-alert-dispatcher");

const ROOT = path.resolve(__dirname, "..");
const CONTRACT = path.join(__dirname, "fork-poc", "contracts", "BalancerV2BaseAtomicRoundTrip.sol");
const COMPILED = path.join(__dirname, "fork-poc", "contracts", "BalancerV2BaseAtomicRoundTrip.compiled.json");
const SCENARIO = path.join(__dirname, "fork-poc", "triggers", "balancer-v2-base-cross-venue.js");
const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));

test("Base Balancer V2 route binds pool id, vault, coin order, and no-deadline scenario", () => {
  assert.equal(scanner.BALANCER_BASE_ROUTE.chainId, 8453);
  assert.equal(scanner.BALANCER_BASE_ROUTE.venueKind, "balancer-v2");
  assert.equal(scanner.BALANCER_BASE_V2.vault, "0xBA12222222228d8Ba445958a75a0704d566BF2C8");
  assert.equal(scanner.BALANCER_BASE_V2.poolId, "0xc205ba80bfe089f364922c3439ee952302c3cd9c000200000000000000000371");
  assert.equal(scanner.BALANCER_BASE_V2.pool, "0xc205BA80BFE089f364922c3439Ee952302C3CD9c");
  assert.deepEqual(scanner.BALANCER_BASE_V2.coins, [
    scanner.BALANCER_BASE_TOKENS.WETH.address, scanner.BALANCER_BASE_TOKENS.USDC.address,
  ]);
  assert.equal(scanner.BALANCER_BASE_TOKENS.USDC.decimals, 6);
  assert.equal(scanner.BALANCER_BASE_TOKENS.WETH.decimals, 18);
  assert.equal(scanner.BALANCER_BASE_UNISWAP.fee, 500);
  assert.equal(scanner.BALANCER_BASE_ROUTE.id, "base-balancer-v2-usdc-weth");
  assert.equal(scanner.BALANCER_BASE_V2.quoteSource, "queryBatchSwap");
  assert.equal(scanner.BALANCER_BASE_V2.quoteExecutable, true);
  assert.equal(scanner.BALANCER_BASE_V2.quoteInflationBps, undefined);
  assert.deepEqual([...scanner.BALANCER_BASE_SIZES], [10n, 25n, 50n, 100n]);
  assert.equal(scanner.BALANCER_BASE_ROUTE.uniToken0, scanner.BALANCER_BASE_TOKENS.WETH.address);
  assert.equal(scanner.BALANCER_BASE_ROUTE.uniToken1, scanner.BALANCER_BASE_TOKENS.USDC.address);
  const venueFirst = scanner.buildRouteLegs("CURVE_TO_UNIV3", scanner.BALANCER_BASE_ROUTE);
  assert.deepEqual(venueFirst.map((leg) => leg.venue), ["Balancer V2", "UniswapV3"]);
  assert.equal(venueFirst[0].curveI, 1); // USDC
  assert.equal(venueFirst[0].curveJ, 0); // WETH
  const uniFirst = scanner.buildRouteLegs("UNIV3_TO_CURVE", scanner.BALANCER_BASE_ROUTE);
  assert.deepEqual(uniFirst.map((leg) => leg.venue), ["UniswapV3", "Balancer V2"]);
  assert.equal(uniFirst[1].curveI, 0);
  assert.equal(uniFirst[1].curveJ, 1);
  const source = fs.readFileSync(CONTRACT, "utf8");
  assert.match(source, /BALANCER_POOL_ID = 0xc205ba80bfe089f364922c3439ee952302c3cd9c000200000000000000000371/u);
  assert.match(source, /struct ExactInputSingleParams \{[\s\S]*uint160 sqrtPriceLimitX96;[\s\S]*\}/u);
  assert.doesNotMatch(source, /uint256 deadline;/u);
  assert.match(source, /swap\(/u);
  assert.match(source, /flashLoan\(USDC, principal/u);
});

test("Base Balancer route keeps the shared Base priority floor and gas ceiling", () => {
  assert.equal(scanner.BALANCER_BASE_ROUTE.gasPolicy.priorityFeeWei, 100_000_000n);
  assert.equal(economics.GAS_CEILING, 2_000_000n);
});

test("Base Balancer route executes exactly eight complete rows across both directions", async () => {
  const { rpcCallImpl } = makeRpc();
  const artifact = await scanner.scan({ route: scanner.BALANCER_BASE_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.chainId, 8453);
  assert.equal(artifact.routeId, "base-balancer-v2-usdc-weth");
  assert.equal(artifact.rows.length, scanner.BALANCER_BASE_SIZES.length * 2);
  assert.equal(artifact.rows.every((row) => row.economics.status !== "FAILED"), true);
  assert.equal(artifact.routeBinding.balancer.poolId, scanner.BALANCER_BASE_V2.poolId);
  assert.equal(artifact.routeBinding.balancer.pool.toLowerCase(), scanner.BALANCER_BASE_V2.pool.toLowerCase());
  assert.equal(artifact.routeBinding.curve, undefined);
  const candidate = artifact.forkCandidates.find((row) => row.direction === "CURVE_TO_UNIV3");
  assert.equal(candidate.balancer.poolId, scanner.BALANCER_BASE_V2.poolId);
  assert.equal(candidate.curve.pool.toLowerCase(), scanner.BALANCER_BASE_V2.pool.toLowerCase());
  assert.equal(artifact.flashObservation.reads.failed, 0);
  assert.equal(artifact.flashObservation.flashFeeRaw, "0");
  assert.equal(artifact.flashObservation.protocolFeesCollector.toLowerCase(), ADDR.COLLECTOR);
  assert.equal(artifact.flashObservation.balances.length, scanner.BALANCER_BASE_V2.coins.length);
});

test("a failed Base Balancer quote leg yields FAILED economics and no fork candidates", async () => {
  const { rpcCallImpl } = makeRpc({ failQuote: true });
  const artifact = await scanner.scan({ route: scanner.BALANCER_BASE_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.rows.length, 8);
  assert.equal(artifact.rows.every((row) => row.economics.status === "FAILED"), true);
  assert.equal(artifact.forkCandidates.length, 0);
});

test("a Base Balancer pool-id mismatch rejects before any candidate", async () => {
  const { rpcCallImpl } = makeRpc({ wrongPoolId: true });
  await assert.rejects(
    () => scanner.scan({ route: scanner.BALANCER_BASE_ROUTE, rpcCall: rpcCallImpl, resolveRpc }),
    /CURVE_BINDING_MISMATCH/u,
  );
});

test("a Base Balancer coin-order mismatch rejects before any candidate", async () => {
  const { rpcCallImpl } = makeRpc({ reverseCoins: true });
  await assert.rejects(
    () => scanner.scan({ route: scanner.BALANCER_BASE_ROUTE, rpcCall: rpcCallImpl, resolveRpc }),
    /CURVE_BINDING_MISMATCH/u,
  );
});

test("Base Balancer coverage evidence maps exactly the enabled universe row", () => {
  const artifact = {
    scannedAt: new Date().toISOString(),
    pin: { number: 1, hash: `0x${"1".repeat(64)}` },
    rows: Array.from({ length: 8 }, () => ({ economics: { status: "NO_GROSS_EDGE" } })),
  };
  const rows = UNIVERSE.rows.filter((row) => row.id === "base-balancer-v2-x");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].onFire.enabled, true);
  const evidence = scanner.coverageEvidence(artifact, "Balancer V2", scanner.BALANCER_BASE_ROUTE);
  const shape = coverage.genericEvidenceShape(evidence, rows[0]);
  assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
    && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
});

test("Base Balancer producer is wired through watch, bridge, autopilot, and dispatcher", () => {
  assert.equal(watch.PRODUCER_IDS.includes("balancer-v2-base-cross-venue"), true);
  assert.deepEqual([...watch.SUCCESS_STATUSES["balancer-v2-base-cross-venue"]], ["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"]);
  assert.equal(bridge.FIXED_CHAIN["balancer-v2-base-cross-venue"], 8453);
  assert.equal(autopilot.SUPPORTED_EVENTS.get("balancer-v2-base-cross-venue"), "ATOMIC_FORK_REQUIRED");
  assert.equal(autopilot.CROSS_VENUE_PRODUCERS.has("balancer-v2-base-cross-venue"), true);
  assert.equal(dispatcher.FORK_PROMOTION_PRODUCERS.includes("balancer-v2-base-cross-venue"), true);
});

test("Base Balancer evidence validates only with the Base chain id and exact candidate keys", () => {
  const candidate = {
    routeKey: "a".repeat(64), eventId: "b".repeat(64), direction: "CURVE_TO_UNIV3",
    amountInRaw: "10000000", expectedOutRaw: "9980000", grossDeltaRaw: "1",
    gasCeilingUsdcRaw: "0", baseFeePerGasRaw: "1", ethUsdRaw: "200000000000",
    curvePool: scanner.BALANCER_BASE_V2.pool.toLowerCase(), uniPool: "0xd0b53d9277642d899df5c87a3966a349a798f224",
  };
  const evidence = {
    chainId: 8453, blockNumberRaw: "1", blockHash: `0x${"c".repeat(64)}`, blockTimestamp: new Date().toISOString(),
    routeCount: 8, failedCount: 0, firedCount: 1, candidate,
  };
  assert.equal(watch.validateEvidence("balancer-v2-base-cross-venue", "ATOMIC_FORK_REQUIRED", evidence), true);
  assert.equal(watch.validateEvidence("balancer-v2-base-cross-venue", "ATOMIC_FORK_REQUIRED", { ...evidence, chainId: 1 }), false);
  assert.equal(watch.validateEvidence("balancer-v2-base-cross-venue", "NO_GROSS_EDGE", { ...evidence, firedCount: 0, candidate: null }), true);
});

test("Base Balancer compiled artifact is source-hash bound and byte-for-byte reproducible", () => {
  const artifact = JSON.parse(fs.readFileSync(COMPILED, "utf8"));
  const source = fs.readFileSync(CONTRACT);
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  assert.equal(artifact.chainId, 8453);
  assert.equal(sha(source), artifact.sourceSha256);
  assert.equal(sha(Buffer.from(artifact.creationBytecode.slice(2), "hex")), artifact.creationBytecodeSha256);
  assert.equal(sha(Buffer.from(artifact.runtimeBytecode.slice(2), "hex")), artifact.runtimeBytecodeSha256);
  const result = childProcess.spawnSync(path.join(ROOT, artifact.compiler.path), [
    "--optimize", "--optimize-runs", "200", "--evm-version", "paris", "--metadata-hash", "none", "--combined-json", "abi,bin,bin-runtime", CONTRACT,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const built = output.contracts[Object.keys(output.contracts).find((key) => key.endsWith(":BalancerV2BaseAtomicRoundTrip"))];
  assert.equal(`0x${built.bin}`, artifact.creationBytecode);
  assert.equal(`0x${built["bin-runtime"]}`, artifact.runtimeBytecode);
});

test("Base Balancer scenario binds the chain, exact pin, funded actor, and zero-capital repayment", () => {
  const scenario = fs.readFileSync(SCENARIO, "utf8");
  const source = fs.readFileSync(CONTRACT, "utf8");
  assert.match(source, /flashLoan\(USDC, principal/u);
  assert.match(source, /onMorphoFlashLoan/u);
  assert.match(source, /bothSwapsComplete = true/u);
  assert.match(source, /transfer\(actor, residual\)/u);
  assert.match(scenario, /module\.exports = \{ chainId: 8453, run \}/u);
  assert.match(scenario, /const ACTOR = "0x00000000000000000000000000000000000a11d1"/u);
  assert.match(scenario, /const exactPin = typeof evidence\?\.blockHash === "string"/u);
  assert.match(scenario, /ctx\.assert\(ctx\.chainId === 8453, "base-chain"\)/u);
  assert.match(scenario, /ctx\.assert\(exactPin, "exact-pin-hash"\)/u);
  assert.match(scenario, /deploymentGas \* deploymentGasPrice \+ executionGas \* executionGasPrice/u);
});

test("Base Balancer scenario aborts on an exact-pin mismatch before any RPC or deployment", async () => {
  const scenario = require("./fork-poc/triggers/balancer-v2-base-cross-venue");
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

// --- injectable Base Balancer scan deps ---------------------------------------------------
const ADDR = {
  USDC: scanner.BALANCER_BASE_TOKENS.USDC.address.toLowerCase(),
  WETH: scanner.BALANCER_BASE_TOKENS.WETH.address.toLowerCase(),
  VAULT: scanner.BALANCER_BASE_V2.vault.toLowerCase(),
  BAL_POOL: scanner.BALANCER_BASE_V2.pool.toLowerCase(),
  FACTORY: scanner.BALANCER_BASE_UNISWAP.factory.toLowerCase(),
  QUOTER: scanner.BALANCER_BASE_UNISWAP.quoterV2.toLowerCase(),
  CHAINLINK: scanner.BASE_CHAINLINK.ethUsd.toLowerCase(),
  COLLECTOR: "0x3333333333333333333333333333333333333333",
  POOL: "0x2222222222222222222222222222222222222222",
};
const IFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function getPoolTokens(bytes32) view returns (address[],uint256[],uint256)",
  "function getPool(bytes32) view returns (address,uint8)",
  "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)",
  "function getPoolId() view returns (bytes32)",
  "function getVault() view returns (address)",
  "function getSwapFeePercentage() view returns (uint256)",
  "function getProtocolFeesCollector() view returns (address)",
  "function getFlashLoanFeePercentage() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function getPool(address,address,uint24) view returns (address)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint256)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const SEL = Object.fromEntries(["decimals", "getPoolTokens", "queryBatchSwap", "getPoolId", "getVault", "getSwapFeePercentage", "getProtocolFeesCollector", "getFlashLoanFeePercentage", "balanceOf", "factory", "token0", "token1", "fee", "quoteExactInputSingle", "latestRoundData"].map((name) => [name, IFACE.getFunction(name).selector]));
// `getPool` is overloaded; resolve each signature explicitly.
SEL.getPoolById = IFACE.getFunction("getPool(bytes32)").selector;
SEL.getPoolByTokens = IFACE.getFunction("getPool(address,address,uint24)").selector;
const resolveRpc = async () => "http://127.0.0.1:8545";

function makeRpc(options = {}) {
  const block = options.block || {
    number: "0x100", hash: `0x${"ab".repeat(32)}`, timestamp: "0x100000",
    baseFeePerGas: "0x3b9aca00", stateRoot: `0x${"cd".repeat(32)}`,
  };
  const oracleUpdatedAt = BigInt(block.timestamp) - 100n;
  const handleCall = (to, data) => {
    const target = String(to).toLowerCase();
    const selector = data.slice(0, 10);
    if (selector === SEL.decimals) {
      if (target === ADDR.USDC) return IFACE.encodeFunctionResult("decimals", [6]);
      if (target === ADDR.WETH) return IFACE.encodeFunctionResult("decimals", [18]);
      if (target === ADDR.CHAINLINK) return IFACE.encodeFunctionResult("decimals", [8]);
    }
    if (target === ADDR.BAL_POOL && selector === SEL.getPoolId) {
      const id = options.wrongPoolId ? `0x${"1".repeat(64)}` : scanner.BALANCER_BASE_V2.poolId;
      return IFACE.encodeFunctionResult("getPoolId", [id]);
    }
    if (target === ADDR.BAL_POOL && selector === SEL.getVault) return IFACE.encodeFunctionResult("getVault", [ADDR.VAULT]);
    if (target === ADDR.BAL_POOL && selector === SEL.getSwapFeePercentage) return IFACE.encodeFunctionResult("getSwapFeePercentage", [1_000_000_000_000_000n]);
    if (target === ADDR.VAULT && selector === SEL.getPoolTokens) {
      const order = options.reverseCoins ? [ADDR.USDC, ADDR.WETH] : [ADDR.WETH, ADDR.USDC];
      return IFACE.encodeFunctionResult("getPoolTokens", [order, [1n, 1n], 0n]);
    }
    if (target === ADDR.VAULT && selector === SEL.getProtocolFeesCollector) {
      return IFACE.encodeFunctionResult("getProtocolFeesCollector", [ADDR.COLLECTOR]);
    }
    if (target === ADDR.COLLECTOR && selector === SEL.getFlashLoanFeePercentage) {
      return IFACE.encodeFunctionResult("getFlashLoanFeePercentage", [0n]);
    }
    if ([ADDR.WETH, ADDR.USDC].includes(target) && selector === SEL.balanceOf) {
      return IFACE.encodeFunctionResult("balanceOf", [1_000_000_000_000n]);
    }
    if (target === ADDR.VAULT && selector === SEL.queryBatchSwap) {
      if (options.failQuote) throw new Error("MOCK_QUOTE_FAILURE");
      // Decode the single-swap tuple to return a correctly signed delta array:
      // the in-asset delta is positive, the out-asset delta is negative by a
      // deliberately generous output so the mocked round trip is gross positive.
      const decoded = IFACE.decodeFunctionData("queryBatchSwap", data);
      const swap = decoded[1][0];
      const outIndex = Number(swap.assetOutIndex);
      const inIndex = Number(swap.assetInIndex);
      const amount = BigInt(swap.amount);
      const deltas = [0n, 0n];
      deltas[inIndex] = amount;
      deltas[outIndex] = -(amount * 2n);
      return IFACE.encodeFunctionResult("queryBatchSwap", [deltas]);
    }
    if (target === ADDR.FACTORY && selector === SEL.getPoolByTokens) return IFACE.encodeFunctionResult("getPool(address,address,uint24)", [ADDR.POOL]);
    if (target === ADDR.POOL && selector === SEL.factory) return IFACE.encodeFunctionResult("factory", [ADDR.FACTORY]);
    if (target === ADDR.POOL && selector === SEL.token0) return IFACE.encodeFunctionResult("token0", [ADDR.WETH]);
    if (target === ADDR.POOL && selector === SEL.token1) return IFACE.encodeFunctionResult("token1", [ADDR.USDC]);
    if (target === ADDR.POOL && selector === SEL.fee) return IFACE.encodeFunctionResult("fee", [500]);
    if (target === ADDR.CHAINLINK && selector === SEL.latestRoundData) {
      return IFACE.encodeFunctionResult("latestRoundData", [2n, options.ethUsdRaw ?? 2_000n * 100_000_000n, 0n, oracleUpdatedAt, 2n]);
    }
    if (target === ADDR.QUOTER && selector === SEL.quoteExactInputSingle) {
      if (options.failQuote) throw new Error("MOCK_QUOTE_FAILURE");
      // Return a positive multiple of the input so a complete mocked round trip
      // clears the gas ceiling and yields a fork candidate.
      const decoded = IFACE.decodeFunctionData("quoteExactInputSingle", data);
      return IFACE.encodeFunctionResult("quoteExactInputSingle", [BigInt(decoded[0].amountIn) * 2n, 0n, 0, 0n]);
    }
    throw new Error(`UNROUTED_CALL ${target} ${selector}`);
  };
  const rpcCallImpl = async (url, method, params) => {
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getBlockByNumber") return block;
    if (method === "eth_getBlockByHash") return options.recheckBlock || block;
    if (method === "eth_call") return handleCall(params[0].to, params[0].data);
    throw new Error(`UNROUTED_METHOD ${method}`);
  };
  return { rpcCallImpl, block };
}
