"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface, parseUnits } = require("ethers");
const { screen } = require("../bnb-dex-roundtrip-screen");

const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const SLIS = "0xb0b84d294e0c75a6abe60171b70edeb2efd14a1b";
const UNI = "0x78d78e420da98ad378d7799be8f4af69033eb077";
const PANCAKE = "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997";
const SUSHI = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";
const addr = (number) => `0x${number.toString(16).padStart(40, "0")}`;
const FACTORIES = new Map([[UNI, addr(1)], [PANCAKE, addr(2)], [SUSHI, addr(3)]]);

function mock({ override = () => undefined, quote = ({ amountIn }) => amountIn,
  alias = false } = {}) {
  const history = [];
  const pools = new Map();
  let active = 0;
  let peak = 0;
  async function call(to, iface, name, args) {
    assert.ok(iface instanceof Interface);
    // ABI roundtrips exercise real decoded ethers Results and tuple ordering.
    const decodedArgs = iface.decodeFunctionData(name, iface.encodeFunctionData(name, args));
    const request = { to, name, args: decodedArgs };
    history.push(request);
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    try {
      const overridden = override(request);
      let values = overridden;
      if (overridden === undefined) {
        if (name === "decimals") values = [18n];
        else if (name === "factory") {
          values = [FACTORIES.has(to) ? (alias && to === PANCAKE ? FACTORIES.get(UNI) : FACTORIES.get(to))
            : pools.get(to).factory];
        } else if (name === "getPool" || name === "getPair") {
          const token = decodedArgs[1].toLowerCase();
          const fee = name === "getPool" ? decodedArgs[2] : null;
          const pool = addr(Number(BigInt(to)) * 10000 + (token === USDT ? 0 : 5000) + Number(fee ?? 1n));
          pools.set(pool, { factory: to, token, fee });
          values = [pool];
        } else if (name === "token0") values = [pools.get(to).token];
        else if (name === "token1") values = [WBNB];
        else if (name === "fee") values = [pools.get(to).fee];
        else if (name === "quoteExactInputSingle" || name === "getAmountsOut") {
          const v3 = name === "quoteExactInputSingle";
          const amountIn = v3 ? decodedArgs[0].amountIn : decodedArgs[0];
          const tokenIn = (v3 ? decodedArgs[0].tokenIn : decodedArgs[1][0]).toLowerCase();
          const tokenOut = (v3 ? decodedArgs[0].tokenOut : decodedArgs[1][1]).toLowerCase();
          const fee = v3 ? decodedArgs[0].fee : null;
          if (v3) assert.equal(decodedArgs[0].sqrtPriceLimitX96, 0n);
          const amountOut = quote({ to, amountIn, tokenIn, tokenOut, fee });
          values = amountOut === null ? null : v3
            ? [amountOut, 2n ** 96n, 0n, 50000n] : [[amountIn, amountOut]];
        } else assert.fail(`Unexpected mock call: ${name}`);
      }
      return values === null ? null : iface.decodeFunctionResult(name, iface.encodeFunctionResult(name, values));
    } finally {
      active -= 1;
    }
  }
  return { call, history, get peak() { return peak; } };
}

const quoteRequests = (history) => history.filter(({ name }) =>
  name === "quoteExactInputSingle" || name === "getAmountsOut");

