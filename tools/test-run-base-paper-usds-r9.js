"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const r9 = require("./run-base-paper-usds-r9");
const { A, I } = r9;
const NOW = Date.parse("2026-09-05T19:00:00Z"), SQRT = (1n << 96n) / 1000000n;
const POCKET = "0x" + "33".repeat(20);
const hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const candidates = [{ url: new URL("https://one.invalid"), family: "one" }, { url: new URL("https://two.invalid"), family: "two" }];
function fixture(options = {}) {
  const calls = []; let fixed = 0, time = NOW;
  const transport = async (url, body) => {
    calls.push(body);
    if (options.timeout) time += r9.CAP.wallMs;
    if (options.reflect) throw new Error("DO_NOT_PERSIST https://secret.invalid/token");
    const second = url.hostname === "two.invalid", { method, params } = body;
    let result;
    if (method === "eth_chainId") result = options.wrongChain ? "0x1" : "0x2105";
    else if (method === "eth_getBlockByNumber") {
      if (params[0] !== "finalized") fixed++;
      result = { number: options.regressed && fixed > 2 && params[0] === "finalized" ? "0x63" : "0x64",
        hash: hash(options.pinMismatch && second || options.terminalChange && fixed > 2 ? 2 : 1), parentHash: hash(0), stateRoot: hash(3),
        timestamp: "0x" + (BigInt(NOW / 1000) - (options.stale ? 7200n : 60n)).toString(16) };
    } else if (method === "eth_getCode") {
      assert.ok(Object.values(A).includes(params[0]));
      assert.deepEqual(params[1], { blockHash: hash(options.pinMismatch && second ? 2 : 1), requireCanonical: true });
      result = options.noCode ? "0x" : "0x60006000";
    } else if (method === "eth_call") {
      assert.deepEqual(params[1], { blockHash: hash(options.pinMismatch && second ? 2 : 1), requireCanonical: true });
      assert.deepEqual(Object.keys(params[0]).sort(), ["data", "gas", "to"]);
      assert.equal(params[0].gas, "0x1e8480");
      const { to, data } = params[0];
      const type = to === A.pool ? "pool" : to === A.factory ? "factory" : to === A.quoter ? "quoter" : to === A.psm ? "psm" : "token";
      const iface = I[type], parsed = iface.parseTransaction({ data }), name = parsed.name, args = parsed.args;
      let values;
      if (name === "quoteExactInputSingle") {
        assert.equal(to, A.quoter);
        assert.equal(args[0][0].toLowerCase(), A.usdc); assert.equal(args[0][1].toLowerCase(), A.usds);
        assert.ok(r9.SIZES.includes(args[0][2])); assert.equal(args[0][3], 100n); assert.equal(args[0][4], 0n);
        if (options.quoteError) return { bytes: 200, value: { jsonrpc: "2.0", id: body.id, error: { code: 3, message: "DO_NOT_PERSIST", data: "0x" + "ab".repeat(96) } } };
        values = [options.zeroQuote ? 0n : args[0][2] * 10n ** 12n * (options.positive ? 10010n : 9998n) / 10000n,
          options.atLimit ? r9.MAX_SQRT - 1n : options.wrongDirection ? SQRT - 1n : SQRT + args[0][2], 0n, 123000n];
      } else {
        assert.equal(parsed.fragment.stateMutability, "view");
        if (name === "factory") values = [options.badFactory ? POCKET : A.factory];
        else if (name === "deployer") values = [options.badDeployer ? POCKET : A.deployer];
        else if (name === "WETH9") values = [A.weth];
        else if (name === "token0") values = [options.badTokens ? A.usdc : A.usds];
        else if (name === "token1") values = [A.usdc];
        else if (["usdc", "usds"].includes(name)) values = [options.badPsm ? POCKET : A[name]];
        else if (name === "fee") values = [options.badFee ? 500n : 100n];
        else if (name === "tickSpacing") values = [1n];
        else if (name === "feeAmountTickSpacing") values = [options.badSpacing ? 10n : 1n];
        else if (name === "getPool") values = [options.badPool ? POCKET : A.pool];
        else if (name === "decimals") values = [options.badDecimals ? 8n : to === A.usdc ? 6n : 18n];
        else if (name === "slot0") values = [SQRT, -276325n, 0n, 1n, 1n, 209718400n, !options.locked];
        else if (name === "liquidity") values = [options.zeroLiquidity ? 0n : 10n ** 18n];
        else if (name === "pocket") values = [options.internalPocket ? A.psm : POCKET];
        else if (name === "allowance") {
          assert.equal(args[0].toLowerCase(), POCKET); assert.equal(args[1].toLowerCase(), A.psm);
          values = [options.lowAllowance ? 0n : 1000000n * 10n ** 6n];
        } else if (name === "balanceOf") {
          const pool = args[0].toLowerCase() === A.pool;
          values = [pool ? options.poolBalanceLow && to === A.usds ? 1n : 10000n * 10n ** (to === A.usds ? 18n : 6n)
            : options.lowBalance ? 0n : 1000000n * 10n ** 6n + (options.disagreement && second ? 1n : 0n)];
        } else if (name === "previewSwapExactIn") {
          assert.equal(args[0].toLowerCase(), A.usds); assert.equal(args[1].toLowerCase(), A.usdc);
          values = [args[2] / 10n ** 12n + (options.badPreview ? 1n : 0n)];
        }
      }
      assert.ok(values, `Unexpected fixture call: ${type}.${name}`);
      result = iface.encodeFunctionResult(name, values);
      if (options.extraWord) result += hash(0).slice(2);
    } else assert.fail(`Forbidden method ${method}`);
    return { bytes: options.oversize ? r9.CAP.responseBytes + 1 : options.largeResponses ? r9.CAP.responseBytes : 200,
      value: { jsonrpc: "2.0", id: options.wrongId ? body.id + 1 : body.id, result } };
  };
  return { candidates, transport, clock: () => time, sourceCheck: () => !options.sourceMismatch, calls };
}

