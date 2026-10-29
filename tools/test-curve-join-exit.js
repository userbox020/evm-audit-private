"use strict";

// Offline suite for the Curve LP mint/redeem (R class) vertical on Ethereum
// FraxBP and Base StableSwap-NG, mirroring tools/test-balancer-v2-eth-join-exit.js.
// No network: all RPC and fork deps are injected mocks.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const { ethers } = require("ethers");

const scanner = require("./scan-curve-join-exit");
const economics = require("./frax-usdc-cross-venue-economics");
const coverage = require("./audit-trigger-coverage-universe");
const watch = require("./run-profit-trigger-watch");
const bridge = require("./run-trigger-fork-poc");
const autopilot = require("./trigger-fork-autopilot");
const dispatcher = require("./monitor-alert-dispatcher");

const ROOT = path.resolve(__dirname, "..");
const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));

const CONTRACTS = {
  1: {
    name: "CurveEthJoinExitRoundTrip",
    sol: path.join(__dirname, "fork-poc", "contracts", "CurveEthJoinExitRoundTrip.sol"),
    compiled: path.join(__dirname, "fork-poc", "contracts", "CurveEthJoinExitRoundTrip.compiled.json"),
    scenario: path.join(__dirname, "fork-poc", "triggers", "curve-eth-join-exit.js"),
  },
  8453: {
    name: "CurveBaseJoinExitRoundTrip",
    sol: path.join(__dirname, "fork-poc", "contracts", "CurveBaseJoinExitRoundTrip.sol"),
    compiled: path.join(__dirname, "fork-poc", "contracts", "CurveBaseJoinExitRoundTrip.compiled.json"),
    scenario: path.join(__dirname, "fork-poc", "triggers", "curve-base-join-exit.js"),
  },
};

test("Curve mint/redeem routes bind pool, LP token, coin order, and sizes", () => {
  assert.equal(scanner.CURVE_ETH_ROUTE.chainId, 1);
  assert.equal(scanner.CURVE_ETH_ROUTE.venueKind, "curve-join-exit");
  assert.equal(scanner.CURVE_ETH_ROUTE.pool, "0xDcEF968d416a41Cdac0ED8702fAC8128A64241A2");
  assert.equal(scanner.CURVE_ETH_ROUTE.lpToken, "0x3175Df0976dFA876431C2E9eE6Bc45b65d3473CC");
  assert.deepEqual(scanner.CURVE_ETH_ROUTE.coins, [scanner.TOKENS.FRAX.address, scanner.TOKENS.USDC.address]);
  assert.deepEqual([...scanner.CURVE_ETH_ROUTE.sizes], [100n, 1_000n, 10_000n, 100_000n]);
  assert.equal(scanner.CURVE_ETH_ROUTE.quoteExecutable, false);
  assert.equal(scanner.CURVE_ETH_ROUTE.quoteInflationBps, 2);
  assert.deepEqual(scanner.CURVE_ETH_ROUTE.directions.map((d) => d.id), ["ADD_REMOVE_FRAX", "ADD_REMOVE_USDC"]);

  assert.equal(scanner.CURVE_BASE_ROUTE.chainId, 8453);
  assert.equal(scanner.CURVE_BASE_ROUTE.pool, "0x335BE1a364eA7f5DA30AaaF062103AB91bF44dD0");
  assert.equal(scanner.CURVE_BASE_ROUTE.lpToken, scanner.CURVE_BASE_ROUTE.pool);
  assert.deepEqual(scanner.CURVE_BASE_ROUTE.coins, [scanner.BASE_TOKENS.USDC.address, scanner.BASE_TOKENS.USDT.address]);
  assert.deepEqual([...scanner.CURVE_BASE_ROUTE.sizes], [100n, 1_000n, 10_000n]);
  assert.equal(scanner.CURVE_BASE_ROUTE.quoteExecutable, true);
  assert.equal(scanner.CURVE_BASE_ROUTE.quoteInflationBps, undefined);
  assert.deepEqual(scanner.CURVE_BASE_ROUTE.directions.map((d) => d.id), ["ADD_REMOVE_USDC", "ADD_REMOVE_USDT"]);
});

