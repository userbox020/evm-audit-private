"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Interface, keccak256 } = require("ethers");
const contract = require("../lib/aave-v4-base-observation-contract");
const borrowers = require("../scan-aave-v4-base-borrowers");
const oracles = require("../scan-aave-v4-base-oracles");
const A = n => "0x" + BigInt(n).toString(16).padStart(40, "0");
const H = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const USER = A(42), CALLER = A(41), CODE = "0x6000", CODE_HASH = keccak256(CODE);
const EVENT = new Interface(["event Borrow(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 drawnShares,uint256 drawnAmount)"]);
let published, captured;
function makeFixture(options = {}) {
  // Explicit fixture setup only. These historical public bytes are never loaded
  // by the new collectors, never written back, and are NOT fresh live evidence.
  const roles = require("../lib/aave-v4-base-role-evidence");
  const manifest = require("../aave-v4-base-role-evidence.json");
  if (!published) published = roles.loadPublishedEvidence();
  if (!captured) captured = require("../../reports/coverage-unblock-20261018/base-typed-validation/code-inventory.json");
  const pin = { number: 9, hash: H(9), stateRoot: H(900), timestamp: NOW / 1000 - 60 };
  const inventory = structuredClone(captured); inventory.pin = { ...pin };
  const roleBindings = roles.bindRoleEvidence({ chainId: 8453, registry: manifest.registry, pin, inventory,
    scopeSha256: manifest.scopeSha256, published });
  const users = options.users || [USER];
  // Source-independent literal fixture components: each USDC position has
  // drawn=8, premiumShares=1, offset=-3 RAY-units at index=1 RAY. Each rounds
  // to 10 underlying units; the aggregate rounds only once per component.
  const aggregate = options.aggregateDebtRaw ?? String(users.length ? 9 * users.length + 1 : 0);
  const links = Array.from({ length: 8 }, (_, i) => ({ hubAddress: contract.HUB, assetId: i, spoke: contract.SPOKE, reserveId: i }));
  const coverage = { schema: "aave-source-coverage/v1", schemaVersion: 1, protocolVersion: "V4", coverageKind: "topology",
    sampleComplete: true, complete: false, stateReadsAttempted: 34, stateReadsSucceeded: 34, stateReadsFailed: 0,
    topologyUniverse: { bound: true, registry: "aave-dao/aave-address-book", version: "v4.74.1", commit: manifest.registry.commit,
      pinBlock: "0x9", inventoryDigest: "a".repeat(64) }, consumedReserveLinks: links,
    hubsExpected: 1, hubsObserved: 1, spokesExpected: 1, spokesObserved: 1, assetsExpected: 8, assetsObserved: 8,
    spokeReserveLinks: [{ spoke: contract.SPOKE, expected: 8, observed: 8, consumed: 8, links }],
    reserveLinksExpected: 8, reserveLinksDeclared: 8, reserveLinksObserved: 8, reserveLinksConsumed: 8 };
  const state = { operations: 34, confirmed: true, calls: [], ranges: [], events: [], saved: null, saves: 0,
    budget: true, key: 7, updatedAt: BigInt(pin.timestamp - 10), latestRoundReads: 0, badAnchor: false, terminalFailure: false };
  const context = { chainId: 8453, pin,
    canCollect: () => state.budget && state.operations < (state.maxOperations ?? Infinity),
    statistics: () => ({ stateReadOperations: state.operations }),
    async confirmPin() { state.events.push("CONFIRM"); state.confirmed = !state.terminalFailure;
      if (state.terminalFailure) throw new Error("SYNTHETIC_SECRET_TERMINAL"); return pin; },
    observationPin(c) {
      if (!state.confirmed || c.stateReadsAttempted > state.operations || c.stateReadsFailed || c.stateReadsSucceeded !== c.stateReadsAttempted) return null;
      return { schema: "aave-v4-state-pin/v1", chainId: 8453, finality: "finalized", blockNumber: pin.number, blockHash: pin.hash,
        stateRoot: pin.stateRoot, terminalBlockNumber: pin.number, terminalBlockHash: pin.hash, stateReadsPinned: c.stateReadsAttempted,
        headerFamilies: 2, stateFamilies: 1, rpcStrength: "single-provider" };
    }, provider: {} };
  const topology = { generatedAt: new Date(NOW - 1000).toISOString(), chain: { id: 8453, blockNumber: pin.number,
    blockHash: pin.hash, stateRoot: pin.stateRoot, timestamp: pin.timestamp, finality: "finalized" }, sourceCoverage: coverage,
    declaredTopology: { bound: true, hubsDeclared: 1, pinBlock: "0x9", registry: "aave-dao/aave-address-book", version: "v4.74.1", commit: manifest.registry.commit, inventoryDigest: "a".repeat(64) },
    hubs: [{ address: contract.HUB, assetCountReadOk: true, assetCount: 8, assets: links.map((link, i) => ({ assetId: i,
      underlying: contract.ASSETS[i], decimals: i === 7 ? 6 : 8,
      spokeDirectory: { count: 1, rows: [{ address: contract.SPOKE, listed: true, reserve: { reserveBearing: true, reserveId: i,
        reserve: { hub: contract.HUB, assetId: String(i), underlying: contract.ASSETS[i], decimals: i === 7 ? 6 : 8, dynamicConfigKey: 2 },
        totalDebtRaw: i === 7 ? aggregate : "0", oracleData: { address: contract.ORACLE, spoke: contract.SPOKE, source: contract.FEEDS[i] } } }] } })) }] };
  coverage.observationPin = context.observationPin(coverage);
  const fullABI = new Interface([...borrowers.ABI.fragments, ...oracles.ABI.fragments, ...oracles.TIMESTAMP.fragments]);
  const logs = users.map((user, i) => {
    const encoded = EVENT.encodeEventLog(EVENT.getEvent("Borrow"), [7, CALLER, user, 1, 10]);
    return { address: contract.SPOKE, topics: encoded.topics, data: encoded.data, blockNumber: "0x1", blockHash: H(1),
      transactionHash: H(500 + i), logIndex: "0x" + i.toString(16), removed: false };
  });
  context.provider.call = async tx => {
    const parsed = fullABI.parseTransaction(tx); assert.ok(parsed); state.confirmed = false; state.operations++;
    state.calls.push({ to: tx.to.toLowerCase(), name: parsed.name, args: Array.from(parsed.args) });
    if (state.failName === parsed.name) throw state.failure || new Error("SYNTHETIC_SECRET_READ");
    const i = parsed.args.length ? Number(parsed.args[0]) : 0;
    const user = parsed.args.length > 1 && typeof parsed.args[1] === "string" ? parsed.args[1].toLowerCase() : null;
    const values = {
      getUserAccountData: [0, 6000, 1200000000000000000n, 500, 100, 1, 1], getUserReserveStatus: [i !== 7, i === 7],
      getUserSuppliedAssets: [i === 7 ? 0 : 1], getUserTotalDebt: [state.userDebtByUser?.[user]?.[i] ?? (i === 7 ? 10 : 0)],
      getUserPosition: state.positionsByUser?.[user]?.[i] ?? (i === 7 ? [8, 1, -3, 0, state.key] : [0, 0, 0, 4, state.key]),
      getDynamicReserveConfig: [6000, 10500, 100],
      getSpokeDrawnShares: [state.aggregateComponents?.[i]?.[0] ?? (i === 7 ? 8n * BigInt(users.length) : 0n)],
      getSpokePremiumData: [state.aggregateComponents?.[i]?.[1] ?? (i === 7 ? BigInt(users.length) : 0n),
        state.aggregateComponents?.[i]?.[2] ?? (i === 7 ? -3n * BigInt(users.length) : 0n)],
      getAssetDrawnIndex: [state.drawnIndexRay ?? 10n ** 27n],
      ORACLE: [state.wrongOracle || contract.ORACLE], spoke: [state.wrongSpoke || contract.SPOKE], decimals: [8],
      getReserveSource: [state.wrongSource || contract.FEEDS[i]], getReservePrice: [state.price ?? 100000000n],
      latestRoundData: [1, 100000000n, state.updatedAt, state.updatedAt, 1],
    };
    if (["getSpokeDrawnShares", "getSpokePremiumData", "getAssetDrawnIndex"].includes(parsed.name)) {
      assert.equal(tx.to.toLowerCase(), contract.HUB);
      if (parsed.args.length === 2) assert.equal(parsed.args[1].toLowerCase(), contract.SPOKE);
    }
    if (parsed.name === "latestRoundData") state.latestRoundReads++;
    return fullABI.encodeFunctionResult(parsed.name, values[parsed.name]);
  };
  context.provider.getCode = async address => { state.operations++; state.confirmed = false; state.calls.push({ to: address, name: "GET_CODE" }); return state.badCode ? "0x6001" : state.codeByAddress?.[address] || CODE; };
  context.provider.getStorage = async () => { state.operations++; state.confirmed = false; return H(1); };
  context.provider.getLogs = async filter => {
    state.ranges.push([filter.fromBlock, filter.toBlock]); state.confirmed = false;
    if (state.logFailureAt === filter.fromBlock) throw new Error("SYNTHETIC_SECRET_LOG");
    if (state.maxRange && filter.toBlock - filter.fromBlock + 1 > state.maxRange) {
      const { CollectionError } = require("../lib/aave-v4-pinned-collection"); throw new CollectionError("LOG_RANGE_LIMIT");
    }
    return (state.logs || logs).filter(row => Number(row.blockNumber) >= filter.fromBlock && Number(row.blockNumber) <= filter.toBlock);
  };
  context.provider.getBlock = context.checkpointBlock = async number => ({ number, hash: state.badAnchor ? H(999) : H(number) });
  const scopeAddresses = Object.freeze(inventory.rows.map(row => row.address));
  const deps = { context, roleBindings, now: () => NOW, frozenScope: { chainId: 8453, addresses: scopeAddresses,
    digest: contract.digest([...scopeAddresses].sort()) }, runtimeExpectations: [contract.ORACLE, ...contract.FEEDS].map(address => ({ address, codeKeccak256: CODE_HASH })),
    historyStore: { async load(identity) { return state.saved ? structuredClone(state.saved) : require("../lib/aave-v4-borrower-history").emptyHistory(identity); },
      async save(index) { state.events.push("SAVE"); assert.equal(state.confirmed, true); state.saves++; state.saved = structuredClone(index); } } };
  return { topology, deps, state, logs, pin };
}
function semanticDescriptor(address, kind = "round-data", options = {}) {
  const runtimeCode = options.runtimeCode || CODE, codeHash = keccak256(runtimeCode);
  const statement = { kind, ...(options.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: options.maxAgeSeconds }),
    ...(options.child ? { child: options.child, timestampPropagation: "child-only", ...(options.childProof ? { childProof: options.childProof } : {}) } : {}) };
  const iface = kind === "reserve-price-positive-only" ? oracles.ABI : kind === "round-data" ? oracles.TIMESTAMP
    : new Interface(["function latestAnswer() view returns (int256)"]);
  const source = kind === "reserve-price-positive-only" ? "function getReservePrice(uint256) external view returns(uint256) { return uint256(source.latestAnswer()); }"
    : kind === "round-data" ? "function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80);"
      : "function latestAnswer() external view returns(int256);";
  const artifactJson = JSON.stringify({ chainId: 8453, address, runtimeMatch: "match", runtimeBytecode: { onchainBytecode: runtimeCode },
    compilation: { compilerVersion: "0.8.28+commit.7893614a" }, abi: iface.fragments.map(fragment => JSON.parse(fragment.format("json"))),
    sources: { "SyntheticEvidence.sol": { content: source } }, ignoredMetadata: "SYNTHETIC_SECRET_SOURCE" });
  return { address, codeKeccak256: codeHash, statementDigest: contract.digest(statement), sourceEvidence: {
    schema: "aave-v4-base-source-evidence/v1", artifactJson, artifactSha256: contract.sha256(artifactJson),
    sourcePath: "SyntheticEvidence.sol", sourceSha256: contract.sha256(source), review: {
      schema: "aave-v4-code-bound-semantic-review/v1", sourceSha256: contract.sha256(source), codeKeccak256: codeHash, statement } } };
}
function fabricatedCreationProof() {
  const proxy = require("../../reports/base-aave-v4-admission-20261018/public-sources/0x17905db0e4a3514467539956c084180616ae7b8d.json");
  // All former structural checks agree, but none of these invented headers,
  // receipts or transaction fields proves canonical deployment provenance.
  return { kind: "CREATION", chainId: 8453, fromBlock: 5, spoke: contract.SPOKE, implementation: contract.IMPLEMENTATION,
    implementationCodeKeccak256: contract.IMPL_HASH, proxyRuntime: proxy.runtimeBytecode.onchainBytecode,
    transaction: { hash: H(555), chainId: 8453, to: null, blockNumber: 5, blockHash: H(5) },
    receipt: { transactionHash: H(555), contractAddress: contract.SPOKE, status: "0x1", blockNumber: 5, blockHash: H(5) },
    header: { number: 5, hash: H(5) } };
}
module.exports = { makeFixture, semanticDescriptor, fabricatedCreationProof, A, H, NOW, USER, CALLER, EVENT, CODE_HASH };

