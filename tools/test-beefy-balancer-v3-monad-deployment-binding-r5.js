#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Interface } = require("./node_modules/ethers");
const runner = require("./beefy-balancer-v3-monad-deployment-binding-r5-runner");

let checks = 0;
function equal(a, b, message) { assert.deepStrictEqual(a, b, message); checks += 1; }
function check(value, message) { assert.ok(value, message); checks += 1; }
function nowStamp(now) { return new Date(now).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z"); }
function runId(now, suffix = "a") { return `beefybalv3monad-r5-${nowStamp(now)}-${suffix.repeat(32)}`; }
function pin() { return { number: "100", hash: `0x${"a".repeat(64)}`, timestamp: "200" }; }
function word(address) { return `0x${address.slice(2).padStart(64, "0")}`; }
function context(rpc) { return { budget: new runner.Budget(() => 0), nextId: 0, rpc }; }
function independentAggregate(value) { const rows = [...value.artifacts.map((x) => `artifacts:${x.path}:${x.sha256}`),
  ...value.runtimeDependencyGraph.map((x) => `runtime:${x.path}:${x.sha256}`), ...value.localInputs.map((x) => `localInputs:${x.path}:${x.sha256}`)];
return crypto.createHash("sha256").update(rows.sort().join("\n")).digest("hex"); }
function completeCapture() { return { rawCriticalComplete: true, criticalGates: { all: true }, stopReasons: {},
  strategyIdentity: { resolved: true, sourceRuntimeAttested: null }, vaultIdentity: { resolved: true },
  bindings: { bidirectional: true }, conclusions: { economics: null } }; }
const A = Object.freeze({ want:"0x1000000000000000000000000000000000000001", deposit:"0x1000000000000000000000000000000000000002",
  native:"0x1000000000000000000000000000000000000003", reward:"0x1000000000000000000000000000000000000004",
  factory:"0x1000000000000000000000000000000000000005", swapper:"0x1000000000000000000000000000000000000006",
  gauge:"0x1000000000000000000000000000000000000007", booster:"0x1000000000000000000000000000000000000008",
  rewardPool:"0x1000000000000000000000000000000000000009", balancer:"0x100000000000000000000000000000000000000a",
  feeConfig:"0x100000000000000000000000000000000000000b", feeRecipient:"0x100000000000000000000000000000000000000c",
  extension:"0x100000000000000000000000000000000000000d", admin:"0x100000000000000000000000000000000000000e",
  controller:"0x100000000000000000000000000000000000000f", hook:"0x1000000000000000000000000000000000000010",
  rate:"0x1000000000000000000000000000000000000011", oracle:"0x1000000000000000000000000000000000000012",
  router:"0x1000000000000000000000000000000000000013", owner:"0x1000000000000000000000000000000000000014" });
function captureRpc(mode = "aura", calls = []) {
  const auraMode = mode.startsWith("aura");
  const s = runner.scalarAbi, e = runner.explorerAbi, balancerGetter = new Interface(["function balancerVault() view returns(address)"]);
  const sel = (iface, name) => iface.getFunction(name).selector, ok = (iface, name, values) => ({ ok:true, result:iface.encodeFunctionResult(name, values) });
  return async (_endpoint, method, params) => {
    if (method === "eth_chainId") return { ok:true, result:"0x8f" };
    if (method === "eth_getBlockByNumber") return { ok:true, result:{ number:"0x64", hash:pin().hash, timestamp:"0xc8" } };
    if (method === "eth_getCode") return { ok:true, result:mode==="aura-controller-missing"&&params[0]===A.controller?"0x":"0x60016000" };
    if (method === "eth_getStorageAt") return { ok:true, result:word(runner.ZERO) };
    if (method !== "eth_call") return { ok:false, reason:"UNEXPECTED_METHOD" };
    const to = params[0].to, data = params[0].data, selector = data.slice(0,10), is = (iface, name) => selector === sel(iface,name);
    calls.push({ to, selector });
    if (is(balancerGetter,"balancerVault")) return ok(balancerGetter,"balancerVault",[A.balancer]);
    if (to === runner.STRATEGY) {
      const addresses = { owner:A.owner,vault:runner.BEEFY_VAULT,factory:A.factory,want:A.want,depositToken:A.deposit,native:A.native,
        swapper:A.swapper,gauge:mode==="hold"?runner.ZERO:A.gauge,booster:auraMode?A.booster:runner.ZERO,
        rewardPool:auraMode?A.rewardPool:runner.ZERO,minter:runner.ZERO,strategist:A.owner };
      for (const [name,value] of Object.entries(addresses)) if (is(s,name)) return ok(s,name,[value]);
      if (is(s,"pid")) return ok(s,"pid",[auraMode?1n:1234567n]);
      for (const name of ["lastHarvest","totalLocked","lockDuration","balanceOf()","balanceOfWant","balanceOfPool","lockedProfit","callReward","rewardsAvailable"])
        if (is(s,name)) return ok(s,name,[name==="lockDuration"?86400n:100n]);
      if (is(s,"harvestOnDeposit")) return ok(s,"harvestOnDeposit",[false]);
      if (is(s,"rewardsLength")) return ok(s,"rewardsLength",[1n]);
      if (is(s,"rewards")) return ok(s,"rewards",[A.reward]);
      if (is(s,"minAmounts")) return ok(s,"minAmounts",[1n]);
      if (is(s,"paused")) return ok(s,"paused",[false]);
      if (is(s,"stratName")) return ok(s,"stratName",["BalancerV3"]);
      if (is(s,"getAllFees")) return ok(s,"getAllFees",[[[100n,60n,20n,20n,"default",true],0n,0n]]);
    }
    if (to === runner.BEEFY_VAULT) {
      if (is(s,"owner")) return ok(s,"owner",[A.owner]); if (is(s,"strategy")) return ok(s,"strategy",[runner.STRATEGY]);
      if (is(s,"want")) return ok(s,"want",[A.want]); if (is(s,"totalSupply()")) return ok(s,"totalSupply()",[1000n]);
      for (const name of ["balance","available","getPricePerFullShare","approvalDelay"]) if (is(s,name)) return ok(s,name,[100n]);
      if (is(s,"stratCandidate")) return ok(s,"stratCandidate",[runner.ZERO,0n]); if (is(s,"decimals")) return ok(s,"decimals",[18]);
      if (is(s,"name")) return ok(s,"name",["moo"]); if (is(s,"symbol")) return ok(s,"symbol",["moo"]);
    }
    if (to === A.factory) { if (is(s,"owner")) return ok(s,"owner",[A.owner]); if (is(s,"native")) return ok(s,"native",[A.native]);
      if (is(s,"keeper")) return ok(s,"keeper",[A.owner]); if (is(s,"globalPause")||is(s,"strategyPause")) return ok(s,is(s,"globalPause")?"globalPause":"strategyPause",[false]);
      if (is(s,"beefyFeeConfig")) return ok(s,"beefyFeeConfig",[A.feeConfig]); if (is(s,"beefyFeeRecipient")) return ok(s,"beefyFeeRecipient",[A.feeRecipient]); }
    if (to === A.feeConfig && is(s,"getFees")) return ok(s,"getFees",[[100n,60n,20n,20n,"default",true]]);
    if (to === A.booster && is(s,"poolInfo")) return ok(s,"poolInfo",[A.want,runner.ZERO,A.gauge,A.rewardPool,runner.ZERO,false]);
    if (to === A.rewardPool) { if (is(s,"stakingToken")) return ok(s,"stakingToken",[A.want]); if (is(s,"balanceOf(address)")) return ok(s,"balanceOf(address)",[100n]); if (is(s,"earned")) return ok(s,"earned",[5n]); }
    if (to === A.gauge && is(s,"balanceOf(address)")) return ok(s,"balanceOf(address)",[100n]);
    if (to === A.swapper) { if (is(s,"oracle")) return ok(s,"oracle",[A.oracle]); if (is(s,"slippage")) return ok(s,"slippage",[990000000000000000n]);
      if (is(s,"swapInfo")) return ok(s,"swapInfo",[A.router,`0x12345678${"00".repeat(96)}`,4n,36n,-7]); }
    if ([A.want,A.deposit,A.native,A.reward].includes(to)) { if (is(s,"decimals")) return ok(s,"decimals",[18]);
      if (is(s,"balanceOf(address)")) return ok(s,"balanceOf(address)",[100n]); if (is(s,"allowance")) return ok(s,"allowance",[100n]); }
    if (to === A.want) { if (is(s,"getTokens")) return ok(s,"getTokens",[[A.deposit,A.native,A.reward]]); if (is(s,"version")) return ok(s,"version",["3.0.0"]);
      if (is(s,"getNormalizedWeights")) return ok(s,"getNormalizedWeights",[[333333333333333333n,333333333333333333n,333333333333333334n]]);
      if (is(s,"getAmplificationParameter")) return { ok:false, reason:"UNSUPPORTED" }; }
    if (to === A.balancer) {
      if (is(e,"getVaultExtension")) return ok(e,"getVaultExtension",[A.extension]); if (is(e,"getVaultAdmin")) return ok(e,"getVaultAdmin",[A.admin]);
      if (is(e,"getProtocolFeeController")) return mode==="aura-controller-unresolved"?{ ok:false, reason:"RPC_REVERT_OR_UNSUPPORTED" }:
        ok(e,"getProtocolFeeController",[mode==="aura-zero-controller"?runner.ZERO:A.controller]);
      if (is(e,"getVaultPausedState")) return ok(e,"getVaultPausedState",[false,0,0]);
      if (is(e,"isPoolRegistered")) return ok(e,"isPoolRegistered",[true]); if (is(e,"isPoolInitialized")) return ok(e,"isPoolInitialized",[true]);
      if (is(e,"getPoolTokens")) return ok(e,"getPoolTokens",[[A.deposit,A.native,A.reward]]);
      if (is(e,"getPoolTokenCountAndIndexOfToken")) return ok(e,"getPoolTokenCountAndIndexOfToken",[3n,0n]);
      if (is(e,"getPoolTokenRates")) return ok(e,"getPoolTokenRates",[[1n,1n,1n],[1n,2n,1n]]);
      const info = [[0,runner.ZERO,false],[1,A.rate,true],[0,runner.ZERO,false]];
      if (is(e,"getPoolTokenInfo")) return ok(e,"getPoolTokenInfo",[[A.deposit,A.native,A.reward],info,[10n,20n,30n],[11n,21n,31n]]);
      if (is(e,"getPoolData")) return ok(e,"getPoolData",[[`0x${"0".repeat(64)}`,[A.deposit,A.native,A.reward],info,[10n,20n,30n],[11n,21n,31n],[1n,2n,1n],[1n,1n,1n]]]);
      if (is(e,"getCurrentLiveBalances")) return ok(e,"getCurrentLiveBalances",[[11n,21n,31n]]);
      if (is(e,"getPoolConfig")) return ok(e,"getPoolConfig",[[[false,false,false,false],1n,2n,3n,0,0,true,true,false,false]]);
      if (is(e,"getHooksConfig")) return ok(e,"getHooksConfig",[[false,false,false,false,false,false,false,false,false,false,A.hook]]);
      if (is(e,"getStaticSwapFeePercentage")||is(e,"getAggregateSwapFeeAmount")||is(e,"getAggregateYieldFeeAmount")||is(e,"getMinimumTradeAmount")||is(e,"totalSupply"))
        return ok(e,is(e,"getStaticSwapFeePercentage")?"getStaticSwapFeePercentage":is(e,"getAggregateSwapFeeAmount")?"getAggregateSwapFeeAmount":is(e,"getAggregateYieldFeeAmount")?"getAggregateYieldFeeAmount":is(e,"getMinimumTradeAmount")?"getMinimumTradeAmount":"totalSupply",[1n]);
      if (is(e,"isPoolPaused")||is(e,"isPoolInRecoveryMode")) return ok(e,is(e,"isPoolPaused")?"isPoolPaused":"isPoolInRecoveryMode",[false]);
    }
    return { ok:false, reason:"UNSUPPORTED_SELECTOR" };
  };
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(path.join(runner.ROOT, ...runner.FIXTURE_REL.split("/")), "utf8"));
  equal(fixture.schemaVersion, 5, "R5 fixture schema"); equal(runner.FINDING_ID, runner.STEM, "distinct R5 namespace");
  const now = Date.UTC(2026, 7, 15, 12, 0, 0), id = runId(now);
  equal(runner.validateRunId(id, now), id, "fresh UTC run id");
  assert.throws(() => runner.validateRunId(runId(now - 301000), now), /RUN_ID_NOT_FRESH_UTC/u); checks += 1;
  equal(runner.parseArgs(["node","runner",runner.CAPTURE_FLAG,"--run-id",id], now).runId, id, "R5 one-shot flag");
  equal(runner.eip1898(pin().hash), { blockHash: pin().hash, requireCanonical: true }, "EIP-1898 canonical pin");

  equal(runner.triAnd([true,true]), true, "tri-state all true"); equal(runner.triAnd([true,false,null]), false, "tri-state proven false");
  equal(runner.triAnd([true,null]), null, "tri-state unknown preserved"); equal(runner.triEqual(null, true), null, "unknown never false");
  const stop = runner.deriveStopReasons({ bindings: { bidirectional: true, tokenOrder: { sameOrder: true, exactIndex: true } },
    strategyIdentity: { resolved: true }, vaultIdentity: { resolved: true }, balancer: { identity: { resolved: true }, explorer: {
      poolConfig: { value: null }, hooksConfig: { value: null }, tokenRates: { value: null }, poolPaused: { value: null } } },
    factory: { globalPause: { value: null }, strategyPause: { value: null } }, strategy: { paused: { value: null } },
    vault: { totalSupply: { value: null } }, allowances: { wantToStaker: { value: null } } });
  equal(stop.strategyPaused, null, "strategy pause unknown not false"); equal(stop.factoryPaused, null, "factory pause unknown not false");
  equal(stop.vaultPaused, null, "vault pause unknown not false"); equal(stop.zeroSupply, null, "zero supply separate unknown");
  equal(stop.negligibleMateriality, null, "materiality null without threshold");
  equal(runner.deriveStopReasons({ ...stop, bindings: {}, strategyIdentity: {}, vaultIdentity: {}, balancer: { explorer: {} },
    strategy: {}, factory: {}, vault: {}, allowances: {}, reachability: { routeSemanticsResolved: false } }).swapRoutesAbsent,
  true, "explicit absent route is a stop");
  const absentStops = runner.deriveStopReasons({ bindings: {}, strategyIdentity: {}, vaultIdentity: {}, balancer: { explorer: {} },
    strategy: {}, factory: {}, vault: {}, allowances: {} });
  equal(absentStops.tokenOrIndexMismatch, null, "unknown binding never false");
  equal(absentStops.poolFactoryUnresolved, true, "package-known unresolved factory provenance is explicit stop");
  equal(Object.entries(absentStops).filter(([key]) => key !== "poolFactoryUnresolved").every(([, value]) => value === null), true,
    "every other entirely absent stop input remains null");

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
  const realisticRoute = [A.router, `0x12345678${"00".repeat(96)}`, 5n, 50n, -128];
  equal(runner.validateRouteStructure(realisticRoute), true, "arbitrary unaligned offsets and sign accepted");
  equal(runner.validateRouteStructure([A.router, realisticRoute[1], 5n, 20n, 127]), false, "overlapping insert ranges rejected");
  equal(runner.validateRouteStructure([A.router, `0x${"00".repeat(64)}`, 40n, 0n, 0]), false, "truncated route bytes rejected");
  equal(runner.validateRouteStructure([runner.ZERO, realisticRoute[1], 5n, 50n, 1]), false, "zero router rejected");

  const auraCapture = await runner.captureFamily({}, pin(), context(captureRpc("aura")));
  equal(auraCapture.reachability.aura.useAura, true, "production captureFamily Aura mode");
  equal(auraCapture.reachability.aura.lptokenMatchesWant, true, "Aura lptoken bound");
  equal(auraCapture.reachability.aura.rewardPoolMatchesStrategyGetter, true, "Aura rewardPool bound");
  equal(auraCapture.reachability.stakingTokenMatchesWant, true, "Aura staking token bound");
  equal(auraCapture.reachability.routeSemanticsResolved, true, "all exact swap routes resolved");
  equal(auraCapture.balancer.explorer.arrayConsistency, true, "all Balancer arrays consistent");
  equal(auraCapture.criticalGates.hookRuntime, true, "nonzero hook runtime required");
  equal(auraCapture.criticalGates.rateProvidersAndTokenTypes, true, "rate runtime and token types required");
  equal(auraCapture.criticalGates.feeControllerRuntimeEvidence, true, "nonzero fee controller runtime proven");
  equal(auraCapture.criticalGates.poolTypeParametersVersion, true, "pool type parameters and version required");
  equal(auraCapture.criticalGates.swapperRoutesOracleSlippage, true, "route critical gate true");
  equal(auraCapture.deploymentApplicability.poolFactoryProvenance, null, "factory provenance explicit null blocker");
  equal(auraCapture.rawCriticalComplete, true, "observable snapshot complete without provenance");
  const gaugeCalls = [], gaugeCapture = await runner.captureFamily({}, pin(), context(captureRpc("gauge", gaugeCalls)));
  equal(gaugeCapture.reachability.aura.useAura, false, "production captureFamily gauge mode");
  equal(gaugeCapture.reachability.stakedBalance.value, "100", "gauge balanceOf strategy captured");
  equal(gaugeCapture.reachability.earned.reason, "GAUGE_EARNED_NOT_SOURCE_BACKED", "gauge earned not invented");
  equal(gaugeCapture.reachability.gaugeIdentity.stakingIdentity, null, "gauge staking identity unavailable null");
  const stakingSelector = runner.scalarAbi.getFunction("stakingToken").selector;
  equal(gaugeCalls.some((row) => row.selector === stakingSelector), false, "gauge mode never calls stakingToken even when mock exposes it");
  const holdCapture = await runner.captureFamily({}, pin(), context(captureRpc("hold")));
  equal(holdCapture.reachability.holdWant, true, "holdWant explicit"); equal(holdCapture.reachability.externalStaker, null, "holdWant has no external staker");
  const zeroController = await runner.captureFamily({}, pin(), context(captureRpc("aura-zero-controller")));
  equal(zeroController.criticalGates.feeControllerRuntimeEvidence, false, "proven zero fee controller is false evidence");
  equal(zeroController.balancer.explorer.feeControllerRuntimeEvidence.reason, "PROVEN_ZERO_NO_FEE_CONTROLLER",
    "zero fee controller raw reason preserved");
  equal(zeroController.criticalGates.all, false, "false fee controller evidence makes aggregate critical gate false");
  equal(zeroController.rawCriticalComplete, true, "false non-null evidence remains snapshot-complete");
  const missingController = await runner.captureFamily({}, pin(), context(captureRpc("aura-controller-missing")));
  equal(missingController.criticalGates.feeControllerRuntimeEvidence, false, "nonzero missing controller runtime is false");
  equal(missingController.balancer.explorer.feeControllerRuntimeEvidence.reason,
    "NONZERO_FEE_CONTROLLER_RUNTIME_MISSING", "missing nonzero controller runtime reason preserved");
  const unresolvedController = await runner.captureFamily({}, pin(), context(captureRpc("aura-controller-unresolved")));
  equal(unresolvedController.criticalGates.feeControllerRuntimeEvidence, null, "unresolved controller address is null");
  equal(unresolvedController.rawCriticalComplete, false, "unresolved controller evidence blocks snapshot completeness");

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

  let markerExists = false, markerFsyncs = 0, markerBytes = Buffer.alloc(0);
  const fakeFs = { openSync(_file, flags) { if (flags === "wx") { if (markerExists) { const error = new Error("exists"); error.code = "EEXIST"; throw error; }
      markerExists = true; return 1; } return 2; }, writeSync(_fd, bytes) { markerBytes = Buffer.from(bytes); return bytes.length; },
    fsyncSync(fd) { if (fd === 1) markerFsyncs += 1; }, readSync(_fd, target, offset) { markerBytes.copy(target, offset); return markerBytes.length; }, closeSync() {} };
  runner.createConsumptionMarker(id, { fsImpl: fakeFs, markerPath: "C:\\fake\\marker", now });
  equal([markerExists,markerFsyncs], [true,1], "exclusive marker flushed and exact read back");
  equal(JSON.parse(markerBytes).packageAggregate, runner.EXPECTED_PACKAGE_AGGREGATE, "marker embeds package aggregate");
  assert.throws(() => runner.createConsumptionMarker(runId(now,"b"), { fsImpl: fakeFs, markerPath: "C:\\fake\\marker", now }), /PACKAGE_ALREADY_CONSUMED/u); checks += 1;
  const nativeDir = fs.mkdtempSync(path.join("C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode", `${runner.STEM}-marker-`));
  const nativeMarker = path.join(nativeDir, "fixed.consumed");
  try { runner.createConsumptionMarker(id, { markerPath: nativeMarker, now }); const nativeBytes = fs.readFileSync(nativeMarker);
    equal(JSON.parse(nativeBytes).packageAggregate, runner.EXPECTED_PACKAGE_AGGREGATE, "native Windows marker exact readback");
    assert.throws(() => runner.createConsumptionMarker(runId(now,"b"), { markerPath: nativeMarker, now }), /PACKAGE_ALREADY_CONSUMED/u); checks += 1;
  } finally { fs.rmSync(nativeDir, { recursive: true, force: true }); }

  const fullDir = fs.mkdtempSync(path.join("C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode", `${runner.STEM}-full-`));
  let intercepted = null, success;
  try { success = await runner.runCapture({ runId: id }, { now: () => now, rpc: captureRpc("aura"),
    inventoryText: "chainId=143 rpc=https://one.example/rpc\nchainId=143 rpc=https://two.example/rpc",
    markerPath: path.join(fullDir,"fixed.consumed"), terminal: async () => true,
    writeOutput: (_file, value) => { intercepted = value; }, outputPath: path.join(fullDir,"unused.json") }); }
  finally { fs.rmSync(fullDir, { recursive:true, force:true }); }
  equal(success.status, "CURRENT_CONFIG_SNAPSHOT_NONPROMOTABLE", "production runCapture and captureFamily full two-family success");
  equal(intercepted.conclusions.currentConfigSnapshot, true, "observable current config snapshot true");
  equal(intercepted.conclusions.deploymentApplicability, null, "deployment applicability remains null");
  equal(runner.assertNoSecrets(intercepted, secrets), true, "full success output sanitized");
  equal(success.qualification.backendOperatorIndependence, false, "hostname is not backend independence");
  equal(success.conclusions.economics, null, "economics null"); equal(success.conclusions.routePositive, null, "route null");
  const zeroDir = fs.mkdtempSync(path.join("C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode", `${runner.STEM}-zero-`));
  let zeroSnapshot;
  try { zeroSnapshot = await runner.runCapture({ runId: runId(now,"c") }, { now: () => now, rpc: captureRpc("aura-zero-controller"),
    inventoryText: "chainId=143 rpc=https://one.example/rpc\nchainId=143 rpc=https://two.example/rpc",
    markerPath: path.join(zeroDir,"fixed.consumed"), terminal: async () => true, writeOutput: () => {}, outputPath: path.join(zeroDir,"unused.json") }); }
  finally { fs.rmSync(zeroDir, { recursive:true, force:true }); }
  equal(zeroSnapshot.state.criticalGates.all, false, "zero controller keeps critical aggregate false");
  equal(zeroSnapshot.conclusions.currentConfigSnapshot, true, "zero controller false evidence still publishes complete snapshot");

  const nullDeps = { now: () => now, verifyPackage: () => {}, consume: () => {}, inventoryText:
    "chainId=143 rpc=https://one.example/rpc\nchainId=143 rpc=https://two.example/rpc",
    qualify: async () => ({ consensus: true, selected: [{ endpoint: {} },{ endpoint: {} }], pin: pin() }),
    capture: async () => ({ ...completeCapture(), rawCriticalComplete: false, criticalGates: { all: null } }),
    terminal: async () => true, writeOutput: () => {}, outputPath: "unused" };
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
  for (const [kind, relative] of [["artifact", manifest.artifacts.find((row) => !row.normalization).path],
    ["runtime", manifest.runtimeDependencyGraph.find((row) => row.path.includes("node_modules")).path],
    ["local", manifest.localInputs[0].path]]) {
    const target = path.join(runner.ROOT, ...relative.split("/"));
    const injectedRead = (file, ...args) => { const bytes = fs.readFileSync(file, ...args); if (path.resolve(file) !== path.resolve(target)) return bytes;
      const buffer = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes, "utf8"); buffer[0] ^= 1; return buffer; };
    assert.throws(() => runner.verifyPackageBeforeConsumption({ readFile: injectedRead }), /PACKAGE_(?:FILE|RUNTIME_GRAPH)_MISMATCH/u, `${kind} byte mutation`); checks += 1;
  }
  const orchestrationMutationTarget = path.join(runner.ROOT, ...manifest.artifacts.find((row) => !row.normalization).path.split("/"));
  const orchestrationMutationRead = (file, ...args) => { const bytes = fs.readFileSync(file, ...args); if (path.resolve(file) !== path.resolve(orchestrationMutationTarget)) return bytes;
    const buffer = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes,"utf8"); buffer[0] ^= 1; return buffer; };
  let consumedOnMutation = false, inventoryOnMutation = false;
  await runner.runCapture({ runId: id }, { now: () => now,
    verifyPackage: () => runner.verifyPackageBeforeConsumption({ readFile: orchestrationMutationRead }),
    consume: () => { consumedOnMutation = true; }, readInventory: () => { inventoryOnMutation = true; return ""; }, writeOutput: () => {} });
  equal(consumedOnMutation, false, "aggregate mutation blocks before consumption"); equal(inventoryOnMutation, false, "aggregate mutation blocks before inventory");

  equal(independentAggregate(manifest), manifest.aggregateSha256, "independent aggregate recomputation");
  equal(runner.verifyRecords(manifest.artifacts, runner.REQUIRED_ARTIFACT_PATHS), true, "artifact hashes");
  equal(runner.verifyRecords(manifest.localInputs, runner.LOCAL_INPUT_RELS), true, "local input hashes");
  check(runner.LOCAL_INPUT_RELS.includes("targets/beefy-contracts-4621d2dd/contracts/BIFI/infra/BeefySwapper.sol"), "exact BeefySwapper source bound");
  equal([...runner.ALLOWED_METHODS].sort(), ["eth_call","eth_chainId","eth_getBlockByNumber","eth_getCode","eth_getStorageAt"].sort(), "read-only allowlist");
  const preflight = runner.dryPreflight(); equal(preflight.networkReads, 0, "no network"); equal(preflight.inventoryReads, 0, "no inventory");
  equal(preflight.captureExecuted, false, "no capture"); equal(preflight.retryAllowed, false, "zero retry");
  process.stdout.write(`beefy balancer v3 monad R5 tests passed: ${checks} checks, ${fixture.fixtureClasses.length} fixtures, zero network/inventory/capture\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
