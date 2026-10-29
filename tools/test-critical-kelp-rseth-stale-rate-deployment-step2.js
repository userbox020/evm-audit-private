#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const runner = require("./run-critical-kelp-rseth-stale-rate-deployment-step2");
const validator = require("./validate-critical-kelp-rseth-stale-rate-deployment-step2");

let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
function eq(actual, expected, message) { assert.deepStrictEqual(actual, expected, message); checks++; }
function rejects(fn, code, message) {
  assert.throws(fn, (error) => String(error.code || error.message).includes(code), message); checks++;
}

const hash = (byte) => `0x${byte.repeat(64)}`;
const runtime = (byte = "1") => ({ bytes: 1, keccak256: hash(byte) });
const abiWord = (value) => BigInt(value).toString(16).padStart(64, "0");
function encodeRateReceivers(entries) {
  return `0x${abiWord(32)}${abiWord(entries.length)}${entries.map((entry) => `${abiWord(entry.chainId)}${entry.receiver.slice(2).toLowerCase().padStart(64, "0")}`).join("")}`;
}
const proxy = (implementation, byte) => ({
  kind: "EIP1967_IMPLEMENTATION",
  implementation,
  beacon: null,
  admin: runner.ADDRESSES.base.proxyAdmin,
  implementationRuntime: runtime(byte),
  beaconRuntime: null,
});

function successfulFixture() {
  const base = {
    chainId: 8453,
    pin: { number: "20000000", hash: hash("a"), timestamp: "2000000", terminalHeaderConsistent: true },
    contracts: {
      pool: { address: runner.ADDRESSES.base.pool, runtime: runtime("1"), proxy: proxy("0x0000000000000000000000000000000000000101", "2") },
      wrapper: { address: runner.ADDRESSES.base.wrapper, runtime: runtime("3"), proxy: proxy("0x0000000000000000000000000000000000000102", "4") },
      receiver: { address: runner.ADDRESSES.base.receiver, runtime: runtime("5") },
      canonical: { address: runner.ADDRESSES.base.canonical, runtime: runtime("6") },
      documentedProxyAdmin: { address: runner.ADDRESSES.base.proxyAdmin, runtime: runtime("7") },
      configuredLayerZeroEndpoint: { address: "0x0000000000000000000000000000000000000201", runtime: runtime("8") },
    },
    state: {
      pool: { wrsETH: runner.ADDRESSES.base.wrapper, rsETHOracle: runner.ADDRESSES.base.receiver, paused: false, feeBps: "100", dailyMintLimit: "1000000000000000000000", dailyMintAmount: "100000000000000000000", lastMintDay: "11", startTimestamp: "1000000", currentDay: "11", remainingDailyMintLimit: "900000000000000000000", rate: "1000000000000000000" },
      wrapper: { minterRole: hash("b"), poolHasMinterRole: true, canonicalAllowed: true, maxCanonicalDeposit: "100000000000000000000", totalSupply: "1000000000000000000000" },
      canonical: { decimals: "18", wrapperReserve: "900000000000000000000" },
      receiver: { rate: "1000000000000000000", lastUpdated: "1900000", srcChainId: "101", rateProvider: runner.ADDRESSES.ethereum.provider, layerZeroEndpoint: "0x0000000000000000000000000000000000000201" },
    },
  };
  const ethereum = {
    chainId: 1,
    pin: { number: "21000000", hash: hash("c"), timestamp: "2000500", terminalHeaderConsistent: true },
    contracts: {
      provider: { address: runner.ADDRESSES.ethereum.provider, runtime: runtime("9") },
      lrtOracle: { address: runner.ADDRESSES.ethereum.lrtOracle, runtime: runtime("a") },
      configuredEndpoint: { address: "0x0000000000000000000000000000000000000202", runtime: runtime("b") },
    },
    state: {
      provider: { getLatestRate: "1200000000000000000", getRate: "1200000000000000000", rate: "1200000000000000000", lastUpdated: "1999000", rsETHPriceOracle: runner.ADDRESSES.ethereum.lrtOracle, routeSummary: { getterStatus: "OBSERVED", totalEntries: 1, baseDestinationEntries: 1, matchingBaseEntries: 1, conflictingBaseEntries: 0 }, layerZeroEndpoint: "0x0000000000000000000000000000000000000202" },
      lrtOracle: { rsETHPrice: "1200000000000000000" },
    },
  };
  const outcome = runner.evaluateCapture({ base, ethereum });
  return runner.canonical({
    schemaVersion: runner.SCHEMA_VERSION,
    findingId: runner.FINDING_ID,
    sourceCommit: runner.SOURCE_COMMIT,
    specSha256: runner.SPEC_SHA256,
    sourceRuntimeAttested: false,
    captureMode: "READ_ONLY_LATEST_THEN_NUMBER_PINNED_WITH_TERMINAL_HEADER_CONSISTENCY",
    classification: outcome.classification,
    promotion: outcome.promotion,
    killReasons: outcome.killReasons,
    chains: { base, ethereum },
    analysis: outcome.analysis,
    policy: { allowedMethods: runner.ALLOWED_METHODS, caps: runner.CAPS, plan: runner.PLAN, retries: 0, stateOverrides: false, logs: false, traces: false, accounts: false, pinnedReadSemantics: "numeric block tags plus terminal same-number/hash/timestamp header consistency" },
    rpc: { totalCalls: 54, callsByChain: { base: 40, ethereum: 14 }, qualificationCalls: 2, batches: 11, transientBytes: 4096, byMethod: { eth_chainId: 2, eth_getBlockByNumber: 4, eth_getCode: 11, eth_getStorageAt: 6, eth_call: 31 } },
    safety: { inventoryReadInMemoryOnly: true, endpointMaterialPersisted: false, providerIdentityPersisted: false, rawRpcPersisted: false, rawBytecodePersisted: false, signing: false, transactions: false, broadcasts: false, stateMutation: false, networkOnlyInExplicitCaptureMode: true },
  });
}

