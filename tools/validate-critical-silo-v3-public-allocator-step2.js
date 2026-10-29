#!/usr/bin/env node
"use strict";
// Check-only validator. It has no filesystem write call; manifest generation is separate.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const generator = require("./generate-critical-silo-v3-public-allocator-step2-manifest");
const ROOT = path.resolve(__dirname, "..");
const RAW = generator.PACKAGE_FILES[0], REPORT = generator.PACKAGE_FILES[1], INBOX = generator.PACKAGE_FILES[2], HANDOFF = generator.PACKAGE_FILES[3];
const read = rel => fs.readFileSync(path.join(ROOT, rel));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function assertion(value, message, state) { if (!value) throw new Error(`VALIDATION_FAILED:${message}`); state.checks++; }
function runtimeRows(chains) { const rows = []; for (const chain of chains.filter(c => c.retainedCaptureStatus === "CAPTURED")) { rows.push(chain.deployments.publicAllocatorRuntime, chain.deployments.factoryRuntime); for (const vault of chain.vaults) { rows.push(vault.runtime); for (const market of vault.markets) rows.push(market.runtime); } } return rows; }
function validateData(raw, report, inbox, handoff) {
  const state = { checks: 0 }, check = (v, m) => assertion(v, m, state), expected = "WATCH/KNOWN-SIX-AUTHORIZATION-PREDICATE-FALSE/FACTORY-VAULT-RUNTIME-SEMANTICS-UNBOUND/HISTORY-STRICTNESS-UNPROVEN/DEPLOYMENT-COVERAGE-PARTIAL";
  check(raw.schemaVersion === 2 && raw.revision === "oracle-r2-offline" && raw.classification === expected && inbox.classification === expected, "schema/revision/classification");
  check(raw.gates.routePositive === false && raw.gates.executableNow === false && raw.gates.signedActionJustified === false && raw.gates.fork === false, "raw gates");
  check(inbox.routePositive === 0 && inbox.executableNow === 0 && inbox.signedActionJustified === false && inbox.fork === false, "inbox gates");
  check(raw.chainDefinitionValidation.expectedCount === 13 && raw.chainDefinitionValidation.observedRows === 13 && raw.chainDefinitionValidation.uniqueExpectedChainIds === true && raw.chainDefinitionValidation.uniqueObservedChainIds === true && raw.chainDefinitionValidation.exactExpectedSet === true, "chain id uniqueness/set");
  check(new Set(raw.chains.map(c => c.chainId)).size === 13 && raw.chains.length === 13, "chain row uniqueness");
  check(raw.summary.retainedStateChains === 7 && raw.summary.strictlyCompleteChains === 0 && raw.summary.preexistingBlockedChains === 6 && raw.summary.historyStrictnessIncompleteRetainedChains === 7, "coverage summary");
  check(raw.summary.knownFactoryAuthenticatedVaults === 6 && raw.summary.knownRequiredStateCompleteVaults === 6 && raw.summary.knownAuthorizationPredicateFalseVaults === 6 && raw.summary.knownPublicAllocatorAuthorizedVaults === 0 && raw.summary.knownStructuralPairCandidates === 0 && raw.summary.globalVaultUniverseComplete === false, "known vault summary");
  const retained = raw.chains.filter(c => c.retainedCaptureStatus === "CAPTURED"), blocked = raw.chains.filter(c => c.retainedCaptureStatus !== "CAPTURED"), vaults = retained.flatMap(c => c.vaults);
  check(retained.length === 7 && blocked.length === 6 && vaults.length === 6 && raw.candidates.length === 0, "retained/block/vault arrays");
  check(retained.every(c => c.status === "RETAINED_STATE_PARTIAL_HISTORY_STRICTNESS_UNPROVEN" && c.strictlyComplete === false), "retained corrected status");
  check(retained.every(c => c.history.strictDecoderAppliedInR1 === false && c.history.malformedMatchingLogs === null && c.history.strictDecodeComplete === false && c.history.eventUniverseComplete === false && c.history.knownDecodedRowsOnly === true), "history strictness fail closed");
  check(retained.every(c => c.incompleteRequiredStateVaults === 0 && c.factoryAuthenticatedStateComplete === true), "known authenticated states complete");
  check(vaults.every(v => v.factoryAuthenticated === true && v.requiredStateComplete === true && v.stateConclusion === "KNOWN_AUTHORIZATION_PREDICATE_FALSE"), "explicit authentication/state fields");
  check(vaults.every(v => v.authorization.formula === "isAllocator[allocator] || owner == allocator || curator == allocator" && v.authorization.isAllocatorMapping === false && v.authorization.ownerEqualsAllocator === false && v.authorization.curatorEqualsAllocator === false && v.authorization.publicAllocatorAuthorized === false), "three-path authorization false");
  check(vaults.every(v => v.authorization.predicateInputsAbiObserved === true && v.authorization.localSourcePredicateReviewed === true && v.authorization.deployedVaultRuntimeSemanticsBound === false), "authorization qualification");
  check(vaults.every(v => v.totalAssetsRaw === "0" && v.pairCandidates.length === 0 && v.publicAllocator.feeWeiPerCall === "0"), "known ABI state");
  check(raw.runtimeBinding.publicAllocatorExactRetainedChains === 7 && raw.runtimeBinding.factoryNormalizedRuntimeEquivalentChains === 0 && raw.runtimeBinding.vaultNormalizedRuntimeEquivalentRows === 0 && raw.runtimeBinding.factoryAndVaultSourceSemanticsBound === false, "runtime binding summary");
  check(retained.every(c => c.deployments.publicAllocatorRuntime.runtimeEquivalence.status === "EXACT_DEPLOYED_BYTECODE_MATCH_RETAINED" && c.deployments.publicAllocatorRuntime.runtimeEquivalence.cryptographicallySupported === true && c.deployments.publicAllocatorRuntime.sourceSemanticsBound === true), "allocator exact retained");
  check(retained.every(c => c.deployments.factoryRuntime.runtimeEquivalence.status === "UNBOUND_RETAINED_CODE_HASH_ONLY" && c.deployments.factoryRuntime.runtimeEquivalence.cryptographicallySupported === false && c.deployments.factoryRuntime.sourceSemanticsBound === false && c.deployments.factoryRuntime.abiObservedStateOnly === true), "factory unbound/ABI only");
  check(vaults.every(v => v.runtime.runtimeEquivalence.status === "UNBOUND_RETAINED_CODE_HASH_ONLY" && v.runtime.sourceSemanticsBound === false && v.runtime.abiObservedStateOnly === true), "vault unbound/ABI only");
  const runtimes = runtimeRows(raw.chains);
  check(runtimes.length === raw.slotCorrection.affectedRuntimeObservations && runtimes.length === 21, "runtime/slot row count");
  check(runtimes.every(r => r.eip1967ImplementationSlot.readStatus === "UNRESOLVED_R1_COLLAPSED_NULL" && r.eip1967ImplementationSlot.successfulFamilies === null && r.eip1967ImplementationSlot.agreement === null && r.eip1967ImplementationSlot.value === null && r.eip1967ImplementationSlot.implementation === null && r.eip1967ImplementationSlot.proxyDetected === null && r.proxyDetected === null), "slot tri-state correction");
  check(raw.slotCorrection.zeroSlotClaims === 0 && raw.slotCorrection.proxyFalseClaimsFromSlots === 0, "no zero/proxy false slot claims");
  check(raw.chains.find(c => c.chainId === 42161).vaults.length === 4 && raw.chains.find(c => c.chainId === 56).vaults.length === 2, "known vault locations");
  check(raw.chains.filter(c => c.retainedCaptureStatus === "BLOCKED_NO_ENDPOINT").map(c => c.chainId).sort((a,b)=>a-b).join(",") === "50,196,1776,4326", "missing endpoint blocks");
  check(raw.chains.find(c => c.chainId === 10).blocker === "TERMINAL_RECHECK_FAILED" && raw.chains.find(c => c.chainId === 43114).blocker === "BOUNDED_HISTORY_UNAVAILABLE", "retained explicit blockers");
  check(raw.predecessorBinding.rawSha256 === "a93859dfd39fd40b1bef3ea27b4a7af2e53a8172640e19a8a665630d39026cce" && sha(read(raw.predecessorBinding.rawPath)) === raw.predecessorBinding.rawSha256, "predecessor raw binding");
  check(raw.predecessorBinding.manifestSha256 === "202e6cb75b56d47e04f8e7bc9c2551b0312ca8bff6f0da2deac895c91d077430" && sha(read(raw.predecessorBinding.manifestPath)) === raw.predecessorBinding.manifestSha256 && raw.predecessorBinding.aggregateSha256 === "7b31395a381fce3da5f3c9ccfa5985cbfed3d4bef22bbd699c1ec358c6028029", "predecessor manifest binding");
  check(raw.materialContext.targetCommit === "94c20ef94041345cce7f216f4914a8cbea861be4" && raw.materialContext.nodeVersion === "v24.13.0" && raw.materialContext.ethersVersion === "6.16.0" && raw.materialContext.platform === "win32" && raw.materialContext.arch === "x64", "material runtime context");
  check(raw.oracleCorrection.offlineOnly === true && raw.oracleCorrection.inventoryReads === 0 && raw.oracleCorrection.networkReads === 0 && raw.oracleCorrection.rpcReads === 0 && raw.oracleCorrection.rawResponseReads === 0 && raw.oracleCorrection.fork === false && raw.oracleCorrection.secretsRead === false && raw.oracleCorrection.signing === false && raw.oracleCorrection.transactions === false && raw.oracleCorrection.stateMutation === false, "offline correction purity");
  check(raw.economics.exactNetEstablished === false && raw.paR202.deployedIncompatibleMarketEstablished === false && raw.paR202.behavioralSupplySimulationPerformed === false, "economics/R2-02 unresolved");
  check(report.includes("All three inputs are false for all six known rows") && report.includes("previous wording based only on `isAllocator` was incomplete"), "report authorization correction");
  check(report.includes("factory runtime equivalence and local factory source semantics are **unbound**") && report.includes("vault/market runtime equivalence and deployed local source semantics are **unbound**"), "report runtime downgrade");
  check(report.includes("UNRESOLVED_R1_COLLAPSED_NULL") && report.includes("prior “no nonzero slot”") && report.includes("silently dropped matching factory logs"), "report slot/log corrections");
  check(report.includes("does not establish global absence") && report.includes("No fork is justified"), "report scope/fork");
  check(handoff.includes("Authorization corrected to isAllocator OR owner OR curator") && handoff.includes("no zero-slot or proxyDetected=false claim survives") && handoff.includes("No global absence claim"), "handoff corrections");
  check(inbox.runId === raw.runId && inbox.correctedAuthorization.allThreeFalseRows === 6 && inbox.correctedAuthorization.authorizedRows === 0 && inbox.correctedAuthorization.deployedVaultRuntimeSemanticsBound === false, "inbox binding");
  for (const [name, text] of [[RAW, JSON.stringify(raw)], [REPORT, report], [INBOX, JSON.stringify(inbox)], [HANDOFF, handoff]]) { check(!/(?:https?|wss?):\/\//i.test(text), `${name} URL leak`); check(!/"(?:url|headers|apiKey|token|rawResponse|responseBody)"\s*:/i.test(text), `${name} forbidden endpoint field`); }
  return state;
}
function verifyManifest(manifest) {
  const state = { checks: 0 }, check = (v, m) => assertion(v, m, state);
  check(manifest.schemaVersion === 2 && manifest.validatorMode === "check-only" && manifest.deterministicAggregate === true, "manifest schema/mode");
  check(manifest.generator === "tools/generate-critical-silo-v3-public-allocator-step2-manifest.js", "manifest generator");
  check(manifest.generatedAt === "2026-07-29T02:00:00.000Z" && manifest.targetCommit === "94c20ef94041345cce7f216f4914a8cbea861be4", "manifest deterministic context");
  check(manifest.runtimeContext.nodeVersion === "v24.13.0" && manifest.runtimeContext.ethersVersion === "6.16.0", "manifest runtime versions");
  check(manifest.packageFileCount === generator.PACKAGE_FILES.length && manifest.materialInputCount === generator.MATERIAL_INPUTS.length, "manifest role counts");
  check(JSON.stringify(manifest.files.map(x => x.path)) === JSON.stringify(generator.FILES), "manifest exact file order");
  check(new Set(manifest.files.map(x => x.path)).size === manifest.files.length, "manifest unique files");
  check(manifest.files.slice(0, generator.PACKAGE_FILES.length).every(x => x.role === "package") && manifest.files.slice(generator.PACKAGE_FILES.length).every(x => x.role === "material-input"), "manifest roles");
  for (const row of manifest.files) { const body = read(row.path); check(row.bytes === body.length && row.sha256 === sha(body), `${row.path} integrity`); }
  check(manifest.aggregateSha256 === sha(generator.canonical(manifest.files.map(x => ({ path: x.path, role: x.role, bytes: x.bytes, sha256: x.sha256 })))), "deterministic aggregate");
  return state;
}
function validate(options = {}) { const raw = JSON.parse(read(RAW)), report = read(REPORT).toString("utf8"), inbox = JSON.parse(read(INBOX)), handoff = read(HANDOFF).toString("utf8"), data = validateData(raw, report, inbox, handoff); let manifestChecks = 0; if (options.manifest !== false) manifestChecks = verifyManifest(JSON.parse(read(generator.MANIFEST_REL))).checks; return { dataChecks: data.checks, manifestChecks, checks: data.checks + manifestChecks }; }
if (require.main === module) { const before = fs.existsSync(path.join(ROOT, generator.MANIFEST_REL)) ? sha(read(generator.MANIFEST_REL)) : null, result = validate({ manifest: !process.argv.includes("--data-only") }), after = fs.existsSync(path.join(ROOT, generator.MANIFEST_REL)) ? sha(read(generator.MANIFEST_REL)) : null; if (before !== after) throw new Error("VALIDATOR_WROTE_MANIFEST"); process.stdout.write(`${JSON.stringify({ status: "PASS", mode: "check-only", ...result, manifestUnchanged: before === after })}\n`); }
module.exports = { runtimeRows, validateData, verifyManifest, validate };
