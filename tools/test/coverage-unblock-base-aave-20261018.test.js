"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Interface, id, keccak256 } = require("ethers");
const roles = require("../lib/aave-v4-base-role-evidence");
const manifest = require("../aave-v4-base-role-evidence.json");
const topology = require("../scan-aave-v4-hubs");
const admission = require("../admit-aave-v4-base");
const { openPinnedCollection, CollectionError } = require("../lib/aave-v4-pinned-collection");

test.beforeEach(t => t.mock.method(global, "fetch", () => assert.fail("network prohibited")));
const ROOT = path.resolve(__dirname, "../..");
const readPublic = relative => fs.readFileSync(path.join(ROOT, relative));
const capturedInventory = JSON.parse(readPublic("reports/base-aave-v4-admission-20261018/capture4-publicnode-first/code-inventory.json"));
const published = roles.loadPublishedEvidence({ readFile: readPublic });
const fact = role => manifest.roles.find(row => row.role === role);
const HUB = fact("hub").address, TREASURY = fact("treasury").address, TOKENIZATION = fact("tokenization").address, LENDING = fact("lending").address;
const USDC = fact("tokenization").expectedLink.asset;
const STRATEGY = "0x3b0c5fbeff9d32fb6bb706bacc988c88b1871770";
const ZERO = "0x" + "00".repeat(20), WORD = "0x" + "00".repeat(32);
const A = n => "0x" + BigInt(n).toString(16).padStart(40, "0");
const H = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
function bind(overrides = {}) {
  return roles.bindRoleEvidence({ chainId: 8453, registry: { ...manifest.registry }, pin: { ...capturedInventory.pin },
    inventory: structuredClone(capturedInventory), scopeSha256: manifest.scopeSha256, published, ...overrides });
}
const bindings = bind();
const scanOptions = { chainId: 8453, roleBindings: bindings };
const ABI = new Interface([
  "function getSuppliedAssets(address,address) view returns (uint256)",
  "function getSuppliedShares(address,address) view returns (uint256)",
  "function owner() view returns (address)", "function pendingOwner() view returns (address)",
  "function authority() view returns (address)", "function hub() view returns (address)",
  "function HUB() view returns (address)",
  "function assetId() view returns (uint256)", "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)", "function decimals() view returns (uint8)",
  "function getReserveId(address,uint256) view returns (uint256)", "function ORACLE() view returns (address)",
  "function MAX_USER_RESERVES_LIMIT() view returns (uint16)",
  "function getLiquidationConfig() view returns (uint128,uint64,uint16)",
  "function getAssetOwed(uint256) view returns (uint256,uint256)",
  "function getSpokeOwed(uint256,address) view returns (uint256,uint256)",
]);
function typedProvider({ failName, wrongTokenHub = false, wrongStrategyHub = false } = {}) {
  const calls = [];
  return { calls, async call(tx) {
    const decoded = ABI.parseTransaction(tx); calls.push({ to: tx.to.toLowerCase(), name: decoded?.name, args: decoded?.args });
    if (!decoded || decoded.name === failName) throw new CollectionError("CALL_EXCEPTION");
    const values = { getSuppliedAssets: [120n], getSuppliedShares: [90n], owner: [A(1)], pendingOwner: [ZERO],
      authority: [A(2)], hub: [wrongTokenHub ? A(123) : HUB], assetId: [7], asset: [USDC], totalAssets: [130n], decimals: [6],
      HUB: [wrongStrategyHub ? A(123) : HUB],
      ORACLE: [A(3)], MAX_USER_RESERVES_LIMIT: [8], getLiquidationConfig: [1n, 2n, 3],
      getAssetOwed: [2000000n, 3000000n], getSpokeOwed: [4000000n, 7000000n] };
    if (!values[decoded.name]) throw new CollectionError("CALL_EXCEPTION");
    return ABI.encodeFunctionResult(decoded.name, values[decoded.name]);
  }, async getCode() { return "0x6000"; }, async getStorage(at, slot) {
    const row = manifest.roles.find(row => row.address === at.toLowerCase());
    return slot === "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" && row ? "0x" + "0".repeat(24) + row.implementation.slice(2) : WORD;
  } };
}
function coverageFor(rows, options = scanOptions) {
  return topology.buildTopologySourceCoverage([{ address: HUB, assetCountReadOk: true, assetCount: 1, assets: [{
    assetId: 7, underlying: USDC, spokeDirectory: { count: rows.length, rows },
  }] }], { bound: true, hubsDeclared: 1, registry: "aave-dao/aave-address-book", version: "v4.74.1" }, options);
}

