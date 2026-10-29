#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const adapters = require("./deployed-delta-adapters/index.js");
const mapping = require("./run-deployed-delta-build-mapping-resolver.js");
const aaveAddressBook = require("./deployed-delta-adapters/aave-address-book.js");

const REPOSITORY = "compound-finance/comet";
const hash = (character) => character.repeat(64);
function input(overrides = {}) {
  return {
    repositoryId: REPOSITORY,
    pinnedCommit: "1".repeat(40),
    manifestPath: "deployments/mainnet/usdc.json",
    manifestBlobCommitment: hash("2"),
    declarationCommitment: hash("3"),
    upstreamExtractorCommitment: hash("4"),
    upstreamRecordCommitment: hash("5"),
    manifest: {
      address: `0x${"a".repeat(40)}`,
      documentation: "https://repository.example.invalid/deployment",
      sourceCode: "contract RawSourceSentinel {}",
      release: { build: "fixture" }
    },
    ...overrides
  };
}
function validExtract(context) {
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.manifest), true);
  return {
    status: "EXACT",
    mappings: [{
      buildInfoPath: "artifacts/build-info/comet.json",
      sourceName: "contracts/Comet.sol",
      contractName: "Comet"
    }]
  };
}

test("registered fixture adapter normalizes an exact mapping with commitment-only persistence", () => {
  const registry = adapters.createRegistry();
  registry.register(REPOSITORY, validExtract);
  const result = registry.dispatch(input());
  assert.equal(adapters.validateResult(result), true);
  assert.equal(result.status, "EXACT");
  assert.deepEqual(result.transient.parsedMapping, {
    buildInfoPath: "artifacts/build-info/comet.json",
    sourceName: "contracts/Comet.sol",
    contractName: "Comet"
  });
  const mapped = mapping.resolveBatch({
    records: [result.transient], upstreamExtractorCommitment: input().upstreamExtractorCommitment, now: 1
  });
  assert.deepEqual(mapped.counts, { exact: 1, unknown: 0 });
  const persisted = JSON.stringify(result.persistable);
  for (const forbidden of [REPOSITORY, input().pinnedCommit, input().manifestPath,
    result.transient.parsedMapping.buildInfoPath, "contracts/Comet.sol", "Comet",
    input().manifest.address, input().manifest.documentation, input().manifest.sourceCode]) {
    assert.equal(persisted.includes(forbidden), false);
  }
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.persistable), true);
});

test("unknown and unregistered repositories fail closed with finite reasons", () => {
  const registry = adapters.createRegistry();
  const unknown = registry.dispatch(input({ repositoryId: "unknown/project" }));
  const unregistered = registry.dispatch(input({ repositoryId: "curvefi/curve-core" }));
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.reason, "UNKNOWN_REPOSITORY");
  assert.equal(unregistered.reason, "ADAPTER_NOT_REGISTERED");
  assert.equal(adapters.validateResult(unknown), true);
  assert.equal(adapters.validateResult(unregistered), true);
});

test("Aave address-book adapter accepts only the exact Ink projection and keeps build authority unknown", () => {
  const targets = aaveAddressBook.CORE_TARGETS.map((descriptor, index) => ({
    role: descriptor.role,
    address: `0x${(index + 1).toString(16).repeat(40)}`
  })).sort((left, right) => left.role.localeCompare(right.role));
  const manifest = {
    schema: aaveAddressBook.SOURCE_SCHEMA,
    chainId: aaveAddressBook.CHAIN_ID,
    targets
  };
  assert.equal(aaveAddressBook.validProjection(manifest), true);
  const exactIdentity = adapters.dispatch(input({
    repositoryId: aaveAddressBook.REPOSITORY_ID,
    manifestPath: aaveAddressBook.SOLIDITY_PATH,
    manifest
  }));
  assert.equal(exactIdentity.status, "UNKNOWN");
  assert.equal(exactIdentity.reason, aaveAddressBook.BUILD_METADATA_ABSENT);
  assert.equal(exactIdentity.transient, null);
  assert.equal(adapters.validateResult(exactIdentity), true);
  assert.doesNotMatch(JSON.stringify(exactIdentity.persistable), /0x[0-9a-f]{40}|AaveV3InkWhitelabel/i);

  const wrongPath = adapters.dispatch(input({
    repositoryId: aaveAddressBook.REPOSITORY_ID,
    manifestPath: "src/AaveV3Ink.sol",
    manifest
  }));
  assert.equal(wrongPath.reason, "UNSUPPORTED_MANIFEST");
});

test("newly watched fail-closed adapters report absent metadata and reject unsupported paths", () => {
  adapters.registerOfficialAdapters();
  for (const [repositoryId, metadataPath] of [
    ["basalt-vault/basalt-vault", "deployments/arbitrum/vault.json"],
    ["Enhanced-Finance/contracts", "deployments/mainnet/vault.json"],
    ["vetro-protocol/vetro-contracts", "deployments/ethereum/Gateway.json"],
    ["basedollar/basedollar", "contracts/addresses/1.json"]
  ]) {
    const absent = adapters.dispatch(input({ repositoryId, manifestPath: metadataPath, manifest: {} }));
    assert.equal(absent.status, "UNKNOWN", repositoryId);
    assert.equal(absent.reason, "DEPLOYMENT_METADATA_ABSENT", repositoryId);
    assert.equal(absent.transient, null, repositoryId);
    assert.equal(adapters.validateResult(absent), true, repositoryId);

    const unsupported = adapters.dispatch(input({ repositoryId, manifestPath: "src/NotAPath.sol", manifest: {} }));
    assert.equal(unsupported.reason, "UNSUPPORTED_MANIFEST", repositoryId);
  }
});

