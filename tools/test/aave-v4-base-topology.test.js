"use strict";

// Synthetic, injected topology collection only: no captures, inventory or network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface } = require("ethers");
const topology = require("../scan-aave-v4-hubs");
const { validateAaveSourceCoverageEnvelope } = require("../aave-source-coverage");

const NOW = Date.parse("2026-10-18T00:00:00Z");
const HUB = "0x" + "11".repeat(20);
const TOKEN = "0x" + "22".repeat(20);
const SPOKE = "0x" + "33".repeat(20);
const NON_RESERVE = "0x" + "44".repeat(20);
const COMMIT = "ab".repeat(20);
const ABI = new Interface([
  "function getAssetCount() view returns (uint256)",
  "function getAssetUnderlyingAndDecimals(uint256) view returns (address,uint8)",
]);

function baseRegistry(extra = {}) {
  return {
    chainId: 8453,
    registryId: "aave-dao/aave-address-book/AaveV4Base",
    version: "v4.74.1",
    commit: COMMIT,
    source: `https://raw.githubusercontent.com/aave-dao/aave-address-book/${COMMIT}/src/AaveV4Base.ts`,
    pinBlock: 100,
    hubs: [{ key: "EQUITIES_HUB", name: "EQUITIES_HUB", address: HUB }],
    ...extra,
  };
}

function fixture(extra = {}) {
  const calls = { opened: 0, provider: 0, scanned: [], prices: [], confirmed: 0 };
  const context = {
    chainId: 8453,
    pin: { number: 100, hash: "0x" + "01".repeat(32), stateRoot: "0x" + "02".repeat(32), timestamp: NOW / 1000 },
    provider: {
      call: async ({ data }) => {
        calls.provider += 1;
        const decoded = ABI.parseTransaction({ data });
        return ABI.encodeFunctionResult(decoded.name, decoded.name === "getAssetCount" ? [1] : [TOKEN, 18]);
      },
    },
    confirmPin: async () => { calls.confirmed += 1; },
    observationPin: coverage => {
      assert.equal(calls.confirmed, 1);
      return {
        schema: "aave-v4-state-pin/v1", chainId: context.chainId || 1, finality: "finalized",
        blockNumber: 100, blockHash: context.pin.hash,
        terminalBlockNumber: 100, terminalBlockHash: context.pin.hash,
        stateReadsPinned: coverage.stateReadsAttempted,
      };
    },
    statistics: () => ({ networkCalls: 0 }),
  };
  const dependencies = {
    chainId: 8453, registryExtract: baseRegistry(), now: () => NOW,
    openCollection: async options => { calls.opened += 1; calls.options = options; return context; },
    fetchPrices: async addresses => { calls.prices.push(addresses); return { [TOKEN]: 2 }; },
    scanHub: async (provider, hub, prices) => {
      assert.equal(provider, context.provider);
      calls.scanned.push(hub);
      calls.hubPrices = prices;
      const price = prices[TOKEN] ?? null;
      return {
        ...hub, sourceVerified: false, assetCountReadOk: true, assetCount: 1, assetScanTruncated: false,
        assets: [{
          assetId: 0, underlying: TOKEN, priceUsd: price, cashUsd: price, totalOwedUsd: price,
          reviewCandidate: false, watchCandidate: false, routePositive: false,
          spokeDirectory: { count: 2, error: null, truncated: false, rows: [
            {
              address: SPOKE, listed: true, listedError: null, config: { error: null },
              reserve: {
                reserveId: 7, reserveIdError: null, errors: {},
                reserve: { hub: hub.address, assetId: "0", underlying: TOKEN },
                oracleData: { spoke: SPOKE, errors: {} },
              },
            },
            { address: NON_RESERVE, reserve: { reserveBearing: false, reserveId: null, reserveIdError: "call-reverted" } },
          ] },
        }],
        totals: { cashUsd: price || 0, totalOwedUsd: price || 0, reviewCandidates: 0, watchCandidates: 0, routePositive: 0 },
      };
    },
    ...extra,
  };
  return { dependencies, context, calls };
}