test("public HTML deployed panels and Sourcify bytes bind four exact runtime hashes without an attestation", () => {
  assert.equal(admission.sha256(readPublic("tools/aave-v4-base-admission-scope.json")), manifest.scopeSha256);
  assert.equal(published.facts.length, 5);
  assert.equal(published.terminalPinConfirmed, false);
  assert.equal(published.sourceVerificationClaimed, false);
  for (const row of published.facts) {
    if (row.role === "strategy") {
      assert.equal(row.historicalRecoveryOnly, true);
      assert.equal(row.publishedBytesOnly, false);
      assert.equal(row.supportedDispatcherProof.entryPc, 0x284);
      const runtime = readPublic(row.runtime.filePath).toString().trim();
      assert.equal(keccak256(runtime), row.codeKeccak256);
      assert.equal((runtime.length - 2) / 2, 2626);
      assert.deepEqual(row.dispatcherProofs.map(p => p.revertPc), [0xac, 0x7c]);
      assert.throws(() => roles.traceDispatcherRevert(runtime, id("HUB()").slice(0, 10)), /BASE_ROLE_EVIDENCE_INVALID/);
      continue;
    }
    assert.equal(row.publishedBytesOnly, true);
    const bytes = readPublic(row.runtime.filePath);
    const runtime = row.runtime.format === "basescan-deployed-html" ? roles.extractDeployedRuntime(bytes.toString()) : JSON.parse(bytes).runtimeBytecode.onchainBytecode;
    assert.equal(keccak256(runtime), row.implementationCodeKeccak256);
    assert.equal((runtime.length - 2) / 2, row.implementationCodeBytes);
    if (row.role === "treasury") assert.throws(() => roles.traceDispatcherRevert(runtime, id("owner()").slice(0, 10)), /BASE_ROLE_EVIDENCE_INVALID/);
  }
  assert.throws(() => roles.extractDeployedRuntime("<div id='verifiedbytecode2'>0x6000</div>"), /BASE_ROLE_EVIDENCE_INVALID/);
});

test("all 24 wrong-interface patterns replay to actual dispatcher empty reverts without admission or promotion", () => {
  const previous = JSON.parse(readPublic("reports/base-aave-v4-admission-20261018/provisional-revert-selector-map.json"));
  let explained = 0;
  for (const row of previous.rows) {
    const evidence = published.facts.find(f => f.address === row.address);
    const proof = evidence?.dispatcherProofs.find(p => p.selector === row.selector);
    if (proof) {
      assert.equal(proof.count, row.count);
      assert.ok(proof.steps > 20 && proof.revertPc > 0);
      assert.match(proof.pathSha256, /^[0-9a-f]{64}$/);
      explained += row.count;
    } else assert.fail("every provisional pattern must have an actual runtime dispatcher proof");
  }
  assert.equal(explained, 24);
  assert.equal(previous.totalPendingReverts - explained, 0);
  assert.deepEqual(bindings.unresolved, []);
  assert.equal(published.terminalPinConfirmed, false);
});

