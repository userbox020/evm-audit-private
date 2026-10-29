"use strict";

// Production reserve helper and pinned four-slot adapter; no network, inventory,
// real clocks, scanner CLI or report writes. Latencies below are virtual units.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Interface, id } = require("ethers");
const scanner = require("../scan-aave-v4-hubs");
const { openPinnedCollection, CollectionError } = require("../lib/aave-v4-pinned-collection");
const { REVIEWED_OPERATOR_FAMILY_IDS } = require("../lib/common-finalized-rpc-preflight");
test.beforeEach(t => t.mock.method(global, "fetch", () => assert.fail("network forbidden")));
const NOW = Date.parse("2026-10-18T07:00:00Z");
const A = n => "0x" + BigInt(n).toString(16).padStart(40, "0");
const W = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const TOKEN = A(10), STRATEGY = A(11), SPOKE = A(12), ORACLE = A(13), SOURCE = A(14);
const HUBS = scanner.loadAaveV4EthereumRegistry().hubs, HUB = HUBS[0].address;
const DISCOVERY = ["getReserveId", "ORACLE", "MAX_USER_RESERVES_LIMIT", "getLiquidationConfig"];
const RESERVE = ["getReserve", "getReserveConfig", "getReserveSuppliedAssets", "getReserveDebt", "getReserveTotalDebt"];
const ORACLE_READS = ["decimals", "spoke", "getReserveSource", "getReservePrice"];
const OLD_ORDER = [...DISCOVERY, ...RESERVE, "getDynamicReserveConfig", ...ORACLE_READS];
const ABI = new Interface([
  "function getReserveId(address,uint256) view returns(uint256)", "function ORACLE() view returns(address)",
  "function MAX_USER_RESERVES_LIMIT() view returns(uint16)", "function getLiquidationConfig() view returns(uint128,uint64,uint16)",
  "function getReserve(uint256) view returns(address,address,uint16,uint8,uint24,uint8,uint32)",
  "function getReserveConfig(uint256) view returns(uint24,bool,bool,bool,bool)",
  "function getDynamicReserveConfig(uint256,uint32) view returns(uint16,uint32,uint16)",
  "function getReserveSuppliedAssets(uint256) view returns(uint256)", "function getReserveDebt(uint256) view returns(uint256,uint256)",
  "function getReserveTotalDebt(uint256) view returns(uint256)", "function decimals() view returns(uint8)",
  "function spoke() view returns(address)", "function getReserveSource(uint256) view returns(address)",
  "function getReservePrice(uint256) view returns(uint256)",
  "function getAssetCount() view returns(uint256)", "function getAssetUnderlyingAndDecimals(uint256) view returns(address,uint8)",
  "function isUnderlyingListed(address) view returns(bool)", "function isSpokeListed(uint256,address) view returns(bool)",
  "function symbol() view returns(string)", "function name() view returns(string)", "function balanceOf(address) view returns(uint256)",
  "function getAssetTotalOwed(uint256) view returns(uint256)",
  ...["getAssetLiquidity", "getAssetOwed", "getAssetDrawnShares", "getAssetDrawnIndex", "getAssetDrawnRate",
    "getAssetDeficitRay", "getAssetPremiumRay", "getAssetAccruedFees", "getAssetSwept"].map(n => `function ${n}(uint256) view returns(uint256)`),
  "function getSpokeCount(uint256) view returns(uint256)", "function getSpokeAddress(uint256,uint256) view returns(address)",
  "function getSpokeConfig(uint256,address) view returns(uint40,uint40,uint24,bool,bool)",
  ...["getSpokeAddedAssets", "getSpokeAddedShares", "getSpokeDrawnShares", "getSpokeOwed", "getSpokeTotalOwed",
    "getSpokeDeficitRay", "getSpokePremiumRay"].map(n => `function ${n}(uint256,address) view returns(uint256)`),
  "function HUB() view returns(address)", "function owner() view returns(address)", "function authority() view returns(address)",
  "function getSuppliedAssets(address,address) view returns(uint256)", "function getSuppliedShares(address,address) view returns(uint256)",
  "function pendingOwner() view returns(address)", "function hub() view returns(address)", "function assetId() view returns(uint256)",
  "function asset() view returns(address)", "function totalAssets() view returns(uint256)",
]);
const CONFIG = id("getAssetConfig(uint256)").slice(0, 10);
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  let tick = 0, scheduled = false, active = 0, maxActive = 0, stage = "QUALIFICATION", context;
  const pending = [], starts = [], finishes = [], stages = [];
  const chainId = options.chainId || 1;
  const baseFact = options.baseFact;
  const hub = baseFact?.hub || HUB, spoke = baseFact?.spoke || SPOKE, token = baseFact?.token || TOKEN;
  const header = () => ({ number: "0x64", hash: options.terminalMismatch && stage === "PIN_CONFIRMATION" ? W(999) : W(101),
    parentHash: W(100), stateRoot: W(900), timestamp: "0x" + (NOW / 1000 - 600).toString(16) });
  function response(method, params) {
    if (method === "eth_chainId") return "0x" + chainId.toString(16);
    if (method === "eth_getBlockByNumber") return header();
    if (method === "eth_getLogs") return [];
    if (method === "eth_getCode") return "0x60016000";
    if (method === "eth_getStorageAt") return W(0);
    assert.equal(method, "eth_call");
    const tx = params[0];
    assert.deepEqual(Object.keys(tx).sort(), ["data", "to"]);
    assert.deepEqual(params[1], { blockHash: W(101), requireCanonical: true });
    if (tx.data.startsWith(CONFIG)) return W(BigInt(STRATEGY)) + W(0).slice(2).repeat(3);
    const decoded = ABI.parseTransaction(tx), name = decoded.name;
    if (options.failName === name) throw new CollectionError(options.failCode || "CALL_EXCEPTION");
    if (options.malformed === name) return "0x";
    const arg0 = decoded.args.length ? decoded.args[0] : null;
    const reserveId = name === "getReserve" ? Number(arg0) : 0;
    const values = {
      getAssetCount: [1], getAssetUnderlyingAndDecimals: [token, 18], isUnderlyingListed: [true], isSpokeListed: [true],
      symbol: ["SYNTH"], name: ["SYNTH"], getSpokeAddress: [spoke], getSpokeConfig: [1, 1, 1, true, false],
      getReserveId: [baseFact ? 0 : Math.max(0, HUBS.findIndex(row => row.address.toLowerCase() === arg0?.toLowerCase?.()))],
      ORACLE: [ORACLE], MAX_USER_RESERVES_LIMIT: [8], getLiquidationConfig: [1, 1, 1],
      getReserve: [token, baseFact ? hub : HUBS[reserveId].address, 0, 18, 5000, 1, 37],
      getReserveConfig: [5000, false, false, true, true], getDynamicReserveConfig: [6000, 10500, 100],
      getReserveSuppliedAssets: [10], getReserveDebt: [2, 1], getReserveTotalDebt: [3],
      decimals: [tx.to.toLowerCase() === ORACLE ? 8 : baseFact?.decimals ?? 18], spoke: [spoke],
      getReserveSource: [SOURCE], getReservePrice: [100000000], HUB: [hub], owner: [A(16)], authority: [A(17)], pendingOwner: [A(0)],
      getSuppliedAssets: [10], getSuppliedShares: [9], hub: [hub], assetId: [7], asset: [token], totalAssets: [10],
    };
    let raw = ABI.encodeFunctionResult(decoded.fragment, values[name] || [1]);
    // Ethers defers invalid address-word errors until a Result is accessed. This
    // exercises unexpected branch throws, rather than ordinary caught RPC errors.
    if ([].concat(options.deferredDecodeError || []).includes(name)) raw = "0x" + "f".repeat(64) + raw.slice(66);
    return raw;
  }
  const rpc = (_handle, method, params) => {
    if (!scheduled) return Promise.resolve().then(() => response(method, params));
    const name = method === "eth_call" ? (params[0].data.startsWith(CONFIG) ? "getAssetConfig" : ABI.parseTransaction(params[0]).name) : method;
    const row = { method, params: structuredClone(params), name, stage, start: tick };
    starts.push(row); active += 1; maxActive = Math.max(maxActive, active);
    assert.ok(active <= 4, "unchanged real pinned transport owns four physical slots");
    return new Promise((resolve, reject) => pending.push({ end: tick + (options.delays?.[name] || 1), finish() {
      active -= 1; finishes.push({ ...row, end: tick });
      try { resolve(response(method, params)); } catch (error) { reject(error); }
    } }));
  };
  async function open(extra = {}) {
    context = await openPinnedCollection({ ...extra, chainId, probeAddress: hub, now: () => NOW + tick, rpc,
      candidates: REVIEWED_OPERATOR_FAMILY_IDS.slice(0, 2).map((operatorFamily, i) => ({ operatorFamily, handle: "synthetic-" + i })) });
    return context;
  }
  async function drive(operation) {
    scheduled = true;
    let done = false, value, error;
    Promise.resolve().then(operation).then(result => { value = result; done = true; }, caught => { error = caught; done = true; });
    for (let iteration = 0; iteration < 3000; iteration++) {
      await turn();
      if (done) {
        assert.equal(active, 0, "return/throw must drain all physical branches");
        assert.equal(pending.length, 0);
        if (context) assert.equal(context.budgetStatus().outstandingRequests, 0, "queued dispatch must also be drained");
        if (error) throw error;
        return value;
      }
      assert.ok(pending.length, "operation made progress without real timers");
      tick = Math.min(...pending.map(row => row.end));
      const ready = pending.filter(row => row.end === tick);
      for (const row of ready) pending.splice(pending.indexOf(row), 1);
      ready.forEach(row => row.finish());
    }
    assert.fail("virtual operation did not settle");
  }
  return { open, drive, starts, finishes, stages, response, get context() { return context; }, get tick() { return tick; },
    get maxActive() { return maxActive; }, get active() { return active; },
    setTick(value) { tick = value; },
    dependencies: { now: () => NOW + tick, fetchPrices: async () => ({ [token]: 1 }),
      openCollection: async opts => { await open(opts); return context; },
      onDiagnosticStage: code => {
        // Scanner diagnostic hooks deliberately swallow exceptions. Record here
        // and assert OUTSIDE the hook so a failing assertion cannot be hidden.
        stage = code; stages.push({ code, tick, active, outstanding: context?.budgetStatus().outstandingRequests ?? 0 });
        if (code === "PRICE_LOOKUP") scheduled = true;
      } },
  };
}

