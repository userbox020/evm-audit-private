#!/usr/bin/env node
"use strict";

// Local-only defensive Step 2. No RPC, fork, deployed call, broadcast, wallet,
// private key file, or real value is used. Foundry vm.sign uses fixed ephemeral keys.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const SCANNER = "tools/scan-critical-etherfi-safe-asset-recovery-invariant.js";
const VALIDATOR = "tools/test-critical-etherfi-safe-asset-recovery-invariant.js";
const SOL_TEST = "targets/cash-v3/test/critical/SafeAssetRecoveryInvariant.t.sol";
const RAW = "reports/raw/fast/critical-etherfi-safe-asset-recovery-invariant.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-safe-asset-recovery-invariant-manifest.json";
const REPORT = "reports/critical-etherfi-safe-asset-recovery-invariant.md";
const INBOX = "coordination/inbox/critical/2026-07-22-critical-etherfi-safe-asset-recovery-invariant.json";
const HANDOFF = "coordination/handoffs/2026-07-22-critical-etherfi-safe-asset-recovery-invariant-handoff.md";
const STEP1 = "reports/raw/fast/critical-etherfi-unknown-default-identity-binding.json";
const SOURCE_COMMIT = "247faab2206cb651e2e81b2331404eed841145b8";
const REVISION = "safe-asset-recovery-invariant-step2-reviewer-r2";
const AGENT = "critical-etherfi-recovery-invariant-r2-20260722";
const FUZZ_RUNS = 128;
const FUZZ_SEED = "0x5afea55e7ec0de20260722000000000000000000000000000000000000000002";
const SOURCE_FILES = [
  "src/modules/recovery/SafeAssetRecoveryModule.sol",
  "src/interfaces/ISafeAssetRecoveryModule.sol",
  "src/modules/ModuleBase.sol",
  "src/safe/EtherFiSafe.sol",
  "src/safe/ModuleManager.sol",
  "src/hook/EtherFiHook.sol",
];

function abs(x) { return path.join(ROOT, x); }
function sha(x) { return crypto.createHash("sha256").update(x).digest("hex"); }
function hashFile(rel) { const b = fs.readFileSync(abs(rel)); return { path: rel, bytes: b.length, sha256: sha(b) }; }
function writeOwned(rel, text) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8"); }
function git(args, options = {}) { const r = spawnSync("git", args, { cwd: TARGET, encoding: "utf8", timeout: options.timeout || 180_000, maxBuffer: 128 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`git ${args[0]} failed`); return r.stdout; }
function sourceAt(rel) { return git(["show", `${SOURCE_COMMIT}:${rel}`]); }
function gitBlob(rel) { return git(["rev-parse", `${SOURCE_COMMIT}:${rel}`]).trim(); }
function unlinkLibraries(work) { const lib = path.join(work, "lib"); if (!fs.existsSync(lib)) return; for (const name of fs.readdirSync(lib)) { const p = path.join(lib, name); try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch {} } }
function cleanup(temp, work) { unlinkLibraries(work); try { git(["worktree", "remove", "--force", work]); } catch {} fs.rmSync(temp, { recursive: true, force: true }); }
function sanitizeOutput(x) { return String(x || "").replace(/https?:\/\/\S+/gi, "[redacted]"); }

function prepareWorktree() {
  const temp = path.join(os.tmpdir(), "opencode", "etherfi-safe-recovery-step2");
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
    const testDst = path.join(work, "test", "critical", "SafeAssetRecoveryInvariant.t.sol");
    fs.mkdirSync(path.dirname(testDst), { recursive: true });
    fs.copyFileSync(abs(SOL_TEST), testDst);
    return { temp, work, out: path.join(temp, "out"), cache: path.join(temp, "cache") };
  } catch (e) {
    cleanup(temp, work);
    throw e;
  }
}