test("wrong chain, registry/scope identity, current pin, changed proxy pointer and implementation hash fail closed", () => {
  for (const change of [
    { chainId: 1 }, { scopeSha256: "0".repeat(64) }, { registry: { ...manifest.registry, commit: "0".repeat(40) } },
    { published: { ...published } }, { pin: { ...capturedInventory.pin, hash: H(777) } },
  ]) assert.throws(() => bind(change), /BASE_ROLE_BINDING_MISMATCH/);
  for (const [at, key, value] of [[TREASURY, "implementation", LENDING], [fact("treasury").implementation, "codeKeccak256", H(123)],
    [TOKENIZATION, "codeKeccak256", H(123)], [LENDING, "implementationInFrozenScope", false], [STRATEGY, "codeKeccak256", H(123)]]) {
    const inventory = structuredClone(capturedInventory); inventory.rows.find(row => row.address === at)[key] = value;
    assert.throws(() => bind({ inventory }), /BASE_ROLE_BINDING_MISMATCH/);
  }
  const shrunk = structuredClone(capturedInventory); shrunk.rows = shrunk.rows.filter(row => row.address !== STRATEGY);
  assert.throws(() => bind({ inventory: shrunk }), /BASE_ROLE_BINDING_MISMATCH/);
  assert.throws(() => roles.assertBindings(bindings, { chainId: 8453, pin: capturedInventory.pin,
    registry: { ...manifest.registry, version: "v4.74.1", hubs: [{ address: A(123) }] } }), /BASE_ROLE_BINDING_MISMATCH/);
  const evidence = structuredClone(manifest); evidence.roles[0].role = "unreviewed-role";
  assert.throws(() => roles.loadPublishedEvidence({ evidence, readFile: readPublic }), /BASE_ROLE_EVIDENCE_INVALID/);
  assert.throws(() => roles.loadPublishedEvidence({ readFile: () => Buffer.from("tampered") }), /BASE_ROLE_EVIDENCE_INVALID/);
});

test("treasury and tokenization retain typed state plus hub accounting dependencies, never lending/oracle probes", async () => {
  const provider = typedProvider();
  const rows = [];
  for (const at of [TREASURY, TOKENIZATION]) {
    const reserve = await topology.readSpokeReserve(provider, at, HUB, 7, 6, null, scanOptions, USDC);
    assert.equal(reserve.reserveBearing, false);
    assert.equal(reserve.reason, "NON_LENDING_INTERFACE");
    assert.deepEqual(reserve.errors, {});
    rows.push({ address: at, listed: true, config: { error: null }, reserve,
      accounting: { views: { getSpokeAddedAssets: { amountUsd: 12 }, getSpokeOwed: { amountUsd: 4 } } } });
  }
  assert.equal(rows[0].reserve.typed.suppliedAssetsRaw, 120n);
  assert.equal(rows[0].reserve.typed.suppliedSharesRaw, 90n);
  assert.equal(rows[1].reserve.typed.assetId, 7n);
  assert.equal(rows[1].reserve.typed.totalAssetsRaw, 130n);
  const assets = [{ assetId: 7, symbol: "USDC", spokeDirectory: { rows } }];
  const dependencies = await topology.summarizeListedSpokeDependencies(provider, assets, scanOptions);
  assert.equal(dependencies.length, 2);
  assert.ok(dependencies.every(row => row.totalAddedAssetsUsd === 12 && row.totalOwedUsd === 4));
  assert.ok(provider.calls.every(call => !["getReserveId", "ORACLE", "MAX_USER_RESERVES_LIMIT", "getLiquidationConfig", "HUB"].includes(call.name)));
  const coverage = coverageFor(rows);
  assert.equal(coverage.nonReserveSpokesExcluded, 2);
  assert.equal(coverage.reserveLinksExpected, 0);
  assert.equal(coverage.stateReadsAttempted, 5);
  assert.equal(coverage.stateReadsSucceeded, 5);
  assert.equal(coverage.sampleComplete, true);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.promotionEligible, false);
  assert.equal(coverage.errors.includes("deployment-semantics-unresolved"), false);
});