function outcomeAfter(mutator) {
  const fixture = successfulFixture(); mutator(fixture);
  return runner.evaluateCapture(fixture.chains);
}

const outputExistedBefore = fs.existsSync(runner.OUTPUT);
ok(!outputExistedBefore, "fixed capture output absent before offline tests");
eq(runner.staticCheck().mode, "offline-check-only", "runner check-only mode");
eq(runner.staticCheck().outputCreated, false, "runner check-only does not create output");

const fixture = successfulFixture();
ok(fixture.promotion === false, "capture cannot operationally promote");
eq(fixture.killReasons, ["SOURCE_RUNTIME_UNATTESTED"], "otherwise-feasible fixture is blocked only by source/runtime attestation");
ok(fixture.analysis.boundedFeasibleCase.evidenceFeasible === true, "successful deployment-evidence fixture has a bounded exact feasible case");
ok(validator.validateData(fixture).checks >= 40, "successful sanitized evidence fixture validates");

ok(outcomeAfter((x) => { x.chains.base.chainId = 1; }).killReasons.includes("CHAIN_BASE_MISMATCH"), "wrong Base chain rejected deterministically");
ok(outcomeAfter((x) => { x.chains.ethereum.chainId = 8453; }).killReasons.includes("CHAIN_ETHEREUM_MISMATCH"), "wrong Ethereum chain rejected deterministically");

