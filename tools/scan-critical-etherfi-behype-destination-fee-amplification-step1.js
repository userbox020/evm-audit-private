#!/usr/bin/env node
"use strict";

// Bounded local-only defensive analysis. No RPC/inventory/web/fork/live calls,
// signing, broadcast, deployed invocation, or economics.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const NAME = "critical-etherfi-behype-destination-fee-amplification-step1";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const SOL_TEST = "targets/cash-v3/test/critical/BeHYPEDestinationFeeAmplificationStep1.t.sol";
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const SELECTION = "coordination/inbox/critical/2026-07-23-critical-etherfi-behype-accounting-selection.json";
const STEP3 = "reports/raw/fast/critical-etherfi-behype-fee-refund-delivery-invariant.json";
const STEP4 = "reports/raw/fast/critical-etherfi-behype-staker-layerzero-binding.json";
const SOURCE_COMMIT = "247faab2206cb651e2e81b2331404eed841145b8";
const REVISION = "behype-destination-fee-amplification-step1-local-model-r1";
const AGENT = "critical-etherfi-behype-feeamp-step1-20260723";
const FUZZ_RUNS = 256;
const FUZZ_SEED = "0xbeefee2026072300000000000000000000000000000000000000000000000001";
const SOURCE_FILES = [
  "src/modules/hype/BeHYPEStakeModule.sol",
  "src/interfaces/IL2BeHYPEOAppStaker.sol",
  "src/modules/ModuleBase.sol",
  "src/modules/ModuleCheckBalance.sol",
  "src/safe/EtherFiSafe.sol",
];