test("tokenization link/decimals mismatches and typed treasury read failures are failed dependencies, not clean exclusions", async () => {
  for (const [at, provider] of [[TOKENIZATION, typedProvider({ wrongTokenHub: true })], [TREASURY, typedProvider({ failName: "getSuppliedAssets" })]]) {
    const reserve = await topology.readSpokeReserve(provider, at, HUB, 7, 6, null, scanOptions, USDC);
    const coverage = coverageFor([{ address: at, listed: true, config: { error: null }, reserve }]);
    assert.equal(coverage.sampleComplete, false);
    assert.equal(coverage.stateReadsFailed, 1);
    assert.ok(coverage.errors.includes("non-lending-dependency-read-failed"));
  }
});

test("MAG7 ReserveNotListed/getReserveId reverts cannot exclude a lending reserve; global dependencies use authority only", async () => {
  const provider = typedProvider({ failName: "getReserveId" });
  const reserve = await topology.readSpokeReserve(provider, LENDING, HUB, 7, 6, null, scanOptions, USDC);
  assert.equal(reserve.reserveBearing, null);
  assert.equal(reserve.reserveIdError, "call-reverted");
  const coverage = coverageFor([{ address: LENDING, listed: true, config: { error: null }, reserve }]);
  assert.equal(coverage.nonReserveSpokesExcluded, 0);
  assert.equal(coverage.reserveLinksExpected, 1);
  assert.ok(coverage.errors.includes("reserve-state-read-failed"));
  const before = provider.calls.length;
  await topology.readOptionalAddressViews(provider, LENDING, scanOptions);
  assert.deepEqual(provider.calls.slice(before).map(row => row.name), ["authority"]);
});

test("unknown roles and forged non-lending booleans fail rather than silently dropping links", async () => {
  const provider = typedProvider();
  await assert.rejects(topology.readSpokeReserve(provider, A(999), HUB, 7, 6, null, scanOptions, USDC), /base-spoke-role-unbound/);
  assert.equal(provider.calls.length, 0);
  const coverage = coverageFor([{ address: TREASURY, listed: true, reserve: { reserveBearing: false, reserveId: null } }]);
  assert.equal(coverage.nonReserveSpokesExcluded, 0);
  assert.equal(coverage.reserveLinksExpected, 1);
  assert.equal(coverage.sampleComplete, false);
  const views = await topology.readOptionalAddressViews(provider, A(999), scanOptions);
  assert.equal(views.deploymentSemantics.status, "UNKNOWN_DEPLOYMENT_SEMANTICS");
  assert.equal(provider.calls.length, 0, "avoiding untyped probes is not semantic qualification");
  await assert.rejects(topology.readSpokeReserve(provider, TREASURY, A(123), 7, 6, null, scanOptions, USDC), /base-non-lending-hub-mismatch/);
});

test("only the exact same-pin Base strategy code gets HUB-only dependency reads, and wrong HUB/reverts block", async () => {
  for (const [provider, expectedError] of [[typedProvider(), null], [typedProvider({ wrongStrategyHub: true }), "dependency-hub-identity-mismatch"],
    [typedProvider({ failName: "HUB" }), "call-reverted"]]) {
    const views = await topology.readOptionalAddressViews(provider, STRATEGY, scanOptions);
    assert.deepEqual(provider.calls.map(row => row.name), ["HUB"]);
    assert.equal(views.interfaceKind, "strategy");
    assert.equal(views.HUB.error, expectedError);
    assert.equal(views.roleBinding.codeKeccak256, manifest.strategy.codeKeccak256);
    assert.equal(views.roleBinding.terminalPinConfirmed, false);
    assert.equal(admission.hasReadGaps(views), Boolean(expectedError));
  }
  await assert.rejects(topology.readSpokeReserve(typedProvider(), STRATEGY, HUB, 7, 6, null, scanOptions, USDC), /base-spoke-role-unbound/);
});