test("Curve routes keep the per-chain priority floors", () => {
  assert.equal(scanner.CURVE_ETH_ROUTE.gasPolicy.priorityFeeWei, 2_000_000_000n);
  assert.equal(scanner.CURVE_BASE_ROUTE.gasPolicy.priorityFeeWei, 100_000_000n);
  assert.equal(economics.GAS_CEILING, 2_000_000n);
});

test("Curve mint/redeem ETH scan executes exactly eight complete rows", async () => {
  const { rpcCallImpl } = makeRpc(1);
  const artifact = await scanner.scan({ route: scanner.CURVE_ETH_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.chainId, 1);
  assert.equal(artifact.routeId, "ethereum-curve-mint-redeem");
  assert.equal(artifact.rows.length, 8);
  assert.equal(artifact.rows.every((row) => row.economics.status !== "FAILED"), true);
  assert.equal(artifact.routeBinding.curve.pool, scanner.CURVE_ETH_ROUTE.pool);
  assert.equal(artifact.routeBinding.curve.lpToken, scanner.CURVE_ETH_ROUTE.lpToken);
  assert.equal(artifact.routeBinding.curve.quoteInflationBps, 2);
  const candidate = artifact.forkCandidates.find((row) => row.direction === "ADD_REMOVE_FRAX");
  assert.equal(candidate.pool.toLowerCase(), scanner.CURVE_ETH_ROUTE.pool.toLowerCase());
  assert.equal(candidate.lpToken.toLowerCase(), scanner.CURVE_ETH_ROUTE.lpToken.toLowerCase());
});

test("Curve mint/redeem Base scan executes exactly six complete rows", async () => {
  const { rpcCallImpl } = makeRpc(8453);
  const artifact = await scanner.scan({ route: scanner.CURVE_BASE_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.chainId, 8453);
  assert.equal(artifact.routeId, "base-curve-mint-redeem");
  assert.equal(artifact.rows.length, 6);
  assert.equal(artifact.rows.every((row) => row.economics.status !== "FAILED"), true);
  assert.equal(artifact.routeBinding.curve.quoteInflationBps, undefined);
  const candidate = artifact.forkCandidates.find((row) => row.direction === "ADD_REMOVE_USDC");
  assert.equal(candidate.lpToken.toLowerCase(), scanner.CURVE_BASE_ROUTE.pool.toLowerCase());
});

test("a failed Curve quote yields FAILED economics and no fork candidates", async () => {
  for (const [chainId, route, count] of [[1, scanner.CURVE_ETH_ROUTE, 8], [8453, scanner.CURVE_BASE_ROUTE, 6]]) {
    const { rpcCallImpl } = makeRpc(chainId, { failQuote: true });
    const artifact = await scanner.scan({ route, rpcCall: rpcCallImpl, resolveRpc });
    assert.equal(artifact.rows.length, count);
    assert.equal(artifact.rows.every((row) => row.economics.status === "FAILED"), true);
    assert.equal(artifact.forkCandidates.length, 0);
  }
});

test("a Curve coin-order mismatch rejects before any candidate", async () => {
  const { rpcCallImpl } = makeRpc(1, { reverseCoins: true });
  await assert.rejects(
    () => scanner.scan({ route: scanner.CURVE_ETH_ROUTE, rpcCall: rpcCallImpl, resolveRpc }),
    /CURVE_BINDING_MISMATCH/u,
  );
});

test("Curve mint/redeem coverage evidence maps exactly the enabled universe rows", () => {
  for (const [route, id, rows] of [[scanner.CURVE_ETH_ROUTE, "ethereum-curve-r", 8], [scanner.CURVE_BASE_ROUTE, "base-curve-r", 6]]) {
    const artifact = {
      scannedAt: new Date().toISOString(),
      pin: { number: 1, hash: `0x${"1".repeat(64)}` },
      rows: Array.from({ length: rows }, () => ({ economics: { status: "NO_GROSS_EDGE" } })),
    };
    const universeRows = UNIVERSE.rows.filter((row) => row.id === id);
    assert.equal(universeRows.length, 1);
    assert.equal(universeRows[0].onFire.enabled, true);
    assert.equal(universeRows[0].triggerClass, "R");
    assert.equal(universeRows[0].artifactPath, `reports/monitor/trigger-coverage/curve-${route.chainId === 1 ? "ethereum" : "base"}-r.json`);
    const evidence = scanner.coverageEvidence(artifact, "Curve", route);
    const shape = coverage.genericEvidenceShape(evidence, universeRows[0]);
    assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
      && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
  }
});

test("Curve mint/redeem producers are wired through watch, bridge, autopilot, and dispatcher", () => {
  for (const id of ["curve-eth-join-exit", "curve-base-join-exit"]) {
    assert.equal(watch.PRODUCER_IDS.includes(id), true);
    assert.deepEqual([...watch.SUCCESS_STATUSES[id]], ["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"]);
    assert.equal(autopilot.SUPPORTED_EVENTS.get(id), "ATOMIC_FORK_REQUIRED");
    assert.equal(autopilot.CROSS_VENUE_PRODUCERS.has(id), true);
    assert.equal(dispatcher.FORK_PROMOTION_PRODUCERS.includes(id), true);
  }
  assert.equal(bridge.FIXED_CHAIN["curve-eth-join-exit"], 1);
  assert.equal(bridge.FIXED_CHAIN["curve-base-join-exit"], 8453);
});

test("Curve mint/redeem evidence validates per chain, rows, and directions", () => {
  const ethCandidate = {
    routeKey: "a".repeat(64), eventId: "b".repeat(64), direction: "ADD_REMOVE_FRAX",
    amountInRaw: "100000000", expectedOutRaw: "103000000", grossDeltaRaw: "3000000",
    gasCeilingUsdcRaw: "2000000", baseFeePerGasRaw: "1000000000", ethUsdRaw: "200000000000",
    pool: scanner.CURVE_ETH_ROUTE.pool.toLowerCase(), lpToken: scanner.CURVE_ETH_ROUTE.lpToken.toLowerCase(),
  };
  const ethEvidence = {
    chainId: 1, blockNumberRaw: "1", blockHash: `0x${"c".repeat(64)}`, blockTimestamp: new Date().toISOString(),
    routeCount: 8, failedCount: 0, firedCount: 1, candidate: ethCandidate,
  };
  assert.equal(watch.validateEvidence("curve-eth-join-exit", "ATOMIC_FORK_REQUIRED", ethEvidence), true);
  assert.equal(watch.validateEvidence("curve-eth-join-exit", "ATOMIC_FORK_REQUIRED", { ...ethEvidence, chainId: 8453 }), false);
  assert.equal(watch.validateEvidence("curve-eth-join-exit", "ATOMIC_FORK_REQUIRED", { ...ethEvidence, candidate: { ...ethCandidate, direction: "ADD_REMOVE_USDT" } }), false);
  assert.equal(watch.validateEvidence("curve-eth-join-exit", "NO_GROSS_EDGE", { ...ethEvidence, firedCount: 0, candidate: null }), true);

  const baseEvidence = {
    chainId: 8453, blockNumberRaw: "1", blockHash: `0x${"c".repeat(64)}`, blockTimestamp: new Date().toISOString(),
    routeCount: 6, failedCount: 0, firedCount: 1,
    candidate: { ...ethCandidate, direction: "ADD_REMOVE_USDT", pool: scanner.CURVE_BASE_ROUTE.pool.toLowerCase(), lpToken: scanner.CURVE_BASE_ROUTE.pool.toLowerCase() },
  };
  assert.equal(watch.validateEvidence("curve-base-join-exit", "ATOMIC_FORK_REQUIRED", baseEvidence), true);
  assert.equal(watch.validateEvidence("curve-base-join-exit", "ATOMIC_FORK_REQUIRED", { ...baseEvidence, routeCount: 8 }), false);
});

test("Curve mint/redeem compiled artifacts are source-hash bound and reproducible", () => {
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  for (const chainId of [1, 8453]) {
    const spec = CONTRACTS[chainId];
    const artifact = JSON.parse(fs.readFileSync(spec.compiled, "utf8"));
    assert.equal(artifact.chainId, chainId);
    assert.equal(sha(fs.readFileSync(spec.sol)), artifact.sourceSha256);
    assert.equal(sha(Buffer.from(artifact.creationBytecode.slice(2), "hex")), artifact.creationBytecodeSha256);
    assert.equal(sha(Buffer.from(artifact.runtimeBytecode.slice(2), "hex")), artifact.runtimeBytecodeSha256);
    const result = childProcess.spawnSync(path.join(ROOT, artifact.compiler.path), [
      "--optimize", "--optimize-runs", "200", "--evm-version", "paris", "--metadata-hash", "none", "--combined-json", "abi,bin,bin-runtime", spec.sol,
    ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const built = output.contracts[Object.keys(output.contracts).find((key) => key.endsWith(`:${spec.name}`))];
    assert.equal(`0x${built.bin}`, artifact.creationBytecode);
    assert.equal(`0x${built["bin-runtime"]}`, artifact.runtimeBytecode);
  }
});

test("Curve mint/redeem scenarios bind chain, exact pin, funded actor, and zero-capital repayment", () => {
  for (const [chainId, contractSpec, label] of [[1, CONTRACTS[1], "ethereum"], [8453, CONTRACTS[8453], "base"]]) {
    const scenario = fs.readFileSync(contractSpec.scenario, "utf8");
    const source = fs.readFileSync(contractSpec.sol, "utf8");
    assert.match(source, /flashLoan\(token, principal/u);
    assert.match(source, /onMorphoFlashLoan/u);
    assert.match(source, /bothLegsComplete = true/u);
    assert.match(source, /add_liquidity\(/u);
    assert.match(source, /remove_liquidity_one_coin\(/u);
    assert.match(source, /transfer\(actor, residual\)/u);
    assert.match(scenario, new RegExp(`module\\.exports = \\{ chainId: ${chainId}, run \\}`, "u"));
    assert.match(scenario, /const ACTOR = "0x00000000000000000000000000000000000a11d0"/u);
    assert.match(scenario, /const exactPin = typeof evidence\?\.blockHash === "string"/u);
    assert.match(scenario, new RegExp(`ctx\\.assert\\(ctx\\.chainId === ${chainId}, "${label}-chain"\\)`, "u"));
    assert.match(scenario, /ctx\.assert\(exactPin, "exact-pin-hash"\)/u);
    assert.match(scenario, /deploymentGas \* deploymentGasPrice \+ executionGas \* executionGasPrice/u);
  }
});

test("Curve mint/redeem scenarios abort on an exact-pin mismatch before any RPC or deployment", async () => {
  for (const [chainId, contractSpec] of [[1, CONTRACTS[1]], [8453, CONTRACTS[8453]]]) {
    const scenario = require(contractSpec.scenario);
    const seen = [];
    const ctx = {
      chainId,
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
    assert.deepEqual(seen, [chainId === 1 ? "ethereum-chain" : "base-chain", "exact-pin-hash"]);
    assert.equal(Object.hasOwn(ctx, "ethers"), false);
  }
});

// --- injectable Curve scan deps ------------------------------------------------------------
const IFACE_FIXED = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function coins(uint256) view returns (address)",
  "function fee() view returns (uint256)",
  "function calc_token_amount(uint256[2] amounts,bool is_deposit) view returns (uint256)",
  "function calc_withdraw_one_coin(uint256 _token_amount,int128 i) view returns (uint256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const IFACE_DYN = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function coins(uint256) view returns (address)",
  "function fee() view returns (uint256)",
  "function calc_token_amount(uint256[] amounts,bool is_deposit) view returns (uint256)",
  "function calc_withdraw_one_coin(uint256 _token_amount,int128 i) view returns (uint256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const SEL = {
  decimals: IFACE_FIXED.getFunction("decimals").selector,
  coins: IFACE_FIXED.getFunction("coins").selector,
  fee: IFACE_FIXED.getFunction("fee").selector,
  calcFixed: IFACE_FIXED.getFunction("calc_token_amount").selector,
  calcDyn: IFACE_DYN.getFunction("calc_token_amount").selector,
  withdraw: IFACE_FIXED.getFunction("calc_withdraw_one_coin").selector,
  latestRoundData: IFACE_FIXED.getFunction("latestRoundData").selector,
};
const BPT_SCALE = 10n ** 12n;
const resolveRpc = async () => "http://127.0.0.1:8545";

function makeRpc(chainId, options = {}) {
  const route = chainId === 1 ? scanner.CURVE_ETH_ROUTE : scanner.CURVE_BASE_ROUTE;
  const iface = chainId === 1 ? IFACE_FIXED : IFACE_DYN;
  const block = options.block || {
    number: "0x100", hash: `0x${"ab".repeat(32)}`, timestamp: "0x100000",
    baseFeePerGas: "0x3b9aca00", stateRoot: `0x${"cd".repeat(32)}`,
  };
  const oracleUpdatedAt = BigInt(block.timestamp) - 100n;
  const pool = route.pool.toLowerCase();
  const lp = route.lpToken.toLowerCase();
  const coins = route.coins.map((value) => value.toLowerCase());
  const chainlink = route.chainlink.ethUsd.toLowerCase();
  const handleCall = (to, data) => {
    const target = String(to).toLowerCase();
    const selector = data.slice(0, 10);
    if (selector === SEL.decimals) {
      const index = coins.indexOf(target);
      if (index >= 0) return iface.encodeFunctionResult("decimals", [route.decimals[index]]);
      if (target === chainlink) return iface.encodeFunctionResult("decimals", [8]);
    }
    if (target === pool && selector === SEL.coins) {
      const decoded = iface.decodeFunctionData("coins", data);
      const order = options.reverseCoins ? [...coins].reverse() : coins;
      return iface.encodeFunctionResult("coins", [order[Number(decoded[0])]]);
    }
    if (target === pool && selector === SEL.fee) return iface.encodeFunctionResult("fee", [1_000_000n]);
    if (target === pool && (selector === SEL.calcFixed || selector === SEL.calcDyn)) {
      if (options.failQuote) throw new Error("MOCK_QUOTE_FAILURE");
      const decoded = iface.decodeFunctionData("calc_token_amount", data);
      const amounts = decoded[0];
      const amount = amounts.reduce((max, value) => (BigInt(value) > max ? BigInt(value) : max), 0n);
      return iface.encodeFunctionResult("calc_token_amount", [amount * BPT_SCALE]);
    }
    if (target === pool && selector === SEL.withdraw) {
      if (options.failQuote) throw new Error("MOCK_QUOTE_FAILURE");
      const decoded = iface.decodeFunctionData("calc_withdraw_one_coin", data);
      return iface.encodeFunctionResult("calc_withdraw_one_coin", [(BigInt(decoded[0]) / BPT_SCALE) * 2n]);
    }
    if (target === chainlink && selector === SEL.latestRoundData) {
      return iface.encodeFunctionResult("latestRoundData", [2n, options.ethUsdRaw ?? 2_000n * 100_000_000n, 0n, oracleUpdatedAt, 2n]);
    }
    void lp;
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
