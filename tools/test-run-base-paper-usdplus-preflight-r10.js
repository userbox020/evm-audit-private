"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { run, A, I, CAP } = require("./run-base-paper-usdplus-preflight-r10");
const NOW = Date.parse("2026-09-05T20:00:00Z");
const candidates = [{ url: "https://one.invalid/private", family: "one" }, { url: "https://two.invalid/private", family: "two" }];
function fixture(change = () => {}) {
  const requests = [];
  const transport = async (url, body) => {
    requests.push(body);
    const { method, params, id } = body;
    let result;
    if (method === "eth_chainId") result = "0x2105";
    else if (method === "eth_getBlockByNumber") result = { number: "0x100", timestamp: `0x${(BigInt(NOW / 1000) - 100n).toString(16)}`, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), stateRoot: "0x" + "ef".repeat(32) };
    else if (method === "eth_getStorageAt") result = "0x" + A.implementation.slice(2).padStart(64, "0");
    else if (method === "eth_getCode") result = "0x60006000";
    else if (method === "eth_call") {
      const to = params[0].to, iface = to === A.exchange ? I.exchange : to === A.manager ? I.manager : to === A.m2m ? I.m2m : I.token;
      const fragment = iface.getFunction(params[0].data.slice(0, 10));
      assert.equal(fragment.stateMutability, "view");
      const values = { usdPlus: A.usdPlus, usdc: A.usdc, portfolioManager: A.manager, mark2market: A.m2m, redeemFee: 40n, redeemFeeDenominator: 100000n,
        paused: false, cashStrategy: A.manager, exchanger: A.exchange, decimals: 6n, balanceOf: 1000000n, totalNetAssets: 5000000n, totalLiquidationAssets: 4000000n };
      result = iface.encodeFunctionResult(fragment, [values[fragment.name]]);
    } else assert.fail("Unexpected RPC method");
    const response = { value: { jsonrpc: "2.0", id, result }, bytes: 100 };
    change(response, body, url, requests);
    return response;
  };
  return { transport, requests, candidates, clock: () => NOW };
}
test("complete view observations do not claim source binding, capacity, quotes or profit", async () => {
  const deps = fixture(), out = await run(deps);
  assert.equal(out.status, "OBSERVED_UNPROMOTED");
  assert.equal(out.code, "SOURCE_RUNTIME_AND_PAYOUT_CAPACITY_UNPROVEN");
  assert.equal(out.qualification.selectedFamilyCount, 2);
  assert.equal(out.observation.exchange.usdc, A.usdc);
  assert.equal(out.observation.balancesAreTransferProof, false);
  assert.equal(out.gates.quoteEligible, false);
  assert.equal(out.source.sourceRuntimeBound, "unknown");
  assert.equal(out.economics.conservativeNetUsdc, null);
  assert.equal(out.safety.inventoryRead, false);
  assert.ok(out.requests < CAP.requests);
  assert.ok(!JSON.stringify(out).includes(".invalid"));
  for (const req of deps.requests.filter(r => ["eth_call", "eth_getStorageAt", "eth_getCode"].includes(r.method)))
    assert.equal(req.params.at(-1).requireCanonical, true);
});
for (const [name, getter, value, expected] of [
  ["paused", "paused", true, "EXCHANGE_PAUSED_OBSERVED"],
  ["bridged asset", "usdc", A.usdbc, "UNDERLYING_NOT_NATIVE_USDC"],
  ["invalid fee", "redeemFeeDenominator", 0n, "FEE_INVALID"]
]) test(name, async () => {
  const deps = fixture((r, b) => { if (b.method === "eth_call" && b.params[0].to === A.exchange && b.params[0].data === I.exchange.encodeFunctionData(getter)) r.value.result = I.exchange.encodeFunctionResult(getter, [value]); });
  assert.equal((await run(deps)).code, expected);
});
test("unlisted manager is retained without being followed", async () => {
  const deps = fixture((r, b) => { if (b.method === "eth_call" && b.params[0].data === I.exchange.encodeFunctionData("portfolioManager")) r.value.result = I.exchange.encodeFunctionResult("portfolioManager", [A.usdPlus]); });
  const out = await run(deps);
  assert.equal(out.observation.manager, null);
  assert.equal(out.gates.quoteEligible, false);
});
test("qualification completes before distinct family selection", async () => {
  const deps = fixture(); deps.candidates = [candidates[0], { ...candidates[1], family: "one" }];
  const out = await run(deps);
  assert.equal(out.qualification.qualified, 2);
  assert.equal(out.code, "TWO_STATE_CAPABLE_FAMILIES_UNAVAILABLE");
  assert.equal(out.observation, null);
});
test("provider disagreement leaves no observation", async () => {
  const deps = fixture((r, b, url) => { if (url === candidates[1].url && b.method === "eth_call" && b.params[0].data === I.exchange.encodeFunctionData("redeemFee")) r.value.result = I.exchange.encodeFunctionResult("redeemFee", [41n]); });
  const out = await run(deps); assert.equal(out.code, "OBSERVATION_DISAGREEMENT"); assert.equal(out.observation, null);
});
test("terminal pin change invalidates observations", async () => {
  let historical = 0;
  const deps = fixture((r, b) => { if (b.method === "eth_getBlockByNumber" && b.params[0] === "0x100" && ++historical > 2) r.value.result.hash = "0x" + "01".repeat(32); });
  const out = await run(deps); assert.equal(out.code, "TERMINAL_PIN_CHANGED"); assert.equal(out.observation, null);
});
test("raw errors stay process-only and no retry occurs", async () => {
  const deps = fixture(); let calls = 0;
  deps.transport = async () => { calls++; throw new Error("https://secret.invalid/private"); };
  const out = await run(deps);
  assert.equal(calls, 2); assert.equal(out.safety.retries, 0); assert.ok(!JSON.stringify(out).includes("secret"));
});
test("noncanonical ABI is rejected", async () => {
  const deps = fixture((r, b) => { if (b.method === "eth_call") r.value.result += "00".repeat(32); });
  const out = await run(deps); assert.equal(out.qualification.failures.ABI_INVALID, 2); assert.equal(out.observation, null);
});
test("stale finality blocks qualification", async () => {
  const deps = fixture((r, b) => { if (b.method === "eth_getBlockByNumber") r.value.result.timestamp = "0x1"; });
  assert.equal((await run(deps)).qualification.failures.FINALITY_STALE, 2);
});
test("injected candidates cannot use live transport", async () => {
  const out = await run({ candidates }); assert.equal(out.code, "INJECTED_TRANSPORT_REQUIRED"); assert.equal(out.requests, 0);
});
