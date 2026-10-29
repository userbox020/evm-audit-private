"use strict";

// Offline suite for the Ethereum Balancer V2 <-> Uniswap V3 cross-venue vertical,
// mirroring tools/test-frax-usdc-cross-venue.js and
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

const ROOT = path.resolve(__dirname, "..");
const CONTRACT = path.join(__dirname, "fork-poc", "contracts", "BalancerV2EthAtomicRoundTrip.sol");
const COMPILED = path.join(__dirname, "fork-poc", "contracts", "BalancerV2EthAtomicRoundTrip.compiled.json");
const SCENARIO = path.join(__dirname, "fork-poc", "triggers", "balancer-v2-eth-cross-venue.js");
const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));

test("Balancer V2 route binds pool id, vault, coin order, and no-deadline scenario", () => {
  assert.equal(scanner.BALANCER_ROUTE.chainId, 1);
  assert.equal(scanner.BALANCER_ROUTE.venueKind, "balancer-v2");
  assert.equal(scanner.BALANCER_V2.vault, "0xBA12222222228d8Ba445958a75a0704d566BF2C8");
  assert.equal(scanner.BALANCER_V2.poolId, "0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063");
  assert.equal(scanner.BALANCER_V2.pool, "0x06Df3b2bbB68adc8B0e302443692037ED9f91b42");
  assert.deepEqual(scanner.BALANCER_V2.coins, [
    scanner.BALANCER_TOKENS.DAI.address, scanner.BALANCER_TOKENS.USDC.address, scanner.BALANCER_TOKENS.USDT.address,
  ]);
  assert.equal(scanner.BALANCER_TOKENS.USDC.decimals, 6);
  assert.equal(scanner.BALANCER_TOKENS.USDT.decimals, 6);
  assert.equal(scanner.BALANCER_UNISWAP.fee, 100);
  assert.equal(scanner.BALANCER_ROUTE.id, "ethereum-balancer-v2-usdc-usdt");
  assert.equal(scanner.BALANCER_V2.quoteSource, "queryBatchSwap");
  assert.equal(scanner.BALANCER_V2.quoteExecutable, true);
  assert.equal(scanner.BALANCER_V2.quoteInflationBps, undefined);
  assert.equal(scanner.BALANCER_SIZES.length, 4);
  const venueFirst = scanner.buildRouteLegs("CURVE_TO_UNIV3", scanner.BALANCER_ROUTE);
  assert.deepEqual(venueFirst.map((leg) => leg.venue), ["Balancer V2", "UniswapV3"]);
  assert.equal(venueFirst[0].curveI, 1); // USDC
  assert.equal(venueFirst[0].curveJ, 2); // USDT
  const uniFirst = scanner.buildRouteLegs("UNIV3_TO_CURVE", scanner.BALANCER_ROUTE);
  assert.deepEqual(uniFirst.map((leg) => leg.venue), ["UniswapV3", "Balancer V2"]);
  assert.equal(uniFirst[1].curveI, 2);
  assert.equal(uniFirst[1].curveJ, 1);
  const source = fs.readFileSync(CONTRACT, "utf8");
  assert.match(source, /BALANCER_POOL_ID = 0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063/u);
  assert.match(source, /struct ExactInputSingleParams \{[\s\S]*uint256 deadline;[\s\S]*\}/u);
  assert.match(source, /swap\(/u);
  assert.match(source, /flashLoan\(USDC, principal/u);
});

test("Balancer route keeps the shared 2 gwei priority floor and gas ceiling", () => {
  assert.equal(scanner.BALANCER_ROUTE.gasPolicy.priorityFeeWei, 2_000_000_000n);
  assert.equal(economics.GAS_CEILING, 2_000_000n);
  assert.equal(economics.effectiveGasPriceWei(5_000_000n), 2_005_625_000n);
});

test("Curve routes keep byte-identical selectors while Balancer adds its own", () => {
  const curveSelectors = scanner.selectors(scanner.ETH_ROUTE);
  assert.deepEqual(Object.keys(curveSelectors).sort(), [
    "curveCoins", "curveFee", "curveGetDy", "factoryGetPool", "quoterV2ExactInputSingle",
  ]);
  const balancerSelectors = scanner.selectors(scanner.BALANCER_ROUTE);
  assert.deepEqual(Object.keys(balancerSelectors).sort(), [
    "balancerGetPoolTokens", "balancerQueryBatchSwap", "curveCoins", "curveFee", "curveGetDy",
    "factoryGetPool", "quoterV2ExactInputSingle",
  ]);
});

test("Balancer route executes exactly eight complete rows across both directions", async () => {
  const { rpcCallImpl } = makeRpc();
  const artifact = await scanner.scan({ route: scanner.BALANCER_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.chainId, 1);
  assert.equal(artifact.routeId, "ethereum-balancer-v2-usdc-usdt");
  assert.equal(artifact.rows.length, scanner.BALANCER_SIZES.length * 2);
  assert.equal(artifact.rows.every((row) => row.economics.status !== "FAILED"), true);
  assert.equal(artifact.routeBinding.balancer.poolId, scanner.BALANCER_V2.poolId);
  assert.equal(artifact.routeBinding.balancer.pool.toLowerCase(), scanner.BALANCER_V2.pool.toLowerCase());
  assert.equal(artifact.routeBinding.curve, undefined);
  const candidate = artifact.forkCandidates.find((row) => row.direction === "CURVE_TO_UNIV3");
  assert.equal(candidate.balancer.poolId, scanner.BALANCER_V2.poolId);
  assert.equal(candidate.curve.pool.toLowerCase(), scanner.BALANCER_V2.pool.toLowerCase());
  assert.equal(artifact.flashObservation.reads.failed, 0);
  assert.equal(artifact.flashObservation.flashFeeRaw, "0");
  assert.equal(artifact.flashObservation.protocolFeesCollector.toLowerCase(), ADDR.COLLECTOR);
  assert.equal(artifact.flashObservation.balances.length, scanner.BALANCER_V2.coins.length);
});

test("a failed Balancer quote leg yields FAILED economics and no fork candidates", async () => {
  const { rpcCallImpl } = makeRpc({ failQuote: true });
  const artifact = await scanner.scan({ route: scanner.BALANCER_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.rows.length, 8);
  assert.equal(artifact.rows.every((row) => row.economics.status === "FAILED"), true);
  assert.equal(artifact.forkCandidates.length, 0);
});

test("a Balancer pool-id mismatch rejects before any candidate", async () => {
  const { rpcCallImpl } = makeRpc({ wrongPoolId: true });
  await assert.rejects(
    () => scanner.scan({ route: scanner.BALANCER_ROUTE, rpcCall: rpcCallImpl, resolveRpc }),
    /CURVE_BINDING_MISMATCH/u,
  );
});

test("a Balancer coin-order mismatch rejects before any candidate", async () => {
  const { rpcCallImpl } = makeRpc({ reverseCoins: true });
  await assert.rejects(
    () => scanner.scan({ route: scanner.BALANCER_ROUTE, rpcCall: rpcCallImpl, resolveRpc }),
    /CURVE_BINDING_MISMATCH/u,
  );
});

test("Balancer coverage evidence maps exactly the enabled universe row", () => {
  const artifact = {
    scannedAt: new Date().toISOString(),
    pin: { number: 1, hash: `0x${"1".repeat(64)}` },
    rows: Array.from({ length: 8 }, () => ({ economics: { status: "NO_GROSS_EDGE" } })),
  };
  const rows = UNIVERSE.rows.filter((row) => row.id === "ethereum-balancer-v2-x");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].onFire.enabled, true);
  const evidence = scanner.coverageEvidence(artifact, "Balancer V2", scanner.BALANCER_ROUTE);
  const shape = coverage.genericEvidenceShape(evidence, rows[0]);
  assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
    && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
});

test("Balancer flash-liquidity/fee evidence maps exactly the enabled F universe row", () => {
  const artifact = {
    scannedAt: new Date().toISOString(),
    pin: { number: 1, hash: `0x${"1".repeat(64)}` },
    flashObservation: {
      protocolFeesCollector: "0x2222222222222222222222222222222222222222",
      flashFeeRaw: "0",
      flashFeeBps: 0,
      balances: scanner.BALANCER_V2.coins.map((token) => ({ token, balanceRaw: "1" })),
      reads: {
        attempted: scanner.BALANCER_V2.coins.length + 1,
        succeeded: scanner.BALANCER_V2.coins.length + 1,
        failed: 0,
        unclassifiedFailures: 0,
      },
      errors: [],
    },
  };
  const rows = UNIVERSE.rows.filter((row) => row.id === "ethereum-balancer-v2-f");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].onFire.enabled, true);
  assert.equal(rows[0].artifactPath, "reports/monitor/trigger-coverage/balancer-v2-ethereum-f.json");
  assert.equal(rows[0].enumerationRef, scanner.FLASH_COVERAGE_REF);
  const evidence = scanner.flashCoverageEvidence(artifact, scanner.BALANCER_ROUTE);
  const shape = coverage.genericEvidenceShape(evidence, rows[0]);
  assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
    && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
});

