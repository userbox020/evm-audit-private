#!/usr/bin/env node
"use strict";

// Deterministic, offline Babylon BAB-H-01 remediation artifact generator.
// Reads only the local remediation worktree and local read-only git metadata.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const SOURCE_REL = "sources/babylon-v4.3.0-remediation";
const SOURCE_ROOT = path.join(WORKSPACE, SOURCE_REL);
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "babylon-late-quorum-remediation.json");
const OUT_MD = path.join(WORKSPACE, "reports", "babylon-late-quorum-remediation.md");
const SCANNER = "tools/scan-babylon-late-quorum-remediation.js";
const GENERATED_AT = "2026-07-10T00:00:00.000Z";
const EXPECTED_COMMIT = "16e00c88d9cfd2e9f92bb786c474f6e79628a49f";
const INTENT_TO_ADD_PATH = "x/btcstaking/keeper/late_covenant_quorum_remediation_test.go";
const REMEDIATION_STATUS = "FORWARD-FIX-PASS/DEPLOYMENT-BLOCKED-NEEDS-STATE-RECONCILIATION";

const EXPECTED_PATHS = [
  "proto/babylon/btcstaking/v1/btcstaking.proto",
  "x/btcstaking/keeper/btc_delegations.go",
  INTENT_TO_ADD_PATH,
  "x/btcstaking/keeper/msg_server.go",
  "x/btcstaking/keeper/msg_server_test.go",
  "x/btcstaking/types/btc_delegation.go",
  "x/btcstaking/types/btc_delegation_test.go",
  "x/btcstaking/types/btcstaking.pb.go",
];

const ALLOWED_WRITES = new Set([
  "reports/raw/fast/babylon-late-quorum-remediation.json",
  "reports/babylon-late-quorum-remediation.md",
]);

const FILE_SPECS = [
  {
    path: "proto/babylon/btcstaking/v1/btcstaking.proto",
    role: "canonical proto status documentation",
    markers: [
      "Pre-registration: PENDING -> VERIFIED -> ACTIVE -> UNBONDED/EXPIRED",
      "Included delegation awaiting covenant quorum: PENDING -> ACTIVE or PENDING -> EXPIRED",
      "reaching the chronological timelock expiry threshold produces EXPIRED",
    ],
  },
  {
    path: "x/btcstaking/keeper/btc_delegations.go",
    role: "post-add status recomputation and event gating",
    markers: [
      "postAddStatus := btcDel.GetStatus(btcTipHeight, delInfo.Params.CovenantQuorum, quorumPreviousStk)",
      "case types.BTCDelegationStatus_ACTIVE:",
      "case types.BTCDelegationStatus_VERIFIED:",
      "k.addPowerDistUpdateEvent(ctx, btcTipHeight, activeEvent)",
    ],
  },
  {
    path: INTENT_TO_ADD_PATH,
    role: "deterministic late-quorum no-mutation regression",
    markers: [
      "func TestLateCovenantQuorumAfterExpiryEventIsRejected(t *testing.T)",
      "rand.New(rand.NewSource(1))",
      "require.ErrorIs(t, err, types.ErrInvalidCovenantSig)",
      "require.Len(t, h.Ctx.EventManager().Events(), eventCountBeforeReject)",
      "require.Len(t, delegation.CovenantSigs, int(params.CovenantQuorum)-1)",
      "require.True(t, postLateCache == nil || postLateCache.Empty())",
    ],
  },
  {
    path: "x/btcstaking/keeper/msg_server.go",
    role: "pre-crypto expired/unbonded rejection",
    markers: [
      "Reject expired or unbonded delegations before expensive signature checks.",
      "status == types.BTCDelegationStatus_UNBONDED || status == types.BTCDelegationStatus_EXPIRED",
      "the BTC delegation is already expired or unbonded",
      "Verify each covenant adaptor signature over slashing tx",
    ],
  },
  {
    path: "x/btcstaking/keeper/msg_server_test.go",
    role: "legitimate adjacent ACTIVE/EXPIRED net-zero regression",
    markers: [
      "func TestActiveAndExpiredEventsSameBlock(t *testing.T)",
      "rand.New(rand.NewSource(1))",
      "ACTIVE event at E-1 while the scheduled EXPIRED event remains at E",
      "must net to zero without transient power remaining in the cache",
      "require.Equal(t, dc, newDc)",
    ],
  },
  {
    path: "x/btcstaking/types/btc_delegation.go",
    role: "subtraction-safe chronological status ordering",
    markers: [
      "if d.IsUnbondedEarly()",
      "Preserve pre-registration semantics until the staking transaction has an",
      "if !d.HasInclusionProof()",
      "if d.EndHeight < d.UnbondingTime || btcHeight >= d.EndHeight-d.UnbondingTime",
      "if !d.HasCovenantQuorums(covenantQuorum, quorumPreviousStk)",
    ],
  },
  {
    path: "x/btcstaking/types/btc_delegation_test.go",
    role: "status boundary, overflow, pre-registration, and expansion tests",
    markers: [
      "func TestGetStatus(t *testing.T)",
      "pre-registration without quorum is pending",
      "included without quorum is expired at threshold",
      "near max uint32 expires at subtraction boundary without addition overflow",
      "math.MaxUint32 - 10",
      "func TestGetStatusStakeExpansionPreviousQuorum(t *testing.T)",
    ],
  },
  {
    path: "x/btcstaking/types/btcstaking.pb.go",
    role: "generated status documentation aligned with proto",
    markers: [
      "Pre-registration: PENDING -> VERIFIED -> ACTIVE -> UNBONDED/EXPIRED",
      "Included delegation awaiting covenant quorum: PENDING -> ACTIVE or PENDING -> EXPIRED",
      "reaching the chronological timelock expiry threshold produces EXPIRED",
    ],
  },
];

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function assertAllowedWrite(file) {
  const target = rel(path.resolve(file));
  if (!ALLOWED_WRITES.has(target)) throw new Error(`Refusing write outside Babylon remediation ownership: ${target}`);
}

