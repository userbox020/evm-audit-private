#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const framework = require("./deployed-delta-adapters/index.js");
const fluid = require("./deployed-delta-adapters/fluid-contracts-public.js");

const hash = (character) => character.repeat(64);
const buildInfoMapping = Object.freeze({
  buildInfoPath: "build-info/fluid-liquidity.json",
  sourceName: "contracts/protocols/liquidity/liquidity.sol",
  contractName: "Liquidity"
});

function manifest() {
  return {
    address: `0x${"a".repeat(40)}`,
    abi: [{
      inputs: [{ internalType: "address", name: "admin_", type: "address" }],
      stateMutability: "nonpayable",
      type: "constructor"
    }, {
      inputs: [],
      name: "admin",
      outputs: [{ internalType: "address", name: "", type: "address" }],
      stateMutability: "view",
      type: "function"
    }],
    storageLayout: {
      storage: [{
        astId: 7,
        contract: "contracts/protocols/liquidity/liquidity.sol:Liquidity",
        label: "_status",
        offset: 0,
        slot: "0",
        type: "t_uint256"
      }],
      types: {
        t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" }
      }
    }
  };
}

function context(overrides = {}) {
  return {
    repositoryId: fluid.REPOSITORY_ID,
    pinnedCommit: "1".repeat(40),
    manifestPath: "deployments/mainnet/Liquidity.json",
    manifestBlobCommitment: hash("2"),
    declarationCommitment: hash("3"),
    upstreamExtractorCommitment: hash("4"),
    upstreamRecordCommitment: hash("5"),
    manifest: manifest(),
    ...overrides
  };
}

test("explicit source-owned mapping is exact and shared-framework compatible", () => {
  const fixture = context({ buildInfoMapping });
  const before = JSON.stringify(fixture);
  const parsed = fluid.extract(fixture);
  assert.deepEqual(parsed, { status: "EXACT", mappings: [buildInfoMapping] });
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.mappings), true);
  assert.equal(Object.isFrozen(parsed.mappings[0]), true);

  const registry = framework.createRegistry();
  const descriptor = registry.register(fluid.REPOSITORY_ID,
    (sharedContext) => fluid.extract({ ...sharedContext, buildInfoMapping }));
  assert.equal(descriptor.extract instanceof Function, true);
  const result = registry.dispatch(context());
  assert.equal(result.status, "EXACT");
  assert.deepEqual(result.transient.parsedMapping, buildInfoMapping);
  assert.equal(framework.validateResult(result), true);

  const serialized = JSON.stringify({ parsed, persistable: result.persistable });
  assert.equal(serialized.includes(fixture.manifest.address), false);
  assert.equal(serialized.includes(JSON.stringify(fixture.manifest.abi)), false);
  assert.equal(serialized.includes(JSON.stringify(fixture.manifest.storageLayout)), false);
});

test("valid official projection without an explicit mapping is finitely unknown", () => {
  assert.deepEqual(fluid.extract(context()), {
    status: "UNKNOWN",
    reason: "BUILD_METADATA_ABSENT"
  });
});

test("implied mappings and topology are never accepted", () => {
  const implied = manifest();
  implied.solcInputHash = hash("6");
  assert.deepEqual(fluid.extract(context({ manifest: implied })), {
    status: "UNKNOWN",
    reason: "BUILD_METADATA_ABSENT"
  });
  assert.deepEqual(fluid.extract(context({
    topology: "deployments/mainnet/solcInputs",
    buildInfoMapping
  })), {
    status: "UNKNOWN",
    reason: "UNSUPPORTED_MANIFEST"
  });
});

test("leaky and malformed paths fail closed without reflecting input", () => {
  const mappings = [
    { ...buildInfoMapping, buildInfoPath: "../build-info/fluid.json" },
    { ...buildInfoMapping, buildInfoPath: "https://example.invalid/fluid.json" },
    { ...buildInfoMapping, sourceName: "contracts\\Liquidity.sol" },
    { ...buildInfoMapping, sourceName: `contracts/0x${"b".repeat(40)}.sol` },
    { ...buildInfoMapping, contractName: "Liquidity/Proxy" }
  ];
  for (const buildInfoMappingFixture of mappings) {
    const result = fluid.extract(context({ buildInfoMapping: buildInfoMappingFixture }));
    assert.deepEqual(result, { status: "UNKNOWN", reason: "MAPPING_MALFORMED" });
    const output = JSON.stringify(result);
    assert.equal(output.includes(JSON.stringify(buildInfoMappingFixture)), false);
    assert.doesNotMatch(output, /0x[0-9a-f]{40}|https?:\/\//i);
  }

  for (const manifestPath of [
    "deployments/mainnet/nested/Liquidity.json",
    "deployments/../Liquidity.json",
    "deployments/mainnet/Liquidity.sol"
  ]) {
    assert.deepEqual(fluid.extract(context({ manifestPath, buildInfoMapping })), {
      status: "UNKNOWN",
      reason: "UNSUPPORTED_MANIFEST"
    });
  }
});

test("malformed deployment projections fail closed", () => {
  const fixtures = [
    { ...manifest(), address: "not-an-address" },
    { ...manifest(), abi: [{ name: "admin", type: "function" }] },
    { ...manifest(), storageLayout: { storage: [], types: { bad: null } } },
    { address: manifest().address, abi: manifest().abi }
  ];
  for (const malformed of fixtures) {
    assert.deepEqual(fluid.extract(context({ manifest: malformed, buildInfoMapping })), {
      status: "UNKNOWN",
      reason: "UNSUPPORTED_MANIFEST"
    });
  }
});

test("equivalent key order produces deterministic adapter and framework results", () => {
  const first = fluid.extract(context({ buildInfoMapping }));
  const reorderedManifest = manifest();
  const reordered = {
    storageLayout: reorderedManifest.storageLayout,
    abi: reorderedManifest.abi,
    address: reorderedManifest.address
  };
  const second = fluid.extract(context({
    manifest: reordered,
    buildInfoMapping: {
      contractName: buildInfoMapping.contractName,
      sourceName: buildInfoMapping.sourceName,
      buildInfoPath: buildInfoMapping.buildInfoPath
    }
  }));
  assert.deepEqual(first, second);

  const one = framework.createRegistry();
  const two = framework.createRegistry();
  one.register(fluid.REPOSITORY_ID, () => first);
  two.register(fluid.REPOSITORY_ID, () => second);
  assert.deepEqual(one.dispatch(context()).persistable, two.dispatch(context({ manifest: reordered })).persistable);
});

test("registration and capabilities use the shared side-effect-free framework API", () => {
  const registry = framework.createRegistry();
  const descriptor = fluid.register(registry);
  assert.equal(descriptor.repositoryId, fluid.REPOSITORY_ID);
  assert.equal(descriptor.extract, fluid.extract);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.deepEqual(fluid.CAPABILITIES, {
    network: false,
    filesystem: false,
    processExecution: false,
    rpc: false,
    fork: false,
    signing: false,
    transactions: false
  });
});
