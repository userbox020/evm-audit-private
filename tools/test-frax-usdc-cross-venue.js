"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const { ethers } = require("ethers");

const economics = require("./frax-usdc-cross-venue-economics");
const scanner = require("./scan-cross-dex-arbitrage");
const coverage = require("./audit-trigger-coverage-universe");

const ROOT = path.resolve(__dirname, "..");
const CONTRACT = path.join(__dirname, "fork-poc", "contracts", "FraxUsdcAtomicRoundTrip.sol");
const COMPILED = path.join(__dirname, "fork-poc", "contracts", "FraxUsdcAtomicRoundTrip.compiled.json");
const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));

test("exact arithmetic rounds gas policy upward at boundaries", () => {
  assert.equal(economics.ceilDiv(0n, 8n), 0n);
  assert.equal(economics.ceilDiv(8n, 8n), 1n);
  assert.equal(economics.ceilDiv(9n, 8n), 2n);
  assert.equal(economics.effectiveGasPriceWei(8n), 2_000_000_009n);
  assert.equal(economics.gasCeilingUsdcRaw(0n, 2_000n * 100_000_000n), 8_000_000n);
});

test("Ethereum FRAX route keeps the 2 gwei priority floor byte-identical", () => {
  assert.equal(economics.PRIORITY_FEE_WEI, 2_000_000_000n);
  assert.equal(scanner.ETH_ROUTE.gasPolicy.priorityFeeWei, 2_000_000_000n);
  assert.equal(economics.effectiveGasPriceWei(5_000_000n), 2_005_625_000n);
  assert.equal(economics.resolvePriorityFeeWei(undefined), 2_000_000_000n);
  assert.equal(economics.gasCeilingUsdcRaw(0n, 1n, 2_000_000_000n), economics.gasCeilingUsdcRaw(0n, 1n));
});

test("pre-fork gate is strict gross greater than premium plus gas", () => {
  const context = { chainId: 1, curvePool: scanner.CURVE.pool, uniPool: "0x1111111111111111111111111111111111111111", blockHash: `0x${"1".repeat(64)}`, baseFeeWei: 0n, ethUsdRaw: 1n };
  const gas = economics.gasCeilingUsdcRaw(0n, 1n);
  const make = (delta) => ({ direction: "CURVE_TO_UNIV3", amountInRaw: "100000000", amountOutRaw: (100000000n + delta).toString(), grossDeltaRaw: delta.toString(), classification: "GROSS_EDGE_FORK_REQUIRED" });
  assert.equal(economics.evaluateRow(make(0n), context).status, "NO_GROSS_EDGE");
  assert.equal(economics.evaluateRow(make(gas), context).status, "GROSS_EDGE_NET_BLOCKED");
  assert.equal(economics.evaluateRow(make(gas + 1n), context).status, "ATOMIC_FORK_REQUIRED");
});

test("route and event identities bind every required field", () => {
  const a = economics.routeKey({ chainId: 1, curvePool: "0xabc", uniPool: "0xdef", direction: "A", amountInRaw: "1" });
  const b = economics.routeKey({ chainId: 1, curvePool: "0xabc", uniPool: "0xdef", direction: "A", amountInRaw: "2" });
  assert.match(a, /^[0-9a-f]{64}$/u);
  assert.notEqual(a, b);
  assert.notEqual(economics.eventId({ routeKey: a, blockHash: "0x1", expectedOutRaw: "2", grossDeltaRaw: "1" }), economics.eventId({ routeKey: a, blockHash: "0x2", expectedOutRaw: "2", grossDeltaRaw: "1" }));
});

test("exactly eight complete quote rows cover four sizes and both directions", async () => {
  const rows = [];
  for (const size of scanner.SIZE_USDC) for (const direction of ["CURVE_TO_UNIV3", "UNIV3_TO_CURVE"]) {
    rows.push(await scanner.executeRoundTrip({
      direction, amountInRaw: size * 1_000_000n, curveFeeRaw: 1n,
      quoteCurve: async ({ i, amountInRaw }) => i === 1 ? amountInRaw * 999_000_000_000n : amountInRaw / 1_001_000_000_000n,
      quoteUni: async ({ tokenIn, amountInRaw }) => ({
        amountOutRaw: tokenIn.toLowerCase() === scanner.TOKENS.USDC.address.toLowerCase()
          ? amountInRaw * 999_000_000_000n : amountInRaw / 1_001_000_000_000n,
        gasEstimate: 1n,
      }),
    }));
  }
  assert.equal(rows.length, 8);
  assert.equal(rows.every((row) => row.classification === "NO_CROSS_VENUE_EDGE"), true);
});

