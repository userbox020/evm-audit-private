#!/usr/bin/env node
"use strict";

// Reviewer-corrected offline successor. Consumes only sanitized predecessor artifacts.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-cash-withdrawal-token-deployment-binding-r2";
const REVISION = "cash-withdrawal-token-deployment-binding-reviewer-r2";
const AGENT = "reviewer-etherfi-cash-withdrawal-r2-20260724";
const CLASSIFICATION = "INFORMATIONAL/WATCH/REVIEWER-R2/DIRECT-TOKEN-TRANSFER-BEHAVIOR-ONLY/CASHMODULE-SETTERS-SOURCE-RUNTIME-OPEN/NO-INCOMPLETE-DELIVERY-OBSERVED/NO-ATTACKER-GAIN/FIXED-PIN";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/review-${NAME}-2026-07-24.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const R1_RAW = "reports/raw/fast/critical-etherfi-cash-withdrawal-token-deployment-binding.json";
const R1_MANIFEST = "reports/raw/fast/critical-etherfi-cash-withdrawal-token-deployment-binding-manifest.json";
const R1_REPORT = "reports/critical-etherfi-cash-withdrawal-token-deployment-binding.md";
const SOURCE_R2_RAW = "reports/raw/fast/critical-etherfi-cash-withdrawal-exactly-once-r2.json";
const SOURCE_R2_MANIFEST = "reports/raw/fast/critical-etherfi-cash-withdrawal-exactly-once-r2-manifest.json";
const SOURCE_R2_REPORT = "reports/critical-etherfi-cash-withdrawal-exactly-once-r2.md";
const FORK_TEST = "targets/cash-v3/test/critical/CashWithdrawalTokenDeploymentBindingFork.t.sol";

