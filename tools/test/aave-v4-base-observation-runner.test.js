"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Interface, id, keccak256 } = require("ethers");
const runner = require("../observe-aave-v4-base");
const C = require("../admit-aave-v4-base");
const contract = require("../lib/aave-v4-base-observation-contract");
const roles = require("../lib/aave-v4-base-role-evidence");
const history = require("../lib/aave-v4-borrower-history");
const borrowers = require("../scan-aave-v4-base-borrowers");
const oracles = require("../scan-aave-v4-base-oracles");
const root = path.resolve(__dirname, "../.."), NOW = Date.parse("2026-10-18T12:00:00.000Z");
const H = n => "0x" + BigInt(n).toString(16).padStart(64, "0"), A = n => "0x" + BigInt(n).toString(16).padStart(40, "0");
const hashBytes = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const clone = value => structuredClone(value), HEX = n => "0x" + n.toString(16);
const event = new Interface(["event Borrow(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 drawnShares,uint256 drawnAmount)"]);
const validated = C.loadScope("tools/aave-v4-base-admission-scope.json");
let codeFixture;
function publicCodeFixture() {
  if (codeFixture) return codeFixture;
  // Only published runtime/source references, never a capture/code inventory.
  // Fake RPC responses bind these literal public bytes to synthetic block 9;
  // this is NOT current-state evidence or a historical attestation transplant.
  const manifest = require("../aave-v4-base-role-evidence.json");
  const codes = Object.fromEntries(validated.allowedAddresses.map(at => [at, "0x6000"]));
  for (const role of manifest.roles) {
    codes[role.address] = JSON.parse(fs.readFileSync(path.join(root, "reports/base-aave-v4-admission-20261018/public-sources", role.address + ".json"))).runtimeBytecode.onchainBytecode;
    const bytes = fs.readFileSync(path.join(root, role.runtime.filePath), "utf8");
    codes[role.implementation] = role.runtime.format === "basescan-deployed-html" ? roles.extractDeployedRuntime(bytes) : JSON.parse(bytes).runtimeBytecode.onchainBytecode;
  }
  codes[manifest.strategy.address] = fs.readFileSync(path.join(root, manifest.strategy.runtime.filePath), "utf8").trim();
  codeFixture = codes; return codes;
}
function topology(context, time) {
  const p = context.pin, links = Array.from({ length: 8 }, (_, i) => ({ hubAddress: contract.HUB, assetId: i, spoke: contract.SPOKE, reserveId: i }));
  const declared = { bound: true, hubsDeclared: 1, pinBlock: HEX(p.number), registry: "aave-dao/aave-address-book", version: "v4.74.1",
    commit: validated.scope.registry.commit, inventoryDigest: "a".repeat(64) };
  const coverage = { schema: "aave-source-coverage/v1", schemaVersion: 1, protocolVersion: "V4", coverageKind: "topology", sampleComplete: true, complete: false,
    stateReadsAttempted: 34, stateReadsSucceeded: 34, stateReadsFailed: 0, topologyUniverse: { ...declared }, consumedReserveLinks: links,
    hubsExpected: 1, hubsObserved: 1, spokesExpected: 1, spokesObserved: 1, assetsExpected: 8, assetsObserved: 8,
    spokeReserveLinks: [{ spoke: contract.SPOKE, expected: 8, observed: 8, consumed: 8, links }],
    reserveLinksExpected: 8, reserveLinksDeclared: 8, reserveLinksObserved: 8, reserveLinksConsumed: 8 };
  const raw = { generatedAt: new Date(time).toISOString(), declaredTopology: declared,
    chain: { id: 8453, blockNumber: p.number, blockHash: p.hash, stateRoot: p.stateRoot, timestamp: Number(p.timestamp), finality: "finalized" }, sourceCoverage: coverage,
    hubs: [{ address: contract.HUB, assetCountReadOk: true, assetCount: 8, assets: links.map((link, i) => ({ assetId: i, underlying: contract.ASSETS[i], decimals: i === 7 ? 6 : 8,
      spokeDirectory: { count: 1, rows: [{ address: contract.SPOKE, listed: true, reserve: { reserveBearing: true, reserveId: i,
        reserve: { hub: contract.HUB, assetId: String(i), underlying: contract.ASSETS[i], decimals: i === 7 ? 6 : 8, dynamicConfigKey: 2 }, totalDebtRaw: "0",
        oracleData: { address: contract.ORACLE, spoke: contract.SPOKE, source: contract.FEEDS[i] } } }] } })) }] };
  coverage.observationPin = context.observationPin(coverage); return raw;
}
function fullProfile() {
  return { schema: "aave-v4-base-observation-profile/v1", mode: "FULL_L_O", roots: false, topology: true, borrowers: true, oracles: true,
    qualificationCanaries: true, history: { enabled: true, fromBlock: 0, chunkSize: 4, maxChunks: 5, maxLogs: 10, maxUsers: 10 } };
}
function fixture(mode = "FULL_L_O") {
  let elapsed = 0, confirms = 0;
  const pin = { number: 9, hash: H(9), stateRoot: H(900), timestamp: NOW / 1000 - 60 };
  const state = { calls: [], saves: [], loaded: null, codes: { ...publicCodeFixture() }, pin, events: [], terminalFail: false, failRead: false };
  const roots = runner.rootReads(), profile = mode === "ROOT_DISCOVERY" ? runner.rootDiscoveryProfile() : fullProfile();
  const sourceProfile = { schema: "aave-v4-base-observation-sources/v1",
    codeHashes: Object.fromEntries(runner.CODE_FILES.map(file => [file, hashBytes(fs.readFileSync(path.join(root, file)))])),
    roots: [contract.ORACLE, ...contract.FEEDS].map(at => {
      const abi = roots.filter(row => row.target === at).map(row => `function ${row.signature} view returns (${row.outputs.join(",")})`);
      const artifactJson = JSON.stringify({ chainId: 8453, address: at, runtimeMatch: "match", runtimeBytecode: { onchainBytecode: state.codes[at] }, abi,
        sources: { "Synthetic.sol": { content: "Synthetic ABI fixture, not source qualification" } } });
      return { evidenceKind: "DIRECT_PUBLICATION", address: at, codeKeccak256: keccak256(state.codes[at]), sourceEvidenceSha256: hashBytes(artifactJson), artifactJson };
    }), callSelectors: Object.fromEntries(validated.allowedAddresses.map(at => [at, [...new Set([
      ...borrowers.ABI.fragments.filter(f => f.type === "function").map(f => f.selector), ...oracles.ABI.fragments.map(f => f.selector),
      ...oracles.TIMESTAMP.fragments.map(f => f.selector), ...roots.map(row => id(row.signature).slice(0, 10)),
    ])]])) };
  const iface = new Interface([...new Set([...borrowers.ABI.fragments, ...oracles.ABI.fragments, ...oracles.TIMESTAMP.fragments].map(f => f.format("full"))),
    ...roots.filter(row => !["ORACLE()", "spoke()", "decimals()", "getReserveSource(uint256)", "getReservePrice(uint256)", "latestRoundData()"].includes(row.signature))
      .filter((row, i, all) => all.findIndex(x => x.signature === row.signature) === i).map(row => `function ${row.signature} view returns (${row.outputs.join(",")})`) ]);
  const encoded = event.encodeEventLog(event.getEvent("Borrow"), [7, A(41), A(42), 1, 10]);
  state.logs = [{ address: contract.SPOKE, ...encoded, blockNumber: "0x1", blockHash: H(1), transactionHash: H(501), logIndex: "0x0", removed: false }];
  const header = n => ({ number: HEX(n), hash: H(n), stateRoot: pin.stateRoot, timestamp: HEX(pin.timestamp), parentHash: H(Math.max(0, n - 1)) });
  const now = () => NOW + elapsed;
  const transport = async (handle, method, params, timeout, transportOptions) => {
    state.calls.push({ handle, method, params: clone(params), time: now(), timeout, maxBytes: transportOptions.maxBytes });
    assert.ok(timeout <= 10000 && timeout > 0); assert.equal(transportOptions.maxBytes, 4194304);
    if (state.hook) { const response = await state.hook(method, params); if (response !== undefined) return response; }
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") {
      const result = header(params[0] === "finalized" ? 9 : Number(BigInt(params[0])));
      if (state.terminalFail && params[0] === "0x9") result.hash = H(999);
      return result;
    }
    if (method === "eth_getCode") return state.codes[params[0].toLowerCase()];
    if (method === "eth_getStorageAt") {
      if (params[1] === H(0)) return H(0);
      const impl = validated.dependencies.find(row => row.parent === params[0].toLowerCase());
      return impl ? "0x" + "0".repeat(24) + impl.address.slice(2) : H(0);
    }
    if (method === "eth_getLogs") {
      if (params[0].blockHash) return [];
      return state.logs.filter(row => Number(BigInt(row.blockNumber)) >= Number(BigInt(params[0].fromBlock)) && Number(BigInt(row.blockNumber)) <= Number(BigInt(params[0].toBlock)));
    }
    if (method === "eth_call") {
      if (params[0].data === id("getAssetCount()").slice(0, 10)) return H(8);
      const parsed = iface.parseTransaction(params[0]); assert.ok(parsed);
      if (state.failRead && parsed.name === "getReservePrice") throw new Error("SENTINEL_SECRET_TRANSPORT");
    const i = parsed.args.length && typeof parsed.args[0] !== "string" ? Number(parsed.args[0]) : 0, feed = contract.FEEDS.indexOf(params[0].to);
      const values = { ORACLE: [contract.ORACLE], spoke: [contract.SPOKE], decimals: [8], getReserveSource: [contract.FEEDS[i]], getReservePrice: [100000000],
        getUserAccountData: [0, 0, 0, 0, 0, 0, 0], getUserReserveStatus: [false, false], getUserSuppliedAssets: [0], getUserTotalDebt: [0],
        getUserPosition: [0, 0, 0, 0, 7], getDynamicReserveConfig: [6000, 10500, 100], getSpokeDrawnShares: [0], getSpokePremiumData: [0, 0], getAssetDrawnIndex: [10n ** 27n],
        aggregator: [A(800 + feed)], phaseId: [1], accessController: [A(900)], latestAnswer: [100000000],
        latestRoundData: [1, 100000000, pin.timestamp - 10, pin.timestamp - 10, 1], ASSET_TO_USD_AGGREGATOR: [A(807)], ACL_MANAGER: [A(901)], getPriceCap: [101000000] };
      return iface.encodeFunctionResult(parsed.name, values[parsed.name]);
    }
    assert.fail("unexpected transport method");
  };
  const candidates = ["alchemy", "infura"].map((operatorFamily, i) => ({ handle: `SENTINEL_SECRET_HANDLE_${i}`, operatorFamily, inventoryOrder: i }));
  const options = { now, sleep: async ms => { elapsed += ms; }, transport: async (...args) => {
    try { return await transport(...args); } catch (error) { state.rpcError = error; throw error; }
  }, candidates, profile, sourceProfile,
    historyStore: { async load(identity) { state.loaded = history.emptyHistory(identity); return state.loaded; },
      async save(index) { state.events.push("PERSIST"); state.saves.push(index); assert.ok(state.finalSeen); } },
    async collectTopology(args) {
      const context = await args.openCollection(); state.context = context;
      assert.equal(args.chainId, 8453); assert.equal(context.chainId, 8453);
      roles.assertBindings(args.roleBindings, { chainId: 8453, pin: context.pin, registry: args.registryExtract });
      const seen = new Set(state.calls.filter(c => c.method === "eth_getCode").map(c => c.params[0]));
      assert.equal(seen.size, 38, "all frozen targets inventoried before bindings/topology");
      for (let i = 0; i < 34; i++) await context.provider.call({ to: contract.ORACLE, data: oracles.ABI.encodeFunctionData("getReservePrice", [i % 8]) });
      await context.confirmPin(); state.raw = topology(context, now());
      state.raw.SENTINEL_SECRET_KEY = true; state.raw.ignored = "SENTINEL_SECRET_METADATA";
      state.raw.chain.privateContext = "SENTINEL_SECRET_PIN";
      return state.raw;
    },
    async collectBorrowers(raw, deps) { assert.equal(raw, state.raw); assert.equal(deps.context, state.context);
      const out = await borrowers.collectBaseBorrowers(raw, deps); state.l = out; return out; },
    async collectOracles(raw, deps) { assert.equal(raw, state.raw); assert.equal(deps.context, state.context);
      const out = await oracles.collectBaseOracles(raw, deps); state.o = out; state.beforeFinal = state.calls.length; return out; },
  };
  if (mode === "ROOT_DISCOVERY") {
    // Explicitly test-only no-log fake context; not the frozen native constructor.
    delete options.collectTopology; delete options.collectBorrowers; delete options.collectOracles;
    options.openCollection = async args => {
      let operations = 0, stateRequests = 0, confirmed = false, network = 0;
      const rpc = async (handle, method, params) => { network++; return args.rpc(handle, method, params, 10000); };
      await Promise.all(candidates.map(row => rpc(row.handle, "eth_getBlockByNumber", ["finalized", false])));
      const at = { blockHash: pin.hash, requireCanonical: true }, cache = new Map();
      const read = async (method, params) => { operations++; confirmed = false; const key = method + JSON.stringify(params);
        if (!cache.has(key)) { stateRequests++; cache.set(key, await rpc(candidates[0].handle, method, params)); } return cache.get(key); };
      const context = { chainId: 8453, pin, canCollect: () => true, provider: {
        getCode: atAddress => read("eth_getCode", [atAddress, at]), getStorage: (atAddress, slot) => read("eth_getStorageAt", [atAddress, slot, at]),
        call: tx => read("eth_call", [tx, at]), getLogs: () => assert.fail("ROOT logs forbidden"),
      }, async confirmPin() { confirms++; state.events.push("CONFIRM");
        await Promise.all(candidates.map(row => rpc(row.handle, "eth_getBlockByNumber", ["0x9", false])));
        confirmed = true; state.finalSeen = true; return pin; },
      observationPin(c) { if (!confirmed) return null; return { schema: "aave-v4-state-pin/v1", chainId: 8453, finality: "finalized", blockNumber: 9, blockHash: pin.hash,
        stateRoot: pin.stateRoot, terminalBlockNumber: 9, terminalBlockHash: pin.hash, stateReadsPinned: c.stateReadsAttempted, headerFamilies: 2, stateFamilies: 1, rpcStrength: "single-provider" }; },
      statistics: () => ({ dispatchedRequests: network, stateRequests, stateReadOperations: operations, stateCacheHits: operations - stateRequests,
        stateTransportFailures: 0, revertedStateReads: 0, rejectedRequests: 0, networkCalls: network, headerFamilies: 2, stateFamilies: 1, automaticRetries: 0 }) };
      return context;
    };
  } else {
    options.openCollection = async args => {
      const native = await require("../lib/aave-v4-pinned-collection").openPinnedCollection(args);
      return { ...native, async confirmPin() { confirms++; state.events.push("CONFIRM"); const value = await native.confirmPin();
        if (confirms >= 4) state.finalSeen = true; return value; } };
    };
  }
  function approve(execution = "OFFLINE_FIXTURE") {
    if (options.profile.qualificationCanaries) {
      options.profile.qualificationCanaryPolicy ||= { schema: "aave-v4-base-qualification-canaries/v1", address: contract.HUB, topic: H(0),
        minBlock: 9, maxBlock: 9, maxPerCandidate: 2, maxTotal: 2 * options.candidates.length, stages: ["PINNED_CANDIDATE", "COMMON_PIN"] };
      options.sourceProfile.qualificationCanaryDigest = runner.digest(options.profile.qualificationCanaryPolicy);
    }
    if (options.profile.qualificationCanaries || options.sourceProfile.roots.some(row => row.evidenceKind === "SHARED_RUNTIME_CLASS")) options.profile.rootEvidenceDigest = runner.digest(options.sourceProfile.roots);
    options.approval = { schema: "aave-v4-base-observation-approval/v1", status: "CURRENT_IN_PROGRESS", attemptStarted: true, chainId: 8453,
      scopeSha256: runner.SCOPE_SHA256, targetCount: 38, addressSetSha256: runner.ADDRESS_SET_SHA256, execution, issuedAtMs: now(), expiresAtMs: now() + 240000,
      mode: options.profile.mode, profileDigest: runner.digest(options.profile), sourceProfileDigest: runner.digest(options.sourceProfile),
      candidatesDigest: runner.digest(options.candidates), budget: { ...runner.LIMITS } };
    if (options.profile.qualificationCanaries) options.approval.qualificationCanaryDigest = runner.digest(options.profile.qualificationCanaryPolicy);
  }
  approve();
  return { options, state, approve, now, advance: ms => { elapsed += ms; }, confirms: () => confirms };
}
function assertClosedGates(out) {
  assert.equal(out.complete, false); assert.equal(out.classSemantics.exact, false); assert.equal(out.coveragePromotion, false);
  assert.equal(out.dispatchEnabled, false); assert.equal(out.liveAdmission, false); assert.equal(out.baseGuardQualified, false); assert.equal(out.freshness, "UNKNOWN");
}
function sharedWitness(target, peer) {
  const classWitness = { schema: "aave-v4-base-shared-runtime-class/v1", chainId: 8453, target: target.address, peer: peer.address,
    codeKeccak256: peer.codeKeccak256, peerArtifactSha256: peer.sourceEvidenceSha256, classId: "EACAggregatorProxy", claim: "INTERFACE_ONLY_NO_PER_ADDRESS_PUBLICATION" };
  const reviewStatement = { schema: "aave-v4-base-shared-runtime-review/v1", classWitnessSha256: runner.digest(classWitness), conclusion: "ABI_ONLY_CURRENT_STATE_UNKNOWN" };
  return { ...target, evidenceKind: "SHARED_RUNTIME_CLASS", peerAddress: peer.address, codeKeccak256: peer.codeKeccak256,
    artifactJson: peer.artifactJson, sourceEvidenceSha256: peer.sourceEvidenceSha256, classWitness, classWitnessSha256: runner.digest(classWitness),
    reviewStatement, reviewStatementSha256: runner.digest(reviewStatement) };
}
function nativeFixture(mode = "ROOT_DISCOVERY") {
  const f = fixture(mode), { options, state } = f;
  for (const name of ["openCollection", "collectTopology", "collectBorrowers", "collectOracles"]) delete options[name];
  options.profile.qualificationCanaries = true;
  const archive = "reports/coverage-unblock-20261018/continuation/public-base-sources/";
  options.sourceProfile.roots = [contract.ORACLE, ...contract.FEEDS].map((at, i) => {
    if (i === 7) return { address: at };
    const artifactJson = fs.readFileSync(path.join(root, archive, i === 0 ? "oracle.json" : `feed-${i - 1}.json`), "utf8");
    const artifact = JSON.parse(artifactJson); state.codes[at] = artifact.runtimeBytecode.onchainBytecode;
    return { evidenceKind: "DIRECT_PUBLICATION", address: at, codeKeccak256: keccak256(state.codes[at]), artifactJson, sourceEvidenceSha256: hashBytes(artifactJson) };
  });
  const peer = options.sourceProfile.roots[1];
  options.sourceProfile.roots[7] = sharedWitness(options.sourceProfile.roots[7], peer);
  state.codes[contract.FEEDS[6]] = state.codes[contract.FEEDS[0]];
  const manifest = require("../aave-v4-base-role-evidence.json");
  const byRole = Object.fromEntries(manifest.roles.map(row => [row.role, row]));
  const artifactAbi = role => new Interface(JSON.parse(fs.readFileSync(path.join(root, byRole[role].abi.filePath), "utf8")).abi);
  const hub = artifactAbi("hub"), spoke = artifactAbi("lending"), treasury = artifactAbi("treasury"), tokenization = artifactAbi("tokenization");
  const token = new Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)",
    "function symbol() view returns(string)", "function name() view returns(string)"]);
  const strategy = new Interface(["function HUB() view returns(address)"]);
  // Explicit target-specific native scanner + L/O + fixed root selector lists.
  const hubNames = ["getAssetCount", "getAssetUnderlyingAndDecimals", "getAssetConfig", "getAssetLiquidity", "getAssetOwed", "getAssetTotalOwed",
    "getAssetDrawnShares", "getAssetDrawnIndex", "getAssetDrawnRate", "getAssetDeficitRay", "getAssetPremiumRay", "getAssetAccruedFees", "getAssetSwept",
    "isUnderlyingListed", "getSpokeCount", "getSpokeAddress", "isSpokeListed", "getSpokeConfig", "getSpokeAddedAssets", "getSpokeAddedShares",
    "getSpokeDrawnShares", "getSpokeOwed", "getSpokeTotalOwed", "getSpokeDeficitRay", "getSpokePremiumRay", "getSpokePremiumData", "authority"];
  const spokeNames = ["ORACLE", "MAX_USER_RESERVES_LIMIT", "getLiquidationConfig", "getReserveId", "getReserve", "getReserveConfig", "getDynamicReserveConfig",
    "getReserveSuppliedAssets", "getReserveDebt", "getReserveTotalDebt", "authority", "getUserAccountData", "getUserReserveStatus", "getUserSuppliedAssets", "getUserTotalDebt", "getUserPosition"];
  const interfaces = new Map(), selectors = {};
  const register = (at, iface, names) => { interfaces.set(at, iface); selectors[at] = names.map(name => {
    const fn = iface.getFunction(name); assert.ok(fn, `published function ${name}`); return fn.selector;
  }); };
  register(contract.HUB, hub, hubNames); register(contract.SPOKE, spoke, spokeNames);
  register(byRole.treasury.address, treasury, ["getSuppliedAssets", "getSuppliedShares", "owner", "pendingOwner"]);
  register(byRole.tokenization.address, tokenization, ["hub", "assetId", "asset", "totalAssets", "decimals"]);
  register(manifest.strategy.address, strategy, ["HUB"]);
  for (const at of contract.ASSETS) register(at, token, ["balanceOf", "decimals", "symbol", "name"]);
  for (const row of options.sourceProfile.roots) register(row.address, new Interface(JSON.parse(row.artifactJson).abi),
    [...new Set(runner.rootReads().filter(read => read.target === row.address).map(read => read.signature))]);
  options.sourceProfile.callSelectors = selectors;
  state.logs = []; state.nativeNames = []; state.historyScans = 0; state.postHistoryHeaders = 0;
  state.hook = async (method, params) => {
    if (state.nativeHook) { const answer = await state.nativeHook(method, params); if (answer !== undefined) return answer; }
    if (method === "eth_getStorageAt" && params[1] !== "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc") return H(0);
    if (method === "eth_getBlockByNumber" && params[0] === "0x9" && state.historyScans === 3) { state.postHistoryHeaders++; state.finalSeen = true; }
    if (method === "eth_getLogs" && params[0].fromBlock !== undefined) { state.historyScans++; return []; }
    if (method !== "eth_call") return undefined;
    const at = params[0].to.toLowerCase(), iface = interfaces.get(at); assert.ok(iface, "native call target in explicit profile");
    const parsed = iface.parseTransaction(params[0]); assert.ok(parsed);
    const n = parsed.name, i = parsed.args.length && typeof parsed.args[0] === "bigint" ? Number(parsed.args[0]) : 0;
    state.nativeNames.push({ at, name: n, args: Array.from(parsed.args, String) });
    const directory = [byRole.treasury.address, contract.SPOKE, ...(i === 7 ? [byRole.tokenization.address] : [])];
    const assetIndex = contract.ASSETS.indexOf(at), feedIndex = contract.FEEDS.indexOf(at);
    let values = {
      getAssetCount: [8], getAssetUnderlyingAndDecimals: [contract.ASSETS[i], i === 7 ? 6 : 8],
      getAssetConfig: [byRole.treasury.address, 100, manifest.strategy.address, A(0)],
      getAssetLiquidity: [0], getAssetOwed: [0, 0], getAssetTotalOwed: [0], getAssetDrawnShares: [0], getAssetDrawnIndex: [10n ** 27n], getAssetDrawnRate: [0],
      getAssetDeficitRay: [0], getAssetPremiumRay: [0], getAssetAccruedFees: [0], getAssetSwept: [0], isUnderlyingListed: [true],
      getSpokeCount: [directory.length], getSpokeAddress: [directory[Number(parsed.args.length > 1 ? parsed.args[1] : 0)]], isSpokeListed: [true],
      getSpokeConfig: [2n ** 40n - 1n, 2n ** 40n - 1n, 0, true, false], getSpokeAddedAssets: [0], getSpokeAddedShares: [0], getSpokeDrawnShares: [0],
      getSpokeOwed: [0, 0], getSpokeTotalOwed: [0], getSpokeDeficitRay: [0], getSpokePremiumRay: [0], getSpokePremiumData: [0, 0],
      ORACLE: [contract.ORACLE], authority: [validated.module.ACCESS_MANAGER], getReserveId: [Number(parsed.args.length > 1 ? parsed.args[1] : 0)],
      MAX_USER_RESERVES_LIMIT: [8], getLiquidationConfig: [10n ** 18n, 10n ** 18n, 10000], getReserve: [contract.ASSETS[i], contract.HUB, i, i === 7 ? 6 : 8, 0, 0, 2],
      getReserveConfig: [0, false, false, true, true], getDynamicReserveConfig: [6000, 10500, 100], getReserveSuppliedAssets: [0], getReserveDebt: [0, 0], getReserveTotalDebt: [0],
      getUserAccountData: [0, 0, 0, 0, 0, 0, 0], getUserReserveStatus: [false, false], getUserSuppliedAssets: [0], getUserTotalDebt: [0], getUserPosition: [0, 0, 0, 0, 7],
      getSuppliedAssets: [0], getSuppliedShares: [0], owner: [validated.module.ACCESS_MANAGER], pendingOwner: [A(0)], hub: [contract.HUB], assetId: [7], asset: [contract.ASSETS[7]], totalAssets: [0], HUB: [contract.HUB],
      balanceOf: [0], decimals: [assetIndex >= 0 ? assetIndex === 7 ? 6 : 8 : at === byRole.tokenization.address ? 6 : 8], name: ["Synthetic public token"], symbol: ["FIXTURE"],
      spoke: [contract.SPOKE], getReserveSource: [contract.FEEDS[i]], getReservePrice: [100000000], aggregator: [A(800 + feedIndex)], phaseId: [1], accessController: [A(900)], latestAnswer: [100000000],
      latestRoundData: [1, 100000000, state.pin.timestamp - 10, state.pin.timestamp - 10, 1], ASSET_TO_USD_AGGREGATOR: [A(807)], ACL_MANAGER: [A(901)], getPriceCap: [101000000],
    }[n];
    assert.ok(values, `native fake response ${n}`);
    if (parsed.fragment.outputs.length === 1 && parsed.fragment.outputs[0].baseType === "tuple") values = [values];
    return iface.encodeFunctionResult(parsed.fragment, values);
  };
  if (mode === "ROOT_DISCOVERY") options.historyStore = { load() { assert.fail("ROOT history load"); }, save() { assert.fail("ROOT history save"); } };
  else options.historyStore.save = async index => {
    assert.equal(state.postHistoryHeaders, 7, "checkpoint + L/O confirmations + FINAL two-family confirmation");
    assert.ok(state.calls.slice(-2).every(call => call.method === "eth_getBlockByNumber" && call.params[0] === "0x9"));
    state.saves.push(clone(index)); state.events.push("PERSIST");
  };
  f.approve("NATIVE"); return f;
}
test.beforeEach(t => { t.mock.method(global, "fetch", () => assert.fail("network prohibited")); });