async function reserveRun(options = {}, optimized = true) {
  const f = fixture(options);
  await f.open();
  for (const [name, args, target = SPOKE] of options.warm || []) {
    try { await f.context.provider.call({ to: target, data: ABI.encodeFunctionData(name, args) }); }
    catch (error) { assert.equal(error.code, "CALL_EXCEPTION"); }
  }
  const before = f.context.statistics();
  // The unchanged non-Base legacy branch IS the sequential reference. Only the
  // explicit Ethereum chain1 path is optimized; no second implementation copy.
  const output = await f.drive(() => scanner.readSpokeReserve(f.context.provider, SPOKE, HUB, 0, 18, 1, optimized ? { chainId: 1 } : {}));
  const stats = f.context.statistics();
  return { f, output, operations: stats.stateReadOperations - before.stateReadOperations,
    cacheHits: stats.stateCacheHits - before.stateCacheHits, stats };
}
const multiset = f => f.starts.map(({ method, params }) => JSON.stringify({ method, params })).sort();
function complete(output) {
  return scanner.requiredSpokeRowOk({ address: SPOKE, listed: true, config: { error: null }, reserve: output },
    { hubAddress: HUB, spoke: SPOKE, assetId: 0, underlying: TOKEN });
}

test("uncached Ethereum preserves every output/request/operation with post-discovery four virtual waves reduced to three", async () => {
  const sequential = await reserveRun({}, false), optimized = await reserveRun();
  assert.deepEqual(sequential.output, optimized.output);
  assert.deepEqual(multiset(sequential.f), multiset(optimized.f));
  assert.equal(sequential.operations, 14); assert.equal(optimized.operations, 14);
  assert.equal(sequential.cacheHits, 0); assert.equal(optimized.cacheHits, 0);
  assert.equal(complete(optimized.output), true);
  const waves = run => run.f.tick - Math.max(...run.f.finishes.filter(row => DISCOVERY.includes(row.name)).map(row => row.end));
  assert.equal(waves(sequential), 4); assert.equal(waves(optimized), 3);
  assert.equal(sequential.f.maxActive, 4); assert.equal(optimized.f.maxActive, 4);
  assert.deepEqual(sequential.f.starts.map(row => row.name), OLD_ORDER);
  const dynamic = optimized.f.starts.find(row => row.name === "getDynamicReserveConfig");
  assert.equal(Number(ABI.parseTransaction(dynamic.params[0]).args[1]), 37, "actual reserve key, not default zero");
  assert.ok(optimized.f.starts.find(row => row.name === "getReserveSource").start < dynamic.start);
});

