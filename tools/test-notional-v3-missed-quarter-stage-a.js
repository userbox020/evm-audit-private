#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { Readable } = require("stream");
const r = require("./notional-v3-missed-quarter-stage-a-runner");

let checks = 0;
function equal(actual, expected, message) { assert.deepStrictEqual(actual, expected, message); checks += 1; }
function check(value, message) { assert.ok(value, message); checks += 1; }
function throws(fn, pattern, message) { assert.throws(fn, pattern, message); checks += 1; }
async function rejects(fn, pattern, message) { await assert.rejects(fn, pattern, message); checks += 1; }

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0), R = 1804032000n, T = R + 86400n;
const PIN = { number: "100", hash: `0x${"a".repeat(64)}`, stateRoot: `0x${"b".repeat(64)}`, timestamp: T.toString() };
const ZERO = `0x${"0".repeat(40)}`;
const ACTUAL = Object.freeze({ router: "0x00000000000000000000000000000000000000a1", initializeMarkets: "0x00000000000000000000000000000000000000a2",
  views: "0x00000000000000000000000000000000000000a3", nTokenMint: "0x00000000000000000000000000000000000000a4", freeCollateral: "0x00000000000000000000000000000000000000a5" });
const runId = (suffix = "a") => `notional-v3-stage-a-20260816T120000Z-${suffix.repeat(32)}`;
function endpoint(index, family = `operator-${index}`) { return { url: new URL(`https://rpc${index}.invalid/service`), headers: {}, family, order: index - 1, budgetKey: `candidate-${index}` }; }
function inventory(count = 2) { return JSON.stringify(Array.from({ length: count }, (_, index) => ({ chainId: 1, serviceTier: "premium",
  providerMapping: { status: "sealed", operatorFamily: `operator-${index % 4 + 1}` }, url: `https://rpc${index + 1}.invalid/service` }))); }
function header(number = 100) { return { number: `0x${BigInt(number).toString(16)}`, hash: PIN.hash, stateRoot: PIN.stateRoot, timestamp: `0x${T.toString(16)}` }; }
function nToken(idValue) { return `0x${(0x1000 + idValue).toString(16).padStart(40, "0")}`; }
function storageWord(address, polluted = false) { return `0x${polluted ? "01".repeat(12) : "0".repeat(24)}${address.slice(2)}`; }
function runtime(role, links = {}, immutables = {}, selfAddress = "0x00000000000000000000000000000000000000ed") {
  const model = r.runtimeManifest().contracts[role], allImmutables = { ...immutables }; for (const item of model.immutableReferences) if (!allImmutables[item.name]) allImmutables[item.name] = "0x00000000000000000000000000000000000000ee";
  const allLinks = { ...links }; for (const item of model.linkReferences) if (!allLinks[item.libraryName]) allLinks[item.libraryName] = "0x00000000000000000000000000000000000000ef";
  const self = model.librarySelfReference ? { [model.contractName]: selfAddress } : {}, built = r.substituteRuntime(model, allLinks, allImmutables, self); assert.ok(built.complete, `${role} runtime reconstructs`); return built.code;
}
function runtimeSet() { return { proxy: runtime("proxy"), router: runtime("router", {}, { INITIALIZE_MARKET: ACTUAL.initializeMarkets, VIEWS: ACTUAL.views }),
  initializeMarkets: runtime("initializeMarkets", { nTokenMintAction: ACTUAL.nTokenMint }, {}, ACTUAL.initializeMarkets), views: runtime("views", { FreeCollateralExternal: ACTUAL.freeCollateral }),
  nTokenMint: runtime("nTokenMint", {}, {}, ACTUAL.nTokenMint), freeCollateral: runtime("freeCollateral", {}, {}, ACTUAL.freeCollateral) }; }
function markets(reference, zero = false) { return r.expectedMaturities(reference, 2).map((maturity, index) => [`0x${"0".repeat(64)}`, BigInt(maturity), zero ? 0n : BigInt(100 + index),
  zero ? 0n : BigInt(100 + index), zero ? 0n : BigInt(100 + index), zero ? 0n : 90000000n, zero ? 0n : 90000000n, zero ? 0n : BigInt(reference)]); }
