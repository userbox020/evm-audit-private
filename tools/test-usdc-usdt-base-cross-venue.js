"use strict";

// Offline suite for the Base (8453) USDC/USDT cross-venue vertical, mirroring
// tools/test-frax-usdc-cross-venue.js. No network: all RPC and fork deps are
// injected mocks. RPC endpoint material never appears in assertions or output.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const { ethers } = require("ethers");

const scanner = require("./scan-cross-dex-arbitrage");
const coverage = require("./audit-trigger-coverage-universe");

const ROOT = path.resolve(__dirname, "..");
const CONTRACT = path.join(__dirname, "fork-poc", "contracts", "UsdcUsdtBaseAtomicRoundTrip.sol");
const COMPILED = path.join(__dirname, "fork-poc", "contracts", "UsdcUsdtBaseAtomicRoundTrip.compiled.json");
const SCENARIO = path.join(__dirname, "fork-poc", "triggers", "base-usdc-usdt-cross-venue.js");
const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));

const BASE_SIZES = scanner.BASE_SIZES;

test("Base route binds USDC/USDT ordering, decimals, fee-100, and no-deadline router scenario", () => {
  assert.deepEqual(scanner.BASE_CURVE.coins, [scanner.BASE_TOKENS.USDC.address, scanner.BASE_TOKENS.USDT.address]);
  assert.equal(scanner.BASE_TOKENS.USDC.decimals, 6);
  assert.equal(scanner.BASE_TOKENS.USDT.decimals, 6);
  assert.equal(scanner.BASE_UNISWAP.fee, 100);
  assert.equal(scanner.BASE_ROUTE.chainId, 8453);
  assert.equal(scanner.BASE_ROUTE.id, "base-usdc-usdt");
  assert.equal(scanner.BASE_CURVE.quoteSource, "get_dy");
  assert.equal(scanner.BASE_CURVE.quoteExecutable, false);
  assert.equal(scanner.BASE_SIZES.length, 4);
  const curveFirst = scanner.buildRouteLegs("CURVE_TO_UNIV3", scanner.BASE_ROUTE);
  assert.deepEqual(curveFirst.map((leg) => leg.venue), ["Curve", "UniswapV3"]);
  assert.equal(curveFirst[0].curveI, 0);
  assert.equal(curveFirst[0].curveJ, 1);
  const uniFirst = scanner.buildRouteLegs("UNIV3_TO_CURVE", scanner.BASE_ROUTE);
  assert.deepEqual(uniFirst.map((leg) => leg.venue), ["UniswapV3", "Curve"]);
  assert.equal(uniFirst[1].curveI, 1);
  assert.equal(uniFirst[1].curveJ, 0);
  const source = fs.readFileSync(CONTRACT, "utf8");
  assert.match(source, /0x2626664c2603336E57B271c5C0b26F421741e481/u);
  assert.match(source, /struct ExactInputSingleParams \{[\s\S]*uint160 sqrtPriceLimitX96;[\s\S]*\}/u);
  assert.doesNotMatch(source, /uint256 deadline/u);
  assert.match(source, /exchange\(0, 1, principal, 0\)/u);
  assert.match(source, /exchange\(1, 0, intermediate, minimumFinalUsdc\)/u);
});

test("Base route locks the conservative 0.1 gwei priority floor (never below 0.05 gwei)", () => {
  const economics = require("./frax-usdc-cross-venue-economics");
  const floor = scanner.BASE_ROUTE.gasPolicy.priorityFeeWei;
  assert.equal(floor, 100_000_000n);
  assert.ok(floor >= 50_000_000n);
  // Typical Base priority fees are 0.001-0.01 gwei; 0.1 gwei is >=~100x that.
  assert.ok(floor >= 100n * 1_000_000n);
  // Gas limit stays at the shared 2,000,000 ceiling.
  assert.equal(economics.GAS_CEILING, 2_000_000n);
  assert.equal(economics.effectiveGasPriceWei(5_000_000n, floor), 105_625_000n);
});

