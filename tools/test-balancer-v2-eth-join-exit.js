"use strict";

// Offline suite for the Ethereum Balancer V2 single-token BPT mint/redeem
// (R class) vertical, mirroring tools/test-balancer-v2-eth-cross-venue.js. No
// network: all RPC and fork deps are injected mocks. RPC endpoint material never
// appears in assertions or output.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const { ethers } = require("ethers");

const scanner = require("./scan-balancer-v2-join-exit");
const economics = require("./frax-usdc-cross-venue-economics");
const coverage = require("./audit-trigger-coverage-universe");
const watch = require("./run-profit-trigger-watch");
const bridge = require("./run-trigger-fork-poc");
const autopilot = require("./trigger-fork-autopilot");
const dispatcher = require("./monitor-alert-dispatcher");

const ROOT = path.resolve(__dirname, "..");
const CONTRACT = path.join(__dirname, "fork-poc", "contracts", "BalancerV2EthJoinExitRoundTrip.sol");
const COMPILED = path.join(__dirname, "fork-poc", "contracts", "BalancerV2EthJoinExitRoundTrip.compiled.json");
const SCENARIO = path.join(__dirname, "fork-poc", "triggers", "balancer-v2-eth-join-exit.js");
const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));
const ABI = ethers.AbiCoder.defaultAbiCoder();

test("Balancer mint/redeem route binds pool id, vault, queries helper, coin order, and sizes", () => {
  assert.equal(scanner.JOIN_EXIT_ROUTE.chainId, 1);
  assert.equal(scanner.JOIN_EXIT_ROUTE.venueKind, "balancer-v2-join-exit");
  assert.equal(scanner.JOIN_EXIT_POOL.vault, "0xBA12222222228d8Ba445958a75a0704d566BF2C8");
  assert.equal(scanner.JOIN_EXIT_POOL.poolId, "0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063");
  assert.equal(scanner.JOIN_EXIT_POOL.pool, "0x06Df3b2bbB68adc8B0e302443692037ED9f91b42");
  assert.deepEqual(scanner.JOIN_EXIT_POOL.coins, [
    scanner.JOIN_EXIT_TOKENS.DAI.address, scanner.JOIN_EXIT_TOKENS.USDC.address, scanner.JOIN_EXIT_TOKENS.USDT.address,
  ]);
  assert.equal(scanner.JOIN_EXIT_QUERIES.address, "0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5");
  assert.equal(scanner.JOIN_EXIT_QUERIES.quoteSource, "queryJoin+queryExit");
  assert.equal(scanner.JOIN_EXIT_QUERIES.quoteExecutable, true);
  assert.deepEqual([...scanner.SIZE], [100n, 1_000n, 10_000n]);
  assert.deepEqual(scanner.JOIN_EXIT_DIRECTIONS.map((direction) => direction.id), ["JOIN_EXIT_USDC", "JOIN_EXIT_USDT"]);
  assert.equal(scanner.JOIN_EXIT_DIRECTIONS[0].index, 1);
  assert.equal(scanner.JOIN_EXIT_DIRECTIONS[1].index, 2);
  assert.equal(scanner.JOIN_EXIT_ROUTE.coverageRef, "bounded mint/redemption observation");
});

test("Balancer mint/redeem route keeps the shared 2 gwei priority floor", () => {
  assert.equal(scanner.JOIN_EXIT_ROUTE.gasPolicy.priorityFeeWei, 2_000_000_000n);
  assert.equal(economics.GAS_CEILING, 2_000_000n);
});

