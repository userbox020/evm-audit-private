#!/usr/bin/env node
"use strict";

// Bounded local-only exact-source cashback accounting review. No endpoint inventory or network access.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const NAME = "critical-etherfi-cashback-exactly-once";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const CLOSURE = `reports/raw/fast/${NAME}-source-closure.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const TEST = "targets/cash-v3/test/critical/CashbackExactlyOnce.t.sol";
const HARNESS = "targets/cash-v3/test/critical/CashbackExactlyOnceHarness.sol";
const LOCK = "targets/cash-v3/foundry.lock";
const SOURCE_COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8";
const CLASSIFICATION = "INFORMATIONAL/PENDING_REVIEW/PRIVILEGED-WALLET-UNBOUND-CASHBACK-INPUT/DUPLICATE-PAYOUT-AND-RECIPIENT-REDIRECT/NO-PERMISSIONLESS-TRIGGER/EXACT-SOURCE";
const REVISION = "cashback-exactly-once-local-r1";
const AGENT = "critical-etherfi-cashback-exactly-once-20260724";
const FUZZ_RUNS = 256;
const FUZZ_SEED = "0x434153484241434b2d45584143544c592d4f4e43452d56310000000000000000";
const SOURCE_SEEDS = ["src/cashback-dispatcher/CashbackDispatcher.sol", "src/modules/cash/CashModuleCore.sol", "src/modules/cash/CashModuleStorageContract.sol", "src/modules/cash/CashEventEmitter.sol"];

const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };
function canonical(v) { if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`; if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`; return JSON.stringify(v); }
function writeOwned(rel, text) { if (![RAW, CLOSURE, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8"); }
function run(command, args, cwd, timeout = 1_200_000) { const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 128 * 1024 * 1024, windowsHide: true }); return { status: r.status, output: `${r.stdout || ""}\n${r.stderr || ""}`, error: r.error?.message || null }; }
function git(args, cwd = TARGET) { const r = run("git", args, cwd, 180_000); if (r.status !== 0) throw new Error(`git ${args[0]} failed`); return r.output.trim(); }
function walk(dir, predicate, out = []) { if (!fs.existsSync(dir)) return out; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, predicate, out); else if (predicate(p)) out.push(p); } return out; }

function parseRemappings() {
  return fs.readFileSync(path.join(TARGET, "remappings.txt"), "utf8").split(/\r?\n/).map((x) => x.trim()).filter((x) => x.includes("=")).map((x) => {
    const i = x.indexOf("="); return { prefix: x.slice(0, i), replacement: x.slice(i + 1) };
  }).sort((a, b) => b.prefix.length - a.prefix.length);
}

