#!/usr/bin/env node
"use strict";

// Local-only defensive Step 3. No RPC, fork, deployed stake call, broadcast,
// wallet/key file, or real value. Foundry vm.sign uses fixed ephemeral keys.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const NAME = "critical-etherfi-behype-fee-refund-delivery-invariant";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const SOL_TEST = "targets/cash-v3/test/critical/BeHYPEFeeRefundDeliveryInvariant.t.sol";
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const STEP1 = "reports/raw/fast/critical-etherfi-unknown-default-identity-binding.json";
const SOURCE_COMMIT = "247faab2206cb651e2e81b2331404eed841145b8";
const REVISION = "behype-fee-refund-delivery-invariant-step3-r1";
const AGENT = "critical-etherfi-behype-invariant-step3-20260722";
const FUZZ_RUNS = 256;
const FUZZ_SEED = "0xbeefee2026072200000000000000000000000000000000000000000000000003";
const DEPLOYED_RUNTIME = "0x243461daa2ebff26f40a4645f235d7f5ebf4d4fcac012bf0624b98e2379f25a3";
const SOURCE_FILES = [
  "src/modules/hype/BeHYPEStakeModule.sol",
  "src/interfaces/IL2BeHYPEOAppStaker.sol",
  "src/modules/ModuleBase.sol",
  "src/modules/ModuleCheckBalance.sol",
  "src/libraries/SignatureUtils.sol",
  "src/safe/EtherFiSafe.sol",
  "src/hook/EtherFiHook.sol",
];

