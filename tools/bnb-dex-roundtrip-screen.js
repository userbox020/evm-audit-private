"use strict";

const { Interface, formatUnits, parseUnits } = require("ethers");

// No transport, provider, file, environment, or execution hooks. The caller must
// bind every injected call to chain 56 at ONE finalized block. Return decoded
// Results or null for unavailable/reverted reads; unexpected thrown errors abort.
const TOKENS = [
  ["WBNB", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"],
  ["USDT", "0x55d398326f99059fF775485246999027B3197955"],
  ["slisBNB", "0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B"],
].map(([symbol, address]) => ({ symbol, address: address.toLowerCase() }));
const VENUES = [
  { venue: "uniswap-v3", kind: "v3", address: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077", fees: [100, 500, 3000] },
  { venue: "pancake-v3", kind: "v3", address: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997", fees: [100, 500, 2500] },
  { venue: "sushi-v2", kind: "v2", address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", fees: [null] },
].map((venue) => ({ ...venue, address: venue.address.toLowerCase() }));
const SIZES = ["0.01", "0.1", "1", "10"];
const ERC20 = new Interface(["function decimals() view returns (uint8)"]);
const V3_QUOTER = new Interface([
  "function factory() view returns (address)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const V2_ROUTER = new Interface([
  "function factory() view returns (address)",
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)",
]);
const FACTORY = new Interface([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
  "function getPair(address tokenA,address tokenB) view returns (address)",
]);
const POOL = new Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
]);
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

async function screen({ call }) {
  if (typeof call !== "function") throw new TypeError("screen requires an injected call function");
  const coverageGaps = [];
  const pools = [];
  const rows = [];
  let calls = 0;
  let quoteCalls = 0;
  async function read(to, iface, name, args = []) {
    calls += 1;
    return call(to, iface, name, args);
  }

  const tokens = [];
  for (const token of TOKENS) {
    const result = await read(token.address, ERC20, "decimals");
    const observed = result?.[0];
    const valid = uint(observed, 8) && observed === 18n;
    tokens.push({ ...token, decimals: valid ? 18 : null,
      observedDecimals: uint(observed, 8) ? observed.toString() : null,
      status: valid ? "VALID" : "INCOMPLETE" });
    if (!valid) coverageGaps.push({ stage: "decimals", token: token.symbol,
      reason: "DECIMALS_NOT_VERIFIED_18" });
  }

  const venues = [];
  for (const venue of VENUES) {
    const iface = venue.kind === "v3" ? V3_QUOTER : V2_ROUTER;
    const factory = address((await read(venue.address, iface, "factory"))?.[0]);
    venues.push({ ...venue, factory });
    if (!factory) coverageGaps.push({ stage: "factory", venue: venue.venue,
      reason: "FACTORY_UNAVAILABLE_OR_INVALID" });
  }

  const [wbnb, ...intermediates] = tokens;
  for (const token of intermediates) {
    const pair = `WBNB/${token.symbol}`;
    const seen = new Map();
    for (const venue of venues) {
      for (const fee of venue.fees) {
        const candidate = {
          id: `${pair}:${venue.venue}:${fee ?? "pair"}`, pair,
          venue: venue.venue, kind: venue.kind, quoteAddress: venue.address,
          fee, factory: venue.factory, pool: null, status: "INCOMPLETE", reason: null,
        };
        pools.push(candidate);
        if (wbnb.status !== "VALID" || token.status !== "VALID") {
          candidate.reason = "DECIMALS_NOT_VERIFIED_18";
        } else if (!venue.factory) {
          candidate.reason = "FACTORY_UNAVAILABLE_OR_INVALID";
        } else {
          const v3 = venue.kind === "v3";
          const result = await read(venue.factory, FACTORY, v3 ? "getPool" : "getPair",
            v3 ? [wbnb.address, token.address, fee] : [wbnb.address, token.address]);
          candidate.pool = address(result?.[0]);
          if (!candidate.pool) {
            candidate.reason = result?.[0] === "0x0000000000000000000000000000000000000000"
              ? "POOL_NOT_FOUND" : "POOL_LOOKUP_UNAVAILABLE_OR_INVALID";
          } else {
            const token0 = address((await read(candidate.pool, POOL, "token0"))?.[0]);
            const token1 = address((await read(candidate.pool, POOL, "token1"))?.[0]);
            const factory = address((await read(candidate.pool, POOL, "factory"))?.[0]);
            const poolFee = v3 ? (await read(candidate.pool, POOL, "fee"))?.[0] : null;
            const tokensMatch = (token0 === wbnb.address && token1 === token.address)
              || (token1 === wbnb.address && token0 === token.address);
            if (!tokensMatch || factory !== venue.factory || (v3 && poolFee !== BigInt(fee))) {
              candidate.reason = "POOL_IDENTITY_UNVERIFIED";
            } else if (seen.has(candidate.pool)) {
              candidate.status = "DUPLICATE";
              candidate.duplicateOf = seen.get(candidate.pool);
            } else {
              candidate.status = "VALID";
              seen.set(candidate.pool, candidate.id);
            }
          }
        }
        if (candidate.status === "INCOMPLETE") {
          coverageGaps.push({ stage: "pool", poolId: candidate.id, reason: candidate.reason });
        }
      }
    }

    async function quote(candidate, tokenIn, tokenOut, amountIn) {
      quoteCalls += 1;
      let amountOut = null;
      if (candidate.kind === "v3") {
        const result = await read(candidate.quoteAddress, V3_QUOTER, "quoteExactInputSingle", [{
          tokenIn, tokenOut, amountIn, fee: candidate.fee, sqrtPriceLimitX96: 0n,
        }]);
        if (result?.length === 4 && uint(result[0]) && uint(result[1], 160)
          && uint(result[2], 32) && uint(result[3])) amountOut = result[0];
      } else {
        const result = await read(candidate.quoteAddress, V2_ROUTER, "getAmountsOut",
          [amountIn, [tokenIn, tokenOut]]);
        const amounts = result?.[0];
        if (amounts?.length === 2 && amounts[0] === amountIn && uint(amounts[1])) {
          amountOut = amounts[1];
        }
      }
      if (amountOut === null) coverageGaps.push({ stage: "quote", poolId: candidate.id,
        tokenIn, tokenOut, amountInRaw: amountIn.toString(), reason: "QUOTE_UNAVAILABLE_OR_INVALID" });
      return amountOut;
    }

    // Retain unbound candidates as INCOMPLETE rows; they are never quoted.
    // Valid aliases are deduplicated by pool address, not by venue or fee tier.
    const candidates = pools.filter((pool) => pool.pair === pair && pool.status !== "DUPLICATE");
    for (const size of SIZES) {
      const amountIn = parseUnits(size, 18);
      for (const first of candidates) {
        const intermediate = first.status === "VALID"
          ? await quote(first, wbnb.address, token.address, amountIn) : null;
        for (const second of candidates) {
          if (first === second || (first.pool && first.pool === second.pool)) continue;
          const row = {
            pair, firstPoolId: first.id, secondPoolId: second.id,
            amountInRaw: amountIn.toString(), amountInWbnb: size,
            intermediateRaw: intermediate?.toString() ?? null,
            intermediateAmount: intermediate === null ? null : formatUnits(intermediate, 18),
            amountOutRaw: null, amountOutWbnb: null,
            grossDeltaRaw: null, grossDeltaWbnb: null, grossBps: null,
            classification: "INCOMPLETE", reason: null, ...UNKNOWN_GATES,
          };
          rows.push(row);
          if (first.status !== "VALID" || second.status !== "VALID") {
            row.reason = "POOL_BINDING_INCOMPLETE";
            continue;
          }
          if (intermediate === null) {
            row.reason = "FIRST_QUOTE_UNAVAILABLE_OR_INVALID";
            continue;
          }
          // Exact first-leg output, including its swap fee, feeds EVERY other pool.
          const amountOut = await quote(second, token.address, wbnb.address, intermediate);
          if (amountOut === null) {
            row.reason = "SECOND_QUOTE_UNAVAILABLE_OR_INVALID";
            continue;
          }
          const gross = amountOut - amountIn;
          row.amountOutRaw = amountOut.toString();
          row.amountOutWbnb = formatUnits(amountOut, 18);
          row.grossDeltaRaw = gross.toString();
          row.grossDeltaWbnb = formatUnits(gross, 18);
          // Every fixed input divides 10^19 exactly: no floating point/truncation.
          row.grossBps = formatUnits(gross * 10000n * (10n ** 19n / amountIn), 19);
          row.classification = gross > 0n ? "QUOTE_POSITIVE_REQUIRES_FORK" : "QUOTE_NONPOSITIVE";
        }
      }
    }
  }

  return {
    chainId: 56, evidenceStage: "QUOTE_ONLY", ...UNKNOWN_GATES,
    blockBinding: "CALLER_REQUIRED_SINGLE_FINALIZED_BLOCK",
    sizesWbnb: [...SIZES], tokens, pools, rows, coverageGaps,
    counts: {
      calls, quoteCalls, poolCandidates: pools.length,
      validDistinctPools: pools.filter((pool) => pool.status === "VALID").length,
      routes: rows.length,
      quotePositive: rows.filter((row) => row.classification === "QUOTE_POSITIVE_REQUIRES_FORK").length,
      quoteNonpositive: rows.filter((row) => row.classification === "QUOTE_NONPOSITIVE").length,
      incomplete: rows.filter((row) => row.classification === "INCOMPLETE").length,
      coverageGaps: coverageGaps.length,
    },
    limitations: [
      "V3 quote ABI does not prove full-input consumption; composed quotes are not atomic execution evidence.",
      "Swap fees are already included in quotes and are not subtracted again.",
      "No fork, financing, repayment, full-flow gas, MEV/competition, or conservative-net evidence.",
      "Finite two-pair, four-size pool grid only; missing bindings/quotes are coverage gaps, not negatives.",
      "The caller owns chain identity, transport, and single finalized-block binding; this engine cannot verify them.",
    ],
  };
}

module.exports = { screen };
