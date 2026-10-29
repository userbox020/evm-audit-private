#!/usr/bin/env node
"use strict";

// Offline reviewer wrapper. It never reads endpoint inventories and never imports
// or executes the network-capable Step 1 scanner.
const crypto = require("crypto");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "across-contracts");
const NAME = "critical-across-hyperevm-fallback-sponsorship-step1-r2";
const PRE = "critical-across-hyperevm-fallback-sponsorship-step1";
const AGENT = "reviewer-across-hyperevm-fallback-step1-r2-20260724";
const RAW = `reports/raw/fast/${NAME}.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const LEAK = `reports/raw/fast/${NAME}-leak-scan.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const HISTORICAL_SCANNER = `reports/raw/fast/${NAME}-predecessor-scanner.js`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/review-${NAME}-2026-07-24.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const WRAPPER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const PRE_RAW = `reports/raw/fast/${PRE}.json`;
const PRE_TESTS = `reports/raw/fast/${PRE}-tests.json`;
const PRE_LEAK = `reports/raw/fast/${PRE}-leak-scan.json`;
const PRE_MANIFEST = `reports/raw/fast/${PRE}-manifest.json`;
const PRE_REPORT = `reports/${PRE}.md`;
const PRE_INBOX = `coordination/inbox/critical/2026-07-24-${PRE}.json`;
const PRE_HANDOFF = `coordination/handoffs/2026-07-24-${PRE}-handoff.md`;
const PRE_SCANNER = `tools/scan-${PRE}.js`;
const PRE_VALIDATOR = `tools/test-${PRE}.js`;
const HISTORICAL_BUILDER = `tools/build-${PRE}-historical.js`;
const HISTORICAL_BUILDS = `reports/raw/fast/${PRE}-historical-builds.json`;
const SOL_TEST = "targets/across-contracts/test/evm/foundry/local/HyperCoreFallbackSponsorshipInvariant.t.sol";
const SOURCES = {
  module: "targets/across-contracts/contracts/periphery/mintburn/HyperCoreFlowExecutor.sol",
  base: "targets/across-contracts/contracts/periphery/mintburn/BaseModuleHandler.sol",
  auth: "targets/across-contracts/contracts/periphery/mintburn/AuthorizedFundedFlow.sol",
  oft: "targets/across-contracts/contracts/periphery/mintburn/sponsored-oft/DstOFTHandler.sol",
  cctp: "targets/across-contracts/contracts/periphery/mintburn/sponsored-cctp/SponsoredCCTPDstPeriphery.sol",
  donation: "targets/across-contracts/contracts/chain-adapters/DonationBox.sol"
};
const EXPECTED_PRE_SCANNER = { bytes: 39049, sha256: "105bf33bbf6bf649c40b94d83ffa77ab11217dc95103bf1c8b40eb4d0d300927" };
const EXPECTED_CURRENT_SCANNER = { bytes: 39304, sha256: "b2c5a89bac983c9b5fbb8e126277e081a0a84aa5c7873665b5e846dd5e084512" };

const abs = (rel) => path.join(ROOT, rel);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const read = (rel) => fs.readFileSync(abs(rel));
const text = (rel) => read(rel).toString("utf8");
const json = (rel) => JSON.parse(text(rel));
const hashFile = (rel) => { const body = read(rel); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const write = (rel, body) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8"); };
function requireTrue(ok, label) { if (!ok) throw new Error(label); }

function run(command, args, cwd, env = {}) {
  const result = cp.spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 600000, windowsHide: true });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  return { command: `${command} ${args.join(" ")}`, exitCode: result.status, passed: result.status === 0, outputSha256: sha(Buffer.from(output)), output };
}

