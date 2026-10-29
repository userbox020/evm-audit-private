#!/usr/bin/env node
// Bounded, read-only Balancer V2 single-token BPT mint/redeem (R class) round-trip scan.
//
// Observation (single venue, closed round trip): deposit one token into the
// Balancer V2 pool with an EXACT_TOKENS_IN_FOR_BPT_OUT join, receive BPT, then
// burn that BPT with an EXACT_BPT_IN_FOR_ONE_TOKEN_OUT exit of the SAME token.
// The quoted output is compared against the quoted input in the same token, so
// the row is a genuine closed round trip and its gross delta is comparable
// without a reference price.
//
// Canonical quoting: the BalancerQueries helper (mainnet
// 0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5) exposes `queryJoin`/`queryExit`,
// which fetch the registered balances/protocol fee and delegate to the pool's
// own `queryJoin`/`queryExit`. The Vault has no `queryJoin`/`queryExit`.
// RPC endpoint material remains process-only and is never logged or persisted.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const economics = require("./frax-usdc-cross-venue-economics");

const WORKSPACE = path.resolve(__dirname, "..");
const COVERAGE_DIR = path.join(WORKSPACE, "reports", "monitor", "trigger-coverage");
const TIMEOUT_MS = 15_000;
// Depth-appropriate single-token sizes for the 3pool. The StablePool invariant
// solver (`StableMath`) fails to converge (BAL#322) for single-token mint/redeem
// legs above ~15k USDC-equivalent at the observed pins, so the honest upper
// bound is 10k. Three sizes x two same-token round trips = six complete rows.
const SIZE = Object.freeze([100n, 1_000n, 10_000n]);

const JOIN_EXIT_TOKENS = Object.freeze({
  DAI: Object.freeze({ symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 }),
  USDC: Object.freeze({ symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }),
  USDT: Object.freeze({ symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }),
});

// Canonical BalancerQueries helper (the Vault has no queryJoin/queryExit).
// Same-pin probe at a finalized mainnet pin (keyless fork, funded actor):
// reports/raw/fast/fork-poc/bal-r-eth-samepin.json. `queryJoin` equals the mined
// `Vault.joinPool` exactly at every measured size and both round-tripped tokens.
// The stateless `queryExit` evaluates the redemption at the PRE-join pool state,
// while the executable exit runs after the join has enlarged the pool, so the
// mined redemption is >= the quoted redemption at every measured size and token
// (measured deltas 487/48,884/17,561,327 raw for USDC and 348/34,814/5,208,259
// raw for USDT at 100/1,000/10,000 USDC-equivalent). The quoted gross is
// therefore conservative (never overstates the executable output), so
// `quoteExecutable=true` and no suppress-only haircut is declared.
const JOIN_EXIT_QUERIES = Object.freeze({
  name: "BalancerQueries",
  address: "0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5",
  quoteSource: "queryJoin+queryExit",
  quoteExecutable: true,
});

const JOIN_EXIT_POOL = Object.freeze({
  name: "Balancer V2 DAI/USDC/USDT Stable",
  type: "Balancer V2 StablePool",
  vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  poolId: "0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063",
  pool: "0x06Df3b2bbB68adc8B0e302443692037ED9f91b42",
  // coin order as returned by Vault.getPoolTokens: DAI(0), USDC(1), USDT(2)
  coins: Object.freeze([JOIN_EXIT_TOKENS.DAI.address, JOIN_EXIT_TOKENS.USDC.address, JOIN_EXIT_TOKENS.USDT.address]),
  feeDenominator: 1_000_000_000_000_000_000n,
});
const JOIN_EXIT_CHAINLINK = Object.freeze({
  ethUsd: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  decimals: 8,
  maxAgeSeconds: 3600,
});
const OUT_JOIN_EXIT = path.join(WORKSPACE, "reports", "raw", "fast", "balancer-v2-join-exit.json");
const COVERAGE_FILE_JOIN_EXIT = path.join(COVERAGE_DIR, "balancer-v2-ethereum-r.json");

