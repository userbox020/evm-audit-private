#!/usr/bin/env node
"use strict";

// Reviewer-corrected local-only R2 package. No endpoint inventory or network use.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const NAME = "critical-etherfi-cash-withdrawal-exactly-once-r2";
const SOURCE_COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8";
const CLASSIFICATION = "INFORMATIONAL/REVIEWER-R2/CONDITIONAL-NONSTANDARD-ERC20-CONSUMPTION/SOLADY-ZERO-SENTINEL-RECIPIENT-REJECTED/NO-ATTACKER-CAPTURE/EXACT-SOURCE";
const REVISION = "cash-withdrawal-exactly-once-reviewer-r2";
const AGENT = "reviewer-etherfi-cash-withdrawal-r2-20260724";
const FUZZ_RUNS = 256;
const FUZZ_SEED = "0x434153482d5749544844524157414c2d45584143544c592d4f4e43452d5631";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/review-${NAME}-2026-07-24.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const TEST = "targets/cash-v3/test/critical/CashWithdrawalExactlyOnce.t.sol";
const HARNESS = "targets/cash-v3/test/critical/CashWithdrawalExactlyOnceHarness.sol";
const LOCK = "targets/cash-v3/foundry.lock";
const R1_RAW = "reports/raw/fast/critical-etherfi-cash-withdrawal-exactly-once.json";
const R1_MANIFEST = "reports/raw/fast/critical-etherfi-cash-withdrawal-exactly-once-manifest.json";
const R1_REPORT = "reports/critical-etherfi-cash-withdrawal-exactly-once.md";
const R1_CLOSURE = "reports/raw/fast/critical-etherfi-cash-withdrawal-exactly-once-source-closure.json";
const SOURCE_FILES = [
  "targets/cash-v3/src/modules/cash/CashModuleCore.sol",
  "targets/cash-v3/src/modules/cash/CashModuleSetters.sol",
  "targets/cash-v3/src/modules/cash/CashModuleStorageContract.sol",
  "targets/cash-v3/src/safe/EtherFiSafe.sol",
  "targets/cash-v3/src/libraries/CashVerificationLib.sol",
  "targets/cash-v3/src/interfaces/ICashModule.sol",
  "targets/cash-v3/lib/solady/src/utils/EnumerableSetLib.sol",
];