test("real pin cache hits and cached EVM reverts preserve exact outputs, physical multiset and logical counts", async () => {
  for (const failName of [undefined, "getReservePrice"]) {
    const options = { failName, warm: [["ORACLE", []], ["getReserveConfig", [0]], ["decimals", [], ORACLE], ["getReservePrice", [0], ORACLE]] };
    const sequential = await reserveRun(options, false), optimized = await reserveRun(options);
    assert.deepEqual(optimized.output, sequential.output);
    assert.deepEqual(multiset(optimized.f), multiset(sequential.f));
    assert.equal(optimized.operations, sequential.operations); assert.equal(optimized.operations, 14);
    assert.equal(optimized.cacheHits, 4); assert.equal(sequential.cacheHits, 4);
    assert.equal(optimized.f.starts.length, 10); assert.equal(sequential.f.starts.length, 10);
    assert.equal(complete(optimized.output), !failName);
    if (failName) assert.equal(optimized.output.oracleData.errors.price, "call-reverted");
  }
});

test("missing reserve ID never launches reserve or oracle reads after discovery", async () => {
  for (const options of [{ failName: "getReserveId" }, { malformed: "getReserveId" }]) {
    const sequential = await reserveRun(options, false), optimized = await reserveRun(options);
    assert.deepEqual(optimized.output, sequential.output); assert.deepEqual(multiset(optimized.f), multiset(sequential.f));
    assert.deepEqual(optimized.f.starts.map(row => row.name), DISCOVERY);
    assert.equal(optimized.output.reserveId, null); assert.equal(complete(optimized.output), false);
  }
});

