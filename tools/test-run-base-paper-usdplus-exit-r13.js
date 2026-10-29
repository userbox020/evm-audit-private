"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { keccak256, Interface } = require("ethers");
const { normalize, coreState, guardDisposition, CONTRACTS, ZERO, ACTIVE_TOKEN } = require("./run-base-paper-usdplus-exit-r13");
const { A: CORE } = require("./run-base-paper-usdplus-preflight-r10");
const { PROXY: CASH, IMPLEMENTATION: CASH_IMPLEMENTATION } = require("./run-base-paper-usdplus-cash-r12");
function fixture(label = "token") {
  const expected = CONTRACTS[label], file = `contracts/${expected.name}.sol`, content = `pragma solidity ^0.8.17; contract ${expected.name} {}\n`;
  const metadata = { language: "Solidity", compiler: { version: "0.8.17+commit.8df45f5f" }, settings: { compilationTarget: { [file]: expected.name }, optimizer: { enabled: true, runs: 100 } },
    sources: { [file]: { content, keccak256: keccak256(Buffer.from(content)) } } };
  return { expected, metadata, deployment: { address: expected.proxy, implementation: expected.implementation, abi: [], deployedBytecode: "0x6000", metadata: JSON.stringify(metadata) } };
}
for (const label of ["token", "role"]) test(`exact ${label} metadata creates bounded compile input`, () => {
  const f = fixture(label), input = normalize(f.deployment, f.expected);
  assert.equal(input.settings.optimizer.runs, 100); assert.equal(Object.keys(input.sources).length, 1);
});
for (const [name, change] of [
  ["wrong implementation", f => f.deployment.implementation = f.expected.proxy],
  ["wrong proxy", f => f.deployment.address = f.expected.implementation],
  ["changed source", f => f.metadata.sources["contracts/UsdPlusToken.sol"].content += " "],
  ["path traversal", f => f.metadata.sources["../Other.sol"] = f.metadata.sources["contracts/UsdPlusToken.sol"]],
  ["compiler mismatch", f => f.metadata.compiler.version = "latest"],
  ["missing primary", f => f.metadata.sources = {}],
]) test(`reject ${name}`, () => { const f = fixture(); change(f); f.deployment.metadata = JSON.stringify(f.metadata); assert.throws(() => normalize(f.deployment, f.expected)); });

