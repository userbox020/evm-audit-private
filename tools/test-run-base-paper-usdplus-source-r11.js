"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { normalize, instantiateRuntime, bind, PROXIES, KEYS } = require("./run-base-paper-usdplus-source-r11");
const { Interface, keccak256 } = require("ethers");
const { A } = require("./run-base-paper-usdplus-preflight-r10");
const address = "0x" + "11".repeat(20);
const fixture = () => ({ is_verified: true, name: "Test", file_path: "contracts/Test.sol", compiler_version: "v0.8.17+commit.8df45f5f", compiler_settings: { optimizer: { enabled: true, runs: 100 } },
  source_code: "pragma solidity ^0.8.17; contract Test {}", additional_sources: [], abi: [], deployed_bytecode: "0x60006000", implementations: [] });
test("preserves exact compiler settings, content, and runtime without a source-bound claim", () => {
  const out = normalize(fixture(), address);
  assert.equal(out.compiler, "0.8.17+commit.8df45f5f");
  assert.equal(out.input.settings.optimizer.runs, 100);
  assert.equal(out.input.sources["contracts/Test.sol"].content, fixture().source_code);
  assert.equal(out.explorerRuntime, "0x60006000");
});
for (const [name, modify] of [
  ["unverified", r => r.is_verified = false], ["floating compiler", r => r.compiler_version = "latest"],
  ["wrong address", r => r.address_hash = "0x" + "22".repeat(20)], ["missing settings", r => delete r.compiler_settings],
  ["path traversal", r => r.file_path = "../Test.sol"], ["absolute path", r => r.file_path = "C:\\Test.sol"],
  ["duplicate source", r => r.additional_sources = [{ file_path: r.file_path, source_code: r.source_code }]],
  ["runtime absent", r => r.deployed_bytecode = "0x"], ["two implementations", r => r.implementations = [{ address_hash: address }, { address_hash: address }]],
]) test(`reject ${name}`, () => { const raw = fixture(); modify(raw); assert.throws(() => normalize(raw, address)); });

function immutableFixture() {
  return { output: { sources: { "A.sol": { ast: { nodes: [{ id: 1, nodeType: "VariableDeclaration", name: "__self", mutability: "immutable", typeName: { name: "address" },
    value: { kind: "typeConversion", expression: { typeName: { name: "address" } }, arguments: [{ nodeType: "Identifier", name: "this" }] } }] } } } },
    target: { object: "60" + "00".repeat(32) + "1234", immutableReferences: { "1": [{ start: 1, length: 32 }] }, linkReferences: {} } };
}
test("only source-proven self address is instantiated; all other bytes stay exact", () => {
  const { output, target } = immutableFixture(), built = instantiateRuntime(output, target, address);
  assert.equal(built.runtime, "0x60" + address.slice(2).padStart(64, "0") + "1234");
  assert.equal(built.assignments[0].rationale, "SOURCE_INITIALIZER_ADDRESS_THIS");
});
for (const [name, modify] of [
  ["unknown initializer", f => f.output.sources["A.sol"].ast.nodes[0].value.arguments[0].name = "owner"],
  ["missing AST", f => f.output.sources = {}], ["out of range", f => f.target.immutableReferences["1"][0].start = 999],
  ["overlap", f => f.target.immutableReferences["1"].push({ start: 1, length: 32 })],
  ["nonzero template", f => f.target.object = "ff".repeat(35)],
  ["library link", f => f.target.linkReferences = { "L.sol": { L: [{ start: 0, length: 20 }] } }],
]) test(`reject immutable ${name}`, () => { const f = immutableFixture(); modify(f); assert.throws(() => instantiateRuntime(f.output, f.target, address)); });