const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function writeOwned(rel, text) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8"); }
function run(command, args, cwd, timeout = 1_200_000) { const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 128 * 1024 * 1024, windowsHide: true }); return { status: result.status, output: `${result.stdout || ""}\n${result.stderr || ""}`, error: result.error?.message || null }; }
function sanitize(text) { if (/https?:\/\//i.test(text)) throw new Error("URL leak"); if (/(?:private[_ -]?key|seed[_ -]?phrase|mnemonic)["']?\s*[:=]\s*["']?[^\s,"'}]{12,}/i.test(text)) throw new Error("secret-pattern leak"); }

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
  const temp = path.join(ROOT, `.tmp-cash-withdrawal-r2-${tag}`);
  fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(temp, { recursive: true });
  try {
    const args = ["test", "--root", TARGET, "--out", path.join(temp, "out"), "--cache-path", path.join(temp, "cache"), "--no-cache", "--offline", "--match-path", "test/critical/CashWithdrawalExactlyOnce.t.sol", "--match-contract", "CashWithdrawalExactlyOnceTest", "--skip", "SafeAssetRecoveryInvariant", "--fuzz-runs", String(FUZZ_RUNS), "--fuzz-seed", FUZZ_SEED, "-vvv"];
    const result = run("forge", args, ROOT);
    return { exitStatus: result.status, outputBytes: Buffer.byteLength(result.output), outputSha256: sha(result.output), parsed: parseTests(result.output), endpointAccess: false, fork: false };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function build() {
  const temp = path.join(ROOT, ".tmp-cash-withdrawal-r2-build");
  fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(temp, { recursive: true });
  try {
    const sources = ["src/modules/cash/CashModuleCore.sol", "src/modules/cash/CashModuleSetters.sol", "src/safe/EtherFiSafe.sol"];
    const result = run("forge", ["build", ...sources, "--root", TARGET, "--out", path.join(temp, "out"), "--cache-path", path.join(temp, "cache"), "--no-cache", "--offline"], ROOT);
    return { exitStatus: result.status, outputBytes: Buffer.byteLength(result.output), outputSha256: sha(result.output), compiler: "0.8.28", endpointAccess: false };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function main() {
  const generatedAt = new Date().toISOString();
  const head = run("git", ["rev-parse", "HEAD"], TARGET, 120_000).output.trim();
  if (head !== SOURCE_COMMIT) throw new Error("source commit mismatch");
  const sourceDiff = run("git", ["diff", "--name-only", SOURCE_COMMIT, "--", "src"], TARGET, 120_000).output.trim().split(/\r?\n/).filter(Boolean);
  if (sourceDiff.length) throw new Error("production source drift");
  const predecessor = JSON.parse(fs.readFileSync(abs(R1_RAW), "utf8"));
  const predecessorManifest = JSON.parse(fs.readFileSync(abs(R1_MANIFEST), "utf8"));
  const closure = JSON.parse(fs.readFileSync(abs(R1_CLOSURE), "utf8"));
  if (!closure.complete || closure.productionSourceDiffAgainstCommit.length) throw new Error("predecessor source closure invalid");
  for (const row of closure.files) { const current = hashFile(row.path); if (current.bytes !== row.bytes || current.sha256 !== row.sha256) throw new Error(`source closure drift: ${row.path}`); }
  const buildResult = build(); if (buildResult.exitStatus !== 0) throw new Error("offline source build failed");
  const primary = runTests("primary"), replay = runTests("replay");
  if (primary.exitStatus !== 0 || replay.exitStatus !== 0) throw new Error("R2 source tests failed");
  if (canonical(primary.parsed) !== canonical(replay.parsed)) throw new Error("semantic replay mismatch");
  const fuzzTests = primary.parsed.tests.filter((row) => row.fuzzRuns !== null);
  if (primary.parsed.passCount !== 30 || primary.parsed.failCount !== 0 || fuzzTests.length !== 4 || fuzzTests.some((row) => row.fuzzRuns < FUZZ_RUNS)) throw new Error("R2 coverage gate failed");
  const names = new Set(primary.parsed.tests.map((row) => row.name));
  if (!names.has("testNonzeroSoladyZeroSentinelRecipientRevertsAvailabilityOnly()") || !names.has("testFuzzSoladyZeroSentinelRecipientAlwaysReverts(uint96)")) throw new Error("sentinel regression missing");
  const testSource = fs.readFileSync(abs(TEST), "utf8");
  const sentinelHex = "0xfbb67fda52d4bfb8bf";
  if (!testSource.includes(sentinelHex) || !testSource.includes("boundRecipient != ZERO_SENTINEL_RECIPIENT") || !testSource.includes("firstRecipient != ZERO_SENTINEL_RECIPIENT")) throw new Error("sentinel fuzz-domain correction absent");
  const totalFuzzCases = fuzzTests.reduce((sum, row) => sum + row.fuzzRuns, 0);
  const runId = `etherfi-cash-withdrawal-exactly-once-r2-${SOURCE_COMMIT.slice(0, 12)}-${hashFile(TEST).sha256.slice(0, 12)}`;
  const result = {
    schemaVersion: 1,
    revision: REVISION,
    runId,
    generatedAt,
    agentId: AGENT,
    role: "reviewer",
    classification: CLASSIFICATION,
    predecessor: { runId: predecessor.runId, classification: predecessor.classification, raw: hashFile(R1_RAW), manifest: hashFile(R1_MANIFEST), report: hashFile(R1_REPORT), sourceClosure: hashFile(R1_CLOSURE), predecessorManifestAggregateSha256: predecessorManifest.aggregateSha256 },
    reviewerCorrections: {
      zeroSentinelRecipient: "0x0000000000000000000000fbb67fda52d4bfb8bf",
      actualNumericValue: sentinelHex,
      requestBehavior: "requestWithdrawal reverts EnumerableSetLib.ValueIsZeroSentinel for this nonzero recipient when checking the module whitelist",
      classification: "bounded-recipient-availability-validation-no-extraction",
      generalRecipientFuzzExcludesZeroAndSentinel: true,
      separateFixedRegression: true,
      separateSentinelFuzzProperty: true,
      nonceAndRequestRollback: true,
      attackerGainRaw: "0",
    },
    conclusion: {
      status: "reviewer-r2-bounded-informational-no-extraction",
      advances: false,
      branchPipeline: "1/5_SOURCE_SEMANTIC_PRIMITIVES_CONDITIONAL_NO_ATTACKER_VALUE",
      extractionPipeline: "0/5_NO_ATTACKER_VALUE_PATH",
      globalHighestPipeline: "DebtManager donation 2/5 WATCH unchanged",
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      reason: "Standard-token fulfillment remains exactly once in the corrected domain. False/partial ERC20 delivery remains a conditional availability primitive with no caller capture. The nonzero Solady zero-sentinel recipient is rejected before request creation, causing bounded recipient availability loss only; nonce, pending state, Safe balance, and attacker balance roll back.",
    },
    safety: { offlineOnly: true, network: false, rpcInventoryRead: false, fork: false, forkRerun: false, liveTransactions: false, signedActions: false, broadcasts: false, productionMutation: false, keysRead: false },
    source: { commit: head, productionSourceDiffAgainstCommit: sourceDiff, productionSourceBinding: "commit-bound", inheritedRecursiveClosure: hashFile(R1_CLOSURE), offlineBuild: buildResult },
    customHarness: { binding: "local-byte-hash-bound", claimedAsCommitArtifact: false, files: [hashFile(TEST), hashFile(HARNESS)] },
    foundryLock: { binding: "local-byte-hash-bound", file: hashFile(LOCK) },
    tests: { passCount: primary.parsed.passCount, failCount: primary.parsed.failCount, skippedCount: primary.parsed.skippedCount, testCount: primary.parsed.tests.length, unitTestCount: primary.parsed.tests.length - fuzzTests.length, fuzzPropertyCount: fuzzTests.length, fuzzRunsPerProperty: FUZZ_RUNS, totalFuzzCases, fuzzSeed: FUZZ_SEED, deterministicSemanticReplay: true, primaryOutputSha256: primary.outputSha256, replayOutputSha256: replay.outputSha256, tests: primary.parsed.tests },
    invariantAssessment: {
      standardTokenExactlyOncePassWithinCorrectedRecipientDomain: true,
      generalRecipientDomainExcludesZero: true,
      generalRecipientDomainExcludesSoladyZeroSentinel: true,
      sentinelAlwaysRevertsPropertyPass: true,
      sentinelCreatesPendingRequest: false,
      sentinelMovesSafeFunds: false,
      sentinelAttackerCaptureFound: false,
      strictPartialFulfillmentPass: false,
      permissionlessAttackerCaptureFound: false,
    },
    deltas: {
      inheritedReturnFalse: predecessor.deltas.returnFalse,
      inheritedPartialTrue: predecessor.deltas.partialTrue,
      standard: predecessor.deltas.standard,
      sentinel: { requestedRawFixedCase: "43000000", recipientPayoutRaw: "0", safeRetainedRaw: "43000000", pendingRaw: "0", nonceDelta: "0", attackerGainRaw: "0", revertSelector: "0xf5a267f1" },
    },
    findings: [
      {
        id: "CW-R2-01", severity: "Informational / conditional token integration", status: "CONDITIONAL_NO_EXTRACTION",
        title: "False-return or partial-transfer ERC20 can consume the source-level request without full delivery",
        codeReferences: ["src/safe/EtherFiSafe.sol:186-205", "src/modules/cash/CashModuleStorageContract.sol:298-332"],
        impact: "Undelivered value remains in the Safe and caller gain is zero in the bounded harness.",
        mitigation: "Validate optional ERC20 return data and recipient balance deltas before request deletion."
      },
      {
        id: "CW-R2-02", severity: "Informational / bounded recipient availability", status: "CONFIRMED_LOCAL_EXACT_SOURCE_NO_EXTRACTION",
        title: "Nonzero Solady zero-sentinel recipient cannot be used for requestWithdrawal",
        codeReferences: ["src/modules/cash/CashModuleSetters.sol:177-181", "lib/solady/src/utils/EnumerableSetLib.sol:26-38", "lib/solady/src/utils/EnumerableSetLib.sol:166-170"],
        preconditions: ["Safe owners sign a withdrawal to address 0x0000000000000000000000fbb67fda52d4bfb8bf"],
        impact: "The valid nonzero recipient is rejected with ValueIsZeroSentinel. The transaction rolls back nonce and request state; no transfer, loss, redirect, or attacker gain occurs.",
        evidence: ["fixed regression", "256-run dedicated sentinel property"],
        mitigation: "Reject the reserved sentinel explicitly with a protocol error or avoid EnumerableSet.contains on untrusted recipient values by checking module membership through a sentinel-safe wrapper."
      },
    ],
    nextGate: "Independent offline approval. Deployment conclusions remain separate because active CashModuleCore/Setters runtime/source continuity is open; no network, fork, or live action is justified by this R2 source package.",
  };
  const rawText = JSON.stringify(result, null, 2) + "\n";
  const reportText = `# Ether.fi Cash withdrawal exactly-once — reviewer R2\n\n**Signal:** ⚪ CLEAN for permissionless extraction; informational conditional/availability issues.  \n**Classification:** \`${CLASSIFICATION}\`  \n**Scope:** local exact source \`${SOURCE_COMMIT}\`; no network or fork.\n\n## Reviewer correction\n\nThe nonzero address \`0x0000000000000000000000fbb67fda52d4bfb8bf\` equals Solady's reserved zero sentinel. \`requestWithdrawal\` calls \`whitelistedModulesCanRequestWithdraw.contains(recipient)\` and reverts \`ValueIsZeroSentinel()\`. The fixed regression and a dedicated 256-run property confirm nonce delta **0**, pending request **0**, recipient payout **0**, Safe loss **0**, and attacker gain **0**. This is a bounded recipient availability/validation issue, not extraction.\n\nGeneral recipient fuzz now excludes both address zero and the sentinel; sentinel behavior is tested separately rather than discarded silently.\n\n## Full suite\n\n- **30/30** tests: **26** unit and **4** fuzz properties.\n- **${totalFuzzCases}** fixed-seed fuzz cases; deterministic semantic replay.\n- Existing standard-token exactly-once, failure/retry/reentrancy/order/authorization/conservation checks remain passing.\n- Conditional false/partial ERC20 request-consumption deltas are unchanged and still produce caller gain **0**.\n\n## Classification and pipeline\n\nThe source branch remains \`1/5_SOURCE_SEMANTIC_PRIMITIVES_CONDITIONAL_NO_ATTACKER_VALUE\`; extraction \`0/5\`; global highest remains **DebtManager donation 2/5 WATCH**. Deployment semantics are not claimed by this source package.\n\n## Mitigation\n\nHandle the Solady sentinel before membership lookup with a clear protocol validation error or a sentinel-safe membership wrapper. Preserve optional-return and recipient-delta validation recommendations for ERC20 fulfillment.\n`;
  const inbox = { findingId: NAME, agentId: AGENT, role: "reviewer", status: "reviewer-r2-bounded-informational-no-extraction", classification: CLASSIFICATION, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "30/30 corrected exact-source tests: standard path exactly once in corrected domain; Solady zero-sentinel recipient reverts with rollback and zero attacker gain; false/partial token primitive remains conditional no-extraction.", artifacts: [RAW, REPORT, MANIFEST], nextAction: result.nextGate };
  const handoffText = `# Handoff: ${NAME}\n\n- Reviewer R2 exact-source package; R1 raw/manifest/report/closure hash-bound.\n- 30/30 tests: 26 unit, 4 fuzz, ${totalFuzzCases} fixed-seed cases; deterministic replay.\n- General recipient fuzz excludes zero and Solady sentinel.\n- Sentinel \`0x0000000000000000000000fbb67fda52d4bfb8bf\` has fixed regression plus 256-run property: ValueIsZeroSentinel, nonce/pending/funds rollback, attacker gain zero.\n- Branch 1/5 conditional source semantics; extraction 0/5; global DebtManager donation 2/5 WATCH unchanged.\n- No network/fork/live activity. Validate with \`node ${VALIDATOR}\`.\n`;
  for (const text of [rawText, reportText, JSON.stringify(inbox), handoffText]) sanitize(text);
  writeOwned(RAW, rawText); writeOwned(REPORT, reportText); writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n"); writeOwned(HANDOFF, handoffText);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, TEST, HARNESS, LOCK, R1_RAW, R1_MANIFEST, R1_REPORT, R1_CLOSURE, ...SOURCE_FILES].map(hashFile);
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, records, aggregateSha256: sha(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")) };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n"; sanitize(manifestText); writeOwned(MANIFEST, manifestText);
  console.log(JSON.stringify({ ok: true, runId, classification: CLASSIFICATION, tests: `${result.tests.passCount}/${result.tests.testCount}`, unitTests: result.tests.unitTestCount, fuzzProperties: result.tests.fuzzPropertyCount, fuzzCases: totalFuzzCases, sentinelRegression: true, branchPipeline: result.conclusion.branchPipeline, extractionPipeline: result.conclusion.extractionPipeline, manifestAggregateSha256: manifest.aggregateSha256 }, null, 2));
}

try { main(); } catch (error) { console.error(`cash withdrawal R2 packaging failed: ${String(error?.message || error).slice(0, 500)}`); process.exit(1); }