function coreFixture(change = () => {}, activeToken = false) {
  const now = Date.parse("2026-09-05T23:00:00Z"), runtime = "0x60006000";
  const addresses = { exchangeProxy: CORE.exchange, exchange: CORE.implementation, managerProxy: CORE.manager, manager: "0xb008d09d25f06799e4081877a6bb185d89d893d3", cashProxy: CASH, cash: CASH_IMPLEMENTATION,
    tokenProxy: CONTRACTS.token.proxy, token: activeToken ? ACTIVE_TOKEN : CONTRACTS.token.implementation, roleProxy: CONTRACTS.role.proxy, role: CONTRACTS.role.implementation };
  const abi = [
    ...["exchange", "exchanger", "roleManager", "usdPlus", "usdc", "portfolioManager", "blockGetter", "cashStrategy"].map(name => `function ${name}() view returns(address)`),
    ...["redeemFee", "redeemFeeDenominator", "liquidationValue"].map(name => `function ${name}() view returns(uint256)`),
    "function decimals() view returns(uint8)", "function isPaused() view returns(bool)", "function paused() view returns(bool)", "function inLending() view returns(bool)",
    "function lockOptionsPerAddress(address) view returns(bool,bool)", "function hasRole(bytes32,address) view returns(bool)"
  ];
  const iface = new Interface(abi), compiled = Object.fromEntries(Object.entries(addresses).map(([key, address]) => [key, { address, runtime, runtimeKeccak256: keccak256(runtime), abi }]));
  const requests = [], candidates = [{ url: "https://one.invalid/secret", family: "one" }, { url: "https://two.invalid/secret", family: "two" }];
  const transport = async (url, body) => {
    requests.push(body); let result;
    if (body.method === "eth_chainId") result = "0x2105";
    else if (body.method === "eth_getBlockByNumber") result = { number: "0x100", timestamp: `0x${(BigInt(now / 1000) - 60n).toString(16)}`, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), stateRoot: "0x" + "ef".repeat(32) };
    else if (body.method === "eth_getCode") result = runtime;
    else if (body.method === "eth_getStorageAt") {
      const key = Object.keys(addresses).find(key => key.endsWith("Proxy") && addresses[key] === body.params[0]);
      result = "0x" + addresses[key.replace("Proxy", "")].slice(2).padStart(64, "0");
    } else if (body.method === "eth_call") {
      const fragment = iface.getFunction(body.params[0].data.slice(0, 10));
      assert.equal(fragment.stateMutability, "view");
      const values = { exchange: CORE.exchange, exchanger: CORE.exchange, roleManager: CONTRACTS.role.proxy, usdPlus: CORE.usdPlus, usdc: CORE.usdc, portfolioManager: CORE.manager, blockGetter: ZERO,
        cashStrategy: CASH, redeemFee: 10n, redeemFeeDenominator: 100000n, liquidationValue: 1000000000000n, decimals: 6n, isPaused: false, paused: false, inLending: true,
        hasRole: body.params[0].to === CORE.manager };
      result = iface.encodeFunctionResult(fragment, fragment.name === "lockOptionsPerAddress" ? [false, false] : [values[fragment.name]]);
    } else assert.fail("Unexpected RPC method");
    const response = { value: { jsonrpc: "2.0", id: body.id, result }, bytes: 100 };
    change(response, body, url, requests); return response;
  };
  return { compiled, candidates, transport, clock: () => now, requests, iface, activeToken };
}
test("ten common-pin core runtimes and clear token guards do not manufacture full exit proof", async () => {
  const deps = coreFixture(), out = await coreState(deps);
  assert.equal(out.status, "TOKEN_CORE_GUARDS_CLEAR_AAVE_BINDING_REQUIRED");
  assert.equal(Object.keys(out.observation.runtimeBound).length, 10);
  assert.equal(out.observation.paperActorIsWallet, false);
  assert.equal(out.observation.actorFeeExempt, false);
  assert.equal(out.gates.quoteEligible, false); assert.equal(out.gates.fullExitVerified, false);
  assert.ok(out.requests < 180); assert.ok(!JSON.stringify(out).includes(".invalid"));
});
for (const [label, name] of [["token", "isPaused"], ["exchange", "paused"]]) test(`${label} pause blocks this ordinary route`, async () => {
  const deps = coreFixture((r, b) => { if (b.method === "eth_call" && b.params[0].data === new Interface([`function ${name}() view returns(bool)`]).encodeFunctionData(name)) r.value.result = new Interface([`function ${name}() view returns(bool)`]).encodeFunctionResult(name, [true]); });
  assert.equal((await coreState(deps)).status, "BLOCKED_PAUSED");
});
test("venue send lock blocks acquisition without a permission-bypass attempt", async () => {
  const deps = coreFixture((r, b) => { if (b.method === "eth_call" && b.params[0].data.startsWith(new Interface(["function lockOptionsPerAddress(address) view returns(bool,bool)"]).getFunction("lockOptionsPerAddress").selector)) r.value.result = "0x" + "0".repeat(63) + "1" + "0".repeat(64); });
  assert.equal((await coreState(deps)).status, "BLOCKED_TOKEN_TRANSFER_LOCK");
});
test("runtime mismatch leaves token permission status unobserved", async () => {
  const deps = coreFixture((r, b) => { if (b.method === "eth_getCode" && b.params[0] === CONTRACTS.token.implementation) r.value.result = "0x6001"; });
  const out = await coreState(deps); assert.equal(out.code, "CORE_RUNTIME_MISMATCH"); assert.equal(out.observation, null);
});
test("same-family records cannot corroborate a core pin", async () => {
  const deps = coreFixture(); deps.candidates[1].family = "one";
  assert.equal((await coreState(deps)).code, "TWO_STATE_CAPABLE_FAMILIES_UNAVAILABLE");
});
test("terminal reorg discards the assembled core observation", async () => {
  let count = 0;
  const deps = coreFixture((r, b) => { if (b.method === "eth_getBlockByNumber" && b.params[0] === "0x100" && ++count > 2) r.value.result.hash = "0x" + "12".repeat(32); });
  const out = await coreState(deps); assert.equal(out.code, "TERMINAL_PIN_CHANGED"); assert.equal(out.observation, null);
});
test("no live transport for injected candidates", async () => {
  const out = await coreState({ candidates: [] }); assert.equal(out.code, "INJECTED_TRANSPORT_REQUIRED"); assert.equal(out.requests, 0);
});
test("corrected active-token reference remains quote-gated", async () => {
  const out = await coreState(coreFixture(() => {}, true));
  assert.equal(out.status, "TOKEN_CORE_GUARDS_CLEAR_AAVE_BINDING_REQUIRED");
  assert.equal(out.observation.implementations.token, ACTIVE_TOKEN); assert.equal(out.gates.quoteEligible, false);
});
test("changed pointer diagnostics are explicit and not corroborated", async () => {
  const deps = coreFixture((r, b) => { if (b.method === "eth_getStorageAt" && b.params[0] === CORE.usdPlus) r.value.result = "0x" + ACTIVE_TOKEN.slice(2).padStart(64, "0"); });
  const out = await coreState(deps);
  assert.equal(out.code, "CORE_IMPLEMENTATION_CHANGED"); assert.equal(out.failureContext.label, "token");
  assert.equal(out.failureContext.observed, ACTIVE_TOKEN); assert.equal(out.failureContext.corroborated, false); assert.equal(out.observation, null);
});