// Directions are the token that is minted-and-redeemed in the closed round trip.
const JOIN_EXIT_DIRECTIONS = Object.freeze([
  Object.freeze({ id: "JOIN_EXIT_USDC", symbol: "USDC", index: 1 }),
  Object.freeze({ id: "JOIN_EXIT_USDT", symbol: "USDT", index: 2 }),
]);

const JOIN_EXIT_ROUTE = Object.freeze({
  id: "ethereum-balancer-v2-mint-redeem",
  chainId: 1,
  venueKind: "balancer-v2-join-exit",
  label: "DAI/USDC/USDT",
  base: JOIN_EXIT_TOKENS.USDC,
  quote: JOIN_EXIT_TOKENS.USDT,
  pool: JOIN_EXIT_POOL,
  queries: JOIN_EXIT_QUERIES,
  chainlink: JOIN_EXIT_CHAINLINK,
  sizes: SIZE,
  maxSize: 100_000n,
  gasPolicy: Object.freeze({ priorityFeeWei: 2_000_000_000n }),
  artifactPath: OUT_JOIN_EXIT,
  coverageFiles: Object.freeze({ "Balancer V2": COVERAGE_FILE_JOIN_EXIT }),
  localEvidence: Object.freeze([
    "tools/trigger-coverage-universe.json:ethereum-balancer-v2-r",
    "read-only Ethereum qualification of BalancerQueries 0xE39B...549d5 against pool 0x06df...0063",
  ]),
  coverageRef: "bounded mint/redemption observation",
});

const NUMBER_WORDS = Object.freeze(["zero", "one", "two", "three", "four"]);
function sizeWord(route) {
  return NUMBER_WORDS[route.sizes.length] || String(route.sizes.length);
}

const ERC20_I = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);
const BALANCER_VAULT_I = new ethers.Interface([
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens,uint256[] balances,uint256 lastChangeBlock)",
]);
const BALANCER_QUERIES_I = new ethers.Interface([
  "function vault() view returns (address)",
  "function queryJoin(bytes32 poolId,address sender,address recipient,(address[] assets,uint256[] maxAmountsIn,bytes userData,bool fromInternalBalance) request) returns (uint256 bptOut,uint256[] amountsIn)",
  "function queryExit(bytes32 poolId,address sender,address recipient,(address[] assets,uint256[] minAmountsOut,bytes userData,bool toInternalBalance) request) returns (uint256 bptIn,uint256[] amountsOut)",
]);
const BALANCER_POOL_I = new ethers.Interface([
  "function getPoolId() view returns (bytes32)",
  "function getVault() view returns (address)",
  "function getSwapFeePercentage() view returns (uint256)",
]);
const CHAINLINK_I = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

const JOIN_KIND_EXACT_TOKENS_IN_FOR_BPT_OUT = 1n;
const EXIT_KIND_EXACT_BPT_IN_FOR_ONE_TOKEN_OUT = 0n;
const ABI = ethers.AbiCoder.defaultAbiCoder();

class ScanFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function sanitizeFailure(error) {
  const allowed = new Set([
    "RPC_UNAVAILABLE", "BLOCK_UNAVAILABLE", "CALL_FAILED", "EMPTY_CODE", "ABI_DECODE_FAILED",
    "LOCAL_BINDING_MISMATCH", "CURVE_BINDING_MISMATCH", "JOIN_EXIT_BINDING_MISMATCH", "QUOTE_FAILED",
    "ORACLE_STALE", "ORACLE_INVALID", "BASE_FEE_UNAVAILABLE", "PIN_RECHECK_FAILED",
  ]);
  return allowed.has(error && error.code) ? error.code : "QUOTE_FAILED";
}

