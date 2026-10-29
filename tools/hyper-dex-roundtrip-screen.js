"use strict";

const { Interface, formatUnits, parseUnits } = require("ethers");

// Import-inert, transport-free screen. The parent must bind every injected call
// to chain 999 at ONE finalized block. Null means unavailable; unexpected thrown
// transport/budget errors propagate so this engine cannot bypass a parent stop.
const TOKENS = [
  ["WHYPE", "0x5555555555555555555555555555555555555555"],
  ["wstHYPE", "0x94e8396e0869c9F2200760aF0621aFd240E1CF38"],
  ["kHYPE", "0xfD739d4e423301CE9385c1fb8850539D657C296D"],
].map(([symbol, address]) => ({ symbol, address: address.toLowerCase() }));
const VENUES = [
  { venue: "Laminar", kind: "v3", factory: "0x40059a6f242c3de0e639693973004921b04d96ad",
    quoter: "0x4a74faec90071f7ce52354900fccf41b1f5d4090" },
  { venue: "Nest", kind: "nest", factory: "0xF77Bd082c627aA54591cF2f2EaA811fd1AB3b1F3",
    quoter: "0xBea20609A4772311c5b81F814Cd4f9ECaEF5DFAd",
    poolDeployer: "0x3842CE04380B8655A3A47Ed87eA0D311ADCa161F" },
  { venue: "ProjectX", kind: "v3", factory: "0xFf7B3e8C00e57ea31477c32A5B52a58Eea47b072",
    quoter: "0x239F11a7A3E08f2B8110D4CA9F6B95d4c8865258", candidateAbi: true },
].map((venue) => ({ ...venue, factory: venue.factory.toLowerCase(),
  quoter: venue.quoter.toLowerCase(), poolDeployer: venue.poolDeployer?.toLowerCase() ?? null }));
// Identities from hyper-pool-bindings.json; no file is loaded at runtime.
const POOLS = [
  ["Laminar", "wstHYPE", "0x0A69A514CD9D7C8427FB819c55Afb9939Da20b80", 500],
  ["Nest", "wstHYPE", "0x728C8E4E89472B96Bd2B830438E0CB458F141db9", 50],
  ["Nest", "kHYPE", "0xA83D60b1a9CA6Dd1d0D2d9275c700114F2F3a8d6", 100],
  ["ProjectX", "kHYPE", "0xbe352daF66af94ccF2012a154a67DAEF95FAcB91", 100],
  ["ProjectX", "wstHYPE", "0xff0A1d682E614B8f913751aC97Fe2086a40C476A", 100],
].map(([venue, token, pool, referenceFee]) => ({ venue, token, pool: pool.toLowerCase(), referenceFee }));
const SIZES = ["0.1", "1", "10", "100"];
const ERC20 = new Interface(["function decimals() view returns (uint8)"]);
const V3_QUOTER = new Interface([
  "function factory() view returns (address)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const NEST_QUOTER = new Interface([
  "function factory() view returns (address)",
  "function poolDeployer() view returns (address)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint160 limitSqrtPrice) params) returns (uint256 amountOut,uint256 amountInUsed,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate,uint16 fee)",
]);
const FACTORY = new Interface([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
  "function poolByPair(address tokenA,address tokenB) view returns (address)",
]);
const POOL_IDENTITY_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
];
const V3_POOL = new Interface([...POOL_IDENTITY_ABI, "function fee() view returns (uint24)"]);
const NEST_POOL = new Interface([...POOL_IDENTITY_ABI, "function fee() view returns (uint16)"]);
const UNKNOWN_GATES = {
  routePositive: "unknown", executableNow: "unknown", conservativeNet: "unknown",
};

function uint(value, bits = 256) {
  return typeof value === "bigint" && value >= 0n && value < (1n << BigInt(bits));
}

function address(value) {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value)
    && !/^0x0{40}$/i.test(value) ? value.toLowerCase() : null;
}