function sourceClosure() {
  const remappings = parseRemappings();
  const queue = SOURCE_SEEDS.map((x) => path.resolve(TARGET, x));
  const seen = new Set(), unresolved = [];
  while (queue.length) {
    const file = queue.shift(); if (seen.has(file)) continue;
    if (!file.startsWith(TARGET + path.sep) || !fs.existsSync(file)) { unresolved.push(file); continue; }
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']\s*;/g)) {
      const spec = m[1]; let resolved;
      if (spec.startsWith(".")) resolved = path.resolve(path.dirname(file), spec);
      else { const remap = remappings.find((x) => spec.startsWith(x.prefix)); resolved = remap ? path.resolve(TARGET, remap.replacement, spec.slice(remap.prefix.length)) : path.resolve(TARGET, spec); }
      if (fs.existsSync(resolved)) queue.push(resolved); else unresolved.push(`${path.relative(TARGET, file)} -> ${spec}`);
    }
  }
  const sourceDiff = git(["diff", "--name-only", SOURCE_COMMIT, "--", "src"]);
  const files = [...seen].map((file) => {
    const rel = `targets/cash-v3/${path.relative(TARGET, file).replace(/\\/g, "/")}`;
    const record = hashFile(rel);
    const targetRel = rel.slice("targets/cash-v3/".length);
    return { ...record, bindingClass: targetRel.startsWith("src/") ? "production-source-commit-bound" : "local-dependency-byte-bound" };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return {
    method: "recursive-solidity-import-resolution-with-remappings", seeds: SOURCE_SEEDS, complete: unresolved.length === 0,
    unresolved: [...new Set(unresolved)].sort(), productionSourceDiffAgainstCommit: sourceDiff ? sourceDiff.split(/\r?\n/).filter(Boolean) : [],
    files, aggregateSha256: sha(files.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}\0${x.bindingClass}`).join("\n")),
  };
}

function cleanCommitBuild() {
  const temp = path.join(os.tmpdir(), "opencode", "etherfi-cashback-exactly-once");
  const work = path.join(temp, "source"), out = path.join(temp, "out"), cache = path.join(temp, "cache"), info = path.join(temp, "build-info");
  fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(temp, { recursive: true });
  git(["worktree", "add", "--detach", work, SOURCE_COMMIT]);
  try {
    const srcLib = path.join(TARGET, "lib"), dstLib = path.join(work, "lib"); fs.mkdirSync(dstLib, { recursive: true });
    for (const name of fs.readdirSync(srcLib)) { const dst = path.join(dstLib, name); fs.rmSync(dst, { recursive: true, force: true }); fs.symlinkSync(path.join(srcLib, name), dst, "junction"); }
    const args = ["build", "src/cashback-dispatcher/CashbackDispatcher.sol", "src/modules/cash/CashModuleCore.sol", "--root", work, "--out", out, "--cache-path", cache, "--build-info", "--build-info-path", info, "--no-cache", "--offline"];
    const result = run("forge", args, work);
    const infos = walk(info, (x) => x.endsWith(".json"));
    let compiler = null, settingsSha256 = null, inputSha256 = null, sourceCount = null;
    if (infos.length === 1) {
      const buildInfo = JSON.parse(fs.readFileSync(infos[0], "utf8"));
      compiler = { version: buildInfo.solcVersion, longVersion: buildInfo.solcLongVersion };
      settingsSha256 = sha(canonical(buildInfo.input?.settings || {})); inputSha256 = sha(canonical(buildInfo.input || {})); sourceCount = Object.keys(buildInfo.input?.sources || {}).length;
    }
    return { exitStatus: result.status, outputBytes: Buffer.byteLength(result.output), outputSha256: sha(result.output), compiler, settingsSha256, standardJsonInputSha256: inputSha256, sourceCount, tempRetained: false };
  } finally {
    const lib = path.join(work, "lib");
    if (fs.existsSync(lib)) for (const name of fs.readdirSync(lib)) { const p = path.join(lib, name); try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch {} }
    try { git(["worktree", "remove", "--force", work]); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function parseTests(output) {
  const tests = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\[(PASS|FAIL)\]\s+([^\s(]+(?:\([^)]*\))?)(?:\s+\(runs:\s*(\d+),[^)]*\)|\s+\(gas:\s*(\d+)\))?/);
    if (m) tests.push({ status: m[1], name: m[2], fuzzRuns: m[3] ? Number(m[3]) : null, gas: m[4] ? Number(m[4]) : null });
  }
  tests.sort((a, b) => a.name.localeCompare(b.name));
  const suite = output.match(/Suite result:\s+ok\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) skipped/);
  return { passCount: suite ? Number(suite[1]) : tests.filter((x) => x.status === "PASS").length, failCount: suite ? Number(suite[2]) : tests.filter((x) => x.status === "FAIL").length, skippedCount: suite ? Number(suite[3]) : 0, tests };
}

function runTests(tag) {
  const temp = path.join(os.tmpdir(), "opencode", `etherfi-cashback-test-${tag}`);
  fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(temp, { recursive: true });
  try {
    const args = ["test", "--root", TARGET, "--out", path.join(temp, "out"), "--cache-path", path.join(temp, "cache"), "--no-cache", "--offline", "--match-path", "test/critical/CashbackExactlyOnce.t.sol", "--match-contract", "CashbackExactlyOnceTest", "--skip", "SafeAssetRecoveryInvariant", "--fuzz-runs", String(FUZZ_RUNS), "--fuzz-seed", FUZZ_SEED, "-vvv"];
    const result = run("forge", args, ROOT);
    return { exitStatus: result.status, outputBytes: Buffer.byteLength(result.output), outputSha256: sha(result.output), parsed: parseTests(result.output), tempRetained: false };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function selfTests() {
  const source = fs.readFileSync(abs("targets/cash-v3/src/modules/cash/CashModuleCore.sol"), "utf8");
  const dispatcher = fs.readFileSync(abs("targets/cash-v3/src/cashback-dispatcher/CashbackDispatcher.sol"), "utf8");
  const checks = {
    txIdPerSafe: /transactionCleared\[txId\]/.test(source), cashModuleSpendNonReentrant: /function spend\([^]*?nonReentrant onlyEtherFiWallet/.test(source),
    clearNonReentrant: /function clearPendingCashback\([^]*?nonReentrant whenNotPaused/.test(source), duplicateCashbackRowsNotRejected: !/cashbacks\.checkDuplicates/.test(source),
    arbitraryRecipientForwarded: /cashback\(to, token, amountInUsd\)/.test(source), pendingDeleteAfterExternalCall: source.indexOf("clearPendingCashback(user, token, amountInUsd)") < source.indexOf("delete $.pendingCashbackForTokenInUsd[user][token]"),
    dispatcherOnlyCashModule: /msg\.sender != address\(\$\.cashModule\)/.test(dispatcher), dispatcherPayoutNoNonReentrant: /function cashback\([^]*?external whenNotPaused/.test(dispatcher) && !/function cashback\([^]*?nonReentrant/.test(dispatcher),
    pendingClearNotPaused: /function clearPendingCashback\([^]*?external returns/.test(dispatcher), zeroRecipientContinue: /if \(to == address\(0\)\) continue/.test(source),
  };
  if (!Object.values(checks).every(Boolean)) throw new Error("source semantic self-test failed");
  return { passed: Object.keys(checks).length, checks };
}

function sanitize(text) {
  if (/https?:\/\//i.test(text)) throw new Error("URL leak");
  // Reject credential-shaped assignments, not harmless safety metadata such as
  // `privateKeysRead: false` or prose explaining that no credentials were used.
  const assignment = /(?:private[_ -]?key|seed[_ -]?phrase|mnemonic|authorization|cookie)["']?\s*[:=]\s*["']?([^\s,"'}]+)/ig;
  for (const match of text.matchAll(assignment)) {
    if (!/^(?:false|null|none|never|not-used)$/i.test(match[1])) throw new Error("secret-pattern leak");
  }
}

function main() {
  const generatedAt = new Date().toISOString();
  const head = git(["rev-parse", "HEAD"]); if (head !== SOURCE_COMMIT) throw new Error("source commit mismatch");
  const closure = sourceClosure(); if (!closure.complete || closure.productionSourceDiffAgainstCommit.length) throw new Error("production source closure not commit-clean");
  const build = cleanCommitBuild(); if (build.exitStatus !== 0 || build.compiler?.version !== "0.8.28") throw new Error("clean commit build failed");
  const primary = runTests("primary"), replay = runTests("replay");
  if (primary.exitStatus !== 0 || replay.exitStatus !== 0) throw new Error("cashback invariant tests failed");
  if (canonical(primary.parsed) !== canonical(replay.parsed)) throw new Error("deterministic semantic replay mismatch");
  const parsed = primary.parsed;
  const fuzzTests = parsed.tests.filter((x) => x.fuzzRuns !== null);
  if (parsed.passCount !== 24 || parsed.failCount !== 0 || fuzzTests.length !== 3 || fuzzTests.some((x) => x.fuzzRuns < FUZZ_RUNS)) throw new Error("coverage gate failed");
  const self = selfTests();
  const closureText = JSON.stringify({ schemaVersion: 1, generatedAt, sourceCommit: SOURCE_COMMIT, ...closure }, null, 2) + "\n";
  writeOwned(CLOSURE, closureText);
  const runId = `etherfi-cashback-exactly-once-${SOURCE_COMMIT.slice(0, 12)}-${hashFile(TEST).sha256.slice(0, 12)}`;
  const findings = [
    {
      id: "CB-01", severity: "Informational / privileged-input trust", status: "PENDING_REVIEW", title: "Cashback list is not bound, deduplicated, recipient-restricted, or capped by spend",
      preconditions: ["Caller holds ETHER_FI_WALLET_ROLE", "A valid Safe spend succeeds", "CashbackDispatcher has payout-token inventory"],
      evidence: ["CashModuleCore.sol:339-346", "CashModuleCore.sol:517-539", "CashbackDispatcher.sol:228-243"],
      impact: "One authorized spend can include repeated identical recipient/token rows and arbitrary recipient/amount rows. The fixed duplicate case pays 6,000,000 raw while the exactly-once reference pays 3,000,000; the fixed redirect case pays 1,000,000,000 raw against a 100,000,000-USD6 spend. Source imposes no cashback-to-spend cap beyond available dispatcher inventory.",
      attackerReachability: "No permissionless trigger chain was found. Direct dispatcher calls fail OnlyCashModule; the primitive requires the privileged wallet/backend or its compromise.",
      mitigation: "Bind a canonical cashback-plan hash to safe/txId/chain, enforce permitted recipients and per-type policy, aggregate/reject duplicate recipient-token-type rows, and cap total cashback against spend before any external call."
    },
    {
      id: "CB-02", severity: "Informational", status: "BOUNDED_PASS", title: "Pending retry path is transaction-atomic and reentrancy-resistant through CashModule",
      preconditions: ["Existing pending USD entitlement", "Anyone calls public clearPendingCashback or a later spend retries it"],
      evidence: ["CashModuleCore.sol:466-508", "CashbackDispatcher.sol:254-269"],
      impact: "No duplicate or redirect was observed across failure-before/after-transfer, false-return, event failure, token callback, Safe recursion, batch duplicate, or retry ordering. Successful payout and pending deletion commit atomically; failed calls roll back token deltas and retain one pending amount.",
      attackerReachability: "Clear is permissionless but recipient and token are storage-bound; caller receives no payout.",
      mitigation: "Retain nonReentrant on every CashModule entry and consider checks-effects-interactions or an explicit entitlement state machine for audit clarity."
    },
    {
      id: "CB-03", severity: "Informational / availability-policy", status: "OBSERVED", title: "Pending clear bypasses dispatcher pause and token removal can strand entitlement",
      preconditions: ["Pending entitlement exists"], evidence: ["CashbackDispatcher.sol:228", "CashbackDispatcher.sol:254", "CashModuleCore.sol:496-508"],
      impact: "New direct cashback is deferred while paused, but pending clear remains payable. Removing a cashback token makes pending retrieval revert-and-retain until re-whitelisted. No duplicate payout or caller redirection results.",
      attackerReachability: "Permissionless clear can trigger the pause-bypassing payout only to the stored recipient.",
      mitigation: "Apply a documented pause policy consistently and provide a migration path for pending entitlements when token configuration changes."
    },
    {
      id: "CB-04", severity: "Informational / bounded availability and rounding", status: "OBSERVED", title: "Zero recipient loops to OOG and zero-rounded rewards are consumed",
      preconditions: ["Privileged wallet supplies a zero recipient, or a configured amount rounds below one token unit"], evidence: ["CashModuleCore.sol:520-530", "CashbackDispatcher.sol:210-217", "CashbackDispatcher.sol:235-236"],
      impact: "A zero recipient causes atomic OOG rollback because continue skips the loop increment. A one-USD6-raw test at a 3-USD/token price increments earned accounting by one while paying zero and creating no pending entitlement.",
      attackerReachability: "Malformed cashback input requires the wallet role; rounding can affect a legitimate recipient but yields no extraction.",
      mitigation: "Increment before continue or reject zero recipients; define minimum payout accumulation rather than treating zero conversion as paid."
    }
  ];
  const result = {
    schemaVersion: 1, revision: REVISION, runId, generatedAt, agentId: AGENT, role: "critical-research", classification: CLASSIFICATION,
    conclusion: { status: "source-candidate-pending-review", advances: false, branchPipeline: "1/5_SOURCE_PRIMITIVE_PENDING_REVIEW", routePositive: 0, executableNow: 0, signedActionJustified: false, reason: "The exact source violates strict exactly-once policy for privileged wallet-supplied cashback rows, but no permissionless or Safe-owner trigger reaches spend and direct dispatcher calls are CashModule-only." },
    safety: { localOnly: true, network: false, rpcInventoryRead: false, fork: false, privateKeysRead: false, signedActions: false, broadcasts: false, productionMutation: false },
    source: { commit: head, expectedCommit: SOURCE_COMMIT, commitMatch: true, productionSourceBinding: "commit-bound", cleanCommitBuild: build, recursiveClosure: hashFile(CLOSURE) },
    customHarness: { binding: "local-byte-hash-bound", claimedAsCommitArtifact: false, files: [hashFile(TEST), hashFile(HARNESS)] },
    foundryLock: { binding: "local-byte-hash-bound", claimedAsCommitArtifact: false, file: hashFile(LOCK) },
    tests: { passCount: parsed.passCount, failCount: parsed.failCount, skippedCount: parsed.skippedCount, testCount: parsed.tests.length, unitTestCount: parsed.tests.length - fuzzTests.length, fuzzPropertyCount: fuzzTests.length, fuzzRunsPerProperty: FUZZ_RUNS, totalFuzzCases: fuzzTests.reduce((n, x) => n + x.fuzzRuns, 0), fuzzSeed: FUZZ_SEED, deterministicSemanticReplay: true, primaryOutputSha256: primary.outputSha256, replayOutputSha256: replay.outputSha256, tests: parsed.tests },
    stateMachine: {
      spend: ["onlyEtherFiWallet + valid Safe + nonReentrant", "safe-scoped txId checked and marked", "spend/borrow transfer completes", "each wallet-supplied cashback row retries old pending", "earned USD increments", "dispatcher pays or pending USD increments"],
      pendingClear: ["permissionless CashModule entry is nonReentrant", "stored recipient/token/amount read", "dispatcher OnlyCashModule transfer attempt", "on paid: event then pending delete in same transaction", "on false/revert: pending remains"],
      treasury: "No separate treasury callback exists in this source scope; CashbackDispatcher token inventory is the payout treasury. Owner-only withdrawFunds is independent privileged inventory withdrawal.",
    },
    invariant: "One authorized payment identity may create at most one entitlement per canonical recipient-token-type and at most one payout; failures and retries must not duplicate, redirect, or retain reusable paid state.",
    invariantAssessment: { overallPass: false, duplicateAuthorizedInputPass: false, retryAndCallbackExactlyOncePass: true, redirectResistancePass: false, permissionlessTriggerFound: false, crossInstanceGlobalIdempotencyPass: false },
    deltas: {
      fixedDuplicate: { amountPerRowRaw: "3000000", duplicateRows: 2, sourceRecipientPayoutRaw: "6000000", referenceRecipientPayoutRaw: "3000000", excessPayoutRaw: "3000000" },
      fuzzDuplicate: { rowsMin: 2, rowsMax: 8, maximumObservedMultiplier: 8, referenceMultiplier: 1 },
      privilegedRedirect: { spendUsd6Raw: "100000000", attackerPayoutTokenRaw: "1000000000", payoutToSpendRatio: "10", sourceCap: null },
      crossInstanceSameId: { sourcePayoutRaw: "34000000", referencePayoutRaw: "17000000", excessPayoutRaw: "17000000" },
      retries: { successfulEntitlementPayoutCount: 1, finalPendingUsdRaw: "0", callerPayoutRaw: "0", duplicatePayoutRaw: "0" },
      rounding: { earnedCreditUsd6Raw: "1", payoutTokenRaw: "0", pendingUsd6Raw: "0" },
    },
    surfaces: {
      onlyCashModule: "PASS for direct dispatcher calls", nonReentrant: "PASS through CashModule spend/clear, token callback, wallet-contract callback, and Safe recursion", pendingOrdering: "PASS by transaction atomicity; delete follows transfer but rollback prevents reusable paid state", duplicateIds: "same Safe/module rejects; same ID is accepted by a second module/chain instance", sameSafeTokens: "pending accounting is token-separated", callbacks: "false-return, revert-before, revert-after, event failure, token callback, authorized-wallet callback, Safe recursion covered", batches: "duplicate clear users/tokens reject atomically; duplicate cashback rows are accepted and paid", pauseConfig: "pending clear remains active while dispatcher paused; unwhitelist strands then re-whitelist recovers", roundingCaps: "zero conversion is treated paid; cashback amount/recipient not capped or policy-bound" },
    findings, selfTests: self,
    nextDeploymentGate: "After independent source review, perform a separate read-only fixed-pin binding of CashModule/CashbackDispatcher runtimes and linkage, ETHER_FI_WALLET holders, current cashback tokens/prices, dispatcher inventories, pause state, and documented cross-chain payment-ID/cashback-plan semantics. Do not fork or sign unless a non-privileged trigger becomes concrete.",
    remediationSummary: "Add canonical per-payment cashback-plan binding and consumption, duplicate rejection/aggregation, recipient/type policy and spend-relative caps; keep retry state atomic and provide explicit pause/config migration/minimum-payout semantics."
  };
  const rawText = JSON.stringify(result, null, 2) + "\n";
  const reportText = `# Ether.fi Cash cashback exactly-once review\n\n**Classification:** \`${CLASSIFICATION}\`  \n**Scope:** local-only exact source at \`${SOURCE_COMMIT}\`; no network or fork.\n\n## Finding\n\nThe retry path resisted duplicate payout in all bounded failure, callback, reordering, and retry tests. However, strict exactly-once policy fails at the authorized-input boundary: \`CashModuleCore.spend\` accepts wallet-supplied cashback rows without binding them to \`txId\`, deduplicating recipient/token/type, restricting recipients, or capping cashback against spend. Two identical rows paid **6,000,000 raw** versus **3,000,000 raw** in the reference; fuzz reached **8x**. An authorized row redirected **1,000,000,000 raw** to an arbitrary recipient on a **100,000,000 USD6-raw** spend.\n\n## Preconditions and impact\n\nThis requires \`ETHER_FI_WALLET_ROLE\` (or its compromise), a valid Safe spend, and dispatcher inventory. No permissionless trigger chain was found: direct \`CashbackDispatcher.cashback/clearPendingCashback\` calls revert \`OnlyCashModule\`; public pending clear pays only the stored recipient. Therefore this is a privileged-input/control-plane candidate pending review, not a permissionless exploit claim.\n\n## Exactly-once evidence\n\n- **24/24** tests; **21** unit and **3** fuzz properties; **${result.tests.totalFuzzCases}** fixed-seed fuzz cases.\n- Same Safe/module \`txId\` replay rejected; second module/chain instance accepts the same ID and pays again.\n- Transfer false/revert before/revert after, event failure, token callback, authorized-wallet callback, Safe recursion, duplicate clear batches, and retry ordering produced **0 duplicate retry payout** and final pending **0** after success.\n- Pending state is token-separated. Successful transfer/event/delete is atomic despite delete-after-call ordering.\n- Pending clear remains payable while dispatcher is paused; token removal can strand pending until re-whitelisted.\n- Zero recipient atomically OOGs; zero-rounded reward increments earned accounting but creates neither payout nor pending.\n\n## Mitigation\n\n${result.remediationSummary}\n\n## Next gate\n\n${result.nextDeploymentGate}\n`;
  const inbox = { findingId: NAME, agentId: AGENT, role: "critical-research", status: "pending-review", classification: CLASSIFICATION, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "Exact source permits privileged wallet-supplied duplicate/unbound cashback payouts, while retry/callback paths remain exactly-once in bounded tests; no permissionless trigger found.", artifacts: [RAW, REPORT, MANIFEST], nextAction: result.nextDeploymentGate };
  const handoffText = `# Handoff: ${NAME}\n\n- Classification: \`${CLASSIFICATION}\`.\n- Exact production source commit/build bound; local harness byte-bound.\n- Tests: 24/24, 3 fuzz properties, ${result.tests.totalFuzzCases} fixed-seed fuzz cases; deterministic semantic replay.\n- Candidate: privileged wallet can duplicate identical rows and redirect uncapped cashback; fixed excess 3,000,000 raw, fuzz up to 8x.\n- Retry/reentrancy path: zero duplicate payout, final pending zero after success.\n- No network/fork/signed action; no permissionless trigger.\n- Validate with \`node ${VALIDATOR}\`.\n`;
  for (const text of [closureText, rawText, reportText, JSON.stringify(inbox), handoffText]) sanitize(text);
  writeOwned(RAW, rawText); writeOwned(REPORT, reportText); writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n"); writeOwned(HANDOFF, handoffText);
  const records = [SCANNER, VALIDATOR, RAW, CLOSURE, REPORT, INBOX, HANDOFF, TEST, HARNESS, LOCK,
    "targets/cash-v3/src/cashback-dispatcher/CashbackDispatcher.sol", "targets/cash-v3/src/modules/cash/CashModuleCore.sol", "targets/cash-v3/src/modules/cash/CashModuleStorageContract.sol", "targets/cash-v3/src/modules/cash/CashEventEmitter.sol", "targets/cash-v3/src/interfaces/ICashbackDispatcher.sol", "targets/cash-v3/src/interfaces/ICashModule.sol"
  ].map(hashFile);
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, records, aggregateSha256: sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")) };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n"; sanitize(manifestText); writeOwned(MANIFEST, manifestText);
  console.log(JSON.stringify({ ok: true, runId, classification: CLASSIFICATION, tests: `${parsed.passCount}/${parsed.tests.length}`, fuzzCases: result.tests.totalFuzzCases, branchPipeline: result.conclusion.branchPipeline, routePositive: 0, manifestAggregateSha256: manifest.aggregateSha256 }, null, 2));
}

try { main(); } catch (e) { console.error(`cashback exactly-once scan failed: ${String(e?.message || e).slice(0, 400)}`); process.exit(1); }