test("Base fire gate is boundary-exact at the route's priority floor", () => {
  const economics = require("./frax-usdc-cross-venue-economics");
  const floor = scanner.BASE_ROUTE.gasPolicy.priorityFeeWei;
  const context = {
    chainId: 8453, priorityFeeWei: floor, curvePool: scanner.BASE_CURVE.pool,
    uniPool: "0x1111111111111111111111111111111111111111",
    blockHash: `0x${"1".repeat(64)}`, baseFeeWei: 5_000_000n, ethUsdRaw: 2_000n * 100_000_000n,
  };
  const gas = economics.gasCeilingUsdcRaw(context.baseFeeWei, context.ethUsdRaw, floor);
  const make = (delta) => ({
    direction: "CURVE_TO_UNIV3", amountInRaw: "1000000000", amountOutRaw: (1_000_000_000n + delta).toString(),
    grossDeltaRaw: delta.toString(), classification: "GROSS_EDGE_FORK_REQUIRED",
  });
  assert.equal(economics.evaluateRow(make(0n), context).status, "NO_GROSS_EDGE");
  assert.equal(economics.evaluateRow(make(gas), context).status, "GROSS_EDGE_NET_BLOCKED");
  assert.equal(economics.evaluateRow(make(gas + 1n), context).status, "ATOMIC_FORK_REQUIRED");
  // A 37 bps, 1,000 USDC edge (3,685,130 raw) clears the Base floor.
  assert.equal(economics.evaluateRow(make(3_685_130n), context).status, "ATOMIC_FORK_REQUIRED");
  // The same edge under the ETH floor stays blocked.
  assert.equal(economics.evaluateRow(make(3_685_130n), { ...context, priorityFeeWei: 2_000_000_000n }).status, "GROSS_EDGE_NET_BLOCKED");
});

test("Base quote-inflation haircut suppresses the measured phantom and only suppresses", () => {
  const economics = require("./frax-usdc-cross-venue-economics");
  const floor = scanner.BASE_ROUTE.gasPolicy.priorityFeeWei;
  assert.equal(scanner.BASE_CURVE.quoteInflationBps, 60);
  const context = {
    chainId: 8453, priorityFeeWei: floor, curvePool: scanner.BASE_CURVE.pool,
    uniPool: "0x1111111111111111111111111111111111111111",
    blockHash: `0x${"1".repeat(64)}`, baseFeeWei: 5_000_000n, ethUsdRaw: 2_000n * 100_000_000n,
    quoteInflationBps: scanner.BASE_CURVE.quoteInflationBps,
  };
  const amountInRaw = 1_000_000_000n;
  const gas = economics.gasCeilingUsdcRaw(context.baseFeeWei, context.ethUsdRaw, floor);
  const haircut = economics.quoteInflationRaw(amountInRaw, 60); // ceil(1e9*60/1e4) = 6_000_000
  assert.equal(haircut, 6_000_000n);
  const make = (delta) => ({
    direction: "CURVE_TO_UNIV3", amountInRaw: amountInRaw.toString(), amountOutRaw: (amountInRaw + delta).toString(),
    grossDeltaRaw: delta.toString(), classification: "GROSS_EDGE_FORK_REQUIRED",
  });
  // The recorded Base phantom at pin 51521075 was ~+36.9 bps (3,645,285 raw) on
  // a 1,000 USDC principal. The 60 bps haircut (6,000,000 raw) turns it negative.
  const phantom = economics.evaluateRow(make(3_645_285n), context);
  assert.equal(phantom.status, "NO_GROSS_EDGE");
  assert.equal(phantom.quotedGrossDeltaRaw, "3645285");
  assert.equal(phantom.quoteInflationRaw, "6000000");
  assert.equal(phantom.quoteInflationBps, 60);
  assert.equal(phantom.grossDeltaRaw, "-2354715");
  // Without the haircut the same row is a (false) fire.
  assert.equal(economics.evaluateRow(make(3_645_285n), { ...context, quoteInflationBps: 0 }).status, "ATOMIC_FORK_REQUIRED");
  // A synthetic gross exactly at haircut+gas stays blocked; one raw unit above fires.
  const threshold = haircut + gas;
  assert.equal(economics.evaluateRow(make(threshold), context).status, "GROSS_EDGE_NET_BLOCKED");
  assert.equal(economics.evaluateRow(make(threshold + 1n), context).status, "ATOMIC_FORK_REQUIRED");
  // A zero-haircut route is byte-identical to the prior behaviour.
  assert.equal(economics.evaluateRow(make(3_645_285n), { ...context, quoteInflationBps: 0 }).grossDeltaRaw, "3645285");
});