test("malformed, ambiguous, leaky, asynchronous, and throwing outputs fail closed", () => {
  const fixtures = [
    [() => ({ status: "EXACT", mappings: [] }), "ADAPTER_OUTPUT_AMBIGUOUS"],
    [() => ({ status: "EXACT", mappings: [
      { buildInfoPath: "build-info/one.json", sourceName: null, contractName: null },
      { buildInfoPath: "build-info/two.json", sourceName: null, contractName: null }
    ] }), "ADAPTER_OUTPUT_AMBIGUOUS"],
    [() => ({ status: "EXACT", mappings: [{ buildInfoPath: "https://bad.invalid/build.json", sourceName: null, contractName: null }] }), "ADAPTER_OUTPUT_LEAK"],
    [() => ({ status: "EXACT", mappings: [{ buildInfoPath: "build-info/one.json", sourceName: null, contractName: null, address: `0x${"b".repeat(40)}` }] }), "ADAPTER_OUTPUT_LEAK"],
    [async () => ({ status: "UNKNOWN", reason: "MAPPING_MISSING" }), "ADAPTER_OUTPUT_MALFORMED"],
    [() => { throw new Error("fixture"); }, "ADAPTER_EXCEPTION"]
  ];
  for (const [extract, reason] of fixtures) {
    const registry = adapters.createRegistry();
    registry.register(REPOSITORY, extract);
    const result = registry.dispatch(input());
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.reason, reason);
    assert.equal(result.transient, null);
    assert.equal(adapters.validateResult(result), true);
  }
});

test("canonical provenance and normalized mapping commitments are deterministic", () => {
  const first = adapters.createRegistry(), second = adapters.createRegistry();
  first.register(REPOSITORY, validExtract);
  second.register(REPOSITORY, () => ({ mappings: [{ contractName: "Comet", sourceName: "contracts/Comet.sol", buildInfoPath: "artifacts/build-info/comet.json" }], status: "EXACT" }));
  const a = first.dispatch(input({ manifest: { z: [3, 2, 1], a: { value: true } } }));
  const b = second.dispatch(input({ manifest: { a: { value: true }, z: [3, 2, 1] } }));
  assert.deepEqual(a.persistable, b.persistable);
  assert.deepEqual(a.transient, b.transient);
});

test("manifest depth, rows, and adapter mapping caps are bounded", () => {
  const registry = adapters.createRegistry();
  registry.register(REPOSITORY, validExtract);
  let deep = {};
  for (let index = 0; index < 70; index += 1) deep = { child: deep };
  assert.equal(registry.dispatch(input({ manifest: deep })).reason, "INPUT_CAP_EXCEEDED");
  assert.equal(registry.dispatch(input({ manifest: new Array(4_097).fill(null) })).reason, "INPUT_CAP_EXCEEDED");
  const sparse = [];
  sparse.length = 4_097;
  assert.equal(registry.dispatch(input({ manifest: sparse })).reason, "INPUT_CAP_EXCEEDED");

  const capped = adapters.createRegistry();
  capped.register(REPOSITORY, () => ({ status: "EXACT", mappings: new Array(17).fill(null).map((_, index) => ({
    buildInfoPath: `build-info/${index}.json`, sourceName: null, contractName: null
  })) }));
  assert.equal(capped.dispatch(input()).reason, "ADAPTER_CAP_EXCEEDED");
});

test("non-JSON manifest members and hidden adapter output fields are rejected", () => {
  const registry = adapters.createRegistry();
  registry.register(REPOSITORY, validExtract);
  const sparse = [];
  sparse.length = 2;
  sparse[1] = null;
  assert.equal(registry.dispatch(input({ manifest: sparse })).reason, "INPUT_MALFORMED");

  const leaky = adapters.createRegistry();
  leaky.register(REPOSITORY, () => {
    const output = { status: "EXACT", mappings: [{
      buildInfoPath: "build-info/one.json", sourceName: null, contractName: null
    }] };
    Object.defineProperty(output, "provider", { value: "hidden", enumerable: false });
    return output;
  });
  assert.equal(leaky.dispatch(input()).reason, "ADAPTER_OUTPUT_MALFORMED");
});

test("registration is strict, immutable, and rejects duplicates", () => {
  const registry = adapters.createRegistry();
  const descriptor = registry.register(REPOSITORY, validExtract);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.extract), true);
  assert.throws(() => { descriptor.repositoryId = "curvefi/curve-core"; }, TypeError);
  assert.throws(() => registry.register(REPOSITORY, validExtract),
    (error) => error instanceof adapters.AdapterError && error.code === "ADAPTER_DUPLICATE");
  assert.throws(() => registry.register("unknown/project", validExtract),
    (error) => error instanceof adapters.AdapterError && error.code === "REPOSITORY_NOT_ALLOWED");
  assert.throws(() => registry.register("curvefi/curve-core", null),
    (error) => error instanceof adapters.AdapterError && error.code === "ADAPTER_INVALID");
});

test("registry and capability declarations are exact and deny side effects", () => {
  assert.deepEqual(adapters.ALLOWED_REPOSITORIES, [
    "compound-finance/comet",
    "pendle-finance/pendle-core-v2-public",
    "Instadapp/fluid-contracts-public",
    "curvefi/curve-core",
    "aave-dao/aave-address-book",
    "basalt-vault/basalt-vault",
    "Enhanced-Finance/contracts",
    "vetro-protocol/vetro-contracts",
    "basedollar/basedollar"
  ]);
  assert.deepEqual(adapters.CAPABILITIES, {
    network: false, filesystem: false, processExecution: false, rpc: false, fork: false,
    signing: false, transactions: false
  });
  assert.equal(Object.isFrozen(adapters.ALLOWED_REPOSITORIES), true);
  assert.equal(Object.isFrozen(adapters.CAPABILITIES), true);
});
