#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AAVE_V4_ETHEREUM_REGISTRY,
  buildTopologySourceCoverage,
  buildTopologyUniverse,
  loadAaveV4EthereumRegistry,
  registryInventoryDigest,
  validateRegistryExtract,
} = require("./scan-aave-v4-hubs");
const { validateAaveSourceCoverageEnvelope } = require("./aave-source-coverage");

const GLOBAL_DOLLAR_HUB = "0x62d63197660c080236193CA60b70E49A08E90368";

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("vendored registry binds the versioned Ethereum topology with four hubs", () => {
  const registry = loadAaveV4EthereumRegistry();
  assert.equal(registry.bound, true);
  assert.equal(registry.registry, "aave-dao/aave-address-book");
  assert.equal(registry.version, "v4.68.2");
  assert.match(registry.commit, /^[0-9a-f]{40}$/);
  assert.equal(registry.commit, AAVE_V4_ETHEREUM_REGISTRY.commit);
  assert.equal(registry.pinBlock, "0x18cfd59");
  assert.equal(registry.failureReason, null);
  assert.equal(registry.hubsDeclared, 4);
  assert.equal(registry.hubs.length, 4);
  const keys = registry.hubs.map((hub) => hub.key);
  assert.deepEqual(keys, ["CORE", "PLUS", "PRIME", "GLOBAL_DOLLAR"]);
  const globalDollar = registry.hubs.find((hub) => hub.key === "GLOBAL_DOLLAR");
  assert.ok(globalDollar);
  assert.equal(globalDollar.address, "0x62d63197660c080236193CA60b70E49A08E90368");
  assert.match(registry.inventoryDigest, /^[0-9a-f]{64}$/);
});

test("registry validation rejects an extract that omits the GLOBAL_DOLLAR hub", () => {
  const withoutGlobalDollar = deepClone(AAVE_V4_ETHEREUM_REGISTRY);
  withoutGlobalDollar.hubs = withoutGlobalDollar.hubs.filter((hub) => hub.key !== "GLOBAL_DOLLAR");
  assert.equal(validateRegistryExtract(withoutGlobalDollar), "global-dollar-hub-missing");
  const registry = loadAaveV4EthereumRegistry({ registryExtract: withoutGlobalDollar });
  assert.equal(registry.bound, false);
  assert.equal(registry.registry, null);
  assert.equal(registry.version, null);
  assert.match(registry.failureReason, /^registry-extract-invalid:global-dollar-hub-missing$/);
  // Fail closed on the binding, but the declared pinned hubs are still what the
  // observational scan enumerates.
  assert.equal(registry.hubs.length, 4);
  assert.ok(registry.hubs.some((hub) => hub.address === GLOBAL_DOLLAR_HUB));
});

test("registry validation rejects malformed version, commit, and non-object extracts", () => {
  const badVersion = deepClone(AAVE_V4_ETHEREUM_REGISTRY);
  badVersion.version = "4.68.2";
  assert.equal(validateRegistryExtract(badVersion), "version-invalid");

  const badCommit = deepClone(AAVE_V4_ETHEREUM_REGISTRY);
  badCommit.commit = "not-a-commit";
  assert.equal(validateRegistryExtract(badCommit), "commit-invalid");

  assert.equal(validateRegistryExtract(null), "not-an-object");
  assert.equal(validateRegistryExtract([]), "not-an-object");
  assert.equal(validateRegistryExtract({}), "registry-id-missing");
});

test("loadAaveV4EthereumRegistry fails closed with an explicit reason for any invalid extract", () => {
  const registry = loadAaveV4EthereumRegistry({ registryExtract: {} });
  assert.equal(registry.bound, false);
  assert.equal(registry.registry, null);
  assert.equal(registry.version, null);
  assert.equal(registry.inventoryDigest, null);
  assert.match(registry.failureReason, /^registry-extract-invalid:/);
  assert.equal(registry.hubs.length, 4);
});

test("buildTopologyUniverse binds registry and version only when the registry bound", () => {
  const bound = loadAaveV4EthereumRegistry();
  const universe = buildTopologyUniverse(bound, bound.hubsDeclared);
  assert.equal(universe.type, "DECLARED_STATIC_HUB_SET");
  assert.equal(universe.bound, true);
  assert.equal(universe.registry, "aave-dao/aave-address-book");
  assert.equal(universe.version, "v4.68.2");
  assert.equal(universe.hubsDeclared, 4);
  assert.equal(universe.failureReason, null);

  const unbound = loadAaveV4EthereumRegistry({ registryExtract: {} });
  const unboundUniverse = buildTopologyUniverse(unbound, unbound.hubsDeclared);
  assert.equal(unboundUniverse.bound, false);
  assert.equal(unboundUniverse.registry, null);
  assert.equal(unboundUniverse.version, null);
  assert.match(unboundUniverse.failureReason, /^registry-extract-invalid:/);
});

