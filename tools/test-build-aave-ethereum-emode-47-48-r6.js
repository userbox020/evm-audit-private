#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { keccak256 } = require("ethers");
const b = require("./build-aave-ethereum-emode-47-48-r6.js");
let count = 0;
const test = (name, run) => { run(); console.log(`ok ${++count} - ${name}`); };
const prepared = b.prepare(), originalHashes = prepared.sourceHashes;
let bundle;
test("exact gitlink chain resolves from local committed objects", () => {
  assert.equal(prepared.repositories.origin.commit, "1ce897ba99d5a9ab659861b591576cd4278e9e27");
  assert.equal(prepared.repositories.utils.commit, "039931241e49d78b4d0a798e1fff4da3eb40cc35");
  assert.equal(Object.keys(prepared.repositories).length, 8);
  assert.equal(Object.keys(prepared.agent.input.sources).length, 38);
});
test("context remapping uses the exact origin src directory", () => {
  const mappings = prepared.agent.input.settings.remappings;
  assert.equal(b.resolveImport("lib/aave-helpers/lib/aave-address-book/src/AaveV3.sol", "aave-v3-origin/contracts/interfaces/IPool.sol", mappings),
    "lib/aave-helpers/lib/aave-address-book/lib/aave-v3-origin/src/contracts/interfaces/IPool.sol");
  assert.equal(b.resolveImport(b.AGENT, "./BaseAaveAgent.sol", mappings), "src/contracts/agent/BaseAaveAgent.sol");
});
test("imports cannot escape the explicit source scope", () => {
  for (const name of ["../../../../private.sol", "https://example.invalid/a.sol", "../.env", "/outside.sol"]) {
    assert.throws(() => b.resolveImport(b.AGENT, name, prepared.agent.input.settings.remappings), /IMPORT_/);
  }
});
test("source manifests match the literal standard-JSON inputs", () => {
  for (const [file, source] of Object.entries(prepared.agent.input.sources)) {
    assert.equal(b.sha(Buffer.from(source.content)), prepared.agent.manifest[file].sha256);
    assert.equal(keccak256(Buffer.from(source.content)), prepared.agent.manifest[file].keccak256);
    assert.deepEqual(Object.keys(source), ["content"]);
  }
});
test("full proxy verification accepts the exact solc-only proxy", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(b.ROOT, "reports/raw/fast/aave-ethereum-emode-47-48-r5-proxy-code.json")));
  const expected = prepared.authority.r3.report.observations.current.code.hub;
  assert.equal(b.verifyProxy(fixture.runtime, expected).metadataNormalization, "none");
  assert.equal(b.verifyProxy(fixture.runtime, expected).exactFullRuntimeMatch, true);
  assert.throws(() => b.verifyProxy(`${fixture.runtime.slice(0, -2)}0b`, expected), /PROXY_FULL_RUNTIME_MISMATCH/);
  assert.throws(() => b.verifyProxy(`0x00${fixture.runtime.slice(4)}`, expected), /PROXY_FULL_RUNTIME_MISMATCH/);
});
test("malformed runtimes cannot be hashed as valid identities", () => {
  for (const value of ["0x", "0x0", "0xzz", null]) assert.throws(() => b.fullIdentity(value), /RUNTIME_INVALID/);
});
test("the compiler refuses URL-based source inputs", () => {
  assert.throws(() => b.compile({ language: "Solidity", sources: { "src/A.sol": { urls: ["https://example.invalid/A.sol"] } } }), /NONLITERAL_COMPILER_INPUT/);
});
test("all three contracts compile with the cached pinned compiler", () => {
  bundle = b.build(prepared);
  assert.equal(bundle.report.status, "OFFLINE_BUILD_COMPLETE");
  assert.equal(bundle.report.core.AgentHub.matchesPriorBuild, true);
  assert.equal(bundle.report.core.RangeValidationModule.matchesPriorBuild, true);
  assert.equal(bundle.report.compiler.sha256, b.SOLC_SHA);
});
test("agent immutable substitutions are explicit and deterministic", () => {
  assert.deepEqual(b.instantiateAgent(bundle.agentOutput), bundle.agent);
  assert.equal(bundle.agent.bindings.length, 4);
  assert.deepEqual(bundle.agent.bindings.map((value) => value.name).sort(), ["AGENT_HUB", "POOL", "RANGE_VALIDATION_MODULE", "UPDATE_TYPE"]);
  assert.equal(bundle.report.agent.bytes, 3803);
  assert.equal(bundle.report.agent.keccak256, "0xe39f97a7dc6847748c60ead3eef0a2d8b5aaac3f7fa917b61ede802db39dd828");
});
test("unknown immutable identifiers cannot be silently patched", () => {
  const output = structuredClone(bundle.agentOutput), refs = output.contracts[b.AGENT].AaveEModeAgent.evm.deployedBytecode.immutableReferences;
  const key = Object.keys(refs)[0]; refs["99999999"] = refs[key]; delete refs[key];
  assert.throws(() => b.instantiateAgent(output), /IMMUTABLE_DECLARATION_INVALID/);
});
test("invalid immutable lengths and overlaps are rejected", () => {
  for (const mutate of [
    (refs) => { Object.values(refs)[0][0].length = 31; },
    (refs) => { Object.values(refs)[1][0].start = Object.values(refs)[0][0].start; }
  ]) {
    const output = structuredClone(bundle.agentOutput); mutate(output.contracts[b.AGENT].AaveEModeAgent.evm.deployedBytecode.immutableReferences);
    assert.throws(() => b.instantiateAgent(output), /IMMUTABLE_/);
  }
});
test("candidate mismatch never promotes complete runtime assurance", () => {
  assert.equal(bundle.report.agent.historicalFullRuntimeMatch, false);
  assert.equal(bundle.report.gates.agentExactRuntimeMatch, false);
  assert.equal(bundle.report.gates.completeRuntimeBinding, false);
  assert.equal(bundle.report.gates.completeAuthorityVerification, false);
  assert.equal(bundle.report.gates.effectiveRangeSemanticsBound, false);
});
test("normalized comparisons cannot be mislabeled exact-runtime equality", () => {
  for (const name of ["AgentHub", "RangeValidationModule"]) {
    const comparison = bundle.report.core[name].explorerComparison;
    assert.equal(comparison.exactFullRuntimeMatch, false);
    assert.notEqual(comparison.compiledMetadataHex, comparison.observedMetadataHex);
  }
  assert.equal(bundle.report.core.AgentHub.historicalNormalizedRuntimeMatch, "unknown");
  assert.equal(bundle.report.core.RangeValidationModule.explorerComparison.observedFullRuntime.keccak256,
    prepared.authority.r3.report.observations.current.code.range.keccak256);
});
test("all compiler metadata sources agree with their literal input content", () => {
  for (const [input, output] of [[bundle.agentInput, bundle.agentOutput], [bundle.coreInput, bundle.coreOutput]]) {
    for (const contracts of Object.values(output.contracts)) for (const artifact of Object.values(contracts)) if (artifact.metadata) {
      const metadata = JSON.parse(artifact.metadata);
      for (const [file, source] of Object.entries(metadata.sources)) assert.equal(keccak256(Buffer.from(input.sources[file].content)), source.keccak256);
    }
  }
});
test("the offline build preserves all prior captured inputs", () => {
  for (const [file, hash] of Object.entries(originalHashes)) assert.equal(b.sha(fs.readFileSync(path.join(b.ROOT, file))), hash);
  assert.deepEqual(bundle.report.safety, { network: false, inventoryReads: 0, rpcRequests: 0, checkoutMutation: false, signing: false });
});
console.log(`${count} tests passed`);
