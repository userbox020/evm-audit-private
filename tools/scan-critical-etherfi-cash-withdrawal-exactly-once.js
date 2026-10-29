#!/usr/bin/env node
"use strict";

// Bounded local-only exact-source Cash withdrawal request/fulfillment review.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const NAME = "critical-etherfi-cash-withdrawal-exactly-once";
const SOURCE_COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8";
const AGENT = "critical-etherfi-cash-next-permissionless-20260724";
const REVISION = "cash-withdrawal-exactly-once-local-r1";
const CLASSIFICATION = "INFORMATIONAL/CONDITIONAL-NONSTANDARD-ERC20-WITHDRAWAL-CONSUMPTION/NO-ATTACKER-CAPTURE/PERMISSIONLESS-FULFILLMENT/EXACT-SOURCE";
const FUZZ_RUNS = 256;
const FUZZ_SEED = "0x434153482d5749544844524157414c2d45584143544c592d4f4e43452d5631";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const CLOSURE = `reports/raw/fast/${NAME}-source-closure.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const TEST = "targets/cash-v3/test/critical/CashWithdrawalExactlyOnce.t.sol";
const HARNESS = "targets/cash-v3/test/critical/CashWithdrawalExactlyOnceHarness.sol";
const LOCK = "targets/cash-v3/foundry.lock";
const SOURCE_SEEDS = [
  "src/modules/cash/CashModuleCore.sol",
  "src/modules/cash/CashModuleSetters.sol",
  "src/modules/cash/CashModuleStorageContract.sol",
  "src/safe/EtherFiSafe.sol",
  "src/libraries/CashVerificationLib.sol",
];

const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };
function canonical(v) { if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`; if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`; return JSON.stringify(v); }
function run(command, args, cwd, timeout = 1_200_000) { const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 128 * 1024 * 1024, windowsHide: true }); return { status: r.status, output: `${r.stdout || ""}\n${r.stderr || ""}`, error: r.error?.message || null }; }
function git(args, cwd = TARGET) { const r = run("git", args, cwd, 180_000); if (r.status !== 0) throw new Error(`git ${args[0]} failed`); return r.output.trim(); }
function writeOwned(rel, text) { if (![RAW, CLOSURE, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8"); }
function walk(dir, predicate, out = []) { if (!fs.existsSync(dir)) return out; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file, predicate, out); else if (predicate(file)) out.push(file); } return out; }

function remappings() {
  return fs.readFileSync(path.join(TARGET, "remappings.txt"), "utf8").split(/\r?\n/).map((x) => x.trim()).filter((x) => x.includes("=")).map((x) => {
    const i = x.indexOf("="); return { prefix: x.slice(0, i), replacement: x.slice(i + 1) };
  }).sort((a, b) => b.prefix.length - a.prefix.length);
}

function sourceClosure() {
  const maps = remappings();
  const queue = SOURCE_SEEDS.map((x) => path.resolve(TARGET, x));
  const seen = new Set(), unresolved = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (!file.startsWith(TARGET + path.sep) || !fs.existsSync(file)) { unresolved.push(file); continue; }
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']\s*;/g)) {
      const spec = match[1]; let resolved;
      if (spec.startsWith(".")) resolved = path.resolve(path.dirname(file), spec);
      else { const map = maps.find((x) => spec.startsWith(x.prefix)); resolved = map ? path.resolve(TARGET, map.replacement, spec.slice(map.prefix.length)) : path.resolve(TARGET, spec); }
      if (fs.existsSync(resolved)) queue.push(resolved); else unresolved.push(`${path.relative(TARGET, file)} -> ${spec}`);
    }
  }
  const files = [...seen].map((file) => {
    const rel = `targets/cash-v3/${path.relative(TARGET, file).replace(/\\/g, "/")}`;
    const row = hashFile(rel);
    return { ...row, bindingClass: rel.startsWith("targets/cash-v3/src/") ? "production-source-commit-bound" : "local-dependency-byte-bound" };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const diff = git(["diff", "--name-only", SOURCE_COMMIT, "--", "src"]);
  return {
    method: "recursive-solidity-import-resolution-with-remappings",
    seeds: SOURCE_SEEDS,
    complete: unresolved.length === 0,
    unresolved: [...new Set(unresolved)].sort(),
    productionSourceDiffAgainstCommit: diff ? diff.split(/\r?\n/).filter(Boolean) : [],
    files,
    aggregateSha256: sha(files.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}\0${x.bindingClass}`).join("\n")),
  };
}

