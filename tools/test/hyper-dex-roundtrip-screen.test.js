"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface, parseUnits } = require("ethers");
const { screen } = require("../hyper-dex-roundtrip-screen");

const WHYPE = "0x5555555555555555555555555555555555555555";
const WST = "0x94e8396e0869c9f2200760af0621afd240e1cf38";
const KHYPE = "0xfd739d4e423301ce9385c1fb8850539d657c296d";
const LAMINAR = "0x4a74faec90071f7ce52354900fccf41b1f5d4090";
const NEST = "0xbea20609a4772311c5b81f814cd4f9ecaef5dfad";
const PROJECT_X = "0x239f11a7a3e08f2b8110d4ca9f6b95d4c8865258";
const DEPLOYER = "0x3842ce04380b8655a3a47ed87ea0d311adca161f";
const VENUES = [
  { factory: "0x40059a6f242c3de0e639693973004921b04d96ad", quoter: LAMINAR },
  { factory: "0xf77bd082c627aa54591cf2f2eaa811fd1ab3b1f3", quoter: NEST },
  { factory: "0xff7b3e8c00e57ea31477c32a5b52a58eea47b072", quoter: PROJECT_X },
];
const POOLS = [
  { pool: "0x0a69a514cd9d7c8427fb819c55afb9939da20b80", token: WST, venue: 0, fee: 500n },
  { pool: "0x728c8e4e89472b96bd2b830438e0cb458f141db9", token: WST, venue: 1, fee: 50n },
  { pool: "0xa83d60b1a9ca6dd1d0d2d9275c700114f2f3a8d6", token: KHYPE, venue: 1, fee: 100n },
  { pool: "0xbe352daf66af94ccf2012a154a67daef95facb91", token: KHYPE, venue: 2, fee: 100n },
  { pool: "0xff0a1d682e614b8f913751ac97fe2086a40c476a", token: WST, venue: 2, fee: 100n },
];

function fixture(override = () => undefined) {
  const calls = [];
  let active = false;
  const call = async (to, iface, name, args) => {
    assert.equal(active, false, "calls must be serial, never fan out");
    active = true;
    try {
      await Promise.resolve();
      assert.ok(iface instanceof Interface);
      iface.encodeFunctionData(name, args);
      const entry = { to, iface, name, args };
      calls.push(entry);
      let result = override(entry);
      if (result === undefined) {
        const pool = POOLS.find((item) => item.pool === to);
        const quoter = VENUES.find((item) => item.quoter === to);
        if (name === "decimals") {
          assert.ok([WHYPE, WST, KHYPE].includes(to));
          result = [18n];
        } else if (name === "factory") {
          result = [pool ? VENUES[pool.venue].factory : quoter.factory];
        } else if (name === "poolDeployer") {
          assert.equal(to, NEST);
          result = [DEPLOYER];
        } else if (name === "token0") result = [WHYPE];
        else if (name === "token1") result = [pool.token];
        else if (name === "fee") result = [pool.fee];
        else if (name === "getPool" || name === "poolByPair") {
          assert.equal(args[0], WHYPE);
          const found = POOLS.find((item) => VENUES[item.venue].factory === to && item.token === args[1]);
          if (name === "getPool") assert.equal(BigInt(args[2]), found.fee);
          else assert.equal(args.length, 2);
          result = [found.pool];
        } else if (name === "quoteExactInputSingle") {
          const params = args[0];
          assert.equal(typeof params.amountIn, "bigint");
          if (to === NEST) {
            assert.deepEqual(Object.keys(params), ["tokenIn", "tokenOut", "amountIn", "limitSqrtPrice"]);
            result = [params.amountIn, params.amountIn, 1n << 96n, 0n, 50000n, 50n];
          } else {
            assert.deepEqual(Object.keys(params), ["tokenIn", "tokenOut", "amountIn", "fee", "sqrtPriceLimitX96"]);
            result = [params.amountIn, 1n << 96n, 0n, 50000n];
          }
        } else assert.fail(`Unexpected function ${name}`);
      }
      // Exercise the actual injected decoded Result contract, not plain objects.
      return result === null ? null : iface.decodeFunctionResult(name, iface.encodeFunctionResult(name, result));
    } finally {
      active = false;
    }
  };
  return { call, calls };
}