test("Hub owed ABI preserves both underlying components and computes sums, not the first returned word", async () => {
  const provider = typedProvider();
  const assets = await topology.readOptionalAssetViews(provider, HUB, 7, 6, 2);
  const spoke = await topology.readOptionalSpokeViews(provider, HUB, 7, "listed", LENDING, 6, 2);
  assert.equal(assets.getAssetOwed.raw, 5000000n);
  assert.equal(assets.getAssetOwed.amountUsd, 10);
  assert.equal(assets.getAssetOwed.components.drawnRaw, 2000000n);
  assert.equal(assets.getAssetOwed.components.premiumRaw, 3000000n);
  assert.equal(spoke.views.getSpokeOwed.raw, 11000000n);
  assert.equal(spoke.views.getSpokeOwed.amountUsd, 22);
  assert.equal(spoke.views.getSpokeOwed.components.drawnRaw, 4000000n);
  assert.equal(spoke.views.getSpokeOwed.components.premiumRaw, 7000000n);
});

test("remaining guard restrictions reject zero/undeclared targets without dispatch", async () => {
  const guard = admission.createRpcGuard({ allowedAddresses: [HUB], rpcRead: () => assert.fail("no dispatch") });
  await assert.rejects(guard.rpc("fixture", "eth_getLogs", [{ address: ZERO, blockHash: H(1) }], 1000), { code: "UNDECLARED_TARGET" });
});

function memoryFs(initial) {
  const files = new Map(), dirs = new Set([ROOT]);
  function parents(value) { for (let at = path.dirname(value); !dirs.has(at); at = path.dirname(at)) { dirs.add(at); if (path.dirname(at) === at) break; } }
  parents(ROOT);
  for (const [name, bytes] of Object.entries(initial)) { const file = path.join(ROOT, name); files.set(file, Buffer.from(bytes)); parents(file); }
  return { files, existsSync: value => files.has(value) || dirs.has(value), realpathSync: value => value,
    statSync: value => ({ size: files.get(value)?.length || 0, isFile: () => files.has(value) }),
    readFileSync: value => { assert.ok(files.has(value)); return files.get(value); },
    mkdirSync(value, options) { assert.ok(!dirs.has(value) || options?.recursive); parents(value); dirs.add(value); },
    writeFileSync(value, bytes, options) { assert.ok(options?.flag !== "wx" || !files.has(value)); assert.ok(dirs.has(path.dirname(value))); files.set(value, Buffer.from(bytes)); },
    renameSync(from, to) { assert.ok(files.has(from)); files.set(to, files.get(from)); files.delete(from); },
  };
}