test("official deployer/init hash derives exactly the selected pool", () => assert.equal(r9.computedPool(), A.pool));

test("six direct quotes include the fee once and keep all net and execution gates unknown", async () => {
  const output = await r9.run(fixture());
  assert.equal(output.status, "OBSERVED_UNPROMOTED", output.code);
  assert.equal(output.observation.rows.length, 6);
  assert.equal(output.observation.rows[0].quotedSurplusUsdcRaw, "-200");
  assert.equal(output.observation.rows[0].outputUsdcRaw, "999800");
  assert.equal(output.observation.rows[0].quoterGasIsCycleGas, false);
  assert.equal(output.gates.rateOracleDependency, "n/a");
  assert.equal(output.gates.profitabilityClaim, false);
  assert.equal(output.economics.conservativeNetUsdc, null);
  assert.equal(output.source.sourceRuntimeBound, "unknown");
  assert.equal(output.safety.transactions, 0);
});

test("positive quote is not promoted without runtime, full-cycle costs and transfer evidence", async () => {
  const output = await r9.run(fixture({ positive: true }));
  assert.equal(output.code, "QUOTED_SURPLUS_REQUIRES_VALIDATION");
  assert.equal(output.observation.rows[0].quotedSurplusUsdcRaw, "1000");
  assert.equal(output.gates.profitabilityClaim, false);
  assert.equal(output.economics.conservativeNetUsd, null);
});