function assets(idValue, reference) { return r.expectedMaturities(reference, 2).map((maturity, index) => [idValue, BigInt(maturity), BigInt(2 + index), 1000n + BigInt(index), 0n, 0]); }
function makeMock(options = {}) {
  const codes = runtimeSet(), byCodeAddress = new Map([[r.ADDRESSES.proxy, codes.proxy], [ACTUAL.router, codes.router], [ACTUAL.initializeMarkets, codes.initializeMarkets],
    [ACTUAL.views, codes.views], [ACTUAL.nTokenMint, codes.nTokenMint], [ACTUAL.freeCollateral, codes.freeCollateral]]), stats = { batches: new Map() };
  const rpc = async (ep, method, params) => {
    if (method === "eth_chainId") return { ok: true, result: "0x1" };
    if (method === "eth_getBlockByNumber") return { ok: true, result: header(params[0] === "finalized" && ep.budgetKey.endsWith("1") ? 101 : 100) };
    if (method === "eth_getCode") return { ok: true, result: byCodeAddress.get(params[0].toLowerCase()) || "0x" };
    if (method === "eth_getStorageAt") return { ok: true, result: storageWord(ACTUAL.router, options.pollutedSlot) };
    if (method !== "eth_call") return { ok: false, reason: "UNEXPECTED_METHOD" };
    const to = params[0].to.toLowerCase(), data = params[0].data, selector = data.slice(0, 10).toLowerCase();
    if (to === r.ADDRESSES.proxy) {
      if (selector === r.proxyAbi.getFunction("getImplementation").selector.toLowerCase()) return { ok: true, result: r.proxyAbi.encodeFunctionResult("getImplementation", [ACTUAL.router]) };
      let fragment; try { fragment = r.viewsAbi.getFunction(selector); } catch (_) { return { ok: false, reason: "PROXY_SELECTOR" }; }
      const decoded = r.viewsAbi.decodeFunctionData(fragment, data), idValue = fragment.name === "getNTokenAccount" || fragment.name === "getNTokenPortfolio" ?
        [...r.CURRENCY_IDS].find((value) => nToken(value) === String(decoded[0]).toLowerCase()) || 0 : Number(decoded[0]);
      if (fragment.name === "getCurrency") { if (options.revertId === idValue) return { ok: false, reason: "MOCK_REVERT" }; const token = ["0x0000000000000000000000000000000000000011", false, 18n, 1, 0n]; return { ok: true, result: r.viewsAbi.encodeFunctionResult(fragment, [token, token]) }; }
      if (fragment.name === "getCashGroup") return { ok: true, result: r.viewsAbi.encodeFunctionResult(fragment, [[2, 1, 2, 3, 4, 5, 6, 7, 8, 9]]) };
      if (fragment.name === "getActiveMarketsAtBlockTime") return { ok: true, result: r.viewsAbi.encodeFunctionResult(fragment, [markets(R)]) };
      if (fragment.name === "nTokenAddress") { if (options.noNTokenId === idValue) return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted", data: r.encodeNoNTokenError() } };
        if (options.unknownNTokenRevertId === idValue) return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted", data: r.errorAbi.encodeErrorResult("Error", ["provider-specific failure"]) } }; return { ok: true, result: r.viewsAbi.encodeFunctionResult(fragment, [nToken(idValue)]) }; }
      if (fragment.name === "getNTokenAccount") return { ok: true, result: r.viewsAbi.encodeFunctionResult(fragment, [idValue, 100n, 1n, T, "0x000000000000", 9n, 8n, 7n]) };
      if (fragment.name === "getNTokenPortfolio") return { ok: true, result: r.viewsAbi.encodeFunctionResult(fragment, idValue ? [assets(idValue, R), []] : [[], []]) };
    }
    if (to === ACTUAL.router) { const fragment = r.routerAbi.getFunction(selector); if (fragment.name === "INITIALIZE_MARKET") return { ok: true, result: r.routerAbi.encodeFunctionResult(fragment, [ACTUAL.initializeMarkets]) };
      if (fragment.name === "VIEWS") return { ok: true, result: r.routerAbi.encodeFunctionResult(fragment, [ACTUAL.views]) }; const routed = r.routerAbi.decodeFunctionData(fragment, data)[0].toLowerCase();
      return { ok: true, result: r.routerAbi.encodeFunctionResult(fragment, [routed === r.INITIALIZE_SELECTOR ? ACTUAL.initializeMarkets : ACTUAL.views]) }; }
    if (to === ACTUAL.initializeMarkets) return { ok: true, result: r.libAbi.encodeFunctionResult("getLibInfo", [ACTUAL.nTokenMint]) };
    if (to === ACTUAL.views) return { ok: true, result: r.libAbi.encodeFunctionResult("getLibInfo", [ACTUAL.freeCollateral]) };
    return { ok: false, reason: "CALL_TARGET" };
  };
  const rpcBatch = async (ep, requests, ctx) => { stats.batches.set(ep.budgetKey, (stats.batches.get(ep.budgetKey) || 0) + 1); if (options.failCapability === ep.budgetKey) return requests.map(() => ({ ok: false, reason: "CAPABILITY_FAIL" }));
    return Promise.all(requests.map((request) => rpc(ep, request.method, request.params, ctx))); };
  return { rpc, rpcBatch, stats };
}
function context(mock) { return { budget: new r.Budget(() => 0), nextId: 0, rpc: mock.rpc, rpcBatch: mock.rpcBatch, policy: r.seedPolicy(), phase: "test" }; }
function fakeHttps(parts, refs = {}) { return (_options, callback) => { const request = new EventEmitter(); refs.request = request; request.destroyed = false; request.destroy = () => { request.destroyed = true; };
  request.end = () => process.nextTick(() => { const response = new EventEmitter(); refs.response = response; response.statusCode = 200; response.destroyed = false; response.destroy = () => { response.destroyed = true; }; callback(response);
    for (const part of parts) { if (response.destroyed) break; response.emit("data", part); } if (!response.destroyed) response.emit("end"); }); return request; }; }
function fixtureState(idValue, initializedReference, reference, mode = "healthy") {
  const zero = mode === "trigger" || mode === "zero", tuples = zero ? markets(reference, true) : markets(reference), current = tuples.map((value) => ({ maturity: value[1].toString(), totalfCash: value[2].toString(), totalPrimeCash: value[3].toString(),
    totalLiquidity: value[4].toString(), lastImpliedRate: value[5].toString(), oracleRate: value[6].toString(), previousTradeTime: value[7].toString() }));
  return { currencyId: idValue, baseErrors: Object.fromEntries(r.VIEW_NAMES.map((name) => [name, null])), nToken: nToken(idValue), cashGroup: { maxMarketIndex: 2 }, nTokenAccount: { currencyId: idValue },
    initializedReferenceTime: BigInt(initializedReference).toString(), referenceTime: BigInt(reference).toString(), lagQuarters: ((BigInt(reference) - BigInt(initializedReference)) / r.QUARTER).toString(),
    blockTimestamp: BigInt(reference).toString(), lastInitializedTime: BigInt(initializedReference).toString(), timingValid: true,
    liquidityTokens: assets(idValue, initializedReference).map((value) => ({ currencyId: idValue, maturity: value[1].toString(), assetType: value[2].toString(), notional: value[3].toString(), storageState: 0 })), netfCashAssets: [], markets: current, historicalMarkets: [] };
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(path.join(r.ROOT, ...r.FIXTURE_REL.split("/")), "utf8")); equal(fixture.fixtureClasses.length, 16, "exactly sixteen Oracle fixture classes");

  // Explicit sealed provider mapping only; no hostname or path heuristics.
  equal(r.parseInventoryText(JSON.stringify([{ serviceTier: "premium", url: "https://fallback.invalid/long/premium/path" }])).rows.length, 0, "hostname/path premium fallback removed");
  equal(r.parseInventoryText(inventory(6)).rows.length, 6, "six explicitly mapped premium candidates retained");
  const fiveFamilies = JSON.stringify(Array.from({ length: 5 }, (_, index) => ({ chainId: 1, serviceTier: "premium", providerMapping: { status: "sealed", operatorFamily: `op${index}` }, url: `https://h${index}.invalid/rpc` })));
  equal(r.parseInventoryText(fiveFamilies).rows.length, 4, "operator families capped at four");

  // Common numeric P, one capability batch per attempted candidate, and qualification-only replacement.
  const replacementMock = makeMock({ failCapability: "candidate-1" }), replacement = await r.qualifyDescriptors([endpoint(1), endpoint(2), endpoint(3)], context(replacementMock));
  equal(replacement.ok, true, "capability replacement succeeds during qualification"); equal(replacement.tag, "0x64", "common P is minimum finalized pool height"); equal(replacement.rejectedCalls, 4, "one rejected capability batch consumes four bounded calls");
  equal([...replacementMock.stats.batches.values()], [1, 1, 1], "one capability batch per attempted candidate"); equal(replacement.counts.replacements, 1, "one qualification replacement recorded");

  // Numeric-only guard, dynamic allowlist, denylist, and polluted slot.
  const policy = r.seedPolicy(); throws(() => r.ensureAllowedRequest("eth_getCode", [ACTUAL.router, "0x64"], policy), /CODE_ADDRESS_NOT_ALLOWED/u, "actual Router denied before consensus admission");
  r.admit(policy, ACTUAL.router, "code"); r.admit(policy, ACTUAL.router, "call", [r.routerAbi.getFunction("VIEWS").selector]); check(r.ensureAllowedRequest("eth_getCode", [ACTUAL.router, "0x64"], policy), "consensus Router dynamically admitted");
  throws(() => r.ensureAllowedRequest("eth_getCode", [ACTUAL.router, "latest"], policy), /NUMERIC_BLOCK_TAG_REQUIRED/u, "latest rejected");
  throws(() => r.ensureAllowedRequest("eth_call", [{ to: ACTUAL.router, data: `${r.INITIALIZE_SELECTOR}${"0".repeat(128)}` }, "0x64"], policy), /CALL_TARGET_OR_SELECTOR_NOT_ALLOWED/u, "initializeMarkets call denied");
  for (const method of ["eth_sendRawTransaction", "eth_sign", "debug_traceCall", "eth_estimateGas"]) throws(() => r.ensureAllowedRequest(method, [], policy), /METHOD_NOT_ALLOWED/u, `${method} denied`);
  equal(r.storageAddress(storageWord(ACTUAL.router)), ACTUAL.router, "clean slot decoded"); equal(r.storageAddress(storageWord(ACTUAL.router, true)), null, "polluted upper twelve slot bytes rejected");

  // Resource-budget boundaries remain explicit.
  r.assertBatchSize(Array(24).fill({})); checks += 1; throws(() => r.assertBatchSize(Array(25).fill({})), /BATCH_CAP_EXCEEDED/u, "batch 25 rejected");
  r.codeRecord(`0x${"00".repeat(r.CAPS.runtimeBytes)}`); checks += 1; throws(() => r.codeRecord(`0x${"00".repeat(r.CAPS.runtimeBytes + 1)}`), /RUNTIME_CAP_EXCEEDED/u, "runtime cap +1 rejected");
  r.capDecoded("getActiveMarketsAtBlockTime", Array(7)); checks += 1; throws(() => r.capDecoded("getActiveMarketsAtBlockTime", Array(8)), /MARKET_ARRAY_CAP_EXCEEDED/u, "market cap +1 rejected");
  r.capDecoded("getNTokenPortfolio", [Array(7), Array(256)]); checks += 1; throws(() => r.capDecoded("getNTokenPortfolio", [Array(8), []]), /LIQUIDITY_ARRAY_CAP_EXCEEDED/u, "liquidity cap +1 rejected");
  throws(() => r.capDecoded("getNTokenPortfolio", [[], Array(257)]), /NET_FCASH_ARRAY_CAP_EXCEEDED/u, "net fCash cap +1 rejected");
  const fixedBudget = new r.Budget(() => 0); for (let i = 0; i < 77; i += 1) fixedBudget.call("selected", "evidenceBase"); checks += 1; throws(() => fixedBudget.call("selected", "terminal"), /SELECTED_BASE_CALL_CAP_EXCEEDED/u, "fixed call 78 rejected");
  const conditionalBudget = new r.Budget(() => 0); for (let i = 0; i < 9; i += 1) conditionalBudget.call("selected", "evidenceConditional"); checks += 1; throws(() => conditionalBudget.call("selected", "evidenceConditional"), /SELECTED_CONDITIONAL_CALL_CAP_EXCEEDED/u, "conditional call 10 rejected");
  const responseBudget = new r.Budget(() => 0); responseBudget.body("selected", r.CAPS.responseBytes); checks += 1; throws(() => responseBudget.body("other", r.CAPS.responseBytes + 1), /RESPONSE_BODY_CAP_EXCEEDED/u, "response cap +1 rejected");

  // Transactional endpoint and aggregate response counters never mutate on overflow.
  const endpointBudget = new r.Budget(() => 0, { ...r.CAPS, responseBytes: 10, endpointResponseBytes: 15, aggregateResponseBytes: 100 }); endpointBudget.body("selected", 10); checks += 1;
  throws(() => endpointBudget.body("selected", 6), /ENDPOINT_RESPONSE_CAP_EXCEEDED/u, "endpoint overflow rejected before mutation"); equal(endpointBudget.row("selected").responseBytes, 10, "endpoint counter transactional"); equal(endpointBudget.bytes, 10, "aggregate unchanged after endpoint overflow");
  const aggregateBudget = new r.Budget(() => 0, { ...r.CAPS, responseBytes: 10, endpointResponseBytes: 100, aggregateResponseBytes: 15 }); aggregateBudget.body("one", 10); checks += 1;
  throws(() => aggregateBudget.body("two", 6), /AGGREGATE_RESPONSE_CAP_EXCEEDED/u, "aggregate overflow rejected before mutation"); equal(aggregateBudget.row("two").responseBytes, 0, "second endpoint unchanged after aggregate overflow"); equal(aggregateBudget.bytes, 10, "aggregate counter transactional");

  // Split chunks accept the exact cumulative boundary; valid JSON prefix plus overcap whitespace never parses.
  const responseJson = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" })), exactBody = Buffer.concat([responseJson, Buffer.alloc(r.CAPS.responseBytes - responseJson.length, 0x20)]), exactRefs = {}, exactHttpBudget = new r.Budget(() => 0);
  const exactRow = await r.productionPost(endpoint(1), { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { budget: exactHttpBudget, httpsRequest: fakeHttps([exactBody.subarray(0, 333333), exactBody.subarray(333333)], exactRefs) });
  equal(exactRow, { jsonrpc: "2.0", id: 1, result: "0x1" }, "split response at exact cumulative boundary parses"); equal(exactHttpBudget.bytes, r.CAPS.responseBytes, "exact boundary bytes committed"); check(exactRefs.request.destroyed, "exact response request closed");
  const overRefs = {}, overHttpBudget = new r.Budget(() => 0), overRow = await r.productionPost(endpoint(1), { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    { budget: overHttpBudget, httpsRequest: fakeHttps([responseJson, Buffer.alloc(r.CAPS.responseBytes - responseJson.length + 1, 0x20)], overRefs) });
  equal(overRow, null, "valid JSON prefix followed by overcap whitespace rejected"); check(overRefs.request.destroyed && overRefs.response.destroyed, "overcap permanently destroys response and request"); equal(overHttpBudget.bytes, responseJson.length, "crossing chunk never mutates byte budget");

  // Solidity CBOR must be fully parsed and consumed.
  const proxyCode = runtime("proxy"), cbor = r.cborBoundary(proxyCode); check(cbor?.fullyConsumed, "Solidity CBOR map fully consumed"); equal(cbor.bytes, r.runtimeManifest().contracts.proxy.cbor.bytes, "CBOR trailer length exact");
  equal(r.cborBoundary(`${proxyCode.slice(0, -6)}00ffff`), null, "invalid CBOR rejected");

  // solc 0.7.6 library-self proof: exact PUSH20 <self> ADDRESS EQ prefix only.
  const nTokenModel = r.runtimeManifest().contracts.nTokenMint, selfPrefix = `73${"00".repeat(20)}3014`; equal(nTokenModel.contractKind, "library", "AST contractKind records nTokenMintAction library");
  equal(nTokenModel.runtimeTemplate.slice(0, selfPrefix.length), selfPrefix, "exact solc 0.7.6 library-self prefix"); equal(nTokenModel.librarySelfReference, { start: 1, length: 20, exactPrefix: selfPrefix, proof: "solc-0.7.6 PUSH20 <self> ADDRESS EQ" }, "distinct library-self range recorded");
  const wrongPrefixModel = JSON.parse(JSON.stringify(nTokenModel)); wrongPrefixModel.runtimeTemplate = `74${wrongPrefixModel.runtimeTemplate.slice(2)}`; throws(() => r.validateLibrarySelfReference(wrongPrefixModel), /LIBRARY_SELF_REFERENCE_INVALID/u, "wrong library prefix rejected");
  const selfRuntime = runtime("nTokenMint", {}, {}, ACTUAL.nTokenMint), selfRange = nTokenModel.librarySelfReference; equal(selfRuntime.slice(2 + selfRange.start * 2, 2 + (selfRange.start + selfRange.length) * 2), ACTUAL.nTokenMint.slice(2), "discovered library address substituted at self range");
  equal(r.compareRuntime(selfRuntime, nTokenModel, { librarySelf: { nTokenMintAction: ACTUAL.freeCollateral } }).reason, "KNOWN_BINDING_RANGE_MISMATCH", "wrong library-self address rejected");

  // Exact bounded Error(string) normalization only; raw/provider errors remain generic.
  equal(r.normalizeRpcError({ data: r.encodeNoNTokenError() }), "NO_NTOKEN_REVERT", "exact No nToken revert normalized");
  equal(r.normalizeRpcError({ data: r.errorAbi.encodeErrorResult("Error", ["No nToken for currency "]) }), "RPC_UNAVAILABLE", "near-match revert remains unknown");

  // Bytewise runtime equivalence outside only compiler-declared ranges; selector false positives fail.
  equal(r.compareRuntime(proxyCode, r.runtimeManifest().contracts.proxy).level, "full", "exact proxy fully bound"); const at = 20, selectorBytes = r.routerAbi.getFunction("VIEWS").selector.slice(2), falsePositive = `${proxyCode.slice(0, 2 + at * 2)}${selectorBytes}${proxyCode.slice(2 + (at + 4) * 2)}`;
  const falseBinding = r.compareRuntime(falsePositive, r.runtimeManifest().contracts.proxy); equal(falseBinding.level, "mismatch", "selector-containing executable mismatch rejected"); equal(falseBinding.firstDiffOffset, at, "first differing byte reported");
  const routerBinding = r.compareRuntime(runtimeSet().router, r.runtimeManifest().contracts.router, { immutables: { INITIALIZE_MARKET: ACTUAL.initializeMarkets, VIEWS: ACTUAL.views } });
  equal(routerBinding.level, "structural", "Router structural requires byte equality outside declared ranges"); equal(routerBinding.normalizedExecutableSha256, routerBinding.expectedNormalizedExecutableSha256, "recognized-range normalized hashes agree"); check(routerBinding.rawRuntimeHex.startsWith("0x"), "bounded raw runtime published");
  const knownRange = routerBinding.recognizedRanges.find((range) => range.name === "INITIALIZE_MARKET"), wrongKnown = `${runtimeSet().router.slice(0, 2 + knownRange.start * 2)}${"ff".repeat(knownRange.length)}${runtimeSet().router.slice(2 + (knownRange.start + knownRange.length) * 2)}`;
  equal(r.compareRuntime(wrongKnown, r.runtimeManifest().contracts.router, { immutables: { INITIALIZE_MARKET: ACTUAL.initializeMarkets, VIEWS: ACTUAL.views } }).reason, "KNOWN_BINDING_RANGE_MISMATCH", "known declared range mismatch rejected");

  // Correct I=floor(L/Q)*Q and coherence/classifier boundaries.
  const nonaligned = r.timing(R + 86400n, R + 2n * 86400n); equal(nonaligned.initializedReferenceTime, R.toString(), "nonaligned L floors to I"); equal(nonaligned.lagQuarters, "0", "L=R+1day remains lag zero");
  const healthy = fixtureState(2, R, R), healthyCoherence = r.currencyCoherent(2, healthy); equal(healthyCoherence.coherent, true, "healthy maturity and portfolio coherent");
  equal(r.classifyCurrency({ ...healthy, coherence: healthyCoherence, sourceState: "SOURCE_BOUND" }), "CURRENT_HEALTHY", "lag zero positive rates healthy");
  const lagOne = fixtureState(2, R - r.QUARTER, R, "zero"), lagOneCoherence = r.currencyCoherent(2, lagOne); equal(r.classifyCurrency({ ...lagOne, coherence: lagOneCoherence, sourceState: "SOURCE_BOUND" }), "DUE_BUT_RECOVERABLE", "lag one coherent fully-zero current namespace recoverable");
  const trigger = fixtureState(2, R - 2n * r.QUARTER, R, "trigger"); trigger.historicalMarkets = markets(R - 2n * r.QUARTER).map((value) => ({ maturity: value[1].toString(), totalLiquidity: value[4].toString(), lastImpliedRate: value[5].toString(), oracleRate: value[6].toString() }));
  const triggerCoherence = r.currencyCoherent(2, trigger); equal(r.classifyCurrency({ ...trigger, coherence: triggerCoherence, sourceState: "SOURCE_BOUND" }), "MISSED_QUARTER_TRIGGER_PRESENT", "lag two old stored/historical and zero current trigger");
  const malformed = JSON.parse(JSON.stringify(healthy)); malformed.markets[0].maturity = (R + 123n).toString(); equal(r.currencyCoherent(2, malformed).coherent, false, "malformed current maturity rejected");
  const noToken = JSON.parse(JSON.stringify(healthy)); noToken.nToken = ZERO; noToken.baseErrors.nTokenAddress = "NO_NTOKEN_REVERT"; equal(r.currencyCoherent(2, noToken).applicable, false, "exact recognized no-nToken revert is not applicable");
  const noTokenMissingCurrency = JSON.parse(JSON.stringify(noToken)); noTokenMissingCurrency.baseErrors.getCurrency = "RPC_UNAVAILABLE"; equal(r.currencyCoherent(2, noTokenMissingCurrency).applicable, null, "recognized no-nToken still requires currency and cash-group success");
  const unknownNoToken = JSON.parse(JSON.stringify(healthy)); unknownNoToken.nToken = ZERO; unknownNoToken.baseErrors.nTokenAddress = "RPC_UNAVAILABLE"; equal(r.currencyCoherent(2, unknownNoToken).applicable, null, "unknown nToken provider revert remains unknown");
  const notListed = JSON.parse(JSON.stringify(healthy)); notListed.cashGroup.maxMarketIndex = 1; equal(r.currencyCoherent(2, notListed).applicable, false, "maxMarketIndex below two not applicable");
  const futureTiming = r.timing(R + 1n, R), futureState = { ...JSON.parse(JSON.stringify(healthy)), ...futureTiming }; const futureCoherence = r.currencyCoherent(2, futureState);
  equal(futureTiming.timingValid, false, "raw L greater than block T invalid even in same quarter"); equal(r.classifyCurrency({ ...futureState, coherence: futureCoherence, sourceState: "SOURCE_BOUND" }), "STATE_INCONSISTENT_UNKNOWN", "future raw L classifies unknown");
  check(r.isValidBitmapMaturity(R, R + 86400n), "DateTime daily bitmap maturity valid relative raw L");
  const malformedNet = JSON.parse(JSON.stringify(healthy)); malformedNet.netfCashAssets = [{ currencyId: 2, maturity: (R + 1n).toString(), assetType: "1", notional: "1", storageState: 0 }]; equal(r.currencyCoherent(2, malformedNet).reason, "NET_FCASH_SHAPE", "malformed net fCash rejected");
  const validNet = JSON.parse(JSON.stringify(healthy)); validNet.netfCashAssets = [{ currencyId: 2, maturity: (R + 86400n).toString(), assetType: "1", notional: "1", storageState: 0 }, { currencyId: 2, maturity: (R + 172800n).toString(), assetType: "1", notional: "-1", storageState: 0 }];
  equal(r.currencyCoherent(2, validNet).coherent, true, "strict ordered valid bitmap net fCash accepted"); const wrongNetType = JSON.parse(JSON.stringify(validNet)); wrongNetType.netfCashAssets[1].assetType = "2"; equal(r.currencyCoherent(2, wrongNetType).reason, "NET_FCASH_SHAPE", "wrong net fCash type rejected");
  const wrongNetOrder = JSON.parse(JSON.stringify(validNet)); wrongNetOrder.netfCashAssets.reverse(); equal(r.currencyCoherent(2, wrongNetOrder).reason, "NET_FCASH_SHAPE", "unordered net fCash rejected");
  const partial = JSON.parse(JSON.stringify(healthy)); partial.markets.pop(); equal(r.currencyCoherent(2, partial).reason, "CURRENT_MARKET_COUNT", "partial current namespace rejected");
  const empty = JSON.parse(JSON.stringify(healthy)); empty.markets = []; equal(r.currencyCoherent(2, empty).reason, "CURRENT_MARKET_COUNT", "empty current namespace rejected");
  const wrongStorage = JSON.parse(JSON.stringify(healthy)); wrongStorage.liquidityTokens[0].storageState = 1; equal(r.currencyCoherent(2, wrongStorage).reason, "STORED_PORTFOLIO_SHAPE", "nonzero liquidity storage state rejected");
  const nonfirstZero = JSON.parse(JSON.stringify(trigger)); nonfirstZero.liquidityTokens[1].notional = "0"; const nonfirstCoherence = r.currencyCoherent(2, nonfirstZero);
  equal(r.classifyCurrency({ ...nonfirstZero, coherence: nonfirstCoherence, sourceState: "SOURCE_BOUND" }), "STATE_INCONSISTENT_UNKNOWN", "nonfirst zero-liquidity trigger rejected");
  const partiallyZeroLagOne = JSON.parse(JSON.stringify(lagOne)); partiallyZeroLagOne.markets[1].totalfCash = "1"; equal(r.classifyCurrency({ ...partiallyZeroLagOne, coherence: r.currencyCoherent(2, partiallyZeroLagOne), sourceState: "SOURCE_BOUND" }), "STATE_INCONSISTENT_UNKNOWN", "partially zero lag-one namespace rejected");

  // Full two-family successful runCapture, including config drift, per-ID revert/no-token, equality, terminal publication.
  const fullMock = makeMock({ revertId: 3, noNTokenId: 5, unknownNTokenRevertId: 6 }), fullTemp = fs.mkdtempSync(path.join("C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode", `${r.STEM}-full-`)), fullMarker = path.join(fullTemp, "consumed");
  let full;
  try { full = await r.runCapture({ runId: runId("f") }, { now: () => NOW, verifyPackage: () => true, markerPath: fullMarker, outputRoot: fullTemp, createInventoryStream: () => Readable.from([inventory(2)]), rpc: fullMock.rpc, rpcBatch: fullMock.rpcBatch });
    equal(full.status, "NOTIONAL_STAGE_A_COMPLETE", "full mocked two-family capture completes"); equal(full.familyAgreement, true, "full captures equal"); equal(full.evidence.topology.sourceState, "CONFIG_DRIFT_BOUND", "config drift remains separately source-bound");
    equal(full.evidence.topology.configDrift.router, true, "Router config drift explicit"); equal(full.evidence.currencies.find((row) => row.currencyId === 3).classification, "STATE_INCONSISTENT_UNKNOWN", "per-ID revert does not abort global capture");
    equal(full.evidence.currencies.find((row) => row.currencyId === 5).classification, "NOT_APPLICABLE", "genuine JSON-RPC No nToken revert per-ID not applicable"); equal(full.evidence.currencies.find((row) => row.currencyId === 6).classification, "STATE_INCONSISTENT_UNKNOWN", "unknown JSON-RPC nToken revert stays unknown");
    equal(full.evidence.currencies.find((row) => row.currencyId === 2).classification, "CURRENT_HEALTHY", "other ID remains healthy");
    equal(full.evidence.currencies.find((row) => row.currencyId === 5).baseErrors.nTokenAddress, "NO_NTOKEN_REVERT", "only normalized internal no-nToken code is retained"); check(!JSON.stringify(full).includes(r.encodeNoNTokenError().slice(2)), "raw revert bytes absent from output");
    equal(full.evidence.topology.runtimes.nTokenMint.level, "full", "dynamically discovered nTokenMint library self-address fully bound"); equal(full.evidence.topology.runtimes.freeCollateral.reconstruction.librarySelf, ["FreeCollateralExternal"], "dynamically discovered FreeCollateral library self-address recorded");
    equal(full.budget.calls, 154, "two selected families remain exactly 77 fixed calls each"); equal([...fullMock.stats.batches.values()], [1, 1], "successful run has one capability batch per candidate");
    check(fs.existsSync(fullMarker), "consumed marker durable"); const runDir = path.join(fullTemp, `${r.STEM}-${runId("f")}`); check(fs.existsSync(path.join(runDir, "fallback-terminal-rejected.json")), "fallback preallocated before consumption");
    check(fs.existsSync(path.join(runDir, "result.json")) && fs.existsSync(path.join(runDir, "result.sha256")) && fs.existsSync(path.join(runDir, "publication.json")), "final result/hash atomically activated by publication marker");
  } finally { fs.rmSync(fullTemp, { recursive: true, force: true }); }

  // Publication ordering and fault matrix: verify, reserve/preexisting output, consume, inventory, qualification, capture, equality, terminal, publication.
  const faultRoot = () => fs.mkdtempSync(path.join("C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode", `${r.STEM}-fault-`));
  { const dir = faultRoot(), marker = path.join(dir, "marker"); try { await rejects(() => r.runCapture({ runId: runId("a") }, { now: () => NOW, markerPath: marker, outputRoot: dir, verifyPackage: () => { throw new Error("VERIFY_FAULT"); } }), /VERIFY_FAULT/u, "verify fault before reservation"); equal(fs.existsSync(marker), false, "verify fault leaves no marker"); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  { const dir = faultRoot(), marker = path.join(dir, "marker"), reserved = path.join(dir, `${r.STEM}-${runId("b")}`); fs.mkdirSync(reserved); try { await rejects(() => r.runCapture({ runId: runId("b") }, { now: () => NOW, markerPath: marker, outputRoot: dir, verifyPackage: () => true }), /EEXIST/u, "preexisting output reservation rejects"); equal(fs.existsSync(marker), false, "preexisting output cannot consume"); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  { const dir = faultRoot(), marker = path.join(dir, "marker"); try { await rejects(() => r.runCapture({ runId: runId("c") }, { now: () => NOW, markerPath: marker, outputRoot: dir, verifyPackage: () => true, consume: () => { throw new Error("CONSUME_FAULT"); } }), /CONSUME_FAULT/u, "consume fault propagates");
      equal(fs.existsSync(marker), false, "consume fault has no marker"); check(fs.existsSync(path.join(dir, `${r.STEM}-${runId("c")}`, "fallback-terminal-rejected.json")), "consume-stage fallback already durable"); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  const injectedQualification = { ok: true, selected: [{}, {}], pin: PIN, tag: "0x64", rejectedCalls: 0, counts: {} };
  async function postConsumeFault(suffix, overrides, expectedReason) { const dir = faultRoot(), marker = path.join(dir, "marker"); try { const value = await r.runCapture({ runId: runId(suffix) }, { now: () => NOW, markerPath: marker, outputRoot: dir, verifyPackage: () => true,
      createInventoryStream: () => Readable.from([inventory(2)]), qualify: async () => injectedQualification, captureFamily: async () => ({ same: true }), terminalRecheck: async () => true, ...overrides });
    equal(value.status, "NOTIONAL_STAGE_A_REJECTED", `${expectedReason} terminal reject`); check(fs.existsSync(marker), `${expectedReason} marker remains`); const runDir = path.join(dir, `${r.STEM}-${runId(suffix)}`);
    check(fs.existsSync(path.join(runDir, "fallback-terminal-rejected.json")) && fs.existsSync(path.join(runDir, "fallback-terminal-rejected.sha256")), `${expectedReason} fallback+hash guaranteed`); return { value, runDir }; } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  await postConsumeFault("d", { createInventoryStream: () => Readable.from([Buffer.alloc(r.CAPS.inventoryBytes + 1)]) }, "inventory");
  await postConsumeFault("e", { qualify: async () => { throw new Error("QUALIFICATION_FAULT"); } }, "qualification");
  await postConsumeFault("1", { captureFamily: async () => { throw new Error("CAPTURE_FAULT"); } }, "capture");
  { let count = 0; await postConsumeFault("2", { captureFamily: async () => ({ value: ++count }) }, "cross-family equality"); }
  await postConsumeFault("3", { terminalRecheck: async () => false }, "terminal recheck");
  const publication = await postConsumeFault("4", { publish: () => { throw new Error("PUBLICATION_FAULT"); } }, "publication"); equal(publication.value.fallbackActive, true, "publication failure activates preallocated fallback");
  const endpointOverflowBudget = new r.Budget(() => 0, { ...r.CAPS, responseBytes: 10, endpointResponseBytes: 15, aggregateResponseBytes: 100 });
  const endpointOverflow = await postConsumeFault("6", { budget: endpointOverflowBudget, captureFamily: async (_selected, _pin, _tag, ctx) => { ctx.budget.body("selected", 10); ctx.budget.body("selected", 6); return { same: true }; } }, "endpoint response overflow");
  equal(endpointOverflow.value.reason, "ENDPOINT_RESPONSE_CAP_EXCEEDED", "endpoint overflow terminal reason sanitized");
  const aggregateOverflowBudget = new r.Budget(() => 0, { ...r.CAPS, responseBytes: 10, endpointResponseBytes: 100, aggregateResponseBytes: 15 });
  const aggregateOverflow = await postConsumeFault("7", { budget: aggregateOverflowBudget, captureFamily: async (_selected, _pin, _tag, ctx) => { ctx.budget.body("one", 10); ctx.budget.body("two", 6); return { same: true }; } }, "aggregate response overflow");
  equal(aggregateOverflow.value.reason, "AGGREGATE_RESPONSE_CAP_EXCEEDED", "aggregate overflow terminal reason sanitized");

  // Marker preexistence: reservation occurs first, but no newly consumed run can lack a terminal fallback.
  { const dir = faultRoot(), marker = path.join(dir, "marker"); fs.writeFileSync(marker, "preexisting"); try { await rejects(() => r.runCapture({ runId: runId("5") }, { now: () => NOW, markerPath: marker, outputRoot: dir, verifyPackage: () => true }), /EEXIST/u, "preexisting marker rejects after reservation");
      check(fs.existsSync(path.join(dir, `${r.STEM}-${runId("5")}`, "fallback-terminal-rejected.json")), "preexisting marker path still has fallback"); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }

  throws(() => r.assertNoSecrets({ value: "credential-secret" }, ["credential-secret"]), /PROVIDER_MATERIAL/u, "secret corpus rejected"); equal(r.parseArgs([r.CAPTURE_FLAG, "--run-id", runId()]).runId, runId(), "exact launcher order accepted");
  throws(() => r.parseArgs(["--run-id", runId(), r.CAPTURE_FLAG]), /EXACT_CAPTURE_COMMAND_REQUIRED/u, "reordered command rejected"); const preflight = r.dryPreflight(); equal(preflight.networkReads, 0, "offline preflight network zero"); equal(preflight.inventoryReads, 0, "offline preflight inventory zero"); equal(preflight.captureExecuted, false, "capture absent during tests");
  process.stdout.write(`Notional V3 Stage-A repaired tests passed: ${checks} checks, ${fixture.fixtureClasses.length} Oracle fixture classes, one full mocked two-family capture, zero real network/inventory/capture\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
