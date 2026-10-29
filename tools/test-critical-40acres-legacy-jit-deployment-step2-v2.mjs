#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as runner from "./critical-40acres-legacy-jit-deployment-step2-v2-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", `${runner.PACKAGE_ID}-fixtures.json`), "utf8"));
let checks = 0;
let mockedRpcElements = 0;
function equal(actual, expected, message) { checks += 1; assert.deepEqual(actual, expected, `check ${checks}: ${message}`); }
function check(value, message) { checks += 1; assert.ok(value, `check ${checks}: ${message}`); }
function throws(fn, code, message) { checks += 1; assert.throws(fn, new RegExp(code, "u"), `check ${checks}: ${message}`); }
async function rejects(fn, code, message) { checks += 1; await assert.rejects(fn, new RegExp(code, "u"), `check ${checks}: ${message}`); }

const ADDRESS = Object.freeze({
  vault: "0x1111111111111111111111111111111111111111", asset: "0x2222222222222222222222222222222222222222",
  owner: "0x3333333333333333333333333333333333333333", implementation: "0x4444444444444444444444444444444444444444",
  vaultImplementation: "0x5555555555555555555555555555555555555555"
});
const cv = (value) => ({ value, error: null });
const missing = (error = "RPC_ERROR") => ({ value: null, error });
function artifactCatalog(v2 = true) {
  const loan = runner.normalizeArtifactObject({ contractName: v2 ? "LoanV2" : "Loan", deployedBytecode: { object: "6001" } },
    { family: v2 ? "LoanV2" : "Loan", contractName: v2 ? "LoanV2" : "Loan", path: "targets/40-acres-loan-contracts/out/Loan.json", artifactSha256: "a".repeat(64) });
  const vault = runner.normalizeArtifactObject({ contractName: "VaultV2", deployedBytecode: { object: "6002" } },
    { family: "VaultV2", contractName: "VaultV2", path: "targets/40-acres-loan-contracts/out/VaultV2.json", artifactSha256: "b".repeat(64) });
  return { manifestSha256: "c".repeat(64), sourceCommit: runner.SOURCE_COMMIT, entries: [loan, vault] };
}
function validObserved(overrides = {}) {
  const timestamp = 1_700_000_000n, epoch = (timestamp / runner.WEEK) * runner.WEEK, remaining = epoch + runner.WEEK - timestamp;
  const reward = 200_000_000n, locked = remaining * reward / runner.WEEK, cash = 1_200_000_000n;
  const base = {
    pin: { number: "123456", hash: `0x${"ab".repeat(32)}`, timestamp: timestamp.toString(), finalityMethod: "finalized" }, errors: [],
    loan: { implementation: { address: ADDRESS.implementation, error: null }, admin: { address: runner.ZERO_ADDRESS, error: null },
      proxyCode: runner.codeInfo("0x6000"), implementationCode: runner.codeInfo("0x6001") },
    vault: { address: ADDRESS.vault, implementation: { address: ADDRESS.vaultImplementation, error: null },
      admin: { address: runner.ZERO_ADDRESS, error: null }, proxyCode: runner.codeInfo("0x6000"), implementationCode: runner.codeInfo("0x6002") },
    calls: {
      owner: cv(ADDRESS.owner), loanVault: cv(ADDRESS.vault), lendingVault: cv(ADDRESS.vault), loanAsset: cv(ADDRESS.asset), lendingAsset: cv(ADDRESS.asset),
      activeAssets: cv("0"), lastEpochReward: cv(reward.toString()), rewardsPerEpoch: cv(reward.toString()), rewardsRate: cv("10000"), paused: missing(),
      vaultLoan: cv(runner.CANDIDATES[0].loan), vaultAsset: cv(ADDRESS.asset), asset: cv(ADDRESS.asset), totalSupply: cv("1000000000"),
      totalAssets: cv((cash - locked).toString()), epochRewardsLocked: cv(locked.toString()), cash: cv(cash.toString()), allowance: cv((2n ** 256n - 1n).toString())
    }, terminal: null
  };
  base.terminal = { stable: true, block: { ...base.pin }, loanImplementation: { ...base.loan.implementation }, loanAdmin: { ...base.loan.admin },
    owner: { ...base.calls.owner }, loanVault: { ...base.calls.loanVault }, loanAsset: { ...base.calls.loanAsset },
    vaultImplementation: { ...base.vault.implementation }, vaultAdmin: { ...base.vault.admin }, vaultLoan: { ...base.calls.vaultLoan },
    vaultAsset: { ...base.calls.vaultAsset }, assetAlias: { ...base.calls.asset } };
  return Object.assign(base, overrides);
}
const clone = (value) => structuredClone(value);
const toHex = (bytes) => `0x${bytes.toString("hex")}`;
const paddedAddress = (address) => Buffer.from(`${"00".repeat(12)}${address.slice(2)}`, "hex");
function boundRawFixture(artifacts) {
  const by = Object.fromEntries(artifacts.entries.map((entry) => [entry.family, entry])), loan = Buffer.from(by.LoanV2._templateBytes),
    vault = Buffer.from(by.VaultV2._templateBytes), loanUtils = Buffer.from(by.LoanUtils._templateBytes), portfolio = Buffer.from(by.PortfolioLoanLib._templateBytes);
  const loanUtilsAddress = "0x6666666666666666666666666666666666666666", portfolioAddress = "0x7777777777777777777777777777777777777777";
  for (const range of by.LoanV2.immutableReferences) paddedAddress(ADDRESS.implementation).copy(loan, range.start);
  for (const range of by.VaultV2.immutableReferences) paddedAddress(ADDRESS.vaultImplementation).copy(vault, range.start);
  for (const range of by.LoanV2.linkReferences) Buffer.from((range.library === "LoanUtils" ? loanUtilsAddress : portfolioAddress).slice(2), "hex").copy(loan, range.start);
  for (const range of by.PortfolioLoanLib.immutableReferences) paddedAddress(portfolioAddress).copy(portfolio, range.start);
  return { loanCode: toHex(loan), vaultCode: toHex(vault), loanUtilsCode: toHex(loanUtils), portfolioLoanLibCode: toHex(portfolio),
    loanImplementation: ADDRESS.implementation, vaultImplementation: ADDRESS.vaultImplementation };
}
function mutateCode(value, start, bytes) { const out = Buffer.from(value.slice(2), "hex"); Buffer.from(bytes).copy(out, start); return toHex(out); }
function mutableArtifacts(artifacts) {
  const out = { ...artifacts, referenceRules: clone(artifacts.referenceRules), entries: artifacts.entries.map((entry) => {
    const copy = { ...entry, linkReferences: clone(entry.linkReferences), immutableReferences: clone(entry.immutableReferences) };
    Object.defineProperty(copy, "_templateBytes", { value: Buffer.from(entry._templateBytes), enumerable: false }); return copy;
  }) };
  return out;
}
function responseJson(value, options = {}) {
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value)); let sent = false;
  return { status: options.status ?? 200, redirected: options.redirected ?? false, body: { getReader: () => ({
    read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }), cancel: async () => {}
  }) } };
}
function singletonFetch(handler) {
  return async (_url, request) => {
    const payload = JSON.parse(request.body);
    if (!payload || Array.isArray(payload)) throw new Error("request must be singleton object");
    const result = handler(payload), row = result?.error ? { jsonrpc: "2.0", id: payload.id, error: result.error } : { jsonrpc: "2.0", id: payload.id, result };
    return responseJson(row);
  };
}
const countedFetch = (fetchImpl) => async (url, request) => {
  const payload = JSON.parse(request.body); assert.ok(!Array.isArray(payload)); mockedRpcElements += 1;
  return fetchImpl(url, request);
};

