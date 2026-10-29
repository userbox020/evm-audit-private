"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { keccak256, Interface } = require("ethers");
const { inputFromDeployment, state, PROXY, IMPLEMENTATION, VERSION_KEY, COMPILER_VERSION, AAVE, I } = require("./run-base-paper-usdplus-cash-r12");
const { A: CORE } = require("./run-base-paper-usdplus-preflight-r10");
function fixture() {
  const content = "pragma solidity ^0.8.17; contract StrategyAave {}\n";
  const metadata = { compiler: { version: COMPILER_VERSION }, language: "Solidity", settings: { compilationTarget: { "contracts/StrategyAave.sol": "StrategyAave" }, optimizer: { enabled: true, runs: 100 }, metadata: { useLiteralContent: true } },
    sources: { "contracts/StrategyAave.sol": { content, keccak256: keccak256(Buffer.from(content)) } } };
  return { metadata, deployment: { address: PROXY, implementation: IMPLEMENTATION, abi: [], deployedBytecode: "0x6000" }, registry: { impls: { [VERSION_KEY]: { address: IMPLEMENTATION } } } };
}
test("binds exact official deployment and verifies literal source hashes", () => {
  const f = fixture(); f.deployment.metadata = JSON.stringify(f.metadata);
  const input = inputFromDeployment(f.deployment, f.registry);
  assert.equal(input.settings.optimizer.runs, 100);
  assert.equal(input.sources["contracts/StrategyAave.sol"].content, f.metadata.sources["contracts/StrategyAave.sol"].content);
  assert.equal(input.settings.compilationTarget, undefined);
});
for (const [name, change] of [
  ["wrong proxy", f => f.deployment.address = IMPLEMENTATION],
  ["wrong implementation", f => f.deployment.implementation = PROXY],
  ["registry mismatch", f => f.registry.impls[VERSION_KEY].address = PROXY],
  ["floating compiler", f => f.metadata.compiler.version = "latest"],
  ["wrong target", f => f.metadata.settings.compilationTarget = { "contracts/Other.sol": "Other" }],
  ["missing literal content", f => delete f.metadata.sources["contracts/StrategyAave.sol"].content],
  ["changed source", f => f.metadata.sources["contracts/StrategyAave.sol"].content += " "],
  ["source traversal", f => f.metadata.sources["../Other.sol"] = f.metadata.sources["contracts/StrategyAave.sol"]],
  ["empty runtime", f => f.deployment.deployedBytecode = "0x"],
]) test(`reject ${name}`, () => { const f = fixture(); change(f); f.deployment.metadata = JSON.stringify(f.metadata); assert.throws(() => inputFromDeployment(f.deployment, f.registry)); });