rejects(() => runner.decodeWord(`0x${"00".repeat(31)}`), "ABI_SCALAR_NOT_32_BYTES", "short scalar rejected");
rejects(() => runner.decodeWord(`0x${"00".repeat(129)}`), "ABI_MALFORMED_OR_OVERSIZED", "oversized getter rejected");
rejects(() => runner.decodeBool(`0x${"00".repeat(31)}02`), "ABI_BOOL_INVALID", "noncanonical bool rejected");
rejects(() => runner.decodeAddress(`0x01${"00".repeat(31)}`), "ABI_ADDRESS_PADDING_INVALID", "address padding rejected");
rejects(() => runner.summarizeCode(`0x${"60".repeat(runner.CAPS.codeBytes + 1)}`), "CODE_MALFORMED_OR_OVERSIZED", "oversized runtime rejected");
eq(runner.decodeRateReceivers(encodeRateReceivers([])), [], "canonical empty dynamic route array decodes");
const mixedRoutes = runner.decodeRateReceivers(encodeRateReceivers([
  { chainId: 110, receiver: "0x0000000000000000000000000000000000000011" },
  { chainId: 184, receiver: runner.ADDRESSES.base.receiver },
]));
eq(mixedRoutes.length, 2, "canonical dynamic tuple array decodes");
eq(runner.summarizeProviderRoute(mixedRoutes), { baseDestinationEntries: 1, conflictingBaseEntries: 0, getterStatus: "OBSERVED", matchingBaseEntries: 1, totalEntries: 2 }, "valid Base route summarized without unrelated addresses");
eq(runner.providerRouteKillReasons(runner.summarizeProviderRoute(mixedRoutes)), [], "valid Base route among unrelated entries passes route gate");
rejects(() => runner.decodeRateReceivers(`0x${abiWord(64)}${abiWord(0)}`), "ROUTE_ABI_NONCANONICAL_OFFSET", "dynamic ABI noncanonical offset rejected");
rejects(() => runner.decodeRateReceivers(`0x${abiWord(32)}${abiWord(1)}`), "ROUTE_ABI_LENGTH_MISMATCH", "dynamic ABI declared length mismatch rejected");
rejects(() => runner.decodeRateReceivers(`0x${"00".repeat(63)}`), "ROUTE_ABI_TRUNCATED", "dynamic ABI truncation rejected");
rejects(() => runner.decodeRateReceivers(`0x${abiWord(32)}${abiWord(1)}01${"00".repeat(31)}${runner.ADDRESSES.base.receiver.slice(2).padStart(64, "0")}`), "ROUTE_CHAIN_ID_PADDING_INVALID", "uint16 padding rejected");
rejects(() => runner.decodeRateReceivers(`0x${abiWord(32)}${abiWord(1)}${abiWord(184)}01${"00".repeat(31)}`), "ROUTE_ADDRESS_PADDING_INVALID", "route address padding rejected");
rejects(() => runner.decodeRateReceivers(`0x${abiWord(32)}${abiWord(runner.CAPS.routeReceiverEntries + 1)}`), "ROUTE_ENTRY_CAP_EXCEEDED", "route entry cap enforced before allocation");
rejects(() => runner.decodeRateReceivers(`0x${"00".repeat(runner.CAPS.routeGetterBytes + 1)}`), "ROUTE_ABI_OVERSIZED", "route getter byte cap enforced");

ok(outcomeAfter((x) => { x.chains.base.state.receiver.lastUpdated = "2000001"; }).killReasons.includes("RECEIVER_LAST_UPDATED_FUTURE"), "future receiver timestamp rejected");
ok(outcomeAfter((x) => { x.chains.ethereum.state.provider.lastUpdated = "2000501"; }).killReasons.includes("PROVIDER_LAST_UPDATED_FUTURE"), "future provider timestamp rejected");
ok(outcomeAfter((x) => { x.chains.base.state.receiver.rate = "0"; x.chains.base.state.pool.rate = "0"; }).killReasons.includes("ZERO_RATE_OBSERVED"), "zero destination rate rejected");
ok(outcomeAfter((x) => { x.chains.ethereum.state.provider.getLatestRate = "0"; }).killReasons.includes("ZERO_RATE_OBSERVED"), "zero source rate rejected");
ok(outcomeAfter((x) => { x.chains.base.state.pool.feeBps = "10000"; }).killReasons.includes("FEE_BPS_AT_OR_ABOVE_10000"), "fee at 10000 rejected");