const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };
const check = (ok, message) => { if (!ok) throw new Error(message); };
function writeOwned(rel, text) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8"); }
function sanitize(text) { if (/https?:\/\//i.test(text)) throw new Error("endpoint leak"); if (/(?:private[_ -]?key|seed[_ -]?phrase|mnemonic)["']?\s*[:=]\s*["']?[^\s,"'}]{12,}/i.test(text)) throw new Error("secret-pattern leak"); }

function verifyManifest(manifest, label) {
  const current = manifest.records.map((record) => {
    const row = hashFile(record.path);
    check(row.bytes === record.bytes && row.sha256 === record.sha256, `${label} manifest drift: ${record.path}`);
    return row;
  });
  const aggregate = sha(current.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"));
  check(aggregate === manifest.aggregateSha256, `${label} aggregate drift`);
  return aggregate;
}

function main() {
  const generatedAt = new Date().toISOString();
  const predecessor = JSON.parse(fs.readFileSync(abs(R1_RAW), "utf8"));
  const predecessorManifest = JSON.parse(fs.readFileSync(abs(R1_MANIFEST), "utf8"));
  const sourceR2 = JSON.parse(fs.readFileSync(abs(SOURCE_R2_RAW), "utf8"));
  const sourceR2Manifest = JSON.parse(fs.readFileSync(abs(SOURCE_R2_MANIFEST), "utf8"));
  const predecessorAggregate = verifyManifest(predecessorManifest, "deployment R1");
  const sourceR2Aggregate = verifyManifest(sourceR2Manifest, "source R2");
  check(predecessorManifest.runId === predecessor.runId, "deployment predecessor run mismatch");
  check(sourceR2Manifest.runId === sourceR2.runId, "source R2 run mismatch");
  check(predecessor.configuredWithdrawalTokenCount === 20 && predecessor.tokens.length === 20, "token observations incomplete");
  check(predecessor.behaviorSummary.standardBoolExactCount === 20 && predecessor.behaviorSummary.falseReturnObservedCount === 0 && predecessor.behaviorSummary.feeOrPartialObservedCount === 0 && predecessor.behaviorSummary.behaviorUnresolvedCount === 0, "token behavior predecessor drift");
  check(predecessor.forkTests.passCount === 5 && predecessor.forkTests.totalBehaviorProbeCount === 60, "inherited fork evidence drift");
  check(predecessor.source.cashModuleCoreExactRuntime === false && predecessor.source.cashModuleSettersExactRuntime === false && predecessor.source.allMetadataNormalizedRuntimeContinuity === false, "runtime continuity blocker drift");
  check(sourceR2.tests.passCount === 30 && sourceR2.reviewerCorrections.separateSentinelFuzzProperty, "corrected source predecessor incomplete");

  const selfChecks = {
    predecessorDeploymentManifestValid: true,
    correctedSourceR2ManifestValid: true,
    fixedPinPreserved: predecessor.pin.finalized === true,
    providerThresholdPreserved: predecessor.providerCoverage.exactDecodedStateFamilyCount === 2,
    terminalRecheckPreserved: predecessor.terminalRecheck.every((row) => row.sameNumberHashMatch),
    tokenCountPreserved: predecessor.tokens.length === 20,
    directTransferProbeCountPreserved: predecessor.forkTests.totalBehaviorProbeCount === 60,
    standardBoolExactCountPreserved: predecessor.behaviorSummary.standardBoolExactCount === 20,
    falseReturnCountZero: predecessor.behaviorSummary.falseReturnObservedCount === 0,
    feeOrPartialCountZero: predecessor.behaviorSummary.feeOrPartialObservedCount === 0,
    unresolvedCountZero: predecessor.behaviorSummary.behaviorUnresolvedCount === 0,
    coreRuntimeContinuityOpen: predecessor.source.cashModuleCoreExactRuntime === false,
    settersRuntimeContinuityOpen: predecessor.source.cashModuleSettersExactRuntime === false,
    noStateMachineSemanticsClaimed: true,
    noSentinelDeploymentClaimed: true,
    noNetworkRerun: true,
    noForkRerun: true,
    attackerGainZero: predecessor.behaviorSummary.attackerGainRaw === "0",
  };
  check(Object.values(selfChecks).every(Boolean), "offline reviewer self-check failed");
  const runId = `etherfi-cash-withdrawal-token-binding-r2-${predecessor.pin.number}-${predecessor.pin.hash.slice(2, 14)}-${sourceR2Aggregate.slice(0, 12)}`;
  const result = {
    schemaVersion: 1,
    revision: REVISION,
    runId,
    generatedAt,
    agentId: AGENT,
    role: "reviewer",
    classification: CLASSIFICATION,
    predecessors: {
      deploymentR1: { runId: predecessor.runId, classification: predecessor.classification, raw: hashFile(R1_RAW), manifest: hashFile(R1_MANIFEST), report: hashFile(R1_REPORT), verifiedManifestAggregateSha256: predecessorAggregate },
      correctedSourceR2: { runId: sourceR2.runId, classification: sourceR2.classification, raw: hashFile(SOURCE_R2_RAW), manifest: hashFile(SOURCE_R2_MANIFEST), report: hashFile(SOURCE_R2_REPORT), verifiedManifestAggregateSha256: sourceR2Aggregate },
    },
    reviewerCorrection: {
      directTokenBehaviorOnly: true,
      deployedWithdrawalStateMachineSemanticsClaimed: false,
      deployedProcessWithdrawalDeletionOrderingClaimed: false,
      deployedOptionalReturnConsumptionClaimed: false,
      deployedSentinelRecipientBehaviorClaimed: false,
      reason: "The fixed-pin fork probes directly called token transfer/transferFrom from dealt ephemeral holders. They did not create or process a real Safe withdrawal. Active CashModuleCore and CashModuleSetters do not match the locally reviewed source runtime, so source state-machine semantics cannot be joined to deployment behavior.",
    },
    conclusion: {
      status: "WATCH_REVIEWER_R2_DIRECT_TOKEN_BEHAVIOR_NEGATIVE_DEPLOYED_STATE_MACHINE_UNBOUND",
      advances: false,
      branchPipeline: "0/5_DEPLOYED-WITHDRAWAL-STATE-MACHINE-UNBOUND_DIRECT-TOKEN-BEHAVIOR-GATE-NEGATIVE",
      extractionPipeline: "0/5_NO_ATTACKER_VALUE_PATH",
      globalHighestPipeline: "DebtManager donation 2/5 WATCH unchanged",
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      reason: "All 20 fixed-pin direct token probes delivered exact amounts and returned true on tested paths, with no false return, fee, partial delivery, unresolved row, or attacker gain. This blocks the token-behavior precondition only for those direct probes. Deployed Cash withdrawal state-machine behavior remains unbound because Core/Setters exact runtime/source continuity is open.",
    },
    safety: { offlineReviewerSuccessor: true, networkRerun: false, rpcInventoryRead: false, forkRerun: false, liveTransactions: false, signedActions: false, broadcasts: false, productionMutation: false, realFunds: false, keysRead: false, endpointMaterialRead: false },
    retainedFixedPinEvidence: {
      pin: predecessor.pin,
      providerCoverage: predecessor.providerCoverage,
      terminalRecheck: predecessor.terminalRecheck,
      deploymentLinkage: predecessor.deployment,
      configurationDrift: predecessor.configurationDrift,
      runtimeSourceContinuity: predecessor.source,
    },
    directTokenBehavior: {
      configuredTokenCount: predecessor.configuredWithdrawalTokenCount,
      summary: predecessor.behaviorSummary,
      tokens: predecessor.tokens,
      inheritedForkTests: { ...predecessor.forkTests, rerunInR2: false, interpretation: "direct token calls with dealt ephemeral balances only; no Cash/Safe withdrawal transaction" },
      proves: ["return-data class for tested direct transfer/transferFrom calls", "sender and receiver balance deltas for one raw and/or one decimal unit", "runtime/proxy metadata at retained pin"],
      doesNotProve: ["deployed CashModule request validation", "deployed processWithdrawal execution or request deletion", "Safe-mediated optional-return handling joined to current Core", "deployed Solady sentinel rejection", "global fee/rebase/blacklist/hook/upgrade behavior"],
    },
    correctedSourceContext: {
      localExactSourceTests: "30/30",
      sentinelRegressionLocalOnly: true,
      falsePartialPrimitiveLocalOnly: true,
      deployedJoinEstablished: false,
    },
    selfChecks: { passed: Object.keys(selfChecks).length, checks: selfChecks },
    nextGate: "Recover an exact active CashModuleCore/CashModuleSetters source-build pair and independently compare withdrawal request/process semantics. Do not rerun token probes, fork, or perform live action unless runtime/config changes or reviewed source continuity establishes a concrete need.",
  };
  const rows = result.directTokenBehavior.tokens.map((token) => `| ${token.fixtureName || token.symbol || "unmapped"} | \`${token.address}\` | ${token.decimals} | ${token.behavior.classification} |`).join("\n");
  const rawText = JSON.stringify(result, null, 2) + "\n";
  const reportText = `# Ether.fi Cash withdrawal-token deployment binding — reviewer R2\n\n**Signal:** 🟢 DORMANT — direct token behavior gate negative; deployed withdrawal state machine unbound.  \n**Classification:** \`${CLASSIFICATION}\`  \n**Retained pin:** Optimism \`${predecessor.pin.number}\` / \`${predecessor.pin.hash}\`. No network or fork rerun.\n\n## Reviewer correction\n\nThe retained **60** fork probes prove only direct \`transfer\`/\`transferFrom\` behavior from dealt ephemeral holders. They do **not** prove a deployed CashModule withdrawal request, Safe-mediated execution, request deletion, optional-return consumption, or Solady sentinel rejection. CashModuleCore and CashModuleSetters metadata-normalized runtime/source continuity remains false; EtherFiSafe alone matched. Therefore no deployed withdrawal state-machine semantics are claimed.\n\nThe corrected source R2 package is hash-bound and passes **30/30** local exact-source tests, including the zero-sentinel regression, but its semantics are not joined to this deployment.\n\n## Preserved token observations\n\n| Token | Address | Decimals | Direct tested behavior |\n|---|---|---:|---|\n${rows}\n\nAll **20** retained token rows returned standard boolean true with exact tested deltas. False-return, fee/partial, and unresolved counts remain **0**; attacker gain remains **0**. These are path/amount/pin-bounded observations, not global token safety.\n\n## Pipeline\n\nBranch: \`0/5_DEPLOYED-WITHDRAWAL-STATE-MACHINE-UNBOUND_DIRECT-TOKEN-BEHAVIOR-GATE-NEGATIVE\`; extraction \`0/5\`; global highest remains **DebtManager donation 2/5 WATCH**.\n`;
  const inbox = { findingId: NAME, agentId: AGENT, role: "reviewer", status: "watch-direct-token-negative-deployed-state-machine-unbound", classification: CLASSIFICATION, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "Reviewer R2 preserves 20-token/60-probe direct behavior observations but retracts any deployed Cash withdrawal state-machine inference; Core/Setters source-runtime continuity remains open, attacker gain zero.", artifacts: [RAW, REPORT, MANIFEST], nextAction: result.nextGate };
  const handoffText = `# Handoff: ${NAME}\n\n- Offline reviewer R2; no network/fork rerun.\n- Deployment R1 and corrected source R2 manifests independently revalidated and hash-bound.\n- Preserved: fixed pin, 20 token rows, 60 dealt-ephemeral direct probes, 20 standard-bool exact, 0 false/no-return/fee/partial/unresolved, attacker gain zero.\n- Correction: no deployed request/process/Safe state-machine/sentinel semantics claimed; active Core/Setters exact source-runtime continuity remains open.\n- Branch 0/5 deployed state-machine unbound; extraction 0/5; global DebtManager donation 2/5 WATCH unchanged.\n- Validate with \`node ${VALIDATOR}\`.\n`;
  for (const text of [rawText, reportText, JSON.stringify(inbox), handoffText]) sanitize(text);
  writeOwned(RAW, rawText); writeOwned(REPORT, reportText); writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n"); writeOwned(HANDOFF, handoffText);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R1_RAW, R1_MANIFEST, R1_REPORT, SOURCE_R2_RAW, SOURCE_R2_MANIFEST, SOURCE_R2_REPORT, FORK_TEST].map(hashFile);
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, records, aggregateSha256: sha(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")) };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n"; sanitize(manifestText); writeOwned(MANIFEST, manifestText);
  console.log(JSON.stringify({ ok: true, runId, classification: CLASSIFICATION, retainedPin: predecessor.pin, tokenCount: result.directTokenBehavior.configuredTokenCount, behaviorProbes: result.directTokenBehavior.inheritedForkTests.totalBehaviorProbeCount, sourceR2Tests: sourceR2.tests.passCount, selfChecks: result.selfChecks.passed, networkRerun: false, forkRerun: false, branchPipeline: result.conclusion.branchPipeline, globalHighestPipeline: result.conclusion.globalHighestPipeline, manifestAggregateSha256: manifest.aggregateSha256 }, null, 2));
}

try { main(); } catch (error) { console.error(`cash withdrawal deployment R2 packaging failed: ${String(error?.message || error).slice(0, 500)}`); process.exit(1); }