test("buildTopologySourceCoverage surfaces a bound topology universe on success", () => {
  const registry = loadAaveV4EthereumRegistry();
  const coverage = buildTopologySourceCoverage([], registry);
  assert.equal(coverage.topologyUniverse.bound, true);
  assert.equal(coverage.topologyUniverse.registry, "aave-dao/aave-address-book");
  assert.equal(coverage.topologyUniverse.version, "v4.68.2");
  assert.equal(coverage.topologyUniverse.hubsDeclared, 4);
  assert.equal(coverage.topologyUniverse.failureReason, null);
  assert.match(coverage.blocker, /bound to aave-dao\/aave-address-book@v4\.68\.2/);
  assert.equal(coverage.hubsExpected, 4);
  const envelope = validateAaveSourceCoverageEnvelope(coverage, { protocolVersion: "V4", coverageKind: "topology" });
  assert.deepEqual(envelope.failures, []);
  assert.equal(envelope.valid, true);
});

test("buildTopologySourceCoverage fails closed with a reason when the registry cannot bind", () => {
  const registry = loadAaveV4EthereumRegistry({ registryExtract: {} });
  const coverage = buildTopologySourceCoverage([], registry);
  assert.equal(coverage.topologyUniverse.bound, false);
  assert.equal(coverage.topologyUniverse.registry, null);
  assert.equal(coverage.topologyUniverse.version, null);
  assert.match(coverage.topologyUniverse.failureReason, /^registry-extract-invalid:/);
  assert.match(coverage.blocker, /declared static hub set/);
  const envelope = validateAaveSourceCoverageEnvelope(coverage, { protocolVersion: "V4", coverageKind: "topology" });
  assert.equal(envelope.valid, true);
});

test("inventory digest is deterministic and sensitive to topology changes", () => {
  const digest = registryInventoryDigest(AAVE_V4_ETHEREUM_REGISTRY);
  assert.equal(digest, registryInventoryDigest(deepClone(AAVE_V4_ETHEREUM_REGISTRY)));
  const mutated = deepClone(AAVE_V4_ETHEREUM_REGISTRY);
  mutated.hubs = mutated.hubs.map((hub) => (hub.key === "PRIME" ? { ...hub, address: "0x0000000000000000000000000000000000000001" } : hub));
  assert.notEqual(digest, registryInventoryDigest(mutated));
});

const FAKE_REGISTRY = {
  bound: true,
  registry: "test/registry",
  version: "v1.0.0",
  commit: "a".repeat(40),
  source: "test.sol",
  pinBlock: "0x1",
  inventoryDigest: "b".repeat(64),
  hubsDeclared: 1,
  failureReason: null,
};

function ledgerHub({ address, reserveBearing, reserveId = 0, reserveIdError = null }) {
  const underlying = "0x00000000000000000000000000000000000000aa";
  const spoke = "0x00000000000000000000000000000000000000bb";
  return {
    name: "Ledger Hub",
    address,
    assetCount: 1,
    assetCountReadOk: true,
    assetScanTruncated: false,
    assets: [{
      assetId: 0,
      underlying,
      status: "ok",
      spokeDirectory: {
        count: 1,
        truncated: false,
        error: null,
        rows: [{
          index: 0,
          address: spoke,
          listed: true,
          listedError: null,
          config: { error: null },
          reserve: reserveBearing === false
            ? { reserveId: null, reserveIdError: "call-reverted", reserveBearing: false, errors: {} }
            : {
              reserveId,
              reserveIdError,
              reserveBearing,
              reserve: { hub: address, assetId: 0, underlying, decimals: 18 },
              oracleData: { spoke, errors: {} },
              errors: {},
            },
          accounting: null,
        }],
      },
    }],
  };
}

test("non-reserve spokes are excluded from the reserve-link ledger", () => {
  const hub = ledgerHub({ address: "0x00000000000000000000000000000000000000cc", reserveBearing: false });
  const coverage = buildTopologySourceCoverage([hub], FAKE_REGISTRY);
  assert.equal(coverage.sampleComplete, true);
  assert.equal(coverage.nonReserveSpokesExcluded, 1);
  assert.equal(coverage.reserveLinksDeclared, 0);
  assert.equal(coverage.reserveLinksExpected, 0);
  assert.equal(coverage.stateReadsFailed, 0);
  assert.deepEqual(coverage.errors, []);
});

test("reserve-bearing spokes remain fully accounted", () => {
  const hub = ledgerHub({ address: "0x00000000000000000000000000000000000000cc", reserveBearing: true, reserveId: 3 });
  const coverage = buildTopologySourceCoverage([hub], FAKE_REGISTRY);
  assert.equal(coverage.sampleComplete, true);
  assert.equal(coverage.nonReserveSpokesExcluded, 0);
  assert.equal(coverage.reserveLinksExpected, 1);
  assert.equal(coverage.reserveLinksConsumed, 1);
});

test("a genuine reserve read failure is still counted as a failure", () => {
  const hub = ledgerHub({ address: "0x00000000000000000000000000000000000000cc", reserveBearing: null, reserveIdError: "provider-call-failed" });
  const coverage = buildTopologySourceCoverage([hub], FAKE_REGISTRY);
  assert.equal(coverage.sampleComplete, false);
  assert.equal(coverage.nonReserveSpokesExcluded, 0);
  assert.equal(coverage.stateReadsFailed, 1);
  assert.ok(coverage.errors.includes("reserve-state-read-failed"));
});