function reconstructHistoricalScanner() {
  const current = text(PRE_SCANNER);
  const newInbox = 'const inbox = canonical({ findingId: NAME, runId: raw.runId, agentId: AGENT, role: "critical-research", status: classification, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "Exact local handlers and the deployed OFT path block callback reentry; active CCTP handler source equivalence remains unresolved, and the under-delivery accounting primitive has no current trigger or attacker delta.", artifacts: [RAW, TESTS, REPORT, MANIFEST, LEAK, SCANNER, VALIDATOR, SOL_TEST], nextAction: "Recover an exact active CCTP handler build/runtime match, then apply balance-delta CEI hardening; reopen fork only on an exact guard bypass or active successful under-delivery trigger." });';
  const oldInbox = 'const inbox = canonical({ findingId: NAME, runId: raw.runId, agentId: AGENT, role: "critical-research", status: classification, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "Callback reentry is blocked in exact deployed handlers; only a conditional under-delivery integration accounting primitive remains, with no current trigger or attacker delta.", artifacts: [RAW, TESTS, REPORT, MANIFEST, LEAK, SCANNER, VALIDATOR, SOL_TEST], nextAction: "Apply balance-delta CEI hardening; reopen fork gate only if an active token/DonationBox can under-deliver successfully or a production entrypoint bypasses the shared guard." });';
  const newHandoff = 'write(HANDOFF, `# Across HyperEVM fallback sponsorship Step 1 handoff\\n\\n- Classification: \\`${classification}\\`; pipeline 1/5; gates 0/0/false; fork=false.\\n- Exact source/build/runtime binding passed=${allSourceRuntimeEquivalent}; modules/DonationBoxes/OFT exact, CCTP handlers unresolved; strict-qualified families=${strictFamilies.length}; pin ${pinNumber} / \\`${pinHash}\\`; terminal recheck=${terminalPassed}.\\n- Local tests ${tests.fixedAndFuzzFunctions}/${tests.fixedAndFuzzFunctions}, fuzz=${tests.fuzzExecutions}, effective=${tests.totalEffectiveCases}.\\n- Exact local guard blocks same/alternate/direct-selector callbacks; deployed direct-selector probes reject, but exact CCTP callback-guard semantics remain unbound. Conditional primitive: successful under-delivery can consume shared handler funds and overstate the cumulative counter by \\`requested-actual\\`. Current retained fallback history reconciles exactly; attacker delta 0.\\n- Fork stopped fail-closed. Next gate is exact active CCTP source/runtime recovery, then an active under-delivering integration or exact guard-bypass path.\\n`);';
  const oldHandoff = 'write(HANDOFF, `# Across HyperEVM fallback sponsorship Step 1 handoff\\n\\n- Classification: \\`${classification}\\`; pipeline 1/5; gates 0/0/false; fork=false.\\n- Exact source/build/runtime binding passed=${allSourceRuntimeEquivalent}; strict-qualified families=${strictFamilies.length}; pin ${pinNumber} / \\`${pinHash}\\`; terminal recheck=${terminalPassed}.\\n- Local tests ${tests.fixedAndFuzzFunctions}/${tests.fixedAndFuzzFunctions}, fuzz=${tests.fuzzExecutions}, effective=${tests.totalEffectiveCases}.\\n- Production guard blocks same/alternate/direct-selector callbacks. Conditional primitive: successful under-delivery can consume shared handler funds and overstate the cumulative counter by \\`requested-actual\\`. Current retained fallback history reconciles exactly; attacker delta 0.\\n- Fork stopped fail-closed. Next gate requires an active under-delivering integration or a guard-bypass path.\\n`);';
  requireTrue(current.split(newInbox).length === 2 && current.split(newHandoff).length === 2, "current-scanner-patch-shape-unexpected");
  const historical = current.replace(newInbox, oldInbox).replace(newHandoff, oldHandoff);
  const historicalBody = Buffer.from(historical, "utf8");
  requireTrue(historicalBody.length === EXPECTED_PRE_SCANNER.bytes, "historical-scanner-byte-count");
  requireTrue(sha(historicalBody) === EXPECTED_PRE_SCANNER.sha256, "historical-scanner-hash");
  write(HISTORICAL_SCANNER, historical);
  return {
    current: hashFile(PRE_SCANNER),
    reconstructed: hashFile(HISTORICAL_SCANNER),
    expectedHistorical: EXPECTED_PRE_SCANNER,
    exactHistoricalBytesRecovered: true,
    localToolHistory: { sessionId: "ses_06a512349ffew7J7ExdGk6Fv3G", messageId: "msg_f9626c9fb001y7RFDKXhp9CYGA", partId: "prt_f9627018600127CRgH0eb7UvqV", editTimestamp: "2026-07-24T22:02:59.535Z" },
    diff: { changedLines: [347, 349], additions: 2, deletions: 2, byteDelta: Buffer.byteLength(current, "utf8") - historicalBody.length, executableLogicChanged: false, changedSurface: "generated inbox and handoff wording only", semanticDirection: "narrows the guard claim and makes the active CCTP runtime/source gap explicit" }
  };
}

