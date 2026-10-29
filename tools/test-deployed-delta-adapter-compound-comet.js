#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const framework = require("./deployed-delta-adapters/index.js");
const adapter = require("./deployed-delta-adapters/compound-comet.js");

const hash = (character) => character.repeat(64);
const ADDRESSES = Object.freeze({
  comet: `0x${"a".repeat(40)}`,
  token: `0x${"b".repeat(40)}`,
  feed: `0x${"c".repeat(40)}`,
  guardian: `0x${"d".repeat(40)}`,
  asset: `0x${"e".repeat(40)}`,
  assetFeed: `0x${"f".repeat(40)}`
});

function baseInput(manifestPath, manifest) {
  return {
    repositoryId: adapter.REPOSITORY_ID,
    pinnedCommit: "1".repeat(40),
    manifestPath,
    manifestBlobCommitment: hash("2"),
    declarationCommitment: hash("3"),
    upstreamExtractorCommitment: hash("4"),
    upstreamRecordCommitment: hash("5"),
    manifest
  };
}

function configuration(mapping = {}) {
  return {
    name: "Compound USDC",
    symbol: "cUSDCv3",
    baseToken: "USDC",
    baseTokenAddress: ADDRESSES.token,
    baseTokenPriceFeed: ADDRESSES.feed,
    borrowMin: "1e6",
    pauseGuardian: ADDRESSES.guardian,
    storeFrontPriceFactor: 0.5,
    targetReserves: "5000000e6",
    rates: {
      supplyKink: 0.8, supplySlopeLow: 0.03, supplySlopeHigh: 0.4, supplyBase: 0,
      borrowKink: 0.8, borrowSlopeLow: 0.04, borrowSlopeHigh: 0.25, borrowBase: 0.01
    },
    tracking: {
      indexScale: "1e15", baseSupplySpeed: "0e15", baseBorrowSpeed: "0e15", baseMinForRewards: "1e6"
    },
    assets: {
      WETH: {
        address: ADDRESSES.asset,
        priceFeed: ADDRESSES.assetFeed,
        decimals: "18",
        borrowCF: 0.8,
        liquidateCF: 0.85,
        liquidationFactor: 0.95,
        supplyCap: "1000e18"
      }
    },
    ...mapping
  };
}

function roots(mapping = {}) {
  return { comet: ADDRESSES.comet, configurator: ADDRESSES.guardian, ...mapping };
}

test("explicit source-owned build-info mappings are exact for configuration and roots material", () => {
  const fixtures = [
    ["deployments/mainnet/usdc/configuration.json", configuration({
      buildInfoPath: "artifacts/build-info/comet.json",
      sourceName: "contracts/Comet.sol",
      contractName: "Comet"
    })],
    ["deployments/base/usdc/roots.json", roots({
      build_info: "build-info/comet-roots.json",
      sourceName: "contracts/Comet.sol",
      contractName: "Comet"
    })]
  ];
  for (const [manifestPath, manifest] of fixtures) {
    const result = framework.dispatch(baseInput(manifestPath, manifest));
    assert.equal(result.status, "EXACT");
    assert.equal(result.reason, "EXACT");
    assert.equal(framework.validateResult(result), true);
    assert.deepEqual(result.transient.parsedMapping, {
      buildInfoPath: manifest.buildInfoPath || manifest.build_info,
      sourceName: "contracts/Comet.sol",
      contractName: "Comet"
    });
  }
});

test("configuration and roots shapes cannot be substituted for each other", () => {
  const mismatches = [
    ["deployments/mainnet/usdc/roots.json", configuration({ buildInfoPath: "build-info/comet.json" })],
    ["deployments/mainnet/usdc/configuration.json", roots({ buildInfoPath: "build-info/comet.json" })]
  ];
  for (const [manifestPath, manifest] of mismatches) {
    const result = framework.dispatch(baseInput(manifestPath, manifest));
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.reason, "UNSUPPORTED_MANIFEST");
    assert.equal(result.transient, null);
  }
});

test("raw addresses and configuration material never escape the framework projection", () => {
  const manifest = configuration({
    buildInfo: "artifacts/build-info/comet.json",
    sourceName: "contracts/Comet.sol",
    contractName: "Comet"
  });
  const result = framework.dispatch(baseInput("deployments/mainnet/usdc/configuration.json", manifest));
  const persisted = JSON.stringify(result.persistable);
  const completeResult = JSON.stringify(result);
  for (const raw of [...Object.values(ADDRESSES), manifest.name, manifest.symbol, manifest.borrowMin]) {
    assert.equal(persisted.includes(raw), false);
    assert.equal(completeResult.includes(raw), false);
  }
  assert.equal(persisted.includes(result.transient.parsedMapping.buildInfoPath), false);
  assert.deepEqual(Object.keys(result.persistable).sort(), [
    "adapterCommitment", "declarationCommitment", "manifestBlobCommitment", "manifestPathCommitment",
    "normalizedMappingCommitment", "pinnedCommitCommitment", "reason", "repositoryCommitment",
    "status", "upstreamExtractorCommitment", "upstreamRecordCommitment"
  ]);
});

test("malformed paths, absent mappings, and unsupported relations fail closed", () => {
  const malformed = framework.dispatch(baseInput("deployments/mainnet/usdc/configuration.json",
    configuration({ buildInfoPath: "artifacts/build-info/../comet.json" })));
  const missing = framework.dispatch(baseInput("deployments/mainnet/usdc/roots.json", roots()));
  const relations = framework.dispatch(baseInput("deployments/mainnet/usdc/relations.ts",
    roots({ buildInfoPath: "build-info/comet.json" })));
  assert.deepEqual([malformed.status, malformed.reason], ["UNKNOWN", "MAPPING_MALFORMED"]);
  assert.deepEqual([missing.status, missing.reason], ["UNKNOWN", "MAPPING_MISSING"]);
  assert.deepEqual([relations.status, relations.reason], ["UNKNOWN", "UNSUPPORTED_MANIFEST"]);
  assert.equal(malformed.transient, null);
  assert.equal(missing.transient, null);
  assert.equal(relations.transient, null);
});

test("the pure parser is deterministic across source key order", () => {
  const firstManifest = configuration({
    buildInfoPath: "artifacts/build-info/comet.json",
    sourceName: "contracts/Comet.sol",
    contractName: "Comet"
  });
  const secondManifest = Object.fromEntries(Object.entries(firstManifest).reverse());
  secondManifest.rates = Object.fromEntries(Object.entries(secondManifest.rates).reverse());
  secondManifest.tracking = Object.fromEntries(Object.entries(secondManifest.tracking).reverse());
  secondManifest.assets = { WETH: Object.fromEntries(Object.entries(secondManifest.assets.WETH).reverse()) };
  const path = "deployments/mainnet/usdc/configuration.json";
  const first = framework.dispatch(baseInput(path, firstManifest));
  const second = framework.dispatch(baseInput(path, secondManifest));
  assert.deepEqual(first, second);
  assert.equal(framework.validateResult(first), true);
});