test("real scanner terminal failure preserves a sanitized diagnostic in a new in-memory capture, never an attestation", async () => {
  const now = 1800000000000;
  const module = { CHAIN_ID: 8453, HUBS: { EQUITIES_HUB: A(1) }, SPOKES: { MAG7_SPOKE: A(2), TREASURY_SPOKE: A(4) },
    TREASURY_SPOKE: A(4), TOKENIZATION_SPOKES: { EQUITIES_USDC_TOKENIZATION_SPOKE: A(3) },
    ALL_HUBS: [A(1)], ALL_SPOKES: [A(2)], ALL_SPOKES_RAW: [A(4), A(2), A(3)], ALL_TOKENIZED_SPOKES: [A(3)] };
  const moduleBytes = Buffer.from(JSON.stringify(module));
  const identity = { ...admission.IDENTITY, moduleSha256: admission.sha256(moduleBytes) };
  const book = { packageVersion: identity.version, commit: identity.commit, modules: [{ name: identity.moduleName, chainId: 8453,
    sha256: identity.moduleSha256, bytes: moduleBytes.length }] };
  const components = []; // recursive addresses only, never inference of deployment interfaces
  const rolePaths = new Map();
  function visit(v, p = "") { if (typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v)) { if (!rolePaths.has(v)) rolePaths.set(v, []); rolePaths.get(v).push(p); }
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, p ? `${p}.${k}` : k); }
  visit(module); for (const [address, roles] of rolePaths) components.push({ address, roles });
  const scope = { schema: admission.SCHEMA, chainId: 8453,
    registry: { manifestPath: "public/manifest.json", modulePath: "public/module.json", ...identity }, components,
    dependencies: [{ address: A(6), role: "implementation", parent: A(1), source: "https://sourcify.dev/server/v2/contract/8453/" + A(6) }], sources: [] };
  const io = memoryFs({ "public/manifest.json": JSON.stringify(book), "public/module.json": moduleBytes, "scope.json": JSON.stringify(scope) });
  const hubAbi = new Interface(["function getAssetCount() view returns (uint256)"]);
  let terminal = false, requests = 0, snapshots = 0;
  const terminalFailure = new CollectionError("RPC_RATE_LIMITED");
  const raw = async (handle, method, params) => {
    requests += 1;
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") {
      if (terminal) throw terminalFailure;
      return { number: "0x64", hash: H(100), parentHash: H(99), stateRoot: H(900), timestamp: "0x" + (now / 1000 - 60).toString(16) };
    }
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getStorageAt") return params[1] === "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" ? H(6) : WORD;
    if (method === "eth_getLogs") return [];
    if (method === "eth_call") return hubAbi.encodeFunctionResult("getAssetCount", [0]);
    assert.fail("unexpected method");
  };
  const report = await admission.capture({ workspace: ROOT, fs: io, scopePath: "scope.json", outDir: "reports/offline-diagnostic-fixture",
    identity, now: () => now, rpcRead: raw,
    openCollection: options => openPinnedCollection({ ...options,
      candidates: ["alchemy", "infura"].map((operatorFamily, i) => ({ handle: `fixture-${i}`, operatorFamily })) }),
    collectTopology: options => topology.collectTopology({ ...options, onProvisionalTopology: snapshot => {
      snapshots += 1;
      assert.equal(snapshot.provisional, true);
      assert.equal(snapshot.incomplete, true);
      assert.equal(snapshot.sourceCoverage.observationPin, null);
      options.onProvisionalTopology(snapshot); terminal = true;
    } }),
  });
  assert.ok(requests > 0);
  assert.equal(snapshots, 1);
  assert.equal(report.status, "INCOMPLETE");
  assert.ok(report.codes.includes("RPC_RATE_LIMITED"));
  assert.equal(report.topologyObtained, false);
  assert.equal(report.topologyDiagnosticWritten, true);
  assert.equal(report.finalObservationPin, null);
  assert.equal(report.terminalPinConfirmed, false);
  const diagnostic = JSON.parse(io.files.get(path.join(ROOT, "reports/offline-diagnostic-fixture/topology-diagnostic.json")));
  assert.equal(diagnostic.sourceCoverage.observationPin, null);
  assert.equal(diagnostic.sourceCoverage.complete, false);
  assert.equal(io.files.has(path.join(ROOT, "reports/offline-diagnostic-fixture/topology.json")), false);
  assert.equal(report.coveragePromotion, false);
});

test("provisional callback cannot swallow or replace the scanner's original terminal error", async () => {
  const failure = new CollectionError("TERMINAL_PIN_MISMATCH");
  const context = { chainId: 8453, pin: capturedInventory.pin, statistics: () => ({ networkCalls: 0 }),
    provider: { call: async () => H(0) }, confirmPin: async () => { throw failure; },
    observationPin: () => assert.fail("failed terminal confirmation must never attest") };
  let snapshot;
  await assert.rejects(topology.collectTopology({ chainId: 8453, registryExtract: { chainId: 8453,
    registryId: "aave-dao/aave-address-book", version: "v4.74.1", commit: manifest.registry.commit, source: "AaveV4Base",
    pinBlock: capturedInventory.pin.number, hubs: [{ key: "EQUITIES_HUB", name: "Equities Hub", address: HUB }] },
    openCollection: async () => context, fetchPrices: async () => ({}),
    scanHub: async () => ({ address: HUB, assetCount: 0, assetCountReadOk: true, assets: [], totals: {} }),
    onProvisionalTopology: value => { snapshot = value; throw new Error("diagnostic callback failure"); },
  }), error => error === failure);
  assert.equal(snapshot.provisional, true);
  assert.equal(snapshot.incomplete, true);
  assert.equal(snapshot.sourceCoverage.observationPin, null);
});