test("base-balancer-v2-x is enabled and wired", () => {
  const row = UNIVERSE.rows.find((value) => value.id === "base-balancer-v2-x");
  assert.equal(row.onFire.enabled, true);
  assert.equal(row.chainId, 8453);
  assert.equal(row.artifactPath, "reports/monitor/trigger-coverage/balancer-v2-base-x.json");
});

test("base-balancer-v2-f is enabled and wired to the flash binder", () => {
  const row = UNIVERSE.rows.find((value) => value.id === "base-balancer-v2-f");
  assert.equal(row.onFire.enabled, true);
  assert.equal(row.chainId, 8453);
  assert.equal(row.artifactPath, "reports/monitor/trigger-coverage/balancer-v2-base-f.json");
  assert.equal(row.enumerationRef, scanner.FLASH_COVERAGE_REF);
});

test("Balancer compiled artifact is source-hash bound and byte-for-byte reproducible", () => {
  const artifact = JSON.parse(fs.readFileSync(COMPILED, "utf8"));
  const source = fs.readFileSync(CONTRACT);
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  assert.equal(artifact.chainId, 1);
  assert.equal(sha(source), artifact.sourceSha256);
  assert.equal(sha(Buffer.from(artifact.creationBytecode.slice(2), "hex")), artifact.creationBytecodeSha256);
  assert.equal(sha(Buffer.from(artifact.runtimeBytecode.slice(2), "hex")), artifact.runtimeBytecodeSha256);
  const result = childProcess.spawnSync(path.join(ROOT, artifact.compiler.path), [
    "--optimize", "--optimize-runs", "200", "--evm-version", "paris", "--metadata-hash", "none", "--combined-json", "abi,bin,bin-runtime", CONTRACT,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const built = output.contracts[Object.keys(output.contracts).find((key) => key.endsWith(":BalancerV2EthAtomicRoundTrip"))];
  assert.equal(`0x${built.bin}`, artifact.creationBytecode);
  assert.equal(`0x${built["bin-runtime"]}`, artifact.runtimeBytecode);
});

test("Balancer scenario binds the chain, exact pin, funded actor, and zero-capital repayment", () => {
  const scenario = fs.readFileSync(SCENARIO, "utf8");
  const source = fs.readFileSync(CONTRACT, "utf8");
  assert.match(source, /flashLoan\(USDC, principal/u);
  assert.match(source, /onMorphoFlashLoan/u);
  assert.match(source, /bothSwapsComplete = true/u);
  assert.match(source, /transfer\(actor, residual\)/u);
  assert.match(scenario, /module\.exports = \{ chainId: 1, run \}/u);
  assert.match(scenario, /const ACTOR = "0x00000000000000000000000000000000000a11d0"/u);
  assert.match(scenario, /const exactPin = typeof evidence\?\.blockHash === "string"/u);
  assert.match(scenario, /ctx\.assert\(ctx\.chainId === 1, "ethereum-chain"\)/u);
  assert.match(scenario, /ctx\.assert\(exactPin, "exact-pin-hash"\)/u);
  assert.match(scenario, /deploymentGas \* deploymentGasPrice \+ executionGas \* executionGasPrice/u);
});

test("Balancer scenario aborts on an exact-pin mismatch before any RPC or deployment", async () => {
  const scenario = require("./fork-poc/triggers/balancer-v2-eth-cross-venue");
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

function makePoolBindingContext(uniPool) {
  const seen = [];
  const counts = { ethers: 0, calls: 0, deploys: 0, sends: 0, mutations: 0 };
  const sentinel = new Error("POOL_BINDING_ETHERS_SENTINEL");
  const refusal = Object.assign(new Error("SCENARIO_ASSERT_FAILED"), {
    code: "SCENARIO_ASSERT_FAILED",
  });
  const tripwire = (counter) => () => {
    counts[counter] += 1;
    throw new Error(`Unexpected pool-binding side effect: ${counter}`);
  };
  const ctx = {
    chainId: 1,
    blockHash: `0x${"ab".repeat(32)}`,
    input: {
      blockHash: `0x${"ab".repeat(32)}`,
      candidate: {
        curvePool: "0x06Df3b2bbB68adc8B0e302443692037ED9f91b42",
        uniPool,
        eventId: "1".repeat(64),
      },
    },
    fatal: false,
    assert(condition, label) {
      const pass = condition === true;
      seen.push({ label, pass });
      if (!pass && this.fatal) throw refusal;
      return pass;
    },
    get ethers() {
      counts.ethers += 1;
      throw sentinel;
    },
    call: tripwire("calls"),
    deploy: tripwire("deploys"),
    send: tripwire("sends"),
    setBalance: tripwire("mutations"),
  };
  return { ctx, seen, counts, sentinel, refusal };
}

test("Balancer scenario accepts corrected USDC/USDT fee100 pool binding", async () => {
  const scenario = require("./fork-poc/triggers/balancer-v2-eth-cross-venue");
  // Deliberately different casing from the scenario's fixed pool literal.
  const { ctx, seen, counts, sentinel } = makePoolBindingContext(
    "0x3416Cf6c708dA44db2624d63EA0aaEF7113527c6",
  );
  await assert.rejects(() => scenario.run(ctx), (error) => error === sentinel);
  assert.equal(ctx.fatal, true);
  assert.deepEqual(seen, [
    { label: "ethereum-chain", pass: true },
    { label: "exact-pin-hash", pass: true },
    { label: "balancer-pool-bound", pass: true },
    { label: "uni-pool-bound", pass: true },
    { label: "event-id-bound", pass: true },
  ]);
  assert.deepEqual(counts, {
    ethers: 1, calls: 0, deploys: 0, sends: 0, mutations: 0,
  });
});

test("Balancer scenario rejects legacy WETH/USDT fee500 pool binding", async () => {
  const scenario = require("./fork-poc/triggers/balancer-v2-eth-cross-venue");
  const { ctx, seen, counts, refusal } = makePoolBindingContext(
    "0x11b815efB8f581194ae79006d24E0d814B7697F6",
  );
  await assert.rejects(() => scenario.run(ctx), (error) => error === refusal);
  assert.equal(ctx.fatal, true);
  assert.deepEqual(seen, [
    { label: "ethereum-chain", pass: true },
    { label: "exact-pin-hash", pass: true },
    { label: "balancer-pool-bound", pass: true },
    { label: "uni-pool-bound", pass: false },
  ]);
  assert.deepEqual(counts, {
    ethers: 0, calls: 0, deploys: 0, sends: 0, mutations: 0,
  });
});

// --- injectable Balancer scan deps --------------------------------------------------------
const ADDR = {
  USDC: scanner.BALANCER_TOKENS.USDC.address.toLowerCase(),
  USDT: scanner.BALANCER_TOKENS.USDT.address.toLowerCase(),
  DAI: scanner.BALANCER_TOKENS.DAI.address.toLowerCase(),
  VAULT: scanner.BALANCER_V2.vault.toLowerCase(),
  BAL_POOL: scanner.BALANCER_V2.pool.toLowerCase(),
  FACTORY: scanner.BALANCER_UNISWAP.factory.toLowerCase(),
  QUOTER: scanner.BALANCER_UNISWAP.quoterV2.toLowerCase(),
  CHAINLINK: scanner.CHAINLINK.ethUsd.toLowerCase(),
  COLLECTOR: "0x2222222222222222222222222222222222222222",
  POOL: "0x1111111111111111111111111111111111111111",
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
      if (target === ADDR.USDT) return IFACE.encodeFunctionResult("decimals", [6]);
      if (target === ADDR.CHAINLINK) return IFACE.encodeFunctionResult("decimals", [8]);
    }
    if (target === ADDR.BAL_POOL && selector === SEL.getPoolId) {
      const id = options.wrongPoolId ? `0x${"1".repeat(64)}` : scanner.BALANCER_V2.poolId;
      return IFACE.encodeFunctionResult("getPoolId", [id]);
    }
    if (target === ADDR.BAL_POOL && selector === SEL.getVault) return IFACE.encodeFunctionResult("getVault", [ADDR.VAULT]);
    if (target === ADDR.BAL_POOL && selector === SEL.getSwapFeePercentage) return IFACE.encodeFunctionResult("getSwapFeePercentage", [50_000_000_000_000n]);
    if (target === ADDR.VAULT && selector === SEL.getPoolTokens) {
      const order = options.reverseCoins ? [ADDR.USDT, ADDR.USDC, ADDR.DAI] : [ADDR.DAI, ADDR.USDC, ADDR.USDT];
      return IFACE.encodeFunctionResult("getPoolTokens", [order, [1n, 1n, 1n], 0n]);
    }
    if (target === ADDR.VAULT && selector === SEL.getProtocolFeesCollector) {
      return IFACE.encodeFunctionResult("getProtocolFeesCollector", [ADDR.COLLECTOR]);
    }
    if (target === ADDR.COLLECTOR && selector === SEL.getFlashLoanFeePercentage) {
      return IFACE.encodeFunctionResult("getFlashLoanFeePercentage", [0n]);
    }
    if ([ADDR.DAI, ADDR.USDC, ADDR.USDT].includes(target) && selector === SEL.balanceOf) {
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
      const deltas = [0n, 0n, 0n];
      deltas[inIndex] = amount;
      deltas[outIndex] = -(amount * 2n);
      return IFACE.encodeFunctionResult("queryBatchSwap", [deltas]);
    }
    if (target === ADDR.FACTORY && selector === SEL.getPoolByTokens) return IFACE.encodeFunctionResult("getPool(address,address,uint24)", [ADDR.POOL]);
    if (target === ADDR.POOL && selector === SEL.factory) return IFACE.encodeFunctionResult("factory", [ADDR.FACTORY]);
    if (target === ADDR.POOL && selector === SEL.token0) return IFACE.encodeFunctionResult("token0", [ADDR.USDC]);
    if (target === ADDR.POOL && selector === SEL.token1) return IFACE.encodeFunctionResult("token1", [ADDR.USDT]);
    if (target === ADDR.POOL && selector === SEL.fee) return IFACE.encodeFunctionResult("fee", [100]);
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