function validateSizes(sizes, maxSize = 100_000n) {
  if (!Array.isArray(sizes) || sizes.length === 0 || sizes.length > 4) throw new ScanFailure("LOCAL_BINDING_MISMATCH");
  for (const value of sizes) {
    if (typeof value !== "bigint" || value <= 0n || value > maxSize) throw new ScanFailure("LOCAL_BINDING_MISMATCH");
  }
  return sizes;
}

function grossBps(deltaRaw, inputRaw) {
  const scale = 1_000_000n;
  return Number((deltaRaw * 10_000n * scale) / inputRaw) / Number(scale);
}

async function callDecoded(rpc, target, iface, fn, args, blockTag, rpcCallImpl = rpcCall) {
  const data = iface.encodeFunctionData(fn, args);
  const raw = await rpcCallImpl(rpc, "eth_call", [{ to: target, data }, blockTag], TIMEOUT_MS);
  if (typeof raw !== "string" || !/^0x[0-9a-f]*$/i.test(raw) || raw === "0x") throw new ScanFailure("CALL_FAILED");
  try {
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    throw new ScanFailure("ABI_DECODE_FAILED");
  }
}

async function requireCode(rpc, address, blockTag, rpcCallImpl = rpcCall) {
  const code = await rpcCallImpl(rpc, "eth_getCode", [address, blockTag], TIMEOUT_MS);
  if (typeof code !== "string" || !/^0x[0-9a-f]+$/i.test(code) || code === "0x") throw new ScanFailure("EMPTY_CODE");
}

async function selectPin(rpc, rpcCallImpl = rpcCall) {
  const block = await rpcCallImpl(rpc, "eth_getBlockByNumber", ["finalized", false], TIMEOUT_MS);
  validatePinBlock(block);
  return { block, blockTag: block.number, finality: "finalized" };
}

function validatePinBlock(block) {
  if (!block || !/^0x[0-9a-f]+$/i.test(block.number || "") || !/^0x[0-9a-f]{64}$/i.test(block.hash || "")) throw new ScanFailure("BLOCK_UNAVAILABLE");
  if (!/^0x[0-9a-f]+$/i.test(block.baseFeePerGas || "")) throw new ScanFailure("BASE_FEE_UNAVAILABLE");
  return true;
}

async function bindRoute(rpc, blockTag, route = JOIN_EXIT_ROUTE, rpcCallImpl = rpcCall) {
  const routeConfig = route || JOIN_EXIT_ROUTE;
  const pool = routeConfig.pool;
  for (const address of [...pool.coins, pool.vault, pool.pool, routeConfig.queries.address, routeConfig.chainlink.ethUsd]) {
    await requireCode(rpc, address, blockTag, rpcCallImpl);
  }
  const decimals = await Promise.all(pool.coins.map((address) => callDecoded(rpc, address, ERC20_I, "decimals", [], blockTag, rpcCallImpl)));
  const expectedDecimals = [JOIN_EXIT_TOKENS.DAI.decimals, JOIN_EXIT_TOKENS.USDC.decimals, JOIN_EXIT_TOKENS.USDT.decimals];
  if (!decimals.every(([value], index) => Number(value) === expectedDecimals[index])) throw new ScanFailure("LOCAL_BINDING_MISMATCH");
  const [[poolId], [poolVault], [swapFee]] = await Promise.all([
    callDecoded(rpc, pool.pool, BALANCER_POOL_I, "getPoolId", [], blockTag, rpcCallImpl),
    callDecoded(rpc, pool.pool, BALANCER_POOL_I, "getVault", [], blockTag, rpcCallImpl),
    callDecoded(rpc, pool.pool, BALANCER_POOL_I, "getSwapFeePercentage", [], blockTag, rpcCallImpl),
  ]);
  if (String(poolId).toLowerCase() !== pool.poolId.toLowerCase() || !sameAddress(poolVault, pool.vault)) {
    throw new ScanFailure("JOIN_EXIT_BINDING_MISMATCH");
  }
  const [tokens] = await callDecoded(rpc, pool.vault, BALANCER_VAULT_I, "getPoolTokens", [pool.poolId], blockTag, rpcCallImpl);
  if (tokens.length !== pool.coins.length || !pool.coins.every((expected, index) => sameAddress(tokens[index], expected))) {
    throw new ScanFailure("JOIN_EXIT_BINDING_MISMATCH");
  }
  const [queriesVault] = await callDecoded(rpc, routeConfig.queries.address, BALANCER_QUERIES_I, "vault", [], blockTag, rpcCallImpl);
  if (!sameAddress(queriesVault, pool.vault)) throw new ScanFailure("JOIN_EXIT_BINDING_MISMATCH");
  return { poolId: ethers.getAddress(pool.pool), feeRaw: BigInt(swapFee) };
}