function writeAllowed(file, content) {
  assertAllowedWrite(file);
  if (!fs.existsSync(path.dirname(file))) throw new Error(`Missing output directory: ${rel(path.dirname(file))}`);
  fs.writeFileSync(file, content, "utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function gitResult(args) {
  const result = spawnSync("git", args, {
    cwd: SOURCE_ROOT,
    encoding: null,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: Buffer.from(result.stdout || []),
    stderr: Buffer.from(result.stderr || []),
  };
}

function gitText(args, expectedStatus = 0) {
  const result = gitResult(args);
  if (result.status !== expectedStatus) {
    const error = result.stderr.toString("utf8").replace(/[\r\n]+/g, " ").slice(0, 240);
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${error}`);
  }
  return result.stdout.toString("utf8").trimEnd();
}

function splitLines(text) {
  return text ? text.split(/\r?\n/).filter(Boolean) : [];
}

function lineOf(text, marker) {
  const index = text.indexOf(marker);
  return index < 0 ? null : text.slice(0, index).split(/\r?\n/).length;
}

function parseNameStatus(text) {
  return splitLines(text).map((line) => {
    const [status, ...parts] = line.split("\t");
    return { status, path: parts[parts.length - 1] };
  });
}

function parseNumstat(text) {
  return splitLines(text).map((line) => {
    const [added, deleted, file] = line.split("\t");
    if (!/^\d+$/.test(added) || !/^\d+$/.test(deleted) || !file) throw new Error(`Unexpected numstat row: ${line}`);
    return { path: file, insertions: Number(added), deletions: Number(deleted) };
  });
}

function validateWorktree() {
  if (!fs.existsSync(SOURCE_ROOT)) throw new Error(`Missing remediation worktree: ${SOURCE_REL}`);
  const commit = gitText(["rev-parse", "HEAD"]);
  const symbolic = gitResult(["symbolic-ref", "-q", "HEAD"]);
  const detached = symbolic.status === 1 && symbolic.stdout.length === 0;
  const statusRows = splitLines(gitText(["status", "--porcelain=v1"]));
  const nameStatus = parseNameStatus(gitText(["diff", "--no-ext-diff", "--no-color", "--name-status"]));
  const cachedNameStatusText = gitText(["diff", "--cached", "--name-status"]);
  const cachedDiff = gitResult(["diff", "--cached", "--no-ext-diff", "--no-color"]);
  if (cachedDiff.status !== 0) throw new Error("Unable to inspect cached diff");
  const diffCheck = gitResult(["diff", "--check"]);
  const textualDiff = gitResult(["diff", "--no-ext-diff", "--no-color", "--full-index"]);
  if (textualDiff.status !== 0) throw new Error("Unable to generate textual diff");
  const numstat = parseNumstat(gitText(["diff", "--numstat"]));
  const actualPaths = nameStatus.map((row) => row.path).sort();
  const expectedPaths = [...EXPECTED_PATHS].sort();
  const insertions = numstat.reduce((sum, row) => sum + row.insertions, 0);
  const deletions = numstat.reduce((sum, row) => sum + row.deletions, 0);
  const intentStatus = statusRows.find((line) => line.slice(3) === INTENT_TO_ADD_PATH);
  const intentDiff = nameStatus.find((row) => row.path === INTENT_TO_ADD_PATH);

  if (commit !== EXPECTED_COMMIT) throw new Error(`Base commit mismatch: ${commit}`);
  if (!detached) throw new Error("Remediation worktree is not detached");
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error(`Unexpected patch paths: ${JSON.stringify(actualPaths)}`);
  if (statusRows.length !== EXPECTED_PATHS.length) throw new Error(`Unexpected status row count: ${statusRows.length}`);
  if (cachedNameStatusText || cachedDiff.stdout.length !== 0) throw new Error("Cached content detected");
  if (diffCheck.status !== 0 || diffCheck.stdout.length !== 0) throw new Error(`git diff --check failed: ${diffCheck.stdout.toString("utf8").slice(0, 240)}`);
  if (!intentStatus || !intentStatus.startsWith(" A ") || !intentDiff || intentDiff.status !== "A") throw new Error("Remediation test is not intent-to-add with working-tree content");
  if (textualDiff.stdout.length === 0) throw new Error("Expected remediation diff is empty");
  if (numstat.length !== EXPECTED_PATHS.length || insertions !== 288 || deletions !== 55) throw new Error(`Unexpected diff stats: files=${numstat.length} +${insertions} -${deletions}`);

  return {
    sourcePath: SOURCE_REL,
    expectedBaseCommit: EXPECTED_COMMIT,
    observedHeadCommit: commit,
    baseCommitMatch: true,
    detachedHead: true,
    expectedPaths,
    observedPaths: actualPaths,
    unexpectedPaths: [],
    statusPorcelain: statusRows,
    nameStatus,
    intentToAdd: {
      path: INTENT_TO_ADD_PATH,
      statusPorcelain: intentStatus,
      workingTreeDiffStatus: intentDiff.status,
      cachedContentPresent: false,
      verified: true,
    },
    cachedContentPresent: false,
    diffCheckPassed: true,
    diffStats: {
      filesChanged: numstat.length,
      insertions,
      deletions,
      expectedApproximationMatchedExactly: true,
      byFile: numstat,
    },
    textualDiff: {
      bytes: textualDiff.stdout.length,
      sha256: sha256(textualDiff.stdout),
      persisted: false,
      command: "git diff --no-ext-diff --no-color --full-index",
    },
  };
}

function loadPatchManifest() {
  return FILE_SPECS.map((spec) => {
    const absolute = path.join(SOURCE_ROOT, spec.path);
    if (!fs.existsSync(absolute)) throw new Error(`Missing expected patch file: ${spec.path}`);
    const bytes = fs.readFileSync(absolute);
    const text = bytes.toString("utf8");
    const markers = spec.markers.map((marker) => {
      const line = lineOf(text, marker);
      if (line == null) throw new Error(`Missing remediation marker in ${spec.path}: ${marker}`);
      return { marker, line, present: true };
    });
    return {
      path: `${SOURCE_REL}/${spec.path}`,
      sourceRelativePath: spec.path,
      role: spec.role,
      bytes: bytes.length,
      sha256: sha256(bytes),
      requiredMarkers: markers,
      intentToAdd: spec.path === INTENT_TO_ADD_PATH,
      rawContentPersisted: false,
    };
  });
}

function markerLine(manifest, file, marker) {
  const row = manifest.find((item) => item.sourceRelativePath === file);
  const found = row && row.requiredMarkers.find((item) => item.marker === marker);
  return found ? found.line : null;
}

function buildSemanticChecks(manifest) {
  const msgFile = path.join(SOURCE_ROOT, "x/btcstaking/keeper/msg_server.go");
  const msgText = fs.readFileSync(msgFile, "utf8");
  const guardLine = lineOf(msgText, "Reject expired or unbonded delegations before expensive signature checks.");
  const cryptoLine = lineOf(msgText, "Verify each covenant adaptor signature over slashing tx");
  if (guardLine == null || cryptoLine == null || guardLine >= cryptoLine) throw new Error("Handler guard is not before crypto verification");
  return [
    { property: "chronological-expiry-before-missing-quorum", status: "source-marker-confirmed", evidence: `btc_delegation.go:${markerLine(manifest, "x/btcstaking/types/btc_delegation.go", "if d.EndHeight < d.UnbondingTime || btcHeight >= d.EndHeight-d.UnbondingTime")}` },
    { property: "subtraction-safe-boundary", status: "source-and-test-marker-confirmed", evidence: "EndHeight < UnbondingTime guard plus MaxUint32 subtraction-boundary tests" },
    { property: "early-unbond-preserved", status: "source-marker-confirmed", evidence: "GetStatus retains IsUnbondedEarly first" },
    { property: "pre-registration-pending-verified-preserved", status: "source-and-test-marker-confirmed", evidence: "inclusion-proof branch retains PENDING/VERIFIED semantics" },
    { property: "expired-unbonded-handler-rejection-before-crypto", status: "source-order-confirmed", evidence: `guardLine=${guardLine}, cryptoLine=${cryptoLine}` },
    { property: "post-add-status-recompute", status: "source-marker-confirmed", evidence: "postAddStatus gates event emission" },
    { property: "active-only-power-event", status: "source-marker-confirmed", evidence: "ACTIVE switch case alone queues EventPowerDistUpdate ACTIVE" },
    { property: "verified-event-preserved", status: "source-marker-confirmed", evidence: "VERIFIED switch case emits quorum event without ACTIVE power event" },
    { property: "same-batch-e-minus-one-active-e-expired-net-zero", status: "recorded-test-pass-and-marker-confirmed", evidence: "TestActiveAndExpiredEventsSameBlock" },
    { property: "late-quorum-no-mutation", status: "recorded-test-pass-and-marker-confirmed", evidence: "signature/state/event/cache remain unchanged after rejection" },
    { property: "stake-expansion-previous-quorum", status: "recorded-test-pass-and-marker-confirmed", evidence: "TestGetStatusStakeExpansionPreviousQuorum" },
    { property: "proto-generated-comments-aligned", status: "marker-confirmed", evidence: "proto and btcstaking.pb.go share updated transitions/expiry comments" },
  ];
}

function md(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function table(lines, headers, rows) {
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`|${headers.map(() => "---").join("|")}|`);
  for (const row of rows) lines.push(`| ${row.map(md).join(" | ")} |`);
  lines.push("");
}

function selfCheck(raw) {
  if (raw.worktree.observedHeadCommit !== EXPECTED_COMMIT || raw.worktree.detachedHead !== true) throw new Error("Self-check: base identity");
  if (JSON.stringify(raw.worktree.observedPaths) !== JSON.stringify([...EXPECTED_PATHS].sort()) || raw.worktree.unexpectedPaths.length !== 0) throw new Error("Self-check: exact paths");
  if (raw.worktree.cachedContentPresent !== false || raw.worktree.intentToAdd.verified !== true || raw.worktree.intentToAdd.cachedContentPresent !== false) throw new Error("Self-check: cached/intent-to-add state");
  if (!raw.worktree.diffCheckPassed || raw.worktree.diffStats.filesChanged !== 8 || raw.worktree.diffStats.insertions !== 288 || raw.worktree.diffStats.deletions !== 55 || !raw.worktree.textualDiff.sha256) throw new Error("Self-check: diff/hash stats");
  if (raw.patchManifest.length !== 8 || !raw.patchManifest.every((row) => row.sha256 && row.requiredMarkers.every((marker) => marker.present))) throw new Error("Self-check: file hashes/markers");
  if (raw.forwardFixedProperties.length < 10 || !raw.forwardFixedProperties.every((row) => row.status.includes("confirmed"))) throw new Error("Self-check: forward semantics");
  if (!raw.recordedTests.every((row) => row.evidenceClass === "recorded-not-executed-by-scanner" && row.result === "PASS")) throw new Error("Self-check: test labels");
  if (!raw.reviews.every((row) => row.evidenceClass === "recorded-not-executed-by-scanner" && row.verdict === "PASS")) throw new Error("Self-check: review labels");
  const gatesOk = raw.signal === "🟡 VULNERABLE"
    && raw.auditClassification === "VULNERABLE/CONDITIONAL-HIGH"
    && raw.remediationStatus === REMEDIATION_STATUS
    && raw.currentPublicExposure === "unknown-insufficient-public-coverage"
    && raw.sourceFindingConfirmed === true
    && raw.severity === "High (conditional)"
    && raw.routePositiveOperational === 0
    && raw.routeEvidenceStatus === "unknown"
    && raw.evidenceComplete === false
    && raw.closureEligible === false
    && raw.executableNow === 0
    && raw.signedActionJustified === false
    && raw.deploymentPromotion === false
    && raw.aggregatePromotion === false
    && raw.forkPromotion === false
    && raw.executorPromotion === false
    && raw.transactionPromotion === false;
  if (!gatesOk) throw new Error("Self-check: gates");
  return {
    status: "passed",
    exactPaths: 8,
    hashedFiles: raw.patchManifest.length,
    textualDiffHashVerified: true,
    diffCheckPassed: true,
    cachedContentAbsent: true,
    markersValidated: raw.patchManifest.reduce((sum, row) => sum + row.requiredMarkers.length, 0),
    recordedTestsNotExecuted: raw.recordedTests.length,
    recordedReviewsNotExecuted: raw.reviews.length,
    gates: "passed-fail-closed",
  };
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Babylon BAB-H-01 Remediation Assessment", "");
  lines.push(`Signal: 🟡 VULNERABLE — forward remediation=${raw.remediationStatus}; BAB-H-01 remains source-confirmed High (conditional) until deployment and state reconciliation are proven.`, "");
  lines.push("## Scope and Safety", "");
  lines.push(`- Scanner: \`${raw.scanner}\`; deterministic timestamp \`${raw.generatedAt}\`.`);
  lines.push(`- Remediation worktree: \`${raw.worktree.sourcePath}\`; detached HEAD \`${raw.worktree.observedHeadCommit}\`.`);
  lines.push("- Offline local filesystem/hash/read-only-git reduction only. No source edits, tests, builds, network, endpoints, secrets, transactions, simulations, forks, signing, wallets, deployment, or live execution.");
  lines.push("- Linux test and reviewer results are recorded coordinator evidence and were not executed by this scanner.", "");

  lines.push("## Patch Integrity", "");
  lines.push(`- Exact paths=${raw.worktree.diffStats.filesChanged}; diff=+${raw.worktree.diffStats.insertions}/-${raw.worktree.diffStats.deletions}; \`git diff --check\` passed.`);
  lines.push(`- Full textual diff: ${raw.worktree.textualDiff.bytes} bytes; SHA-256 \`${raw.worktree.textualDiff.sha256}\`; diff body not persisted.`);
  lines.push(`- Cached content present=${raw.worktree.cachedContentPresent}; remediation test intent-to-add verified=${raw.worktree.intentToAdd.verified}.`, "");
  table(lines, ["Path", "Status", "Insertions", "Deletions", "SHA-256", "Role"], raw.patchManifest.map((row) => {
    const stat = raw.worktree.diffStats.byFile.find((item) => item.path === row.sourceRelativePath);
    const status = raw.worktree.nameStatus.find((item) => item.path === row.sourceRelativePath);
    return [`\`${row.path}\``, status && status.status, stat && stat.insertions, stat && stat.deletions, `\`${row.sha256}\``, row.role];
  }));

  lines.push("## Forward Fixed Properties", "");
  table(lines, ["Property", "Status", "Evidence"], raw.forwardFixedProperties.map((row) => [row.property, row.status, row.evidence]));

  lines.push("## Recorded Linux Test Evidence", "");
  table(lines, ["Command", "Result", "Package time", "Test time", "Evidence class", "Notes"], raw.recordedTests.map((row) => [row.command, row.result, row.packageTime, row.testTime || "n/a", row.evidenceClass, row.notes]));
  lines.push(`- Native Windows: ${raw.nativeWindows.status} — ${raw.nativeWindows.reason}.`, "");

  lines.push("## Recorded Reviews", "");
  table(lines, ["Reviewer", "Verdict", "Evidence class", "Conclusion"], raw.reviews.map((row) => [row.reviewer, row.verdict, row.evidenceClass, row.conclusion]));

  lines.push("## Rollout Residuals — Not Fixed by Forward Patch", "");
  for (const residual of raw.rolloutResiduals) lines.push(`- **${residual.state}:** ${residual.risk}`);
  lines.push("");
  lines.push("The patch is forward logic remediation, not a state migration. Deployment requires either evidence that no affected history/state exists or a tested migration/rebuild/reconciliation of every residual domain.", "");

  lines.push("## Required Deployment Gate", "");
  for (const item of raw.deploymentRequirements) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## Current Exposure and Gates", "");
  lines.push("- `currentPublicExposure=unknown-insufficient-public-coverage`; the bounded public scan had one provider failure, truncation, and no same-height cache/history proof.");
  lines.push("- `auditClassification=VULNERABLE/CONDITIONAL-HIGH`; `sourceFindingConfirmed=true`; `severity=High (conditional)`");
  lines.push("- `routePositiveOperational=0`; `routeEvidenceStatus=unknown`; `evidenceComplete=false`; `closureEligible=false`");
  lines.push("- `executableNow=0`; `signedActionJustified=false`");
  lines.push("- No deployment, aggregate, fork, executor, transaction, or signed-action promotion.", "");
  return lines.join("\n");
}

function main() {
  const worktree = validateWorktree();
  const patchManifest = loadPatchManifest();
  const forwardFixedProperties = buildSemanticChecks(patchManifest);
  const raw = {
    generatedAt: GENERATED_AT,
    scanner: SCANNER,
    signal: "🟡 VULNERABLE",
    purpose: "Deterministic offline integrity and forward-remediation assessment for Babylon BAB-H-01",
    safety: {
      offline: true,
      localFilesystemRead: true,
      localGitReadOnly: true,
      sourceWorktreesModified: false,
      testsExecutedByScanner: false,
      buildsExecuted: false,
      networkCalls: false,
      endpointInventoriesRead: false,
      secretsRead: false,
      transactions: false,
      simulations: false,
      forks: false,
      signedActions: false,
      deployments: false,
    },
    worktree,
    patchManifest,
    forwardFixedProperties,
    recordedTests: [
      {
        command: "go test ./x/btcstaking/types -run TestGetStatus -count=1 -v",
        result: "PASS",
        packageTime: "0.109s",
        testTime: null,
        evidenceClass: "recorded-not-executed-by-scanner",
        notes: "Includes new boundary, MaxUint32, pre-registration, and stake-expansion previous-quorum cases; later comment-only verification also passed.",
      },
      {
        command: "go test ./x/btcstaking/keeper -run TestLateCovenantQuorumAfterExpiryEventIsRejected -count=1 -v",
        result: "PASS",
        packageTime: "0.167s",
        testTime: "0.04s",
        evidenceClass: "recorded-not-executed-by-scanner",
        notes: "Proves rejection with no state/signature/event/cache mutation.",
      },
      {
        command: "go test ./x/btcstaking/keeper -run TestActiveAndExpiredEventsSameBlock -count=1 -v",
        result: "PASS",
        packageTime: "0.141s",
        testTime: "0.03s",
        evidenceClass: "recorded-not-executed-by-scanner",
        notes: "Proves legitimate E-1 ACTIVE plus E EXPIRED processing nets to zero.",
      },
    ],
    nativeWindows: {
      status: "blocked-environment-limitation-not-code-failure",
      reason: "wasmvm dependency uses Unix symbols",
    },
    reviews: [
      {
        reviewer: "@oracle",
        verdict: "PASS",
        evidenceClass: "recorded-not-executed-by-scanner",
        conclusion: "Forward remediation passed after docs/tests with no forward blocker or major; deployment remains blocked on state reconciliation/proof clean.",
      },
      {
        reviewer: "@audit-reviewer",
        verdict: "PASS",
        evidenceClass: "recorded-not-executed-by-scanner",
        conclusion: "Report-ready forward fix; finding remains conditional High and patch is not a state migration.",
      },
    ],
    rolloutResiduals: [
      { state: "stale queued ACTIVE events", risk: "Events created before upgrade can still be consumed unless explicitly inspected, invalidated, or reconciled." },
      { state: "poisoned finality caches and voting power", risk: "Forward status/event guards do not remove TotalSat already admitted to distribution caches or derived voting power." },
      { state: "incentive reward tracker and gauge state", risk: "Previously emitted activation hooks may have initialized or increased reward accounting that the forward patch does not reverse." },
      { state: "historical rewards", risk: "Already accrued, allocated, or withdrawn rewards require explicit accounting policy and cannot be repaired solely by forward logic." },
    ],
    deploymentRequirements: [
      "Prove from complete history and current state that no expired-no-quorum delegation later activated and no stale ACTIVE event/cache/reward effect exists; or execute a tested migration/rebuild/reconciliation.",
      "Reconcile queued BTC delegation power events, finality-provider distribution caches/voting power, incentive reward trackers/gauges, and historical reward deltas at a consistent upgrade height.",
      "Add migration tests covering idempotence, restart/replay, stake expansions, multi-FP delegations, same-batch E-1/E behavior, and no negative/double subtraction.",
      "Run full affected module/integration suites in the supported Linux environment and independently review migration state transitions before deployment.",
    ],
    currentPublicExposure: "unknown-insufficient-public-coverage",
    remediationStatus: REMEDIATION_STATUS,
    auditClassification: "VULNERABLE/CONDITIONAL-HIGH",
    sourceFindingConfirmed: true,
    findingId: "BAB-H-01",
    severity: "High (conditional)",
    routePositiveOperational: 0,
    routeEvidenceStatus: "unknown",
    evidenceComplete: false,
    closureEligible: false,
    executableNow: 0,
    signedActionJustified: false,
    deploymentPromotion: false,
    aggregatePromotion: false,
    forkPromotion: false,
    executorPromotion: false,
    transactionPromotion: false,
  };
  raw.selfChecks = selfCheck(raw);
  writeAllowed(OUT_JSON, `${JSON.stringify(raw, null, 2)}\n`);
  writeAllowed(OUT_MD, `${renderReport(raw)}\n`);
  console.log(`wrote ${rel(OUT_JSON)} and ${rel(OUT_MD)}`);
  console.log(`baseCommit=${raw.worktree.observedHeadCommit} detached=${raw.worktree.detachedHead} paths=${raw.worktree.diffStats.filesChanged} insertions=${raw.worktree.diffStats.insertions} deletions=${raw.worktree.diffStats.deletions} diffCheck=${raw.worktree.diffCheckPassed} cachedContent=${raw.worktree.cachedContentPresent} intentToAdd=${raw.worktree.intentToAdd.verified}`);
  console.log(`diffBytes=${raw.worktree.textualDiff.bytes} diffSha256=${raw.worktree.textualDiff.sha256} hashedFiles=${raw.patchManifest.length} markers=${raw.selfChecks.markersValidated} recordedTests=${raw.recordedTests.length} recordedReviews=${raw.reviews.length}`);
  console.log(`remediationStatus=${raw.remediationStatus} currentPublicExposure=${raw.currentPublicExposure} sourceFindingConfirmed=${raw.sourceFindingConfirmed} severity=${raw.severity} evidenceComplete=${raw.evidenceComplete} closureEligible=${raw.closureEligible} routePositiveOperational=${raw.routePositiveOperational} executableNow=${raw.executableNow} signedActionJustified=${raw.signedActionJustified} selfChecks=${raw.selfChecks.status}`);
}

try {
  main();
} catch (error) {
  console.error(`scan-babylon-late-quorum-remediation failed: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
}