function stateFixture(change = () => {}) {
  const now = Date.parse("2026-09-05T22:00:00Z");
  const abi = [...["usdcToken", "aUsdcToken", "aaveProvider", "portfolioManager"].map(name => `function ${name}() view returns(address)`),
    ...["netAssetValue", "liquidationValue", "navSlippageBP"].map(name => `function ${name}() view returns(uint256)`), "function inLending() view returns(bool)"];
  const cash = new Interface(abi), runtime = "0x60006000";
  const compiled = { address: IMPLEMENTATION, runtime, runtimeKeccak256: keccak256(runtime), abi };
  const proxyCompiled = { address: PROXY, runtime, runtimeKeccak256: keccak256(runtime) };
  const candidates = [{ url: "https://one.invalid/secret", family: "one" }, { url: "https://two.invalid/secret", family: "two" }];
  const requests = [];
  const transport = async (url, body) => {
    requests.push(body); let result;
    if (body.method === "eth_chainId") result = "0x2105";
    else if (body.method === "eth_getBlockByNumber") result = { number: "0x100", timestamp: `0x${(BigInt(now / 1000) - 60n).toString(16)}`, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), stateRoot: "0x" + "ef".repeat(32) };
    else if (body.method === "eth_getCode") result = runtime;
    else if (body.method === "eth_getStorageAt") result = "0x" + IMPLEMENTATION.slice(2).padStart(64, "0");
    else if (body.method === "eth_call") {
      const { to, data } = body.params[0];
      const iface = to === PROXY ? cash : to === AAVE.provider ? I.provider : to === AAVE.pool ? I.pool : I.token.getFunction(data.slice(0, 10)) ? I.token : I.aToken;
      const fragment = iface.getFunction(data.slice(0, 10));
      assert.equal(fragment.stateMutability, "view");
      const values = { usdcToken: CORE.usdc, aUsdcToken: AAVE.aToken, aaveProvider: AAVE.provider, portfolioManager: CORE.manager,
        netAssetValue: 1000000n, liquidationValue: 1000000n, navSlippageBP: 20n, inLending: true, decimals: 6n,
        getPool: AAVE.pool, POOL: AAVE.pool, UNDERLYING_ASSET_ADDRESS: CORE.usdc, getConfiguration: 1n << 56n };
      if (fragment.name === "getUserAccountData") result = iface.encodeFunctionResult(fragment, [100000000n, 0n, 50000000n, 8000n, 7500n, 2n ** 256n - 1n]);
      else {
        let value = values[fragment.name];
        if (fragment.name === "balanceOf") {
          const owner = iface.decodeFunctionData(fragment, data)[0].toLowerCase();
          value = to === AAVE.aToken ? 1000000n : owner === PROXY ? 0n : 2000000n;
        }
        result = iface.encodeFunctionResult(fragment, [value]);
      }
    } else assert.fail("Unexpected RPC method");
    const response = { value: { jsonrpc: "2.0", id: body.id, result }, bytes: 100 };
    change(response, body, url, requests); return response;
  };
  return { transport, candidates, compiled, proxyCompiled, clock: () => now, requests, cash };
}
test("exact cash runtime and positive balance observations remain diagnostic only", async () => {
  const deps = stateFixture(), out = await state(deps);
  assert.equal(out.status, "CASH_RUNTIME_BOUND_LIQUIDITY_DIAGNOSTIC_ONLY");
  assert.equal(out.gates.cashSourceRuntimeBound, "true");
  assert.equal(out.observation.cash.inLending, true);
  assert.equal(out.observation.balances.aTokenRaw, "1000000");
  assert.equal(out.observation.lending.totalDebtBase, "0");
  assert.equal(out.observation.balancesAreWithdrawalProof, false);
  assert.equal(out.gates.withdrawalCapacity, "unknown"); assert.equal(out.gates.quoteEligible, false);
  assert.ok(!JSON.stringify(out).includes(".invalid")); assert.ok(out.requests < 140);
});
test("runtime mismatch cannot promote cash source", async () => {
  const deps = stateFixture((r, b) => { if (b.method === "eth_getCode") r.value.result = "0x6001"; });
  const out = await state(deps); assert.equal(out.code, "CASH_RUNTIME_MISMATCH"); assert.equal(out.observation, null);
});
test("pointer drift cannot inherit a recovered implementation", async () => {
  const deps = stateFixture((r, b) => { if (b.method === "eth_getStorageAt") r.value.result = "0x" + "00".repeat(32); });
  assert.equal((await state(deps)).code, "CASH_IMPLEMENTATION_CHANGED");
});
test("terminal pin change clears the observation", async () => {
  let historical = 0;
  const deps = stateFixture((r, b) => { if (b.method === "eth_getBlockByNumber" && b.params[0] === "0x100" && ++historical > 2) r.value.result.hash = "0x" + "12".repeat(32); });
  const out = await state(deps); assert.equal(out.code, "TERMINAL_PIN_CHANGED"); assert.equal(out.observation, null);
});
test("same-family probes cannot establish corroboration", async () => {
  const deps = stateFixture(); deps.candidates[1].family = "one";
  const out = await state(deps); assert.equal(out.qualification.qualified, 2); assert.equal(out.code, "TWO_STATE_CAPABLE_FAMILIES_UNAVAILABLE");
});
test("pause flags are observations and never enable a quote", async () => {
  const deps = stateFixture((r, b) => { if (b.method === "eth_call" && b.params[0].data.startsWith(I.pool.getFunction("getConfiguration").selector)) r.value.result = I.pool.encodeFunctionResult("getConfiguration", [(1n << 56n) | (1n << 60n)]); });
  const out = await state(deps); assert.equal(out.observation.lending.pausedBit60, true); assert.equal(out.gates.quoteEligible, false);
});
test("malformed ABI and raw transport failures remain non-observations", async () => {
  const deps = stateFixture((r, b) => { if (b.method === "eth_call") r.value.result += "00".repeat(32); });
  const out = await state(deps); assert.equal(out.qualification.failures.ABI_INVALID, 2); assert.equal(out.observation, null);
});
test("injection cannot invoke live transport", async () => {
  const out = await state({ candidates: [] }); assert.equal(out.code, "INJECTED_TRANSPORT_REQUIRED"); assert.equal(out.requests, 0);
});