test("Base scan artifact reports raw gross and haircut, and fork targets are effective", async () => {
  const { rpcCallImpl } = makeRpc();
  const artifact = await scanner.scan({ route: scanner.BASE_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.routeBinding.curve.quoteInflationBps, 60);
  const row = artifact.rows.find((value) => value.direction === "CURVE_TO_UNIV3" && value.amountInRaw === "1000000000");
  assert.equal(row.economics.quoteInflationBps, 60);
  assert.equal(row.economics.quoteInflationRaw, "6000000");
  assert.equal(row.economics.quotedGrossDeltaRaw, row.grossDeltaRaw);
  assert.equal(BigInt(row.economics.grossDeltaRaw), BigInt(row.grossDeltaRaw) - 6_000_000n);
  const candidate = artifact.forkCandidates.find((value) => value.direction === "CURVE_TO_UNIV3" && value.amountInRaw === "1000000000");
  // Effective fork target = quoted view output minus the haircut.
  assert.equal(BigInt(candidate.expectedOutRawAtPin), BigInt(candidate.quotedExpectedOutRawAtPin) - 6_000_000n);
  assert.equal(candidate.quoteInflationRawAtPin, "6000000");
  assert.equal(candidate.quoteInflationBps, 60);
  assert.equal(artifact.economics.rows.every((value) => typeof value.quotedGrossDeltaRaw === "string"), true);
});


test("Base route executes exactly eight complete rows across both directions", async () => {
  const { rpcCallImpl } = makeRpc();
  const artifact = await scanner.scan({ route: scanner.BASE_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.chainId, 8453);
  assert.equal(artifact.economics.gasPolicy.priorityFeeWei, "100000000");
  assert.equal(artifact.economics.gasPolicy.gasCeiling, "2000000");
  assert.equal(artifact.rows.length, BASE_SIZES.length * 2);
  assert.equal(artifact.rows.every((row) => row.economics.status !== "FAILED"), true);
  assert.deepEqual([...new Set(artifact.rows.map((row) => row.direction))].sort(), ["CURVE_TO_UNIV3", "UNIV3_TO_CURVE"]);
  assert.equal(artifact.forkCandidates.length, 8);
  const curve = artifact.forkCandidates.find((row) => row.direction === "CURVE_TO_UNIV3");
  assert.equal(curve.curve.pool.toLowerCase(), scanner.BASE_CURVE.pool.toLowerCase());
  assert.equal(curve.uniswapV3.pool.toLowerCase(), "0x1111111111111111111111111111111111111111");
});

test("a failed Base quote leg yields FAILED economics and no fork candidates", async () => {
  const { rpcCallImpl } = makeRpc({ failQuote: true });
  const artifact = await scanner.scan({ route: scanner.BASE_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.rows.length, 8);
  assert.equal(artifact.rows.every((row) => row.economics.status === "FAILED"), true);
  assert.equal(artifact.forkCandidates.length, 0);
  assert.equal(artifact.grossPositiveRows, 0);
  assert.equal(artifact.economics.fired.length, 0);
});

test("a Base pin-recheck mismatch rejects the scan before any candidate", async () => {
  const good = makeRpc();
  const accepted = await scanner.scan({ route: scanner.BASE_ROUTE, rpcCall: good.rpcCallImpl, resolveRpc });
  assert.ok(accepted.forkCandidates.length > 0);
  const wrong = makeRpc({ recheckBlock: { ...good.block, hash: `0x${"ef".repeat(32)}` } });
  await assert.rejects(
    () => scanner.scan({ route: scanner.BASE_ROUTE, rpcCall: wrong.rpcCallImpl, resolveRpc }),
    /PIN_RECHECK_FAILED/u,
  );
});

test("a Base Curve coin-order mismatch rejects before economics", async () => {
  const { rpcCallImpl } = makeRpc({ reverseCoins: true });
  await assert.rejects(
    () => scanner.scan({ route: scanner.BASE_ROUTE, rpcCall: rpcCallImpl, resolveRpc }),
    /CURVE_BINDING_MISMATCH/u,
  );
});

test("Base coverage evidence maps exactly the two approved universe rows", () => {
  const artifact = {
    scannedAt: new Date().toISOString(),
    pin: { number: 1, hash: `0x${"1".repeat(64)}` },
    rows: Array.from({ length: 8 }, () => ({ economics: { status: "NO_GROSS_EDGE" } })),
  };
  const rows = UNIVERSE.rows.filter((row) => ["base-curve-x", "base-uniswap-v3-x"].includes(row.id));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const evidence = scanner.coverageEvidence(artifact, row.family, scanner.BASE_ROUTE);
    const shape = coverage.genericEvidenceShape(evidence, row);
    assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
      && shape.stagesWired && shape.complete && shape.dispatchEnabled, true, row.id);
  }
});

test("Base compiled artifact is source-hash bound and byte-for-byte reproducible", () => {
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
  const built = output.contracts[Object.keys(output.contracts).find((key) => key.endsWith(":UsdcUsdtBaseAtomicRoundTrip"))];
  assert.equal(`0x${built.bin}`, artifact.creationBytecode);
  assert.equal(`0x${built["bin-runtime"]}`, artifact.runtimeBytecode);
});

test("Base scenario binds the Base chain, exact pin, funded actor, and zero-capital repayment", () => {
  const source = fs.readFileSync(CONTRACT, "utf8");
  const scenario = fs.readFileSync(SCENARIO, "utf8");
  assert.match(source, /flashLoan\(USDC, principal/u);
  assert.match(source, /onMorphoFlashLoan/u);
  assert.match(source, /bothSwapsComplete = true/u);
  assert.match(source, /approve\(MORPHO, principal\)/u);
  assert.match(source, /transfer\(actor, residual\)/u);
  assert.match(scenario, /module\.exports = \{ chainId: 8453, run \}/u);
  assert.match(scenario, /const ACTOR = "0x00000000000000000000000000000000000a11cf"/u);
  assert.match(scenario, /const exactPin = typeof evidence\?\.blockHash === "string"/u);
  assert.match(scenario, /ctx\.assert\(ctx\.chainId === 8453, "base-chain"\)/u);
  assert.match(scenario, /ctx\.assert\(exactPin, "exact-pin-hash"\)/u);
  assert.match(scenario, /deploymentGas \* deploymentGasPrice \+ executionGas \* executionGasPrice/u);
});

test("Base scenario aborts on an exact-pin mismatch before any RPC or deployment", async () => {
  const scenario = require("./fork-poc/triggers/base-usdc-usdt-cross-venue");
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

// --- injectable Base scan deps ------------------------------------------------------------
const ADDR = {
  USDC: scanner.BASE_TOKENS.USDC.address.toLowerCase(),
  USDT: scanner.BASE_TOKENS.USDT.address.toLowerCase(),
  CURVE: scanner.BASE_CURVE.pool.toLowerCase(),
  FACTORY: scanner.BASE_UNISWAP.factory.toLowerCase(),
  QUOTER: scanner.BASE_UNISWAP.quoterV2.toLowerCase(),
  CHAINLINK: scanner.BASE_CHAINLINK.ethUsd.toLowerCase(),
  POOL: "0x1111111111111111111111111111111111111111",
};
const IFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function coins(uint256) view returns (address)",
  "function fee() view returns (uint256)",
  "function get_dy(int128,int128,uint256) view returns (uint256)",
  "function getPool(address,address,uint24) view returns (address)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const SEL = Object.fromEntries(["decimals", "coins", "fee", "get_dy", "getPool", "factory", "token0", "token1", "quoteExactInputSingle", "latestRoundData"].map((name) => [name, IFACE.getFunction(name).selector]));
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
    if (target === ADDR.CURVE && selector === SEL.coins) {
      const index = Number(BigInt(`0x${data.slice(10, 74)}`));
      const order = options.reverseCoins ? [ADDR.USDT, ADDR.USDC] : [ADDR.USDC, ADDR.USDT];
      return IFACE.encodeFunctionResult("coins", [order[index]]);
    }
    if (target === ADDR.CURVE && selector === SEL.fee) return IFACE.encodeFunctionResult("fee", [5_000_000n]);
    if (target === ADDR.FACTORY && selector === SEL.getPool) return IFACE.encodeFunctionResult("getPool", [ADDR.POOL]);
    if (target === ADDR.POOL && selector === SEL.factory) return IFACE.encodeFunctionResult("factory", [ADDR.FACTORY]);
    if (target === ADDR.POOL && selector === SEL.token0) return IFACE.encodeFunctionResult("token0", [ADDR.USDC]);
    if (target === ADDR.POOL && selector === SEL.token1) return IFACE.encodeFunctionResult("token1", [ADDR.USDT]);
    if (target === ADDR.POOL && selector === SEL.fee) return IFACE.encodeFunctionResult("fee", [100]);
    if (target === ADDR.CHAINLINK && selector === SEL.latestRoundData) {
      return IFACE.encodeFunctionResult("latestRoundData", [2n, options.ethUsdRaw ?? 2_000n * 100_000_000n, 0n, oracleUpdatedAt, 2n]);
    }
    if (target === ADDR.CURVE && selector === SEL.get_dy) {
      if (options.failQuote) throw new Error("MOCK_QUOTE_FAILURE");
      return IFACE.encodeFunctionResult("get_dy", [options.curveOut ?? 10n ** 12n]);
    }
    if (target === ADDR.QUOTER && selector === SEL.quoteExactInputSingle) {
      if (options.failQuote) throw new Error("MOCK_QUOTE_FAILURE");
      return IFACE.encodeFunctionResult("quoteExactInputSingle", [options.uniOut ?? 10n ** 12n, 0n, 0, 0n]);
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