const abs = (x) => path.join(ROOT, x);
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const hashFile = (rel) => { const b = fs.readFileSync(abs(rel)); return { path: rel, bytes: b.length, sha256: sha(b) }; };
const sanitize = (x) => String(x || "").replace(/https?:\/\/\S+/gi, "[redacted]");
function writeOwned(rel, text) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text, "utf8");
}
function git(args) {
  const r = spawnSync("git", args, { cwd: TARGET, encoding: "utf8", timeout: 180_000, maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr || "").slice(-800)}`);
  return r.stdout;
}
const sourceAt = (rel) => git(["show", `${SOURCE_COMMIT}:${rel}`]);
const gitBlob = (rel) => git(["rev-parse", `${SOURCE_COMMIT}:${rel}`]).trim();
function unlinkLibraries(work) {
  const lib = path.join(work, "lib");
  if (!fs.existsSync(lib)) return;
  for (const name of fs.readdirSync(lib)) {
    const p = path.join(lib, name);
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch {}
  }
}
function cleanup(temp, work) {
  unlinkLibraries(work);
  try { git(["worktree", "remove", "--force", work]); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
}
function prepareWorktree() {
  const temp = path.join(os.tmpdir(), "opencode", "etherfi-behype-feeamp-step1");
  const work = path.join(temp, "source");
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  git(["worktree", "add", "--detach", work, SOURCE_COMMIT]);
  try {
    const lib = path.join(work, "lib");
    for (const name of fs.readdirSync(path.join(TARGET, "lib"))) {
      const dst = path.join(lib, name);
      fs.rmSync(dst, { recursive: true, force: true });
      fs.symlinkSync(path.join(TARGET, "lib", name), dst, "junction");
    }
    const dst = path.join(work, "test", "critical", path.basename(SOL_TEST));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs(SOL_TEST), dst);
    return { temp, work, out: path.join(temp, "out"), cache: path.join(temp, "cache") };
  } catch (e) {
    cleanup(temp, work);
    throw e;
  }
}
function forge(work, args, timeout = 900_000) {
  const r = spawnSync("forge", args, { cwd: work, encoding: "utf8", timeout, maxBuffer: 128 * 1024 * 1024 });
  const output = `${r.stdout || ""}\n${r.stderr || ""}`;
  return { status: r.status, timedOut: Boolean(r.error?.code === "ETIMEDOUT"), output, outputBytes: Buffer.byteLength(output), outputSha256: sha(output) };
}
function passRows(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\[PASS\]\s+([^\s(]+)(?:\([^)]*\))?(?:\s+\(runs:\s*(\d+),[^)]*\))?/);
    if (m) rows.push({ name: m[1], fuzzRuns: m[2] ? Number(m[2]) : 1 });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
function testFunctions(source) {
  return [...source.matchAll(/function\s+(test(?:Fuzz)?_[A-Za-z0-9_]+)\s*\(/g)].map((x) => x[1]).sort();
}
function testMatrix() {
  return [
    { id: "FEE-FUNDING", invariant: "attacker destination funding >= receiver fee or explicit subsidy bound", tests: ["test_publicEntrypointSourceFeeDoesNotFundDestinationFee_modelFact", "test_referenceRejectsUnfundedDestinationFeeWithoutSubsidy", "test_referenceAllowsOnlyExplicitBoundedSubsidyAndDebitsQuota"] },
    { id: "MINIMUMS", invariant: "zero/sub-unit requests rejected before shared fee debit", tests: ["test_zeroAmountAcceptedAndDebitsReceiver_hypothesisProfile", "test_subUnitAmountRoundsToZeroYetDebitsReceiver_hypothesisProfile", "test_minimalRoundedUnitDebitsSharedReceiver"] },
    { id: "REPEAT", invariant: "unique requests cannot linearly deplete unmetered shared native balance", tests: ["test_repeatedMinimalCallsLinearlyDepleteReceiver_noModeledRateOrCap"] },
    { id: "ROUND-WHOLE", invariant: "rounding and whole-balance accounting do not create unattributed output", tests: ["test_wholeBalanceCanAttributePriorRoundedOutputToNextBeneficiary", "test_subUnitAmountRoundsToZeroYetDebitsReceiver_hypothesisProfile"] },
    { id: "QUOTE-DRIFT", invariant: "destination quote drift is call-attributed or bounded", tests: ["test_quoteDriftBeforeDeliveryIsAbsorbedBySharedReceiverInModel"] },
    { id: "RETRY-REPLAY", invariant: "failed delivery rolls back and successful retry executes once", tests: ["test_failedDeliveryRollsBackThenRetryExecutesExactlyOnce", "test_endpointReplayGateRejectsDuplicateGuidAfterSuccess", "testFuzz_failedDeliveryRetryNeverDuplicates"] },
    { id: "REFUND", invariant: "return-message refund is restored to receiver", tests: ["test_returnAdapterRefundRecipientIsReceiverNotAttacker"] },
    { id: "CALLBACK", invariant: "adapter callback cannot bypass endpoint compose guard", tests: ["test_adapterCallbackCannotReenterEndpointGuardedCompose"] },
    { id: "RECOVERABLE", invariant: "distinguish attacker extra value from grief/subsidy loss", tests: ["test_noResidueAttackerRecoverableExtraIsZero_receiverLossIsGriefOrSubsidy", "test_wholeBalanceCanAttributePriorRoundedOutputToNextBeneficiary"] },
    { id: "DIFFERENTIAL", invariant: "modeled profile versus minimum/funding/subsidy reference", tests: ["testFuzz_differentialSequenceSharedLossVersusSafeReference"] },
  ].map((x) => ({ ...x, result: "PASS" }));
}

function main() {
  const generatedAt = new Date().toISOString();
  const scannerSha256 = hashFile(SCANNER).sha256;
  const selection = JSON.parse(fs.readFileSync(abs(SELECTION), "utf8"));
  const step3 = JSON.parse(fs.readFileSync(abs(STEP3), "utf8"));
  const step4 = JSON.parse(fs.readFileSync(abs(STEP4), "utf8"));
  if (selection.selectedSurface?.name !== "permissionless-small-notional-destination-fee-amplification") throw new Error("selection mismatch");
  if (step3.revision !== "behype-fee-refund-delivery-invariant-step3-r1") throw new Error("Step 3 mismatch");
  if (step4.revision !== "behype-staker-layerzero-binding-step4-reviewer-r2") throw new Error("Step 4 mismatch");
  if (git(["cat-file", "-t", SOURCE_COMMIT]).trim() !== "commit") throw new Error("source commit unavailable");

  const sources = SOURCE_FILES.map((file) => { const text = sourceAt(file); return { path: file, gitBlob: gitBlob(file), bytes: Buffer.byteLength(text), sha256: sha(text) }; });
  const moduleSource = sourceAt(SOURCE_FILES[0]);
  const interfaceSource = sourceAt(SOURCE_FILES[1]);
  const exactSourceFacts = {
    cashModuleSourceExactAtCommit: moduleSource.includes("contract BeHYPEStakeModule") && moduleSource.includes("staker.quoteStake(amountToStake, safe)"),
    cashModuleForwardsOnlyQuotedSourceValue: moduleSource.includes("values[1] = quotedFee") && moduleSource.includes("IL2BeHYPEOAppStaker.stake.selector, amountToStake, safe"),
    cashModuleRefundsOnlyCurrentCallExcess: moduleSource.includes("msg.value - quotedFee") && moduleSource.includes("_refundExcessFee(msg.sender, excessFee)"),
    interfaceExposesPublicShapeWithoutMinimumMetadata: interfaceSource.includes("quoteStake(uint256 hypeAmountIn, address receiver)") && interfaceSource.includes("stake(uint256 hypeAmountIn, address receiver) external payable"),
  };
  if (Object.values(exactSourceFacts).some((x) => x !== true)) throw new Error("exact source fact mismatch");

  const exactBodiesPresent = [
    "targets/cash-v3/src/L2BeHYPEOAppStaker.sol",
    "targets/cash-v3/src/L1BeHYPEOAppStaker.sol",
    "targets/cash-v3/src/staker/L2BeHYPEOAppStaker.sol",
    "targets/cash-v3/src/staker/L1BeHYPEOAppStaker.sol",
  ].filter((x) => fs.existsSync(abs(x)));
  if (exactBodiesPresent.length) throw new Error(`unexpected exact staker body path: ${exactBodiesPresent.join(",")}`);

  const l2Build = step4.sourceBuilds.contracts.find((x) => x.contractName === "L2BeHYPEOAppStaker");
  const l1Build = step4.sourceBuilds.contracts.find((x) => x.contractName === "L1BeHYPEOAppStaker");
  const artifactAttestedFacts = {
    predecessorReportedL2ExactBuildRuntime: l2Build?.exactRuntime === true,
    predecessorReportedDestinationExactBuildRuntime: l1Build?.exactRuntime === true,
    publicStakeNoCallerAllowlist: step4.sourceSemantics.l2.publicStakeNoCallerAllowlist === true,
    dustSilentlyRemoved: step4.sourceSemantics.l2.dustSilentlyRemoved === true,
    callerSuppliesWhype: step4.sourceSemantics.l2.whypeTransferFromCaller === true,
    destinationWholeBalanceNotDelta: step4.sourceSemantics.destination.entireBehypeBalanceNotDelta === true,
    destinationNativeFeePaidFromReceiver: step4.sourceSemantics.destination.nativeFeePaidFromReceiverBalance === true,
    outboundRefundRecipientSelf: step4.sourceSemantics.destination.outboundRefundRecipientSelf === true,
    endpointAndAdapterComposeGuards: step4.sourceSemantics.destination.endpointAndWhypeAdapterComposeGuards === true,
    queueRetryMessageBound: step4.publicValuePaths.endpointComposeRetryPermissionlessButQueueAndMessageHashBound === true,
  };
  if (Object.values(artifactAttestedFacts).some((x) => x !== true)) throw new Error("artifact-attested fact mismatch");

  const sol = fs.readFileSync(abs(SOL_TEST), "utf8");
  if (/create(?:Select)?Fork|fork-url|rpc_endpoints|graphql_endpoints|eth_call|broadcast|startBroadcast|https?:\/\//.test(sol)) throw new Error("forbidden external primitive in harness");
  const functions = testFunctions(sol);
  const matrix = testMatrix();
  const required = [...new Set(matrix.flatMap((x) => x.tests))];
  const missingSourceTests = required.filter((x) => !functions.includes(x));
  if (missingSourceTests.length) throw new Error(`matrix tests missing: ${missingSourceTests.join(",")}`);

  const work = prepareWorktree();
  let build, first, replay;
  try {
    build = forge(work.work, ["build", "--root", work.work, "--out", work.out, "--cache-path", work.cache, "--no-cache", "--offline"]);
    if (build.status !== 0) throw new Error(`offline build failed: ${sanitize(build.output.slice(-4000))}`);
    const args = ["test", "--root", work.work, "--out", work.out, "--cache-path", work.cache, "--match-path", `test/critical/${path.basename(SOL_TEST)}`, "--fuzz-runs", String(FUZZ_RUNS), "--fuzz-seed", FUZZ_SEED, "--no-cache", "--offline", "-vv"];
    first = forge(work.work, args);
    if (first.status !== 0) throw new Error(`first test failed: ${sanitize(first.output.slice(-6000))}`);
    replay = forge(work.work, args);
    if (replay.status !== 0) throw new Error(`replay test failed: ${sanitize(replay.output.slice(-6000))}`);
  } finally {
    cleanup(work.temp, work.work);
  }

  const firstRows = passRows(first.output);
  const replayRows = passRows(replay.output);
  if (JSON.stringify(firstRows) !== JSON.stringify(replayRows)) throw new Error("fixed-seed semantic replay mismatch");
  const names = firstRows.map((x) => x.name);
  if (functions.length !== names.length || functions.some((x) => !names.includes(x))) throw new Error(`test enumeration mismatch source=${functions.length} pass=${names.length}`);
  const fuzzRows = firstRows.filter((x) => x.name.startsWith("testFuzz_"));
  if (fuzzRows.length !== 2 || fuzzRows.some((x) => x.fuzzRuns !== FUZZ_RUNS)) throw new Error("fuzz count mismatch");
  const deterministic = firstRows.filter((x) => x.fuzzRuns === 1).length;

  const modelAssumptions = [
    "The model permits zero and sub-1e12 stake requests; production minimum/zero behavior is unbound.",
    "The model charges a configurable return fee even for rounded-zero output; production OFT zero-amount behavior is unbound.",
    "The model has no per-caller rate limit, aggregate cap, or subsidy ledger; production absence of those controls is unproven without source bodies/storage review.",
    "The model uses 1:1 synchronous destination staking and simplified token/OFT behavior.",
    "The model endpoint provides per-guid exactly-once delivery and atomic rollback; only queue/message-hash binding is artifact-attested for production.",
    "The model treats the source quote as source-only and forwards zero destination funding, consistent with retained flow statements but not a fresh production execution.",
  ];
  const sourceConfidence = {
    exactReviewedSource: { confidence: "HIGH", scope: "Cash BeHYPEStakeModule, interface, ModuleBase, ModuleCheckBalance, EtherFiSafe at pinned source commit", deploymentEquivalence: "Cash module equivalence inherited from reviewed Step 3" },
    predecessorSourceRuntimeAttestation: { confidence: "MEDIUM", scope: "L2 staker and destination receiver semantics/build hashes retained by Step 4", limitation: "source bodies and standard-json inputs are not persisted locally, so this run cannot independently recompile or inspect all guards/minimums" },
    interfaceAbiArtifactFacts: { confidence: "MEDIUM", scope: "public function shape, reported ABI names, fixed addresses/hashes and retained flow fields", limitation: "ABI/runtime hashes do not establish omitted internal controls" },
    localModel: { confidence: "MODEL-ONLY", scope: "falsifiable amplification, retry, rounding, refund, callback and differential behavior", deploymentEquivalence: false },
  };

  const classification = "WATCH/MODEL-PRIMITIVE-CANDIDATE/PERMISSIONLESS-SHARED-DESTINATION-FEE-DEPLETION/PRODUCTION-BINDINGS-INCOMPLETE";
  const runId = `etherfi-behype-destination-fee-amplification-step1-${SOURCE_COMMIT.slice(0, 12)}-${scannerSha256.slice(0, 12)}`;
  const blockers = [
    "Exact production L2BeHYPEOAppStaker.sol and L1BeHYPEOAppStaker.sol bodies are absent locally; production zero/minimum checks and all rate/cap/subsidy controls are unknown.",
    "Production WHYPE/beHYPE OFT adapter source/build equivalence is not local; rounded-zero send acceptance, exact quote behavior, refund behavior, and failure semantics remain unbound.",
    "Production endpoint retry is only artifact-attested as queue/message-hash bound; exact failed-compose rollback and retry duplication behavior is not locally source-proven.",
    "The model proves no native payout to the attacker and no extra recoverable value without pre-existing whole-balance residue; the selected fee debit is grief or implicit subsidy consumption unless separate economics establishes attacker benefit.",
    "No current-state balance, accepted minimum, quote, rate, cap, subsidy policy, repeated loss amount, or economics was queried in this local-only run.",
  ];
  const nextGate = "Independent reviewer must first approve the model/source-confidence split. Then obtain exact production staker/receiver/OFT source bodies or equivalent reproducible standard-json locally and prove accepted minimum, fee attribution, rate/cap/subsidy controls, rounded-zero behavior, and retry semantics. No RPC/fork/economics until those source bindings establish a production-relevant invariant violation.";
  const result = {
    schemaVersion: 1, revision: REVISION, runId, generatedAt, scanner: SCANNER, agentId: AGENT, role: "critical-research", step: 1,
    classification, signal: "🟠 WATCH — LOCAL MODEL PRIMITIVE CANDIDATE; PRODUCTION BINDINGS INCOMPLETE",
    pipeline: { stage: 0, totalStages: 5, primitiveEstablishedForProduction: false },
    routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    safety: { localOnly: true, rpcUsed: false, endpointInventoryRead: false, graphqlInventoryRead: false, webUsed: false, envFilesRead: false, privateKeysRead: false, deployedCalls: false, realValueUsed: false, forkCreated: false, liveMutation: false, broadcast: false, signingUsed: false, economicsAttempted: false },
    predecessors: [SELECTION, STEP3, STEP4].map((p) => ({ ...hashFile(p), runId: JSON.parse(fs.readFileSync(abs(p), "utf8")).runId || null })),
    exactSource: { commit: SOURCE_COMMIT, files: sources, exactBodiesPresent, facts: exactSourceFacts },
    artifactAttested: { sourceBodiesRetainedLocally: false, facts: artifactAttestedFacts, l2RuntimeKeccak256: step4.currentBindings.l2Staker.implementationRuntimeKeccak256, destinationRuntimeKeccak256: step4.currentBindings.destinationReceiver.implementationRuntimeKeccak256, amountNormalization: step4.flow.source.amountWithoutDustExpression, dustConversionRate: step4.flow.destination.dustConversionRate, retryStateOwner: step4.flow.destination.retryStateOwnedBy },
    sourceConfidence, modelAssumptions,
    localHarness: { productionDeploymentEquivalence: false, exactCashModuleImportedIntoModel: false, interfaceLevelTwoStageModel: true, vulnerableHypothesisProfile: true, safeReferencePolicy: true, endpointExactlyOnceModel: true, wholeBalanceAndRoundingModeled: true, refundAndCallbackModeled: true },
    foundry: { compiler: "0.8.28", optimizer: true, optimizerRuns: 0, evmVersion: "cancun", offline: true, build: { exitStatus: build.status, outputBytes: build.outputBytes, outputSha256: build.outputSha256 }, firstRun: { exitStatus: first.status, outputBytes: first.outputBytes, outputSha256: first.outputSha256 }, replayRun: { exitStatus: replay.status, outputBytes: replay.outputBytes, outputSha256: replay.outputSha256 }, fuzzSeed: FUZZ_SEED, fuzzRunsPerFuzzTest: FUZZ_RUNS, semanticReplayEqual: true },
    tests: { sourceFunctionCount: functions.length, passedFunctionCount: firstRows.length, deterministicTestCount: deterministic, fuzzTestCount: fuzzRows.length, fuzzCaseCount: fuzzRows.reduce((n, x) => n + x.fuzzRuns, 0), totalExecutedCases: deterministic + fuzzRows.reduce((n, x) => n + x.fuzzRuns, 0), passRows: firstRows, invariantMatrix: matrix },
    modeledResults: {
      sharedDestinationFeeInvariantViolatedInHypothesisProfile: true,
      zeroAndSubUnitAcceptedInHypothesisProfile: true,
      repeatedUniqueCallsLinearlyDepleteReceiverInHypothesisProfile: true,
      quoteDriftAbsorbedByReceiverInHypothesisProfile: true,
      wholeBalanceCanTransferPriorRoundedResidueInHypothesisProfile: true,
      failedAttemptAtomicAndSuccessfulRetryExactlyOnceInEndpointModel: true,
      refundReturnsToReceiverInModel: true,
      adapterDirectCallbackBlockedByEndpointGuardInModel: true,
      attackerNativePayoutInModel: false,
      attackerExtraRecoverableValueWithoutPriorResidueWei: "0",
      feeDebitWithoutPriorResidueClassification: "grief-or-implicit-subsidy-consumption",
      safeReferenceRejectsUnfundedFeeWithoutSubsidy: true,
    },
    findings: { modelPrimitiveCandidatePendingReviewer: true, exactProductionInvariantViolationEstablished: false, productionPermissionlessLossEstablished: false, productionAttackerProfitEstablished: false, routePositive: 0 },
    blockers, nextGate,
  };
  writeOwned(RAW, JSON.stringify(result, null, 2) + "\n");

  const confidenceRows = Object.entries(sourceConfidence).map(([k, v]) => `| ${k} | ${v.confidence} | ${v.scope} | ${v.limitation || (v.deploymentEquivalence === false ? "deploymentEquivalence=false" : v.deploymentEquivalence)} |`).join("\n");
  const matrixRows = matrix.map((x) => `| ${x.id} | ${x.invariant} | ${x.tests.join(", ")} | ${x.result} |`).join("\n");
  const report = `# ${result.signal} — EtherFi BeHYPE destination-fee amplification Step 1\n\n**Classification:** \`${classification}\`  \n**Run:** \`${runId}\`  \n**Pipeline:** \`0/5\` — production exploit primitive not established  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n> A bounded interface-level model exhibits permissionless shared destination-native fee depletion when zero/minimal stakes are accepted, destination fees are paid from receiver reserves, and no minimum/rate/cap/subsidy ledger exists. Those decisive controls are not proven for production because exact staker/receiver/OFT source bodies are absent locally. This is a model primitive candidate pending review, not a deployed exploit or route-positive result.\n\n## Source-confidence split\n\n| Evidence class | Confidence | Scope | Limitation |\n|---|---|---|---|\n${confidenceRows}\n\nExact reviewed Cash-module source proves that the module quotes the immutable staker, forwards that quote through the Safe, and refunds only current-call excess. The exact local interface exposes \`quoteStake(uint256,address)\` and payable \`stake(uint256,address)\`, but an interface cannot prove minimums or internal fee attribution. Step 4 retained exact-build/runtime attestations and semantic facts for the staker/receiver; this run treats those as predecessor artifact facts because their source bodies were not persisted.\n\n## Local differential result\n\nThe vulnerable hypothesis profile removes dust at \`1e12\`, permits zero/sub-unit requests, forwards no destination fee, lets the destination receiver pay the current return quote, and has no rate/cap/subsidy ledger. It violates the reference policy requiring caller destination funding or an explicit bounded subsidy. Repeated unique messages linearly debit receiver native balance. The model produces no attacker native payout and no extra recoverable value without prior whole-balance residue, so the fee loss is grief or implicit subsidy consumption unless separate production economics proves benefit.\n\n| Gate | Invariant | Tests | Result |\n|---|---|---|---|\n${matrixRows}\n\n## Failure, retry, refund, and callback\n\n- Failed model delivery atomically rolls back staking, output, and receiver fee; a later successful retry executes once and duplicate delivery is rejected by endpoint state. Production equivalence is not claimed.\n- Return-adapter overquote refunds go to the receiver in the model, matching the retained self-refund fact.\n- A direct adapter callback cannot satisfy the endpoint caller guard in the model. Trusted-adapter internal behavior and all production callbacks remain source-open.\n- Whole-balance send can attribute prior rounded output to the next beneficiary; this reproduces the previously reviewed residue surface and is not promoted as a new finding.\n\n## Missing production bindings\n\n${blockers.map((x) => `- ${x}`).join("\n")}\n\n## Defensive mitigation if production confirms the profile\n\nRequire an economically meaningful post-rounding minimum; include the destination return fee in the source quote and deliver call-attributed funding; alternatively enforce an explicit per-call/per-period subsidy quota. Debit only per-call output deltas, preserve exactly-once message state, and emit source/destination fee attribution.\n\n**nextGate:** ${nextGate}\n`;
  writeOwned(REPORT, report);
  const inbox = { findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pipeline: "0/5", summary: "Interface-level model exhibits shared destination-fee depletion under unproven no-minimum/no-cap assumptions; production primitive, loss, and profit remain unestablished.", sourceConfidence, testCounts: result.tests, modeledResults: result.modeledResults, findings: result.findings, blockers, artifacts: [SOL_TEST, SCANNER, VALIDATOR, RAW, MANIFEST, REPORT], nextAction: nextGate };
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# EtherFi BeHYPE destination-fee amplification Step 1 handoff\n\n- Run \`${runId}\`; classification \`${classification}\`; pipeline remains \`0/5\`.\n- ${firstRows.length}/${functions.length} functions passed, including ${fuzzRows.length} fuzz tests / ${fuzzRows.reduce((n, x) => n + x.fuzzRuns, 0)} fixed-seed cases; semantic replay matched.\n- The interface-level vulnerable profile exhibits zero/sub-unit and repeated unique-call shared receiver fee depletion, but zero/minimum/rate/cap/subsidy and rounded-zero production behavior are unbound.\n- Exact reviewed Cash module/interface facts are separated from Step 4 artifact-attested staker/receiver facts and explicit model assumptions; no deployment equivalence is claimed.\n- Failed/retry exactly-once, self refund, endpoint callback guard, quote drift, whole balance, grief-only versus recoverable value, and safe-reference differential were covered locally.\n- No attacker native payout or extra value without prior residue appears in the model; fee loss is grief or implicit subsidy consumption absent separate economics.\n- Gates remain \`0/0/false\`, \`fork=false\`; no RPC/inventory/web/live/fork/economics/signing/state activity.\n- Next: ${nextGate}\n`);
  const records = [SCANNER, VALIDATOR, SOL_TEST, RAW, REPORT, INBOX, HANDOFF, SELECTION, STEP3, STEP4, "targets/cash-v3/src/modules/hype/BeHYPEStakeModule.sol", "targets/cash-v3/src/interfaces/IL2BeHYPEOAppStaker.sol"].map(hashFile);
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, algorithm: "sha256", classification, pipeline: "0/5", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, localOnly: true, noRpcInventoryWebForkLive: true, sourceCommit: SOURCE_COMMIT, exactStakerReceiverSourceBodiesPresent: false, productionDeploymentEquivalence: false, modelPrimitiveCandidatePendingReviewer: true, exactProductionInvariantViolationEstablished: false, passedFunctionCount: firstRows.length, deterministicTestCount: deterministic, fuzzTestCount: fuzzRows.length, fuzzCaseCount: result.tests.fuzzCaseCount, fuzzSeed: FUZZ_SEED, semanticReplayEqual: true, records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, revision: REVISION, classification, pipeline: "0/5", tests: result.tests, sourceConfidence, modeledResults: result.modeledResults, blockers, gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, artifacts: [SOL_TEST, SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF], manifestAggregateSha256: aggregateSha256, nextGate }) + "\n");
}

try { main(); } catch (e) { process.stderr.write(`scan failed: ${sanitize(e?.message || e)}\n`); process.exitCode = 1; }