const rollover = successfulFixture();
rollover.chains.base.state.pool.lastMintDay = "10";
rollover.chains.base.state.pool.remainingDailyMintLimit = "1000000000000000000000";
const rolloverOutcome = runner.evaluateCapture(rollover.chains);
ok(!rolloverOutcome.killReasons.includes("POOL_DAILY_HEADROOM_MISMATCH") && rolloverOutcome.analysis.effectiveDailyMintAmount === "0", "start-relative day rollover resets effective mint amount");
ok(outcomeAfter((x) => { x.chains.base.state.pool.remainingDailyMintLimit = "899999999999999999999"; }).killReasons.includes("POOL_DAILY_HEADROOM_MISMATCH"), "daily headroom mismatch rejected");
ok(outcomeAfter((x) => { x.chains.base.state.pool.currentDay = "12"; }).killReasons.includes("POOL_CURRENT_DAY_MISMATCH"), "current day mismatch rejected");
ok(outcomeAfter((x) => { x.chains.base.state.pool.dailyMintLimit = "0"; x.chains.base.state.pool.dailyMintAmount = "0"; x.chains.base.state.pool.remainingDailyMintLimit = "0"; }).killReasons.includes("DAILY_MINT_LIMIT_ZERO"), "zero daily limit rejected");
ok(outcomeAfter((x) => { x.chains.base.state.pool.dailyMintAmount = x.chains.base.state.pool.dailyMintLimit; x.chains.base.state.pool.remainingDailyMintLimit = "0"; }).killReasons.includes("CURRENT_EFFECTIVE_DAILY_HEADROOM_ZERO"), "zero effective daily headroom rejected");

ok(outcomeAfter((x) => { x.chains.base.state.pool.wrsETH = runner.ADDRESSES.base.receiver; }).killReasons.includes("POOL_WRAPPER_LINK_MISMATCH"), "wrong wrapper linkage rejected");
ok(outcomeAfter((x) => { x.chains.base.state.receiver.rateProvider = runner.ADDRESSES.base.pool; }).killReasons.includes("RECEIVER_PROVIDER_LINK_MISMATCH"), "wrong provider linkage rejected");
ok(outcomeAfter((x) => { x.chains.base.state.receiver.srcChainId = "102"; }).killReasons.includes("RECEIVER_SOURCE_CHAIN_ID_MISMATCH"), "wrong receiver LayerZero source chain rejected");
eq(runner.providerRouteKillReasons({ getterStatus: "OBSERVED", totalEntries: 1, baseDestinationEntries: 1, matchingBaseEntries: 1, conflictingBaseEntries: 0 }), [], "single matching Base route accepted");
eq(runner.providerRouteKillReasons({ getterStatus: "OBSERVED", totalEntries: 0, baseDestinationEntries: 0, matchingBaseEntries: 0, conflictingBaseEntries: 0 }), ["PROVIDER_BASE_ROUTE_ABSENT"], "empty route list rejected");
eq(runner.providerRouteKillReasons({ getterStatus: "OBSERVED", totalEntries: 2, baseDestinationEntries: 0, matchingBaseEntries: 0, conflictingBaseEntries: 0 }), ["PROVIDER_BASE_ROUTE_ABSENT"], "Base route absent among other entries rejected");
eq(runner.providerRouteKillReasons({ getterStatus: "OBSERVED", totalEntries: 1, baseDestinationEntries: 1, matchingBaseEntries: 0, conflictingBaseEntries: 1 }), ["PROVIDER_BASE_ROUTE_RECEIVER_MISMATCH"], "single wrong Base receiver rejected");
eq(runner.providerRouteKillReasons({ getterStatus: "OBSERVED", totalEntries: 2, baseDestinationEntries: 2, matchingBaseEntries: 2, conflictingBaseEntries: 0 }), ["PROVIDER_BASE_ROUTE_DUPLICATE"], "duplicate matching Base routes rejected");
eq(runner.providerRouteKillReasons({ getterStatus: "OBSERVED", totalEntries: 2, baseDestinationEntries: 2, matchingBaseEntries: 1, conflictingBaseEntries: 1 }), ["PROVIDER_BASE_ROUTE_CONFLICTING"], "conflicting Base routes rejected");
eq(runner.providerRouteKillReasons(null), ["PROVIDER_ROUTE_UNVERIFIABLE"], "unverifiable route summary rejected");
ok(outcomeAfter((x) => { x.chains.ethereum.state.provider.routeSummary = { getterStatus: "OBSERVED", totalEntries: 0, baseDestinationEntries: 0, matchingBaseEntries: 0, conflictingBaseEntries: 0 }; }).killReasons.includes("PROVIDER_BASE_ROUTE_ABSENT"), "capture evaluation rejects absent Base route");
ok(outcomeAfter((x) => { x.chains.ethereum.state.provider.routeSummary = { getterStatus: "OBSERVED", totalEntries: 2, baseDestinationEntries: 2, matchingBaseEntries: 2, conflictingBaseEntries: 0 }; }).killReasons.includes("PROVIDER_BASE_ROUTE_DUPLICATE"), "capture evaluation rejects duplicate Base route");
ok(outcomeAfter((x) => { x.chains.base.state.wrapper.poolHasMinterRole = false; }).killReasons.includes("POOL_MINTER_ROLE_MISSING"), "missing minter role rejected");
ok(outcomeAfter((x) => { x.chains.base.state.wrapper.canonicalAllowed = false; }).killReasons.includes("CANONICAL_TOKEN_NOT_ALLOWED"), "wrong allowed-token state rejected");
ok(outcomeAfter((x) => { x.chains.base.state.canonical.wrapperReserve = "0"; x.chains.base.state.wrapper.maxCanonicalDeposit = x.chains.base.state.wrapper.totalSupply; }).killReasons.includes("WRAPPER_CANONICAL_RESERVE_ZERO"), "zero reserve rejected");

