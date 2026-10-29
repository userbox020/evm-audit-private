#!/usr/bin/env node
// Bounded, read-only Curve LP mint/redeem (R class) round-trip scan.
//
// Observation (single venue, closed round trip): deposit one coin into a live
// Curve stable pool with `add_liquidity` (single-token, EXACT amounts in), then
// burn the minted LP with `remove_liquidity_one_coin` of the SAME coin. The
// quoted output is compared against the quoted input in the same coin, so the
// row is a genuine closed round trip.
//
// Canonical quoting: `calc_token_amount(amounts, true)` for the mint and
// `calc_withdraw_one_coin(lp, i)` for the single-token redeem. Curve view vs
// mined execution divergence is measured by the mandatory same-pin probe; the
// per-route `quoteExecutable`/`quoteInflationBps` fields below record the
// measured result. RPC endpoint material remains process-only.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const { resolveWorkingRpc } = require("./scan-morpho-blue-l");
const economics = require("./frax-usdc-cross-venue-economics");

const WORKSPACE = path.resolve(__dirname, "..");
const COVERAGE_DIR = path.join(WORKSPACE, "reports", "monitor", "trigger-coverage");
const TIMEOUT_MS = 15_000;

const TOKENS = Object.freeze({
  FRAX: Object.freeze({ symbol: "FRAX", address: "0x853d955aCEf822Db058eb8505911ED77F175b99e", decimals: 18 }),
  USDC: Object.freeze({ symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }),
});
const BASE_TOKENS = Object.freeze({
  USDC: Object.freeze({ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }),
  USDT: Object.freeze({ symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 }),
});

const CHAINLINK = Object.freeze({
  ethUsd: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  decimals: 8,
  maxAgeSeconds: 3600,
});
const BASE_CHAINLINK = Object.freeze({
  ethUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  decimals: 8,
  maxAgeSeconds: 3600,
});

// Ethereum FraxBP (plain StableSwap, fixed-size arrays, separate LP token).
// Same-pin probe reports/raw/fast/fork-poc/curve-r-eth-samepin.json: the
// composite view round trip can exceed the mined round trip by <=0.83 bps at
// small sizes, so it is not executable and a 2 bps suppress-only haircut is
// declared (margin over the measured divergence).
const CURVE_ETH_ROUTE = Object.freeze({
  id: "ethereum-curve-mint-redeem",
  chainId: 1,
  venueKind: "curve-join-exit",
  arrayType: "fixed",
  label: "FRAX/USDC",
  pool: "0xDcEF968d416a41Cdac0ED8702fAC8128A64241A2",
  lpToken: "0x3175Df0976dFA876431C2E9eE6Bc45b65d3473CC",
  coins: Object.freeze([TOKENS.FRAX.address, TOKENS.USDC.address]),
  decimals: Object.freeze([TOKENS.FRAX.decimals, TOKENS.USDC.decimals]),
  directions: Object.freeze([
    Object.freeze({ id: "ADD_REMOVE_FRAX", index: 0, symbol: "FRAX" }),
    Object.freeze({ id: "ADD_REMOVE_USDC", index: 1, symbol: "USDC" }),
  ]),
  sizes: Object.freeze([100n, 1_000n, 10_000n, 100_000n]),
  maxSize: 100_000n,
  gasPolicy: Object.freeze({ priorityFeeWei: 2_000_000_000n }),
  chainlink: CHAINLINK,
  quoteSource: "calc_token_amount+calc_withdraw_one_coin",
  quoteExecutable: false,
  quoteInflationBps: 2,
  artifactPath: path.join(WORKSPACE, "reports", "raw", "fast", "curve-join-exit-eth.json"),
  coverageFiles: Object.freeze({ Curve: path.join(COVERAGE_DIR, "curve-ethereum-r.json") }),
  localEvidence: Object.freeze([
    "tools/trigger-coverage-universe.json:ethereum-curve-r",
    "reports/raw/fast/fork-poc/curve-r-eth-samepin.json",
  ]),
  coverageRef: "bounded mint/redemption observation",
});