async function readOracle(rpc, blockTag, blockTimestamp, rpcCallImpl = rpcCall, chainlink = JOIN_EXIT_CHAINLINK) {
  const [decimals] = await callDecoded(rpc, chainlink.ethUsd, CHAINLINK_I, "decimals", [], blockTag, rpcCallImpl);
  const [roundId, answer, , updatedAt, answeredInRound] = await callDecoded(rpc, chainlink.ethUsd, CHAINLINK_I, "latestRoundData", [], blockTag, rpcCallImpl);
  const age = validateOracleRound({ decimals: Number(decimals), roundId, answer, updatedAt, answeredInRound, blockTimestamp }, chainlink);
  return { feed: chainlink.ethUsd, decimals: chainlink.decimals, ethUsdRaw: answer.toString(), updatedAtRaw: updatedAt.toString(), ageSeconds: Number(age) };
}

function validateOracleRound({ decimals, roundId, answer, updatedAt, answeredInRound, blockTimestamp }, chainlink = JOIN_EXIT_CHAINLINK) {
  if (decimals !== chainlink.decimals || answer <= 0n || updatedAt <= 0n || answeredInRound < roundId || updatedAt > blockTimestamp + 60n) throw new ScanFailure("ORACLE_INVALID");
  const age = blockTimestamp - updatedAt;
  if (age > BigInt(chainlink.maxAgeSeconds)) throw new ScanFailure("ORACLE_STALE");
  return age;
}

function selectors(route = JOIN_EXIT_ROUTE) {
  void (route || JOIN_EXIT_ROUTE);
  return {
    tokenDecimals: ERC20_I.getFunction("decimals").selector,
    balancerGetPoolTokens: BALANCER_VAULT_I.getFunction("getPoolTokens").selector,
    balancerPoolId: BALANCER_POOL_I.getFunction("getPoolId").selector,
    balancerPoolVault: BALANCER_POOL_I.getFunction("getVault").selector,
    balancerQueriesVault: BALANCER_QUERIES_I.getFunction("vault").selector,
    balancerQueryJoin: BALANCER_QUERIES_I.getFunction("queryJoin").selector,
    balancerQueryExit: BALANCER_QUERIES_I.getFunction("queryExit").selector,
    chainlinkLatestRoundData: CHAINLINK_I.getFunction("latestRoundData").selector,
  };
}