function cleanCommitBuild() {
  const temp = path.join(os.tmpdir(), "opencode", "etherfi-cash-withdrawal-exactly-once");
  const work = path.join(temp, "source"), out = path.join(temp, "out"), cache = path.join(temp, "cache"), info = path.join(temp, "build-info");
  fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(temp, { recursive: true });
  git(["worktree", "add", "--detach", work, SOURCE_COMMIT]);
  try {
    const srcLib = path.join(TARGET, "lib"), dstLib = path.join(work, "lib"); fs.mkdirSync(dstLib, { recursive: true });
    for (const name of fs.readdirSync(srcLib)) {
      const destination = path.join(dstLib, name);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.symlinkSync(path.join(srcLib, name), destination, "junction");
    }
    const args = ["build", ...SOURCE_SEEDS, "--root", work, "--out", out, "--cache-path", cache, "--build-info", "--build-info-path", info, "--no-cache", "--offline"];
    const result = run("forge", args, work);
    const infos = walk(info, (x) => x.endsWith(".json"));
    let compiler = null, settingsSha256 = null, standardJsonInputSha256 = null, sourceCount = null;
    if (infos.length === 1) {
      const buildInfo = JSON.parse(fs.readFileSync(infos[0], "utf8"));
      compiler = { version: buildInfo.solcVersion, longVersion: buildInfo.solcLongVersion };
      settingsSha256 = sha(canonical(buildInfo.input?.settings || {}));
      standardJsonInputSha256 = sha(canonical(buildInfo.input || {}));
      sourceCount = Object.keys(buildInfo.input?.sources || {}).length;
    }
    return { exitStatus: result.status, outputBytes: Buffer.byteLength(result.output), outputSha256: sha(result.output), compiler, settingsSha256, standardJsonInputSha256, sourceCount, tempRetained: false };
  } finally {
    const lib = path.join(work, "lib");
    if (fs.existsSync(lib)) for (const name of fs.readdirSync(lib)) { const item = path.join(lib, name); try { if (fs.lstatSync(item).isSymbolicLink()) fs.unlinkSync(item); } catch {} }
    try { git(["worktree", "remove", "--force", work]); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function parseTests(output) {
  const tests = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\[(PASS|FAIL)\]\s+([^\s(]+(?:\([^)]*\))?)(?:\s+\(runs:\s*(\d+),[^)]*\)|\s+\(gas:\s*(\d+)\))?/);
    if (match) tests.push({ status: match[1], name: match[2], fuzzRuns: match[3] ? Number(match[3]) : null });
  }
  tests.sort((a, b) => a.name.localeCompare(b.name));
  const suite = output.match(/Suite result:\s+ok\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) skipped/);
  return { passCount: suite ? Number(suite[1]) : tests.filter((x) => x.status === "PASS").length, failCount: suite ? Number(suite[2]) : tests.filter((x) => x.status === "FAIL").length, skippedCount: suite ? Number(suite[3]) : 0, tests };
}