test("unavailable oracle remains null, skips all four oracle reads, and cannot prove required coverage", async () => {
  const sequential = await reserveRun({ failName: "ORACLE" }, false), optimized = await reserveRun({ failName: "ORACLE" });
  assert.deepEqual(optimized.output, sequential.output); assert.deepEqual(multiset(optimized.f), multiset(sequential.f));
  assert.equal(optimized.output.oracle, null); assert.equal(optimized.output.oracleData, null);
  assert.deepEqual(optimized.f.starts.map(row => row.name), [...DISCOVERY, ...RESERVE, "getDynamicReserveConfig"]);
  assert.equal(optimized.operations, 10); assert.equal(complete(optimized.output), false);
});

test("malformed reserve/config/dynamic data keeps the same fallback key, errors and incomplete identity", async () => {
  for (const name of ["getReserve", "getReserveConfig", "getDynamicReserveConfig"]) {
    const sequential = await reserveRun({ malformed: name }, false), optimized = await reserveRun({ malformed: name });
    assert.deepEqual(optimized.output, sequential.output); assert.deepEqual(multiset(optimized.f), multiset(sequential.f));
    assert.equal(optimized.operations, 14); assert.equal(complete(optimized.output), false);
    const key = ABI.parseTransaction(optimized.f.starts.find(row => row.name === "getDynamicReserveConfig").params[0]).args[1];
    assert.equal(Number(key), name === "getReserve" ? 0 : 37);
  }
});

test("each oracle getter failure remains an error, never a waived required observation", async () => {
  for (const failName of ORACLE_READS) {
    const sequential = await reserveRun({ failName }, false), optimized = await reserveRun({ failName });
    assert.deepEqual(optimized.output, sequential.output); assert.deepEqual(multiset(optimized.f), multiset(sequential.f));
    assert.equal(optimized.operations, 14); assert.equal(complete(optimized.output), false);
    assert.equal(optimized.stats.revertedStateReads, 1);
  }
});

test("delayed failed reserve and oracle reads drain before returning incomplete results", async () => {
  for (const failName of ["getReserveTotalDebt", "getReservePrice"]) {
    const { f, output } = await reserveRun({ failName, delays: { [failName]: 9 } });
    assert.ok(f.finishes.some(row => row.name === failName && row.end >= 10));
    assert.equal(f.active, 0); assert.equal(complete(output), false);
  }
});

test("unexpected deferred decoding failures in either branch drain the other branch before throwing", async () => {
  for (const [deferredDecodeError, delays] of [["getReserve", { getReservePrice: 12, getReserveTotalDebt: 7 }],
    ["spoke", { getDynamicReserveConfig: 12 }], ["ORACLE", { getDynamicReserveConfig: 12 }]]) {
    const f = fixture({ deferredDecodeError, delays }); await f.open();
    await assert.rejects(f.drive(() => scanner.readSpokeReserve(f.context.provider, SPOKE, HUB, 0, 18, 1, { chainId: 1 })), /deferred error/);
    assert.ok(f.finishes.some(row => row.name === Object.keys(delays)[0]));
    assert.equal(f.active, 0); assert.equal(f.context.budgetStatus().outstandingRequests, 0);
  }
});