async function executeRoundTrip({ direction, amountInRaw, quoteJoin, quoteExit, route = JOIN_EXIT_ROUTE }) {
  const routeConfig = route || JOIN_EXIT_ROUTE;
  const token = direction.symbol;
  try {
    const bptOutRaw = await quoteJoin({ tokenIndex: direction.index, amountInRaw });
    if (typeof bptOutRaw !== "bigint" || bptOutRaw <= 0n) throw new ScanFailure("QUOTE_FAILED");
    const amountOutRaw = await quoteExit({ tokenIndex: direction.index, bptInRaw: bptOutRaw });
    if (typeof amountOutRaw !== "bigint" || amountOutRaw <= 0n) throw new ScanFailure("QUOTE_FAILED");
    const delta = amountOutRaw - amountInRaw;
    return {
      direction: direction.id,
      token,
      tokenIndex: direction.index,
      amountInRaw: amountInRaw.toString(),
      amountIn: ethers.formatUnits(amountInRaw, 6),
      bptOutRaw: bptOutRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      amountOut: ethers.formatUnits(amountOutRaw, 6),
      classification: delta > 0n ? "GROSS_EDGE_FORK_REQUIRED" : "NO_JOIN_EXIT_EDGE",
      grossDeltaRaw: delta.toString(),
      grossDelta: ethers.formatUnits(delta, 6),
      grossBps: grossBps(delta, amountInRaw),
      joinKind: "EXACT_TOKENS_IN_FOR_BPT_OUT",
      exitKind: "EXACT_BPT_IN_FOR_ONE_TOKEN_OUT",
      flashFee: "0",
      gas: "bounded-ceiling",
      net: "unknown",
      routePositive: "unknown",
    };
  } catch (error) {
    return {
      direction: direction.id,
      token,
      tokenIndex: direction.index,
      amountInRaw: amountInRaw.toString(),
      amountIn: ethers.formatUnits(amountInRaw, 6),
      bptOutRaw: null,
      amountOutRaw: null,
      amountOut: null,
      classification: "INCOMPLETE",
      failure: sanitizeFailure(error),
      grossDeltaRaw: null,
      grossDelta: null,
      grossBps: null,
      flashFee: "unknown",
      gas: "unknown",
      net: "unknown",
      routePositive: "unknown",
    };
  }
}

// Accounting seam only: this does not assert a pool's join/exit enum or that two
// stateless pre-join queries simulate a sequential executable round trip.
// Prices are numeraire-raw / token-raw rationals, not decimal-normalized floats.
function accountProportionalBasket({ tokens, maximums, amountsIn, amountsOut, bptMinted, bptBurned,
  prices, roundingBoundsRaw, extraCostRaw = 0n }) {
  const uint = value => typeof value === "bigint" && value >= 0n;
  const count = tokens?.length;
  const vectors = [maximums, amountsIn, amountsOut, prices, roundingBoundsRaw];
  if (count !== 2 || !tokens.every(token => typeof token === "string" && /^0x[0-9a-f]{40}$/i.test(token))
      || new Set(tokens.map(token => String(token).toLowerCase())).size !== count
      || vectors.some(vector => !Array.isArray(vector) || vector.length !== count)
      || !uint(bptMinted) || bptMinted === 0n || bptBurned !== bptMinted || !uint(extraCostRaw)) {
    throw new ScanFailure("JOIN_EXIT_BINDING_MISMATCH");
  }
  let inputValueRaw = 0n;
  let outputValueRaw = 0n;
  const basket = tokens.map((token, index) => {
    const input = amountsIn[index], output = amountsOut[index], maximum = maximums[index];
    const rounding = roundingBoundsRaw[index], price = prices[index];
    if (![input, output, maximum, rounding].every(uint) || input === 0n || input > maximum
        || !sameAddress(price?.token, token) || !uint(price?.numerator) || price.numerator === 0n
        || !uint(price?.denominator) || price.denominator === 0n) {
      throw new ScanFailure("QUOTE_FAILED");
    }
    const conservativeOutput = output > rounding ? output - rounding : 0n;
    const inputValue = (input * price.numerator + price.denominator - 1n) / price.denominator;
    const outputValue = conservativeOutput * price.numerator / price.denominator;
    inputValueRaw += inputValue;
    outputValueRaw += outputValue;
    return { token, inputRaw: input.toString(), outputRaw: output.toString(),
      unspentMaximumRaw: (maximum - input).toString(), roundingBoundRaw: rounding.toString(),
      inputValueRaw: inputValue.toString(), conservativeOutputValueRaw: outputValue.toString() };
  });
  return { basket, bptResidualRaw: "0", inputValueRaw: inputValueRaw.toString(), outputValueRaw: outputValueRaw.toString(),
    conservativeDeltaRaw: (outputValueRaw - inputValueRaw - extraCostRaw).toString(),
    extraCostRaw: extraCostRaw.toString(), venueFeesIncludedInQuotedAmounts: true, feeDoubleCounting: false,
    quoteExecutable: false, routePositive: "unknown", executableNow: "unknown" };
}

