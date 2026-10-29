#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const framework = require("./deployed-delta-adapters/index.js");
const adapter = require("./deployed-delta-adapters/curve-core.js");

const hash = (character) => character.repeat(64);
function compiler(overrides = {}) {
  return {
    provenance: "SOURCE_OWNED",
    version: "0.4.1+commit.abc123",
    settings: { evmVersion: "cancun", optimize: "codesize" },
    ...overrides
  };
}
function row(deploymentType, overrides = {}) {
  return { deployment_type: deploymentType, compiler: compiler(), ...overrides };
}
function input(manifest, overrides = {}) {
  return {
    repositoryId: adapter.REPOSITORY_ID,
    pinnedCommit: "1".repeat(40),
    manifestPath: "deployments/prod/ethereum.yaml",
    manifestBlobCommitment: hash("2"),
    declarationCommitment: hash("3"),
    upstreamExtractorCommitment: hash("4"),
    upstreamRecordCommitment: hash("5"),
    manifest,
    ...overrides
  };
}
function context(manifest, overrides = {}) {
  return Object.freeze(input(Object.freeze(manifest), overrides));
}
const mapping = Object.freeze({
  buildInfoPath: "build-info/curve-core.json",
  sourceName: "contracts/amm/StableSwap.vy",
  contractName: "StableSwap"
});

test("normal and blueprint rows without source-owned build metadata remain safely unknown", () => {
  for (const deploymentType of ["normal", "blueprint"]) {
    const output = adapter.extract(context({ contracts: [row(deploymentType)] }));
    assert.deepEqual(output, { status: "UNKNOWN", reason: "BUILD_METADATA_ABSENT" });
    assert.equal(JSON.stringify(output).includes("DIRECT"), false);
    assert.equal(JSON.stringify(output).includes("EIP1967"), false);
  }
});

test("an explicit source-owned mapping is normalized through the shared framework", () => {
  const result = framework.dispatch(input({
    contracts: [row("normal", { sourceOwnedBuildInfoMapping: mapping })]
  }));
  assert.equal(result.status, "EXACT");
  assert.equal(result.reason, "EXACT");
  assert.deepEqual(result.transient.parsedMapping, mapping);
  assert.equal(framework.validateResult(result), true);
  const persisted = JSON.stringify(result.persistable);
  for (const raw of [adapter.REPOSITORY_ID, "ethereum.yaml", mapping.buildInfoPath,
    mapping.sourceName, mapping.contractName]) assert.equal(persisted.includes(raw), false);
});

test("blueprint mappings never emit a direct or EIP-1967 topology claim", () => {
  const output = adapter.extract(context({
    contracts: [row("blueprint", { sourceOwnedBuildInfoMapping: mapping })]
  }));
  assert.deepEqual(output, { status: "EXACT", mappings: [mapping] });
  assert.equal(JSON.stringify(output).includes("DIRECT"), false);
  assert.equal(JSON.stringify(output).includes("EIP1967"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(output, "topology"), false);
  for (const topology of ["DIRECT", "EIP1967_PROXY"]) {
    assert.deepEqual(adapter.extract(context({ contracts: [row("blueprint", {
      topology, sourceOwnedBuildInfoMapping: mapping
    })] })), { status: "UNKNOWN", reason: "MAPPING_MALFORMED" });
  }
});

test("legacy and unknown compiler provenance cannot promote a mapping", () => {
  for (const provenance of ["LEGACY", "UNKNOWN"]) {
    const output = adapter.extract(context({ contracts: [row("normal", {
      compiler: compiler({ provenance }), sourceOwnedBuildInfoMapping: mapping
    })] }));
    assert.deepEqual(output, { status: "UNKNOWN", reason: "BUILD_METADATA_ABSENT" });
  }
});

test("malformed and leaky metadata fails closed without retaining raw values", () => {
  const fixtures = [
    { contracts: [row("proxy")] },
    { contracts: [row("normal", { compiler: compiler({ settings: "codesize" }) })] },
    { contracts: [row("normal", { sourceOwnedBuildInfoMapping: {
      ...mapping, address: `0x${"a".repeat(40)}`
    } })] },
    { contracts: [row("normal", { sourceOwnedBuildInfoMapping: {
      ...mapping, buildInfoPath: "https://example.invalid/build.json"
    } })] },
    { contracts: [row("normal", { sourceOwnedBuildInfoMapping: {
      ...mapping, sourceName: `contracts/0x${"b".repeat(40)}.vy`
    } })] }
  ];
  for (const manifest of fixtures) {
    const output = adapter.extract(context(manifest));
    assert.deepEqual(output, { status: "UNKNOWN", reason: "MAPPING_MALFORMED" });
    assert.equal(JSON.stringify(output).includes("0x"), false);
    assert.equal(JSON.stringify(output).includes("https://"), false);
  }
  assert.deepEqual(adapter.extract(context({ contracts: [row("normal")] }, {
    manifestPath: "deployments/dev/ethereum.yaml"
  })), { status: "UNKNOWN", reason: "UNSUPPORTED_MANIFEST" });
});

test("contract-row parsing and shared commitments are deterministic", () => {
  const first = input({ contracts: {
    StableSwap: row("normal", { sourceOwnedBuildInfoMapping: mapping })
  } });
  const second = input({ contracts: {
    StableSwap: {
      sourceOwnedBuildInfoMapping: {
        contractName: mapping.contractName,
        sourceName: mapping.sourceName,
        buildInfoPath: mapping.buildInfoPath
      },
      compiler: {
        settings: { optimize: "codesize", evmVersion: "cancun" },
        version: "0.4.1+commit.abc123",
        provenance: "SOURCE_OWNED"
      },
      deployment_type: "normal"
    }
  } });
  assert.deepEqual(adapter.extract(context(first.manifest)), adapter.extract(context(second.manifest)));
  assert.deepEqual(framework.dispatch(first).persistable, framework.dispatch(second).persistable);
});