ok(outcomeAfter((x) => { x.chains.base.pin.terminalHeaderConsistent = false; }).killReasons.includes("BASE_TERMINAL_HEADER_INCONSISTENT"), "Base terminal header mismatch rejected");
ok(outcomeAfter((x) => { x.chains.ethereum.pin.terminalHeaderConsistent = false; }).killReasons.includes("ETHEREUM_TERMINAL_HEADER_INCONSISTENT"), "Ethereum terminal header mismatch rejected");
ok(runner.terminalHeaderConsistency({ number: "1", hash: hash("d"), timestamp: "2" }, { number: "0x1", hash: hash("d"), timestamp: "0x2" }), "terminal header exact match accepted");
ok(!runner.terminalHeaderConsistency({ number: "1", hash: hash("d"), timestamp: "2" }, { number: "0x1", hash: hash("e"), timestamp: "0x2" }), "terminal hash mismatch rejected");
ok(!runner.terminalHeaderConsistency({ number: "1", hash: hash("d"), timestamp: "2" }, { number: "0x01", hash: hash("d"), timestamp: "0x2" }), "malformed terminal header rejected");

ok(outcomeAfter((x) => { x.chains.base.state.receiver.lastUpdated = "1913601"; }).killReasons.includes("RECEIVER_STALE_THRESHOLD_NOT_MET"), "below stale threshold rejected");
ok(!outcomeAfter((x) => { x.chains.base.state.receiver.lastUpdated = "1913600"; }).killReasons.includes("RECEIVER_STALE_THRESHOLD_NOT_MET"), "stale threshold equality accepted");
const equal = runner.divergence(9900n, 10000n, 100n), below = runner.divergence(9899n, 10000n, 100n), above = runner.divergence(9901n, 10000n, 100n);
ok(equal.profitable === false && equal.signedMargin === 0n, "divergence equality is nonpositive");
ok(below.profitable === true && below.signedMargin === 10000n, "one-unit favorable divergence is positive");
ok(above.profitable === false && above.signedMargin === -10000n, "one-unit unfavorable divergence is negative");
const roundedEquality = runner.integerRoundedCase(1n, 0n, 10n ** 18n, 10n ** 18n);
const roundedOneUnit = runner.integerRoundedCase(1n, 0n, 10n ** 18n, 2n * 10n ** 18n);
const roundedFloor = runner.integerRoundedCase(10_001n, 100n, 10n ** 18n, 2n * 10n ** 18n);
ok(roundedEquality.currentValueDeltaWei === 0n, "exact rounded feasible arithmetic equality is nonpositive");
ok(roundedOneUnit.currentValueDeltaWei === 1n, "exact rounded arithmetic one-unit value boundary");
ok(roundedFloor.feeWei === 100n && roundedFloor.mintedCanonicalUnits === 9901n && roundedFloor.currentValueWei === 19802n, "exact fee/mint/value floor arithmetic");
ok(fixture.analysis.boundedFeasibleCase.constraints.mintedPositive && fixture.analysis.boundedFeasibleCase.constraints.withinCurrentDailyHeadroom && fixture.analysis.boundedFeasibleCase.constraints.withinCanonicalReserve && fixture.analysis.boundedFeasibleCase.constraints.minimumValueDeltaMet && fixture.analysis.boundedFeasibleCase.constraints.minimumValueMarginMet, "bounded captured-state feasible case meets all exact constraints");
eq(fixture.analysis.boundedFeasibleCase.canonicalTokenUnitAssumption, "18-decimal canonical rsETH units with 1:1 wrapper redemption", "canonical unit assumption is explicit");