test("Balancer mint/redeem route executes exactly six complete rows across both directions", async () => {
  const { rpcCallImpl } = makeRpc();
  const artifact = await scanner.scan({ route: scanner.JOIN_EXIT_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.chainId, 1);
  assert.equal(artifact.routeId, "ethereum-balancer-v2-mint-redeem");
  assert.equal(artifact.rows.length, scanner.SIZE.length * scanner.JOIN_EXIT_DIRECTIONS.length);
  assert.equal(artifact.rows.every((row) => row.economics.status !== "FAILED"), true);
  assert.equal(artifact.routeBinding.joinExit.poolId, scanner.JOIN_EXIT_POOL.poolId);
  assert.equal(artifact.routeBinding.curve, undefined);
  assert.equal(artifact.routeBinding.joinExit.queries.address, scanner.JOIN_EXIT_QUERIES.address);
  const candidate = artifact.forkCandidates.find((row) => row.direction === "JOIN_EXIT_USDC");
  assert.equal(candidate.poolId, scanner.JOIN_EXIT_POOL.poolId);
  assert.equal(candidate.pool.toLowerCase(), scanner.JOIN_EXIT_POOL.pool.toLowerCase());
  assert.equal(candidate.vault.toLowerCase(), scanner.JOIN_EXIT_POOL.vault.toLowerCase());
});

test("a failed Balancer mint/redeem quote yields FAILED economics and no fork candidates", async () => {
  const { rpcCallImpl } = makeRpc({ failQuote: true });
  const artifact = await scanner.scan({ route: scanner.JOIN_EXIT_ROUTE, rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.rows.length, 6);
  assert.equal(artifact.rows.every((row) => row.economics.status === "FAILED"), true);
  assert.equal(artifact.forkCandidates.length, 0);
});

test("a Balancer mint/redeem pool-id mismatch rejects before any candidate", async () => {
  const { rpcCallImpl } = makeRpc({ wrongPoolId: true });
  await assert.rejects(
    () => scanner.scan({ route: scanner.JOIN_EXIT_ROUTE, rpcCall: rpcCallImpl, resolveRpc }),
    /JOIN_EXIT_BINDING_MISMATCH/u,
  );
});

test("a Balancer mint/redeem coin-order mismatch rejects before any candidate", async () => {
  const { rpcCallImpl } = makeRpc({ reverseCoins: true });
  await assert.rejects(
    () => scanner.scan({ route: scanner.JOIN_EXIT_ROUTE, rpcCall: rpcCallImpl, resolveRpc }),
    /JOIN_EXIT_BINDING_MISMATCH/u,
  );
});

test("a Balancer mint/redeem queries-helper mismatch rejects before any candidate", async () => {
  const { rpcCallImpl } = makeRpc({ wrongQueriesVault: true });
  await assert.rejects(
    () => scanner.scan({ route: scanner.JOIN_EXIT_ROUTE, rpcCall: rpcCallImpl, resolveRpc }),
    /JOIN_EXIT_BINDING_MISMATCH/u,
  );
});

test("Balancer mint/redeem coverage evidence maps exactly the enabled universe row", () => {
  const artifact = {
    scannedAt: new Date().toISOString(),
    pin: { number: 1, hash: `0x${"1".repeat(64)}` },
    rows: Array.from({ length: 6 }, () => ({ economics: { status: "NO_GROSS_EDGE" } })),
  };
  const rows = UNIVERSE.rows.filter((row) => row.id === "ethereum-balancer-v2-r");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].onFire.enabled, true);
  assert.equal(rows[0].triggerClass, "R");
  assert.equal(rows[0].enumerationRef, "bounded mint/redemption observation");
  const evidence = scanner.coverageEvidence(artifact, "Balancer V2", scanner.JOIN_EXIT_ROUTE);
  const shape = coverage.genericEvidenceShape(evidence, rows[0]);
  assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
    && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
});

test("base-balancer-v2-r remains disabled (Base pool only supports proportional joins/exits)", () => {
  const row = UNIVERSE.rows.find((value) => value.id === "base-balancer-v2-r");
  assert.equal(row.onFire.enabled, false);
  assert.equal(row.triggerClass, "R");
});

test("Balancer mint/redeem producer is wired through watch, bridge, autopilot, and dispatcher", () => {
  assert.equal(watch.PRODUCER_IDS.includes("balancer-v2-eth-join-exit"), true);
  assert.deepEqual([...watch.SUCCESS_STATUSES["balancer-v2-eth-join-exit"]], ["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"]);
  assert.equal(bridge.FIXED_CHAIN["balancer-v2-eth-join-exit"], 1);
  assert.equal(autopilot.SUPPORTED_EVENTS.get("balancer-v2-eth-join-exit"), "ATOMIC_FORK_REQUIRED");
  assert.equal(autopilot.CROSS_VENUE_PRODUCERS.has("balancer-v2-eth-join-exit"), true);
  assert.equal(dispatcher.FORK_PROMOTION_PRODUCERS.includes("balancer-v2-eth-join-exit"), true);
});