function runTests(tag) {
  const temp = path.join(os.tmpdir(), "opencode", `etherfi-cash-withdrawal-test-${tag}`);
  fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(temp, { recursive: true });
  try {
    const args = ["test", "--root", TARGET, "--out", path.join(temp, "out"), "--cache-path", path.join(temp, "cache"), "--no-cache", "--offline", "--match-path", "test/critical/CashWithdrawalExactlyOnce.t.sol", "--match-contract", "CashWithdrawalExactlyOnceTest", "--skip", "SafeAssetRecoveryInvariant", "--fuzz-runs", String(FUZZ_RUNS), "--fuzz-seed", FUZZ_SEED, "-vvv"];
    const result = run("forge", args, ROOT);
    return { exitStatus: result.status, outputBytes: Buffer.byteLength(result.output), outputSha256: sha(result.output), parsed: parseTests(result.output), tempRetained: false };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function semanticChecks() {
  const core = fs.readFileSync(path.join(TARGET, "src/modules/cash/CashModuleCore.sol"), "utf8");
  const storage = fs.readFileSync(path.join(TARGET, "src/modules/cash/CashModuleStorageContract.sol"), "utf8");
  const setters = fs.readFileSync(path.join(TARGET, "src/modules/cash/CashModuleSetters.sol"), "utf8");
  const safe = fs.readFileSync(path.join(TARGET, "src/safe/EtherFiSafe.sol"), "utf8");
  const verification = fs.readFileSync(path.join(TARGET, "src/libraries/CashVerificationLib.sol"), "utf8");
  const settlement = fs.readFileSync(path.join(TARGET, "src/settlement-dispatcher/SettlementDispatcherV2.sol"), "utf8");
  const checks = {
    processPermissionlessAfterSafeValidation: /function processWithdrawal\(address safe\) public onlyEtherFiSafe\(safe\) nonReentrant/.test(core),
    moduleRequestProcessorBound: /msg\.sender != \$\$\.pendingWithdrawalRequest\.recipient/.test(storage),
    transferRecipientStorageBound: /IERC20\.transfer\.selector, recipient, \$\$\.pendingWithdrawalRequest\.amounts\[i\]/.test(storage),
    requestDeletedAfterCalls: storage.indexOf("execTransactionFromModule(to") < storage.indexOf("delete $$.pendingWithdrawalRequest"),
    healthAfterDelete: storage.indexOf("delete $$.pendingWithdrawalRequest") < storage.indexOf("$.debtManager.ensureHealth(safe)"),
    safeIgnoresReturnData: /\(bool success,\) = to\[i\]\.call/.test(safe),
    requestDigestBindsTupleAndNonce: /REQUEST_WITHDRAWAL_METHOD, block\.chainid, safe, nonce, abi\.encode\(tokens, amounts, recipient\)/.test(verification),
    duplicateTokensRejected: /tokens\.checkDuplicates\(\)/.test(setters),
    settlementWithdrawRoleGated: /function withdrawLiquidAsset\([^]*?onlyRole\(SETTLEMENT_DISPATCHER_BRIDGER_ROLE\)/.test(settlement),
    settlementSettleRoleGated: /function settle\([^]*?onlyRole\(SETTLEMENT_DISPATCHER_BRIDGER_ROLE\)/.test(settlement),
  };
  if (!Object.values(checks).every(Boolean)) throw new Error("source semantic self-test failed");
  return { passed: Object.keys(checks).length, checks };
}

function sanitize(text) {
  if (/https?:\/\//i.test(text)) throw new Error("URL leak");
  const assignment = /(?:private[_ -]?key|seed[_ -]?phrase|mnemonic|authorization|cookie)["']?\s*[:=]\s*["']?([^\s,"'}]+)/ig;
  for (const match of text.matchAll(assignment)) if (!/^(?:false|null|none|never|not-used)$/i.test(match[1])) throw new Error("secret-pattern leak");
}

function main() {
  const generatedAt = new Date().toISOString();
  const head = git(["rev-parse", "HEAD"]);
  if (head !== SOURCE_COMMIT) throw new Error("source commit mismatch");
  const closure = sourceClosure();
  if (!closure.complete || closure.productionSourceDiffAgainstCommit.length) throw new Error("production source closure not commit-clean");
  const build = cleanCommitBuild();
  if (build.exitStatus !== 0 || build.compiler?.version !== "0.8.28") throw new Error("clean commit build failed");
  const primary = runTests("primary"), replay = runTests("replay");
  if (primary.exitStatus !== 0 || replay.exitStatus !== 0) throw new Error("withdrawal invariant tests failed");
  if (canonical(primary.parsed) !== canonical(replay.parsed)) throw new Error("deterministic semantic replay mismatch");
  const parsed = primary.parsed, fuzzTests = parsed.tests.filter((x) => x.fuzzRuns !== null);
  if (parsed.passCount !== 28 || parsed.failCount !== 0 || fuzzTests.length !== 3 || fuzzTests.some((x) => x.fuzzRuns < FUZZ_RUNS)) throw new Error("coverage gate failed");
  const semantics = semanticChecks();
  const closureText = JSON.stringify({ schemaVersion: 1, generatedAt, sourceCommit: SOURCE_COMMIT, ...closure }, null, 2) + "\n";
  writeOwned(CLOSURE, closureText);
  const runId = `etherfi-cash-withdrawal-exactly-once-${SOURCE_COMMIT.slice(0, 12)}-${hashFile(TEST).sha256.slice(0, 12)}`;
  const totalFuzzCases = fuzzTests.reduce((sum, row) => sum + row.fuzzRuns, 0);
  const result = {
    schemaVersion: 1,
    revision: REVISION,
    runId,
    generatedAt,
    agentId: AGENT,
    role: "critical-research",
    classification: CLASSIFICATION,
    selection: {
      selectedSurface: "CashModule signed withdrawal request plus permissionless processWithdrawal fulfillment",
      permissionlessEntrypoint: "CashModuleCore.processWithdrawal(address)",
      exactSourceVerified: true,
      rotation: "SettlementDispatcherV2 withdraw/redeem/bridge/settle candidates were rejected because every value-moving entry is bridger-role or owner gated; rotated to CashModule user withdrawal fulfillment.",
      excludedCompletedBranches: ["DebtManager donation/liquidation/repayment", "cashback privileged input", "BeHYPE fee grief", "SafeAssetRecovery", "Stargate", "HyperEVM", "privileged-only", "ordinary liquidation"],
    },
    conclusion: {
      status: "bounded-informational-conditional-integration-primitive-no-extraction",
      advances: false,
      branchPipeline: "1/5_SOURCE_SEMANTIC_PRIMITIVE_CONDITIONAL_NO_ATTACKER_VALUE",
      extractionPipeline: "0/5_NO_ATTACKER_VALUE_PATH",
      globalHighestPipeline: "DebtManager donation 2/5 WATCH unchanged",
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      reason: "Standard-token request/fulfillment is recipient-bound, replay-safe, atomic, and exactly once. Because EtherFiSafe checks only low-level call success and ignores ERC20 return data, a whitelisted token returning false or truthfully returning after a partial transfer causes CashModule to emit success and delete the request without full delivery. The permissionless caller captures zero and undelivered value remains in the Safe.",
    },
    safety: { localOnly: true, network: false, rpcInventoryRead: false, fork: false, privateKeysRead: false, signedActions: false, broadcasts: false, productionMutation: false },
    source: { commit: head, expectedCommit: SOURCE_COMMIT, commitMatch: true, productionSourceBinding: "commit-bound", cleanCommitBuild: build, recursiveClosure: hashFile(CLOSURE) },
    customHarness: { binding: "local-byte-hash-bound", claimedAsCommitArtifact: false, files: [hashFile(TEST), hashFile(HARNESS)] },
    foundryLock: { binding: "local-byte-hash-bound", claimedAsCommitArtifact: false, file: hashFile(LOCK) },
    tests: { passCount: parsed.passCount, failCount: parsed.failCount, skippedCount: parsed.skippedCount, testCount: parsed.tests.length, unitTestCount: parsed.tests.length - fuzzTests.length, fuzzPropertyCount: fuzzTests.length, fuzzRunsPerProperty: FUZZ_RUNS, totalFuzzCases, fuzzSeed: FUZZ_SEED, deterministicSemanticReplay: true, primaryOutputSha256: primary.outputSha256, replayOutputSha256: replay.outputSha256, tests: parsed.tests },
    invariant: "For one signed Safe/nonce/tokens/amounts/recipient request, permissionless fulfillment may deliver each raw amount to only the bound recipient once; failed or partial delivery must not consume the entitlement; caller gain must remain zero; aggregate balances must conserve.",
    invariantAssessment: {
      standardTokenExactlyOncePass: true,
      duplicateIdReplayPass: true,
      failuresRetriesAtomicPass: true,
      reentrancyPass: true,
      orderingReplacementCancellationPass: true,
      recipientBindingPass: true,
      authorizationBindingPass: true,
      rawDecimalConservationPass: true,
      strictPartialFulfillmentPass: false,
      permissionlessAttackerCaptureFound: false,
    },
    deltas: {
      returnFalse: { requestedRaw: "28000000", deliveredRaw: "0", recipientShortfallRaw: "28000000", safeRetainedRaw: "28000000", attackerGainRaw: "0", sourceRequestConsumed: true, strictReferencePending: true },
      partialTrue: { requestedRaw: "30000000", deliveredRaw: "15000000", recipientShortfallRaw: "15000000", safeRetainedRaw: "15000000", attackerGainRaw: "0", sourceRequestConsumed: true, strictReferencePending: true },
      standard: { duplicatePayoutRaw: "0", attackerGainRaw: "0", finalPendingRaw: "0", payoutCount: 1 },
    },
    coverage: {
      failuresAndRetries: ["revert-before-transfer", "revert-after-transfer", "event failure", "post-delete health failure", "insufficient fulfillment balance", "multi-token later-leg failure"],
      callbacks: ["token callback", "recipient callback", "event-emitter callback"],
      ordering: ["early process", "duplicate process", "request replacement", "cancel-then-process", "process-then-cancel", "module whitelist removal"],
      binding: ["safe nonce replay", "recipient", "amount", "duplicate tokens", "module requester"],
      decimals: [6, 8, 18],
    },
    findings: [
      {
        id: "CW-01",
        severity: "Informational / conditional token-integration availability",
        status: "CONDITIONAL_NO_EXTRACTION",
        title: "Withdrawal request is consumed when ERC20 transfer returns false or transfers less than requested",
        codeReferences: ["src/safe/EtherFiSafe.sol:186-205", "src/modules/cash/CashModuleStorageContract.sol:298-332"],
        preconditions: ["The token is controller-whitelisted for withdrawals", "Safe owners sign a request for that token", "The token returns low-level success while returning false or transferring less than the requested amount", "Anyone calls processWithdrawal after its delay"],
        impact: "The request is emitted as processed and deleted without full recipient delivery. Fixed false-return shortfall is 28,000,000 raw; fixed partial-return shortfall is 15,000,000 raw. All undelivered value remains in the Safe and the caller receives zero, so no extraction or protocol asset loss is established.",
        evidence: ["28/28 tests", "768 fixed-seed fuzz cases", "strict reference remains pending on incomplete delivery while exact source consumes"],
        mitigation: "Use SafeERC20-style optional-return validation in Safe module execution or make CashModule verify recipient balance deltas per token before emitting and deleting; document/reject fee-on-transfer and partial-transfer assets.",
      },
      {
        id: "CW-02",
        severity: "Bounded pass",
        status: "NO_PERMISSIONLESS_EXTRACTION_FOUND",
        title: "Standard-token withdrawal fulfillment is bound and exactly once in the tested state machine",
        codeReferences: ["src/libraries/CashVerificationLib.sol:95-97", "src/modules/cash/CashModuleSetters.sol:177-181", "src/modules/cash/CashModuleStorageContract.sol:298-332"],
        preconditions: ["Valid signed request", "Mature delay", "Standard ERC20 transfer behavior"],
        impact: "Permissionless processors cannot redirect funds, replay a nonce, duplicate payout, retain reusable paid state, or capture caller value across tested failures, retries, callbacks, replacements, cancellation races, module requests, and 6/8/18-decimal raw amounts.",
        evidence: ["attackerGainRaw=0", "duplicatePayoutRaw=0", "three fuzz properties with 256 runs each"],
        mitigation: "Retain tuple/nonce binding and nonReentrant coverage; add the delivery-delta check from CW-01.",
      },
    ],
    semantics,
    nextGate: "Independent offline source/harness review. Only if exact deployed withdrawal tokens include nonstandard false/partial-transfer behavior should a separate read-only fixed-pin token/runtime/config binding be proposed. No fork or signed action is justified.",
  };

  const rawText = JSON.stringify(result, null, 2) + "\n";
  const reportText = `# Ether.fi Cash withdrawal request/fulfillment exactly-once review\n\n**Signal:** ⚪ CLEAN for permissionless extraction; informational conditional integration discrepancy.  \n**Classification:** \`${CLASSIFICATION}\`  \n**Scope:** exact source commit \`${SOURCE_COMMIT}\`, local-only; no network or fork.\n\n## Selected surface\n\nSettlementDispatcher value-moving entries are bridger-role/owner gated, so the test rotated to the signed CashModule withdrawal request and permissionless \`processWithdrawal(address)\` fulfillment path.\n\n## Result\n\nFor standard ERC20 behavior, the path is recipient-bound, nonce-replay-resistant, transaction-atomic, and exactly once. The arbitrary processor received **0 raw**, duplicate payout was **0**, and raw amounts were conserved across 6, 8, and 18 decimals. Failure-before/after-transfer, later-leg failure, event failure, post-delete health failure, token/recipient/event callbacks, retries, request replacement, cancellation ordering, duplicate IDs, and module processing did not produce attacker value.\n\nA conditional integration discrepancy exists: \`EtherFiSafe.execTransactionFromModule\` checks low-level call success but ignores ERC20 return data. A token returning \`false\` caused the request to be deleted with **28,000,000 raw requested / 0 delivered**. A partial-return token caused **30,000,000 requested / 15,000,000 delivered**. The undelivered value remained in the Safe and the processor gained **0**, so this is not an extraction finding.\n\n## Evidence\n\n- **28/28** tests: **25** unit plus **3** fuzz properties.\n- **${totalFuzzCases}** fixed-seed fuzz cases and deterministic semantic replay.\n- Exact clean build with solc **0.8.28** and recursive source closure.\n- References: \`src/safe/EtherFiSafe.sol:186-205\`; \`src/modules/cash/CashModuleStorageContract.sol:298-332\`; \`src/libraries/CashVerificationLib.sol:95-97\`.\n\n## Mitigation\n\nValidate optional ERC20 return data in Safe execution and/or verify recipient balance deltas before emitting and deleting a withdrawal request. Explicitly reject unsupported fee-on-transfer or partial-transfer assets.\n\n## Pipeline and next gate\n\nBranch: \`1/5_SOURCE_SEMANTIC_PRIMITIVE_CONDITIONAL_NO_ATTACKER_VALUE\`; extraction: \`0/5\`. Global highest pipeline remains **DebtManager donation 2/5 WATCH**. Next gate is independent offline review; deployed read-only binding is warranted only if a configured withdrawal token has nonstandard transfer behavior.\n`;
  const inbox = { findingId: NAME, agentId: AGENT, role: "critical-research", status: "bounded-informational-no-extraction", classification: CLASSIFICATION, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "Permissionless standard-token withdrawal fulfillment is exactly once with zero caller gain; exact source consumes false/partial-return token requests without full delivery, but value remains in the Safe and no extraction is established.", artifacts: [RAW, REPORT, MANIFEST], nextAction: result.nextGate };
  const handoffText = `# Handoff: ${NAME}\n\n- Selected exact-source surface: signed CashModule withdrawal request plus permissionless processWithdrawal fulfillment.\n- SettlementDispatcher candidates rotated out as bridger-role/owner gated.\n- Classification: \`${CLASSIFICATION}\`.\n- Tests: 28/28; 3 fuzz properties; ${totalFuzzCases} fixed-seed cases; deterministic semantic replay.\n- Standard-token attacker gain and duplicate payout: zero.\n- Conditional primitive: false-return request consumes 28,000,000 raw with zero delivery; partial-return consumes 30,000,000 with 15,000,000 delivery. Undelivered value remains in Safe; caller gain zero.\n- Branch 1/5 conditional semantic primitive, extraction 0/5; global DebtManager donation remains 2/5 WATCH.\n- No network, fork, signing, broadcast, or production mutation.\n- Validate with \`node ${VALIDATOR}\`.\n`;
  for (const text of [closureText, rawText, reportText, JSON.stringify(inbox), handoffText]) sanitize(text);
  writeOwned(RAW, rawText);
  writeOwned(REPORT, reportText);
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, handoffText);
  const records = [
    SCANNER, VALIDATOR, RAW, CLOSURE, REPORT, INBOX, HANDOFF, TEST, HARNESS, LOCK,
    "targets/cash-v3/src/modules/cash/CashModuleCore.sol",
    "targets/cash-v3/src/modules/cash/CashModuleSetters.sol",
    "targets/cash-v3/src/modules/cash/CashModuleStorageContract.sol",
    "targets/cash-v3/src/safe/EtherFiSafe.sol",
    "targets/cash-v3/src/libraries/CashVerificationLib.sol",
    "targets/cash-v3/src/interfaces/ICashModule.sol",
  ].map(hashFile);
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, records, aggregateSha256: sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")) };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  sanitize(manifestText);
  writeOwned(MANIFEST, manifestText);
  console.log(JSON.stringify({ ok: true, runId, classification: CLASSIFICATION, selectedSurface: result.selection.permissionlessEntrypoint, tests: `${parsed.passCount}/${parsed.tests.length}`, fuzzCases: totalFuzzCases, branchPipeline: result.conclusion.branchPipeline, extractionPipeline: result.conclusion.extractionPipeline, routePositive: 0, manifestAggregateSha256: manifest.aggregateSha256 }, null, 2));
}

try { main(); } catch (error) { console.error(`cash withdrawal exactly-once scan failed: ${String(error?.message || error).slice(0, 400)}`); process.exit(1); }