for (const option of ["lowBalance", "lowAllowance"]) test(`${option} blocks capacity-backed quote classification`, async () => {
  const output = await r9.run(fixture({ positive: true, [option]: true }));
  assert.equal(output.status, "OBSERVED_UNPROMOTED", output.code);
  assert.equal(output.code, "NO_CAPACITY_BACKED_POSITIVE_QUOTE_AT_TESTED_SIZES");
});
test("internal pocket requires no allowance to itself", async () => {
  const input = fixture({ internalPocket: true, lowAllowance: true, positive: true });
  const output = await r9.run(input);
  assert.equal(output.code, "QUOTED_SURPLUS_REQUIRES_VALIDATION");
  assert.equal(output.observation.psm.usdcAllowanceRaw, null);
  assert.ok(!input.calls.some(call => call.method === "eth_call" && call.params[0].data.startsWith(I.token.getFunction("allowance").selector)));
});
test("zero current in-range liquidity alone is not an all-tick liquidity disproof", async () => {
  const output = await r9.run(fixture({ zeroLiquidity: true }));
  assert.equal(output.status, "OBSERVED_UNPROMOTED", output.code);
  assert.equal(output.observation.liquidityRaw, "0");
  assert.equal(output.economics.allSizesDisproved, false);
});

for (const [option, code] of Object.entries({ sourceMismatch: "PRIMARY_SOURCE_MISMATCH", pinMismatch: "PIN_DISAGREEMENT", terminalChange: "TERMINAL_PIN_CHANGED",
  regressed: "FINALITY_REGRESSED", locked: "POOL_STATE_INVALID", poolBalanceLow: "QUOTE_EXCEEDS_TOKEN_BALANCE", badPreview: "PSM_PREVIEW_MODEL_MISMATCH",
  wrongDirection: "QUOTE_PRICE_DIRECTION_MISMATCH", disagreement: "OBSERVATION_DISAGREEMENT", timeout: "REQUEST_OR_TIME_CAP", largeResponses: "TOTAL_BYTE_CAP" })) {
  test(`${option} never publishes a partial observation`, async () => {
    const output = await r9.run(fixture({ [option]: true }));
    assert.equal(output.status, "INCOMPLETE"); assert.equal(output.code, code);
    assert.equal(output.observation, null); assert.equal(output.gates.profitabilityClaim, false);
  });
}
for (const option of ["wrongChain", "stale", "noCode", "badFactory", "badDeployer", "badTokens", "badPsm", "badFee", "badSpacing", "badPool",
  "badDecimals", "zeroQuote", "atLimit", "quoteError", "extraWord", "reflect", "wrongId", "oversize"]) {
  test(`${option} cannot qualify a quote-capable provider`, async () => {
    const output = await r9.run(fixture({ [option]: true }));
    assert.equal(output.code, "TWO_QUOTE_CAPABLE_FAMILIES_UNAVAILABLE");
    assert.equal(output.observation, null);
    assert.doesNotMatch(JSON.stringify(output), /DO_NOT_PERSIST|secret\.invalid|https?:\/\//);
  });
}
test("quote qualification covers the entire candidate pool before selecting families", async () => {
  const input = fixture();
  input.candidates = Array.from({ length: r9.CAP.candidates }, (_, i) => ({ url: new URL(`https://family-${i}.invalid`), family: `family-${i}` }));
  const output = await r9.run(input);
  assert.equal(output.status, "OBSERVED_UNPROMOTED", output.code);
  assert.equal(output.qualification.qualified, 8);
  assert.ok(output.requests < r9.CAP.requests);
});
test("same-family aliases do not corroborate", async () => {
  const input = fixture(); input.candidates = candidates.map(c => ({ ...c, family: "same" }));
  assert.equal((await r9.run(input)).code, "TWO_QUOTE_CAPABLE_FAMILIES_UNAVAILABLE");
});
test("candidate injection cannot call the real transport", async () => {
  const output = await r9.run({ candidates });
  assert.equal(output.code, "INJECTED_TRANSPORT_REQUIRED"); assert.equal(output.requests, 0);
});
test("candidate overflow stops before network access", async () => {
  const input = fixture(); input.candidates = Array(r9.CAP.candidates + 1).fill(candidates[0]);
  const output = await r9.run(input);
  assert.equal(output.code, "CANDIDATE_CAP"); assert.equal(output.requests, 0);
});