test("Balancer mint/redeem evidence validates only with the chain id, pool binding, and R directions", () => {
  const candidate = {
    routeKey: "a".repeat(64), eventId: "b".repeat(64), direction: "JOIN_EXIT_USDC",
    amountInRaw: "100000000", expectedOutRaw: "103000000", grossDeltaRaw: "3000000",
    gasCeilingUsdcRaw: "2000000", baseFeePerGasRaw: "1000000000", ethUsdRaw: "200000000000",
    pool: scanner.JOIN_EXIT_POOL.pool.toLowerCase(), poolId: scanner.JOIN_EXIT_POOL.poolId,
    vault: scanner.JOIN_EXIT_POOL.vault.toLowerCase(),
  };
  const evidence = {
    chainId: 1, blockNumberRaw: "1", blockHash: `0x${"c".repeat(64)}`, blockTimestamp: new Date().toISOString(),
    routeCount: 6, failedCount: 0, firedCount: 1, candidate,
  };
  assert.equal(watch.validateEvidence("balancer-v2-eth-join-exit", "ATOMIC_FORK_REQUIRED", evidence), true);
  assert.equal(watch.validateEvidence("balancer-v2-eth-join-exit", "ATOMIC_FORK_REQUIRED", { ...evidence, chainId: 8453 }), false);
  assert.equal(watch.validateEvidence("balancer-v2-eth-join-exit", "ATOMIC_FORK_REQUIRED", { ...evidence, routeCount: 8 }), false);
  assert.equal(watch.validateEvidence("balancer-v2-eth-join-exit", "ATOMIC_FORK_REQUIRED", { ...evidence, candidate: { ...candidate, direction: "CURVE_TO_UNIV3" } }), false);
  assert.equal(watch.validateEvidence("balancer-v2-eth-join-exit", "NO_GROSS_EDGE", { ...evidence, firedCount: 0, candidate: null }), true);
});

test("Balancer mint/redeem compiled artifact is source-hash bound and byte-for-byte reproducible", () => {
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
  const built = output.contracts[Object.keys(output.contracts).find((key) => key.endsWith(":BalancerV2EthJoinExitRoundTrip"))];
  assert.equal(`0x${built.bin}`, artifact.creationBytecode);
  assert.equal(`0x${built["bin-runtime"]}`, artifact.runtimeBytecode);
});