async function scan(options = {}) {
  const route = options.route || JOIN_EXIT_ROUTE;
  const rpcCallImpl = options.rpcCall || rpcCall;
  const resolveRpcImpl = options.resolveRpc || resolveRpc;
  validateSizes(route.sizes, route.maxSize);
  const rpc = await resolveRpcImpl(route.chainId);
  if (!rpc) throw new ScanFailure("RPC_UNAVAILABLE");
  const { block, blockTag, finality } = await selectPin(rpc, rpcCallImpl);
  const binding = await bindRoute(rpc, blockTag, route, rpcCallImpl);
  const blockTimestampRaw = BigInt(block.timestamp);
  const oracle = await readOracle(rpc, blockTag, blockTimestampRaw, rpcCallImpl, route.chainlink);
  const quoteJoin = async ({ tokenIndex, amountInRaw }) => {
    const pool = route.pool;
    const amountsIn = pool.coins.map((_, index) => (index === tokenIndex ? amountInRaw : 0n));
    const userData = ABI.encode(["uint256", "uint256[]", "uint256"], [JOIN_KIND_EXACT_TOKENS_IN_FOR_BPT_OUT, amountsIn, 0n]);
    const [bptOut] = await callDecoded(rpc, route.queries.address, BALANCER_QUERIES_I, "queryJoin", [
      pool.poolId, ethers.ZeroAddress, ethers.ZeroAddress,
      { assets: [...pool.coins], maxAmountsIn: amountsIn, userData, fromInternalBalance: false },
    ], blockTag, rpcCallImpl);
    return BigInt(bptOut);
  };
  const quoteExit = async ({ tokenIndex, bptInRaw }) => {
    const pool = route.pool;
    const userData = ABI.encode(["uint256", "uint256", "uint256"], [EXIT_KIND_EXACT_BPT_IN_FOR_ONE_TOKEN_OUT, bptInRaw, BigInt(tokenIndex)]);
    const [, amountsOut] = await callDecoded(rpc, route.queries.address, BALANCER_QUERIES_I, "queryExit", [
      pool.poolId, ethers.ZeroAddress, ethers.ZeroAddress,
      { assets: [...pool.coins], minAmountsOut: pool.coins.map(() => 0n), userData, toInternalBalance: false },
    ], blockTag, rpcCallImpl);
    return BigInt(amountsOut[tokenIndex]);
  };
  const rows = [];
  for (const size of route.sizes) {
    const amountInRaw = size * 10n ** 6n;
    for (const direction of JOIN_EXIT_DIRECTIONS) {
      rows.push(await executeRoundTrip({ direction, amountInRaw, quoteJoin, quoteExit, route }));
    }
  }
  const observedAt = new Date().toISOString();
  const blockTimestamp = Number(BigInt(block.timestamp));
  const pin = {
    number: Number(BigInt(block.number)),
    hash: block.hash,
    stateRoot: block.stateRoot || null,
    timestamp: new Date(blockTimestamp * 1000).toISOString(),
    finality,
    baseFeePerGasRaw: BigInt(block.baseFeePerGas).toString(),
  };
  const preliminary = {
    chainId: route.chainId, scannedAt: observedAt, pin, oracle, rows,
    gasPolicy: { priorityFeeWei: route.gasPolicy.priorityFeeWei.toString() },
    routeBinding: {
      joinExit: { pool: route.pool.pool },
    },
  };
  const economic = economics.evaluateScan(preliminary);
  const economicByEvent = new Map(economic.rows.map((row) => [`${row.direction}|${row.amountInRaw}`, row]));
  const evaluatedRows = rows.map((row) => ({ ...row, economics: economicByEvent.get(`${row.direction}|${row.amountInRaw}`) }));
  const forkCandidates = evaluatedRows.filter(row => row.economics.status === "ATOMIC_FORK_REQUIRED").map(row => {
    const quotedOutRaw = BigInt(row.amountOutRaw);
    const haircutRaw = row.economics.quoteInflationRaw !== undefined ? BigInt(row.economics.quoteInflationRaw) : 0n;
    const effectiveOutRaw = quotedOutRaw > haircutRaw ? quotedOutRaw - haircutRaw : 0n;
    return {
      direction: row.direction,
      token: row.token,
      tokenIndex: row.tokenIndex,
      amountInRaw: row.amountInRaw,
      amountInUsdc: row.amountIn,
      expectedOutRawAtPin: effectiveOutRaw.toString(),
      grossDeltaRawAtPin: row.economics.grossDeltaRaw,
      vault: route.pool.vault,
      pool: route.pool.pool,
      poolId: route.pool.poolId,
      blockPin: pin,
      oracle,
      routeKey: row.economics.routeKey,
      eventId: row.economics.eventId,
      gasCeilingUsdcRaw: row.economics.gasCeilingUsdcRaw,
    };
  });
  const recheck = await rpcCallImpl(rpc, "eth_getBlockByHash", [block.hash, false], TIMEOUT_MS);
  if (!recheck || String(recheck.hash).toLowerCase() !== String(block.hash).toLowerCase() || recheck.number !== block.number) throw new ScanFailure("PIN_RECHECK_FAILED");
  return {
    schemaVersion: 2,
    scannedAt: observedAt,
    scanner: "tools/scan-balancer-v2-join-exit.js",
    routeId: route.id,
    safety: { readOnly: true, signedActions: false, transactions: false, approvals: false, swaps: false, endpointMaterialPersisted: false },
    chainId: route.chainId,
    pin,
    oracle,
    freshness: {
      observedAt,
      blockAgeSecondsAtObservation: Math.max(0, Math.floor(Date.parse(observedAt) / 1000) - blockTimestamp),
      fixedPinUsedForEveryCall: true,
    },
    localEvidence: route.localEvidence,
    routeBinding: {
      tokens: { base: route.base, quote: route.quote },
      joinExit: {
        ...route.pool,
        queries: { ...route.queries },
        feeDenominator: route.pool.feeDenominator.toString(),
        feeRawAtPin: binding.feeRaw.toString(),
        feeBpsAtPin: Number(binding.feeRaw) / 1e16,
      },
      selectors: selectors(route),
      runtimeChecksAtPin: { tokenDecimals: true, coinOrdering: true, poolIdVaultQueries: true, codePresent: true },
    },
    methodology: {
      sizesBase: route.sizes.map(String),
      directions: JOIN_EXIT_DIRECTIONS.map((direction) => direction.id),
      completeRoundTripsOnly: true,
      quoteSource: route.queries.quoteSource,
      venueQuotesIncludeVenueFees: true,
      feeDoubleCounting: false,
      flashFee: "0",
      gas: "bounded-ceiling",
      net: "unknown",
      routePositive: "unknown",
    },
    rows: evaluatedRows,
    economics: economic,
    grossPositiveRows: forkCandidates.length,
    forkCandidates,
    routePositive: "unknown",
    executableNow: "unknown",
    nextAction: forkCandidates.length > 0
      ? "Run one fixed-pin local-fork atomic single-token Balancer V2 join (EXACT_TOKENS_IN_FOR_BPT_OUT) then exit (EXACT_BPT_IN_FOR_ONE_TOKEN_OUT) for the emitted candidate values, including flash repayment and unwind."
      : "No fork: refresh the same bounded complete mint/redeem scan only after material state movement.",
  };
}

