"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const tool = require("./build-venus-psr-ethereum-vtreasury-source-binding.js");

function inputs() { return tool.loadInputs(); }
function cloneInputs() {
  const value = inputs();
  return { ...value, capture: structuredClone(value.capture), deployment: structuredClone(value.deployment), input: structuredClone(value.input) };
}
function rejects(code, mutate) {
  const value = cloneInputs(); mutate(value);
  assert.throws(() => tool.buildSupplement(value), (error) => error instanceof tool.BindingError && error.code === code);
}

test("exact persisted historical build binds the sole fixed-block destination", () => {
  const artifact = tool.buildSupplement(inputs());
  assert.equal(artifact.classification, "SOURCE_BOUND_NONPUBLIC_SINK");
  assert.equal(artifact.scope.destination, "0xfd9b071168bc27dbe16406ec3aba050ce8eb22fa");
  assert.equal(artifact.exactRuntimeBinding.lengthBytes, 2702);
  assert.equal(artifact.exactRuntimeBinding.fullRuntimeIncludingMetadata, true);
  assert.equal(artifact.exactRuntimeBinding.wildcardMasking, false);
  assert.equal(artifact.sourceBinding.authority, "PERSISTED_HISTORICAL_STANDARD_JSON_INPUT");
  assert.equal(artifact.supersession.priorClassification, "UNKNOWN_CONTRACT");
  assert.equal(tool.validateSupplement(artifact), true);
});

test("runtime, historical source and compiler settings mismatches fail closed", () => {
  rejects("FULL_RUNTIME_MISMATCH", ({ deployment }) => { deployment.deployedBytecode = `${deployment.deployedBytecode.slice(0, -2)}00`; });
  rejects("HISTORICAL_TARGET_SOURCE_MISMATCH", ({ input }) => { input.sources["contracts/Governance/VTreasuryV8.sol"].content += "\n"; });
  rejects("COMPILER_OR_SETTINGS_MISMATCH", ({ input }) => { input.settings.optimizer.runs += 1; });
});

test("wrong destination address and unexpected ABI method fail closed", () => {
  rejects("DEPLOYMENT_ADDRESS_MISMATCH", ({ deployment }) => { deployment.address = "0x0000000000000000000000000000000000000001"; });
  rejects("ABI_MISMATCH", ({ deployment }) => {
    deployment.abi.push({ type: "function", name: "unexpectedMutation", inputs: [], outputs: [], stateMutability: "nonpayable" });
  });
});

test("withdrawal modifiers are asserted from the exact historical source", () => {
  rejects("TOKEN_WITHDRAW_ACCESS_MISMATCH", ({ input }) => {
    input.sources["contracts/Governance/VTreasuryV8.sol"].content = input.sources["contracts/Governance/VTreasuryV8.sol"].content.replace("external onlyOwner nonReentrant", "external nonReentrant");
  });
  rejects("NATIVE_WITHDRAW_ACCESS_MISMATCH", ({ input }) => {
    input.sources["contracts/Governance/VTreasuryV8.sol"].content = input.sources["contracts/Governance/VTreasuryV8.sol"].content.replace("external payable onlyOwner nonReentrant", "external payable onlyOwner");
  });
});

test("proxy slot and direct receipt contradictions fail closed", () => {
  rejects("PROXY_CONTRADICTION", ({ capture }) => { capture.destinations[0].eip1967.implementationSlot = "0x0000000000000000000000000000000000000001"; });
  rejects("DIRECT_DEPLOYMENT_RECEIPT_MISMATCH", ({ deployment }) => { deployment.receipt.to = "0x0000000000000000000000000000000000000001"; });
});

test("current checkout mismatch is context only and never invalidates historical input binding", () => {
  const value = inputs();
  value.currentSource = `${value.input.sources["contracts/Governance/VTreasuryV8.sol"].content}\n// current checkout divergence`;
  const artifact = tool.buildSupplement(value);
  assert.equal(artifact.sourceBinding.currentCheckoutComparison.exactHistoricalMatch, false);
  assert.equal(artifact.sourceBinding.currentCheckoutComparison.bindingRequirement, false);
  assert.equal(artifact.sourceBinding.currentCheckoutComparison.semanticsClaimedFromCurrentCheckout, false);
  assert.equal(artifact.classification, "SOURCE_BOUND_NONPUBLIC_SINK");
});

test("generation is deterministic and contains no provider or RPC material", () => {
  const value = inputs();
  const left = tool.buildSupplement(value); const right = tool.buildSupplement(value);
  assert.deepEqual(left, right);
  const serialized = JSON.stringify(left);
  assert.equal(/(?:https?|wss?):\/\//i.test(serialized), false);
  assert.equal(/jsonrpc|providerUrl|endpoint/i.test(serialized), false);
  assert.equal(left.safety.providerMaterialAbsent, true);
  assert.equal(left.safety.rawRpcEnvelopeAbsent, true);
});

test("strict capture schema and deterministic commitment mutations are rejected", () => {
  rejects("CAPTURE_SCHEMA_OR_SCOPE_MISMATCH", ({ capture }) => { capture.schema = "wrong"; });
  const artifact = tool.buildSupplement(inputs()); artifact.classification = "UNKNOWN_CONTRACT";
  assert.throws(() => tool.validateSupplement(artifact), (error) => error instanceof tool.BindingError);
});