async function main() {
  equal(fixture.fixtureClasses.length, 86, "fixture class count");
  equal(runner.IMPLEMENTATION_SLOT, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "canonical EIP-1967 implementation slot");
  equal(runner.ADMIN_SLOT, "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", "canonical EIP-1967 admin slot");
  equal(runner.keccak256(Buffer.alloc(0)), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "Keccak empty vector");
  equal(runner.keccak256(Buffer.from("abc")), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45", "Keccak abc vector");

  const metadataCode = Buffer.from("6000a16161010004", "hex"), metadata = runner.stripCborMetadata(metadataCode);
  equal([metadata.stripped.toString("hex"), metadata.metadataBytes, metadata.strippedApplied], ["6000", 4, true], "CBOR trailer normalization");
  equal(runner.codeInfo(`0x${metadataCode.toString("hex")}`).strippedKeccak256, runner.keccak256(Buffer.from("6000", "hex")), "stripped runtime hash");

  const realManifestPath = path.join(ROOT, ...runner.RECOMMENDED_ARTIFACT_MANIFEST.split("/"));
  const realManifestBytes = fs.readFileSync(realManifestPath), realManifestDocument = JSON.parse(realManifestBytes);
  const realArtifacts = runner.loadArtifactManifest(runner.RECOMMENDED_ARTIFACT_MANIFEST);
  equal([runner.EXPECTED_ARTIFACT_MANIFEST_SHA256, runner.EXPECTED_PROVENANCE_AGGREGATE_SHA256],
    ["4cd97164240268a500a54dbce17f585cd69a72cc5b7647a551110f56eb13dc4a", "8f729b401f516fe7b6c585e1197bd143f8b54e862272f99e4c18cf011ae53db7"], "hard-pinned manifest/provenance constants");
  equal([realManifestDocument.sourceCommit, realManifestDocument.artifacts.length, realArtifacts.sourceCommit, realArtifacts.entries.length],
    [runner.SOURCE_COMMIT, 4, runner.SOURCE_COMMIT, 4], "real manifest source and artifact count");
  equal(realArtifacts.manifestSha256, runner.sha256(realManifestBytes), "real manifest SHA256");
  equal(realArtifacts.provenanceAggregateSha256, realManifestDocument.provenanceAggregateSha256, "provenance aggregate binding");
  equal([new Set(realManifestDocument.artifacts.map((row) => row.path)).size, new Set(realManifestDocument.artifacts.map((row) => row.family)).size],
    [4, 4], "real manifest path/family uniqueness");
  for (const [index, row] of realManifestDocument.artifacts.entries()) {
    const bytes = fs.readFileSync(path.join(ROOT, ...row.path.split("/"))), loaded = realArtifacts.entries[index];
    equal(loaded.artifactSha256, row.sha256, `${row.family} declared artifact SHA256`);
    equal(runner.sha256(bytes), row.sha256, `${row.family} actual artifact SHA256`);
    check(loaded.lengthBytes > 0 && loaded.strippedLengthBytes > 0, `${row.family} nonempty deployed runtime template`);
    check(/^0x[0-9a-f]{64}$/u.test(loaded.templateZeroedFullKeccak256) && /^0x[0-9a-f]{64}$/u.test(loaded.informationalStrippedKeccak256), `${row.family} informational Keccak fields`);
    equal([loaded.promotable, loaded.fullRuntimeKeccak256], [row.promotable, row.promotable ? loaded.templateZeroedFullKeccak256 : null], `${row.family} base promotability`);
    const independentlyNormalized = runner.normalizeArtifactObject(JSON.parse(bytes), row);
    equal([loaded.templateZeroedFullKeccak256, loaded.informationalStrippedKeccak256, loaded.metadataBytes],
      [independentlyNormalized.templateZeroedFullKeccak256, independentlyNormalized.informationalStrippedKeccak256, independentlyNormalized.metadataBytes], `${row.family} template hash binding`);
  }

  const rawFixture = boundRawFixture(realArtifacts), rawEvidence = runner.validateRawReferenceBindings(rawFixture, realArtifacts);
  check(rawEvidence.allChecksPassed && rawEvidence.loanUtils.address !== runner.ZERO_ADDRESS && rawEvidence.portfolioLoanLib.address !== runner.ZERO_ADDRESS,
    "exact semantic raw reference binding");
  throws(() => runner.validateRawReferenceBindings({ ...rawFixture, loanCode: mutateCode(rawFixture.loanCode, 9505, Buffer.alloc(32, 0x99)) }, realArtifacts),
    "RAW_RUNTIME_BINDING_FAILED", "wrong LoanV2 UUPS word");
  throws(() => runner.validateRawReferenceBindings({ ...rawFixture, vaultCode: mutateCode(rawFixture.vaultCode, 1451, Buffer.alloc(32, 0x99)) }, realArtifacts),
    "RAW_RUNTIME_BINDING_FAILED", "wrong VaultV2 UUPS word");
  throws(() => runner.validateRawReferenceBindings({ ...rawFixture, loanCode: mutateCode(rawFixture.loanCode, 8031, Buffer.alloc(20, 0x88)) }, realArtifacts),
    "RAW_RUNTIME_BINDING_FAILED", "different repeated PortfolioLoanLib address");
  throws(() => runner.validateRawReferenceBindings({ ...rawFixture, loanCode: mutateCode(rawFixture.loanCode, 18261, Buffer.alloc(20)) }, realArtifacts),
    "RAW_RUNTIME_BINDING_FAILED", "zero LoanUtils link");
  throws(() => runner.validateRawReferenceBindings({ ...rawFixture, loanUtilsCode: mutateCode(rawFixture.loanUtilsCode, 1, Buffer.from([0xff])) }, realArtifacts),
    "RAW_RUNTIME_BINDING_FAILED", "LoanUtils full hash mismatch");
  throws(() => runner.validateRawReferenceBindings({ ...rawFixture, loanUtilsCode: `0x${rawFixture.loanUtilsCode.slice(2, -2)}` }, realArtifacts),
    "RAW_RUNTIME_BINDING_FAILED", "LoanUtils length mismatch");
  throws(() => runner.validateRawReferenceBindings({ ...rawFixture, portfolioLoanLibCode: mutateCode(rawFixture.portfolioLoanLibCode, 8, Buffer.alloc(32, 0x99)) }, realArtifacts),
    "RAW_RUNTIME_BINDING_FAILED", "PortfolioLoanLib self immutable mismatch");
  throws(() => runner.validateRawReferenceBindings({ ...rawFixture, loanCode: mutateCode(rawFixture.loanCode, 100, Buffer.from([0xff])) }, realArtifacts),
    "RAW_RUNTIME_BINDING_FAILED", "normalized nonreference byte mismatch");
  const extraRef = mutableArtifacts(realArtifacts); extraRef.entries.find((entry) => entry.family === "LoanV2").linkReferences.push({ source: "x", library: "Extra", start: 100, length: 20 });
  throws(() => runner.validateRawReferenceBindings(rawFixture, extraRef), "RAW_RUNTIME_BINDING_FAILED", "extra library reference rejected");
  const shiftedRef = mutableArtifacts(realArtifacts); shiftedRef.entries.find((entry) => entry.family === "LoanV2").linkReferences[0].start += 1;
  throws(() => runner.validateRawReferenceBindings(rawFixture, shiftedRef), "RAW_RUNTIME_BINDING_FAILED", "shifted layout rejected");
  const overlapRef = mutableArtifacts(realArtifacts); overlapRef.entries.find((entry) => entry.family === "LoanV2").linkReferences[1].start = 2710;
  throws(() => runner.validateRawReferenceBindings(rawFixture, overlapRef), "RAW_RUNTIME_BINDING_FAILED", "overlapping layout rejected");
  const outOfBounds = mutableArtifacts(realArtifacts); outOfBounds.entries.find((entry) => entry.family === "LoanV2").linkReferences[0].start = 999999;
  throws(() => runner.validateRawReferenceBindings(rawFixture, outOfBounds), "RAW_RUNTIME_BINDING_FAILED", "out-of-bounds layout rejected");
  const semanticMutation = mutableArtifacts(realArtifacts); semanticMutation.referenceRules.uupsSelf.sourceLine = 23;
  throws(() => runner.validateRawReferenceBindings(rawFixture, semanticMutation), "RAW_RUNTIME_BINDING_FAILED", "semantic manifest mutation rejected");
  const validInput = validObserved();
  validInput.loan.implementationCode = runner.codeInfo(rawFixture.loanCode); validInput.vault.implementationCode = runner.codeInfo(rawFixture.vaultCode);
  validInput.rawRuntimeValidatedInProcess = true; validInput.runtimeReferenceEvidence = rawEvidence;
  validInput.terminal.rawRuntimeValidatedInProcess = true; validInput.terminal.referenceEvidence = rawEvidence;
  const freshValid = () => clone(validInput);
  const valid = runner.evaluateCandidate(runner.CANDIDATES[0], freshValid(), realArtifacts);
  equal([valid.runtime.family, valid.runtime.equivalence, valid.gates.linkage, valid.gates.accounting, valid.gates.topology,
    valid.gates.terminal, valid.historyEligible], ["LEGACY_V2", true, true, true, true, true, true], "valid Base V2 proxy pair");
  const syntheticAgainstReal = runner.evaluateCandidate(runner.CANDIDATES[0], validObserved(), realArtifacts);
  equal([syntheticAgainstReal.runtime.equivalence, syntheticAgainstReal.gates.runtime, syntheticAgainstReal.historyEligible],
    [false, false, false], "real artifact catalog cannot overclaim synthetic runtime equivalence");

  const directV1Observed = freshValid();
  directV1Observed.loan.implementation.address = runner.ZERO_ADDRESS; directV1Observed.vault.implementation.address = runner.ZERO_ADDRESS;
  directV1Observed.calls.lendingVault = missing(); directV1Observed.calls.lendingAsset = missing();
  directV1Observed.calls.activeAssets = missing(); directV1Observed.calls.lastEpochReward = missing(); directV1Observed.calls.rewardsPerEpoch = missing();
  directV1Observed.calls.paused = cv(false);
  const directV1 = runner.evaluateCandidate(runner.CANDIDATES[0], directV1Observed, artifactCatalog(false));
  equal([directV1.runtime.family, directV1.slots.loan.topology, directV1.gates.linkage, directV1.errors.includes("LINKAGE_MISMATCH")],
    ["LEGACY_V1", "DIRECT", true, false], "V1 missing V2 aliases does not itself break linkage");

  const pausedObserved = freshValid(); pausedObserved.calls.rewardsRate = cv("0");
  const pausedResult = runner.evaluateCandidate(runner.CANDIDATES[0], pausedObserved, realArtifacts);
  equal([pausedResult.gates.paused, pausedResult.historyEligible], [true, false], "rewardsRate zero is history-ineligible");
  const zeroSupplyObserved = freshValid(); zeroSupplyObserved.calls.totalSupply = cv("0");
  const zeroSupplyResult = runner.evaluateCandidate(runner.CANDIDATES[0], zeroSupplyObserved, realArtifacts);
  equal([zeroSupplyResult.gates.currentImpactClosed, zeroSupplyResult.historyEligible], [true, false], "zero supply closes current impact and history eligibility");

  const mismatchObserved = freshValid(); mismatchObserved.calls.vaultLoan = cv("0x9999999999999999999999999999999999999999");
  const mismatch = runner.evaluateCandidate(runner.CANDIDATES[0], mismatchObserved, realArtifacts);
  equal([mismatch.gates.linkage, mismatch.historyEligible, mismatch.errors.includes("LINKAGE_MISMATCH")], [false, false, true], "mutual linkage mismatch");
  const unknownObserved = validObserved(); unknownObserved.calls.activeAssets = missing(); unknownObserved.calls.lastEpochReward = missing();
  unknownObserved.calls.rewardsPerEpoch = missing(); unknownObserved.calls.paused = missing();
  const unknown = runner.evaluateCandidate(runner.CANDIDATES[0], unknownObserved, null);
  equal([unknown.runtime.family, unknown.runtime.equivalence, unknown.gates.runtime, unknown.historyEligible], ["UNKNOWN", null, false, false], "unknown runtime remains null/unpromoted");
  const accountingObserved = freshValid(); accountingObserved.calls.totalAssets = cv((BigInt(accountingObserved.calls.totalAssets.value) + 1n).toString());
  const accounting = runner.evaluateCandidate(runner.CANDIDATES[0], accountingObserved, realArtifacts);
  equal([accounting.gates.accounting, accounting.historyEligible, accounting.errors.includes("ACCOUNTING_MISMATCH")], [false, false, true], "accounting mismatch");
  const driftObserved = freshValid(); driftObserved.terminal.stable = false;
  equal([runner.evaluateCandidate(runner.CANDIDATES[0], driftObserved, realArtifacts).gates.terminal,
    runner.evaluateCandidate(runner.CANDIDATES[0], driftObserved, realArtifacts).historyEligible], [false, false], "terminal drift");

  equal([runner.strictData("0x123"), runner.decodeUint("0x00"), runner.decodeAddress(`0x01${"00".repeat(31)}`)], [null, null, null], "odd/short/noncanonical ABI words rejected");
  equal(runner.strictQuantity("0x00"), null, "noncanonical quantity rejected");

  const elementBudget = new runner.Budget({ ...runner.CAPS, maxRpcElements: 1 }); elementBudget.reserve("x");
  throws(() => elementBudget.reserve("x"), "BUDGET_ELEMENTS", "element budget reserved fail-closed");
  const requestBudget = new runner.Budget({ ...runner.CAPS, maxHttpRequests: 1 }); requestBudget.reserve("x");
  throws(() => requestBudget.reserve("x"), "BUDGET_HTTP_REQUESTS", "HTTP request budget reserved fail-closed");
  const worstCase = new runner.Budget(); for (let i = 0; i < 45; i += 1) worstCase.reserve(i < 2 ? "chain:base" : "candidate:A");
  equal([worstCase.summary().rpcElements, worstCase.summary().httpRequests], [45, 45], "A-only singleton worst case exactly bounded");

  const context = (fetchImpl, caps = runner.CAPS) => ({ budget: new runner.Budget(caps), caps, nextId: 0, fetchImpl: countedFetch(fetchImpl) });
  const oneCall = { key: "x", method: "eth_chainId", params: [] };
  const success = await runner.rpcRequest("mock://success", oneCall, context(singletonFetch(() => "0x2105")));
  equal([success.ok, success.result], [true, "0x2105"], "singleton object request/response success");
  await rejects(() => runner.rpcRequest("mock://array", oneCall, context(async (_url, request) => {
    const body = JSON.parse(request.body); return responseJson([{ jsonrpc: "2.0", id: body.id, result: "0x2105" }]);
  })), "MALFORMED_ENVELOPE", "array response rejected in singleton transport");
  await rejects(() => runner.rpcRequest("mock://wrong-id", oneCall, context(async (_url, request) => {
    const body = JSON.parse(request.body); return responseJson({ jsonrpc: "2.0", id: body.id + 1, result: "0x2105" });
  })), "MALFORMED_ENVELOPE", "wrong ID rejected");
  await rejects(() => runner.rpcRequest("mock://missing-id", oneCall, context(async () => responseJson({ jsonrpc: "2.0", result: "0x2105" }))),
    "MALFORMED_ENVELOPE", "missing ID rejected");
  await rejects(() => runner.rpcRequest("mock://conflict", oneCall, context(async (_url, request) => {
    const body = JSON.parse(request.body); return responseJson({ jsonrpc: "2.0", id: body.id, result: "0x2105", error: { code: -1 } });
  })), "MALFORMED_ENVELOPE", "result plus error rejected");
  const rpcError = await runner.rpcRequest("mock://error", oneCall, context(singletonFetch(() => ({ error: { code: -1, message: "offline" } }))));
  equal([rpcError.ok, rpcError.error], [false, "RPC_ERROR"], "singleton error object classified");
  await rejects(() => runner.rpcRequest("mock://bad-error", oneCall, context(async (_url, request) => {
    const body = JSON.parse(request.body); return responseJson({ jsonrpc: "2.0", id: body.id, error: "not-an-object" });
  })), "MALFORMED_ENVELOPE", "non-object error rejected");
  await rejects(() => runner.rpcRequest("mock://timeout", oneCall, context(async () => {
    const error = new Error("aborted"); error.name = "AbortError"; throw error;
  })), "TIMEOUT", "timeout fails closed");
  await rejects(() => runner.rpcRequest("mock://redirect", oneCall, context(async () => responseJson({}, { status: 302, redirected: true }))),
    "REDIRECT_REJECTED", "redirect rejected");
  await rejects(() => runner.rpcRequest("mock://malformed", oneCall, context(async () => responseJson("not-json"))),
    "MALFORMED_JSON", "malformed JSON");
  const nullRow = await runner.rpcRequest("mock://null", oneCall, context(singletonFetch(() => null)));
  equal(nullRow.error, "NULL_RESULT", "null result classified");
  const tinyCaps = { ...runner.CAPS, maxResponseBytes: 2 };
  await rejects(() => runner.rpcRequest("mock://large", oneCall, context(async () => responseJson("123"), tinyCaps)),
    "RESPONSE_BODY_CAP", "response cap");
  const aggregateCaps = { ...runner.CAPS, maxAggregateResponseBytes: 2 };
  await rejects(() => runner.rpcRequest("mock://aggregate", oneCall, context(async () => responseJson("123"), aggregateCaps)),
    "RESPONSE_BODY_CAP", "aggregate response cap");

  const finalizedUnsupported = await runner.runCapture({}, {
    fetchImpl: countedFetch(singletonFetch((row) => row.method === "eth_chainId" ? "0x2105" : { error: { code: -32000, message: "unsupported" } }))
  });
  equal([finalizedUnsupported.candidates[0].gates.finality, finalizedUnsupported.candidates[0].errors[0], finalizedUnsupported.counts.rpcElements,
    finalizedUnsupported.counts.httpRequests], [false, "FINALIZED_UNSUPPORTED", 2, 2], "finalized unsupported does not fall back to latest");
  check(finalizedUnsupported.localProvenance.verifiedBeforeRpc, "capture local provenance verified before mocked RPC");
  let capOverrideDispatches = 0;
  await rejects(() => runner.runCapture({}, { caps: { ...runner.CAPS, maxRpcElements: 999 }, fetchImpl: async () => { capOverrideDispatches += 1; } }),
    "CAP_OVERRIDE_FORBIDDEN", "runCapture cap override rejected");
  equal(capOverrideDispatches, 0, "cap injection causes zero dispatch");

  throws(() => runner.resolveAllowedProvenancePath("targets/40-acres-loan-contracts/src/../foundry.toml"), "PROVENANCE_PATH_FORBIDDEN", "traversal rejected before read");
  throws(() => runner.resolveAllowedProvenancePath("targets/40-acres-loan-contracts/.env"), "PROVENANCE_PATH_FORBIDDEN", "protected .env path rejected before read");
  throws(() => runner.resolveAllowedProvenancePath("targets/40-acres-loan-contracts/rpc_endpoints.txt"), "PROVENANCE_PATH_FORBIDDEN", "protected endpoint inventory rejected before read");
  throws(() => runner.resolveAllowedProvenancePath("targets/40-acres-loan-contracts/src/NotBound.sol"), "PROVENANCE_PATH_FORBIDDEN", "path substitution rejected before read");
  throws(() => runner.resolveAllowedProvenancePath("C:/outside/LoanV2.sol"), "PROVENANCE_PATH_FORBIDDEN", "absolute path rejected before read");
  const expectedPath = "targets/40-acres-loan-contracts/src/LoanV2.sol", fakeFs = { realpathSync: (value) =>
    String(value).replaceAll("\\", "/").endsWith("targets/40-acres-loan-contracts") ? path.join(ROOT, "targets", "40-acres-loan-contracts") : path.join(ROOT, "outside", "LoanV2.sol") };
  throws(() => runner.resolveAllowedProvenancePath(expectedPath, fakeFs), "PROVENANCE_PATH_FORBIDDEN", "symlink escape rejected");

  const approvedTemp = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode";
  check(fs.existsSync(approvedTemp) && path.resolve(os.tmpdir(), "opencode").toLowerCase() === approvedTemp.toLowerCase(), "approved workspace temp available");
  const tempRoot = fs.mkdtempSync(path.join(approvedTemp, "40acres-v2-output-"));
  try {
    throws(() => runner.canonicalFixedOutput(tempRoot), "OUTPUT_PARENT_MISSING", "missing fixed parent rejected");
    const parent = path.join(tempRoot, "reports", "raw", "fast"); fs.mkdirSync(parent, { recursive: true });
    const target = path.join(parent, "40acres-legacy-jit-base-a-state-runtime-v2.json");
    fs.writeFileSync(target, "occupied");
    throws(() => runner.reserveFixedOutput({ workspaceRoot: tempRoot }), "OUTPUT_PREEXISTS", "preexisting output rejected"); fs.unlinkSync(target);

    const reservation = runner.reserveFixedOutput({ workspaceRoot: tempRoot, now: () => new Date("2026-08-03T00:00:00Z") });
    const markerText = fs.readFileSync(target, "utf8"), marker = JSON.parse(markerText);
    check(runner.validateCaptureMarker(marker), "reservation marker schema");
    equal([marker.status, marker.captureStarted, marker.networkReads, marker.counts], [runner.RESERVATION_STATUS, false, 0, null], "reservation marker content");
    check(markerText.length > 0 && !/(?:https?:\/\/|authorization|bearer|api[_-]?key)/iu.test(markerText), "reservation marker nonempty and sanitized");
    throws(() => runner.reserveFixedOutput({ workspaceRoot: tempRoot }), "OUTPUT_PREEXISTS", "exclusive reservation race rejected");
    const startedMarker = runner.markCaptureStarted(reservation, { now: () => new Date("2026-08-03T00:00:00.500Z") });
    equal([startedMarker.status, startedMarker.captureStarted, startedMarker.networkReads, startedMarker.counts],
      [runner.STARTED_STATUS, true, null, null], "hard-crash-equivalent started marker is indeterminate, never false zero");
    equal(JSON.parse(fs.readFileSync(target, "utf8")), startedMarker, "started marker fsynced on reserved inode");
    fs.closeSync(reservation.fd); fs.unlinkSync(target);

    let localFailure;
    try { await runner.orchestrateCliCapture({ workspaceRoot: tempRoot, now: () => new Date("2026-08-03T00:00:01Z"),
      runCaptureImpl: async () => { throw new Error("LOCAL_PROVENANCE_FAILED"); } }); } catch (error) { localFailure = error; }
    equal(localFailure?.message, "LOCAL_PROVENANCE_FAILED", "local precondition failure propagated");
    const localMarkerText = fs.readFileSync(target, "utf8"), localMarker = JSON.parse(localMarkerText);
    check(runner.validateCaptureMarker(localMarker), "local failure marker schema");
    equal([localMarker.status, localMarker.error, localMarker.failureStage, localMarker.countSemantics, localMarker.networkReads,
      localMarker.counts, localMarker.captureStarted], [runner.FAILURE_STATUS, "LOCAL_PROVENANCE_FAILED", "PRE_DISPATCH", "EXACT", 0,
      { rpcElements: 0, httpRequests: 0, dispatchedHttpRequests: 0, responseBytes: 0 }, true], "local failure persists exact zero-read marker");
    check(!/(?:https?:\/\/|authorization|bearer|calldata|bytecode|rawResponse)/iu.test(localMarkerText), "local failure marker sanitized"); fs.unlinkSync(target);

    let countedFailure;
    try { await runner.orchestrateCliCapture({ workspaceRoot: tempRoot, now: () => new Date("2026-08-03T00:00:02Z"), runCaptureImpl: async (_options, { telemetry }) => {
      telemetry.rpcElements = 1; telemetry.httpRequests = 1; telemetry.dispatchedHttpRequests = 1; telemetry.responseBytes = 0;
      const error = new Error("TRANSPORT_FAILURE"); throw error;
    } }); } catch (error) { countedFailure = error; }
    equal(countedFailure?.message, "TRANSPORT_FAILURE", "post-reservation failure propagated");
    const countedMarker = JSON.parse(fs.readFileSync(target, "utf8"));
    equal([countedMarker.error, countedMarker.failureStage, countedMarker.countSemantics, countedMarker.networkReads, countedMarker.counts],
      ["TRANSPORT_FAILURE", "POST_DISPATCH", "EXACT", 1, { rpcElements: 1, httpRequests: 1, dispatchedHttpRequests: 1, responseBytes: 0 }],
      "exception after one dispatch persists exact mutable telemetry"); fs.unlinkSync(target);

    let unknownFailure;
    try { await runner.orchestrateCliCapture({ workspaceRoot: tempRoot, now: () => new Date("2026-08-03T00:00:02.500Z"), runCaptureImpl: async () => {
      const error = new Error("CAPTURE_FAILURE"); error.failureStage = "POST_RPC"; error.telemetryReliable = false; throw error;
    } }); } catch (error) { unknownFailure = error; }
    equal(unknownFailure?.message, "CAPTURE_FAILURE", "post-RPC unknown-count failure propagated");
    const unknownMarker = JSON.parse(fs.readFileSync(target, "utf8"));
    equal([unknownMarker.failureStage, unknownMarker.countSemantics, unknownMarker.networkReads, unknownMarker.counts],
      ["POST_DISPATCH", "UNKNOWN", null, null], "unreliable post-RPC telemetry remains explicitly unknown, never zero");
    const falseZero = { ...unknownMarker, countSemantics: "EXACT", networkReads: 0,
      counts: { rpcElements: 0, httpRequests: 0, dispatchedHttpRequests: 0, responseBytes: 0 } };
    throws(() => runner.validateCaptureMarker(falseZero), "CAPTURE_MARKER_INVALID", "post-dispatch marker cannot claim zero"); fs.unlinkSync(target);

    const simulated = { schemaVersion: 1, packageId: runner.PACKAGE_ID, status: "SIMULATED_SANITIZED_SUCCESS", values: [1, 2, 3] };
    const success = await runner.orchestrateCliCapture({ workspaceRoot: tempRoot, now: () => new Date("2026-08-03T00:00:03Z"), runCaptureImpl: async () => simulated });
    equal([success.reservedInode, success.finalInode], [success.finalInode, success.finalInode], "success replaces marker on same inode");
    equal(JSON.parse(fs.readFileSync(target, "utf8")), simulated, "success final JSON replaces marker");
    check(fs.statSync(target).size > 0, "successful reserved output never empty"); fs.unlinkSync(target);

    const mockRoot = path.join(tempRoot, "mock-root"), mockParent = path.join(mockRoot, "reports", "raw", "fast"), escapingFs = {
      existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => false }),
      realpathSync: (value) => path.resolve(value) === path.resolve(mockRoot) ? mockRoot : path.join(tempRoot, "outside") };
    throws(() => runner.canonicalFixedOutput(mockRoot, escapingFs), "OUTPUT_PARENT_CANONICAL_MISMATCH", "parent symlink/canonical escape rejected");
  } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }

  throws(() => runner.sanitizeOutput({ endpoint: "redacted" }), "OUTPUT_LEAK", "endpoint key leak");
  throws(() => runner.sanitizeOutput({ note: "https://rpc.invalid" }), "OUTPUT_LEAK", "URL leak");
  throws(() => runner.sanitizeOutput({ rawResponse: "x" }), "OUTPUT_LEAK", "raw response leak");
  throws(() => runner.sanitizeOutput({ note: "Bearer secret" }), "OUTPUT_LEAK", "auth-like leak");

  const output = { schemaVersion: 1, packageId: runner.PACKAGE_ID, source: { commit: runner.SOURCE_COMMIT }, stage: "STATE_RUNTIME_ONLY",
    transport: { mode: "JSON_RPC_SINGLETON_HTTP", automaticMultiRequestFallback: false },
    predecessor: { packageId: runner.PREDECESSOR_PACKAGE_ID, outputSha256: runner.PREDECESSOR_OUTPUT_SHA256,
      transportStatus: "V1_TRANSPORT_INCONCLUSIVE", causeInference: false },
    validationSeparation: "RUNNER_VALIDATES_RAW_IN_PROCESS; POST_OUTPUT_VALIDATOR_CHECKS_SCHEMA_AND_INTERNAL_CONSISTENCY_ONLY",
    localProvenance: { verifiedBeforeRpc: true, manifestSha256: runner.EXPECTED_ARTIFACT_MANIFEST_SHA256,
      provenanceAggregateSha256: runner.EXPECTED_PROVENANCE_AGGREGATE_SHA256, untrackedAuditFiles: ["test/audit/LegacyV2EpochRewardJitDifferential.t.sol"] },
    captureExecuted: true, chains: [{ label: "base", chainId: "8453", pin: valid.pin, error: null }], artifacts: realArtifacts,
    counts: { rpcElements: 45, httpRequests: 45, dispatchedHttpRequests: 45, responseBytes: 1000, retries: 0, concurrency: 1,
      byScope: { "chain:base": { rpcElements: 2, httpRequests: 2 }, "candidate:A": { rpcElements: 43, httpRequests: 43 } } },
    candidates: [valid], historyEligibleCount: 1 };
  check(runner.validateOutput(output, output.artifacts), "valid synthetic output accepted with explicit expected fixture catalog");
  const noArtifacts = clone(output); noArtifacts.artifacts = null;
  throws(() => runner.validateOutput(noArtifacts, output.artifacts), "RUNTIME_OVERCLAIM", "runtime equivalence requires artifact binding");
  const missingField = clone(output); delete missingField.candidates[0].formulas;
  throws(() => runner.validateOutput(missingField, output.artifacts), "OUTPUT_SCHEMA", "required candidate field");
  const gateOverclaim = clone(output); gateOverclaim.candidates[0].gates.accounting = false;
  throws(() => runner.validateOutput(gateOverclaim, output.artifacts), "GATE_OVERCLAIM", "history gate recomputed");
  const linkageOverclaim = clone(output); linkageOverclaim.candidates[0].calls.vaultLoan.value = "0x9999999999999999999999999999999999999999";
  throws(() => runner.validateOutput(linkageOverclaim, output.artifacts), "GATE_OVERCLAIM", "linkage gate recomputed");
  const countOver = clone(output); countOver.counts.rpcElements = 101;
  throws(() => runner.validateOutput(countOver, output.artifacts), "OUTPUT_CAPS", "count cap enforced");
  const requestOver = clone(output); requestOver.counts.httpRequests = 46;
  throws(() => runner.validateOutput(requestOver, output.artifacts), "OUTPUT_CAPS", "HTTP request cap enforced");
  const forbiddenTerminology = clone(output); forbiddenTerminology.counts.batchRequests = 1;
  throws(() => runner.validateOutput(forbiddenTerminology, output.artifacts), "OUTPUT_SCHEMA", "legacy batch terminology rejected");
  const transportSwap = clone(output); transportSwap.transport.mode = "JSON_RPC_ARRAY";
  throws(() => runner.validateOutput(transportSwap, output.artifacts), "OUTPUT_SCHEMA", "non-singleton transport envelope rejected");
  const candidateSwap = clone(output); candidateSwap.candidates[0].id = "B";
  throws(() => runner.validateOutput(candidateSwap, output.artifacts), "CANDIDATE_BINDING", "candidate substitution rejected");
  const chainSwap = clone(output); chainSwap.candidates[0].chainId = "43114";
  throws(() => runner.validateOutput(chainSwap, output.artifacts), "CANDIDATE_BINDING", "chain substitution rejected");
  const provenanceSwap = clone(output); provenanceSwap.candidates[0].provenance = "HISTORICAL_DEPRECATED";
  throws(() => runner.validateOutput(provenanceSwap, output.artifacts), "CANDIDATE_BINDING", "provenance substitution rejected");
  const finalitySwap = clone(output); finalitySwap.candidates[0].pin.finalityMethod = "latest";
  throws(() => runner.validateOutput(finalitySwap, output.artifacts), "CANDIDATE_BINDING", "finality substitution rejected");
  const artifactMutation = clone(output); artifactMutation.artifacts.entries[0].artifactSha256 = "f".repeat(64);
  throws(() => runner.validateOutput(artifactMutation, output.artifacts), "RUNTIME_OVERCLAIM", "captured artifact mutation rejected");
  const familySwap = clone(output); familySwap.candidates[0].runtime.loanArtifact.family = "PharaohLoanV2";
  throws(() => runner.validateOutput(familySwap, output.artifacts), "RUNTIME_OVERCLAIM", "artifact family substitution rejected");
  const templateOnlyInput = freshValid(); templateOnlyInput.rawRuntimeValidatedInProcess = false; templateOnlyInput.runtimeReferenceEvidence = null;
  const templateOnly = runner.evaluateCandidate(runner.CANDIDATES[0], templateOnlyInput, realArtifacts);
  equal([templateOnly.runtime.equivalence, templateOnly.gates.runtime, templateOnly.historyEligible], [false, false, false], "template/stripped hashes cannot promote");
  const formulaMutation = clone(output); formulaMutation.candidates[0].formulas.remaining = (BigInt(formulaMutation.candidates[0].formulas.remaining) + 1n).toString();
  throws(() => runner.validateOutput(formulaMutation, output.artifacts), "GATE_OVERCLAIM", "accounting formula mutation rejected");
  const pausedOutput = clone(output); pausedOutput.candidates[0].calls.rewardsRate.value = "0"; pausedOutput.candidates[0].gates.paused = true;
  pausedOutput.candidates[0].historyEligible = false; pausedOutput.historyEligibleCount = 0;
  check(runner.validateOutput(pausedOutput, output.artifacts), "paused output remains valid but history-ineligible");
  const zeroSupplyOutput = clone(output); zeroSupplyOutput.candidates[0].calls.totalSupply.value = "0"; zeroSupplyOutput.candidates[0].gates.currentImpactClosed = true;
  zeroSupplyOutput.candidates[0].historyEligible = false; zeroSupplyOutput.historyEligibleCount = 0;
  check(runner.validateOutput(zeroSupplyOutput, output.artifacts), "zero-supply output remains valid but history-ineligible");
  for (const [field, value] of [["loanAdmin", "0x9999999999999999999999999999999999999999"],
    ["loanAsset", "0x9999999999999999999999999999999999999999"], ["owner", "0x9999999999999999999999999999999999999999"]]) {
    const terminalDrift = clone(output);
    if (field === "loanAdmin") terminalDrift.candidates[0].terminal.loanAdmin.address = value;
    else terminalDrift.candidates[0].terminal[field].value = value;
    throws(() => runner.validateOutput(terminalDrift, output.artifacts), "GATE_OVERCLAIM", `terminal ${field} drift rejected`);
  }
  const terminalCodeDrift = clone(output); terminalCodeDrift.candidates[0].terminal.referenceEvidence = clone(terminalCodeDrift.candidates[0].terminal.referenceEvidence);
  terminalCodeDrift.candidates[0].terminal.referenceEvidence.loanV2.fullKeccak256 = `0x${"99".repeat(32)}`;
  throws(() => runner.validateOutput(terminalCodeDrift, output.artifacts), "RUNTIME_OVERCLAIM", "terminal implementation code drift rejected");
  const terminalLibraryDrift = clone(output); terminalLibraryDrift.candidates[0].terminal.referenceEvidence = clone(terminalLibraryDrift.candidates[0].terminal.referenceEvidence);
  terminalLibraryDrift.candidates[0].terminal.referenceEvidence.loanUtils.fullKeccak256 = `0x${"88".repeat(32)}`;
  throws(() => runner.validateOutput(terminalLibraryDrift, output.artifacts), "RUNTIME_OVERCLAIM", "terminal library code drift rejected");
  const terminalReferenceDrift = clone(output); terminalReferenceDrift.candidates[0].terminal.referenceEvidence = clone(terminalReferenceDrift.candidates[0].terminal.referenceEvidence);
  terminalReferenceDrift.candidates[0].terminal.referenceEvidence.loanV2.referencesBound = false;
  throws(() => runner.validateOutput(terminalReferenceDrift, output.artifacts), "RUNTIME_OVERCLAIM", "terminal reference drift rejected");
  const falseRawFlag = clone(output); falseRawFlag.candidates[0].runtime.rawRuntimeValidatedInProcess = false;
  throws(() => runner.validateOutput(falseRawFlag, output.artifacts), "RUNTIME_OVERCLAIM", "false raw validation flag rejected");
  throws(() => runner.loadArtifactManifest("tools/fixtures/missing-40acres-artifacts.json"), "ARTIFACT_INVALID", "missing/nonfixed mandatory manifest rejected");
  await rejects(() => runner.runCapture({ baseRpc: "https://example.invalid" }), "ENDPOINT_OR_SCOPE_OVERRIDE_FORBIDDEN", "endpoint override rejected before dispatch");
  equal(runner.validateTrackedStatus("?? test/audit/LegacyV2EpochRewardJitDifferential.t.sol\n"),
    ["test/audit/LegacyV2EpochRewardJitDifferential.t.sol"], "untracked audit file allowed and recorded");
  throws(() => runner.validateTrackedStatus(" M src/LoanV2.sol\n"), "DIRTY_TRACKED_SCOPE", "dirty tracked source rejected");
  throws(() => runner.parseSubmoduleStatus(`+${"1".repeat(40)} lib/forge-std (heads/main)\n`), "SUBMODULE_MISMATCH", "submodule mismatch rejected");

  const checkOnly = runner.preflight();
  equal([checkOnly.networkReads, checkOnly.captureExecuted, checkOnly.candidates.length, checkOnly.caps.maxCandidates,
    checkOnly.caps.maxChains, checkOnly.caps.maxRpcElements, checkOnly.caps.maxHttpRequests, checkOnly.caps.retries],
  [0, false, 1, 1, 1, 45, 45, 0], "offline A-only singleton preflight and caps");
  equal(checkOnly.artifactManifest, { fixedPath: runner.RECOMMENDED_ARTIFACT_MANIFEST,
    expectedSha256: runner.EXPECTED_ARTIFACT_MANIFEST_SHA256, expectedProvenanceAggregateSha256: runner.EXPECTED_PROVENANCE_AGGREGATE_SHA256,
    mandatoryForCapture: true, compilationPerformedByRunner: false }, "preflight fixes mandatory artifact manifest");
  equal(checkOnly.endpointPolicy, { fixedOfficialEndpoint: "https://mainnet.base.org", overridesAllowed: false }, "preflight fixes official Base endpoint");
  equal([checkOnly.runtimePromotion, checkOnly.historyStageExecuted],
    ["EXACT_FULL_RUNTIME_WITH_SEMANTICALLY_VERIFIED_LINK_AND_IMMUTABLE_REFERENCES; NO_CBOR_STRIPPING", false], "preflight reference-bound and no history");
  equal(checkOnly.atomicLocalPrecondition,
    "MANIFEST_HASH+AGGREGATE+HEAD+TREE+CLEAN_TRACKED_SCOPE+RECURSIVE_GITLINKS+FILE_HASHES+COMPILER_METADATA_BEFORE_RPC", "preflight atomic local precondition");
  equal(checkOnly.transport, { mode: "JSON_RPC_SINGLETON_HTTP", requestBody: "SINGLE_OBJECT_NEVER_ARRAY", responseBody: "SINGLE_OBJECT_NEVER_ARRAY",
    automaticMultiRequestFallback: false }, "singleton transport preflight");
  equal(checkOnly.predecessor, { packageId: runner.PREDECESSOR_PACKAGE_ID, outputSha256: runner.PREDECESSOR_OUTPUT_SHA256,
    transportStatus: "V1_TRANSPORT_INCONCLUSIVE", causeInference: false, predecessorReadByV2Capture: false }, "v1 predecessor metadata only/no cause inference");
  equal(checkOnly.outputPath, { fixedPath: "reports/raw/fast/40acres-legacy-jit-base-a-state-runtime-v2.json", writeMode: "wx",
    reservationBeforeRpc: true, sameReservedInodeFinalization: true, hardCrashLeavesReservationMarker: true,
    lifecycleStatuses: [runner.RESERVATION_STATUS, runner.STARTED_STATUS, runner.FAILURE_STATUS], failureMarkerStatus: runner.FAILURE_STATUS,
    reservationMarkerStatus: runner.RESERVATION_STATUS, startedMarkerStatus: runner.STARTED_STATUS,
    countSemantics: { started: "NULL_MEANS_INDETERMINATE", failureExact: "EXACT_FROM_MUTABLE_TRANSPORT_TELEMETRY",
      failureUnknown: "NULL_NEVER_COERCED_TO_ZERO" } }, "fixed immutable-successor output lifecycle");
  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, fixtureClasses: fixture.fixtureClasses.length,
    mockedRpcElements, liveNetworkReads: 0, networkCaptureExecuted: false }, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