function coverageEvidence(artifact, family, route = JOIN_EXIT_ROUTE) {
  const routeConfig = route || JOIN_EXIT_ROUTE;
  const failed = artifact.rows.filter((row) => row.economics.status === "FAILED").length;
  const expected = routeConfig.sizes.length * JOIN_EXIT_DIRECTIONS.length;
  return {
    schema: "trigger-coverage-evidence/v1",
    observedAt: artifact.scannedAt,
    chainId: routeConfig.chainId,
    family,
    triggerClass: "R",
    enumeration: {
      kind: "BOUNDED_ARTIFACT",
      ref: routeConfig.coverageRef,
      boundDeclared: true,
      successful: failed === 0 && artifact.rows.length === expected,
    },
    reads: { attempted: expected, succeeded: expected - failed, failed, unclassifiedFailures: 0 },
    classSemantics: { triggerClass: "R", exact: true },
    coverage: { complete: failed === 0 && artifact.rows.length === expected },
    onFire: { economics: true, keylessFixedPinFork: true, alert: true },
    dispatchEnabled: true,
    evidence: [
      `${relPosix(routeConfig.artifactPath)}#rows`,
      `finalized pin ${artifact.pin.number} hash ${artifact.pin.hash}`,
      `${sizeWord(routeConfig)} exact USDC-equivalent sizes for closed single-token Balancer V2 mint/redeem round trips (${JOIN_EXIT_DIRECTIONS.map((direction) => direction.symbol).join(", ")})`,
    ],
    blockers: [],
  };
}