ok(outcomeAfter((x) => { x.chains.ethereum.pin.timestamp = "2001801"; }).killReasons.includes("CROSS_CHAIN_SNAPSHOT_SKEW_EXCEEDED"), "snapshot skew above cap rejected");
ok(!outcomeAfter((x) => { x.chains.ethereum.pin.timestamp = "2001800"; }).killReasons.includes("CROSS_CHAIN_SNAPSHOT_SKEW_EXCEEDED"), "snapshot skew equality accepted");

const zeroWord = `0x${"00".repeat(32)}`, implWord = `0x${"00".repeat(12)}${"11".repeat(20)}`, beaconWord = `0x${"00".repeat(12)}${"22".repeat(20)}`;
eq(runner.classifyProxy({ implementation: zeroWord, admin: zeroWord, beacon: zeroWord }).kind, "DIRECT", "direct classification");
eq(runner.classifyProxy({ implementation: implWord, admin: zeroWord, beacon: zeroWord }).kind, "EIP1967_IMPLEMENTATION", "implementation proxy classification");
eq(runner.classifyProxy({ implementation: zeroWord, admin: zeroWord, beacon: beaconWord }).kind, "EIP1967_BEACON", "beacon proxy classification");
rejects(() => runner.classifyProxy({ implementation: implWord, admin: zeroWord, beacon: beaconWord }), "EIP1967_AMBIGUOUS", "ambiguous proxy classification rejected");

