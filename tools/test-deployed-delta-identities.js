#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const identities = require("./deployed-delta-identities.js");

const AAVE = identities.AAVE_ADDRESS_BOOK_REPOSITORY;
const CURVE = identities.CURVE_CORE_REPOSITORY;

test("Aave address-book mainnet paths resolve per chain; testnets and unknown paths stay unmapped", () => {
  for (const filePath of [
    "src/AaveV3Ethereum.sol", "src/ts/AaveV3Ethereum.ts",
    "src/AaveV3EthereumEtherFi.sol", "src/ts/AaveV3EthereumEtherFi.ts",
    "src/AaveV3EthereumHorizon.sol", "src/ts/AaveV3EthereumHorizon.ts",
    "src/AaveV3EthereumLido.sol", "src/ts/AaveV3EthereumLido.ts",
    "src/AaveV4Ethereum.sol", "src/ts/AaveV4Ethereum.ts",
    "scripts/configs/v4/ethereum.ts"
  ]) assert.equal(identities.chainIdForPath(AAVE, filePath), "1", filePath);
  for (const filePath of ["src/AaveV3Base.sol", "src/ts/AaveV3Base.ts", "src/AaveV4Base.sol", "src/ts/AaveV4Base.ts"]) {
    assert.equal(identities.chainIdForPath(AAVE, filePath), "8453", filePath);
  }
  for (const filePath of ["src/AaveV3XLayer.sol", "src/ts/AaveV3XLayer.ts"]) {
    assert.equal(identities.chainIdForPath(AAVE, filePath), "196", filePath);
  }
  for (const filePath of ["src/AaveV3InkWhitelabel.sol", "src/ts/AaveV3InkWhitelabel.ts"]) {
    assert.equal(identities.chainIdForPath(AAVE, filePath), "57073", filePath);
  }
  // Testnet variants and unverified paths are never resolved.
  assert.equal(identities.chainIdForPath(AAVE, "src/AaveV3BaseSepolia.sol"), null);
  assert.equal(identities.chainIdForPath(AAVE, "src/ts/AaveV3InkSepolia.ts"), null);
  assert.equal(identities.chainIdForPath(AAVE, "scripts/configs/v4/base.ts"), null);
  assert.equal(identities.chainIdForPath(AAVE, "src/AaveV3Ethereum.solx"), null);
  assert.equal(identities.chainIdForPath(AAVE, "deployments/prod/ethereum.yaml"), null);
});

test("curve-core resolves only verified chain-named prod manifests; arc/robinhood stay out of scope", () => {
  assert.equal(identities.chainIdForPath(CURVE, "deployments/prod/avalanche.yaml"), "43114");
  assert.equal(identities.chainIdForPath(CURVE, "deployments/prod/ink.yaml"), "57073");
  assert.equal(identities.chainIdForPath(CURVE, "deployments/prod/x_layer.yaml"), "196");
  for (const filePath of [
    "deployments/prod/arc.yaml", "deployments/prod/robinhood.yaml",
    "deployments/prod/ethereum.yaml", "deployments/prod/base.yaml",
    "deployments/prod/unichain.yaml", "deployments/prod/taiko.yaml"
  ]) assert.equal(identities.chainIdForPath(CURVE, filePath), null, filePath);
});

test("the adapter-exact set stays Ink-only so the extractor never fetches unsupported files", () => {
  assert.equal(identities.exactChainIdForPath(AAVE, "src/AaveV3InkWhitelabel.sol"), "57073");
  assert.equal(identities.exactChainIdForPath(AAVE, "src/ts/AaveV3InkWhitelabel.ts"), "57073");
  assert.equal(identities.exactChainIdForPath(AAVE, "src/AaveV4Ethereum.sol"), null);
  assert.equal(identities.exactChainIdForPath(AAVE, "src/AaveV3Base.sol"), null);
  assert.equal(identities.exactChainIdForPath(CURVE, "deployments/prod/avalanche.yaml"), null);
});

test("chainIdsForPaths is sorted, de-duplicated, and repository/path exact", () => {
  assert.deepEqual(identities.chainIdsForPaths(AAVE, [
    "src/AaveV3XLayer.sol", "src/AaveV4Ethereum.sol", "src/ts/AaveV3Ethereum.ts",
    "src/AaveV3XLayer.sol", "unknown/path.txt"
  ]), ["1", "196"]);
  assert.deepEqual(identities.chainIdsForPaths(AAVE, ["src/AaveV3InkWhitelabel.sol"]), ["57073"]);
  assert.deepEqual(identities.chainIdsForPaths(CURVE, ["deployments/prod/avalanche.yaml", "deployments/prod/ink.yaml"]), ["43114", "57073"]);
  assert.deepEqual(identities.chainIdsForPaths("silo-finance/silo-contracts-v3", ["src/AaveV3Ethereum.sol"]), []);
  assert.deepEqual(identities.chainIdsForPaths(AAVE, "not-an-array"), []);
  assert.deepEqual(identities.chainIdsForPaths(AAVE, []), []);
});

test("newly watched repos resolve only their verified per-chain deployment paths", () => {
  const VETRO = identities.VETRO_REPOSITORY;
  const BASEDOLLAR = identities.BASEDOLLAR_REPOSITORY;
  // VETRO commits per-chain hardhat-deploy directories; only `deployments/ethereum/` is mapped.
  assert.equal(identities.chainIdForPath(VETRO, "deployments/ethereum/Gateway.json"), "1");
  assert.equal(identities.chainIdForPath(VETRO, "deployments/ethereum/.chainId"), "1");
  assert.equal(identities.chainIdForPath(VETRO, "deployments/base/Gateway.json"), null);
  assert.equal(identities.chainIdForPath(VETRO, "src/Gateway.sol"), null);
  // Base Dollar: only the Ethereum mainnet address book is mapped (Sepolia is not watched).
  assert.equal(identities.chainIdForPath(BASEDOLLAR, "contracts/addresses/1.json"), "1");
  assert.equal(identities.chainIdForPath(BASEDOLLAR, "contracts/addresses/11155111.json"), null);
  // Basalt / Enhanced are source-only repos with no honest per-chain path identity.
  assert.equal(identities.chainIdForPath("basalt-vault/basalt-vault", "src/core/VaultCore.sol"), null);
  assert.equal(identities.chainIdForPath("Enhanced-Finance/contracts", "src/core/EnhancedOptions.sol"), null);
  // Resolution remains repository-exact.
  assert.equal(identities.chainIdForPath("silo-finance/silo-contracts-v3", "deployments/ethereum/Gateway.json"), null);
  assert.deepEqual(identities.chainIdsForPaths(VETRO, [
    "deployments/ethereum/Gateway.json", "deployments/ethereum/Treasury.json"
  ]), ["1"]);
});
