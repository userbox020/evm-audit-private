#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const RAW_PATH = path.join(ROOT, "reports", "raw", "fast", "critical-eigenlayer-strategybase-steth-deployment-economics-step3.json");
const MANIFEST_PATH = path.join(ROOT, "reports", "raw", "fast", "critical-eigenlayer-strategybase-steth-deployment-economics-step3-manifest.json");
const RUNNER_PATH = path.join(ROOT, "tools", "run-critical-eigenlayer-steth-deployment-economics-step3.js");

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileSha256(file) { return sha256(fs.readFileSync(file)); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

let checks = 0;
function check(condition, message) { if (!condition) throw new Error(`VALIDATION_FAILED:${message}`); checks++; }

const rawText = fs.readFileSync(RAW_PATH, "utf8");
const manifestText = fs.readFileSync(MANIFEST_PATH, "utf8");
const raw = JSON.parse(rawText);
const manifest = JSON.parse(manifestText);

check(!/:\/\//.test(rawText), "url-material");
check(!/\b(hostname|providerName|providerDomain|rawResponse|rawInventory|requestHeaders|endpointUrl)\b/i.test(rawText), "identity-material");
check(raw.classification === "CLEAN/DEPLOYED-CONTINUITY-BOUND/CURRENT-DUST-DEPOSIT-REVERTS/CURRENT-CAPTURE-ZERO", "classification");
check(raw.schemaVersion === 2 && raw.revision.id === "oracle-final-p0p1-helper-two-transaction-r2", "revision");
check(raw.revision.mode === "OFFLINE_REPACKAGE_RETAINED_FIXED_PIN"
  && raw.revision.networkAccess === false
  && raw.revision.rpcCalls === 0
  && raw.revision.endpointInventoryRead === false, "offline-revision");
check(raw.providerEvidence.anonymousProviderFamiliesUsed >= 2, "provider-families");
check(raw.providerEvidence.families.every(f => /^family-\d+$/.test(f.anonymousId) && /^[0-9a-f]{64}$/.test(f.commitment)), "family-commitments");
check(raw.pin.chainId === 1 && raw.pin.finalized === true, "finalized-pin");
check(raw.terminalPinRecheck.allMatched === true, "terminal-pin");
check(raw.rpcBudget.attempted <= raw.rpcBudget.max
  && raw.rpcBudget.retainedCaptureOnly === true
  && raw.rpcBudget.revisionRpcCalls === 0, "rpc-budget");
check(raw.deployments.allImplementationAddressesMatched === true, "implementations");
check(raw.deployments.allLinksMatched === true, "links");
check(raw.currentState.strategyManager.strategyWhitelisted === true, "whitelist");
check(raw.currentState.permissionlessSurface.permissionlessSurfaceBound === true, "surface");
check(raw.currentState.permissionlessSurface.currentMaximumZeroShareDepositAccepted === false, "dust-deposit-revert");
check(raw.providerEvidence.stateQueryProviderFamiliesUsed === 1, "one-state-family-caveat");
check(raw.sourceArtifacts.reproducibleRuntimeSourceBytecodeEquivalenceClaimed === false, "no-runtime-equality-claim");
check(raw.currentState.stethShareRate.maximumPooledAmountMovingZeroTokenShares !== "0", "zero-share-dust");
const dust = BigInt(raw.currentState.stethShareRate.maximumPooledAmountMovingZeroTokenShares);
const strategyShares = BigInt(raw.currentState.stethStrategy.totalShares);
const strategyBalance = BigInt(raw.currentState.stethStrategy.stethBalance);
const calculatedDustMint = dust * (strategyShares + 1000n) / (strategyBalance + 1000n - dust);
check(calculatedDustMint.toString() === raw.currentState.permissionlessSurface.currentMaximumZeroShareDepositMintsStrategyShares, "dust-mint-recompute");
check(calculatedDustMint === 0n && raw.economics.current.rawCapturePooledWei === "0", "current-capture-zero");
check(raw.economics.current.dustDepositAccepted === false
  && raw.economics.current.batchSimulation.every(b => b.depositWouldRevert === true)
  && raw.economics.current.batchSimulation.every(b => b.currentCapturePooledWei === "0"), "current-batch-reverts");
const helper = raw.economics.hypotheticalHelperBatching;
check(helper.helperCanApproveAndSequentiallyCallDepositsThenQueueInOneTransaction === true
  && helper.nonReentrantDoesNotBlockSequentialCalls === true
  && helper.completionRequiresLaterTransactionAfterDelay === true, "helper-sequential-batching");
check(helper.minimumProtocolPathTransactions === 2
  && helper.minimumProtocolPathIntrinsicGasUnitsLowerBound === "42000", "helper-minimum-path");
check(helper.perDepositExecutionGasLowerBound === null
  && helper.blockGasBatchingCap === null
  && helper.maximumFeasibleDepositCountPerTransaction === null, "helper-bounds-unresolved");
check(helper.netEconomics === null && helper.economicsResolved === false, "helper-economics-unresolved");
check(raw.economics.fixedPinBaseFeeUsedForHypotheticalClosure === false
  && raw.economics.disposition.economicsClosed === false, "no-hypothetical-close");
check(!/(symbolicPreapprovedTransactionCount|symbolicFreshApprovalTransactionCount|boundedEconomicsClosed|preapprovedTransactions|freshApprovalTransactions|intrinsicCostWeiLowerBoundPreapproved|intrinsicCostWeiLowerBoundFreshApproval)/.test(rawText), "invalid-economics-fields-removed");
check(!/protocol-native atomic batch|ECONOMICS-CLOSED/.test(rawText), "invalid-closure-claims-removed");
check(raw.economics.exactP0P1.currentRouteReproducedAtPin === false
  && BigInt(raw.economics.exactP0P1.rawGainTokenShares) === 1n
  && BigInt(raw.economics.exactP0P1.nominalCapitalStethWei) > 10n ** 22n, "exact-p0p1-noncurrent-capital");
check(raw.economics.exactP0P1.minimumProtocolPathTransactions === 2
  && raw.economics.exactP0P1.minimumProtocolPathIntrinsicGasUnitsLowerBound === "42000"
  && raw.economics.exactP0P1.transactionPlan.length === 2, "exact-p0p1-two-transactions");
check(raw.economics.exactP0P1.rebaseOccursDuringWithdrawalQueueDelay === true
  && raw.economics.exactP0P1.queueingBurnsStrategyBaseSharesUnderFactorOneModel === false
  && raw.economics.exactP0P1.queueingRemovesStethCustodyUnderFactorOneModel === false, "exact-p0p1-queue-preserves-shares-custody");
check(raw.economics.exactP0P1.requiresExogenousExactRebaseResidue === true
  && raw.economics.exactP0P1.conditionalFutureCase === true
  && raw.economics.exactP0P1.intrinsicCostWeiLowerBoundAtExecution === null
  && raw.economics.exactP0P1.economicsResolved === false, "exact-p0p1-future-unresolved");
check(!/deposit before exogenous rebase|queue after exogenous rebase|three separated protocol-path transactions|"63000"/.test(rawText), "p0p1-obsolete-separation-removed");
check(raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false, "gates");
check(raw.safety.rpcReadOnly === true && raw.safety.transactions === false && raw.safety.broadcasts === false
  && raw.safety.offlineRevisionOnly === true && raw.safety.revisionNetworkAccess === false
  && raw.safety.revisionRpcCalls === 0, "safety");
check(raw.safety.endpointMaterialPersisted === false && raw.safety.rawResponsesPersisted === false, "sanitization");
check(manifest.rawSha256 === fileSha256(RAW_PATH), "raw-hash");
check(manifest.runnerSha256 === fileSha256(RUNNER_PATH), "runner-hash");
check(manifest.schemaVersion === 2 && manifest.revision.id === raw.revision.id, "manifest-revision");
check(manifest.predecessor.manifestAggregateSha256 === "47d98be5ccde08143791bed060b03d0b05cc137fd75c4247ed8d3147d405a1f8", "predecessor-binding");
check(manifest.rootPredecessor.manifestAggregateSha256 === "2ff2fd3605679852329897ea3caa77f27d0ca8914c58e967808543b9601c5946", "root-predecessor-binding");
check(manifest.sourceCommitments.eigenlayerCurrentReadmeSha256 === raw.sourceArtifacts.hashes.eigenlayerCurrentReadmeSha256, "source-commitment");
const manifestBase = { ...manifest };
delete manifestBase.aggregateSha256;
check(manifest.aggregateSha256 === sha256(canonical(manifestBase)), "aggregate-hash");
check(!/:\/\//.test(manifestText), "manifest-url-material");
check(!/\b(hostname|providerName|providerDomain|rawResponse|rawInventory|requestHeaders|endpointUrl)\b/i.test(manifestText), "manifest-identity-material");

process.stdout.write(`${JSON.stringify({ ok: true, checks })}\n`);
