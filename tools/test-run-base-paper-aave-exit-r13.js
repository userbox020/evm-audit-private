"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { AbiCoder, Interface, keccak256 } = require("ethers");
const { librarySettings, poolRuntime, libraryRuntime, declaredLibrarySettings, withdrawalGuards, bindWithdrawal, IMPLEMENTATION, ACTIVE_AAVE } = require("./run-base-paper-aave-exit-r13");
test("converts explorer flat library settings without changing addresses", () => {
  const address = "0x" + "AB".repeat(20);
  assert.deepEqual(librarySettings({ "lib/Logic.sol:Logic": address }), { "lib/Logic.sol": { Logic: address.toLowerCase() } });
});
for (const value of [{ "../Logic.sol:Logic": "0x" + "ab".repeat(20) }, { "Logic": "0x" + "ab".repeat(20) }, { "lib/Logic.sol:Logic": "bad" }, [], null])
  test(`reject malformed library settings ${JSON.stringify(value)}`, () => assert.throws(() => librarySettings(value)));

function poolFixture() {
  const identifier = id => ({ nodeType: "Identifier", referencedDeclaration: id });
  const cast = value => ({ nodeType: "FunctionCall", kind: "typeConversion", expression: { typeName: { name: "address" } }, arguments: [value] });
  const ctor = (parent, ids) => ({ nodeType: "FunctionDefinition", kind: "constructor", parameters: { parameters: ids.map(id => ({ id })) },
    modifiers: parent ? [{ modifierName: { name: parent }, arguments: ids.map(identifier) }] : [], body: { statements: [] } });
  const constructors = [ctor("PoolInstance", [101, 102]), ctor("Pool", [201, 202]), ctor(null, [301, 302])];
  constructors[2].body.statements = [
    { expression: { nodeType: "Assignment", operator: "=", leftHandSide: identifier(1), rightHandSide: identifier(301) } },
    { expression: { nodeType: "FunctionCall", expression: { name: "require" }, arguments: [{ nodeType: "BinaryOperation", operator: "!=", leftExpression: cast(identifier(302)), rightExpression: cast({ nodeType: "Literal", value: "0" }) }] } },
    { expression: { nodeType: "Assignment", operator: "=", leftHandSide: identifier(2), rightHandSide: cast(identifier(302)) } }
  ];
  const definitions = ["L2PoolInstance", "PoolInstance", "Pool"].map((name, i) => ({ nodeType: "ContractDefinition", name, nodes: [constructors[i]] }));
  definitions[2].nodes.push(...["ADDRESSES_PROVIDER", "RESERVE_INTEREST_RATE_STRATEGY"].map((name, i) => ({ nodeType: "VariableDeclaration", name, id: i + 1, mutability: "immutable" })));
  return { output: { sources: { "Pool.sol": { ast: { nodes: definitions } } } }, constructors,
    target: { object: "00".repeat(64) + "1234", immutableReferences: { "1": [{ start: 0, length: 32 }], "2": [{ start: 32, length: 32 }] } },
    values: ["0x" + "11".repeat(20), "0x" + "22".repeat(20)] };
}
test("pool immutables follow proven positional constructor assignments", () => {
  const f = poolFixture(), args = AbiCoder.defaultAbiCoder().encode(["address", "address"], f.values);
  const result = poolRuntime(f.output, f.target, args);
  assert.equal(result.runtime, args + "1234"); assert.equal(result.proof.length, 2);
});
for (const [name, mutate] of [
  ["changed forwarding", f => f.constructors[0].modifiers[0].arguments[0].referencedDeclaration = 102],
  ["constructor mutation", f => f.constructors[0].body.statements.push({})],
  ["wrong immutable value", f => f.constructors[2].body.statements[0].expression.rightHandSide.referencedDeclaration = 302],
  ["unproven guard", f => f.constructors[2].body.statements[1].expression.expression.name = "mutate"],
  ["overlap", f => f.target.immutableReferences["2"][0].start = 0],
  ["unknown immutable", f => f.target.immutableReferences["3"] = [{ start: 0, length: 32 }]],
]) test(`reject pool ${name}`, () => { const f = poolFixture(); mutate(f); assert.throws(() => poolRuntime(f.output, f.target, AbiCoder.defaultAbiCoder().encode(["address", "address"], f.values))); });
test("library self-protection replacement preserves every other byte", () => {
  const target = { object: "73" + "00".repeat(20) + "30141234", immutableReferences: {} }, address = "0x" + "11".repeat(20);
  assert.equal(libraryRuntime(target, address, { contractKind: "library" }), "0x73" + address.slice(2) + "30141234");
  assert.throws(() => libraryRuntime(target, address, { contractKind: "contract" }));
  assert.throws(() => libraryRuntime({ ...target, object: "00".repeat(30) }, address, { contractKind: "library" }));
});
test("withdrawal guard arithmetic rounds scaled burns up without claiming transfer", () => {
  const rows = withdrawalGuards(1n << 56n, 0n, 3n * 10n ** 27n, 100000000n, 1000000000n, 1000000000n);
  assert.equal(rows[0].scaledBurnRaw, "333334"); assert.equal(rows[1].scaledBurnRaw, "33333334");
  assert.ok(rows.every(row => row.checkedGuardsClear && row.transferSuccess === "unknown"));
  assert.ok(withdrawalGuards((1n << 56n) | (1n << 60n), 0n, 10n ** 27n, 1000000000n, 1000000000n, 1000000000n).every(row => !row.checkedGuardsClear));
  assert.ok(withdrawalGuards(1n << 56n, 1n, 10n ** 27n, 1000000000n, 1000000000n, 1000000000n).every(row => !row.checkedGuardsClear));
});
function bindingFixture(change = () => {}, activeAave = false) {
  const now = Date.parse("2026-09-05T23:30:00Z"), runtime = "0x60006000";
  const rawHeader = { number: "0x100", timestamp: `0x${(BigInt(now / 1000) - 60n).toString(16)}`, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), stateRoot: "0x" + "ef".repeat(32) };
  const pin = { number: "256", hash: rawHeader.hash, parentHash: rawHeader.parentHash, stateRoot: rawHeader.stateRoot, timestamp: String(now / 1000 - 60) };
  const abi = ["function getConfiguration(address) view returns((uint256 data))", "function getUserConfiguration(address) view returns((uint256 data))",
    "function getReserveNormalizedIncome(address) view returns(uint256)", "function getVirtualUnderlyingBalance(address) view returns(uint128)"];
  const iface = new Interface([...abi, "function balanceOf(address) view returns(uint256)", "function scaledBalanceOf(address) view returns(uint256)"]);
  const addresses = activeAave ? ACTIVE_AAVE : { pool: IMPLEMENTATION, SupplyLogic: "0x034fd14b9ae6bb066a1f9f85a55e990b0b25c168", PoolLogic: "0xe51b69e5722bf547866a4d7bc190c6e81b626806" };
  const records = Object.fromEntries(Object.entries(addresses)
    .map(([name, address]) => [name, { address, runtime, runtimeKeccak256: keccak256(runtime), abi }]));
  const candidates = [{ url: "https://one.invalid/secret", family: "one" }, { url: "https://two.invalid/secret", family: "two" }];
  const core = { status: "TOKEN_CORE_GUARDS_CLEAR_AAVE_BINDING_REQUIRED", gates: { tokenRoleRuntimeBound: "true" }, observation: { pin, rpcStrength: "corroborated-operator-families" } };
  const requests = [];
  const transport = async (url, body) => {
    requests.push(body); let result;
    if (body.method === "eth_chainId") result = "0x2105";
    else if (body.method === "eth_getBlockByNumber") result = { ...rawHeader };
    else if (body.method === "eth_getCode") result = runtime;
    else if (body.method === "eth_getStorageAt") result = "0x" + addresses.pool.slice(2).padStart(64, "0");
    else if (body.method === "eth_call") {
      const fragment = iface.getFunction(body.params[0].data.slice(0, 10)); assert.equal(fragment.stateMutability, "view");
      const values = { getConfiguration: [1n << 56n], getUserConfiguration: [0n], getReserveNormalizedIncome: 10n ** 27n, getVirtualUnderlyingBalance: 1000000000n, scaledBalanceOf: 500000000n, balanceOf: 1000000000n };
      result = iface.encodeFunctionResult(fragment, [values[fragment.name]]);
    } else assert.fail("Unexpected RPC method");
    const response = { value: { jsonrpc: "2.0", id: body.id, result }, bytes: 100 }; change(response, body, url, requests); return response;
  };
  return { core, records, candidates, transport, requests, clock: () => now, activeAave };
}
test("Aave match uses the existing core pin and keeps incomplete external calls closed", async () => {
  const deps = bindingFixture(), out = await bindWithdrawal(deps);
  assert.equal(out.status, "AAVE_WITHDRAWAL_LIBRARIES_BOUND_EXTERNAL_CALLS_UNPROVEN");
  assert.equal(out.observation.corePinMatched, true); assert.equal(Object.keys(out.observation.runtimeBound).length, 3);
  assert.ok(out.observation.sizeGuards.every(row => row.checkedGuardsClear));
  assert.equal(out.gates.quoteEligible, false); assert.equal(out.gates.fullWithdrawalDependenciesBound, false);
  assert.ok(!JSON.stringify(out).includes(".invalid"));
});
test("Aave changed runtime is not bound", async () => {
  const deps = bindingFixture((r, b) => { if (b.method === "eth_getCode") r.value.result = "0x6001"; });
  const out = await bindWithdrawal(deps); assert.equal(out.code, "AAVE_RUNTIME_MISMATCH"); assert.equal(out.observation, null);
});
test("stale core pin blocks new calls", async () => {
  const deps = bindingFixture(); deps.clock = () => Date.parse("2026-09-06T01:00:00Z");
  const out = await bindWithdrawal(deps); assert.equal(out.code, "CORE_PIN_STALE"); assert.equal(out.requests, 0);
});
test("Aave qualification cannot use duplicate families", async () => {
  const deps = bindingFixture(); deps.candidates[1].family = "one";
  assert.equal((await bindWithdrawal(deps)).code, "TWO_CAPABLE_FAMILIES_UNAVAILABLE");
});
test("Aave terminal pin mismatch discards the observation", async () => {
  let count = 0;
  const deps = bindingFixture((r, b) => { if (b.method === "eth_getBlockByNumber" && b.params[0] === "0x100" && ++count > 2) r.value.result.hash = "0x" + "12".repeat(32); });
  const out = await bindWithdrawal(deps); assert.equal(out.code, "TERMINAL_PIN_CHANGED"); assert.equal(out.observation, null);
});
test("Aave injection requires mock transport", async () => {
  const out = await bindWithdrawal({ candidates: [] }); assert.equal(out.code, "INJECTED_TRANSPORT_REQUIRED"); assert.equal(out.requests, 0);
});
test("pointer-only diagnostic does not borrow old implementation source certainty", async () => {
  const active = "0x" + "11".repeat(20);
  const deps = bindingFixture((r, b) => { if (b.method === "eth_getStorageAt") r.value.result = "0x" + active.slice(2).padStart(64, "0"); });
  deps.pointerOnly = true;
  const out = await bindWithdrawal(deps);
  assert.equal(out.status, "AAVE_ACTIVE_POINTER_OBSERVED_SOURCE_BINDING_REQUIRED");
  assert.equal(out.observation.implementation, active); assert.equal(out.observation.previousSourceMatchesPointer, false);
  assert.equal(out.gates.selectedAaveRuntimeBound, "unknown"); assert.equal(out.gates.quoteEligible, false);
});
test("service library path reconciliation preserves name and address and rejects ambiguity", () => {
  const address = "0x" + "11".repeat(20), settings = { "Main.sol": { SupplyLogic: address } };
  const ast = { nodes: [{ nodeType: "ContractDefinition", contractKind: "library", name: "SupplyLogic" }] };
  const output = { sources: { "SupplyLogic.sol": { ast } } };
  const mapped = declaredLibrarySettings(settings, output);
  assert.deepEqual(mapped.normalized, { "SupplyLogic.sol": { SupplyLogic: address } });
  assert.equal(mapped.proof[0].addressChanged, false);
  output.sources["Other.sol"] = { ast }; assert.throws(() => declaredLibrarySettings(settings, output));
});
test("active Aave source profile binds only the corrected fixed implementation", async () => {
  const out = await bindWithdrawal(bindingFixture(() => {}, true));
  assert.equal(out.status, "AAVE_WITHDRAWAL_LIBRARIES_BOUND_EXTERNAL_CALLS_UNPROVEN");
  assert.equal(out.observation.implementation, ACTIVE_AAVE.pool); assert.equal(out.gates.quoteEligible, false);
});
