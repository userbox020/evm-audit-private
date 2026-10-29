"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const diagnostic = require("./run-base-redemption-paper-diagnostic-r3");
const base = require("./run-base-redemption-paper-state-r1");
const previous = require("./run-base-redemption-paper-quote-r2");
const NOW = Date.parse("2026-09-05T08:00:00Z");
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const wrapped = (data) => "0x6190b2b0" + word(32) + word((data.length - 2) / 2) + data.slice(2).padEnd(Math.ceil((data.length - 2) / 64) * 64, "0");
const insufficient = wrapped(`0x7a5ed734${previous.POOL.slice(2)}`);
const candidates = [{ url: new URL("https://alpha.invalid"), family: "a" }, { url: new URL("https://beta.invalid"), family: "b" }];

function fixture(options = {}) {
  const calls = [];
  let fixedBlocks = 0;
  const transport = async (url, body) => {
    calls.push(body);
    const second = url.hostname === "beta.invalid";
    const { method, params } = body;
    let result;
    const error = (data) => ({ bytes: 200, value: { jsonrpc: "2.0", id: body.id, error: data } });
    if (options.reflect) throw new Error("DO_NOT_PERSIST https://private.invalid/secret");
    if (method === "eth_chainId") result = options.wrongChain ? "0x1" : "0x2105";
    else if (method === "eth_getBlockByNumber") {
      if (params[0] !== "finalized") fixedBlocks++;
      const changed = options.terminalChange && fixedBlocks > 2;
      result = { number: "0x64", hash: "0x" + word(changed || options.pinMismatch && second ? 2 : 1), parentHash: "0x" + word(0), stateRoot: "0x" + word(3), timestamp: `0x${(BigInt(NOW / 1000) - (options.stale ? 7200n : 60n)).toString(16)}` };
    } else if (method === "eth_getCode") {
      assert.equal(params[1].requireCanonical, true);
      assert.ok([base.VAULT, previous.QUOTER, diagnostic.STATE_VIEW].includes(params[0]));
      result = options.noCode ? "0x" : "0x60006000";
    } else if (method === "eth_call") {
      assert.equal(params[1].requireCanonical, true);
      assert.equal(params[0].gas, "0x1e8480");
      const { to, data } = params[0];
      if (data === "0xdc4c90d3") result = "0x" + word(options.managerMismatch ? 1 : diagnostic.MANAGER);
      else if (data.startsWith("0xc815641c")) {
        assert.equal(to, diagnostic.STATE_VIEW);
        assert.equal(data.slice(10), previous.POOL.slice(2));
        result = "0x" + word((1n << 96n) * 1000000n) + word(276324) + word(0) + word(options.feeMismatch ? 500 : 899000);
      } else if (data.startsWith("0xfa6793d5")) result = "0x" + word(options.zeroLiquidity ? 0 : options.disagree && second ? 100 : 200);
      else if (data === base.SELECTORS.asset) result = "0x" + word(options.wrongAsset ? 1 : base.ASSET);
      else if (data === base.SELECTORS.decimals) result = "0x" + word(options.badDecimals ? 7 : to === base.ASSET ? 6 : 18);
      else if (data.startsWith("0xaa9d21cb")) {
        assert.equal(to, previous.QUOTER);
        const amount = BigInt("0x" + data.slice(458, 522));
        assert.ok(amount === 100000000n || amount === 1000000n);
        assert.equal(data.slice(0, 458), previous.QUOTE_DATA.slice(0, 458));
        assert.equal(data.slice(522), previous.QUOTE_DATA.slice(522));
        if (options.invalidParams) return error({ code: -32602, message: "cannot unmarshal object DO_NOT_PERSIST" });
        if (!options.success && amount === 100000000n) return error({ code: 3, message: "execution reverted DO_NOT_PERSIST", data: insufficient });
        result = "0x" + word(10n ** 18n) + word(60000);
      } else if (data.startsWith(base.SELECTORS.previewRedeem)) result = "0x" + word(options.promising ? 11000000 : 1000000);
      else {
        assert.equal(to, base.VAULT);
        assert.ok(["receiveSharesGate", "sendSharesGate", "receiveAssetsGate", "liquidityAdapter"].some((key) => data === base.SELECTORS[key]));
        if (options.controlsUnavailable) return error({ code: 3, data: "0x", message: "execution reverted" });
        result = "0x" + word(0);
      }
    } else assert.fail(`Unexpected method ${method}`);
    return { bytes: options.oversize ? 2 * 1024 * 1024 : 200, value: { jsonrpc: "2.0", id: options.wrongId ? body.id + 1 : body.id, result } };
  };
  return { candidates, transport, clock: () => NOW, calls };
}

test("decodes source-defined nested liquidity error for only the selected pool", () => {
  assert.equal(diagnostic.classifyError({ code: 3, data: insufficient }).revert, "NOT_ENOUGH_LIQUIDITY_FOR_POOL");
  assert.equal(diagnostic.classifyError({ data: { data: wrapped(insufficient) } }).revert, "NOT_ENOUGH_LIQUIDITY_FOR_POOL");
  assert.equal(diagnostic.classifyError({ data: wrapped("0x486aa307") }).revert, "POOL_NOT_INITIALIZED");
  assert.equal(diagnostic.classifyError({ data: wrapped("0x7a5ed734" + word(7)) }).revert, "UNKNOWN_OR_MISSING");
  assert.equal(diagnostic.classifyError({ data: insufficient.slice(0, -1) + "1" }).revert, "UNKNOWN_OR_MISSING");
});