test("explicit Base registry is normalized without requiring or inventing GLOBAL_DOLLAR", () => {
  const extract = baseRegistry();
  assert.equal(topology.validateRegistryExtract(extract, { chainId: 8453 }), null);
  const registry = topology.loadAaveV4Registry({ chainId: 8453, registryExtract: extract });
  assert.equal(registry.bound, true);
  assert.equal(registry.hubsDeclared, 1);
  assert.equal(registry.hubs[0].key, "EQUITIES_HUB");
  assert.equal(registry.pinBlock, "0x64");
  assert.equal(registry.inventoryDigest, topology.registryInventoryDigest(extract));
});

test("Base collects only its selected hub, emits Base provenance and retains observational gates", async () => {
  const f = fixture({ collectionOptions: { chainId: 8453, fixtureOption: true } });
  const result = await topology.collectTopology(f.dependencies);
  assert.equal(f.calls.opened, 1);
  assert.equal(f.calls.options.chainId, 8453);
  assert.equal(f.calls.options.fixtureOption, true);
  assert.equal(f.calls.options.probeAddress, HUB);
  assert.deepEqual(f.calls.scanned.map(hub => hub.key), ["EQUITIES_HUB"]);
  assert.deepEqual(f.calls.prices, [[TOKEN]]);
  assert.equal(f.calls.confirmed, 1);
  assert.equal(result.chain.id, 8453);
  assert.equal(result.chain.name, "Base");
  assert.equal(result.chain.blockNumber, 100);
  assert.match(result.scope, /Base/);
  assert.doesNotMatch(result.scope, /Ethereum|DefiLlama/i);
  assert.deepEqual(result.sources, [baseRegistry().source]);
  assert.doesNotMatch(JSON.stringify(result.sources), /ethereum|llama/i);
  assert.equal(result.declaredTopology.commit, COMMIT);
  assert.equal(result.declaredTopology.pinBlock, "0x64");
  assert.equal(result.summary.hubsScanned, 1);
  assert.equal(result.summary.unverifiedHubs, 1);
  assert.equal(result.hubs[0].sourceVerified, false);
  assert.equal(result.hubs[0].assets[0].priceUsd, 2);
  const coverage = result.sourceCoverage;
  assert.equal(coverage.hubsExpected, 1);
  assert.equal(coverage.sampleComplete, false);
  assert.equal(coverage.classification, "SOURCE_INCOMPLETE");
  assert.ok(coverage.errors.includes("reserve-state-read-failed"));
  assert.ok(coverage.errors.includes("required-spoke-failed"));
  assert.equal(coverage.complete, false);
  assert.equal(coverage.fullHistoryProven, false);
  assert.equal(coverage.exhaustiveProof, null);
  assert.equal(coverage.promotionEligible, false);
  assert.equal(coverage.observationPin.chainId, 8453);
  assert.equal(result.safety.routePositive, false);
  assert.equal(result.summary.signedActionJustified, false);
  assert.deepEqual(result.positiveRoutes, []);
});

test("Base rejects an unproven non-reserve exclusion while retaining accounting and per-hub caps", async () => {
  const f = fixture();
  const { sourceCoverage: coverage } = await topology.collectTopology(f.dependencies);
  assert.equal(coverage.nonReserveSpokesExcluded, 0);
  assert.equal(coverage.sampleComplete, false);
  assert.equal(coverage.classification, "SOURCE_INCOMPLETE");
  assert.equal(coverage.reserveLinksDeclared, 2);
  assert.equal(coverage.reserveLinksExpected, 2);
  assert.equal(coverage.reserveLinksObserved, 1);
  assert.equal(coverage.reserveLinksConsumed, 1);
  assert.equal(coverage.stateReadsAttempted, 5);
  assert.equal(coverage.stateReadsSucceeded, 4);
  assert.equal(coverage.stateReadsFailed, 1);
  assert.ok(coverage.errors.includes("reserve-state-read-failed"));
  assert.ok(coverage.errors.includes("required-spoke-failed"));
  assert.deepEqual(coverage.consumedReserveLinks, [{ hubAddress: HUB, assetId: 0, spoke: SPOKE, reserveId: 7 }]);
  const ethereumCoverage = topology.buildTopologySourceCoverage([], topology.loadAaveV4EthereumRegistry());
  assert.equal(coverage.topologyCaps.assetsPerHub, ethereumCoverage.topologyCaps.assetsPerHub);
  assert.equal(coverage.topologyCaps.spokesPerAsset, ethereumCoverage.topologyCaps.spokesPerAsset);
  assert.equal(coverage.reserveLinksCap * 4, ethereumCoverage.reserveLinksCap);
});