test("imports and default/check CLI require no ambient providers, files, network or writes", async () => {
  const script = `const M=require('node:module'),old=M._load;M._load=function(n,...a){if(/shared-rpc|pinned-collection|admit-aave|borrower-history|node:fs/.test(n))throw Error('ambient load');return old.call(this,n,...a)};const r=require('./tools/observe-aave-v4-base');r.runCli(['--check']).then(x=>console.log(JSON.stringify(x)));`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).networkCalls, 0);
  const cli = spawnSync(process.execPath, ["tools/observe-aave-v4-base.js", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).writes, 0);
  assert.deepEqual((await runner.runCli(["--capture"])).errors, ["APPROVAL_REQUIRED"]);
});
test("NATIVE ROOT uses both frozen constructors: four stage-bound canaries, 66 roots, eight actual publications, no history/children", async t => {
  const f = nativeFixture(), out = await runner.observeBase(f.options);
  for (const key of ["openCollection", "collectTopology", "collectBorrowers", "collectOracles"]) assert.equal(Object.hasOwn(f.options, key), false);
  assert.equal(out.status, "OBSERVED", JSON.stringify({ out, error: f.state.rpcError?.stack })); assertClosedGates(out);
  assert.equal(out.counts.rootReadOperations, 66); assert.equal(out.counts.qualificationCanaryDispatches, 4);
  const logs = f.state.calls.filter(call => call.method === "eth_getLogs"); assert.equal(logs.length, 4);
  assert.ok(logs.every(call => Object.keys(call.params[0]).sort().join() === "address,blockHash,topics" && call.params[0].address === contract.HUB));
  assert.equal(out.components.borrowers.status, "NOT_COLLECTED"); assert.equal(out.historyPublished, false);
  assert.equal(new Set(f.options.sourceProfile.roots.map(row => row.sourceEvidenceSha256)).size, 8);
  const evidence = out.components.roots.evidence.find(row => row.target === contract.FEEDS[6]);
  assert.equal(evidence.perAddressPublication, false); assert.equal(evidence.publicationAddress, contract.FEEDS[0]); assert.equal(evidence.currentConfig, "UNKNOWN");
  assert.equal(out.counts.physical.actualDispatches, f.state.calls.length);
  assert.ok(f.state.calls.filter(call => call.method === "eth_call").every(call => [contract.HUB, contract.SPOKE, contract.ORACLE, ...contract.FEEDS].includes(call.params[0].to)));
  assert.equal(f.state.calls.filter(call => call.method === "eth_call" && call.params[0].to === contract.FEEDS[7] && call.params[0].data.startsWith(id("latestRoundData()").slice(0, 10))).length, 0);
  t.diagnostic(JSON.stringify({ nativeRootPhysical: out.counts.physical.actualDispatches, nativeRootOperations: out.counts.wholeContext.stateReadOperations,
    rootLogical: out.counts.rootReadOperations, qualificationCanaries: out.counts.qualificationCanaryDispatches }));
});
test("NATIVE FULL uses unmodified topology scanner + real L/O, complete zero-debt genesis, final confirmation before cache", async t => {
  const f = nativeFixture("FULL_L_O"), out = await runner.observeBase(f.options);
  for (const key of ["openCollection", "collectTopology", "collectBorrowers", "collectOracles"]) assert.equal(Object.hasOwn(f.options, key), false);
  assert.equal(out.status, "OBSERVED", JSON.stringify({ out, error: f.state.rpcError?.stack, elapsed: f.now() - NOW })); assertClosedGates(out);
  assert.equal(out.attestations.topology.stateReadsPinned, 34); assert.equal(out.counts.topologyLogicalReads, 34);
  assert.equal(out.components.topology.hubs[0].assets.length, 8); assert.equal(out.components.borrowers.fullHistoryProven, true);
  assert.equal(out.components.borrowers.users.length, 0); assert.equal(out.components.borrowers.debtAccounting, "PASS");
  assert.equal(out.components.oracles.wiringObserved, true); assert.equal(out.components.oracles.freshness, "UNKNOWN");
  assert.equal(f.state.saves.length, 1); assert.equal(out.historyPublished, true); assert.equal(out.counts.qualificationCanaryDispatches, 4);
  assert.ok(out.attestations.wholeContext.stateReadsPinned > 34); assert.equal(out.counts.physical.actualDispatches, f.state.calls.length);
  for (const name of ["getAssetConfig", "getSpokeConfig", "getReserve", "getDynamicReserveConfig", "getSuppliedAssets", "totalAssets", "HUB", "authority", "symbol"]) assert.ok(f.state.nativeNames.some(row => row.name === name), name);
  assert.doesNotMatch(JSON.stringify(out), /SENTINEL_SECRET/);
  t.diagnostic(JSON.stringify({ nativeFullPhysical: out.counts.physical.actualDispatches, wholeContextOperations: out.counts.wholeContext.stateReadOperations,
    topologyLogical: out.counts.topologyLogicalReads, borrowerReads: out.counts.borrowerStateReads, oracleReads: out.counts.oracleStateReads,
    cacheHits: out.counts.wholeContext.stateCacheHits, historyWindows: f.state.historyScans, qualificationCanaries: out.counts.qualificationCanaryDispatches }));
});
test("native canaries bind each candidate's own finalized header, then the independently corroborated numeric common header", async () => {
  const f = nativeFixture(), transport = f.options.transport, second = f.options.candidates[1].handle;
  f.options.profile.qualificationCanaryPolicy.minBlock = 8;
  f.options.transport = async (handle, method, params, ...rest) => {
    const value = await transport(handle, method, params, ...rest);
    if (handle === second && method === "eth_getBlockByNumber" && params[0] === "finalized") return { ...value, number: "0x8", hash: H(8), parentHash: H(7) };
    return value;
  };
  f.approve("NATIVE"); const out = await runner.observeBase(f.options);
  assert.equal(out.status, "OBSERVED", JSON.stringify(out)); assert.equal(out.attestations.wholeContext.blockNumber, 8);
  const canaries = f.state.calls.filter(call => call.method === "eth_getLogs");
  assert.deepEqual(canaries.filter(call => call.handle !== second).map(call => call.params[0].blockHash), [H(9), H(8)]);
  assert.deepEqual(canaries.filter(call => call.handle === second).map(call => call.params[0].blockHash), [H(8), H(8)]);
  assert.equal(out.counts.qualificationCanaryDispatches, 4);
});
test("new canary fields/interval/counts require matching approval, profile and source digests before transport", async () => {
  for (const mutate of [f => { delete f.options.approval.qualificationCanaryDigest; }, f => { delete f.options.sourceProfile.qualificationCanaryDigest; },
    f => { f.options.profile.qualificationCanaryPolicy.minBlock = 8; }, f => { f.options.profile.qualificationCanaryPolicy.maxPerCandidate = 3; f.approve("NATIVE"); },
    f => { f.options.profile.qualificationCanaryPolicy.maxTotal = 5; f.approve("NATIVE"); }, f => { f.options.profile.qualificationCanaryPolicy.minBlock = 10; f.approve("NATIVE"); },
    f => { f.options.profile.qualificationCanaryPolicy.topic = event.getEvent("Borrow").topicHash; f.approve("NATIVE"); }]) {
    const f = nativeFixture(); mutate(f); const out = await runner.observeBase(f.options);
    assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.calls.length, 0);
  }
});
test("wrong canary stage/address/topic/hash/extra keys/numeric rewrite are refused before prohibited physical dispatch", async () => {
  const zero = { address: contract.HUB, blockHash: H(9), topics: [H(0)] };
  const probe = async (rpc, handle) => {
    const at = { blockHash: H(9), requireCanonical: true };
    await rpc(handle, "eth_getCode", [contract.HUB, at]); await rpc(handle, "eth_getStorageAt", [contract.HUB, H(0), at]);
    await rpc(handle, "eth_call", [{ to: contract.HUB, data: id("getAssetCount()").slice(0, 10) }, at]);
  };
  const initial = async (rpc, handle) => { await rpc(handle, "eth_chainId", []); await rpc(handle, "eth_getBlockByNumber", ["finalized", false]); await probe(rpc, handle); };
  async function run(sequence, expectedCanaries) {
    const f = fixture("ROOT_DISCOVERY"); f.options.profile.qualificationCanaries = true;
    f.options.openCollection = async ({ rpc }) => { await sequence(rpc, f.options.candidates.map(c => c.handle)); throw new Error("sequence must refuse"); };
    f.approve(); const out = await runner.observeBase(f.options);
    assert.equal(out.status, "INCOMPLETE");
    assert.equal(f.state.calls.filter(call => call.method === "eth_getLogs").length, expectedCanaries);
    assert.equal(out.partialPhysicalCounts.qualificationCanaryDispatches, expectedCanaries);
    assert.ok(out.errors.some(code => ["QUALIFICATION_CANARY_REFUSED", "QUALIFICATION_HEADER_INVALID"].includes(code)), JSON.stringify(out));
  }
  for (const change of [f => { f.address = contract.SPOKE; }, f => { f.address = [contract.HUB]; }, f => { f.topics = [event.getEvent("Borrow").topicHash]; },
    f => { f.blockHash = H(8); }, f => { f.fromBlock = "0x9"; }, f => { delete f.blockHash; f.fromBlock = "0x9"; f.toBlock = "0x9"; },
    f => { f.extra = true; }]) await run(async (rpc, [handle]) => { await initial(rpc, handle); const filter = clone(zero); change(filter); await rpc(handle, "eth_getLogs", [filter]); }, 0);
  await run(async (rpc, [handle]) => { await rpc(handle, "eth_getLogs", [zero]); }, 0);
  await run(async (rpc, [handle]) => { await initial(rpc, handle); await rpc(handle, "eth_getLogs", [zero]); await rpc(handle, "eth_getLogs", [zero]); }, 1);
  // Common-stage evidence for only one family is insufficient.
  await run(async (rpc, handles) => {
    for (const handle of handles) { await initial(rpc, handle); await rpc(handle, "eth_getLogs", [zero]); }
    const handle = handles[0]; await rpc(handle, "eth_chainId", []); await rpc(handle, "eth_getBlockByNumber", ["finalized", false]);
    await rpc(handle, "eth_getBlockByNumber", ["0x9", false]); await probe(rpc, handle); await rpc(handle, "eth_getLogs", [zero]);
  }, 2);
  // Even a valid second-stage dispatch cannot be replayed as a third canary.
  await run(async (rpc, handles) => {
    for (const handle of handles) { await initial(rpc, handle); await rpc(handle, "eth_getLogs", [zero]); }
    for (const handle of handles) { await rpc(handle, "eth_chainId", []); await rpc(handle, "eth_getBlockByNumber", ["finalized", false]); await rpc(handle, "eth_getBlockByNumber", ["0x9", false]); }
    await probe(rpc, handles[0]); await rpc(handles[0], "eth_getLogs", [zero]); await rpc(handles[0], "eth_getLogs", [zero]);
  }, 3);
});
test("invalid/out-of-interval/query-mismatched qualification headers cannot authorize a canary", async () => {
  for (const kind of ["range", "stateRoot", "timestamp", "numeric-query"]) {
    const f = nativeFixture(), transport = f.options.transport;
    f.options.transport = async (handle, method, params, ...rest) => {
      const value = await transport(handle, method, params, ...rest);
      if (method !== "eth_getBlockByNumber") return value;
      if (kind === "range") return { ...value, number: "0xa", hash: H(10) };
      if (kind === "stateRoot") return { ...value, stateRoot: H(0) };
      if (kind === "timestamp") return { ...value, timestamp: HEX(NOW / 1000 + 3600) };
      return params[0] === "0x9" ? { ...value, number: "0x8", hash: H(8) } : value;
    };
    const out = await runner.observeBase(f.options); assert.equal(out.status, "INCOMPLETE");
    assert.equal(f.state.calls.filter(call => call.method === "eth_getLogs").length, kind === "numeric-query" ? 2 : 0);
    assert.equal(out.attestations.wholeContext, null);
  }
});
test("shared runtime evidence cannot rewrite the peer publication, widen the peer class, or bypass current target runtime", async () => {
  for (const mutate of [f => { f.options.sourceProfile.roots[7].peerAddress = contract.FEEDS[1]; },
    f => { f.options.sourceProfile.roots[7].classWitnessSha256 = "0".repeat(64); },
    f => { f.options.sourceProfile.roots[7].reviewStatement.conclusion = "FRESH"; },
    f => { const row = f.options.sourceProfile.roots[7], artifact = JSON.parse(row.artifactJson); artifact.address = contract.FEEDS[6]; row.artifactJson = JSON.stringify(artifact); row.sourceEvidenceSha256 = hashBytes(row.artifactJson); },
    f => { const peer = f.options.sourceProfile.roots[1], artifact = JSON.parse(peer.artifactJson); artifact.address = contract.FEEDS[6];
      peer.artifactJson = JSON.stringify(artifact); peer.sourceEvidenceSha256 = hashBytes(peer.artifactJson); f.options.sourceProfile.roots[7] = sharedWitness(f.options.sourceProfile.roots[7], peer); },
    f => { const peer = f.options.sourceProfile.roots[1], artifact = JSON.parse(peer.artifactJson);
      artifact.abi.find(fn => fn.name === "latestRoundData").outputs[0].type = "uint256";
      peer.artifactJson = JSON.stringify(artifact); peer.sourceEvidenceSha256 = hashBytes(peer.artifactJson); f.options.sourceProfile.roots[7] = sharedWitness(f.options.sourceProfile.roots[7], peer); }]) {
    const f = nativeFixture(); mutate(f); f.approve("NATIVE"); const out = await runner.observeBase(f.options);
    assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.calls.length, 0);
  }
  const f = nativeFixture(); f.state.codes[contract.FEEDS[6]] = "0x6000";
  const out = await runner.observeBase(f.options); assert.deepEqual(out.errors, ["CURRENT_BINDING_FAILED"]);
  assert.equal(f.state.nativeNames.filter(row => row.at !== contract.HUB).length, 0, "no root reads before current shared-runtime inventory match");
});
test("a qualification canary cannot be replayed in ROOT STATE, even with an otherwise valid approved profile", async () => {
  const f = fixture("ROOT_DISCOVERY"); f.options.profile.qualificationCanaries = true;
  f.options.openCollection = async args => {
    const context = await require("../lib/aave-v4-pinned-collection").openPinnedCollection(args);
    return { ...context, provider: { ...context.provider, async call(tx) {
      await args.rpc(f.options.candidates[0].handle, "eth_getLogs", [{ address: contract.HUB, blockHash: H(9), topics: [H(0)] }]);
      return context.provider.call(tx);
    } } };
  };
  f.approve(); const out = await runner.observeBase(f.options);
  assert.equal(out.status, "INCOMPLETE"); assert.deepEqual(out.errors, ["HISTORY_POLICY_REFUSED"]);
  assert.equal(f.state.calls.filter(call => call.method === "eth_getLogs").length, 4);
  assert.equal(out.partialPhysicalCounts.qualificationCanaryDispatches, 4);
});
test("native FULL late physical/terminal failure discards staged history and every component attestation", async () => {
  for (const kind of ["physical", "terminal"]) {
    const f = nativeFixture("FULL_L_O");
    f.state.nativeHook = async (method, params) => {
      if (method === "eth_getBlockByNumber" && params[0] === "0x9" && f.state.postHistoryHeaders === 5) {
        if (kind === "physical") throw new Error("SENTINEL_SECRET_NATIVE_LATE");
        return { number: "0x9", hash: H(999), stateRoot: H(900), parentHash: H(8), timestamp: HEX(f.state.pin.timestamp) };
      }
    };
    const out = await runner.observeBase(f.options); assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.saves.length, 0);
    assert.equal(f.state.historyScans, 3); assert.ok(Object.values(out.components).every(value => value === null));
    assert.ok(Object.values(out.attestations).every(value => value === null)); assert.equal(out.partialPhysicalCounts.activeRequests, 0);
    assert.doesNotMatch(JSON.stringify(out), /SENTINEL_SECRET/);
  }
});
test("missing/expired/wrong-chain/scope/mode/budget/candidate approvals refuse before any transport", async () => {
  for (const mutate of [f => { delete f.options.approval; }, f => { f.options.approval.expiresAtMs = NOW; },
    f => { f.options.approval.chainId = 1; }, f => { f.options.approval.scopeSha256 = "0".repeat(64); },
    f => { f.options.approval.targetCount = 39; }, f => { f.options.approval.mode = "OTHER"; },
    f => { f.options.approval.status = "APPROVED"; }, f => { f.options.approval.attemptStarted = false; },
    f => { f.options.approval.budget.maxRequests = 12001; }, f => { f.options.approval.budget.paceMs = 249; },
    f => { f.options.approval.budget.timeoutMs = 10001; }, f => { f.options.approval.budget.concurrency = 5; },
    f => { f.options.candidates.push({ handle: "NOT_APPROVED" }); }, f => { delete f.options.transport; }]) {
    const f = fixture(); mutate(f); const out = await runner.observeBase(f.options);
    assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.calls.length, 0); assert.equal(f.state.saves.length, 0); assertClosedGates(out);
  }
});
test("native zero-log ROOT refuses before transport; test injection is never admitted as NATIVE", async () => {
  const f = fixture("ROOT_DISCOVERY"); delete f.options.openCollection; f.approve("NATIVE");
  const out = await runner.observeBase(f.options);
  assert.deepEqual(out.errors, ["NATIVE_ROOT_ZERO_LOG_UNSUPPORTED"]); assert.equal(f.state.calls.length, 0);
  const g = fixture(); g.approve("NATIVE");
  assert.deepEqual((await runner.observeBase(g.options)).errors, ["APPROVAL_INVALID"]); assert.equal(g.state.calls.length, 0);
});
test("source/code/profile digest mismatches refuse before any transport", async () => {
  for (const mutate of [f => { f.options.profile.roots = true; }, f => { f.options.sourceProfile.roots[0].artifactJson += " "; f.approve(); },
    f => { f.options.sourceProfile.codeHashes[runner.CODE_FILES[0]] = "b".repeat(64); f.approve(); },
    f => { f.options.sourceProfile.semanticEvidence = { semanticDescriptors: [{ address: contract.FEEDS[7], sourceEvidence: { review: { statement: { child: A(807) } } } }] }; f.approve(); }]) {
    const f = fixture(); mutate(f); const out = await runner.observeBase(f.options);
    assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.calls.length, 0);
  }
});
test("ROOT fixture reads exact nine source-known roots, no logs or child following; ACL controls are separate", async () => {
  const f = fixture("ROOT_DISCOVERY"), out = await runner.observeBase(f.options);
  assert.equal(out.status, "OBSERVED", JSON.stringify({ out, rpcError: f.state.rpcError?.stack })); assert.equal(out.closed, true); assertClosedGates(out);
  assert.equal(f.state.calls.filter(c => c.method === "eth_getLogs").length, 0);
  assert.equal(out.components.borrowers.status, "NOT_COLLECTED"); assert.equal(out.creationHistory, "UNKNOWN");
  assert.equal(out.components.roots.priceChildCandidates.length, 8); assert.deepEqual(out.components.roots.controlAddresses, [A(900), A(901)]);
  assert.equal(out.components.roots.freshness, "UNKNOWN"); assert.equal(out.components.roots.sourceSemanticsQualified, false);
  assert.equal(f.state.calls.filter(c => c.method === "eth_call").length, runner.rootReads().length);
  assert.ok(f.state.calls.filter(c => c.method === "eth_call").every(c => [contract.SPOKE, contract.ORACLE, ...contract.FEEDS].includes(c.params[0].to)));
  assert.equal(f.state.calls.filter(c => c.method === "eth_call" && c.params[0].to === contract.FEEDS[7] && c.params[0].data.startsWith(id("latestRoundData()").slice(0, 10))).length, 0);
  assert.doesNotMatch(JSON.stringify(out), /SENTINEL_SECRET/);
});
test("fresh inventory/current pointers bind opaque roles; raw native-shaped topology reaches real L/O on the identical context", async () => {
  const f = fixture(), out = await runner.observeBase(f.options);
  assert.equal(out.status, "OBSERVED", JSON.stringify({ out, rpcError: f.state.rpcError?.stack, l: f.state.l, o: f.state.o, raw: !!f.state.raw, confirms: f.confirms() })); assert.equal(f.confirms(), 4); assertClosedGates(out);
  assert.equal(f.state.saves.length, 1); assert.equal(out.historyPublished, true);
  assert.equal(f.state.loaded.throughBlock, -1, "load was deep-cloned before collector mutation");
  assert.equal(f.state.saves[0].throughBlock, 9); assert.equal(f.state.saves[0].users[contract.SPOKE][0].user, A(42));
  assert.equal(out.attestations.topology.stateReadsPinned, 34); assert.equal(out.counts.topologyLogicalReads, 34);
  assert.equal(out.attestations.borrowers.stateReadsPinned, f.state.l.stateReads.attempted);
  assert.equal(out.attestations.oracles.stateReadsPinned, f.state.o.stateReads.attempted);
  assert.ok(out.attestations.wholeContext.stateReadsPinned > 34); assert.notEqual(out.attestations.wholeContext.stateReadsPinned, out.attestations.topology.stateReadsPinned);
  assert.ok(out.counts.wholeContext.stateCacheHits > 0); assert.equal(out.counts.physical.actualDispatches, f.state.calls.length);
  assert.equal(out.components.oracles.freshness, "UNKNOWN"); assert.equal(out.components.oracles.sourceSemanticsQualified, false);
  assert.equal(out.components.borrowers.users[0].reserves.length, 8);
  assert.ok(out.components.borrowers.users[0].reserves.every(row => row.dynamicConfig.key === 7));
  assert.doesNotMatch(JSON.stringify(out), /SENTINEL_SECRET|https?:/);
  assert.ok(f.state.calls.every((c, i, all) => !i || c.time - all[i - 1].time >= 250));
  const countBefore = f.state.calls.length;
  await assert.rejects(f.state.context.provider.call({ to: contract.ORACLE, data: oracles.ABI.encodeFunctionData("getReservePrice", [0]) }), { code: "RUN_CLOSED" });
  assert.equal(f.state.calls.length, countBefore);
});
test("bad or incomplete 38-address inventory/current proxy pointers prevents topology and bindings", async () => {
  for (const mutate of [f => { delete f.state.codes[validated.allowedAddresses[37]]; },
    f => { f.state.hook = async (m, p) => m === "eth_getStorageAt" && p[1] !== H(0) ? H(999) : undefined; }]) {
    const f = fixture(); mutate(f); const out = await runner.observeBase(f.options);
    assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.raw, undefined); assert.equal(f.state.saves.length, 0); assert.equal(out.components.topology, null);
  }
});
test("sanitized metadata/C5-shaped or wrong-count topology cannot be revived with a whole-context attestation", async () => {
  for (const mutate of [raw => { raw.chain.timestamp = "METADATA_OMITTED"; }, raw => { raw.sourceCoverage.observationPin.stateReadsPinned = 683; }]) {
    const f = fixture(), collect = f.options.collectTopology;
    f.options.collectTopology = async args => { const raw = await collect(args); mutate(raw); return raw; };
    const out = await runner.observeBase(f.options); assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.l, undefined);
    assert.equal(f.state.saves.length, 0); assert.equal(out.attestations.wholeContext, null);
  }
});
test("history is only MAG7 Borrow USER, contiguous bounded numeric windows <= one finalized pin", async () => {
  const f = fixture(), out = await runner.observeBase(f.options); assert.equal(out.status, "OBSERVED");
  const numeric = f.state.calls.filter(c => c.method === "eth_getLogs" && c.params[0].fromBlock !== undefined);
  assert.deepEqual(numeric.map(c => [c.params[0].fromBlock, c.params[0].toBlock]), [["0x0", "0x3"], ["0x4", "0x7"], ["0x8", "0x9"]]);
  for (const c of numeric) { assert.deepEqual(c.params[0].address, [contract.SPOKE]); assert.deepEqual(c.params[0].topics, [event.getEvent("Borrow").topicHash]); }
  assert.equal(f.state.saves[0].identity.chainId, 8453); assert.equal(f.state.saves[0].identity.namespace, "aave-v4-base-borrower-history/v1");
});
test("history wrong address/topic/range/span/gap or disabled log attempts never dispatch", async () => {
  for (const change of [f => { f.address = [contract.HUB]; }, f => { f.topics = [H(4)]; }, f => { f.toBlock = 10; },
    f => { f.toBlock = 5; }, f => { f.fromBlock = 1; }, f => { f.fromBlock = "latest"; }]) {
    const f = fixture(); let before;
    f.options.collectBorrowers = async (raw, deps) => {
      before = f.state.calls.length;
      const filter = { address: [contract.SPOKE], topics: [event.getEvent("Borrow").topicHash], fromBlock: 0, toBlock: 3 }; change(filter);
      await deps.context.provider.getLogs(filter); throw new Error("must refuse");
    };
    const out = await runner.observeBase(f.options); assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.calls.length, before); assert.equal(f.state.saves.length, 0);
  }
  const f = fixture("ROOT_DISCOVERY"), open = f.options.openCollection;
  f.options.openCollection = async args => { await args.rpc(f.options.candidates[0].handle, "eth_getLogs", [{ address: contract.SPOKE, topics: [event.getEvent("Borrow").topicHash], fromBlock: "0x0", toBlock: "0x0" }]); return open(args); };
  assert.equal((await runner.observeBase(f.options)).status, "INCOMPLETE"); assert.equal(f.state.calls.length, 0);
});
test("malformed/duplicate/removed logs and result/user caps invalidate the whole run and staged history", async () => {
  for (const mutate of [f => { f.state.logs[0].removed = true; }, f => { f.state.logs.push(clone(f.state.logs[0])); },
    f => { f.state.logs[0].topics[0] = H(4); }, f => { f.options.profile.history.maxLogs = 1; f.approve(); },
    f => { const next = clone(f.state.logs[0]); const encoded = event.encodeEventLog(event.getEvent("Borrow"), [7, A(41), A(43), 1, 10]);
      Object.assign(next, encoded, { transactionHash: H(502), logIndex: "0x1" }); f.state.logs.push(next); f.options.profile.history.maxUsers = 1; f.approve(); }]) {
    const f = fixture(); mutate(f); const out = await runner.observeBase(f.options);
    assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.saves.length, 0); assert.equal(out.components.borrowers, null); assert.equal(out.attestations.wholeContext, null);
  }
});
test("pending unawaited provider work drains before final confirmation/persistence", async () => {
  const f = fixture(), collect = f.options.collectOracles;
  let release, started;
  const pending = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.options.collectOracles = async (raw, deps) => {
    const out = await collect(raw, deps);
    f.state.hook = async (method, params) => { if (method === "eth_call" && params[0].data === oracles.ABI.encodeFunctionData("getReservePrice", [99])) {
      started(); await gate; return H(100); } };
    void deps.context.provider.call({ to: contract.ORACLE, data: oracles.ABI.encodeFunctionData("getReservePrice", [99]) }); return out;
  };
  const running = runner.observeBase(f.options); await pending;
  assert.equal(f.confirms(), 3); assert.equal(f.state.saves.length, 0); release();
  const out = await running; assert.equal(out.status, "OBSERVED", JSON.stringify(out)); assert.equal(f.confirms(), 4); assert.equal(f.state.saves.length, 1);
  assert.equal(out.counts.wholeContext.stateReadOperations, out.attestations.wholeContext.stateReadsPinned);
});
test("late physical/terminal failures invalidate ALL artifacts and discard buffered history", async () => {
  for (const kind of ["physical", "terminal", "component-terminal"]) {
    const f = fixture(), collect = f.options.collectOracles;
    f.options.collectOracles = async (raw, deps) => {
      const out = await collect(raw, deps);
      if (kind === "terminal") f.state.terminalFail = true;
      if (kind === "component-terminal") { out.terminalPinConfirmed = false; out.observationPin = null; }
      if (kind === "physical") {
        f.state.hook = async (method, params) => { if (method === "eth_call" && params[0].data === oracles.ABI.encodeFunctionData("getReservePrice", [99])) throw new Error("SENTINEL_SECRET_LATE"); };
        void deps.context.provider.call({ to: contract.ORACLE, data: oracles.ABI.encodeFunctionData("getReservePrice", [99]) });
      }
      return out;
    };
    const out = await runner.observeBase(f.options); assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.saves.length, 0);
    assert.ok(Object.values(out.components).every(value => value === null)); assert.ok(Object.values(out.attestations).every(value => value === null));
    assert.equal(out.partialPhysicalCounts.activeRequests, 0); assert.doesNotMatch(JSON.stringify(out), /SENTINEL_SECRET/);
  }
});
test("unknown policies and partial history never open gates or publish a buffered partial cache", async () => {
  const f = fixture(); f.options.profile.history.maxChunks = 1; f.approve();
  const out = await runner.observeBase(f.options); assert.equal(out.status, "OBSERVED_PARTIAL", JSON.stringify(out)); assertClosedGates(out);
  assert.equal(out.historyPublished, false); assert.equal(f.state.saves.length, 0); assert.equal(out.components.borrowers.fullHistoryProven, false);
  assert.equal(out.components.oracles.freshness, "UNKNOWN"); assert.equal(out.attestations.topology.stateReadsPinned, 34);
});
test("whole-context counter drift cannot masquerade as a clean physical guard ledger", async () => {
  const f = fixture(), open = f.options.openCollection;
  f.options.openCollection = async args => { const context = await open(args); return { ...context,
    statistics: () => ({ ...context.statistics(), networkCalls: context.statistics().networkCalls + 1 }) }; };
  const out = await runner.observeBase(f.options);
  assert.deepEqual(out.errors, ["COUNTERS_INVALID"]); assert.equal(f.state.saves.length, 0);
  assert.ok(Object.values(out.components).every(value => value === null)); assert.equal(out.attestations.wholeContext, null);
});
test("the history commit is after guard closure; store failure cannot publish component artifacts", async () => {
  const f = fixture(); let attempts = 0;
  f.options.historyStore.save = async () => {
    attempts++; const before = f.state.calls.length;
    await assert.rejects(f.state.context.provider.getCode(contract.SPOKE), { code: "RUN_CLOSED" });
    assert.equal(f.state.calls.length, before); assert.equal(f.confirms(), 4);
    throw new Error("SENTINEL_SECRET_STORE");
  };
  const out = await runner.observeBase(f.options); assert.equal(attempts, 1); assert.deepEqual(out.errors, ["HISTORY_COMMIT_FAILED"]);
  assert.equal(out.historyPublished, false); assert.ok(Object.values(out.components).every(value => value === null));
  assert.doesNotMatch(JSON.stringify(out), /SENTINEL_SECRET/);
});
test("expiry, scope/selector violations and sentinel input/error/pin metadata never leak or create proof", async () => {
  for (const action of [async (f, deps) => { f.advance(240000); await deps.context.confirmPin(); },
    async (f, deps) => { await deps.context.provider.getCode(A(999)); },
    async (f, deps) => { await deps.context.provider.call({ to: contract.ORACLE, data: id("SENTINEL_SECRET_SELECTOR()").slice(0, 10) }); },
    async () => { throw { message: "SENTINEL_SECRET_ERROR", headers: { authorization: "SENTINEL_SECRET_AUTH" }, cause: "https://secret.invalid" }; }]) {
    const f = fixture(), collect = f.options.collectOracles;
    f.options.collectOracles = async (raw, deps) => { await collect(raw, deps); await action(f, deps); };
    const out = await runner.observeBase(f.options); assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.saves.length, 0);
    assert.doesNotMatch(JSON.stringify(out), /SENTINEL_SECRET|https?:/); assert.equal(out.attestations.wholeContext, null);
  }
});