const abs = (x) => path.join(ROOT, x);
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const hashFile = (rel) => { const b = fs.readFileSync(abs(rel)); return { path: rel, bytes: b.length, sha256: sha(b) }; };
function writeOwned(rel, text) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text, "utf8");
}
function git(args, options = {}) {
  const r = spawnSync("git", args, { cwd: TARGET, encoding: "utf8", timeout: options.timeout || 180_000, maxBuffer: 128 * 1024 * 1024 });
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
const sanitize = (x) => String(x || "").replace(/https?:\/\/\S+/gi, "[redacted]");
function prepareWorktree() {
  const temp = path.join(os.tmpdir(), "opencode", "etherfi-behype-step3");
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
    const dst = path.join(work, "test", "critical", "BeHYPEFeeRefundDeliveryInvariant.t.sol");
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
  return { status: r.status, timedOut: Boolean(r.error && r.error.code === "ETIMEDOUT"), output, outputBytes: Buffer.byteLength(output), outputSha256: sha(output) };
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

function authMatrix() {
  return [
    { id: "AUTH-DIGEST", requirement: "chain/module/per-Safe nonce/Safe/amount bound", tests: ["test_validDigest_fixedSafeDestination_andExactValueFlow", "test_mutation_amountRejectedAndNonceRollsBack", "test_crossSafeReplayRejected", "test_crossModuleReplayRejected", "test_crossChainReplayRejected"], result: "PASS" },
    { id: "AUTH-REPLAY", requirement: "same signature single-use with rollback on failure", tests: ["test_sameSignatureReplayRejected", "test_zeroAmountRejectedAndNonceRollsBack", "test_insufficientFeeRollsBackNonceAndTokenState"], result: "PASS" },
    { id: "AUTH-ADMIN", requirement: "single configured Safe admin EOA or ERC-1271 signer; no threshold aggregation", tests: ["test_nonAdminSignerRejectedBeforeNonce", "test_erc1271AdminSupportedWithinSingleAdminAuthorization", "test_multipleAdminsEachAuthorizeIndependently_noThresholdAggregation"], result: "PASS" },
    { id: "AUTH-RELAYER", requirement: "caller is fee-funding/refund recipient but cannot redirect fixed Safe receiver", tests: ["test_relayerNeutral_excessReturnsOnlyToFundingCaller", "test_honestModeledDeliveryUsesFixedSafeReceiver_notRelayer"], result: "PASS" },
    { id: "FIXED-CALL", requirement: "fixed WHYPE approve/staker stake/WHYPE reset; receiver is Safe; no options/calldata parameter", tests: ["test_validDigest_fixedSafeDestination_andExactValueFlow"], result: "PASS" },
  ];
}
function valueMatrix() {
  return [
    { case: "exact quoted fee", callerDelta: "-quote", safeDelta: "0", stakerDelta: "+quote", moduleDelta: "0", result: "success" },
    { case: "quote plus current-call excess", callerDelta: "-quote (excess returned to immediate module caller)", safeDelta: "0", stakerDelta: "+quote", moduleDelta: "0", result: "success if refund accepts" },
    { case: "below quote", callerDelta: "0 rollback", safeDelta: "0", stakerDelta: "0", moduleDelta: "0", result: "InsufficientFee/rollback" },
    { case: "excess refund rejects or exceeds gas", callerDelta: "0 rollback", safeDelta: "0", stakerDelta: "0", moduleDelta: "0", result: "RefundFailed/rollback" },
    { case: "pre-existing Safe ETH", callerDelta: "-quote", safeDelta: "0", stakerDelta: "+quote", moduleDelta: "0", result: "Safe principal unchanged" },
    { case: "forced module ETH before call", callerDelta: "-quote", safeDelta: "0", stakerDelta: "+quote", moduleDelta: "forced residue unchanged", result: "no caller capture; local gain 0" },
    { case: "staker force-sends ETH to module", callerDelta: "-quote", safeDelta: "0", stakerDelta: "+quote-forceBack", moduleDelta: "+forceBack", result: "residue persists; no tested sweep" },
    { case: "zero quote", callerDelta: "0", safeDelta: "0", stakerDelta: "0", moduleDelta: "0", result: "authorized token flow can proceed" },
  ];
}
function refundMatrix() {
  return [
    { gasLimit: "5000 constructor value", receiver: "minimal contract", result: "success" },
    { gasLimit: "5000 constructor value", receiver: "storage-writing contract", result: "RefundFailed/full rollback" },
    { gasLimit: "80000 privileged setting", receiver: "storage-writing contract", result: "success" },
    { gasLimit: "0 raw privileged setting", receiver: "EOA", result: "success" },
    { gasLimit: "0 raw privileged setting", receiver: "minimal contract", result: "success with value stipend" },
    { gasLimit: "0 raw privileged setting", receiver: "storage-writing contract", result: "RefundFailed/full rollback" },
    { gasLimit: "any tested", receiver: "explicit rejector", result: "RefundFailed/full rollback" },
  ];
}
function tokenMatrix() {
  return [
    { behavior: "standard exact consume", result: "success", safeDelta: "-requested", allowanceAfter: "0", qualification: "expected integration" },
    { behavior: "partial consume", result: "success", safeDelta: "-partial", allowanceAfter: "0", qualification: "event/request not actual consumption" },
    { behavior: "no consume", result: "success", safeDelta: "0", allowanceAfter: "0", qualification: "module does not verify consumption/delivery" },
    { behavior: "standard token over-pull attempt", result: "blocked by exact allowance", safeDelta: "0 in catching mock", allowanceAfter: "0", qualification: "standard-token boundary" },
    { behavior: "adversarial token ignores allowance", result: "over-consumption possible in local mock", safeDelta: "more than requested", allowanceAfter: "0", qualification: "token trust assumption; deployed exposure unproven" },
    { behavior: "approve false but sets allowance", result: "success", safeDelta: "-requested", allowanceAfter: "0", qualification: "Safe ignores returndata" },
    { behavior: "approve no-return but sets allowance", result: "success", safeDelta: "-requested", allowanceAfter: "0", qualification: "Safe ignores returndata" },
    { behavior: "approve false/no allowance", result: "staker failure/full rollback", safeDelta: "0", allowanceAfter: "0", qualification: "Safe ignores return but downstream pull detects" },
    { behavior: "initial or reset approve reverts", result: "Safe CallFailed/full rollback", safeDelta: "0", allowanceAfter: "0", qualification: "atomic rollback" },
  ];
}

function main() {
  const generatedAt = new Date().toISOString();
  const scannerSha256 = hashFile(SCANNER).sha256;
  const step1 = JSON.parse(fs.readFileSync(abs(STEP1), "utf8"));
  if (step1.revision !== "unknown-default-identity-binding-step1-reviewer-r2" || step1.classification !== "EXACT/IDENTIFIED-DIRECT-MODULES") throw new Error("reviewed Step 1 mismatch");
  const deployed = step1.modules.find((x) => x.name === "BeHYPEStakeModule");
  if (!deployed?.reconstruction?.exact || deployed.runtime?.keccak256 !== DEPLOYED_RUNTIME) throw new Error("BeHYPE exact runtime link missing");
  if (git(["cat-file", "-t", SOURCE_COMMIT]).trim() !== "commit") throw new Error("source commit unavailable");

  const testSource = fs.readFileSync(abs(SOL_TEST), "utf8");
  const functions = testFunctions(testSource);
  if (!functions.includes("testFuzz_amountFeeConservation")) throw new Error("fuzz test missing");
  if (/create(?:Select)?Fork|fork-url|rpc_endpoints|eth_call|vm\.broadcast|startBroadcast/.test(testSource)) throw new Error("forbidden live/fork primitive");
  const sources = SOURCE_FILES.map((file) => { const text = sourceAt(file); return { path: file, gitBlob: gitBlob(file), bytes: Buffer.byteLength(text), sha256: sha(text) }; });
  const moduleSource = sourceAt(SOURCE_FILES[0]);
  const baseSource = sourceAt("src/modules/ModuleBase.sol");
  const signatureSource = sourceAt("src/libraries/SignatureUtils.sol");
  const safeSource = sourceAt("src/safe/EtherFiSafe.sol");
  const sourceSemantics = {
    digestBindsChainModuleNonceSafeAmount: /STAKE_SIG[\s\S]*block\.chainid[\s\S]*address\(this\)[\s\S]*_useNonce\(safe\)[\s\S]*safe[\s\S]*abi\.encode\(amountToStake\)/.test(moduleSource),
    singleSafeAdminSigner: moduleSource.includes("onlySafeAdmin(safe, signer)") && moduleSource.includes("_verifyAdminSig(digestHash, signer, signature)"),
    eoaAndErc1271Supported: signatureSource.includes("IERC1271(signer).isValidSignature") && signatureSource.includes("ECDSA.recover"),
    perSafeModuleNonceRollbackAtomic: baseSource.includes("nonces[safe]") && baseSource.includes("return $.nonces[safe]++"),
    feeQuotedForAmountAndSafe: moduleSource.includes("staker.quoteStake(amountToStake, safe)"),
    callerFundsQuoteThroughSafe: moduleSource.includes("Address.sendValue(payable(safe), quotedFee)") && moduleSource.includes("values[1] = quotedFee"),
    excessRefundedToCaller: moduleSource.includes("_refundExcessFee(msg.sender, excessFee)"),
    fixedReceiverSafe: moduleSource.includes("IL2BeHYPEOAppStaker.stake.selector, amountToStake, safe"),
    fixedTargetsAndApprovalReset: moduleSource.includes("to[0] = whype") && moduleSource.includes("to[1] = address(staker)") && moduleSource.includes("to[2] = whype") && moduleSource.includes("address(staker), 0"),
    noConsumptionOrDeliveryCheck: !/balanceOf\(safe\)[\s\S]*execTransactionFromModule[\s\S]*balanceOf\(safe\)/.test(moduleSource) && !moduleSource.includes("beHYPE.balanceOf"),
    noAsyncCallbackEntrypoint: !/function\s+(?:lzReceive|retryDelivery|onReceive)/.test(moduleSource),
    safeHookWrapsCalls: safeSource.includes("hook.preOpHook(msg.sender)") && safeSource.includes("hook.postOpHook(msg.sender)"),
    zeroDocumentationMismatch: moduleSource.includes("Setting the gas limit to zero resets it back to the default value") && moduleSource.includes("refundGasLimit = refundGasLimit") && /getRefundGasLimit\(\)[\s\S]*return _getBeHYPEStakeModuleStorage\(\)\.refundGasLimit/.test(moduleSource),
  };
  if (Object.values(sourceSemantics).some((x) => x !== true)) throw new Error(`source semantic anchor missing: ${JSON.stringify(sourceSemantics)}`);

  const work = prepareWorktree();
  let build, first, replay;
  try {
    build = forge(work.work, ["build", "--root", work.work, "--out", work.out, "--cache-path", work.cache, "--no-cache", "--offline"]);
    if (build.status !== 0) throw new Error(`offline build failed: ${sanitize(build.output.slice(-3000))}`);
    const args = ["test", "--root", work.work, "--out", work.out, "--cache-path", work.cache, "--match-path", "test/critical/BeHYPEFeeRefundDeliveryInvariant.t.sol", "--fuzz-runs", String(FUZZ_RUNS), "--fuzz-seed", FUZZ_SEED, "--no-cache", "--offline", "-vv"];
    first = forge(work.work, args);
    if (first.status !== 0) throw new Error(`first test failed: ${sanitize(first.output.slice(-5000))}`);
    replay = forge(work.work, args);
    if (replay.status !== 0) throw new Error(`replay test failed: ${sanitize(replay.output.slice(-5000))}`);
  } finally {
    cleanup(work.temp, work.work);
  }

  const firstRows = passRows(first.output);
  const replayRows = passRows(replay.output);
  if (JSON.stringify(firstRows) !== JSON.stringify(replayRows)) throw new Error("fixed-seed semantic replay mismatch");
  const names = firstRows.map((x) => x.name);
  if (functions.length !== names.length || functions.some((x) => !names.includes(x))) throw new Error(`test enumeration mismatch source=${functions.length} pass=${names.length}`);
  const fuzzRows = firstRows.filter((x) => x.name.startsWith("testFuzz_"));
  if (fuzzRows.length !== 1 || fuzzRows[0].fuzzRuns !== FUZZ_RUNS) throw new Error("fuzz count mismatch");
  const authorizationMatrix = authMatrix();
  const required = [...new Set(authorizationMatrix.flatMap((x) => x.tests))];
  const missing = required.filter((x) => !names.includes(x));
  if (missing.length) throw new Error(`authorization matrix tests missing: ${missing.join(",")}`);

  const deterministic = firstRows.filter((x) => x.fuzzRuns === 1).length;
  const runId = `etherfi-behype-fee-refund-delivery-${SOURCE_COMMIT.slice(0, 12)}-${scannerSha256.slice(0, 12)}`;
  const classification = "PASS/BOUNDED-VALID-ADMIN-FEE-REFUND-DELIVERY-INVARIANT/EXTERNAL-INTEGRATIONS-OPEN";
  const category = "bounded-local-behype-value-flow-external-staker-layerzero-coverage-open";
  const observations = [
    { id: "BH-I01", severity: "Informational", classification: "DOCUMENTATION-MISMATCH/PRIVILEGED-REFUND-AVAILABILITY-RISK-ONLY", precondition: "Module admin sets refundGasLimit to zero and an excess refund targets a receiver needing more than the value stipend", evidence: "Source stores zero raw despite documentation saying zero restores default; local zero-gas EOA/minimal refunds pass while storage-writing receiver fails and atomically rolls back.", impact: "Privileged configuration can make excess-refund execution unavailable for complex relayers; no outsider theft or residue capture is established.", permissionlessExploit: false, mitigation: "Implement an explicit default fallback or update documentation; consider pull refunds or permit exact-fee relaying." },
    { id: "BH-I02", severity: "Informational", classification: "OWNER-AUTHORIZED/EXTERNAL-STAKER-DELIVERY-TRUST-CAVEAT", precondition: "A valid Safe-admin signature is executed against a staker/token integration that partially consumes, does not consume, or fails/redirects asynchronous delivery", evidence: "The module fixes receiver=safe and resets approval but does not verify actual WHYPE consumption or beHYPE delivery; representative local malicious/partial/no-consume stakers demonstrate the trust boundary.", impact: "Owner-authorized intent can complete locally without requested consumption or output delivery; deployed staker/WHYPE/LayerZero exposure is not established.", permissionlessExploit: false, mitigation: "Bind and monitor staker delivery identifiers, reconcile requested versus consumed/delivered amounts, and document immutable integration trust." },
    { id: "BH-I03", severity: "Informational", classification: "OWNER-AUTHORIZED/INTEGRATION-EVENT-ACCOUNTING-CAVEAT", precondition: "Valid admin authorization and a staker consumes less than requested", evidence: "StakeDeposit emits requested amountToStake after the call sequence; local partial/no-consumption paths still emit/succeed and reset allowance.", impact: "The event is intent accounting, not proof of actual WHYPE consumption or beHYPE receipt.", permissionlessExploit: false, mitigation: "Treat StakeDeposit as request intent and reconcile downstream staker/LayerZero delivery events and token deltas." },
    { id: "BH-I04", severity: "Informational", classification: "NONCAPTURABLE-RESIDUE/NO-SWEEP-PATH-OBSERVED", precondition: "ETH is forced into the module or force-sent by the staker", evidence: "Refund amount is msg.value-quote, not contract balance; forced residue remained invariant across caller-funded executions. Exact local unauthorized residue-capture gain is zero.", impact: "ETH can remain stranded in the module, but the tested stake path does not let arbitrary callers capture it.", permissionlessExploit: false, mitigation: "Add a tightly governed rescue path if operationally desired and monitor unexpected module ETH." },
  ];
  const notCovered = [
    "full deployed EtherFiSafe runtime, incoming-admin transitions and every malformed signature/revert case",
    "deployed staker runtime/source, LayerZero endpoint/options/message/callback/retry/refund behavior",
    "production WHYPE and beHYPE runtime semantics, supply and delivery accounting",
    "current post-pin Safe/default/whitelist/role/refundGasLimit/integration continuity",
    "all ERC-1271 wallet implementations, signature gas griefing and construction-time code edge cases",
    "current economic exposure, actual pending deliveries and offchain operator procedures",
  ];
  const blockers = [
    "This exact-source local harness models Safe execution, hooks, tokens, staker and delivery boundaries; it is not complete deployed-system proof.",
    ...notCovered.map((x) => `Not covered: ${x}.`),
    "The production entrypoint uses one configured Safe-admin signature (EOA or ERC-1271), not Safe owner-threshold checkSignatures; multi-owner threshold claims are therefore inapplicable to stake authorization.",
    "No caller-supplied destination, LayerZero options or arbitrary calldata exists in this module API; downstream message fields remain external-staker scope.",
    "No unauthorized caller profit, deployed residue, current external-integration defect, protocol loss or positive economics is established.",
  ];
  const nextAction = "Under a separate read-only claim, bind the reviewed immutable staker to exact source/runtime and map its LayerZero receiver/options/delivery/retry/refund state; do not call stake or send a message.";
  const result = {
    schemaVersion: 1, revision: REVISION, runId, generatedAt, scanner: SCANNER, agentId: AGENT, role: "critical-research", step: 3,
    classification, category, signal: "⚪ CLEAN — BOUNDED LOCAL VALID-ADMIN VALUE-FLOW INVARIANT / EXTERNAL INTEGRATIONS OPEN",
    routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    safety: { localOnly: true, rpcUsed: false, endpointInventoryRead: false, endpointValuesPersisted: false, envFilesRead: false, privateKeysRead: false, deployedStakeCalled: false, realValueUsed: false, forkCreated: false, liveMutation: false, broadcast: false, liveSigning: false, ephemeralFoundryVmSign: true },
    predecessor: { path: STEP1, runId: step1.runId, revision: step1.revision, sha256: hashFile(STEP1).sha256, sourceCommit: step1.source.commit, deployedAddress: deployed.address, deployedRuntimeKeccak256: deployed.runtime.keccak256, immutablePatchedRuntimeExact: deployed.reconstruction.exact },
    source: { commit: SOURCE_COMMIT, files: sources, semantics: sourceSemantics },
    scopeQualifications: { completeDeployedSystemProof: false, productionAuthorizationModel: "one configured Safe admin signer; EOA or ERC-1271", ownerThresholdAggregationUsedByStake: false, localEoaAdminsCovered: 2, representativeErc1271AdminCovered: true, simplifiedSafeHookStakerTokenMocks: true, notCovered },
    localHarness: { exactProductionModuleSource: true, fullSafeRuntimeDeployed: false, deployedStakerRuntimeUsed: false, actualEcdsaRecoverUsed: true, representativeErc1271Used: true, maliciousRefundReceiverUsed: true, maliciousStakerUsed: true, partialStakerUsed: true, reentrantStakerUsed: true, reentrantRefundReceiverUsed: true, ephemeralIdentitiesOnly: true },
    foundry: { compiler: "0.8.28", optimizer: true, optimizerRuns: 0, evmVersion: "cancun", offline: true, build: { exitStatus: build.status, outputBytes: build.outputBytes, outputSha256: build.outputSha256 }, firstRun: { exitStatus: first.status, outputBytes: first.outputBytes, outputSha256: first.outputSha256 }, replayRun: { exitStatus: replay.status, outputBytes: replay.outputBytes, outputSha256: replay.outputSha256 }, fuzzSeed: FUZZ_SEED, fuzzRunsPerFuzzTest: FUZZ_RUNS, semanticReplayEqual: true },
    tests: { sourceFunctionCount: functions.length, passedFunctionCount: firstRows.length, deterministicTestCount: deterministic, fuzzTestCount: fuzzRows.length, fuzzCaseCount: fuzzRows.reduce((n, x) => n + x.fuzzRuns, 0), totalExecutedCases: deterministic + fuzzRows.reduce((n, x) => n + x.fuzzRuns, 0), passRows: firstRows },
    authorizationMatrix, valueFlowMatrix: valueMatrix(), refundGasMatrix: refundMatrix(), tokenFlowMatrix: tokenMatrix(),
    asyncDelivery: { signedOrFixedReceiver: "Safe is digest-bound and passed as fixed staker receiver", callerCanRedirect: false, optionsOrCalldataArgumentsPresent: false, moduleCallbackEntrypointPresent: false, moduleDeliveryReplayStatePresent: false, downstreamTrust: "staker/LayerZero delivery, callback, retry and refund ownership are not validated by this module" },
    findings: { unauthorizedAuthorizationBypassFound: false, arbitraryCallerResidueCaptureFound: false, exactLocalUnauthorizedResidueCaptureGainWei: "0", relayerCanRedirectReceiver: false, currentCallSuppliesQuote: true, immediateModuleCallerReceivesOnlyCurrentCallExcess: true, smartRelayUpstreamRefundOwnershipDependsOnRelayPolicy: true, safeEthPrincipalChanged: false, allowanceResetAfterSuccess: true, externalStakerCanCauseUnverifiedConsumptionOrDelivery: true, healthFailureAtomicRollback: true, permissionlessLossEstablished: false, profitablePathEstablished: false },
    observations, blockers, nextReadOnlyStep: nextAction,
  };
  writeOwned(RAW, JSON.stringify(result, null, 2) + "\n");

  const valueRows = result.valueFlowMatrix.map((x) => `| ${x.case} | ${x.callerDelta} | ${x.safeDelta} | ${x.stakerDelta} | ${x.moduleDelta} | ${x.result} |`).join("\n");
  const refundRows = result.refundGasMatrix.map((x) => `| ${x.gasLimit} | ${x.receiver} | ${x.result} |`).join("\n");
  const tokenRows = result.tokenFlowMatrix.map((x) => `| ${x.behavior} | ${x.result} | ${x.safeDelta} | ${x.allowanceAfter} | ${x.qualification} |`).join("\n");
  const report = `# ${result.signal} — EtherFi BeHYPEStakeModule Step 3\n\n**Classification:** \`${classification}\`  \n**Revision:** \`${REVISION}\`  \n**Run:** \`${runId}\`  \n**Production linkage:** source \`${SOURCE_COMMIT}\`; deployed runtime \`${DEPLOYED_RUNTIME}\`; immutable-patched exact \`true\`  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n> Exact production module source passes bounded local authorization, fee, refund, approval-reset and rollback invariants. No outsider authorization bypass, Safe-principal capture, cross-transaction fee capture, module-residue capture, arbitrary destination, permissionless loss or profit is established. Deployed staker/WHYPE/beHYPE/LayerZero and current configuration remain open.\n\n## Authorization boundary\n\nThe production entrypoint uses **one configured Safe-admin signer**, not owner-threshold \`checkSignatures\`. Two EOA admins were tested independently and one representative ERC-1271 admin was tested. This is not a 1-of-1/2-of-3/3-of-3 Safe owner-threshold proof. Digest tests bind chain, module, per-Safe module nonce, Safe and amount; mutation, replay, cross-Safe, cross-module and cross-chain cases roll back. Caller is relayer-neutral. Receiver is not a free argument: the signed Safe is passed to the immutable staker. LayerZero options/arbitrary calldata are absent from the module API.\n\n## Exact local value-flow matrix\n\n| Case | Caller | Safe | Staker | Module | Result |\n|---|---|---|---|---|---|\n${valueRows}\n\nThe current call supplies the quote. The module first sends quote ETH to the Safe; the Safe forwards exactly quote ETH to the staker, leaving Safe ETH unchanged. Excess is derived only from the current \`msg.value\` and returned to the immediate module caller (\`msg.sender\`). For a smart relay, upstream economic ownership and onward refunding depend on relay policy and are outside this module. Forced or staker-returned module ETH is not included, persisted in every tested later call, and produced exact local unauthorized capture gain **0 wei**.\n\n## Refund gas behavior\n\n| Configured gas | Receiver | Result |\n|---|---|---|\n${refundRows}\n\nA failed positive-excess refund reverts the entire transaction, including nonce, token movement, staker state, fee forwarding and hooks. \`setRefundGasLimit(0)\` stores/returns zero despite documentation saying it restores a default. The setter is role-gated. This remains \`DOCUMENTATION-MISMATCH/PRIVILEGED-REFUND-AVAILABILITY-RISK-ONLY\`.\n\n## Token and approval matrix\n\n| Behavior | Result | Safe token delta | Allowance after | Qualification |\n|---|---|---|---|---|\n${tokenRows}\n\nThe exact source approves only the requested amount, calls the immutable staker with receiver=Safe, then resets allowance to zero. Safe low-level execution ignores ERC20 return data. The module does not compare requested versus consumed WHYPE and does not verify beHYPE delivery. Partial/no-consumption and malicious redirect mocks therefore identify external integration trust, not a permissionless caller opportunity or deployed defect.\n\n## Async delivery and callbacks\n\nThe signed Safe is the fixed staker receiver and a relayer cannot redirect it through this API. The module has no LayerZero options/calldata input, callback, retry, message replay or delivery-refund ledger. No-output and malicious-output mocks can still complete because those semantics live behind the immutable staker. Representative staker/refund reentry without fresh authorization failed. Production staker/LayerZero callback, delivery, retry and refund ownership remain unproven.\n\n## Hook and rollback\n\nThe source-derived Safe model wraps the three calls with pre/post hooks. Unhealthy post-hook, staker failure, approve/reset failure, insufficient fee and refund failure atomically roll back nonce, fee and token state. Full deployed Safe/hook configuration is not proven.\n\n## Calibrated observations\n\n${observations.map((x) => `- **${x.id} — ${x.classification} (${x.severity}):** ${x.impact} Preconditions: ${x.precondition}. Mitigation: ${x.mitigation}`).join("\n")}\n\n## Residual blockers\n\n${blockers.map((x) => `- ${x}`).join("\n")}\n\n**nextReadOnlyStep:** ${nextAction}\n`;
  writeOwned(REPORT, report);
  const inbox = { findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "Exact BeHYPE source passes bounded local admin authorization/fee/refund/approval-reset invariants; no outsider profit or residue capture. External staker/token/LayerZero delivery and current configuration remain open.", testCounts: result.tests, authorizationMatrix, valueFlowMatrix: result.valueFlowMatrix, observations, blockers, artifacts: [SOL_TEST, SCANNER, VALIDATOR, RAW, MANIFEST, REPORT], nextAction };
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# EtherFi BeHYPE fee/refund/delivery invariant Step 3 handoff\n\n- Run \`${runId}\`; revision \`${REVISION}\`; classification \`${classification}\`.\n- Exact BeHYPE source/runtime linkage retained; ${firstRows.length}/${functions.length} functions, ${FUZZ_RUNS} fixed-seed fuzz cases and semantic replay PASS.\n- Authorization is one configured Safe-admin EOA/ERC-1271 signature, not owner-threshold aggregation; chain/module/per-Safe nonce/Safe/amount bind and receiver is fixed Safe.\n- Exact fee path: current call supplies quote, Safe ETH net zero, staker receives quote, and the immediate module caller receives only current-call excess; smart-relay upstream ownership depends on relay policy. Forced module residue capture gain is 0 wei.\n- Zero refund gas is stored raw; EOA/minimal refunds pass while storage-writing receiver fails/full-rolls-back. Known privileged documentation/availability mismatch preserved.\n- Approval is exact and reset to zero, but requested amount/output delivery are not verified; partial/no-consume/malicious staker cases are owner-authorized external-integration trust caveats, not outsider opportunities.\n- Hooks and all tested fee/token/refund failures roll back atomically.\n- No RPC, fork, deployed stake call, real value, broadcast or live signing; gates \`0/0/false\`, fork=false.\n- Next: ${nextAction}\n`);
  const records = [SCANNER, VALIDATOR, SOL_TEST, RAW, REPORT, INBOX, HANDOFF, STEP1].map(hashFile);
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, algorithm: "sha256", classification, category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, localOnly: true, noRpcOrFork: true, sourceCommit: SOURCE_COMMIT, deployedRuntimeKeccak256: DEPLOYED_RUNTIME, immutablePatchedRuntimeExact: true, passedFunctionCount: firstRows.length, deterministicTestCount: deterministic, fuzzCaseCount: result.tests.fuzzCaseCount, fuzzSeed: FUZZ_SEED, semanticReplayEqual: true, unauthorizedAuthorizationBypassFound: false, arbitraryCallerResidueCaptureFound: false, exactLocalUnauthorizedResidueCaptureGainWei: "0", completeDeployedSystemProof: false, ownerThresholdAggregationUsedByStake: false, observationCount: observations.length, records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, revision: REVISION, classification, tests: result.tests, authorizationMatrix, valueFlowMatrix: result.valueFlowMatrix, refundGasMatrix: result.refundGasMatrix, tokenFlowMatrix: result.tokenFlowMatrix, observations, blockers, artifacts: [SOL_TEST, SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF], gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, manifestAggregateSha256: aggregateSha256, nextReadOnlyStep: nextAction }) + "\n");
}

try { main(); } catch (e) { process.stderr.write(`scan failed: ${sanitize(e?.message || e)}\n`); process.exitCode = 1; }