test("Base preserves required-read errors and truncation rather than elevating completeness", async () => {
  const f = fixture();
  const scan = f.dependencies.scanHub;
  f.dependencies.scanHub = async (...args) => {
    const hub = await scan(...args);
    hub.assetScanTruncated = true;
    hub.assets[0].spokeDirectory.rows[0].reserve.errors = { debt: "provider-call-failed" };
    return hub;
  };
  const { sourceCoverage: coverage } = await topology.collectTopology(f.dependencies);
  assert.equal(coverage.sampleComplete, false);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.classification, "SOURCE_INCOMPLETE");
  assert.equal(coverage.reserveLinksConsumed, 0);
  assert.equal(coverage.wasTruncated, true);
  assert.ok(coverage.errors.includes("topology-truncated"));
  assert.ok(coverage.errors.includes("reserve-state-read-failed"));
});

test("Base missing or wrong-chain extracts fail before opening collection", async () => {
  for (const extract of [undefined, null, baseRegistry({ chainId: 1 }), baseRegistry({ chainId: undefined }), topology.AAVE_V4_ETHEREUM_REGISTRY]) {
    const f = fixture({ registryExtract: extract });
    await assert.rejects(topology.collectTopology(f.dependencies), /topology-registry-invalid/);
    assert.equal(f.calls.opened, 0);
  }
  const f = fixture();
  delete f.dependencies.registryExtract;
  await assert.rejects(topology.collectTopology(f.dependencies), /topology-registry-invalid/);
  assert.equal(f.calls.opened, 0);
});

test("Base missing EQUITIES_HUB or pretending GLOBAL_DOLLAR fails before collection", async () => {
  for (const hubs of [[], [{ key: "CORE", name: "Core", address: HUB }], [
    { key: "EQUITIES_HUB", name: "EQUITIES_HUB", address: HUB },
    { key: "GLOBAL_DOLLAR", name: "Global Dollar", address: SPOKE },
  ]]) {
    const f = fixture({ registryExtract: baseRegistry({ hubs }) });
    await assert.rejects(topology.collectTopology(f.dependencies), /topology-registry-invalid/);
    assert.equal(f.calls.opened, 0);
  }
});

test("unsupported selected chains and conflicting collection options fail before opening", async () => {
  for (const chainId of [0, 10, 42161, "8453", null, undefined]) {
    const f = fixture({ chainId });
    await assert.rejects(topology.collectTopology(f.dependencies), /topology-chain-unsupported/);
    assert.equal(f.calls.opened, 0);
  }
  for (const [chainId, optionChain] of [[8453, 1], [1, 8453], [8453, "8453"], [8453, undefined]]) {
    const f = fixture({ chainId, collectionOptions: { chainId: optionChain } });
    await assert.rejects(topology.collectTopology(f.dependencies), /topology-collection-chain-mismatch/);
    assert.equal(f.calls.opened, 0);
  }
});

test("Base requires an explicit matching context chain before any state or price reads", async () => {
  for (const chainId of [undefined, 1, "8453", 10]) {
    const f = fixture();
    f.context.chainId = chainId;
    await assert.rejects(topology.collectTopology(f.dependencies), /topology-context-chain-mismatch/);
    assert.equal(f.calls.opened, 1);
    assert.equal(f.calls.provider, 0);
    assert.deepEqual(f.calls.prices, []);
    assert.deepEqual(f.calls.scanned, []);
  }
});

test("Base registry pin must be the admission context pin, not a registry deployment block", async () => {
  for (const pinBlock of [99, "0x63"]) {
    const f = fixture({ registryExtract: baseRegistry({ pinBlock }) });
    await assert.rejects(topology.collectTopology(f.dependencies), /topology-registry-pin-mismatch/);
    assert.equal(f.calls.provider, 0);
  }
  for (const pinBlock of [0, -1, "", "not-a-block"]) {
    const f = fixture({ registryExtract: baseRegistry({ pinBlock }) });
    await assert.rejects(topology.collectTopology(f.dependencies), /topology-registry-invalid:pin-block-invalid/);
    assert.equal(f.calls.opened, 0);
  }
});