// Base StableSwap-NG USDC/USDT (dynamic-size arrays, pool is the LP token).
// Same-pin probe reports/raw/fast/fork-poc/curve-r-base-samepin.json: the
// composite view round trip is never better than the mined round trip at every
// measured size and coin, so the quote is executable and no haircut is needed.
const CURVE_BASE_ROUTE = Object.freeze({
  id: "base-curve-mint-redeem",
  chainId: 8453,
  venueKind: "curve-join-exit",
  arrayType: "dynamic",
  label: "USDC/USDT",
  pool: "0x335BE1a364eA7f5DA30AaaF062103AB91bF44dD0",
  lpToken: "0x335BE1a364eA7f5DA30AaaF062103AB91bF44dD0",
  coins: Object.freeze([BASE_TOKENS.USDC.address, BASE_TOKENS.USDT.address]),
  decimals: Object.freeze([BASE_TOKENS.USDC.decimals, BASE_TOKENS.USDT.decimals]),
  directions: Object.freeze([
    Object.freeze({ id: "ADD_REMOVE_USDC", index: 0, symbol: "USDC" }),
    Object.freeze({ id: "ADD_REMOVE_USDT", index: 1, symbol: "USDT" }),
  ]),
  sizes: Object.freeze([100n, 1_000n, 10_000n]),
  maxSize: 10_000n,
  gasPolicy: Object.freeze({ priorityFeeWei: 100_000_000n }),
  chainlink: BASE_CHAINLINK,
  quoteSource: "calc_token_amount+calc_withdraw_one_coin",
  quoteExecutable: true,
  artifactPath: path.join(WORKSPACE, "reports", "raw", "fast", "curve-join-exit-base.json"),
  coverageFiles: Object.freeze({ Curve: path.join(COVERAGE_DIR, "curve-base-r.json") }),
  localEvidence: Object.freeze([
    "tools/trigger-coverage-universe.json:base-curve-r",
    "reports/raw/fast/fork-poc/curve-r-base-samepin.json",
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
const CURVE_FIXED_I = new ethers.Interface([
  "function coins(uint256) view returns (address)",
  "function fee() view returns (uint256)",
  "function calc_token_amount(uint256[2] amounts,bool is_deposit) view returns (uint256)",
  "function calc_withdraw_one_coin(uint256 _token_amount,int128 i) view returns (uint256)",
]);
const CURVE_DYN_I = new ethers.Interface([
  "function coins(uint256) view returns (address)",
  "function fee() view returns (uint256)",
  "function calc_token_amount(uint256[] amounts,bool is_deposit) view returns (uint256)",
  "function calc_withdraw_one_coin(uint256 _token_amount,int128 i) view returns (uint256)",
]);
const CHAINLINK_I = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

function curveInterface(route) {
  return route.arrayType === "fixed" ? CURVE_FIXED_I : CURVE_DYN_I;
}

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
    "LOCAL_BINDING_MISMATCH", "CURVE_BINDING_MISMATCH", "QUOTE_FAILED",
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

async function bindRoute(rpc, blockTag, route = CURVE_ETH_ROUTE, rpcCallImpl = rpcCall) {
  const routeConfig = route || CURVE_ETH_ROUTE;
  const iface = curveInterface(routeConfig);
  for (const address of [...routeConfig.coins, routeConfig.pool, routeConfig.lpToken, routeConfig.chainlink.ethUsd]) {
    await requireCode(rpc, address, blockTag, rpcCallImpl);
  }
  const decimals = await Promise.all(routeConfig.coins.map((address) => callDecoded(rpc, address, ERC20_I, "decimals", [], blockTag, rpcCallImpl)));
  if (!decimals.every(([value], index) => Number(value) === routeConfig.decimals[index])) throw new ScanFailure("LOCAL_BINDING_MISMATCH");
  for (let index = 0; index < routeConfig.coins.length; index += 1) {
    const [coin] = await callDecoded(rpc, routeConfig.pool, iface, "coins", [index], blockTag, rpcCallImpl);
    if (!sameAddress(coin, routeConfig.coins[index])) throw new ScanFailure("CURVE_BINDING_MISMATCH");
  }
  const [feeRaw] = await callDecoded(rpc, routeConfig.pool, iface, "fee", [], blockTag, rpcCallImpl);
  return { feeRaw: BigInt(feeRaw) };
}

async function readOracle(rpc, blockTag, blockTimestamp, rpcCallImpl = rpcCall, chainlink = CHAINLINK) {
  const [decimals] = await callDecoded(rpc, chainlink.ethUsd, CHAINLINK_I, "decimals", [], blockTag, rpcCallImpl);
  const [roundId, answer, , updatedAt, answeredInRound] = await callDecoded(rpc, chainlink.ethUsd, CHAINLINK_I, "latestRoundData", [], blockTag, rpcCallImpl);
  const age = validateOracleRound({ decimals: Number(decimals), roundId, answer, updatedAt, answeredInRound, blockTimestamp }, chainlink);
  return { feed: chainlink.ethUsd, decimals: chainlink.decimals, ethUsdRaw: answer.toString(), updatedAtRaw: updatedAt.toString(), ageSeconds: Number(age) };
}

function validateOracleRound({ decimals, roundId, answer, updatedAt, answeredInRound, blockTimestamp }, chainlink = CHAINLINK) {
  if (decimals !== chainlink.decimals || answer <= 0n || updatedAt <= 0n || answeredInRound < roundId || updatedAt > blockTimestamp + 60n) throw new ScanFailure("ORACLE_INVALID");
  const age = blockTimestamp - updatedAt;
  if (age > BigInt(chainlink.maxAgeSeconds)) throw new ScanFailure("ORACLE_STALE");
  return age;
}

function selectors(route = CURVE_ETH_ROUTE) {
  const routeConfig = route || CURVE_ETH_ROUTE;
  const iface = curveInterface(routeConfig);
  return {
    tokenDecimals: ERC20_I.getFunction("decimals").selector,
    curveCoins: iface.getFunction("coins").selector,
    curveFee: iface.getFunction("fee").selector,
    curveCalcTokenAmount: iface.getFunction("calc_token_amount").selector,
    curveCalcWithdrawOneCoin: iface.getFunction("calc_withdraw_one_coin").selector,
    chainlinkLatestRoundData: CHAINLINK_I.getFunction("latestRoundData").selector,
  };
}

async function executeRoundTrip({ direction, amountInRaw, quoteMint, quoteRedeem, route = CURVE_ETH_ROUTE }) {
  const routeConfig = route || CURVE_ETH_ROUTE;
  try {
    const lpOutRaw = await quoteMint({ tokenIndex: direction.index, amountInRaw });
    if (typeof lpOutRaw !== "bigint" || lpOutRaw <= 0n) throw new ScanFailure("QUOTE_FAILED");
    const amountOutRaw = await quoteRedeem({ tokenIndex: direction.index, lpInRaw: lpOutRaw });
    if (typeof amountOutRaw !== "bigint" || amountOutRaw <= 0n) throw new ScanFailure("QUOTE_FAILED");
    const delta = amountOutRaw - amountInRaw;
    return {
      direction: direction.id,
      token: direction.symbol,
      tokenIndex: direction.index,
      amountInRaw: amountInRaw.toString(),
      amountIn: ethers.formatUnits(amountInRaw, routeConfig.decimals[direction.index]),
      lpOutRaw: lpOutRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      amountOut: ethers.formatUnits(amountOutRaw, routeConfig.decimals[direction.index]),
      classification: delta > 0n ? "GROSS_EDGE_FORK_REQUIRED" : "NO_JOIN_EXIT_EDGE",
      grossDeltaRaw: delta.toString(),
      grossDelta: ethers.formatUnits(delta, routeConfig.decimals[direction.index]),
      grossBps: grossBps(delta, amountInRaw),
      mintView: "calc_token_amount",
      redeemView: "calc_withdraw_one_coin",
      flashFee: "0",
      gas: "bounded-ceiling",
      net: "unknown",
      routePositive: "unknown",
    };
  } catch (error) {
    return {
      direction: direction.id,
      token: direction.symbol,
      tokenIndex: direction.index,
      amountInRaw: amountInRaw.toString(),
      amountIn: ethers.formatUnits(amountInRaw, routeConfig.decimals[direction.index]),
      lpOutRaw: null,
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

async function scan(options = {}) {
  const route = options.route || CURVE_ETH_ROUTE;
  const rpcCallImpl = options.rpcCall || rpcCall;
  // Default to an endpoint-qualified resolver; injected resolvers are unchanged.
  const resolveRpcImpl = options.resolveRpc || resolveWorkingRpc;
  const iface = curveInterface(route);
  validateSizes(route.sizes, route.maxSize);
  const rpc = await resolveRpcImpl(route.chainId);
  if (!rpc) throw new ScanFailure("RPC_UNAVAILABLE");
  const { block, blockTag, finality } = await selectPin(rpc, rpcCallImpl);
  const binding = await bindRoute(rpc, blockTag, route, rpcCallImpl);
  const blockTimestampRaw = BigInt(block.timestamp);
  const oracle = await readOracle(rpc, blockTag, blockTimestampRaw, rpcCallImpl, route.chainlink);
  const quoteMint = async ({ tokenIndex, amountInRaw }) => {
    const amounts = route.coins.map((_, index) => (index === tokenIndex ? amountInRaw : 0n));
    const [lpOut] = await callDecoded(rpc, route.pool, iface, "calc_token_amount", [amounts, true], blockTag, rpcCallImpl);
    return BigInt(lpOut);
  };
  const quoteRedeem = async ({ tokenIndex, lpInRaw }) => {
    const [amountOut] = await callDecoded(rpc, route.pool, iface, "calc_withdraw_one_coin", [lpInRaw, BigInt(tokenIndex)], blockTag, rpcCallImpl);
    return BigInt(amountOut);
  };
  const rows = [];
  for (const size of route.sizes) {
    for (const direction of route.directions) {
      const amountInRaw = size * 10n ** BigInt(route.decimals[direction.index]);
      rows.push(await executeRoundTrip({ direction, amountInRaw, quoteMint, quoteRedeem, route }));
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
      joinExit: {
        pool: route.pool,
        ...(route.quoteInflationBps !== undefined ? { quoteInflationBps: route.quoteInflationBps } : {}),
      },
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
      pool: route.pool,
      lpToken: route.lpToken,
      coins: [...route.coins],
      arrayType: route.arrayType,
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
    scanner: "tools/scan-curve-join-exit.js",
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
      tokens: { base: route.coins[0], quote: route.coins[route.coins.length - 1] },
      curve: {
        pool: route.pool,
        lpToken: route.lpToken,
        arrayType: route.arrayType,
        coins: [...route.coins],
        decimals: [...route.decimals],
        feeRawAtPin: binding.feeRaw.toString(),
        quoteSource: route.quoteSource,
        quoteExecutable: route.quoteExecutable,
        ...(route.quoteInflationBps !== undefined ? { quoteInflationBps: route.quoteInflationBps } : {}),
      },
      selectors: selectors(route),
      runtimeChecksAtPin: { tokenDecimals: true, coinOrdering: true, lpToken: true, codePresent: true },
    },
    methodology: {
      sizes: route.sizes.map(String),
      directions: route.directions.map((direction) => direction.id),
      completeRoundTripsOnly: true,
      quoteSource: route.quoteSource,
      quoteExecutable: route.quoteExecutable,
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
      ? "Run one fixed-pin local-fork atomic Curve add_liquidity (single-token mint) then remove_liquidity_one_coin (same-token redeem) for the emitted candidate values, including flash repayment and unwind."
      : "No fork: refresh the same bounded complete mint/redeem scan only after material state movement.",
  };
}

function coverageEvidence(artifact, family, route = CURVE_ETH_ROUTE) {
  const routeConfig = route || CURVE_ETH_ROUTE;
  const failed = artifact.rows.filter((row) => row.economics.status === "FAILED").length;
  const expected = routeConfig.sizes.length * routeConfig.directions.length;
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
      `${sizeWord(routeConfig)} sizes for closed single-token Curve add_liquidity/remove_liquidity_one_coin round trips (${routeConfig.directions.map((direction) => direction.symbol).join(", ")})`,
    ],
    blockers: [],
  };
}

function relPosix(target) {
  return path.relative(WORKSPACE, target).split(path.sep).join("/");
}

function publish(artifact, options = {}) {
  const route = options.route || CURVE_ETH_ROUTE;
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
  for (const route of [CURVE_ETH_ROUTE, CURVE_BASE_ROUTE]) {
    const artifact = await scan({ route });
    publish(artifact, { route });
    for (const row of artifact.rows) {
      console.log(`${row.amountIn} ${row.token} ${row.direction}: ${row.economics.status} grossBps=${row.grossBps === null ? "unknown" : row.grossBps}`);
    }
    console.log(`Pinned ${artifact.pin.finality} block ${artifact.pin.number}; gross-positive rows=${artifact.grossPositiveRows}`);
  }
}

module.exports = {
  TOKENS,
  BASE_TOKENS,
  CHAINLINK,
  BASE_CHAINLINK,
  CURVE_ETH_ROUTE,
  CURVE_BASE_ROUTE,
  isCurveJoinExitRoute: (route) => (route || {}).venueKind === "curve-join-exit",
  curveInterface,
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
  coverageEvidence,
  publish,
  scan,
};

if (require.main === module) {
  main().catch(error => {
    console.error(`curve join/exit scan failed: ${sanitizeFailure(error)}`);
    process.exitCode = 1;
  });
}