function baseLendingSetup() {
  const roles = require("../lib/aave-v4-base-role-evidence"), manifest = require("../aave-v4-base-role-evidence.json");
  const readPublic = relative => fs.readFileSync(path.resolve(__dirname, "../..", relative));
  const inventory = JSON.parse(readPublic("reports/base-aave-v4-admission-20261018/capture4-publicnode-first/code-inventory.json"));
  const bindings = roles.bindRoleEvidence({ chainId: 8453, registry: { ...manifest.registry }, pin: { ...inventory.pin },
    inventory, scopeSha256: manifest.scopeSha256, published: roles.loadPublishedEvidence({ readFile: readPublic }) });
  const fact = role => manifest.roles.find(row => row.role === role);
  return { bindings, baseFact: { spoke: fact("lending").address, hub: fact("hub").address,
    token: fact("tokenization").expectedLink.asset, decimals: 6 } };
}

test("Base lending deferred ORACLE address error follows five reserve reads and actual-key dynamic config", async () => {
  const { bindings, baseFact } = baseLendingSetup();
  const f = fixture({ chainId: 8453, baseFact, deferredDecodeError: "ORACLE", delays: { getDynamicReserveConfig: 12 } });
  await f.open();
  await assert.rejects(f.drive(() => scanner.readSpokeReserve(f.context.provider, baseFact.spoke, baseFact.hub, 7, 6, null,
    { chainId: 8453, roleBindings: bindings }, baseFact.token)), /deferred error/);
  assert.deepEqual(f.starts.map(row => row.name), [...DISCOVERY, ...RESERVE, "getDynamicReserveConfig"]);
  const dynamic = f.starts.at(-1);
  assert.equal(Number(ABI.parseTransaction(dynamic.params[0]).args[1]), 37);
  assert.ok(f.finishes.some(row => row.name === "getDynamicReserveConfig" && row.end === f.tick));
  assert.equal(f.active, 0); assert.equal(f.context.budgetStatus().outstandingRequests, 0);
});

test("Base competing deferred reserve and ORACLE errors preserve sequential reserve-error precedence", async () => {
  const { bindings, baseFact } = baseLendingSetup();
  const runs = [];
  // The no-chain legacy path is the sequential reference. Also compare the
  // reserve-only failure to prove the ORACLE error did not replace its cause.
  for (const [deferredDecodeError, options] of [["getReserve", {}], [["getReserve", "ORACLE"], {}],
    [["getReserve", "ORACLE"], { chainId: 8453, roleBindings: bindings }]]) {
    const f = fixture({ chainId: 8453, baseFact, deferredDecodeError, delays: { getReserve: 7, ORACLE: 3 } });
    await f.open();
    let caught;
    await assert.rejects(f.drive(() => scanner.readSpokeReserve(f.context.provider, baseFact.spoke, baseFact.hub, 7, 6, null,
      options, baseFact.token)), error => { caught = error; return /deferred error/.test(error.message); });
    assert.match(caught.stack, /at decodeReserve /);
    assert.deepEqual(f.starts.map(row => row.name), [...DISCOVERY, ...RESERVE]);
    assert.equal(f.active, 0); assert.equal(f.context.budgetStatus().outstandingRequests, 0);
    runs.push({ f, caught });
  }
  for (const run of runs.slice(1)) {
    assert.equal(run.caught.message, runs[0].caught.message);
    assert.deepEqual(run.caught.error, runs[0].caught.error);
    assert.deepEqual(multiset(run.f), multiset(runs[0].f));
    assert.equal(run.f.context.statistics().stateReadOperations, runs[0].f.context.statistics().stateReadOperations);
  }
});

test("deadline admissions stay rejected, fully drained and incapable of producing an observation pin", async () => {
  const f = fixture({ delays: { getReserve: 210000 } }); await f.open();
  const output = await f.drive(() => scanner.readSpokeReserve(f.context.provider, SPOKE, HUB, 0, 18, 1, { chainId: 1 }));
  assert.equal(output.errors.dynamicConfig, "collection-budget-exhausted");
  assert.equal(complete(output), false); assert.ok(f.context.statistics().rejectedRequests > 0);
  assert.equal(f.context.statistics().firstRejectedDispatch.reason, "TIME_THRESHOLD");
  await f.drive(() => f.context.confirmPin());
  assert.equal(f.context.observationPin({ stateReadsAttempted: 14, stateReadsSucceeded: 14, stateReadsFailed: 0 }), null);
});

