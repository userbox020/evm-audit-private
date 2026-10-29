"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const quote = require("./run-base-redemption-paper-quote-r2");
const base = require("./run-base-redemption-paper-state-r1");
const NOW = Date.parse("2026-09-05T07:00:00Z");
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const candidates = [
  { url: new URL("https://alpha.invalid/"), family: "alpha" },
  { url: new URL("https://beta.invalid/"), family: "beta" },
];
function fixture(options = {}) {
  const calls = [];
  const transport = async (url, body) => {
    calls.push(body);
    if (options.reflect) throw new Error("NEVER_PRINT https://private.invalid/key");
    let result;
    const second = url.hostname === "beta.invalid";
    const { method, params } = body;
    if (method === "eth_chainId") result = options.wrongChain ? "0x1" : "0x2105";
    else if (method === "eth_getBlockByNumber") {
      result = { number: "0x64", hash: "0x" + word(options.pinMismatch && second ? 2 : 1), parentHash: "0x" + word(0), stateRoot: "0x" + word(3), timestamp: `0x${(BigInt(NOW / 1000) - (options.stale ? 7200n : 60n)).toString(16)}` };
      if (options.terminalChange && calls.filter((c) => c.method === method && c.params[0] === "0x64").length > 2) result.hash = "0x" + word(5);
    } else if (method === "eth_getCode") {
      assert.ok([base.VAULT, quote.QUOTER].includes(params[0]));
      assert.equal(params[1].requireCanonical, true);
      result = "0x60006000";
    } else if (method === "eth_call") {
      assert.equal(params[1].requireCanonical, true);
      const { to, data, gas } = params[0];
      assert.equal(gas, "0x1e8480");
      if (to === quote.QUOTER) {
        assert.equal(data, quote.QUOTE_DATA);
        if (options.quoteError) return { bytes: 100, value: { jsonrpc: "2.0", id: body.id, error: { code: -32000 } } };
        result = "0x" + word(options.zero ? 0 : options.disagree && second ? 9n * 10n ** 18n : 10n * 10n ** 18n) + word(60000);
      } else if (data === base.SELECTORS.asset) result = "0x" + word(options.wrongAsset ? 1 : base.ASSET);
      else if (data === base.SELECTORS.decimals) result = "0x" + word(to === base.ASSET ? 6 : 18);
      else {
        assert.equal(to, base.VAULT);
        assert.equal(data.slice(0, 10), base.SELECTORS.previewRedeem);
        result = "0x" + word(options.positive ? 120000000 : 20000000);
      }
    } else assert.fail(`Unexpected method ${method}`);
    return { bytes: 200, value: { jsonrpc: "2.0", id: body.id, result } };
  };
  return { candidates, transport, clock: () => NOW, calls };
}

test("fixed quote calldata equals the independently cast-encoded 100 USDC fixture", () => {
  const expected = "0xaa9d21cb0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000beef0e0834849acc03f0089f01f4f1eeb06873c900000000000000000000000000000000000000000000000000000000000db7b8000000000000000000000000000000000000000000000000000000000000463c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000005f5e10000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000";
  assert.equal(quote.QUOTE_DATA, expected);
  assert.throws(() => quote.decodeQuote("0x" + word(1)));
});

test("negative agreed quote/preview is a scoped screen, not exact net or executable redemption", async () => {
  const result = await quote.run(fixture());
  assert.equal(result.status, "NONPOSITIVE_QUOTE_PREVIEW_SCREEN");
  assert.equal(result.economics.grossPreviewDeltaRaw, "-80000000");
  assert.equal(result.economics.conservativeNetUsd, null);
  assert.equal(result.economics.complete, false);
  assert.equal(result.observation.executableRedemption, false);
  assert.equal(result.profitabilityClaim, false);
  assert.equal(result.sourceRuntimeBound, false);
  assert.equal(result.safety.inventoryRead, false);
  assert.ok(result.requests <= quote.CAP.requests);
  assert.doesNotMatch(JSON.stringify(result), /https?:|alpha|beta|NEVER_PRINT/);
});

test("positive preview never promotes without redemption capacity and all costs", async () => {
  const result = await quote.run(fixture({ positive: true }));
  assert.equal(result.status, "POSITIVE_PREVIEW_REQUIRES_CAPACITY_AND_COSTS");
  assert.equal(result.economics.grossPreviewDeltaRaw, "20000000");
  assert.equal(result.paperEligible, false);
  assert.equal(result.profitabilityClaim, false);
});

for (const [flag, expected] of [
  ["wrongChain", "TWO_QUOTE_CAPABLE_GROUPS_UNAVAILABLE"],
  ["wrongAsset", "TWO_QUOTE_CAPABLE_GROUPS_UNAVAILABLE"],
  ["stale", "TWO_QUOTE_CAPABLE_GROUPS_UNAVAILABLE"],
  ["quoteError", "TWO_QUOTE_CAPABLE_GROUPS_UNAVAILABLE"],
  ["zero", "TWO_QUOTE_CAPABLE_GROUPS_UNAVAILABLE"],
  ["disagree", "QUOTE_OR_PREVIEW_DISAGREEMENT"],
  ["pinMismatch", "PIN_DISAGREEMENT"],
  ["terminalChange", "TERMINAL_PIN_CHANGED"],
  ["reflect", "UNEXPECTED_FAILURE"],
]) test(`${flag} remains incomplete with null observation and economics`, async () => {
  const result = await quote.run(fixture({ [flag]: true }));
  assert.equal(result.code, expected);
  assert.equal(result.observation, null);
  assert.equal(result.economics.grossPreviewDeltaRaw, null);
  assert.equal(result.safety.transactions, 0);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_PRINT|private\.invalid/);
});

test("same-family aliases cannot corroborate", async () => {
  const input = fixture();
  input.candidates = candidates.map((c) => ({ ...c, family: "same" }));
  assert.equal((await quote.run(input)).code, "TWO_QUOTE_CAPABLE_GROUPS_UNAVAILABLE");
});

test("injected candidates cannot invoke production transport", async () => {
  const result = await quote.run({ candidates });
  assert.equal(result.code, "INJECTED_TRANSPORT_REQUIRED");
  assert.equal(result.requests, 0);
});

test("wall-clock budget stops before transport", async () => {
  const input = fixture();
  let index = 0;
  input.clock = () => index++ === 0 ? NOW : NOW + quote.CAP.wallMs + 1;
  const result = await quote.run(input);
  assert.equal(result.code, "REQUEST_OR_TIME_CAP");
  assert.equal(input.calls.length, 0);
});