test("untrusted error data and messages never become artifact text or dynamic enums", () => {
  for (const code of ["__proto__", "constructor", "DO_NOT_PERSIST", null, -32602]) {
    const result = diagnostic.classifyError({ code, message: "DO_NOT_PERSIST https://private.invalid/secret", data: "DO_NOT_PERSIST" });
    assert.equal(typeof result.rpcCategory, "string");
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_PERSIST|private|constructor|__proto__/);
  }
  assert.equal(diagnostic.classifyError({ code: -32602 }).rpcCategory, "INVALID_PARAMS");
  assert.equal(diagnostic.classifyError({ message: "out of gas" }).hint, "GAS_LIMIT_REPORTED");
  assert.equal(diagnostic.classifyError({ message: "insufficient funds for gas" }).hint, "CALLER_BALANCE_CHECK_REPORTED");
});

test("validates ABI widths and signed ticks; computes unit-correct fee screen", () => {
  const data = "0x" + word((1n << 96n) * 1000000n) + word(-1) + word(0) + word(899000);
  const slot = diagnostic.decodeSlot0(data);
  assert.equal(slot.tick, "-1");
  const screen = diagnostic.priceScreen(slot, "1000000");
  assert.equal(BigInt(screen.spot.numerator) / BigInt(screen.spot.denominator), 1000000n);
  assert.equal(BigInt(screen.lpFeeOnlyCost.numerator) / BigInt(screen.lpFeeOnlyCost.denominator), 9900990n);
  assert.equal(screen.previewBelowLpFeeOnlyCost, true);
  assert.equal(screen.allSizesDisproved, false);
  assert.throws(() => diagnostic.decodeSlot0("0x"));
  assert.throws(() => diagnostic.decodeSlot0("0x" + word(1n << 160n) + word(0) + word(0) + word(899000)));
  assert.equal(diagnostic.priceScreen({ sqrtPriceX96: "0", lpFee: "0" }, "0"), null);
});

test("corroborated full-input error remains diagnostic, not an all-size rejection", async () => {
  const input = fixture({ zeroLiquidity: true });
  const result = await diagnostic.run(input);
  assert.equal(result.status, "DIAGNOSTIC_CAPTURE_COMPLETE");
  assert.equal(result.observation.quote100.revert, "NOT_ENOUGH_LIQUIDITY_FOR_POOL");
  assert.equal(result.observation.activeLiquidity, "0");
  assert.equal(result.observation.priceScreen.allSizesDisproved, false);
  assert.equal(result.observation.quote1, null);
  assert.equal(result.conservativeNetUsd, null);
  assert.equal(result.profitabilityClaim, false);
  assert.equal(result.sourceRuntimeBound, false);
  assert.equal(result.redeemCapacityVerified, false);
  assert.ok(result.requests <= diagnostic.CAP.requests);
  assert.doesNotMatch(JSON.stringify(result), /https?:|alpha|beta|DO_NOT_PERSIST/);
});

test("RPC parameter rejection is not classified as a liquidity failure", async () => {
  const result = await diagnostic.run(fixture({ invalidParams: true }));
  assert.equal(result.observation.quote100.rpcCategory, "INVALID_PARAMS");
  assert.equal(result.observation.quote100.revert, "UNKNOWN_OR_MISSING");
  assert.equal(result.observation.quote1, null);
});

test("one smaller diagnostic is conditional and cannot promote profit", async () => {
  const result = await diagnostic.run(fixture({ promising: true }));
  assert.equal(result.observation.quote1.inputRaw, "1000000");
  assert.equal(result.observation.quote1.kind, "OK");
  assert.equal(result.profitabilityClaim, false);
  assert.equal(result.conservativeNetUsd, null);
});

test("successful quote and missing optional controls are represented separately", async () => {
  const result = await diagnostic.run(fixture({ success: true, controlsUnavailable: true }));
  assert.equal(result.observation.quote100.kind, "OK");
  assert.equal(result.observation.quote100.redemptionPreview.assetsRaw, "1000000");
  assert.equal(result.observation.controls.sendSharesGate.kind, "RPC_ERROR");
  assert.equal(result.redeemCapacityVerified, false);
});

for (const flag of ["wrongChain", "stale", "pinMismatch", "terminalChange", "managerMismatch", "feeMismatch", "disagree", "wrongAsset", "badDecimals", "noCode", "reflect", "oversize", "wrongId"]) {
  test(`${flag} does not publish an agreed observation`, async () => {
    const result = await diagnostic.run(fixture({ [flag]: true }));
    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.observation, null);
    assert.equal(result.safety.transactions, 0);
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_PERSIST|private\.invalid/);
  });
}

test("same-family aliases cannot corroborate", async () => {
  const input = fixture();
  input.candidates = candidates.map((row) => ({ ...row, family: "same" }));
  assert.equal((await diagnostic.run(input)).code, "TWO_STATE_CAPABLE_GROUPS_UNAVAILABLE");
});

test("candidate injection cannot call production transport; wall clock stops requests", async () => {
  assert.equal((await diagnostic.run({ candidates })).code, "INJECTED_TRANSPORT_REQUIRED");
  const input = fixture();
  let n = 0;
  input.clock = () => n++ === 0 ? NOW : NOW + diagnostic.CAP.wallMs + 1;
  assert.equal((await diagnostic.run(input)).code, "REQUEST_OR_TIME_CAP");
  assert.equal(input.calls.length, 0);
});