const tinyCaps = { ...runner.CAPS, totalCalls: 2, baseCalls: 1, ethereumCalls: 1, qualificationCalls: 1 };
const budget = new runner.Budget(tinyCaps); budget.reserve("eth_call", "base");
rejects(() => budget.reserve("eth_call", "base"), "RPC_BASE_CAP_EXCEEDED", "Base cap enforced");
budget.reserve("eth_call", "ethereum");
rejects(() => budget.reserve("eth_call", null), "RPC_TOTAL_CAP_EXCEEDED", "total cap enforced");
const qualificationBudget = new runner.Budget(tinyCaps); qualificationBudget.reserve("eth_chainId", null, true);
rejects(() => qualificationBudget.reserve("eth_chainId", null, true), "RPC_QUALIFICATION_CAP_EXCEEDED", "qualification cap enforced");
rejects(() => new runner.Budget().reserve("eth_getLogs", "base"), "RPC_METHOD_NOT_ALLOWED", "method allowlist enforced");
rejects(() => runner.enforceBatchCallCap(runner.CAPS.callsPerBatch + 1), "RPC_BATCH_CALL_CAP_EXCEEDED", "calls-per-batch cap enforced");
rejects(() => runner.enforceRequestByteCap(runner.CAPS.requestBytes + 1), "RPC_REQUEST_BATCH_CAP_EXCEEDED", "request byte cap enforced");
rejects(() => runner.enforceResponseByteCap(runner.CAPS.responseBytesPerBatch + 1), "RPC_RESPONSE_BATCH_CAP_EXCEEDED", "response byte cap enforced");
ok(runner.PLAN.baseCallsIncludingQualificationAndTerminal === 44 && runner.PLAN.baseCallsIncludingQualificationAndTerminal <= runner.CAPS.baseCalls, "Base worst-case plan including terminal header is capped");
ok(runner.PLAN.ethereumCallsIncludingQualificationAndTerminal === 14 && runner.PLAN.ethereumCallsIncludingQualificationAndTerminal <= runner.CAPS.ethereumCalls, "Ethereum plan including one bounded provider route getter and terminal header is capped");
ok(runner.PLAN.totalCallsWithMaximumQualification === 68 && runner.PLAN.totalCallsWithMaximumQualification <= runner.CAPS.totalCalls, "total plan with maximum qualification is capped");
ok(fixture.rpc.totalCalls === 54 && fixture.rpc.callsByChain.base === 40 && fixture.rpc.callsByChain.ethereum === 14 && fixture.rpc.byMethod.eth_call === 31 && fixture.rpc.byMethod.eth_getBlockByNumber === 4, "implementation-proxy fixture accounts for one route getter and both terminal headers");
const transientBudget = new runner.Budget(); transientBudget.addTransient(runner.CAPS.aggregateTransientBytes);
rejects(() => transientBudget.addTransient(1), "RPC_AGGREGATE_TRANSIENT_CAP_EXCEEDED", "aggregate transient cap enforced");
rejects(() => runner.parseInventoryText("https://sentinel.invalid", { captureMode: false }), "INVENTORY_PARSE_REQUIRES_CAPTURE_MODE", "inventory parser disabled outside explicit capture mode");
const parsedInventory = runner.parseInventoryText("https://sentinel.invalid/rpc/SENTINEL_TOKEN", { captureMode: true });
ok(parsedInventory.rows.length === 1 && parsedInventory.secrets.has("https://sentinel.invalid/rpc/sentinel_token"), "explicit capture-mode inventory parse remains memory-only");

const sentinelUrl = "https://sentinel.invalid/rpc/private-key";
const sentinelToken = "SENTINEL_PRIVATE_ACCESS_TOKEN_9f6a";
const leak = runner.leakScan({ note: sentinelUrl, credential: sentinelToken }, [sentinelUrl, sentinelToken]);
ok(!leak.passed && leak.findings.includes("URL_MATERIAL") && leak.findings.includes("INVENTORY_MATERIAL"), "sentinel URL/token leak scan rejects output");
ok(!runner.leakScan({ rawResponse: "redacted" }).passed, "raw response field rejected");
ok(!runner.leakScan({ bytecode: `0x${"60".repeat(40)}` }).passed, "raw bytecode field rejected");

for (const mutator of [
  (x) => { x.rawResponse = "secret"; },
  (x) => { x.sourceCommit = "0".repeat(40); },
  (x) => { x.sourceRuntimeAttested = true; },
  (x) => { x.promotion = true; },
  (x) => { x.policy.caps.totalCalls = 73; },
  (x) => { x.chains.base.contracts.pool.runtime.bytecode = "0x60"; },
]) {
  const bad = structuredClone(fixture); mutator(bad);
  rejects(() => validator.validateData(bad), "VALIDATION_FAILED", "validator rejects schema/hash/cap/raw mutation");
}

ok(validator.validateStaticBindings().checks >= 8, "validator static bindings pass");
ok(validator.validateManifest().checks >= 7, "trusted non-self-referential manifest validates");
const tamperedManifest = JSON.parse(fs.readFileSync(require("path").join(runner.ROOT, validator.MANIFEST_REL), "utf8"));
tamperedManifest.sourceRuntimeAttested = true;
rejects(() => validator.validateManifest(Buffer.from(`${JSON.stringify(tamperedManifest, null, 2)}\n`)), "VALIDATION_FAILED", "manifest tamper rejected");
ok(!fs.existsSync(runner.OUTPUT), "offline tests did not create fixed output");

process.stdout.write(`${JSON.stringify({ status: "PASS", checks, evidenceFixtures: 1, networkCalls: 0, inventoryReads: 0, outputCreated: false })}\n`);

module.exports = { successfulFixture };