function relPosix(target) {
  return path.relative(WORKSPACE, target).split(path.sep).join("/");
}

function publish(artifact, options = {}) {
  const route = options.route || JOIN_EXIT_ROUTE;
  const fsImpl = options.fsImpl || fs;
  const out = options.outPath || route.artifactPath;
  const coverageFiles = options.coverageFiles || route.coverageFiles;
  fsImpl.mkdirSync(path.dirname(out), { recursive: true });
  for (const target of Object.values(coverageFiles)) fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  fsImpl.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  for (const family of Object.keys(coverageFiles)) fsImpl.writeFileSync(coverageFiles[family], `${JSON.stringify(coverageEvidence(artifact, family, route), null, 2)}\n`);
  return artifact;
}

async function main() {
  const artifact = await scan();
  publish(artifact);
  for (const row of artifact.rows) {
    console.log(`${row.amountIn} ${row.token} ${row.direction}: ${row.economics.status} grossBps=${row.grossBps === null ? "unknown" : row.grossBps}`);
  }
  console.log(`Pinned ${artifact.pin.finality} block ${artifact.pin.number}; gross-positive rows=${artifact.grossPositiveRows}`);
}

module.exports = {
  JOIN_EXIT_TOKENS,
  JOIN_EXIT_QUERIES,
  JOIN_EXIT_POOL,
  JOIN_EXIT_CHAINLINK,
  JOIN_EXIT_DIRECTIONS,
  JOIN_EXIT_ROUTE,
  OUT_JOIN_EXIT,
  COVERAGE_FILE_JOIN_EXIT,
  SIZE,
  isJoinExitRoute: (route) => (route || {}).venueKind === "balancer-v2-join-exit",
  sanitizeFailure,
  validateSizes,
  grossBps,
  selectPin,
  validatePinBlock,
  bindRoute,
  readOracle,
  validateOracleRound,
  selectors,
  executeRoundTrip,
  accountProportionalBasket,
  callDecoded,
  BALANCER_QUERIES_I,
  coverageEvidence,
  publish,
  scan,
};

if (require.main === module) {
  main().catch(error => {
    console.error(`balancer join/exit scan failed: ${sanitizeFailure(error)}`);
    process.exitCode = 1;
  });
}