test("exhausts every ordered distinct pool route; leg two consumes the exact intermediate", async () => {
  const fixture = mock({ quote: ({ amountIn, tokenIn }) => tokenIn === WBNB
    ? amountIn * 3n + 7n : amountIn });
  const result = await screen(fixture);
  assert.equal(result.chainId, 56);
  assert.equal(result.counts.validDistinctPools, 14);
  assert.equal(result.counts.routes, 2 * 4 * 7 * 6);
  assert.equal(result.counts.quoteCalls, 2 * 4 * (7 + 7 * 6));
  assert.equal(result.counts.calls, 466);
  assert.equal(result.counts.incomplete, 0);
  assert.equal(fixture.peak, 1);
  for (const row of result.rows) {
    assert.notEqual(row.firstPoolId, row.secondPoolId);
    assert.equal(BigInt(row.intermediateRaw), BigInt(row.amountInRaw) * 3n + 7n);
    assert.equal(row.amountOutRaw, row.intermediateRaw);
  }
  const requests = quoteRequests(fixture.history);
  const secondRequests = requests.filter(({ name, args }) => (name === "getAmountsOut"
    ? args[1][0] : args[0].tokenIn).toLowerCase() !== WBNB);
  assert.equal(secondRequests.length, 336);
  for (const { name, args } of secondRequests) {
    const input = name === "getAmountsOut" ? args[0] : args[0].amountIn;
    assert.ok(result.sizesWbnb.some((size) => input === parseUnits(size, 18) * 3n + 7n));
  }
  assert.equal(new Set(result.rows.map((row) =>
    `${row.pair}:${row.amountInRaw}:${row.firstPoolId}:${row.secondPoolId}`)).size, 336);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("never subtracts swap fees twice; a one-wei gross gain stays quote-only positive", async () => {
  const result = await screen(mock({ quote: ({ amountIn, tokenIn }) =>
    tokenIn === WBNB ? amountIn : amountIn + 1n }));
  assert.equal(result.counts.quotePositive, 336);
  for (const row of result.rows) {
    assert.equal(row.grossDeltaRaw, "1");
    assert.equal(row.grossDeltaWbnb, "0.000000000000000001");
    assert.equal(row.classification, "QUOTE_POSITIVE_REQUIRES_FORK");
    assert.equal(row.routePositive, "unknown");
    assert.equal(row.executableNow, "unknown");
    assert.equal(row.conservativeNet, "unknown");
  }
  assert.equal(result.rows.find((row) => row.amountInWbnb === "0.01").grossBps, "0.000000000001");
  assert.equal(result.rows.find((row) => row.amountInWbnb === "10").grossBps, "0.000000000000001");
  assert.equal(result.routePositive, "unknown");
  assert.equal(result.executableNow, "unknown");
  assert.equal(result.conservativeNet, "unknown");
  assert.ok(result.limitations.some((text) => text.includes("full-input consumption")));
});

test("preserves negative and zero gross without claiming conservative net", async () => {
  for (const loss of [0n, 1n]) {
    const result = await screen(mock({ quote: ({ amountIn, tokenIn }) =>
      tokenIn === WBNB ? amountIn : amountIn - loss }));
    assert.equal(result.counts.quoteNonpositive, 336);
    assert.equal(result.counts.quotePositive, 0);
    for (const row of result.rows) {
      assert.equal(row.grossDeltaRaw, (-loss).toString());
      assert.equal(row.classification, "QUOTE_NONPOSITIVE");
      assert.equal(row.conservativeNet, "unknown");
    }
    assert.equal(result.rows[0].grossBps, loss === 0n ? "0.0" : "-0.000000000001");
  }
});

test("unavailable first or second quotes retain all affected routes as INCOMPLETE", async () => {
  for (const unavailableTokenIn of [WBNB, USDT]) {
    const fixture = mock({ quote: ({ to, tokenIn, amountIn }) =>
      to === UNI && tokenIn === unavailableTokenIn ? null : amountIn });
    const result = await screen(fixture);
    assert.equal(result.counts.routes, 336);
    assert.equal(result.counts.incomplete, unavailableTokenIn === WBNB ? 144 : 72);
    const missing = result.rows.filter((row) => row.classification === "INCOMPLETE");
    for (const row of missing) {
      assert.equal(row.grossDeltaRaw, null);
      assert.equal(row.grossBps, null);
      assert.equal(row.amountOutRaw, null);
      assert.equal(row.routePositive, "unknown");
      assert.match(row.reason, unavailableTokenIn === WBNB ? /^FIRST_QUOTE/ : /^SECOND_QUOTE/);
    }
    assert.ok(result.coverageGaps.some((gap) => gap.stage === "quote"));
  }
});

test("decimal mismatch or missing decimals fails closed without guessing", async () => {
  for (const decimals of [[6n], null]) {
    const fixture = mock({ override: ({ to, name }) => name === "decimals" && to === USDT
      ? decimals : undefined });
    const result = await screen(fixture);
    assert.equal(result.tokens.find((token) => token.symbol === "USDT").decimals, null);
    const rows = result.rows.filter((row) => row.pair === "WBNB/USDT");
    assert.equal(rows.length, 168);
    assert.ok(rows.every((row) => row.classification === "INCOMPLETE"));
    assert.equal(result.counts.quoteNonpositive, 168);
    assert.ok(result.coverageGaps.some((gap) => gap.stage === "decimals" && gap.token === "USDT"));
    for (const { name, args } of quoteRequests(fixture.history)) {
      const path = name === "getAmountsOut" ? [...args[1]] : [args[0].tokenIn, args[0].tokenOut];
      assert.ok(!path.map((token) => token.toLowerCase()).includes(USDT));
    }
  }
});

test("factory, pool lookup, token identity, pool factory and fee failures are coverage gaps", async () => {
  const cases = [
    ({ name, to }) => name === "factory" && FACTORIES.has(to) ? null : undefined,
    ({ name }) => name === "getPool" || name === "getPair" ? null : undefined,
    ({ name }) => name === "getPool" || name === "getPair" ? [addr(0)] : undefined,
    ({ name }) => name === "token0" ? [addr(999)] : undefined,
    ({ name }) => name === "token1" ? null : undefined,
    ({ name, to }) => name === "factory" && !FACTORIES.has(to) ? [addr(999)] : undefined,
    ({ name }) => name === "fee" ? [42n] : undefined,
  ];
  for (const override of cases) {
    const fixture = mock({ override });
    const result = await screen(fixture);
    assert.equal(result.counts.quotePositive, 0);
    assert.equal(result.counts.quoteNonpositive, 0);
    assert.equal(result.counts.incomplete, 336);
    assert.ok(result.coverageGaps.length > 0);
    // Only the two unaffected Sushi pools may be quoted in the V3-fee case.
    assert.ok(quoteRequests(fixture.history).every(({ to }) => to === SUSHI));
  }
});

test("deduplicates valid aliases and excludes the same physical pool across venues", async () => {
  const fixture = mock({ alias: true });
  const result = await screen(fixture);
  assert.equal(result.pools.filter((pool) => pool.status === "DUPLICATE").length, 4);
  assert.equal(result.counts.validDistinctPools, 10);
  assert.equal(result.counts.routes, 2 * 4 * 5 * 4);
  assert.equal(result.counts.quoteCalls, 2 * 4 * (5 + 5 * 4));
  for (const row of result.rows) {
    const first = result.pools.find((pool) => pool.id === row.firstPoolId);
    const second = result.pools.find((pool) => pool.id === row.secondPoolId);
    assert.notEqual(first.pool, second.pool);
  }
});

test("rejects a Sushi quote whose returned input differs from the supplied input", async () => {
  const fixture = mock({ override: ({ name, args }) => name === "getAmountsOut"
    ? [[args[0] + 1n, args[0] * 2n]] : undefined });
  const result = await screen(fixture);
  assert.equal(result.counts.incomplete, 96);
  assert.equal(result.counts.quotePositive, 0);
});

test("requires injection and propagates unexpected transport errors without recording them", async () => {
  await assert.rejects(screen({}), /injected call/);
  const failure = new Error("synthetic transport abort");
  await assert.rejects(screen({ call: async () => { throw failure; } }), (error) => error === failure);
});