test("finalized pin requires exact hash and base fee", () => {
  assert.equal(scanner.validatePinBlock({ number: "0x1", hash: `0x${"1".repeat(64)}`, baseFeePerGas: "0x1" }), true);
  assert.throws(() => scanner.validatePinBlock({ number: "0x1", hash: `0x${"1".repeat(64)}` }), /BASE_FEE_UNAVAILABLE/u);
  assert.throws(() => scanner.validatePinBlock({ number: "0x1", hash: "0x1", baseFeePerGas: "0x1" }), /BLOCK_UNAVAILABLE/u);
});

test("stale and malformed Chainlink observations fail closed", () => {
  const valid = { decimals: 8, roundId: 2n, answer: 2_000n * 100_000_000n, updatedAt: 10_000n, answeredInRound: 2n, blockTimestamp: 10_001n };
  assert.equal(scanner.validateOracleRound(valid), 1n);
  assert.throws(() => scanner.validateOracleRound({ ...valid, updatedAt: 6_000n }), /ORACLE_STALE/u);
  assert.throws(() => scanner.validateOracleRound({ ...valid, answer: 0n }), /ORACLE_INVALID/u);
  assert.throws(() => scanner.validateOracleRound({ ...valid, answeredInRound: 1n }), /ORACLE_INVALID/u);
});

test("read failures remain sanitized and cannot become economics positives", () => {
  assert.equal(scanner.sanitizeFailure({ code: "CALL_FAILED" }), "CALL_FAILED");
  assert.equal(scanner.sanitizeFailure(new Error("https://secret.invalid")), "QUOTE_FAILED");
  assert.equal(economics.evaluateRow({ classification: "INCOMPLETE", direction: "CURVE_TO_UNIV3" }, {}).status, "FAILED");
});

test("coverage evidence maps exactly the two approved universe rows", () => {
  const artifact = { scannedAt: new Date().toISOString(), pin: { number: 1, hash: `0x${"1".repeat(64)}` }, rows: Array.from({ length: 8 }, () => ({ economics: { status: "NO_GROSS_EDGE" } })) };
  const rows = UNIVERSE.rows.filter((row) => ["ethereum-curve-x", "ethereum-uniswap-v3-x"].includes(row.id));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const evidence = scanner.coverageEvidence(artifact, row.family);
    const shape = coverage.genericEvidenceShape(evidence, row);
    assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
  }
});