function bindFixture(change = () => {}) {
  const now = Date.parse("2026-09-05T21:00:00Z");
  const impl = { exchange: A.implementation, manager: "0xb008d09d25f06799e4081877a6bb185d89d893d3", cash: "0xebeac3cd336e592defd6b53548fadde22900d3df" };
  const abi = [
    ...["usdPlus", "usdc", "portfolioManager", "roleManager", "blockGetter", "cashStrategy", "exchanger", "m2m"].map(name => `function ${name}() view returns(address)`),
    ...["redeemFee", "redeemFeeDenominator", "navSlippageBp"].map(name => `function ${name}() view returns(uint256)`),
    "function paused() view returns(bool)", "function hasRole(bytes32,address) view returns(bool)",
    "function getAllStrategyWeights() view returns((address strategy,uint256 minWeight,uint256 targetWeight,uint256 maxWeight,uint256 riskFactor,bool enabled,bool enabledReward)[])"
  ];
  const iface = new Interface(abi), compiled = Object.fromEntries(KEYS.map(key => {
    const [label, type] = key.split("-");
    return [key, { address: type === "proxy" ? PROXIES[label] : impl[label], runtime: "0x60006000", runtimeKeccak256: keccak256("0x60006000"),
      explorerRuntimeExact: true, abi, implementations: type === "proxy" ? [impl[label]] : [], inputSha256: "ab".repeat(32) }];
  }));
  const candidates = [{ family: "one", url: "https://one.invalid/secret" }, { family: "two", url: "https://two.invalid/secret" }];
  const requests = [];
  const transport = async (url, body) => {
    requests.push(body);
    let result;
    if (body.method === "eth_chainId") result = "0x2105";
    else if (body.method === "eth_getBlockByNumber") result = { number: "0x100", timestamp: `0x${(BigInt(now / 1000) - 60n).toString(16)}`, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), stateRoot: "0x" + "ef".repeat(32) };
    else if (body.method === "eth_getCode") result = "0x60006000";
    else if (body.method === "eth_getStorageAt") {
      const label = Object.keys(impl).find(key => PROXIES[key] === body.params[0]);
      result = "0x" + impl[label].slice(2).padStart(64, "0");
    } else if (body.method === "eth_call") {
      const fragment = iface.getFunction(body.params[0].data.slice(0, 10));
      assert.equal(fragment.stateMutability, "view");
      const values = { usdPlus: A.usdPlus, usdc: A.usdc, portfolioManager: A.manager, roleManager: A.manager, blockGetter: "0x" + "00".repeat(20),
        cashStrategy: PROXIES.cash, exchanger: A.exchange, m2m: A.m2m, redeemFee: 10n, redeemFeeDenominator: 100000n, paused: false, navSlippageBp: 4n, hasRole: true,
        getAllStrategyWeights: [[PROXIES.cash, 0n, 100000n, 100000n, 0n, true, false]] };
      result = iface.encodeFunctionResult(fragment, [values[fragment.name]]);
    } else assert.fail("Unexpected RPC method");
    const response = { value: { jsonrpc: "2.0", id: body.id, result }, bytes: 100 };
    change(response, body, url, requests);
    return response;
  };
  return { transport, candidates, compiled, clock: () => now, requests, iface };
}
test("five exact runtime matches do not close unknown cash implementation or withdrawal", async () => {
  const deps = bindFixture(), out = await bind(deps);
  assert.equal(out.status, "PARTIAL_RUNTIME_BOUND");
  assert.equal(Object.keys(out.observation.runtimeBound).length, 5);
  assert.equal(out.observation.manager.exchangeHasRole, true);
  assert.equal(out.observation.manager.strategies.length, 1);
  assert.equal(out.gates.fullWithdrawalDependenciesBound, false);
  assert.equal(out.gates.payoutCapacity, "unknown"); assert.equal(out.gates.quoteEligible, false);
  assert.ok(!JSON.stringify(out).includes(".invalid"));
  assert.ok(out.requests < 140);
});
test("runtime mismatch is terminal with no bound observation", async () => {
  const deps = bindFixture((r, b) => { if (b.method === "eth_getCode" && b.params[0] === A.implementation) r.value.result = "0x6001"; });
  const out = await bind(deps); assert.equal(out.code, "CHAIN_RUNTIME_MISMATCH"); assert.equal(out.observation, null);
});
test("implementation drift cannot inherit the old source binding", async () => {
  const deps = bindFixture((r, b) => { if (b.method === "eth_getStorageAt" && b.params[0] === A.exchange) r.value.result = "0x" + "00".repeat(12) + "11".repeat(20); });
  const out = await bind(deps); assert.equal(out.code, "CHAIN_IMPLEMENTATION_CHANGED"); assert.equal(out.observation, null);
});
test("family independence is checked after capability probes", async () => {
  const deps = bindFixture(); deps.candidates[1].family = "one";
  const out = await bind(deps); assert.equal(out.qualification.qualified, 2); assert.equal(out.code, "TWO_STATE_CAPABLE_FAMILIES_UNAVAILABLE");
});
test("terminal pin changes invalidate all matches", async () => {
  let historical = 0;
  const deps = bindFixture((r, b) => { if (b.method === "eth_getBlockByNumber" && b.params[0] === "0x100" && ++historical > 2) r.value.result.hash = "0x" + "12".repeat(32); });
  const out = await bind(deps); assert.equal(out.code, "TERMINAL_PIN_CHANGED"); assert.equal(out.observation, null);
});
test("malformed ABI cannot be treated as a getter observation", async () => {
  const deps = bindFixture((r, b) => { if (b.method === "eth_call") r.value.result += "00".repeat(32); });
  const out = await bind(deps); assert.equal(out.qualification.failures.ABI_INVALID, 2); assert.equal(out.observation, null);
});
test("compiled artifact hash mismatch stops before RPC", async () => {
  const deps = bindFixture(); deps.compiled["exchange-proxy"].runtimeKeccak256 = "0x" + "00".repeat(32);
  const out = await bind(deps); assert.equal(out.code, "COMPILED_EVIDENCE_INVALID"); assert.equal(out.requests, 0);
});
test("injection cannot open real network transport", async () => {
  const out = await bind({ candidates: [] }); assert.equal(out.code, "INJECTED_TRANSPORT_REQUIRED"); assert.equal(out.requests, 0);
});