function runForge(work, args, timeout = 600_000) {
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

function matrixRows() {
  return [
    { id: "AUTH-DIGEST", requirement: "owner quorum and exact chain/module/nonce/Safe/token/recipient/deadline binding", tests: ["test_validOwnerSignature_exactDigestAndFixedCall", "test_mutation_tokenRejected", "test_mutation_recipientRejected", "test_mutation_deadlineRejected"], result: "PASS" },
    { id: "AUTH-RELAYER", requirement: "caller neutrality with recipient binding", tests: ["test_relayerNeutral_recipientStillBound"], result: "PASS" },
    { id: "AUTH-REPLAY", requirement: "cross-Safe/module/chain and same-signature replay rejection", tests: ["test_crossSafeReplayRejected", "test_crossModuleReplayRejected", "test_crossChainReplayRejected", "test_nonceSingleUseAndSameSignatureReplayRejected"], result: "PASS" },
    { id: "ROLLBACK", requirement: "failed signature/support/token/hook checks roll back nonce and state", tests: ["test_failedSignatureRollsBackNonce", "test_failedSupportedCheckRollsBackNonce", "test_falseReturnNoMoveRejectedAfterSafeCallSuccess", "test_revertingTokenRejectedBySafeAndRollsBackNonce", "test_unhealthySafeBlocksRecoveryAndRollsBackTransferAndNonce"], result: "PASS" },
    { id: "TIME-PAUSE", requirement: "deadline equality accepted, expiry and pause rejected, role-bound unpause", tests: ["test_deadlineBoundaryAcceptedAndExpiredRejectedWithoutNonceUse", "test_pauseBlocksBeforeNonceAndAuthorizedUnpauseRestores", "test_pauseRolesRejectOutsider"], result: "PASS" },
    { id: "SUPPORTED-ASSET", requirement: "collateral/borrow/withdraw exclusions including all seven overlaps", tests: ["test_supportedTokenExclusion_allSevenOverlapMasks"], result: "PASS", localCases: 7 },
    { id: "MODULE-ENABLE", requirement: "default/local/whitelist enabled-state matrix", tests: ["test_defaultModuleEnabledWithoutLocalRelationship", "test_defaultAbsentAndNotLocalRejectsExecution", "test_defaultAbsentButWhitelistedLocalModuleExecutes", "test_whitelistRemovedDisablesLocalNonDefaultModule"], result: "PASS" },
    { id: "FULL-BALANCE", requirement: "then-current full balance, post-sign increase, zero and large/fuzzed amounts", tests: ["test_signedBeforeBalanceIncreaseSweepsThenCurrentFullBalance", "test_zeroBalanceRejectedAndNonceRolledBack", "testFuzz_standardFullBalance"], result: "PASS", fuzzCases: FUZZ_RUNS },
    { id: "FIXED-CALL", requirement: "single signed-token transfer target, signed recipient, current amount, zero value, no arbitrary target/calldata", tests: ["test_validOwnerSignature_exactDigestAndFixedCall"], result: "PASS" },
    { id: "TOKEN-COMPAT", requirement: "standard/no-return/false/revert/fee/dust/balance-inflation behavior", tests: ["test_noReturnTokenSucceedsByBalanceDelta", "test_falseReturnNoMoveRejectedAfterSafeCallSuccess", "test_trueReturnNoMoveRejectedByBalanceDelta", "test_falseReturnWithMoveSucceedsBecauseSafeIgnoresReturnData", "test_revertingTokenRejectedBySafeAndRollsBackNonce", "test_feeOnTransferEventTracksSafeDeltaNotRecipientAmount", "test_rebasingDustEventTracksActualSafeDelta", "test_balanceInflatingTokenRejectedAndStateRolledBack"], result: "PASS" },
    { id: "HOOK-HEALTH", requirement: "non-Cash module path invokes post hook health check and unhealthy revert rolls back", tests: ["test_healthHookInvokedAfterRecovery", "test_unhealthySafeBlocksRecoveryAndRollsBackTransferAndNonce"], result: "PASS" },
    { id: "THRESHOLD", requirement: "one-of-one, two-of-three and three-of-three local threshold harness", tests: ["test_thresholdOneOfOneAccepted", "test_thresholdTwoOfThreeAcceptedAndOneRejected", "test_thresholdThreeOfThreeAcceptedAndTwoRejected"], result: "PASS" },
  ];
}

function tokenMatrix() {
  return [
    { behavior: "standard bool true + full move", safeCallSuccess: true, moduleResult: "success", safeDelta: "full", recipientAmount: "full", classification: "compatible" },
    { behavior: "no return data + full move", safeCallSuccess: true, moduleResult: "success", safeDelta: "full", recipientAmount: "full", classification: "compatible despite non-standard return" },
    { behavior: "false return + no move", safeCallSuccess: true, moduleResult: "RecoveryTransferFailed", safeDelta: "zero", recipientAmount: "zero", classification: "rejected by post-balance check" },
    { behavior: "true return + no move", safeCallSuccess: true, moduleResult: "RecoveryTransferFailed", safeDelta: "zero", recipientAmount: "zero", classification: "rejected by post-balance check" },
    { behavior: "false return + full move", safeCallSuccess: true, moduleResult: "success", safeDelta: "full", recipientAmount: "full", classification: "accepted because Safe ignores returndata and balance decreased" },
    { behavior: "transfer reverts", safeCallSuccess: false, moduleResult: "Safe CallFailed", safeDelta: "rolled back", recipientAmount: "zero", classification: "incompatible/rollback" },
    { behavior: "5% fee on transfer", safeCallSuccess: true, moduleResult: "success", safeDelta: "full/event reports full", recipientAmount: "95%", classification: "owner-authorized/integration-accounting caveat; no unauthorized loss" },
    { behavior: "dust/rebasing-style leaves 1", safeCallSuccess: true, moduleResult: "success", safeDelta: "amount-1/event reports delta", recipientAmount: "amount-1", classification: "compatible with residual dust" },
    { behavior: "sender balance inflates/no move", safeCallSuccess: true, moduleResult: "RecoveryTransferFailed", safeDelta: "rollback", recipientAmount: "zero", classification: "rejected by non-decrease check" },
  ];
}

function main() {
  const generatedAt = new Date().toISOString();
  const scannerSha256 = hashFile(SCANNER).sha256;
  const prior = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
  const priorManifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
  const supersedes = prior.packaging?.supersedes || { revision: prior.revision, runId: prior.runId, manifestAggregateSha256: priorManifest.aggregateSha256 };
  if (supersedes.revision !== "safe-asset-recovery-invariant-step2-r1") throw new Error("reviewer r2 requires retained r1 package");
  const step1 = JSON.parse(fs.readFileSync(abs(STEP1), "utf8"));
  if (step1.revision !== "unknown-default-identity-binding-step1-reviewer-r2" || step1.classification !== "EXACT/IDENTIFIED-DIRECT-MODULES") throw new Error("reviewed Step 1 mismatch");
  const deployed = step1.modules.find((x) => x.name === "SafeAssetRecoveryModule");
  if (!deployed?.reconstruction?.exact || deployed.runtime?.keccak256 !== "0x2e19e9cd3629d57f37e3a2d2c663a22091e24cc432096f3576d6833795fcb928") throw new Error("Step 1 runtime link missing");
  if (git(["cat-file", "-t", SOURCE_COMMIT]).trim() !== "commit") throw new Error("source commit unavailable");

  const testSource = fs.readFileSync(abs(SOL_TEST), "utf8");
  const functions = testFunctions(testSource);
  if (!functions.includes("testFuzz_standardFullBalance")) throw new Error("fuzz test missing");
  if (/create(?:Select)?Fork|fork-url|rpc_endpoints|eth_call|vm\.broadcast|startBroadcast/.test(testSource)) throw new Error("forbidden live/fork primitive in local test");
  const sources = SOURCE_FILES.map((file) => { const text = sourceAt(file); return { path: file, gitBlob: gitBlob(file), bytes: Buffer.byteLength(text), sha256: sha(text) }; });
  const recoverySource = sourceAt(SOURCE_FILES[0]);
  const safeSource = sourceAt("src/safe/EtherFiSafe.sol");
  const managerSource = sourceAt("src/safe/ModuleManager.sol");
  const hookSource = sourceAt("src/hook/EtherFiHook.sol");
  const sourceSemantics = {
    digestFieldsExact: /block\.chainid[\s\S]*address\(this\)[\s\S]*_useNonce\(safe\)[\s\S]*safe[\s\S]*token[\s\S]*recipient[\s\S]*deadline/.test(recoverySource),
    amountUnsignedFullBalance: recoverySource.includes("Amount is not signed") && recoverySource.includes("IERC20(token).balanceOf(safe)"),
    fixedTransferCall: recoverySource.includes("to[0] = token") && recoverySource.includes("abi.encodeCall(IERC20.transfer, (recipient, amount))"),
    supportExclusions: ["isCollateralToken(token)", "isBorrowToken(token)", "_isWithdrawWhitelisted(cashModule, token)"].every((x) => recoverySource.includes(x)),
    safeIgnoresReturnData: safeSource.includes("(bool success,) = to[i].call") && safeSource.includes("if (!success) revert CallFailed(i)"),
    defaultModuleAutoEnabled: managerSource.includes("if (isDefaultModuleOnDataProvider) return true"),
    nonDefaultNeedsWhitelistAndLocal: managerSource.includes("return isWhitelistedModuleOnDataProvider && _getModuleManagerStorage().modules.contains(module)"),
    safeCallsPostHook: safeSource.includes("hook.postOpHook(msg.sender)"),
    hookChecksHealthForNonCash: hookSource.includes("if (module == address(cashModule)) return") && hookSource.includes("debtManager.ensureHealth(msg.sender)"),
    staleContradictoryRecoveryComment: recoverySource.includes("A module transfer bypasses both the") && recoverySource.includes("debt-health flow"),
  };
  if (Object.entries(sourceSemantics).filter(([k]) => k !== "staleContradictoryRecoveryComment").some(([, v]) => v !== true)) throw new Error("source semantic anchor missing");

  const work = prepareWorktree();
  let build;
  let first;
  let second;
  try {
    build = runForge(work.work, ["build", "--root", work.work, "--out", work.out, "--cache-path", work.cache, "--no-cache", "--offline"]);
    if (build.status !== 0) throw new Error(`offline build failed: ${sanitizeOutput(build.output.slice(-1600))}`);
    const testArgs = ["test", "--root", work.work, "--out", work.out, "--cache-path", work.cache, "--match-path", "test/critical/SafeAssetRecoveryInvariant.t.sol", "--fuzz-runs", String(FUZZ_RUNS), "--fuzz-seed", FUZZ_SEED, "--no-cache", "--offline", "-vv"];
    first = runForge(work.work, testArgs);
    if (first.status !== 0) throw new Error(`first local test failed: ${sanitizeOutput(first.output.slice(-2400))}`);
    second = runForge(work.work, testArgs);
    if (second.status !== 0) throw new Error(`replay local test failed: ${sanitizeOutput(second.output.slice(-2400))}`);
  } finally {
    cleanup(work.temp, work.work);
  }

  const firstRows = passRows(first.output);
  const secondRows = passRows(second.output);
  const firstNames = firstRows.map((x) => x.name);
  const secondNames = secondRows.map((x) => x.name);
  if (JSON.stringify(firstRows) !== JSON.stringify(secondRows)) throw new Error("fixed-seed replay semantic mismatch");
  if (functions.length !== firstNames.length || functions.some((x) => !firstNames.includes(x))) throw new Error(`test enumeration mismatch source=${functions.length} pass=${firstNames.length}`);
  const fuzzRows = firstRows.filter((x) => x.name.startsWith("testFuzz_"));
  if (fuzzRows.length !== 1 || fuzzRows[0].fuzzRuns !== FUZZ_RUNS) throw new Error("fuzz run count mismatch");
  const matrix = matrixRows();
  const missingMatrixTests = [...new Set(matrix.flatMap((x) => x.tests))].filter((x) => !firstNames.includes(x));
  if (missingMatrixTests.length) throw new Error(`matrix tests missing: ${missingMatrixTests.join(",")}`);

  const deterministicTests = firstRows.filter((x) => x.fuzzRuns === 1).length;
  // The overlap test is one Foundry function containing seven distinct masks, so
  // replace its single function-level case with the seven internal cases.
  const totalExecutedCases = deterministicTests - 1 + fuzzRows.reduce((n, x) => n + x.fuzzRuns, 0) + 7;
  const classification = "PASS/BOUNDED-VALID-AUTH-FULL-BALANCE-INVARIANT";
  const category = "bounded-local-valid-authorization-production-safe-coverage-open";
  const runId = `etherfi-safe-asset-recovery-invariant-${SOURCE_COMMIT.slice(0, 12)}-reviewer-r2-${scannerSha256.slice(0, 12)}`;
  const observations = [
    { id: "SAR-I01", severity: "Informational", classification: "DOCUMENTATION-MISMATCH", precondition: "Reviewer reads the _assertRecoverable comment as operative semantics", evidence: "The comment says module transfer bypasses debt-health, while EtherFiSafe calls postOpHook and EtherFiHook calls ensureHealth for every non-Cash module.", impact: "Could mislead integrators about recovery availability; local proof shows unhealthy health-check failure rolls back transfer and nonce.", permissionlessExploit: false, mitigation: "Correct the stale comment to state that supported-token exclusion prevents delay/collateral bypass while the Safe post-hook still enforces health." },
    { id: "SAR-I02", severity: "Informational", classification: "OWNER-AUTHORIZED/INTEGRATION-ACCOUNTING-CAVEAT", precondition: "Valid owner quorum authorizes an unsupported fee-on-transfer or balance-changing token", evidence: "AssetRecovered reports Safe-side balance delta; recipient may receive less under transfer fees, while dust tokens report the actual Safe delta.", impact: "Owner-authorized recovery accounting can differ from recipient receipts; no unauthorized loss or outsider choice of token/recipient is established.", permissionlessExploit: false, mitigation: "Document event amount as Safe-side delta and have owner recovery tooling compare recipient pre/post balance for non-standard tokens." },
    { id: "SAR-I03", severity: "Informational", classification: "DOCUMENTED/OPERATIONAL-AVAILABILITY-CONSTRAINT", precondition: "Valid owner quorum, unsupported token, and unhealthy Safe while the configured production-style health hook is active", evidence: "The Safe post-hook invokes ensureHealth after transfer; failure reverts the full operation, consistent with source documentation that unhealthy Safes must regain health first.", impact: "Unsupported assets remain unavailable for recovery until health is restored. This is intended unless a contrary product requirement is established, and does not enable collateral theft or outsider recovery.", permissionlessExploit: false, mitigation: "Retain the intended health gate in operational documentation and provide a health-restoration runbook before recovery." },
  ];
  const notCovered = [
    "ERC-1271 contract owners and mixed EOA/contract-owner quorums",
    "all malformed-signature and exact production-Safe revert-selector cases",
    "all duplicate-signer, signer-order and signature-array length/content combinations",
    "effective incoming-owner recovery/owner-transition behavior",
    "callbacks, reentrancy and the full adversarial-token state space",
    "live hook and EtherFiDataProvider configuration",
    "current registry/default/whitelist/Safe continuity after the retained Step 1 pin",
  ];
  const blockers = [
    "This is not complete production-Safe authorization proof: the ECDSA-only owner harness and simplified Safe/hook/data-provider mocks are not a byte-for-byte deployment of the full EtherFiSafe runtime.",
    ...notCovered.map((x) => `Not covered: ${x}.`),
    "Cross-chain replay is modeled with vm.chainId; no fork or deployed-chain call is used.",
    "Recipient economic value, token marketability and downstream offchain recovery operations are outside this local semantic proof.",
    "No unauthorized caller, permissionless extraction path, protocol loss, or positive economics is established.",
  ];
  const nextAction = "Run one bounded local BeHYPEStakeModule fee/refund/delivery invariant pass using the reviewed exact source; do not call the deployed stake entrypoint.";
  const result = {
    schemaVersion: 2,
    revision: REVISION,
    runId,
    generatedAt,
    scanner: SCANNER,
    agentId: AGENT,
    role: "critical-research",
    step: 2,
    classification,
    category,
    signal: "⚪ CLEAN — BOUNDED LOCAL VALID-AUTHORIZATION INVARIANT / PRODUCTION-SAFE COVERAGE OPEN",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    safety: { localOnly: true, rpcUsed: false, endpointInventoryRead: false, endpointValuesPersisted: false, envFilesRead: false, privateKeysRead: false, deployedRecoverCalled: false, realValueUsed: false, forkCreated: false, liveMutation: false, broadcast: false, liveSigning: false, ephemeralFoundryVmSign: true },
    predecessor: { path: STEP1, runId: step1.runId, revision: step1.revision, sha256: hashFile(STEP1).sha256, sourceCommit: step1.source.commit, deployedAddress: deployed.address, deployedRuntimeKeccak256: deployed.runtime.keccak256, immutablePatchedRuntimeExact: deployed.reconstruction.exact },
    source: { commit: SOURCE_COMMIT, files: sources, semantics: sourceSemantics },
    packaging: { mode: "reviewer-calibrated-r2-with-fresh-local-build-replay", supersedes, r1TestSemanticsPreserved: true, newLiveReads: false },
    promotionWording: "Exact Recovery source passes bounded local valid-authorization/full-balance invariants; no outsider bypass, arbitrary target, permissionless extraction, or profit is established. Results do not prove all deployed Safe, token, hook, DataProvider, or current-registry behavior.",
    scopeQualifications: { completeProductionSafeAuthorizationProof: false, ecdsaOnlyLocalOwners: true, simplifiedSafeHookDataProviderMocks: true, notCovered },
    localHarness: { exactProductionModuleSource: true, fullSafeRuntimeDeployed: false, completeProductionSafeAuthorizationProof: false, safeBehaviorModeledFromPinnedSource: true, actualECDSARecoverUsed: true, erc1271OwnersCovered: false, thresholdScopes: ["1-of-1", "2-of-3", "3-of-3"], ephemeralOwnerKeysOnly: true },
    foundry: { compiler: "0.8.28", optimizer: true, optimizerRuns: 0, evmVersion: "cancun", offline: true, build: { exitStatus: build.status, outputBytes: build.outputBytes, outputSha256: build.outputSha256 }, firstRun: { exitStatus: first.status, outputBytes: first.outputBytes, outputSha256: first.outputSha256 }, replayRun: { exitStatus: second.status, outputBytes: second.outputBytes, outputSha256: second.outputSha256 }, fuzzSeed: FUZZ_SEED, fuzzRunsPerFuzzTest: FUZZ_RUNS, semanticReplayEqual: true },
    tests: { sourceFunctionCount: functions.length, passedFunctionCount: firstRows.length, deterministicTestCount: deterministicTests, fuzzTestCount: fuzzRows.length, fuzzCaseCount: fuzzRows.reduce((n, x) => n + x.fuzzRuns, 0), supportedOverlapLocalCaseCount: 7, totalExecutedCasesIncludingOverlapLoop: totalExecutedCases, passRows: firstRows },
    invariantMatrix: matrix,
    tokenMatrix: tokenMatrix(),
    distinctions: {
      cryptographicAuthorization: "Owner threshold signs chain/module/per-Safe module nonce/Safe/token/recipient/deadline; caller and amount are intentionally excluded.",
      currentBalanceSemantics: "A valid signature authorizes the then-current full signed-token balance, including deposits after signing and before execution.",
      safeModuleExecution: "A default module is auto-enabled; after default removal, execution requires both data-provider whitelist and local Safe module membership.",
      tokenCompatibility: "Safe checks low-level call success but ignores ERC20 returndata; recovery additionally requires the Safe token balance to strictly decrease.",
      healthAndDebt: "Recovery does not bypass the configured post hook. EtherFiHook invokes ensureHealth for non-Cash modules; an unhealthy revert rolls back token movement and nonce.",
      economicExploitability: "All locally successful value movement requires the modeled valid ECDSA owner quorum and a signed token/recipient. Accounting caveats and intended availability constraints are not permissionless exploits; complete production-Safe authorization remains unproven.",
    },
    observations,
    findings: { unauthorizedPathFound: false, allSignedFieldsBound: true, relayerNeutral: true, replayRejected: true, failedChecksRollback: true, supportedAssetsExcluded: true, fullCurrentBalanceSemantics: true, arbitraryTargetOrCalldataFound: false, healthCheckInvoked: true, permissionlessLossEstablished: false, profitablePathEstablished: false },
    blockers,
    nextReadOnlyStep: nextAction,
  };
  writeOwned(RAW, JSON.stringify(result, null, 2) + "\n");

  const report = `# ${result.signal} — EtherFi SafeAssetRecoveryModule invariant Step 2 reviewer r2\n\n**Classification:** \`${classification}\`  \n**Revision:** \`${REVISION}\`  \n**Run:** \`${runId}\`  \n**Production linkage:** source \`${SOURCE_COMMIT}\`; deployed runtime \`${deployed.runtime.keccak256}\`; immutable-patched exact \`${deployed.reconstruction.exact}\`  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n> Reviewer r2 supersedes r1 wording while preserving the passing tests. Exact Recovery source passes bounded local valid-authorization/full-balance invariants; no outsider bypass, arbitrary target, permissionless extraction, or profit is established. Results do not prove all deployed Safe, token, hook, DataProvider, or current-registry behavior.\n\n## Scope and production-Safe qualification\n\nThe exact production \`SafeAssetRecoveryModule\` source was compiled at the reviewed source commit and tested against ECDSA-only local owners plus simplified Safe, hook and DataProvider mocks. ${firstRows.length}/${functions.length} test functions passed, including ${fuzzRows[0].fuzzRuns} fixed-seed fuzz cases and seven supported-token overlap masks; fixed-seed semantic replay matched. No RPC, fork, deployed \`recover\`, real value, broadcast, or live signing was used.\n\nThis is **not complete production-Safe authorization proof**. It does not cover:\n\n${notCovered.map((x) => `- ${x}`).join("\n")}\n\n## Bounded authorization and balance result\n\n- In the ECDSA harness, threshold signatures bind chain ID, module, per-Safe module nonce, Safe, token, recipient and deadline. Covered mutations and cross-Safe/module/chain and same-signature replay fail with rollback.\n- Caller is relayer-neutral while recipient remains signed. Amount is intentionally unsigned: authorization sweeps the then-current full signed-token balance, including balance added after signing.\n- Deadline equality, expiry, pause, supported-token overlap, default/local/whitelist behavior, fixed token call, and 1-of-1, 2-of-3 and 3-of-3 ECDSA threshold cases pass within this harness.\n\n## Token accounting matrix\n\n| Behavior | Safe low-level call | Module result | Recipient/accounting |\n|---|---:|---|---|\n${result.tokenMatrix.map((x) => `| ${x.behavior} | ${x.safeCallSuccess} | ${x.moduleResult} | ${x.recipientAmount}; ${x.classification} |`).join("\n")}\n\nSafe execution ignores ERC20 returndata but requires call success; recovery also requires the Safe balance to strictly decrease. For fee or balance-changing tokens, \`AssetRecovered\` reports Safe-side balance delta and the recipient may receive less. This is \`OWNER-AUTHORIZED/INTEGRATION-ACCOUNTING-CAVEAT\`, with no unauthorized loss established.\n\n## Hook and health behavior\n\nThe modeled source path does **not** bypass the configured health flow: Safe post-hook calls health enforcement for non-Cash modules and an unhealthy revert rolls back transfer and nonce. This is \`DOCUMENTED/OPERATIONAL-AVAILABILITY-CONSTRAINT\`, not a privileged defect, unless a contrary product requirement is established. The contradictory recovery comment remains \`DOCUMENTATION-MISMATCH\`. Live hook/DataProvider configuration and current registry continuity are not proven here.\n\n## Calibrated observations\n\n${observations.map((x) => `- **${x.id} — ${x.classification} (${x.severity}):** ${x.impact} Preconditions: ${x.precondition} Mitigation: ${x.mitigation}`).join("\n")}\n\n## Blockers\n\n${blockers.map((x) => `- ${x}`).join("\n")}\n\n**nextReadOnlyStep:** ${nextAction}\n`;
  writeOwned(REPORT, report);
  const inbox = { findingId: "critical-etherfi-safe-asset-recovery-invariant", revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, supersedes, promotionWording: result.promotionWording, completeProductionSafeAuthorizationProof: false, summary: "Exact Recovery source passes bounded local valid-authorization/full-balance invariants; no outsider bypass, arbitrary target, permissionless extraction, or profit. Full deployed Safe/token/hook/current-registry behavior remains unproven.", testCounts: result.tests, observations, scopeQualifications: result.scopeQualifications, artifacts: [SOL_TEST, SCANNER, VALIDATOR, RAW, MANIFEST, REPORT], blockers, nextAction };
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# EtherFi SafeAssetRecovery invariant Step 2 reviewer r2 handoff\n\n- Run \`${runId}\`; revision \`${REVISION}\`; supersedes r1 \`${supersedes.runId}\`.\n- Exact Recovery source/runtime linkage is retained; ${firstRows.length} functions, ${FUZZ_RUNS} fixed-seed fuzz cases and 7 overlap masks PASS with semantic replay equality.\n- Promotion is bounded: no outsider bypass/arbitrary target/permissionless extraction/profit was found, but this is not complete production-Safe authorization proof.\n- ECDSA-only local owners and simplified Safe/hook/DataProvider mocks do not cover ERC-1271, the full malformed/duplicate/signature-array matrix, incoming-owner transitions, callbacks/reentrancy/adversarial tokens, live configuration, or current registry continuity.\n- SAR-I02 is \`OWNER-AUTHORIZED/INTEGRATION-ACCOUNTING-CAVEAT\`; Safe-side event delta may exceed recipient credit, with no unauthorized loss.\n- SAR-I03 is \`DOCUMENTED/OPERATIONAL-AVAILABILITY-CONSTRAINT\`; intended health gating unless product requirements say otherwise. SAR-I01 remains informational documentation mismatch.\n- Gates \`0/0/false\`; no RPC, fork, deployed call, real value, broadcast, or live signing.\n- Next: ${nextAction}\n`);
  const records = [SCANNER, VALIDATOR, SOL_TEST, RAW, REPORT, INBOX, HANDOFF, STEP1].map(hashFile);
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 2, revision: REVISION, runId, generatedAt, algorithm: "sha256", classification, category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, localOnly: true, noRpcOrFork: true, supersedes, sourceCommit: SOURCE_COMMIT, deployedRuntimeKeccak256: deployed.runtime.keccak256, immutablePatchedRuntimeExact: true, passedFunctionCount: firstRows.length, deterministicTestCount: deterministicTests, fuzzCaseCount: result.tests.fuzzCaseCount, fuzzSeed: FUZZ_SEED, supportedOverlapLocalCaseCount: 7, semanticReplayEqual: true, unauthorizedPathFound: false, completeProductionSafeAuthorizationProof: false, erc1271OwnersCovered: false, observationCount: observations.length, sarI02Classification: "OWNER-AUTHORIZED/INTEGRATION-ACCOUNTING-CAVEAT", sarI03Classification: "DOCUMENTED/OPERATIONAL-AVAILABILITY-CONSTRAINT", records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, revision: REVISION, classification, promotionWording: result.promotionWording, completeProductionSafeAuthorizationProof: false, testCounts: result.tests, fieldMatrix: matrix.map((x) => ({ id: x.id, result: x.result, tests: x.tests.length })), tokenMatrix: result.tokenMatrix, observations, blockers, artifacts: [SOL_TEST, SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF], gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, manifestAggregateSha256: aggregateSha256, nextReadOnlyStep: nextAction }) + "\n");
}

try { main(); } catch (e) { process.stderr.write(`scan failed: ${sanitizeOutput(e?.message || e)}\n`); process.exitCode = 1; }