test("compiled artifact is source-hash bound and byte-for-byte reproducible", () => {
  const artifact = JSON.parse(fs.readFileSync(COMPILED, "utf8"));
  const source = fs.readFileSync(CONTRACT);
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  assert.equal(sha(source), artifact.sourceSha256);
  const result = childProcess.spawnSync(path.join(ROOT, artifact.compiler.path), [
    "--optimize", "--optimize-runs", "200", "--evm-version", "paris", "--metadata-hash", "none", "--combined-json", "abi,bin,bin-runtime", CONTRACT,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const built = output.contracts[Object.keys(output.contracts).find((key) => key.endsWith(":FraxUsdcAtomicRoundTrip"))];
  assert.equal(`0x${built.bin}`, artifact.creationBytecode);
  assert.equal(`0x${built["bin-runtime"]}`, artifact.runtimeBytecode);
  assert.equal(sha(Buffer.from(built.bin, "hex")), artifact.creationBytecodeSha256);
});

test("executor source binds zero-capital callback, two swaps, and full repayment", () => {
  const source = fs.readFileSync(CONTRACT, "utf8");
  const scenario = fs.readFileSync(path.join(__dirname, "fork-poc", "triggers", "frax-usdc-cross-venue.js"), "utf8");
  assert.match(source, /flashLoan\(USDC, principal/u);
  assert.match(source, /onMorphoFlashLoan/u);
  assert.match(source, /bothSwapsComplete = true/u);
  assert.match(source, /approve\(MORPHO, principal\)/u);
  assert.match(source, /transfer\(actor, residual\)/u);
  assert.match(scenario, /deploymentGas \* deploymentGasPrice \+ executionGas \* executionGasPrice/u);
  assert.match(scenario, /const exactPin = typeof evidence\?\.blockHash === "string"/u);
  assert.match(scenario, /ctx\.assert\(exactPin, "exact-pin-hash"\)/u);
  assert.match(scenario, /exactPin,/u);
});

// --- M2: injectable scan deps for deny paths --------------------------------------------
const ADDR = {
  FRAX: scanner.TOKENS.FRAX.address.toLowerCase(),
  USDC: scanner.TOKENS.USDC.address.toLowerCase(),
  CURVE: scanner.CURVE.pool.toLowerCase(),
  FACTORY: scanner.UNISWAP.factory.toLowerCase(),
  QUOTER: scanner.UNISWAP.quoterV2.toLowerCase(),
  CHAINLINK: scanner.CHAINLINK.ethUsd.toLowerCase(),
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
      if (target === ADDR.FRAX) return IFACE.encodeFunctionResult("decimals", [18]);
      if (target === ADDR.USDC) return IFACE.encodeFunctionResult("decimals", [6]);
      if (target === ADDR.CHAINLINK) return IFACE.encodeFunctionResult("decimals", [8]);
    }
    if (target === ADDR.CURVE && selector === SEL.coins) {
      const index = Number(BigInt(`0x${data.slice(10, 74)}`));
      const order = options.reverseCoins ? [ADDR.USDC, ADDR.FRAX] : [ADDR.FRAX, ADDR.USDC];
      return IFACE.encodeFunctionResult("coins", [order[index]]);
    }
    if (target === ADDR.CURVE && selector === SEL.fee) return IFACE.encodeFunctionResult("fee", [1_000_000n]);
    if (target === ADDR.FACTORY && selector === SEL.getPool) return IFACE.encodeFunctionResult("getPool", [ADDR.POOL]);
    if (target === ADDR.POOL && selector === SEL.factory) return IFACE.encodeFunctionResult("factory", [ADDR.FACTORY]);
    if (target === ADDR.POOL && selector === SEL.token0) return IFACE.encodeFunctionResult("token0", [ADDR.FRAX]);
    if (target === ADDR.POOL && selector === SEL.token1) return IFACE.encodeFunctionResult("token1", [ADDR.USDC]);
    if (target === ADDR.POOL && selector === SEL.fee) return IFACE.encodeFunctionResult("fee", [500]);
    if (target === ADDR.CHAINLINK && selector === SEL.latestRoundData) {
      return IFACE.encodeFunctionResult("latestRoundData", [2n, options.ethUsdRaw ?? 2_000n * 100_000_000n, 0n, oracleUpdatedAt, 2n]);
    }
    if (target === ADDR.CURVE && selector === SEL.get_dy) {
      if (options.failQuote) throw new Error("MOCK_QUOTE_FAILURE");
      return IFACE.encodeFunctionResult("get_dy", [options.curveOut ?? 10n ** 18n]);
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

test("a failed quote leg yields FAILED economics and no fork candidates", async () => {
  const { rpcCallImpl } = makeRpc({ failQuote: true });
  const artifact = await scanner.scan({ rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(artifact.rows.length, 8);
  assert.equal(artifact.rows.every((row) => row.economics.status === "FAILED"), true);
  assert.equal(artifact.forkCandidates.length, 0);
  assert.equal(artifact.grossPositiveRows, 0);
  assert.equal(artifact.economics.fired.length, 0);
  const evidence = scanner.coverageEvidence(artifact, "Curve");
  assert.equal(evidence.coverage.complete, false);
  assert.equal(evidence.enumeration.successful, false);
  assert.equal(evidence.reads.failed, 8);
});

test("a pin-recheck mismatch rejects the scan and can never yield a fork candidate", async () => {
  const good = makeRpc();
  const accepted = await scanner.scan({ rpcCall: good.rpcCallImpl, resolveRpc });
  assert.ok(accepted.forkCandidates.length > 0);
  const wrong = makeRpc({ recheckBlock: { ...good.block, hash: `0x${"ef".repeat(32)}` } });
  await assert.rejects(() => scanner.scan({ rpcCall: wrong.rpcCallImpl, resolveRpc }), /PIN_RECHECK_FAILED/u);
});

test("a Curve binding mismatch rejects before any economics evaluation", async () => {
  const { rpcCallImpl } = makeRpc({ reverseCoins: true });
  await assert.rejects(() => scanner.scan({ rpcCall: rpcCallImpl, resolveRpc }), /CURVE_BINDING_MISMATCH/u);
});

test("scenario aborts on an exact-pin mismatch before any RPC or deployment", async () => {
  const scenario = require("./fork-poc/triggers/frax-usdc-cross-venue");
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
