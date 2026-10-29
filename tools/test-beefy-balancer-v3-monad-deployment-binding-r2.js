#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Interface } = require("./node_modules/ethers");
const runner = require("./beefy-balancer-v3-monad-deployment-binding-r2-runner");

let checks = 0;
function equal(a, b, message) { assert.deepStrictEqual(a, b, message); checks += 1; }
function check(value, message) { assert.ok(value, message); checks += 1; }
function nowStamp(now) { return new Date(now).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z"); }
function runId(now, suffix = "a") { return `beefybalv3monad-r2-${nowStamp(now)}-${suffix.repeat(32)}`; }
function pin() { return { number: "100", hash: `0x${"a".repeat(64)}`, timestamp: "200" }; }
function word(address) { return `0x${address.slice(2).padStart(64, "0")}`; }
function context(rpc) { return { budget: new runner.Budget(() => 0), nextId: 0, rpc }; }
function independentAggregate(value) { const rows = [...value.artifacts.map((x) => `artifacts:${x.path}:${x.sha256}`),
  ...value.runtimeDependencyGraph.map((x) => `runtime:${x.path}:${x.sha256}`), ...value.localInputs.map((x) => `localInputs:${x.path}:${x.sha256}`)];
return crypto.createHash("sha256").update(rows.sort().join("\n")).digest("hex"); }
function completeCapture() { return { rawCriticalComplete: true, criticalGates: { all: true }, stopReasons: {},
  strategyIdentity: { resolved: true, sourceRuntimeAttested: null }, vaultIdentity: { resolved: true },
  bindings: { bidirectional: true }, conclusions: { economics: null } }; }

async function main() {
  const fixture = JSON.parse(fs.readFileSync(path.join(runner.ROOT, ...runner.FIXTURE_REL.split("/")), "utf8"));
  equal(fixture.schemaVersion, 2, "R2 fixture schema"); equal(runner.FINDING_ID, runner.STEM, "distinct R2 namespace");
  const now = Date.UTC(2026, 7, 15, 12, 0, 0), id = runId(now);
  equal(runner.validateRunId(id, now), id, "fresh UTC run id");
  assert.throws(() => runner.validateRunId(runId(now - 301000), now), /RUN_ID_NOT_FRESH_UTC/u); checks += 1;
  equal(runner.parseArgs(["node","runner",runner.CAPTURE_FLAG,"--run-id",id], now).runId, id, "R2 one-shot flag");
  equal(runner.eip1898(pin().hash), { blockHash: pin().hash, requireCanonical: true }, "EIP-1898 canonical pin");

  equal(runner.triAnd([true,true]), true, "tri-state all true"); equal(runner.triAnd([true,false,null]), false, "tri-state proven false");
  equal(runner.triAnd([true,null]), null, "tri-state unknown preserved"); equal(runner.triEqual(null, true), null, "unknown never false");
  const stop = runner.deriveStopReasons({ bindings: { bidirectional: true, tokenOrder: { sameOrder: true, exactIndex: true } },
    strategyIdentity: { resolved: true }, vaultIdentity: { resolved: true }, balancer: { identity: { resolved: true }, explorer: {
      poolConfig: { value: null }, hooksConfig: { value: null }, tokenRates: { value: null }, poolPaused: { value: null } } },
    factory: { globalPause: { value: null }, strategyPause: { value: null } }, strategy: { paused: { value: null } },
    vault: { totalSupply: { value: null } }, allowances: { wantToStaker: { value: null } } });
  equal(stop.paused, null, "pause unknown not false"); equal(stop.zeroSupply, null, "zero supply separate unknown");
  equal(stop.negligibleMateriality, null, "materiality null without threshold");
  equal(runner.deriveStopReasons({ bindings: {}, strategyIdentity: {}, vaultIdentity: {}, balancer: { explorer: {} },
    strategy: {}, factory: {}, vault: {}, allowances: {} }).tokenOrIndexMismatch, null, "unknown binding never false");

  const beacon = "0x1111111111111111111111111111111111111111", implementation = "0x2222222222222222222222222222222222222222";
  const proxy = "0x3333333333333333333333333333333333333333";
  const proxyRpc = async (_endpoint, method, params) => {
    if (method === "eth_getStorageAt") return { ok: true, result: params[1] === runner.BEACON_SLOT ? word(beacon) : word(runner.ZERO) };
    if (method === "eth_getCode") return { ok: true, result: "0x60016000" };
    if (method === "eth_call") { if (params[0].to === proxy) return { ok: false, reason: "RPC_REVERT_OR_UNSUPPORTED", result: null };
      return { ok: true, result: runner.scalarAbi.encodeFunctionResult("implementation", [implementation]) }; }
    throw new Error("unexpected"); };
  const resolvedBeacon = await runner.resolveProxy({}, proxy, pin(), context(proxyRpc));
  equal(resolvedBeacon.slots.kind, "BEACON_PROXY", "beacon slot primary"); equal(resolvedBeacon.beaconGetterCorroborates, null, "proxy beacon getter optional");
  equal(resolvedBeacon.resolvedImplementation, implementation, "beacon implementation resolved"); equal(resolvedBeacon.beaconCode.value.present, true, "beacon runtime required");
  equal(resolvedBeacon.implementationRuntime.value.present, true, "implementation runtime required"); equal(resolvedBeacon.resolved, true, "BeaconProxy resolved without getter");

  const storageFail = await runner.resolveProxy({}, proxy, pin(), context(async (_e, method) => method === "eth_getStorageAt" ?
    { ok: false, reason: "STORAGE_FAILED", result: null } : { ok: true, result: "0x6001" }));
  equal(storageFail.slots.kind, "UNRESOLVED_SLOT_READ", "failed storage unresolved"); equal(storageFail.resolved, false, "failed slots never direct");
  const malformed = await runner.resolveProxy({}, proxy, pin(), context(async (_e, method) => method === "eth_getStorageAt" ?
    { ok: true, result: "0x01" } : { ok: true, result: "0x6001" }));
  equal(malformed.unresolvedReason, "PROXY_SLOT_READ_UNRESOLVED", "malformed slot reason"); equal(malformed.resolved, false, "malformed slots unresolved");
  const noBeaconCode = await runner.resolveProxy({}, proxy, pin(), context(async (_e, method, params) => {
    if (method === "eth_getStorageAt") return { ok: true, result: params[1] === runner.BEACON_SLOT ? word(beacon) : word(runner.ZERO) };
    if (method === "eth_getCode") return { ok: true, result: params[0] === beacon ? "0x" : "0x6001" };
    if (method === "eth_call") return params[0].to === proxy ? { ok: false, reason: "NO_GETTER" } :
      { ok: true, result: runner.scalarAbi.encodeFunctionResult("implementation", [implementation]) }; }));
  equal(noBeaconCode.resolved, false, "missing beacon code blocks resolution"); equal(noBeaconCode.unresolvedReason, "BEACON_RUNTIME_MISSING", "missing beacon reason");
  const direct = await runner.resolveProxy({}, proxy, pin(), context(async (_e, method) => method === "eth_getStorageAt" ?
    { ok: true, result: word(runner.ZERO) } : { ok: true, result: "0x6001" }));
  equal(direct.slots.kind, "DIRECT_OR_UNKNOWN", "valid zero slots classify direct"); equal(direct.resolved, true, "direct requires successful zero slots");

  const feeVector = [[100n,60n,20n,20n,"default",true],0n,0n];
  const allFeesRaw = runner.scalarAbi.encodeFunctionResult("getAllFees", [feeVector]);
  equal(runner.jsonValue(runner.scalarAbi.decodeFunctionResult("getAllFees", allFeesRaw)[0]),
    [["100","60","20","20","default",true],"0","0"], "nested AllFees tuple vector");
  const feeRaw = runner.scalarAbi.encodeFunctionResult("getFees", [[100n,60n,20n,20n,"default",true]]);
  equal(runner.jsonValue(runner.scalarAbi.decodeFunctionResult("getFees", feeRaw)[0]), ["100","60","20","20","default",true], "FeeCategory tuple vector");
  const tokenInfo = [[0,runner.ZERO,false]], poolData = [`0x${"0".repeat(64)}`,[runner.STRATEGY],tokenInfo,[1n],[2n],[3n],[4n]];
  const poolRaw = runner.explorerAbi.encodeFunctionResult("getPoolData", [poolData]);
  equal(runner.jsonValue(runner.explorerAbi.decodeFunctionResult("getPoolData", poolRaw)[0])[1], [runner.STRATEGY], "nested PoolData vector");
  const config = [[false,false,false,false],1n,2n,3n,4,5,true,true,false,false];
  const configRaw = runner.explorerAbi.encodeFunctionResult("getPoolConfig", [config]);
  equal(runner.jsonValue(runner.explorerAbi.decodeFunctionResult("getPoolConfig", configRaw)[0])[0], [false,false,false,false], "nested PoolConfig vector");
  const hooks = [false,false,false,false,false,false,false,false,false,false,runner.ZERO];
  const hooksRaw = runner.explorerAbi.encodeFunctionResult("getHooksConfig", [hooks]);
  equal(runner.jsonValue(runner.explorerAbi.decodeFunctionResult("getHooksConfig", hooksRaw)[0]), hooks, "HooksConfig vector");
  const auraRaw = runner.scalarAbi.encodeFunctionResult("poolInfo", [runner.STRATEGY,runner.ZERO,proxy,beacon,runner.ZERO,false]);
  equal(runner.jsonValue(runner.scalarAbi.decodeFunctionResult("poolInfo", auraRaw))[3], beacon, "Aura poolInfo rewardPool vector");
  const routeRaw = runner.scalarAbi.encodeFunctionResult("swapInfo", [proxy,"0x1234",32n,64n,-1]);
  equal(runner.jsonValue(runner.scalarAbi.decodeFunctionResult("swapInfo", routeRaw))[0], proxy, "swapper route vector");

  const descriptors = runner.parseInventoryText("chainId=143 rpc=https://one.example/rpc\nchainId=143 rpc=https://two.example/rpc");
  equal(descriptors.length, 2, "two hostname descriptors");
  const secrets = runner.secretCorpus(descriptors); assert.throws(() => runner.assertNoSecrets({ provider: "one.example" }, secrets), /PROVIDER_MATERIAL/u); checks += 1;
  equal(runner.assertNoSecrets({ selectedFamilyCount: 2 }, secrets), true, "sanitized output");
  const selector = (name) => runner.scalarAbi.getFunction(name).selector;
  const qualification = await runner.qualifyDescriptors(descriptors, context(async (_endpoint, method, params) => {
    if (method === "eth_chainId") return { ok: true, result: "0x8f" };
    if (method === "eth_getBlockByNumber") return { ok: true, result: { number: "0x64", hash: pin().hash, timestamp: "0xc8" } };
    if (method === "eth_getCode") return { ok: true, result: "0x6001" };
    if (method === "eth_getStorageAt") return { ok: true, result: word(runner.ZERO) };
    if (method === "eth_call") { const data = params[0].data.slice(0,10), to = params[0].to;
      if (to === runner.STRATEGY && data === selector("vault")) return { ok: true, result: runner.scalarAbi.encodeFunctionResult("vault", [runner.BEEFY_VAULT]) };
      if (to === runner.STRATEGY && data === selector("want")) return { ok: true, result: runner.scalarAbi.encodeFunctionResult("want", [proxy]) };
      if (to === runner.BEEFY_VAULT && data === selector("strategy")) return { ok: true, result: runner.scalarAbi.encodeFunctionResult("strategy", [runner.STRATEGY]) };
      if (to === runner.BEEFY_VAULT && data === selector("want")) return { ok: true, result: runner.scalarAbi.encodeFunctionResult("want", [proxy]) }; }
    return { ok: false, reason: "UNEXPECTED" }; }));
  equal(qualification.consensus, true, "qualification requires capable anchors at agreed hash");
  equal(qualification.capableFamilyCount, 2, "capable candidate selected per hostname");
  equal(qualification.backendOperatorIndependence, false, "hostname does not prove backend independence");

  let markerExists = false, markerFsyncs = 0, directoryFsyncs = 0;
  const fakeFs = { openSync(_file, flags) { if (flags === "wx") { if (markerExists) { const error = new Error("exists"); error.code = "EEXIST"; throw error; }
      markerExists = true; return 1; } return 2; }, writeSync() {}, fsyncSync(fd) { if (fd === 1) markerFsyncs += 1; else directoryFsyncs += 1; }, closeSync() {} };
  runner.createConsumptionMarker(id, { fsImpl: fakeFs, markerPath: "C:\\fake\\marker", now });
  equal([markerExists,markerFsyncs,directoryFsyncs], [true,1,1], "exclusive marker file and directory fsynced");
  assert.throws(() => runner.createConsumptionMarker(runId(now,"b"), { fsImpl: fakeFs, markerPath: "C:\\fake\\marker", now }), /PACKAGE_ALREADY_CONSUMED/u); checks += 1;

  const events = [], consumeState = { consumed: false };
  const deps = { now: () => now, verifyPackage: () => events.push("verify"), consume: () => { if (consumeState.consumed) throw new Error("PACKAGE_ALREADY_CONSUMED"); consumeState.consumed = true; events.push("consume"); },
    readInventory: () => { events.push("inventory"); return "chainId=143 rpc=https://one.example/rpc\nchainId=143 rpc=https://two.example/rpc"; },
    qualify: async () => ({ consensus: true, selected: [{ endpoint: {} },{ endpoint: {} }], pin: pin() }),
    capture: async () => completeCapture(), terminal: async () => true, writeOutput: (_file, value) => { deps.output = value; }, outputPath: "unused" };
  const success = await runner.runCapture({ runId: id }, deps);
  equal(events.slice(0,3), ["verify","consume","inventory"], "verify then durable consumption then inventory");
  equal(success.status, "CURRENT_CONFIG_SNAPSHOT_NONPROMOTABLE", "full two-family success fixture");
  equal(success.qualification.backendOperatorIndependence, false, "hostname is not backend independence");
  equal(success.conclusions.economics, null, "economics null"); equal(success.conclusions.routePositive, null, "route null");

  const nullDeps = { ...deps, consume: () => {}, capture: async () => ({ ...completeCapture(), rawCriticalComplete: false, criticalGates: { all: null } }) };
  const allNull = await runner.runCapture({ runId: id }, nullDeps);
  equal(allNull.status, "INCOMPLETE_NONPROMOTABLE", "all-null agreement rejected"); equal(allNull.reason, "CRITICAL_STATE_NULL_OR_INCOMPLETE", "critical-null reason");

  let durableConsumed = false, inventoryAttempts = 0;
  const failureDeps = { now: () => now, verifyPackage: () => {}, consume: () => { if (durableConsumed) throw new Error("PACKAGE_ALREADY_CONSUMED"); durableConsumed = true; },
    readInventory: () => { inventoryAttempts += 1; throw new Error("SIMULATED_AFTER_MARKER"); }, writeOutput: () => {}, outputPath: "unused" };
  await runner.runCapture({ runId: id }, failureDeps); equal(durableConsumed, true, "marker survives post-marker failure");
  await runner.runCapture({ runId: runId(now,"b") }, failureDeps); equal(inventoryAttempts, 1, "second different run id rejected before inventory");

  const manifest = JSON.parse(fs.readFileSync(path.join(runner.ROOT, ...runner.MANIFEST_REL.split("/")), "utf8"));
  const mutated = structuredClone(manifest); mutated.localInputs[0].sha256 = "f".repeat(64);
  assert.throws(() => runner.verifyPackageBeforeConsumption({ manifest: mutated }), /PACKAGE_AGGREGATE_MISMATCH/u); checks += 1;
  let consumedOnMutation = false, inventoryOnMutation = false;
  await runner.runCapture({ runId: id }, { now: () => now, verifyPackage: () => { throw new Error("PACKAGE_AGGREGATE_MISMATCH"); },
    consume: () => { consumedOnMutation = true; }, readInventory: () => { inventoryOnMutation = true; return ""; }, writeOutput: () => {} });
  equal(consumedOnMutation, false, "aggregate mutation blocks before consumption"); equal(inventoryOnMutation, false, "aggregate mutation blocks before inventory");

  equal(independentAggregate(manifest), manifest.aggregateSha256, "independent aggregate recomputation");
  equal(runner.verifyRecords(manifest.artifacts, runner.REQUIRED_ARTIFACT_PATHS), true, "artifact hashes");
  equal(runner.verifyRecords(manifest.localInputs, runner.LOCAL_INPUT_RELS), true, "local input hashes");
  check(runner.LOCAL_INPUT_RELS.includes("targets/beefy-contracts-4621d2dd/contracts/BIFI/infra/BeefySwapper.sol"), "exact BeefySwapper source bound");
  equal([...runner.ALLOWED_METHODS].sort(), ["eth_call","eth_chainId","eth_getBlockByNumber","eth_getCode","eth_getStorageAt"].sort(), "read-only allowlist");
  const preflight = runner.dryPreflight(); equal(preflight.networkReads, 0, "no network"); equal(preflight.inventoryReads, 0, "no inventory");
  equal(preflight.captureExecuted, false, "no capture"); equal(preflight.retryAllowed, false, "zero retry");
  process.stdout.write(`beefy balancer v3 monad R2 tests passed: ${checks} checks, ${fixture.fixtureClasses.length} fixtures, zero network/inventory/capture\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
