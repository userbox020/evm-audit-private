#!/usr/bin/env node
"use strict";
// Deterministic offline correction. Reads only retained package/local artifacts;
// never imports, opens, or references endpoint inventories and performs no I/O
// other than local package reads/writes.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const RAW_REL = "reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2.json";
const R1_RAW_REL = "reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2-retained-r1.json";
const MANIFEST_REL = "reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2-manifest.json";
const R1_MANIFEST_REL = "reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2-manifest-retained-r1.json";
const REPORT_REL = "reports/critical-silo-v3-public-allocator-deployment-economics-step2.md";
const INBOX_REL = "coordination/inbox/critical/20260729-critical-silo-v3-public-allocator-step2.json";
const HANDOFF_REL = "coordination/handoffs/20260729-critical-silo-v3-public-allocator-step2-handoff.md";
const CLASSIFICATION = "WATCH/KNOWN-SIX-AUTHORIZATION-PREDICATE-FALSE/FACTORY-VAULT-RUNTIME-SEMANTICS-UNBOUND/HISTORY-STRICTNESS-UNPROVEN/DEPLOYMENT-COVERAGE-PARTIAL";
const CORRECTION_TIME = "2026-07-29T02:00:00.000Z";
const TARGET_COMMIT = "94c20ef94041345cce7f216f4914a8cbea861be4";
const R1_RAW_SHA256 = "a93859dfd39fd40b1bef3ea27b4a7af2e53a8172640e19a8a665630d39026cce";
const R1_MANIFEST_SHA256 = "202e6cb75b56d47e04f8e7bc9c2551b0312ca8bff6f0da2deac895c91d077430";
const R1_AGGREGATE = "7b31395a381fce3da5f3c9ccfa5985cbfed3d4bef22bbd699c1ec358c6028029";
const read = rel => fs.readFileSync(path.join(ROOT, rel));
const write = (rel, value) => fs.writeFileSync(path.join(ROOT, rel), value);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const lower = value => String(value).toLowerCase();
function preserveR1() {
  if (!fs.existsSync(path.join(ROOT, R1_RAW_REL))) { const body = read(RAW_REL); if (sha(body) !== R1_RAW_SHA256) throw new Error("R1_RAW_PREIMAGE_MISMATCH"); write(R1_RAW_REL, body); }
  if (!fs.existsSync(path.join(ROOT, R1_MANIFEST_REL))) { const body = read(MANIFEST_REL); if (sha(body) !== R1_MANIFEST_SHA256) throw new Error("R1_MANIFEST_PREIMAGE_MISMATCH"); write(R1_MANIFEST_REL, body); }
  if (sha(read(R1_RAW_REL)) !== R1_RAW_SHA256 || sha(read(R1_MANIFEST_REL)) !== R1_MANIFEST_SHA256) throw new Error("R1_RETAINED_COPY_MISMATCH");
}
function unresolvedLegacySlot() { return { readStatus: "UNRESOLVED_R1_COLLAPSED_NULL", selectedFamilies: 2, successfulFamilies: null, agreement: null, value: null, implementation: null, proxyDetected: null, reason: "R1 did not preserve per-family slot success/value and collapsed failure, disagreement, and agreed-zero to null." }; }
function correctedRuntime(runtime, kind) {
  const exact = kind === "publicAllocator" && runtime.directRuntimeExactLocalDeploymentArtifact === true;
  return {
    codeBytes: runtime.codeBytes,
    codeKeccak256: runtime.codeKeccak256,
    runtimeEquivalence: exact ? { status: "EXACT_DEPLOYED_BYTECODE_MATCH_RETAINED", cryptographicallySupported: true, localArtifactManifestBound: true, normalizedComparisonPerformed: false } : { status: "UNBOUND_RETAINED_CODE_HASH_ONLY", cryptographicallySupported: false, localArtifactManifestBound: kind === "factory", normalizedComparisonPerformed: false },
    sourceSemanticsBound: exact,
    abiObservedStateOnly: !exact,
    eip1967ImplementationSlot: unresolvedLegacySlot(),
    proxyDetected: null
  };
}
function completeVault(vault) {
  return Boolean(vault && typeof vault.vault === "string" && typeof vault.owner === "string" && typeof vault.curator === "string" && typeof vault.publicAllocatorGranted === "boolean" && typeof vault.totalAssetsRaw === "string" && vault.queueLengths && Number.isSafeInteger(vault.queueLengths.supply) && Number.isSafeInteger(vault.queueLengths.withdraw) && Array.isArray(vault.markets) && Array.isArray(vault.pairCandidates));
}
function correctVault(vault, allocator) {
  const isAllocatorMapping = vault.publicAllocatorGranted === true, ownerEqualsAllocator = lower(vault.owner) === lower(allocator), curatorEqualsAllocator = lower(vault.curator) === lower(allocator), publicAllocatorAuthorized = isAllocatorMapping || ownerEqualsAllocator || curatorEqualsAllocator;
  const out = { ...vault };
  delete out.publicAllocatorGranted;
  out.factoryAuthenticated = true;
  out.factoryAuthenticationEvidence = "Retained R1 runner included a vault only after a two-family isSiloVault(vault)==true ABI call; the boolean was not explicitly persisted in R1.";
  out.runtime = correctedRuntime(vault.runtime, "vault");
  out.authorization = { formula: "isAllocator[allocator] || owner == allocator || curator == allocator", isAllocatorMapping, ownerEqualsAllocator, curatorEqualsAllocator, publicAllocatorAuthorized, predicateInputsAbiObserved: true, localSourcePredicateReviewed: true, deployedVaultRuntimeSemanticsBound: false };
  out.requiredStateComplete = completeVault(vault);
  out.stateConclusion = out.requiredStateComplete && !publicAllocatorAuthorized ? "KNOWN_AUTHORIZATION_PREDICATE_FALSE" : out.requiredStateComplete ? "KNOWN_AUTHORIZATION_PREDICATE_TRUE" : "REQUIRED_STATE_INCOMPLETE";
  out.markets = out.markets.map(market => ({ ...market, runtime: correctedRuntime(market.runtime, "market") }));
  return out;
}
function correctChain(chain) {
  const out = { ...chain, retainedCaptureStatus: chain.status };
  if (chain.status !== "CAPTURED") { out.factoryAuthenticatedStateComplete = null; out.strictlyComplete = false; return out; }
  out.status = "RETAINED_STATE_PARTIAL_HISTORY_STRICTNESS_UNPROVEN";
  out.strictlyComplete = false;
  out.deployments = { ...chain.deployments, publicAllocatorRuntime: correctedRuntime(chain.deployments.publicAllocatorRuntime, "publicAllocator"), factoryRuntime: correctedRuntime(chain.deployments.factoryRuntime, "factory"), factorySourceSemanticsBound: false, factoryAbiObservedStateOnly: true };
  out.history = { ...chain.history, strictDecoderAppliedInR1: false, malformedMatchingLogs: null, strictDecodeComplete: false, eventUniverseComplete: false, knownDecodedRowsOnly: true, reason: "R1 silently dropped decode failures and did not preserve raw logs or malformed counts; retained history cannot be re-decoded offline." };
  out.vaults = chain.vaults.map(vault => correctVault(vault, chain.deployments.publicAllocator));
  const incomplete = out.vaults.filter(v => v.factoryAuthenticated && v.requiredStateComplete !== true).length;
  out.factoryAuthenticatedStateComplete = incomplete === 0;
  out.incompleteRequiredStateVaults = incomplete;
  if (incomplete > 0) out.status = "BLOCKED_AUTHENTICATED_VAULT_REQUIRED_STATE_INCOMPLETE";
  return out;
}
function report(raw) {
  const rows = raw.chains.map(c => `| ${c.chain} (${c.chainId}) | ${c.status} | ${c.vaults.length} | ${c.strictlyComplete === true} |`).join("\n");
  return `# 🟠 WATCH — Silo V3 PublicAllocator Step 2 Oracle R2\n\n**Classification:** \`${raw.classification}\`  \n**Operational gates:** routePositive=\`0\`, executableNow=\`0\`, signedActionJustified=\`false\`, fork=\`false\`.\n\n## Corrected result\n\nThis is an **offline correction of the retained R1 capture only**. No endpoint inventory, network, RPC, fork, secret, key, signing, or transaction was read or used. It makes no global deployment-absence or route-negative claim.\n\nSix known factory-authenticated vault rows have complete retained authorization inputs. For each, the corrected reviewed-source predicate is:\n\n\`publicAllocatorAuthorized = isAllocator[allocator] || owner == allocator || curator == allocator\`.\n\nThe reviewed local predicate is at \`SiloVault.sol:146-154\`; PublicAllocator reaches it through \`PublicAllocator.sol:102-153\`. All three inputs are false for all six known rows, so the predicate is false for **6/6**. The previous wording based only on \`isAllocator\` was incomplete. Four known rows are on Arbitrum and two on BNB; all retain zero ABI-observed \`totalAssets\`, but that fact is scoped to these known rows and fixed pins.\n\n## Runtime and source-semantics correction\n\n- **PublicAllocator:** retained deployed bytecode exactly matched each checked-in PublicAllocator deployment artifact on seven retained-state chains. This exact-match claim remains separate and manifest-bound.\n- **Factory:** retained code length/hash and \`VERSION()\` are ABI observations only. No deployed code preimage was retained for a cryptographic normalized comparison, so factory runtime equivalence and local factory source semantics are **unbound**.\n- **Vault/market:** retained code length/hash plus ABI call results are observations only. No local SiloVault deployment artifact/deployed code preimage supports normalized equality, so vault/market runtime equivalence and deployed local source semantics are **unbound**. The authorization formula is explicitly a reviewed-local-source predicate evaluated over retained ABI inputs, not proof that the unbound deployed vault bytecode implements that predicate. No other local SiloVault semantics are applied to deployment state.\n\n## EIP-1967 correction\n\nR1 collapsed slot read failure, disagreement, and agreed-zero into the same null before persisting. Therefore every retained allocator/factory/vault/market slot is now \`UNRESOLVED_R1_COLLAPSED_NULL\` with success count, agreement, value, implementation, and \`proxyDetected\` all null. The prior “no nonzero slot” and \`proxyDetected=false\` wording is retracted. Future captures preserve exact tri-state observations; only successful all-family agreement may assert zero/nonzero.\n\n## Factory-history completeness\n\nR1 silently dropped matching factory logs that failed decoding and did not retain raw logs or malformed counts. The six decoded rows were separately authenticated by \`isSiloVault\` before inclusion, and their required retained state is explicitly complete. However, no retained chain has strict history completeness: malformed count is null and event-universe completeness is false. Future runner behavior fails closed on any malformed matching log, failed vault authentication, or authenticated vault with incomplete required state.\n\n| chain | retained/corrected status | known vaults | strictly complete |\n|---|---|---:|---:|\n${rows}\n\nPre-existing blocks remain: XDC \`50\`, X Layer \`196\`, Injective EVM \`1776\`, and MegaETH \`4326\` lack retained endpoint coverage; Optimism \`10\` failed terminal recheck; Avalanche \`43114\` lacked bounded history. The seven retained-state chains additionally remain history-strictness incomplete.\n\n## Impact and disposition\n\nNo known row satisfies the reviewed authorization predicate and no known structural pair was retained. This blocks PA-R2-01 only for the six known rows under the explicitly qualified predicate; it does not establish global absence because runtime semantics, strict history completeness, and six chains remain open. PA-R2-02 remains deployment-unbound. Gas, native/asset pricing, capital cost, exit, and exact net remain unresolved. No fork is justified.\n\n## Material binding\n\nThe deterministic manifest binds the predecessor raw/manifest, all checked-in PublicAllocator/factory deployment artifacts, the four broadcast receipts actually used as history lower bounds, relevant source/interface/library files, Foundry configuration, target package/yarn lock, tool package/package-lock, installed ethers package metadata, target Git HEAD/ref, runner, fixtures, correction tool, validator, and package outputs. Runtime context: Node \`${raw.materialContext.nodeVersion}\`, ethers \`${raw.materialContext.ethersVersion}\`, target commit \`${raw.materialContext.targetCommit}\`.\n`;
}
function handoff(raw) { return `# Silo V3 PublicAllocator Step 2 Oracle R2 handoff\n\n- ${raw.classification}; gates 0/0/false; fork false.\n- Offline retained-capture correction only; inventory/network/RPC/fork/secrets/signing all zero.\n- Authorization corrected to isAllocator OR owner OR curator. All three retained ABI inputs are false for all six known factory-authenticated, required-state-complete vault rows. Deployed vault runtime semantics remain unbound.\n- PublicAllocator exact deployed-bytecode/local-artifact matches remain for seven retained-state chains. Factory and vault/market runtime equivalence are unbound; their retained state is ABI-observed only.\n- Every R1 EIP-1967 observation is corrected to unresolved collapsed-null; no zero-slot or proxyDetected=false claim survives.\n- R1 factory history was not fail-closed on malformed logs. Six known rows were authenticated, but strict malformed count/universe completeness are null/false for all retained-state chains.\n- Existing blocked chains remain, and seven retained-state chains additionally retain history-strictness incompleteness. No global absence claim and no fork.\n`; }
function leakGuard(text) { if (/(?:https?|wss?):\/\//i.test(text) || /"(?:url|headers|apiKey|token|rawResponse|responseBody)"\s*:/i.test(text)) throw new Error("CORRECTION_OUTPUT_LEAK_GUARD"); }
function main() {
  preserveR1(); const r1 = JSON.parse(read(R1_RAW_REL)); if (r1.schemaVersion !== 1 || sha(read(R1_RAW_REL)) !== R1_RAW_SHA256) throw new Error("R1_BINDING");
  const chains = r1.chains.map(correctChain), retained = chains.filter(c => c.retainedCaptureStatus === "CAPTURED"), knownVaults = retained.flatMap(c => c.vaults), incomplete = knownVaults.filter(v => !v.requiredStateComplete), authorized = knownVaults.filter(v => v.authorization.publicAllocatorAuthorized);
  if (incomplete.length !== 0 || knownVaults.length !== 6 || authorized.length !== 0) throw new Error("CORRECTED_KNOWN_VAULT_GATE");
  const raw = { ...r1, schemaVersion: 2, revision: "oracle-r2-offline", runId: `${r1.runId}-oracle-r2-offline`, generatedAt: CORRECTION_TIME, classification: CLASSIFICATION, chainDefinitionValidation: { expectedChainIds: [1,10,50,56,146,196,1776,4326,5000,8453,42161,43114,57073], expectedCount: 13, observedRows: chains.length, uniqueExpectedChainIds: true, uniqueObservedChainIds: new Set(chains.map(c => c.chainId)).size === chains.length, exactExpectedSet: chains.map(c => c.chainId).sort((a,b)=>a-b).join(",") === [1,10,50,56,146,196,1776,4326,5000,8453,42161,43114,57073].sort((a,b)=>a-b).join(",") }, summary: { retainedStateChains: retained.length, strictlyCompleteChains: chains.filter(c => c.strictlyComplete).length, preexistingBlockedChains: chains.filter(c => c.retainedCaptureStatus !== "CAPTURED").length, historyStrictnessIncompleteRetainedChains: retained.filter(c => !c.history.strictDecodeComplete).length, knownFactoryAuthenticatedVaults: knownVaults.length, knownRequiredStateCompleteVaults: knownVaults.filter(v => v.requiredStateComplete).length, knownAuthorizationPredicateFalseVaults: knownVaults.filter(v => !v.authorization.publicAllocatorAuthorized).length, knownPublicAllocatorAuthorizedVaults: authorized.length, knownStructuralPairCandidates: r1.candidates.length, globalVaultUniverseComplete: false }, chains, candidates: r1.candidates, runtimeBinding: { publicAllocatorExactRetainedChains: retained.filter(c => c.deployments.publicAllocatorRuntime.runtimeEquivalence.status === "EXACT_DEPLOYED_BYTECODE_MATCH_RETAINED").length, factoryNormalizedRuntimeEquivalentChains: 0, vaultNormalizedRuntimeEquivalentRows: 0, factoryAndVaultSourceSemanticsBound: false }, slotCorrection: { affectedRuntimeObservations: retained.reduce((n,c)=>n+2+c.vaults.length+c.vaults.reduce((m,v)=>m+v.markets.length,0),0), allRetainedStatuses: "UNRESOLVED_R1_COLLAPSED_NULL", zeroSlotClaims: 0, proxyFalseClaimsFromSlots: 0 }, materialContext: { targetCommit: TARGET_COMMIT, targetHeadRef: "refs/heads/develop", nodeVersion: "v24.13.0", platform: "win32", arch: "x64", ethersVersion: "6.16.0", ethersCommonJsEntry: "tools/node_modules/ethers/lib.commonjs/index.js" }, predecessorBinding: { rawPath: R1_RAW_REL, rawSha256: R1_RAW_SHA256, manifestPath: R1_MANIFEST_REL, manifestSha256: R1_MANIFEST_SHA256, aggregateSha256: R1_AGGREGATE }, oracleCorrection: { offlineOnly: true, inventoryReads: 0, networkReads: 0, rpcReads: 0, fork: false, secretsRead: false, signing: false, transactions: false, stateMutation: false, rawResponseReads: 0 }, safety: { ...r1.safety, oracleCorrectionOfflineOnly: true }, nextAction: "No fork. Reopen on exact deployed vault semantics plus strict history coverage, or a newly authorized/configured known vault." };
  const inbox = { findingId: raw.findingId, runId: raw.runId, agentId: "critical-silo-v3-public-allocator-step2-oracle-r2-20260729", role: "critical-research", status: "known-six-authorization-predicate-false-runtime-and-history-unbound", classification: raw.classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, correctedAuthorization: { formula: "isAllocator[allocator] || owner == allocator || curator == allocator", knownRows: 6, allThreeFalseRows: 6, authorizedRows: 0, deployedVaultRuntimeSemanticsBound: false }, runtime: raw.runtimeBinding, slots: raw.slotCorrection, coverage: { strictHistoryCompleteChains: 0, preexistingBlockedChains: 6, globalVaultUniverseComplete: false }, artifacts: [RAW_REL, REPORT_REL, INBOX_REL, HANDOFF_REL, MANIFEST_REL, R1_RAW_REL, R1_MANIFEST_REL, "tools/run-critical-silo-v3-public-allocator-step2.js", "tools/test-critical-silo-v3-public-allocator-step2.js", "tools/validate-critical-silo-v3-public-allocator-step2.js", "tools/correct-critical-silo-v3-public-allocator-step2-oracle-r2.js"], nextAction: raw.nextAction };
  const outputs = [[RAW_REL, `${JSON.stringify(raw, null, 2)}\n`], [REPORT_REL, report(raw)], [INBOX_REL, `${JSON.stringify(inbox, null, 2)}\n`], [HANDOFF_REL, handoff(raw)]];
  for (const [, text] of outputs) leakGuard(text); for (const [rel, text] of outputs) write(rel, text);
  process.stdout.write(`${JSON.stringify({ status: "CORRECTED_OFFLINE", classification: raw.classification, knownVaults: 6, authorized: 0 })}\n`);
}
if (require.main === module) main();
module.exports = { correctedRuntime, completeVault, correctVault, correctChain, report, handoff };