function route(result, first, second, size = "1") {
  return result.rows.find((row) => row.firstPoolId === first && row.secondPoolId === second
    && row.amountInWhype === size);
}

test("bounded serial grid covers every distinct ordering and size, excludes same-pool and keeps unknown gates", async () => {
  const { call, calls } = fixture();
  const result = await screen({ call });
  assert.equal(result.rows.length, 32);
  assert.equal(result.counts.calls, 84);
  assert.equal(calls.length, 84);
  assert.equal(result.counts.quoteCalls, 52);
  assert.equal(result.counts.quoteNonpositive, 8);
  assert.equal(result.counts.candidateAbiUnverified, 24);
  assert.equal(result.counts.incomplete, 0);
  assert.deepEqual(result.sizesWhype, ["0.1", "1", "10", "100"]);
  for (const row of result.rows) {
    assert.notEqual(row.firstPool, row.secondPool);
    assert.equal(row.routePositive, "unknown");
    assert.equal(row.executableNow, "unknown");
    assert.equal(row.conservativeNet, "unknown");
    assert.equal(row.fullInputConsumption, "unknown");
  }
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("exact intermediate wei propagate to leg two, with no second pool-fee subtraction", async () => {
  const { call, calls } = fixture(({ to, name, args }) => {
    if (name !== "quoteExactInputSingle") return undefined;
    const { amountIn, tokenIn } = args[0];
    if (to === LAMINAR && tokenIn === WHYPE) return [amountIn + 123n, 1n, 0n, 1n];
    if (to === NEST && tokenIn === WST) return [amountIn - 122n, amountIn, 1n, 0n, 1n, 50n];
    return undefined;
  });
  const result = await screen({ call });
  for (const size of result.sizesWhype) {
    const row = route(result, "Laminar-wstHYPE", "Nest-wstHYPE", size);
    const input = parseUnits(size, 18);
    assert.equal(row.intermediateRaw, (input + 123n).toString());
    assert.equal(row.legs[1].amountInRaw, row.intermediateRaw);
    assert.ok(calls.some((entry) => entry.to === NEST && entry.name === "quoteExactInputSingle"
      && entry.args[0].tokenIn === WST && entry.args[0].amountIn === input + 123n));
    assert.equal(row.grossDeltaRaw, "1");
    assert.equal(row.grossDeltaWhype, "0.000000000000000001");
    assert.equal(row.classification, "QUOTE_POSITIVE_REQUIRES_FORK");
    assert.equal(row.legs[0].amountInUsedRaw, null);
    assert.equal(row.legs[0].fullInputConsumption, "unknown");
    assert.equal(row.legs[1].fullInputConsumption, "true");
  }
  assert.equal(route(result, "Laminar-wstHYPE", "Nest-wstHYPE", "100").grossBps, "0.0000000000000001");
});

for (const direction of ["first", "second"]) {
  test(`Nest ${direction}-leg partial fills retain output and consumed input without roundtrip classification`, async () => {
    const { call, calls } = fixture(({ to, name, args }) => {
      if (to !== NEST || name !== "quoteExactInputSingle") return undefined;
      const { amountIn, tokenIn } = args[0];
      if ((direction === "first") !== (tokenIn === WHYPE)) return undefined;
      return [amountIn / 3n, amountIn / 2n, 1n, 0n, 1n, 50n];
    });
    const result = await screen({ call });
    const row = direction === "first" ? route(result, "Nest-wstHYPE", "Laminar-wstHYPE")
      : route(result, "Laminar-wstHYPE", "Nest-wstHYPE");
    const leg = row.legs.at(-1);
    assert.equal(row.classification, "INCOMPLETE");
    assert.equal(row.reason, `${direction.toUpperCase()}_PARTIAL_INPUT_CONSUMPTION`);
    assert.equal(row.grossDeltaRaw, null);
    assert.equal(row.grossBps, null);
    assert.equal(row.fullInputConsumption, "false");
    assert.equal(leg.amountInUsedRaw, (parseUnits("1", 18) / 2n).toString());
    assert.equal(leg.amountOutRaw, (parseUnits("1", 18) / 3n).toString());
    assert.equal(row.legs.length, direction === "first" ? 1 : 2);
    if (direction === "first") assert.equal(calls.some((entry) => entry.to === LAMINAR
      && entry.name === "quoteExactInputSingle" && entry.args[0].tokenIn === WST
      && entry.args[0].amountIn === BigInt(leg.amountOutRaw)), false);
    else assert.equal(row.amountOutRaw, leg.amountOutRaw);
  });
}

test("Project X positive or negative quote differences stay candidate-ABI-only", async () => {
  const { call } = fixture(({ to, name, args }) => {
    if (to === PROJECT_X && name === "quoteExactInputSingle") {
      return [args[0].amountIn + 10n, 1n, 0n, 1n];
    }
    return undefined;
  });
  const result = await screen({ call });
  for (const row of result.rows.filter((item) => item.firstPoolId.startsWith("ProjectX")
    || item.secondPoolId.startsWith("ProjectX"))) {
    assert.ok(BigInt(row.grossDeltaRaw) > 0n);
    assert.equal(row.classification, "CANDIDATE_ABI_UNVERIFIED");
    assert.equal(row.routePositive, "unknown");
  }
  assert.equal(result.counts.quotePositive, 0);
});

for (const [label, to, name, value, poolId] of [
  ["token0", POOLS[0].pool, "token0", KHYPE, "Laminar-wstHYPE"],
  ["token1", POOLS[0].pool, "token1", KHYPE, "Laminar-wstHYPE"],
  ["pool factory", POOLS[0].pool, "factory", VENUES[1].factory, "Laminar-wstHYPE"],
  ["pool fee", POOLS[0].pool, "fee", 100n, "Laminar-wstHYPE"],
  ["factory lookup", VENUES[0].factory, "getPool", POOLS[4].pool, "Laminar-wstHYPE"],
  ["quoter factory", LAMINAR, "factory", VENUES[1].factory, "Laminar-wstHYPE"],
  ["Nest deployer", NEST, "poolDeployer", VENUES[1].factory, "Nest-wstHYPE"],
  ["Nest pair lookup", VENUES[1].factory, "poolByPair", POOLS[0].pool, "Nest-wstHYPE"],
  ["missing Nest fee", POOLS[1].pool, "fee", null, "Nest-wstHYPE"],
]) {
  test(`${label} mismatch/unavailability fails closed`, async () => {
    const { call, calls } = fixture((entry) => entry.to === to && entry.name === name
      ? value === null ? null : [value] : undefined);
    const result = await screen({ call });
    const pool = result.pools.find((item) => item.id === poolId);
    assert.equal(pool.status, "INCOMPLETE");
    for (const row of result.rows.filter((item) => item.firstPoolId === poolId || item.secondPoolId === poolId)) {
      assert.equal(row.classification, "INCOMPLETE");
      assert.equal(row.grossDeltaRaw, null);
    }
    assert.equal(calls.some((entry) => entry.to === pool.quoteAddress && entry.name === "quoteExactInputSingle"
      && (entry.args[0].tokenIn === pool.token1 || entry.args[0].tokenOut === pool.token1)), false);
  });
}

test("all three token decimals are verified; mismatched decimals block affected routes", async () => {
  for (const token of [WHYPE, WST, KHYPE]) {
    const { call, calls } = fixture(({ to, name }) => to === token && name === "decimals" ? [6n] : undefined);
    const result = await screen({ call });
    const affected = token === WHYPE ? result.rows
      : result.rows.filter((row) => row.pair === `WHYPE/${token === WST ? "wstHYPE" : "kHYPE"}`);
    assert.ok(affected.every((row) => row.classification === "INCOMPLETE"));
    assert.equal(calls.some((entry) => entry.name === "quoteExactInputSingle"
      && (entry.args[0].tokenIn === token || entry.args[0].tokenOut === token)), false);
  }
});

test("Nest pinned dynamic fee need not equal the historical reference or be subtracted again", async () => {
  const { call } = fixture(({ to, name }) => POOLS.some((pool) => pool.venue === 1 && pool.pool === to)
    && name === "fee" ? [75n] : undefined);
  const result = await screen({ call });
  assert.ok(result.pools.filter((pool) => pool.kind === "nest").every((pool) => pool.status === "VALID" && pool.fee === "75"));
  const row = route(result, "Laminar-wstHYPE", "Nest-wstHYPE");
  assert.equal(row.legs[1].quoteFee, "50");
  assert.equal(row.grossDeltaRaw, "0");
  assert.equal(row.classification, "QUOTE_NONPOSITIVE");
});

test("missing callback or null calls are incomplete, not negative", async () => {
  for (const options of [undefined, {}, { call: async () => null }]) {
    const result = await screen(options);
    assert.equal(result.counts.incomplete, 32);
    assert.equal(result.counts.quoteCalls, 0);
    assert.equal(result.counts.quoteNonpositive, 0);
    assert.ok(result.coverageGaps.length > 0);
  }
});

test("missing first or second quote is incomplete, not negative", async () => {
  for (const missingQuoter of [LAMINAR, NEST]) {
    const { call } = fixture(({ to, name }) => to === missingQuoter && name === "quoteExactInputSingle" ? null : undefined);
    const result = await screen({ call });
    const row = route(result, "Laminar-wstHYPE", "Nest-wstHYPE");
    assert.equal(row.classification, "INCOMPLETE");
    assert.equal(row.grossDeltaRaw, null);
    assert.equal(row.reason, `${missingQuoter === LAMINAR ? "FIRST" : "SECOND"}_QUOTE_UNAVAILABLE_OR_INVALID`);
  }
});

test("Nest overconsumption is invalid and preserves both raw fields", async () => {
  const { call } = fixture(({ to, name, args }) => to === NEST && name === "quoteExactInputSingle"
    ? [args[0].amountIn, args[0].amountIn + 1n, 1n, 0n, 1n, 50n] : undefined);
  const row = route(await screen({ call }), "Laminar-wstHYPE", "Nest-wstHYPE");
  assert.equal(row.classification, "INCOMPLETE");
  assert.equal(row.reason, "SECOND_INVALID_INPUT_CONSUMPTION");
  assert.equal(row.legs[1].amountInUsedRaw, (parseUnits("1", 18) + 1n).toString());
  assert.equal(row.grossDeltaRaw, null);
});

test("negative raw differences and bps remain exact BigInt calculations", async () => {
  const { call } = fixture(({ to, name, args }) => to === NEST && name === "quoteExactInputSingle"
    ? [args[0].amountIn - 1n, args[0].amountIn, 1n, 0n, 1n, 50n] : undefined);
  const row = route(await screen({ call }), "Laminar-wstHYPE", "Nest-wstHYPE", "0.1");
  assert.equal(row.grossDeltaRaw, "-1");
  assert.equal(row.grossDeltaWhype, "-0.000000000000000001");
  assert.equal(row.grossBps, "-0.0000000000001");
  assert.equal(row.classification, "QUOTE_NONPOSITIVE");
});

test("parent stop/budget exceptions propagate without retries", async () => {
  let calls = 0;
  const stop = new Error("PARENT_STOP");
  await assert.rejects(screen({ call: async () => { calls += 1; throw stop; } }), (error) => error === stop);
  assert.equal(calls, 1);
});