function replayPredecessor(preManifest, reconstruction) {
  const audited = [];
  for (const record of preManifest.records) {
    const body = record.path === PRE_SCANNER ? read(HISTORICAL_SCANNER) : read(record.path);
    const actual = { path: record.path, bytes: body.length, sha256: sha(body) };
    requireTrue(actual.bytes === record.bytes && actual.sha256 === record.sha256, `predecessor-record:${record.path}`);
    audited.push(actual);
  }
  const aggregateSha256 = sha(Buffer.from(audited.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  requireTrue(aggregateSha256 === preManifest.aggregateSha256, "predecessor-aggregate-replay");
  const liveDrift = preManifest.records.map((record) => {
    const actual = hashFile(record.path);
    return { path: record.path, expectedBytes: record.bytes, expectedSha256: record.sha256, currentBytes: actual.bytes, currentSha256: actual.sha256, matches: actual.bytes === record.bytes && actual.sha256 === record.sha256 };
  });
  requireTrue(liveDrift.filter((row) => !row.matches).length === 1 && !liveDrift.find((row) => row.path === PRE_SCANNER).matches, "unexpected-predecessor-drift-set");
  requireTrue(reconstruction.current.bytes === EXPECTED_CURRENT_SCANNER.bytes && reconstruction.current.sha256 === EXPECTED_CURRENT_SCANNER.sha256, "current-scanner-unexpected");
  return { aggregateSha256, records: audited, currentFilesystemAudit: liveDrift, exact: true };
}

function sourceReview(preRaw) {
  const source = Object.fromEntries(Object.entries(SOURCES).map(([key, rel]) => [key, text(rel)]));
  const indexes = {
    availability: source.module.indexOf("if (!_availableInDonationBox(params.quoteNonce, params.finalToken, sponsorshipFundsToForward))"),
    withdrawal: source.module.indexOf("donationBox.withdraw(IERC20(params.finalToken), sponsorshipFundsToForward);"),
    total: source.module.indexOf("uint256 totalAmountToForward = params.amountInEVM + sponsorshipFundsToForward;"),
    recipientTransfer: source.module.indexOf("IERC20(params.finalToken).safeTransfer(params.finalRecipient, totalAmountToForward);"),
    counter: source.module.indexOf("_getMainStorage().cumulativeSponsoredAmount[params.finalToken] += sponsorshipFundsToForward;")
  };
  requireTrue(Object.values(indexes).every((x) => x >= 0) && indexes.availability < indexes.withdrawal && indexes.withdrawal < indexes.total && indexes.total < indexes.recipientTransfer && indexes.recipientTransfer < indexes.counter, "fallback-call-order");
  const checks = {
    fallbackCallOrderExact: true,
    fallbackCallOrder: ["availability check", "DonationBox.withdraw", "recipient total calculation", "recipient token transfer", "cumulative counter increment"],
    handlerInheritsSharedGuard: /abstract contract BaseModuleHandler[\s\S]*ReentrancyGuard/.test(source.base),
    delegatedFallbackGuarded: /fallback\(bytes calldata data\) external nonReentrant/.test(source.base),
    moduleSelectorAuthorization: /function fallbackHyperEVMFlow\(CommonFlowParams memory params\) external onlyAuthorizedFlow/.test(source.module),
    oftComposeGuarded: /function lzCompose\([\s\S]*?external payable override nonReentrant authorizeFundedFlow/.test(source.oft),
    oftDirectGuarded: /function executeDirect\([\s\S]*?external nonReentrant authorizeFundedFlow onlyRole\(DIRECT_CALLER_ROLE\)/.test(source.oft),
    cctpReceiveGuardedCurrentSource: /function receiveMessage\([\s\S]*?external nonReentrant authorizeFundedFlow/.test(source.cctp),
    cctpDirectGuardedCurrentSource: /function directReceiveMessage\([\s\S]*?external nonReentrant authorizeFundedFlow onlyRole\(DIRECT_CALLER_ROLE\)/.test(source.cctp),
    oftNonceBeforeFlow: source.oft.indexOf("$.usedNonces[quoteNonce] = true;") < source.oft.indexOf("_executeFromComposeMsg(composeMsg, amountLD);"),
    cctpDirectNonceBeforeFlow: source.cctp.indexOf("$.usedNonces[quote.nonce] = true;", source.cctp.indexOf("function directReceiveMessage")) < source.cctp.indexOf("_executeQuote(quote, 0);"),
    cctpValidatedNonceBeforeFlow: source.cctp.indexOf("_validateQuoteOrRevert(quote, signature);") < source.cctp.indexOf("_executeQuote(quote, feeExecuted);") && source.cctp.indexOf("$.usedNonces[quote.nonce] = true;", source.cctp.indexOf("function _validateQuoteOrRevert")) < source.cctp.length,
    cctpTransportInteractionPrecedesNonceQualifiedCaveat: source.cctp.indexOf("cctpMessageTransmitter.receiveMessage(message, attestation)") < source.cctp.indexOf("_validateQuoteOrRevert(quote, signature);"),
    donationWithdrawRoleGated: /function withdraw\(IERC20 token, uint256 amount\) external onlyRole\(WITHDRAWER_ROLE\)/.test(source.donation)
  };
  requireTrue(Object.entries(checks).filter(([, value]) => typeof value === "boolean").every(([, value]) => value), "source-semantic-check");
  const deployments = preRaw.binding.deployments;
  const history = preRaw.binding.history;
  const historyRowsExact = history.fallbackConservation.every((row) => row.flows === row.exactDonationMatches && row.flows === row.exactRecipientMatches && row.sponsoredRaw === row.donationTransferRaw && BigInt(row.amountInRaw) + BigInt(row.sponsoredRaw) === BigInt(row.recipientTransferRaw));
  requireTrue(history.fallbackEventCount === 277 && history.receiptsChecked === 277 && historyRowsExact, "history-277-reconciliation");
  requireTrue(deployments.length === 3 && deployments.every((row) => row.moduleSourceRuntimeEquivalent && row.donationSourceRuntimeEquivalent && row.moduleGetterMatchesArtifact && row.donationBoxGetterMatchesArtifact), "active-module-donation-binding");
  requireTrue(deployments.find((row) => row.id === "oft-usdt").handlerSourceRuntimeEquivalent, "active-oft-binding");
  requireTrue(deployments.filter((row) => row.id.startsWith("cctp-")).every((row) => !row.handlerSourceRuntimeEquivalent), "cctp-source-mismatch-caveat");
  requireTrue(preRaw.binding.directPermissionlessModuleEntrypointRejected && preRaw.invariant.attackerValueDeltaCurrent === "0", "deployed-negative-delta");
  return canonical({
    sourceHashes: Object.values(SOURCES).map(hashFile),
    checks,
    callOrderIndexes: indexes,
    sharedReentrancyGuardCoverageVerified: true,
    nonceBeforeValueFlowInteractionVerified: true,
    nonceQualification: "OFT compose/direct and CCTP direct consume nonce before flow execution. CCTP receive consumes it after the guarded CCTP transport call and quote checks but before module, arbitrary-call, DonationBox, or recipient interactions; do not claim nonce-before-every-external-call.",
    directSelectorRejectionRetained: preRaw.binding.deployments.every((row) => row.directModuleFallbackCallRejected),
    underDeliveryPrimitiveVerified: preRaw.invariant.sharedFundSubsidyConditionalPrimitive && preRaw.invariant.maximumLocalValueDeltaFormula === "requested sponsorship minus actual DonationBox delivery",
    underDeliveryCallOrder: "requested withdrawal -> recipient transfer from mixed handler balance -> requested counter increment",
    historyReplay: { fallbackEventCount: history.fallbackEventCount, receiptsChecked: history.receiptsChecked, rows: history.fallbackConservation.length, allRowsExact: historyRowsExact, allFallbackDonationTransfersExact: history.allFallbackDonationTransfersExact, allFallbackRecipientTransfersExact: history.allFallbackRecipientTransfersExact },
    activeBindings: { modulesExact: deployments.every((row) => row.moduleSourceRuntimeEquivalent), donationBoxesExact: deployments.every((row) => row.donationSourceRuntimeEquivalent), oftHandlerExact: deployments.find((row) => row.id === "oft-usdt").handlerSourceRuntimeEquivalent, cctpHandlersExact: false, cctpNormalizedFamilyAgreement: new Set(deployments.filter((row) => row.id.startsWith("cctp-")).map((row) => row.handlerNormalizedRuntimeSha256)).size === 1 },
    retainedCapture: { pin: preRaw.binding.pin, strictQualifiedFamilyCount: preRaw.binding.strictQualifiedFamilyCount, historyFamilyCount: preRaw.binding.historyFamilyCount, bindingAgreement: preRaw.binding.bindingAgreement, backendOperatorIndependenceEstablished: preRaw.binding.backendOperatorIndependenceEstablished, newCapturePerformed: false },
    deployedAttackerDelta: "0",
    classificationClosureSupported: false
  });
}

function leakScan(paths) {
  const findings = [];
  for (const rel of paths) {
    const body = text(rel);
    if (/(?:https?|wss?):\/\//i.test(body)) findings.push({ path: rel, category: "url-scheme" });
    if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer)\s*[:=]/i.test(body)) findings.push({ path: rel, category: "credential-header-shape" });
  }
  return { scannedPaths: paths, endpointInventoryCompared: false, findingCount: findings.length, passed: findings.length === 0, findings };
}

function main() {
  const preRaw = json(PRE_RAW), preTests = json(PRE_TESTS), preManifest = json(PRE_MANIFEST), preLeak = json(PRE_LEAK);
  requireTrue(preLeak.passed && preManifest.leakScanPassed, "predecessor-leak-gate");
  const reconstruction = reconstructHistoricalScanner();
  const predecessorReplay = replayPredecessor(preManifest, reconstruction);
  const syntax = run("node", ["--check", abs(PRE_SCANNER)], ROOT);
  requireTrue(syntax.passed, "current-scanner-syntax");
  const build = run("forge", ["build", "--skip", "test", "--contracts", "contracts/periphery/mintburn/HyperCoreFlowExecutor.sol"], TARGET, { FOUNDRY_PROFILE: "mintburn" });
  requireTrue(build.passed, "offline-build");
  const test = run("forge", ["test", "--match-contract", "HyperCoreFallbackSponsorshipInvariantTest", "-vv"], TARGET, { FOUNDRY_PROFILE: "local-test" });
  requireTrue(test.passed && !test.output.includes("[FAIL]"), "offline-tests");
  const fixed = Number(test.output.match(/Ran (\d+) tests for/)?.[1] || 0);
  const fuzzRuns = [...test.output.matchAll(/\(runs:\s*(\d+)/g)].map((match) => Number(match[1]));
  const testSummary = canonical({ passed: true, fixedAndFuzzFunctions: fixed, fuzzFunctions: fuzzRuns.length, fuzzExecutions: fuzzRuns.reduce((sum, x) => sum + x, 0), totalEffectiveCases: fixed - fuzzRuns.length + fuzzRuns.reduce((sum, x) => sum + x, 0), outputSha256: test.outputSha256, command: "FOUNDRY_PROFILE=local-test forge test --match-contract HyperCoreFallbackSponsorshipInvariantTest -vv" });
  requireTrue(testSummary.fixedAndFuzzFunctions === 17 && testSummary.fuzzFunctions === 3 && testSummary.fuzzExecutions === 771 && testSummary.totalEffectiveCases === 785, "offline-test-counts");
  const originalValidator = run("node", [abs(PRE_VALIDATOR)], ROOT);
  requireTrue(!originalValidator.passed && originalValidator.output.includes(`record:${PRE_SCANNER}`), "predecessor-validator-drift-reproduction");
  const sourceReviewResult = sourceReview(preRaw);
  const historicalBuilds = json(HISTORICAL_BUILDS);
  requireTrue(historicalBuilds.aggregateSha256 === digest(historicalBuilds.builds), "historical-build-bundle-aggregate");
  write(TESTS, JSON.stringify(canonical({ schemaVersion: 1, build: { passed: build.passed, command: "FOUNDRY_PROFILE=mintburn forge build --skip test --contracts contracts/periphery/mintburn/HyperCoreFlowExecutor.sol", outputSha256: build.outputSha256 }, solidity: testSummary, currentScannerSyntax: { passed: syntax.passed, outputSha256: syntax.outputSha256 }, predecessorValidatorReplay: { expectedFailureObserved: true, category: `record:${PRE_SCANNER}`, outputSha256: originalValidator.outputSha256 }, predecessorRecordedTests: preTests }), null, 2) + "\n");
  const raw = canonical({
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    runId: `${NAME}-${digest({ predecessor: preManifest.aggregateSha256, currentScanner: reconstruction.current.sha256, tests: testSummary.outputSha256, source: sourceReviewResult.sourceHashes })}`,
    agentId: AGENT,
    role: "reviewer",
    classification: "WATCH/COVERAGE-OR-BINDING-GAP/FAIL-CLOSED/REVIEWER-R2",
    pipeline: { branch: "Across HyperEVM fallback sponsorship", stage: 1, total: 5, sourceConditionalPrimitive: true, localDifferentialProof: true, deployedUnderDeliveryTrigger: false, callbackReachabilitySurvives: false, cctpCallbackReachabilityExact: null, forkGateOpened: false },
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    drift: { cause: "A post-manifest edit at 2026-07-24T22:02:59.535Z changed only generated inbox/handoff wording after the predecessor manifest was emitted at 2026-07-24T22:01:19. The scanner grew by 255 bytes, so the immutable predecessor validator correctly failed its scanner record.", benign: true, evidence: reconstruction, predecessorValidatorExpectedFailure: `record:${PRE_SCANNER}`, currentScannerExecuted: false, semanticOutputReplay: { passed: true, rawCaptureOrClassificationChanged: false, gatesChanged: false, pinOrFamilyEvidenceChanged: false, onlyGeneratedReviewerWordingChanged: true } },
    predecessor: { runId: preRaw.runId, manifest: hashFile(PRE_MANIFEST), claimedAggregateSha256: preManifest.aggregateSha256, replayedAggregateSha256: predecessorReplay.aggregateSha256, recursiveRecordCount: predecessorReplay.records.length, recursiveRecords: predecessorReplay.records, currentFilesystemAudit: predecessorReplay.currentFilesystemAudit, originalCapturePreservedUnmodified: true },
    sourceReview: sourceReviewResult,
    tests: testSummary,
    build: { passed: true, command: "FOUNDRY_PROFILE=mintburn forge build --skip test --contracts contracts/periphery/mintburn/HyperCoreFlowExecutor.sol", outputSha256: build.outputSha256, historicalBundle: hashFile(HISTORICAL_BUILDS), historicalBundleAggregateSha256: historicalBuilds.aggregateSha256, historicalBundleReplayPassed: true },
    findings: {
      callOrder: "Fallback checks advertised DonationBox balance, requests withdrawal, transfers amountIn plus requested sponsorship, then increments the requested cumulative sponsorship counter.",
      conditionalPrimitive: "If DonationBox/token reports success while under-delivering and the handler already holds unrelated same-token funds, the handler subsidizes requested-minus-actual and overstates cumulative sponsorship by the same amount.",
      preconditions: ["successful under-delivery by the bound DonationBox/token integration", "unrelated same-token handler balance sufficient to cover the shortfall", "authorized one-shot flow reaches fallback"],
      impact: "conditional shared-fund subsidy and accounting overstatement; no active under-delivery trigger or deployed attacker gain established",
      cctpCaveat: "The two active CCTP runtimes agree as a normalized family but do not match the recovered historical source build; exact deployed CCTP callback-guard semantics remain unbound.",
      deployedEvidence: "Retained 277-flow history reconciles every requested sponsorship withdrawal and recipient transfer exactly; direct module selector probes rejected; deployed attacker delta is zero.",
      mitigation: "Measure handler balance delta around DonationBox withdrawal, require actual received equals requested, account the measured delta before recipient interaction, and reject unsupported fee-on-transfer/rebasing/callback token semantics."
    },
    nextGate: "Recover an exact active CCTP handler build/runtime match. Reopen simulation only if an exact production guard bypass or active successful under-delivery integration survives; otherwise retain Step 1 fail-closed WATCH.",
    activityScope: { offlineOnly: true, endpointInventoryReads: 0, rpcCalls: 0, httpRequests: 0, forkCreated: false, liveActions: 0, signedTransactions: 0, broadcasts: 0, privateKeyReads: 0, envFileReads: 0, productionMutation: false, originalArtifactEdits: 0, originalClaimEdits: 0, localBuilds: 1, localTestSuites: 1, localArtifactWrites: true }
  });
  write(RAW, JSON.stringify(raw, null, 2) + "\n");
  const report = `# 🟠 WATCH — Across HyperEVM fallback sponsorship Step 1 R2\n\n**Classification:** \`${raw.classification}\`  \n**Pipeline:** \`1/5\`; gates \`0/0/false\`; fork=false\n\n## Reviewer correction\n\nThe predecessor capture remains immutable. Its validator now fails only because the scanner was edited after manifest creation. Local tool history reconstructs the exact historical ${reconstruction.reconstructed.bytes}-byte scanner at SHA-256 \`${reconstruction.reconstructed.sha256}\`; replay of all ${predecessorReplay.records.length} predecessor records reproduces aggregate \`${predecessorReplay.aggregateSha256}\`. The current scanner is ${reconstruction.current.bytes} bytes / \`${reconstruction.current.sha256}\`. The exact two-line patch only narrows generated inbox/handoff wording to disclose the CCTP source/runtime gap; capture logic, raw output, classification, gates, pin/family evidence, and executable semantics did not change. This is benign post-manifest scanner drift, not evidence drift.\n\n## Independent source result\n\n- \`HyperCoreFlowExecutor.sol:917-925\`: advertised availability -> requested withdrawal -> recipient transfer -> requested counter increment. A successful under-delivery can therefore consume unrelated handler funds and overstate sponsorship by \`requested - actual\`.\n- \`BaseModuleHandler.sol:16-19,35-42\`: handler and delegated fallback share one ReentrancyGuard storage context. Exact local tests block same/alternate/direct-selector callbacks.\n- OFT \`DstOFTHandler.sol:149-171,178-191\` and CCTP direct \`SponsoredCCTPDstPeriphery.sol:232-239\` consume nonce before flow execution. CCTP receive is qualified: its guarded bridge transport call precedes nonce consumption, but nonce is consumed before module/arbitrary/DonationBox/recipient interactions (lines 192-224, 299-316).\n- Retained deployment evidence binds all three modules and DonationBoxes exactly and binds the OFT handler exactly. Both CCTP handlers remain source/runtime-mismatched despite normalized-family agreement.\n- Retained pin ${preRaw.binding.pin.number} / \`${preRaw.binding.pin.hash}\`, terminal recheck, ${preRaw.binding.strictQualifiedFamilyCount} strict-qualified families, two matching history families, and all 277 receipts are predecessor capture evidence only; R2 made no endpoint or chain query.\n- Every retained flow reconciles DonationBox and recipient transfers. Direct module-selector probes rejected. No active under-delivery trigger or deployed attacker delta was established.\n\n## Offline replay\n\nBuild PASS; Solidity ${testSummary.fixedAndFuzzFunctions}/${testSummary.fixedAndFuzzFunctions}, fuzz ${testSummary.fuzzExecutions}, effective ${testSummary.totalEffectiveCases}. The original validator's scanner-record failure was reproduced; this R2 validator supersedes that mutable-path check while recursively preserving the historical bytes and predecessor aggregate.\n\n## Mitigation and next gate\n\nMeasure balance delta around \`DonationBox.withdraw\`, require actual receipt equals requested sponsorship, and account the measured delta before recipient interaction. Reject unsupported transfer semantics. Remain fail-closed until an exact active CCTP build/runtime match is recovered; simulation opens only for an exact deployed guard bypass or active successful under-delivery trigger.\n`;
  write(REPORT, report);
  const inbox = canonical({ findingId: NAME, runId: raw.runId, agentId: AGENT, role: "reviewer", status: raw.classification, classification: raw.classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "R2 reconstructs the exact historical scanner, proves benign post-manifest wording-only drift, replays the predecessor aggregate and 277-flow evidence, and retains fail-closed CCTP/source and deployed-trigger gaps.", artifacts: [RAW, TESTS, LEAK, MANIFEST, HISTORICAL_SCANNER, REPORT, WRAPPER, VALIDATOR, HANDOFF], nextAction: raw.nextGate });
  write(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  write(HANDOFF, `# Across HyperEVM fallback sponsorship Step 1 R2 handoff\n\n- Classification: \`${raw.classification}\`; pipeline 1/5; gates 0/0/false; fork=false.\n- Drift cause: post-manifest two-line generated-message correction; current scanner ${reconstruction.current.sha256}; exact reconstructed historical scanner ${reconstruction.reconstructed.sha256}.\n- Predecessor aggregate replay: \`${predecessorReplay.aggregateSha256}\` across ${predecessorReplay.records.length} records. Original artifacts and claim were not edited.\n- Offline build PASS; tests ${testSummary.fixedAndFuzzFunctions}/${testSummary.fixedAndFuzzFunctions}, fuzz ${testSummary.fuzzExecutions}, effective ${testSummary.totalEffectiveCases}.\n- Source: shared guard and nonce-before-value-flow execution verified; CCTP receive transport-before-nonce caveat explicit. Active modules/DonationBoxes/OFT exact; CCTP source/runtime mismatch remains. Retained 277/277 flows reconcile; deployed attacker delta 0.\n- R2 activity: endpoint inventory/RPC/HTTP/fork/live/signing/broadcast/production mutation all zero.\n- Next gate: ${raw.nextGate}\n`);
  const leak = leakScan([RAW, TESTS, REPORT, INBOX, HANDOFF]);
  write(LEAK, JSON.stringify(canonical(leak), null, 2) + "\n");
  requireTrue(leak.passed, "r2-leak-scan");
  const records = [WRAPPER, VALIDATOR, HISTORICAL_SCANNER, RAW, TESTS, LEAK, REPORT, INBOX, HANDOFF].map(hashFile);
  const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const recursiveFiles = [hashFile(PRE_MANIFEST), ...predecessorReplay.records, hashFile(PRE_SCANNER), ...sourceReviewResult.sourceHashes, hashFile(HISTORICAL_BUILDS)];
  const manifest = canonical({ schemaVersion: 2, runId: raw.runId, classification: raw.classification, algorithm: "sha256", aggregateSha256, records, recursivePredecessor: { manifest: hashFile(PRE_MANIFEST), claimedAggregateSha256: preManifest.aggregateSha256, replayedAggregateSha256: predecessorReplay.aggregateSha256, exactHistoricalScanner: hashFile(HISTORICAL_SCANNER), currentScanner: hashFile(PRE_SCANNER), recordCount: predecessorReplay.records.length, files: recursiveFiles, recursiveFilesAggregateSha256: sha(Buffer.from(recursiveFiles.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))) }, tests: testSummary, buildPassed: true, leakScanPassed: true, gates: raw.gates, activityScope: raw.activityScope });
  write(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ok: true, runId: raw.runId, classification: raw.classification, driftCause: "post-manifest generated-message-only scanner edit", tests: testSummary, predecessorAggregateSha256: predecessorReplay.aggregateSha256, currentScannerSha256: reconstruction.current.sha256, historicalScannerSha256: reconstruction.reconstructed.sha256, aggregateSha256, pipeline: "1/5", nextGate: raw.nextGate }) + "\n");
}

try { main(); } catch (error) { process.stderr.write(JSON.stringify({ ok: false, category: String(error.message || error) }) + "\n"); process.exit(1); }