async function screen({ call } = {}) {
  const coverageGaps = [];
  const rows = [];
  let calls = 0;
  let quoteCalls = 0;
  async function read(to, iface, name, args = []) {
    if (typeof call !== "function") return null;
    calls += 1;
    return call(to, iface, name, args);
  }
  if (typeof call !== "function") coverageGaps.push({ stage: "call", reason: "CALL_UNAVAILABLE" });

  const tokens = [];
  for (const token of TOKENS) {
    const observed = (await read(token.address, ERC20, "decimals"))?.[0];
    const valid = uint(observed, 8) && observed === 18n;
    tokens.push({ ...token, decimals: valid ? 18 : null,
      observedDecimals: uint(observed, 8) ? observed.toString() : null,
      status: valid ? "VALID" : "INCOMPLETE" });
    if (!valid) coverageGaps.push({ stage: "decimals", token: token.symbol,
      reason: "DECIMALS_NOT_VERIFIED_18" });
  }

  const venues = [];
  for (const venue of VENUES) {
    const iface = venue.kind === "nest" ? NEST_QUOTER : V3_QUOTER;
    const observedFactory = address((await read(venue.quoter, iface, "factory"))?.[0]);
    const observedPoolDeployer = venue.kind === "nest"
      ? address((await read(venue.quoter, iface, "poolDeployer"))?.[0]) : null;
    const valid = observedFactory === venue.factory
      && (venue.kind !== "nest" || observedPoolDeployer === venue.poolDeployer);
    venues.push({ ...venue, observedFactory, observedPoolDeployer, status: valid ? "VALID" : "INCOMPLETE" });
    if (!valid) coverageGaps.push({ stage: "quoter", venue: venue.venue,
      reason: observedFactory !== venue.factory ? "QUOTER_FACTORY_UNVERIFIED" : "QUOTER_DEPLOYER_UNVERIFIED" });
  }

  const [whype, ...intermediates] = tokens;
  const pools = [];
  for (const expected of POOLS) {
    const venue = venues.find((item) => item.venue === expected.venue);
    const token = tokens.find((item) => item.symbol === expected.token);
    const nest = venue.kind === "nest";
    const iface = nest ? NEST_POOL : V3_POOL;
    const token0 = address((await read(expected.pool, iface, "token0"))?.[0]);
    const token1 = address((await read(expected.pool, iface, "token1"))?.[0]);
    const factory = address((await read(expected.pool, iface, "factory"))?.[0]);
    const fee = (await read(expected.pool, iface, "fee"))?.[0];
    const lookupPool = address((await read(venue.factory, FACTORY, nest ? "poolByPair" : "getPool",
      nest ? [whype.address, token.address] : [whype.address, token.address, expected.referenceFee]))?.[0]);
    const reasons = [];
    if (whype.status !== "VALID" || token.status !== "VALID") reasons.push("DECIMALS_NOT_VERIFIED_18");
    if (venue.status !== "VALID") reasons.push("QUOTER_BINDING_INCOMPLETE");
    if (token0 !== whype.address || token1 !== token.address || factory !== venue.factory) {
      reasons.push("POOL_IDENTITY_UNVERIFIED");
    }
    // Nest has a dynamic fee, not a factory lookup fee tier. Validate and retain
    // its pinned uint16 fee; the historical reference is not a fixed-fee promise.
    if (!uint(fee, nest ? 16 : 24) || (!nest && fee !== BigInt(expected.referenceFee))) {
      reasons.push("POOL_FEE_UNVERIFIED");
    }
    if (lookupPool !== expected.pool) reasons.push("FACTORY_POOL_LOOKUP_UNVERIFIED");
    const pool = { ...expected, id: `${expected.venue}-${token.symbol}`, pair: `WHYPE/${token.symbol}`,
      kind: venue.kind, quoteAddress: venue.quoter, expectedFactory: venue.factory,
      token0, token1, factory, lookupPool, fee: uint(fee, nest ? 16 : 24) ? fee.toString() : null,
      feeModel: nest ? "DYNAMIC" : "FIXED_TIER", candidateAbi: venue.candidateAbi === true,
      status: reasons.length ? "INCOMPLETE" : "VALID", reasons };
    pools.push(pool);
    for (const reason of reasons) coverageGaps.push({ stage: "pool", poolId: pool.id, reason });
    if (pool.candidateAbi) coverageGaps.push({ stage: "abi", poolId: pool.id,
      reason: "CANDIDATE_ABI_UNVERIFIED" });
  }

  async function quote(pool, tokenIn, tokenOut, amountIn) {
    quoteCalls += 1;
    const nest = pool.kind === "nest";
    const params = nest ? { tokenIn, tokenOut, amountIn, limitSqrtPrice: 0n }
      : { tokenIn, tokenOut, amountIn, fee: BigInt(pool.fee), sqrtPriceLimitX96: 0n };
    const result = await read(pool.quoteAddress, nest ? NEST_QUOTER : V3_QUOTER,
      "quoteExactInputSingle", [params]);
    const leg = { poolId: pool.id, pool: pool.pool, tokenIn, tokenOut,
      amountInRaw: amountIn.toString(), amountOutRaw: uint(result?.[0]) ? result[0].toString() : null,
      amountInUsedRaw: nest && uint(result?.[1]) ? result[1].toString() : null,
      fullInputConsumption: "unknown", status: "INCOMPLETE", reason: null,
      abiStatus: pool.candidateAbi ? "CANDIDATE_ABI_UNVERIFIED" : "SOURCE_VERIFIED_ABI",
      sqrtPriceX96AfterRaw: null, initializedTicksCrossed: null, gasEstimateRaw: null, quoteFee: null };
    const offset = nest ? 1 : 0;
    const valid = result?.length === (nest ? 6 : 4) && uint(result[0])
      && (!nest || (uint(result[1]) && uint(result[5], 16)))
      && uint(result[1 + offset], 160) && uint(result[2 + offset], 32) && uint(result[3 + offset]);
    if (!valid) {
      leg.reason = "QUOTE_UNAVAILABLE_OR_INVALID";
    } else {
      leg.sqrtPriceX96AfterRaw = result[1 + offset].toString();
      leg.initializedTicksCrossed = result[2 + offset].toString();
      leg.gasEstimateRaw = result[3 + offset].toString();
      if (nest) {
        leg.quoteFee = result[5].toString();
        leg.fullInputConsumption = result[1] === amountIn ? "true" : "false";
      }
      if (nest && result[1] !== amountIn) {
        leg.reason = result[1] < amountIn ? "PARTIAL_INPUT_CONSUMPTION" : "INVALID_INPUT_CONSUMPTION";
      } else {
        leg.status = "QUOTED";
      }
    }
    if (leg.status === "INCOMPLETE") coverageGaps.push({ stage: "quote", poolId: pool.id,
      tokenIn, tokenOut, amountInRaw: leg.amountInRaw, reason: leg.reason });
    return leg;
  }

  for (const token of intermediates) {
    const candidates = pools.filter((pool) => pool.token === token.symbol);
    for (const size of SIZES) {
      const amountIn = parseUnits(size, 18);
      for (const first of candidates) {
        // Reuse this identical pinned first-leg quote across distinct second pools.
        const leg1 = first.status === "VALID" ? await quote(first, whype.address, token.address, amountIn) : null;
        for (const second of candidates) {
          if (first.pool === second.pool) continue;
          const candidateAbi = first.candidateAbi || second.candidateAbi;
          const row = { pair: first.pair, firstPoolId: first.id, secondPoolId: second.id,
            firstPool: first.pool, secondPool: second.pool, amountInRaw: amountIn.toString(), amountInWhype: size,
            intermediateRaw: leg1?.amountOutRaw ?? null,
            intermediateAmount: leg1?.amountOutRaw == null ? null : formatUnits(leg1.amountOutRaw, 18),
            amountOutRaw: null, amountOutWhype: null, grossDeltaRaw: null, grossDeltaWhype: null, grossBps: null,
            classification: "INCOMPLETE", reason: null,
            abiStatus: candidateAbi ? "CANDIDATE_ABI_UNVERIFIED" : "SOURCE_VERIFIED_ABI",
            fullInputConsumption: leg1?.fullInputConsumption === "false" ? "false" : "unknown",
            legs: leg1 ? [{ ...leg1 }] : [], ...UNKNOWN_GATES };
          rows.push(row);
          if (first.status !== "VALID" || second.status !== "VALID") {
            row.reason = "POOL_BINDING_INCOMPLETE";
            continue;
          }
          if (leg1.status !== "QUOTED") {
            row.reason = `FIRST_${leg1.reason}`;
            continue;
          }
          // Quotes already incorporate swap fees. Never haircut the intermediate
          // or subtract the pool fee again; preserve every raw output wei.
          const leg2 = await quote(second, token.address, whype.address, BigInt(leg1.amountOutRaw));
          row.legs.push(leg2);
          row.amountOutRaw = leg2.amountOutRaw;
          row.amountOutWhype = leg2.amountOutRaw === null ? null : formatUnits(leg2.amountOutRaw, 18);
          if (leg2.fullInputConsumption === "false") row.fullInputConsumption = "false";
          if (leg2.status !== "QUOTED") {
            row.reason = `SECOND_${leg2.reason}`;
            continue;
          }
          const gross = BigInt(leg2.amountOutRaw) - amountIn;
          row.grossDeltaRaw = gross.toString();
          row.grossDeltaWhype = formatUnits(gross, 18);
          // All four inputs divide 10^20 exactly, so even 1 wei has exact bps.
          row.grossBps = formatUnits(gross * 10000n * (10n ** 20n / amountIn), 20);
          row.classification = candidateAbi ? "CANDIDATE_ABI_UNVERIFIED"
            : gross > 0n ? "QUOTE_POSITIVE_REQUIRES_FORK" : "QUOTE_NONPOSITIVE";
          if (candidateAbi) row.reason = "PROJECT_X_QUOTER_ABI_AND_SOURCE_UNVERIFIED";
        }
      }
    }
  }

  return {
    chainId: 999, evidenceStage: "QUOTE_ONLY", ...UNKNOWN_GATES,
    blockBinding: "CALLER_REQUIRED_SINGLE_FINALIZED_BLOCK",
    sizesWhype: [...SIZES], tokens, venues, pools, rows, coverageGaps,
    counts: { calls, quoteCalls, poolCandidates: pools.length,
      validDistinctPools: pools.filter((pool) => pool.status === "VALID").length,
      routes: rows.length,
      quotePositive: rows.filter((row) => row.classification === "QUOTE_POSITIVE_REQUIRES_FORK").length,
      quoteNonpositive: rows.filter((row) => row.classification === "QUOTE_NONPOSITIVE").length,
      candidateAbiUnverified: rows.filter((row) => row.classification === "CANDIDATE_ABI_UNVERIFIED").length,
      incomplete: rows.filter((row) => row.classification === "INCOMPLETE").length,
      coverageGaps: coverageGaps.length },
    limitations: [
      "V3 quotes lack consumed-input returns: full input consumption remains unproven, not assumed true.",
      "Nest requires amountInUsed equal to the requested input on each leg; partial fills are incomplete, not full-roundtrip negatives.",
      "Project X uses a candidate V3 ABI without external source verification; its rows are not execution proof.",
      "Swap fees are already included in quoted outputs and are not subtracted again.",
      "No fork, financing, repayment, full-flow gas, slippage, competition, or conservative-net evidence; gas estimates are not full-flow cost.",
      "TVL and observed liquidity are not executable capacity; this finite grid is not a universal disproof.",
      "Missing bindings, decimals, and quotes are coverage gaps, not negatives.",
      "The parent owns chain identity, transport, and single finalized-block binding; this engine cannot verify them.",
      "All raw amounts and bps use BigInt arithmetic; raw integers are returned as decimal strings for JSON evidence.",
    ],
  };
}

module.exports = { screen };