if (require.main === module) {
  test("imports are offline and do not load collectors/providers/history stores", () => {
    const Module = require("node:module"), original = Module._load;
    try {
      Module._load = function (request, ...args) {
        if (/shared-rpc|pinned-collection|borrower-history|role-evidence/.test(request)) throw new Error("forbidden ambient dependency");
        return original.call(this, request, ...args);
      };
      for (const name of ["../scan-aave-v4-base-borrowers", "../scan-aave-v4-base-oracles", "../lib/aave-v4-base-observation-contract"]) {
        delete require.cache[require.resolve(name)]; assert.ok(require(name));
      }
    } finally { Module._load = original; }
  });
  test("old C5 is rejected before context/provider use, not repaired with its whole-capture attestation", async () => {
    const old = require("../../reports/coverage-unblock-20261018/base-typed-validation/topology.json");
    let opened = 0;
    const deps = { now: () => NOW, openCollection: () => { opened++; throw new Error("must not open"); } };
    const a = await borrowers.collectBaseBorrowers(old, deps), b = await oracles.collectBaseOracles(old, deps);
    assert.equal(opened, 0);
    for (const out of [a, b]) { assert.deepEqual(out.errors, ["TOPOLOGY_METADATA_INVALID"]); assert.equal(out.observationPin, null); }
  });
  test("strict native metadata, all eight identities, read counts and same-pin opaque role evidence are required", async () => {
    for (const mutate of [
      f => { f.topology.sourceCoverage.observationPin.stateReadsPinned = 683; },
      f => { f.topology.chain.timestamp = "METADATA_OMITTED"; }, f => { f.topology.chain.id = 1; },
      f => { f.topology.declaredTopology.inventoryDigest = "METADATA_OMITTED"; },
      f => { f.topology.hubs[0].assets[7].underlying = contract.ASSETS[0]; },
      f => { f.topology.sourceCoverage.consumedReserveLinks[7] = { ...f.topology.sourceCoverage.consumedReserveLinks[0] }; },
      f => { f.topology.hubs[0].assets[0].spokeDirectory.truncated = true; },
      f => { f.topology.sourceCoverage.assetsObserved = 7; },
      f => { f.topology.hubs[0].assets[0].spokeDirectory.rows.push({ address: A(999), reserve: { reserveBearing: false } }); f.topology.hubs[0].assets[0].spokeDirectory.count++; },
      f => { f.deps.roleBindings = { sourceBound: true }; }, f => { f.deps.context = { ...f.deps.context, chainId: 1 }; },
    ]) {
      const f = makeFixture(); mutate(f);
      const out = await borrowers.collectBaseBorrowers(f.topology, f.deps);
      assert.equal(out.componentObservationComplete, false); assert.equal(out.observationPin, null); assert.ok(out.errors.length);
      assert.equal(f.state.calls.length, 0);
    }
  });
  test("unknown metadata and synthetic secrets in errors/pins never appear in outputs", async () => {
    const f = makeFixture(); f.topology.ignored = "SYNTHETIC_SECRET_METADATA";
    f.state.failName = "getUserPosition";
    f.state.failure = { code: "SYNTHETIC_SECRET_CODE", message: "SYNTHETIC_SECRET_MESSAGE", cause: "SYNTHETIC_SECRET_CAUSE", headers: { authorization: "SYNTHETIC_SECRET" } };
    const out = await borrowers.collectBaseBorrowers(f.topology, f.deps);
    assert.doesNotMatch(JSON.stringify(out), /SYNTHETIC_SECRET/); assert.ok(out.errors.includes("OBSERVATION_READ_FAILED"));
    const bad = makeFixture(); bad.topology.chain.blockHash = "SYNTHETIC_SECRET_PIN";
    assert.doesNotMatch(JSON.stringify(await oracles.collectBaseOracles(bad.topology, bad.deps)), /SYNTHETIC_SECRET/);
  });
  test("internally consistent fabricated direct-creation metadata never authorizes a truncated history", () => {
    const proof = fabricatedCreationProof();
    assert.equal(keccak256(proof.proxyRuntime), "0x57db7d2196b3603cef54f6fdeae8332584be1e54b2bd9c2a7c827a89f5482e61");
    assert.throws(() => contract.startProof(proof, { pin: { number: 9 } }), { code: "CREATION_PROOF_UNQUALIFIED" });
    const genesis = contract.startProof({ kind: "GENESIS", fromBlock: 0 }, { pin: { number: 9 } });
    assert.equal(genesis.fromBlock, 0); assert.equal(genesis.fullHistoryEligible, true);
    assert.equal(contract.startProof({ kind: "SNAPSHOT", fromBlock: 5, blockHash: H(5) }, { pin: { number: 9 } }).fullHistoryEligible, false);
    assert.throws(() => contract.startProof({ kind: "GENESIS", fromBlock: 5 }, { pin: { number: 9 } }), { code: "START_PROOF_INVALID" });
  });
}