test("Base without injected prices is unpriced and never calls Ethereum public pricing", async t => {
  let fetched = 0;
  t.mock.method(globalThis, "fetch", async () => { fetched += 1; assert.fail("no external pricing for Base"); });
  const f = fixture();
  delete f.dependencies.fetchPrices;
  const result = await topology.collectTopology(f.dependencies);
  assert.equal(fetched, 0);
  assert.deepEqual(f.calls.hubPrices, {});
  assert.equal(result.hubs[0].assets[0].priceUsd, null);
  assert.equal(result.hubs[0].assets[0].cashUsd, null);
  assert.equal(result.summary.routePositive, 0);
});

test("legacy Ethereum registry fallback and GLOBAL_DOLLAR requirement stay unchanged", async () => {
  const registry = topology.loadAaveV4EthereumRegistry();
  assert.equal(registry.bound, true);
  assert.equal(registry.hubsDeclared, 4);
  assert.equal(registry.hubs.at(-1).key, "GLOBAL_DOLLAR");
  assert.deepEqual(topology.loadAaveV4Registry(), registry);
  const extract = { ...topology.AAVE_V4_ETHEREUM_REGISTRY, hubs: topology.AAVE_V4_ETHEREUM_REGISTRY.hubs.slice(0, 3) };
  assert.equal(topology.validateRegistryExtract(extract), "global-dollar-hub-missing");
  const fallback = topology.loadAaveV4EthereumRegistry({ registryExtract: extract });
  assert.equal(fallback.bound, false);
  assert.equal(fallback.failureReason, "registry-extract-invalid:global-dollar-hub-missing");
  assert.deepEqual(fallback.hubs, registry.hubs);
  assert.equal(fallback.registry, null);
  assert.equal(fallback.inventoryDigest, null);
  const f = fixture({ registryExtract: extract });
  delete f.dependencies.chainId;
  await assert.rejects(topology.collectTopology(f.dependencies), /topology-registry-unbound/);
  assert.equal(f.calls.opened, 0);
  assert.equal(topology.loadAaveV4EthereumRegistry({ registryExtract: baseRegistry() }).bound, false);
});

test("default Ethereum output and public price namespace retain legacy behavior with untagged contexts", async t => {
  const fetched = [];
  t.mock.method(globalThis, "fetch", async url => {
    fetched.push(url);
    return { ok: true, json: async () => ({ coins: { [`ethereum:${TOKEN}`]: { price: 3 } } }) };
  });
  const f = fixture();
  delete f.dependencies.chainId;
  delete f.dependencies.registryExtract;
  delete f.dependencies.fetchPrices;
  delete f.context.chainId;
  const result = await topology.collectTopology(f.dependencies);
  assert.equal(f.calls.options.chainId, 1);
  assert.equal(f.calls.scanned.length, 4);
  assert.deepEqual(fetched, [`https://coins.llama.fi/prices/current/ethereum:${TOKEN}`]);
  assert.equal(result.chain.id, 1);
  assert.equal(result.chain.name, "Ethereum");
  assert.equal(result.hubs[0].assets[0].priceUsd, 3);
  assert.equal(result.scope, "Aave V4 public DefiLlama hub mapping and read-only route gate");
  assert.equal(result.sources[0], "https://api.llama.fi/protocol/aave-v4");
  assert.equal(validateAaveSourceCoverageEnvelope(result.sourceCoverage, { protocolVersion: "V4", coverageKind: "topology" }).valid, true);
});

test("Ethereum also rejects an explicitly wrong-chain context", async () => {
  const f = fixture({ chainId: 1, registryExtract: topology.AAVE_V4_ETHEREUM_REGISTRY });
  await assert.rejects(topology.collectTopology(f.dependencies), /topology-context-chain-mismatch/);
  assert.equal(f.calls.provider, 0);
});