test("Balancer mint/redeem scenario binds the chain, exact pin, funded actor, and zero-capital repayment", () => {
  const scenario = fs.readFileSync(SCENARIO, "utf8");
  const source = fs.readFileSync(CONTRACT, "utf8");
  assert.match(source, /flashLoan\(token, principal/u);
  assert.match(source, /onMorphoFlashLoan/u);
  assert.match(source, /bothLegsComplete = true/u);
  assert.match(source, /joinPool\(/u);
  assert.match(source, /exitPool\(/u);
  assert.match(source, /transfer\(actor, residual\)/u);
  assert.match(scenario, /module\.exports = \{ chainId: 1, run \}/u);
  assert.match(scenario, /const ACTOR = "0x00000000000000000000000000000000000a11d0"/u);
  assert.match(scenario, /const exactPin = typeof evidence\?\.blockHash === "string"/u);
  assert.match(scenario, /ctx\.assert\(ctx\.chainId === 1, "ethereum-chain"\)/u);
  assert.match(scenario, /ctx\.assert\(exactPin, "exact-pin-hash"\)/u);
  assert.match(scenario, /deploymentGas \* deploymentGasPrice \+ executionGas \* executionGasPrice/u);
});

test("Balancer mint/redeem scenario aborts on an exact-pin mismatch before any RPC or deployment", async () => {
  const scenario = require("./fork-poc/triggers/balancer-v2-eth-join-exit");
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

// --- injectable Balancer mint/redeem scan deps -------------------------------------------
const ADDR = {
  DAI: scanner.JOIN_EXIT_TOKENS.DAI.address.toLowerCase(),
  USDC: scanner.JOIN_EXIT_TOKENS.USDC.address.toLowerCase(),
  USDT: scanner.JOIN_EXIT_TOKENS.USDT.address.toLowerCase(),
  VAULT: scanner.JOIN_EXIT_POOL.vault.toLowerCase(),
  BAL_POOL: scanner.JOIN_EXIT_POOL.pool.toLowerCase(),
  QUERIES: scanner.JOIN_EXIT_QUERIES.address.toLowerCase(),
  CHAINLINK: scanner.JOIN_EXIT_CHAINLINK.ethUsd.toLowerCase(),
};
const IFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function getPoolTokens(bytes32) view returns (address[],uint256[],uint256)",
  "function getPoolId() view returns (bytes32)",
  "function getVault() view returns (address)",
  "function getSwapFeePercentage() view returns (uint256)",
  "function vault() view returns (address)",
  "function queryJoin(bytes32 poolId,address sender,address recipient,(address[] assets,uint256[] maxAmountsIn,bytes userData,bool fromInternalBalance) request) returns (uint256 bptOut,uint256[] amountsIn)",
  "function queryExit(bytes32 poolId,address sender,address recipient,(address[] assets,uint256[] minAmountsOut,bytes userData,bool toInternalBalance) request) returns (uint256 bptIn,uint256[] amountsOut)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const SEL = Object.fromEntries([
  "decimals", "getPoolTokens", "getPoolId", "getVault", "getSwapFeePercentage", "vault",
  "queryJoin", "queryExit", "latestRoundData",
].map((name) => [name, IFACE.getFunction(name).selector]));
const BPT_SCALE = 10n ** 12n;
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
      if (target === ADDR.DAI) return IFACE.encodeFunctionResult("decimals", [18]);
      if (target === ADDR.USDC) return IFACE.encodeFunctionResult("decimals", [6]);
      if (target === ADDR.USDT) return IFACE.encodeFunctionResult("decimals", [6]);
      if (target === ADDR.CHAINLINK) return IFACE.encodeFunctionResult("decimals", [8]);
    }
    if (target === ADDR.BAL_POOL && selector === SEL.getPoolId) {
      const id = options.wrongPoolId ? `0x${"1".repeat(64)}` : scanner.JOIN_EXIT_POOL.poolId;
      return IFACE.encodeFunctionResult("getPoolId", [id]);
    }
    if (target === ADDR.BAL_POOL && selector === SEL.getVault) return IFACE.encodeFunctionResult("getVault", [ADDR.VAULT]);
    if (target === ADDR.BAL_POOL && selector === SEL.getSwapFeePercentage) return IFACE.encodeFunctionResult("getSwapFeePercentage", [50_000_000_000_000n]);
    if (target === ADDR.VAULT && selector === SEL.getPoolTokens) {
      const order = options.reverseCoins ? [ADDR.USDT, ADDR.USDC, ADDR.DAI] : [ADDR.DAI, ADDR.USDC, ADDR.USDT];
      return IFACE.encodeFunctionResult("getPoolTokens", [order, [1n, 1n, 1n], 0n]);
    }
    if (target === ADDR.QUERIES && selector === SEL.vault) {
      const vault = options.wrongQueriesVault ? "0x1111111111111111111111111111111111111111" : ADDR.VAULT;
      return IFACE.encodeFunctionResult("vault", [vault]);
    }
    if (target === ADDR.QUERIES && selector === SEL.queryJoin) {
      if (options.failQuote) throw new Error("MOCK_QUOTE_FAILURE");
      const decoded = IFACE.decodeFunctionData("queryJoin", data);
      const [kind, amountsIn] = ABI.decode(["uint256", "uint256[]", "uint256"], decoded[3].userData);
      if (BigInt(kind) !== 1n) throw new Error("MOCK_JOIN_KIND");
      const amount = amountsIn.reduce((max, value) => (BigInt(value) > max ? BigInt(value) : max), 0n);
      const bptOut = amount * BPT_SCALE;
      return IFACE.encodeFunctionResult("queryJoin", [bptOut, amountsIn]);
    }
    if (target === ADDR.QUERIES && selector === SEL.queryExit) {
      if (options.failQuote) throw new Error("MOCK_QUOTE_FAILURE");
      const decoded = IFACE.decodeFunctionData("queryExit", data);
      const [kind, bptIn, tokenIndex] = ABI.decode(["uint256", "uint256", "uint256"], decoded[3].userData);
      if (BigInt(kind) !== 0n) throw new Error("MOCK_EXIT_KIND");
      const amountIn = BigInt(bptIn) / BPT_SCALE;
      const amountsOut = [0n, 0n, 0n];
      amountsOut[Number(tokenIndex)] = amountIn * 2n;
      return IFACE.encodeFunctionResult("queryExit", [bptIn, amountsOut]);
    }
    if (target === ADDR.CHAINLINK && selector === SEL.latestRoundData) {
      return IFACE.encodeFunctionResult("latestRoundData", [2n, options.ethUsdRaw ?? 2_000n * 100_000_000n, 0n, oracleUpdatedAt, 2n]);
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