test("full production topology completes mandatory branches before deferred metadata and terminal checks", async () => {
  const f = fixture({ delays: { getDynamicReserveConfig: 4, getReservePrice: 6 } });
  // Qualification, native scanner calls and terminal confirmation all use the
  // injected RPC; only the state pipeline's scheduling is changed in production.
  const output = await f.drive(() => scanner.collectTopology(f.dependencies));
  assert.equal(output.sourceCoverage.sampleComplete, true); assert.ok(output.sourceCoverage.observationPin);
  assert.equal(output.collection.rejectedRequests, 0); assert.equal(output.collection.stateTransportFailures, 0);
  assert.equal(output.collection.budget.outstandingRequests, 0);
  assert.ok(f.stages.find(row => row.code === "DEPENDENCY_METADATA"));
  assert.ok(f.stages.find(row => row.code === "PIN_CONFIRMATION"));
  for (const observed of f.stages.filter(row => ["DEPENDENCY_METADATA", "PIN_CONFIRMATION"].includes(row.code))) {
    assert.equal(observed.active, 0); assert.equal(observed.outstanding, 0);
    assert.ok(f.finishes.filter(row => [...RESERVE, ...ORACLE_READS, "getDynamicReserveConfig"].includes(row.name)).every(row => row.end <= observed.tick));
  }
  assert.ok(f.starts.filter(row => ["HUB", "owner", "authority"].includes(row.name)).every(row => row.stage === "DEPENDENCY_METADATA"));
});

test("full topology retains mandatory-failure and terminal-mismatch rejection, not promotion", async () => {
  for (const options of [{ malformed: "getDynamicReserveConfig" }, { failName: "getReservePrice", failCode: "RPC_TRANSPORT" }, { terminalMismatch: true }]) {
    const f = fixture(options);
    if (options.terminalMismatch) {
      await assert.rejects(f.drive(() => scanner.collectTopology(f.dependencies)), { code: "TERMINAL_PIN_MISMATCH" });
    } else {
      const output = await f.drive(() => scanner.collectTopology(f.dependencies));
      assert.equal(output.sourceCoverage.sampleComplete, false); assert.equal(output.sourceCoverage.observationPin, null);
      assert.equal(output.sourceCoverage.complete, false);
    }
  }
  const unexpected = fixture({ deferredDecodeError: "getReserve", delays: { getReservePrice: 12 } });
  await assert.rejects(unexpected.drive(() => scanner.collectTopology(unexpected.dependencies)), /deferred error/);
  assert.equal(unexpected.stages.some(row => ["DEPENDENCY_METADATA", "PIN_CONFIRMATION"].includes(row.code)), false);
});

test("Base lending and both opaque typed non-lending paths retain the exact old call order", async () => {
  const roles = require("../lib/aave-v4-base-role-evidence"), manifest = require("../aave-v4-base-role-evidence.json");
  const readPublic = relative => fs.readFileSync(path.resolve(__dirname, "../..", relative));
  const inventory = JSON.parse(readPublic("reports/base-aave-v4-admission-20261018/capture4-publicnode-first/code-inventory.json"));
  const bindings = roles.bindRoleEvidence({ chainId: 8453, registry: { ...manifest.registry }, pin: { ...inventory.pin },
    inventory, scopeSha256: manifest.scopeSha256, published: roles.loadPublishedEvidence({ readFile: readPublic }) });
  const fact = role => manifest.roles.find(row => row.role === role);
  for (const [role, order] of [["lending", OLD_ORDER], ["treasury", ["getSuppliedAssets", "getSuppliedShares", "owner", "pendingOwner"]],
    ["tokenization", ["hub", "assetId", "asset", "totalAssets", "decimals"]]]) {
    const baseFact = { spoke: fact(role).address, hub: fact("hub").address, token: fact("tokenization").expectedLink.asset, decimals: 6 };
    const f = fixture({ chainId: 8453, baseFact }); await f.open();
    const output = await f.drive(() => scanner.readSpokeReserve(f.context.provider, baseFact.spoke, baseFact.hub, 7, 6, null,
      { chainId: 8453, roleBindings: bindings }, baseFact.token));
    assert.deepEqual(f.starts.map(row => row.name), order);
    assert.ok(f.maxActive <= 4);
    if (role !== "lending") { assert.equal(output.reserveBearing, false); assert.deepEqual(output.errors, {}); }
    else assert.equal(f.tick, 5, "discovery plus unchanged four sequential post-discovery waves");
  }
});
