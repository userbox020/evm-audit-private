#!/usr/bin/env node
"use strict";

// Babylon step-2 deterministic source/spend-authority trace.
// Offline only: local filesystem, SHA-256, and read-only local git metadata.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const SOURCE_REL = "sources/babylon-v4.3.0";
const SOURCE_ROOT = path.join(WORKSPACE, SOURCE_REL);
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "babylon-source-spend-authority.json");
const OUT_MD = path.join(WORKSPACE, "reports", "babylon-source-spend-authority-triage.md");
const SCANNER = "tools/scan-babylon-source-spend-authority.js";
const GENERATED_AT = "2026-07-10T00:00:00.000Z";
const EXPECTED_TAG = "v4.3.0";
const EXPECTED_COMMIT = "16e00c88d9cfd2e9f92bb786c474f6e79628a49f";
const ALLOWED_UNTRACKED = "x/btcstaking/keeper/late_covenant_quorum_regression_test.go";

const ALLOWED_WRITES = new Set([
  "reports/raw/fast/babylon-source-spend-authority.json",
  "reports/babylon-source-spend-authority-triage.md",
]);

const SOURCE_SPECS = [
  { path: "go.mod", tracked: true, role: "pinned module/dependency manifest", markers: ["module github.com/babylonlabs-io/babylon/v4"] },
  { path: "x/btcstaking/types/btc_delegation.go", tracked: true, role: "delegation status chronology", markers: ["func (d *BTCDelegation) GetStatus(", "if !d.HasCovenantQuorums(covenantQuorum, quorumPreviousStk)", "if btcHeight+d.UnbondingTime >= d.EndHeight"] },
  { path: "x/btcstaking/keeper/msg_server.go", tracked: true, role: "late covenant-signature entrypoint", markers: ["func (ms msgServer) AddCovenantSigs(", "status == types.BTCDelegationStatus_UNBONDED || status == types.BTCDelegationStatus_EXPIRED", "ms.addCovenantSigsToBTCDelegation("] },
  { path: "x/btcstaking/keeper/btc_delegations.go", tracked: true, role: "expiry scheduling and quorum-reached ACTIVE event", markers: ["k.addPowerDistUpdateEvent(ctx, btcDel.EndHeight-btcDel.UnbondingTime, expiredEvent)", "if !hadQuorum && btcDel.HasCovenantQuorums", "k.addPowerDistUpdateEvent(ctx, btcTipHeight, activeEvent)"] },
  { path: "x/finality/keeper/power_dist_change.go", tracked: true, role: "event clearing and finality power cache", markers: ["k.BTCStakingKeeper.ClearPowerDistUpdateEvents(ctx, i)", "func (k Keeper) processExpiredEvents(", "k.processPowerDistUpdateEventActive(state, btcDel)", "state.DeltaSatsByFpBtcPk[fpBTCPKHex] += int64(btcDel.TotalSat)"] },
  { path: "x/incentive/keeper/finality_hooks.go", tracked: true, role: "finality-to-incentive activation hooks", markers: ["func (h Hooks) AfterBtcDelegationActivated(", "return h.k.AddEventBtcDelegationActivated"] },
  { path: "x/incentive/keeper/reward_tracker_events.go", tracked: true, role: "activation reward-tracker event and processing", markers: ["func (k Keeper) AddEventBtcDelegationActivated(", "if err := k.BtcDelegationActivated(", "return k.DeleteRewardTrackerEvents(ctx, height)"] },
  { path: "x/incentive/keeper/reward_tracker.go", tracked: true, role: "active satoshi and reward-period accounting", markers: ["func (k Keeper) BtcDelegationActivated(", "return k.addDelegationSat(ctx, fp, del, sat)", "CalculateBTCDelegationRewardsAndSendToGauge"] },
  { path: "x/incentive/keeper/reward_gauge.go", tracked: true, role: "downstream withdrawable reward gauge", markers: ["func (k Keeper) withdrawReward(", "SendCoinsFromModuleToAccount", "rg.SetFullyWithdrawn()"] },
  { path: "x/btcstaking/keeper/msg_server_test.go", tracked: true, role: "adjacent same-batch ACTIVE+EXPIRED coverage", markers: ["func TestActiveAndExpiredEventsSameBlock(t *testing.T)"] },
  { path: "x/finality/keeper/power_dist_change_test.go", tracked: true, role: "adjacent no-quorum expiry coverage", markers: ["func TestIgnoreExpiredEventIfThereIsNoQuorum(t *testing.T)"] },
  { path: ALLOWED_UNTRACKED, tracked: false, role: "defensive late-quorum regression", markers: ["func TestLateCovenantQuorumAfterExpiryEventCreatesPhantomPower(t *testing.T)", "rand.New(rand.NewSource(1))", "The first finality cycle consumes the EXPIRED event without quorum.", "types.BTCDelegationStatus_EXPIRED", "types.BTCDelegationStatus_ACTIVE", "phantomCache.FinalityProviders[0].TotalBondedSat", "With no correcting event left"] },
];

const CODE_REFERENCE_SPECS = [
  { id: "status-no-quorum-first", path: "x/btcstaking/types/btc_delegation.go", marker: "if !d.HasCovenantQuorums(covenantQuorum, quorumPreviousStk)", expectedLineMin: 127, expectedLineMax: 130, role: "Returns PENDING before chronological expiry is evaluated." },
  { id: "status-expiry-later", path: "x/btcstaking/types/btc_delegation.go", marker: "if btcHeight+d.UnbondingTime >= d.EndHeight", expectedLineMin: 146, expectedLineMax: 150, role: "Chronological EXPIRED check occurs only after quorum/inclusion checks." },
  { id: "add-sigs-handler", path: "x/btcstaking/keeper/msg_server.go", marker: "func (ms msgServer) AddCovenantSigs(", expectedLineMin: 243, expectedLineMax: 247, role: "Externally submitted covenant-signature message handler." },
  { id: "handler-status-guard", path: "x/btcstaking/keeper/msg_server.go", marker: "status == types.BTCDelegationStatus_UNBONDED || status == types.BTCDelegationStatus_EXPIRED", expectedLineMin: 270, expectedLineMax: 275, role: "Rejects UNBONDED/EXPIRED, but GetStatus can report PENDING after chronological expiry when quorum is absent." },
  { id: "handler-adds-signature", path: "x/btcstaking/keeper/msg_server.go", marker: "ms.addCovenantSigsToBTCDelegation(", expectedLineMin: 368, expectedLineMax: 375, role: "Verified final quorum material is persisted and event generation is entered." },
  { id: "single-expiry-event", path: "x/btcstaking/keeper/btc_delegations.go", marker: "k.addPowerDistUpdateEvent(ctx, btcDel.EndHeight-btcDel.UnbondingTime, expiredEvent)", expectedLineMin: 171, expectedLineMax: 181, role: "Schedules the one chronological expiry event." },
  { id: "late-active-event", path: "x/btcstaking/keeper/btc_delegations.go", marker: "k.addPowerDistUpdateEvent(ctx, btcTipHeight, activeEvent)", expectedLineMin: 241, expectedLineMax: 249, role: "First late quorum emits ACTIVE without post-add current-status recomputation." },
  { id: "consumed-events-cleared", path: "x/finality/keeper/power_dist_change.go", marker: "k.BTCStakingKeeper.ClearPowerDistUpdateEvents(ctx, i)", expectedLineMin: 39, expectedLineMax: 43, role: "Consumed expiry event is cleared." },
  { id: "expiry-requires-quorum-to-subtract", path: "x/finality/keeper/power_dist_change.go", marker: "func (k Keeper) processExpiredEvents(", expectedLineMin: 431, expectedLineMax: 435, role: "Expired-event processing subtracts only when quorum exists at processing time." },
  { id: "active-event-trusted", path: "x/finality/keeper/power_dist_change.go", marker: "k.processPowerDistUpdateEventActive(state, btcDel)", expectedLineMin: 403, expectedLineMax: 408, role: "ACTIVE event is trusted without recomputing current delegation status." },
  { id: "totalsat-added", path: "x/finality/keeper/power_dist_change.go", marker: "state.DeltaSatsByFpBtcPk[fpBTCPKHex] += int64(btcDel.TotalSat)", expectedLineMin: 499, expectedLineMax: 505, role: "Expired delegation TotalSat is added to FP power delta." },
  { id: "incentive-activation-hook", path: "x/incentive/keeper/finality_hooks.go", marker: "return h.k.AddEventBtcDelegationActivated", expectedLineMin: 32, expectedLineMax: 39, role: "Stale activation is forwarded into incentive reward tracking." },
  { id: "reward-event-applied", path: "x/incentive/keeper/reward_tracker_events.go", marker: "if err := k.BtcDelegationActivated(", expectedLineMin: 134, expectedLineMax: 141, role: "Queued activation modifies reward-tracker state." },
  { id: "reward-sats-added", path: "x/incentive/keeper/reward_tracker.go", marker: "return k.addDelegationSat(ctx, fp, del, sat)", expectedLineMin: 34, expectedLineMax: 38, role: "Activation adds satoshi weight to reward accounting." },
];

const CALL_GRAPH = [
  { order: 1, node: "BTCDelegation.GetStatus", edge: "no quorum -> PENDING before expiry check", codeRefs: ["status-no-quorum-first", "status-expiry-later"] },
  { order: 2, node: "MsgAddCovenantSigs -> msgServer.AddCovenantSigs", edge: "PENDING passes guard; valid delayed quorum material is accepted", codeRefs: ["add-sigs-handler", "handler-status-guard", "handler-adds-signature"] },
  { order: 3, node: "addCovenantSigsToBTCDelegation", edge: "first quorum with inclusion proof queues ACTIVE at current BTC tip without post-add status recomputation", codeRefs: ["single-expiry-event", "late-active-event"] },
  { order: 4, node: "UpdatePowerDist/processExpiredEvents", edge: "earlier no-quorum EXPIRED event causes no subtraction and is cleared", codeRefs: ["consumed-events-cleared", "expiry-requires-quorum-to-subtract"] },
  { order: 5, node: "processBtcDelUpdate(ACTIVE)", edge: "later ACTIVE event is trusted and TotalSat is added", codeRefs: ["active-event-trusted", "totalsat-added"] },
  { order: 6, node: "finality hooks -> incentive reward tracker", edge: "stale activation is queued and satoshi weight enters reward accounting", codeRefs: ["incentive-activation-hook", "reward-event-applied", "reward-sats-added"] },
];

const ROOT_CHRONOLOGY = [
  { order: 1, codeRef: "x/btcstaking/types/btc_delegation.go:110-161", finding: "GetStatus returns PENDING on absent quorum before evaluating chronological expiry." },
  { order: 2, codeRef: "x/btcstaking/keeper/msg_server.go:245-391", finding: "AddCovenantSigs accepts the PENDING result and rejects only statuses reported as UNBONDED/EXPIRED before adding valid signatures." },
  { order: 3, codeRef: "x/btcstaking/keeper/btc_delegations.go:161-180,186-260", finding: "One expiry event is scheduled; late first quorum queues ACTIVE without post-add status recomputation." },
  { order: 4, codeRef: "x/finality/keeper/power_dist_change.go:24-63,391-460,493-505", finding: "No-quorum expiry does not subtract and the event is cleared; later ACTIVE is trusted and adds TotalSat without a current-status check." },
  { order: 5, codeRef: "x/incentive/keeper/finality_hooks.go:23-39 and reward tracker/gauge paths", finding: "Stale activation reaches incentive event, satoshi-weight, reward-period, and gauge accounting paths." },
];

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function assertAllowedWrite(file) {
  const target = rel(path.resolve(file));
  if (!ALLOWED_WRITES.has(target)) throw new Error(`Refusing write outside Babylon step-2 ownership: ${target}`);
}

function writeAllowed(file, content) {
  assertAllowedWrite(file);
  if (!fs.existsSync(path.dirname(file))) throw new Error(`Missing output directory: ${rel(path.dirname(file))}`);
  fs.writeFileSync(file, content, "utf8");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function git(args) {
  return execFileSync("git", args, { cwd: SOURCE_ROOT, encoding: "utf8", windowsHide: true }).trim();
}

function gitQuiet(args) {
  const result = spawnSync("git", args, { cwd: SOURCE_ROOT, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return { ok: result.status === 0, status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

function lineOf(text, marker) {
  const index = text.indexOf(marker);
  if (index < 0) return null;
  return text.slice(0, index).split(/\r?\n/).length;
}

function validateGitIdentity() {
  if (!fs.existsSync(path.join(SOURCE_ROOT, ".git"))) throw new Error(`Pinned source is not a local git worktree: ${SOURCE_REL}`);
  const commit = git(["rev-parse", "HEAD"]);
  const exactTag = git(["describe", "--tags", "--exact-match", "HEAD"]);
  const tagCommit = git(["rev-list", "-n", "1", EXPECTED_TAG]);
  const statusText = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const statusLines = statusText ? statusText.split(/\r?\n/).filter(Boolean) : [];
  const expectedStatus = [`?? ${ALLOWED_UNTRACKED}`];
  const unstaged = gitQuiet(["diff", "--quiet"]);
  const staged = gitQuiet(["diff", "--cached", "--quiet"]);
  if (commit !== EXPECTED_COMMIT) throw new Error(`Pinned commit mismatch: ${commit}`);
  if (exactTag !== EXPECTED_TAG || tagCommit !== EXPECTED_COMMIT) throw new Error(`Pinned tag mismatch: ${exactTag} -> ${tagCommit}`);
  if (JSON.stringify(statusLines) !== JSON.stringify(expectedStatus)) throw new Error(`Unexpected source dirty state: ${JSON.stringify(statusLines)}`);
  if (!unstaged.ok || !staged.ok) throw new Error("Tracked source modifications detected");
  return {
    sourcePath: SOURCE_REL,
    expectedCommit: EXPECTED_COMMIT,
    observedCommit: commit,
    expectedTag: EXPECTED_TAG,
    observedExactTag: exactTag,
    tagCommit,
    commitMatch: true,
    tagMatch: true,
    trackedModifications: 0,
    stagedModifications: 0,
    untrackedFiles: [ALLOWED_UNTRACKED],
    dirtyStateAllowed: true,
    statusPorcelain: statusLines,
    validationMethod: "offline-read-only-local-git",
  };
}

function loadSourceFiles() {
  const contentByPath = {};
  const sourceManifest = [];
  for (const spec of SOURCE_SPECS) {
    const absolute = path.join(SOURCE_ROOT, spec.path);
    if (!fs.existsSync(absolute)) throw new Error(`Required pinned source/test file missing: ${spec.path}`);
    const buffer = fs.readFileSync(absolute);
    const text = buffer.toString("utf8");
    const markerRows = spec.markers.map((marker) => {
      const line = lineOf(text, marker);
      if (line == null) throw new Error(`Required marker missing in ${spec.path}: ${marker}`);
      return { marker, line, present: true };
    });
    contentByPath[spec.path] = text;
    sourceManifest.push({
      path: `${SOURCE_REL}/${spec.path}`,
      sourceRelativePath: spec.path,
      role: spec.role,
      trackedByPinnedCommit: spec.tracked,
      permittedDefensiveUntrackedFile: !spec.tracked,
      required: true,
      loaded: true,
      bytes: buffer.length,
      sha256: sha256(buffer),
      requiredMarkers: markerRows,
    });
  }
  return { contentByPath, sourceManifest };
}

function resolveCodeReferences(contentByPath) {
  return CODE_REFERENCE_SPECS.map((spec) => {
    const text = contentByPath[spec.path];
    if (text == null) throw new Error(`Code-reference file not loaded: ${spec.path}`);
    const actualLine = lineOf(text, spec.marker);
    if (actualLine == null || actualLine < spec.expectedLineMin || actualLine > spec.expectedLineMax) {
      throw new Error(`Code-reference line mismatch for ${spec.id}: ${actualLine}`);
    }
    return {
      id: spec.id,
      path: `${SOURCE_REL}/${spec.path}`,
      citedRange: `${spec.expectedLineMin}-${spec.expectedLineMax}`,
      actualMarkerLine: actualLine,
      marker: spec.marker,
      role: spec.role,
      sourceValidated: true,
    };
  });
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
  if (raw.sourceIdentity.observedCommit !== EXPECTED_COMMIT || raw.sourceIdentity.observedExactTag !== EXPECTED_TAG) throw new Error("Self-check: source identity");
  if (raw.sourceIdentity.trackedModifications !== 0 || raw.sourceIdentity.stagedModifications !== 0 || raw.sourceIdentity.untrackedFiles.length !== 1 || raw.sourceIdentity.untrackedFiles[0] !== ALLOWED_UNTRACKED) throw new Error("Self-check: dirty state");
  if (raw.sourceManifest.length !== SOURCE_SPECS.length || !raw.sourceManifest.every((row) => row.loaded && row.sha256 && row.requiredMarkers.every((marker) => marker.present))) throw new Error("Self-check: source manifest");
  if (raw.codeReferences.length !== CODE_REFERENCE_SPECS.length || !raw.codeReferences.every((row) => row.sourceValidated)) throw new Error("Self-check: code references");
  if (raw.rootChronology.length !== ROOT_CHRONOLOGY.length) throw new Error("Self-check: root chronology");
  if (raw.finding.findingId !== "BAB-H-01" || raw.finding.findingConfirmed !== true || raw.finding.severity !== "High (conditional)" || raw.finding.directBtcTheft !== false || raw.finding.arbitraryOutsiderPermissionless !== false) throw new Error("Self-check: finding classification");
  if (raw.testEvidence.regression.validationClass !== "recorded-coordinator-validation-not-executed-by-scanner" || raw.testEvidence.regression.result !== "PASS" || raw.testEvidence.scannerExecutedTests !== false) throw new Error("Self-check: regression evidence labeling");
  if (raw.economics.exactEconomicsAvailable !== false || raw.economics.estimatedProfit !== null || raw.economics.affectedLiveStateClaimed !== false) throw new Error("Self-check: economics honesty");
  const gatesOk = raw.auditClassification === "VULNERABLE/CONDITIONAL-HIGH"
    && raw.findingConfirmed === true
    && raw.severity === "High (conditional)"
    && raw.routePositiveOperational === 0
    && raw.routeEvidenceStatus === "unknown"
    && raw.evidenceComplete === false
    && raw.closureEligible === false
    && raw.executableNow === 0
    && raw.signedActionJustified === false
    && raw.aggregatePromotion === false
    && raw.forkPromotion === false
    && raw.executorPromotion === false
    && raw.transactionPromotion === false;
  if (!gatesOk) throw new Error("Self-check: gate consistency");
  return {
    status: "passed",
    sourceIdentity: "exact-tag-commit-and-allowed-dirty-state",
    sourceFilesHashed: raw.sourceManifest.length,
    codeReferencesValidated: raw.codeReferences.length,
    findingClassification: "source-and-local-regression-confirmed-conditional-high",
    gates: "passed-fail-closed",
  };
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Babylon Step-2 Source / Spend-Authority Triage", "");
  lines.push(`Signal: 🟡 VULNERABLE — ${raw.finding.findingId} is source-confirmed and locally regression-confirmed; severity=${raw.severity}, but routePositiveOperational=0, executableNow=0, and signedActionJustified=false.`, "");
  lines.push("## Scope and Safety", "");
  lines.push(`- Scanner: \`${raw.scanner}\`; deterministic timestamp \`${raw.generatedAt}\`.`);
  lines.push(`- Pinned local source: \`${raw.sourceIdentity.sourcePath}\`, exact tag \`${raw.sourceIdentity.observedExactTag}\`, commit \`${raw.sourceIdentity.observedCommit}\`.`);
  lines.push(`- Dirty state validated: no tracked/staged modifications; only permitted untracked defensive test \`${raw.sourceIdentity.untrackedFiles[0]}\`.`);
  lines.push("- Offline filesystem/hash/source trace and read-only local git validation only. The scanner made no network calls, installs, builds, tests, transactions, simulations, forks, signed actions, wallet operations, endpoint/secret reads, or live-state queries.");
  lines.push("- The Docker regression result is recorded coordinator evidence and was not executed by this scanner.", "");

  lines.push("## Finding", "");
  lines.push(`- **${raw.finding.findingId}: ${raw.finding.title}**`);
  lines.push(`- Classification: ${raw.finding.classification}. Severity: **${raw.finding.severity}**.`);
  lines.push("- This is not direct BTC theft and is not permissionless for an arbitrary outsider. Practical activation requires valid quorum-completing covenant material.");
  lines.push("- Impact is phantom/unbacked finality voting weight and potential reward over-allocation after the underlying BTC is withdrawable, with possible repeated capital reuse. No affected live deployment or exact economics is claimed.", "");

  lines.push("## Root Chronology / Call Graph", "");
  table(lines, ["Order", "Node", "State transition / trust edge", "Code refs"], raw.callGraph.map((row) => [row.order, row.node, row.edge, row.codeRefs.join(", ")]));
  table(lines, ["Order", "Requested source range", "Finding"], raw.rootChronology.map((row) => [row.order, `\`${row.codeRef}\``, row.finding]));

  lines.push("## Validated Code References", "");
  table(lines, ["ID", "Pinned path", "Cited range", "Marker line", "Role"], raw.codeReferences.map((row) => [row.id, `\`${row.path}\``, row.citedRange, row.actualMarkerLine, row.role]));

  lines.push("## Reachability Prerequisites", "");
  for (const item of raw.prerequisites) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## Impact and Limits", "");
  for (const item of raw.impact) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## False-Positive Analysis", "");
  for (const item of raw.falsePositiveAnalysis) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## Regression Evidence", "");
  lines.push(`- Defensive test: \`${raw.testEvidence.regression.path}\`; SHA-256 \`${raw.testEvidence.regression.sha256}\`; deterministic seed \`${raw.testEvidence.regression.seed}\`.`);
  lines.push(`- Validation class: \`${raw.testEvidence.regression.validationClass}\`.`);
  lines.push(`- Linux image: \`${raw.testEvidence.regression.image}\`; observed digest \`${raw.testEvidence.regression.imageDigest}\`.`);
  lines.push(`- Exact command: \`${raw.testEvidence.regression.command}\`.`);
  lines.push(`- Result: ${raw.testEvidence.regression.result}; package time ${raw.testEvidence.regression.packageTime}; test time ${raw.testEvidence.regression.testTime}.`);
  lines.push(`- Direct proof boundary: ${raw.testEvidence.regression.directProofBoundary}.`);
  lines.push(`- Native Windows: ${raw.testEvidence.nativeWindows.status} — ${raw.testEvidence.nativeWindows.reason}.`, "");

  lines.push("## Existing Adjacent Coverage", "");
  table(lines, ["Test", "Path", "What it covers", "Why it does not close BAB-H-01"], raw.existingCoverage.map((row) => [row.test, `\`${row.path}\``, row.coverage, row.gap]));

  lines.push("## Source Manifest", "");
  table(lines, ["Path", "Role", "Tracked", "Bytes", "SHA-256"], raw.sourceManifest.map((row) => [`\`${row.path}\``, row.role, row.trackedByPinnedCommit, row.bytes, `\`${row.sha256}\``]));

  lines.push("## Recommended Remediation", "");
  for (const item of raw.mitigations) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## Unresolved Deployment / Economic Blockers", "");
  for (const item of raw.unresolvedBlockers) lines.push(`- ${item}`);
  lines.push("- Exact economics are absent; no profit estimate and no affected-live-state claim is made.", "");

  lines.push("## Next Safe Step", "");
  lines.push(`- ${raw.nextStep}`);
  lines.push("- Prepare remediation tests and a patch separately against a controlled local source copy; do not perform live action.", "");

  lines.push("## Gates", "");
  lines.push("- `auditClassification=VULNERABLE/CONDITIONAL-HIGH`; `findingConfirmed=true`; `severity=High (conditional)`");
  lines.push("- `routePositiveOperational=0`; `routeEvidenceStatus=unknown`; `evidenceComplete=false`; `closureEligible=false`");
  lines.push("- `executableNow=0`; `signedActionJustified=false`");
  lines.push("- No aggregate, fork, executor, transaction, or signed-action promotion.", "");
  return lines.join("\n");
}

function main() {
  const sourceIdentity = validateGitIdentity();
  const { contentByPath, sourceManifest } = loadSourceFiles();
  const codeReferences = resolveCodeReferences(contentByPath);
  const regressionManifest = sourceManifest.find((row) => row.sourceRelativePath === ALLOWED_UNTRACKED);
  if (!regressionManifest) throw new Error("Regression test missing from source manifest");

  const raw = {
    generatedAt: GENERATED_AT,
    scanner: SCANNER,
    signal: "🟡 VULNERABLE",
    scope: "Babylon v4.3.0 deterministic offline source/spend-authority trace for BAB-H-01",
    safety: {
      deterministicOffline: true,
      localFilesystemRead: true,
      localGitReadOnlyValidation: true,
      networkCalls: false,
      packageInstalls: false,
      trackedProductionSourceModified: false,
      defensiveRegressionTestAdded: true,
      buildsExecuted: false,
      testsExecutedByScanner: false,
      liveExecution: false,
      endpointInventoriesRead: false,
      secretsRead: false,
      transactions: false,
      simulations: false,
      forks: false,
      signedActions: false,
      walletOps: false,
      aggregateGatePromoted: false,
    },
    sourceIdentity,
    sourceManifest,
    codeReferences,
    callGraph: CALL_GRAPH,
    rootChronology: ROOT_CHRONOLOGY,
    finding: {
      findingId: "BAB-H-01",
      title: "Late covenant quorum can inject an expired delegation into voting-power and reward caches",
      classification: "source-confirmed and locally regression-confirmed logic vulnerability",
      findingConfirmed: true,
      severity: "High (conditional)",
      severityCondition: "Valid quorum-completing covenant material is available after the earlier no-quorum expiry event has been processed and cleared.",
      directBtcTheft: false,
      arbitraryOutsiderPermissionless: false,
      currentExecutableExploitConfirmed: false,
      affectedLiveStateClaimed: false,
    },
    prerequisites: [
      "The delegation has an inclusion proof and reaches chronological expiry without covenant quorum.",
      "The scheduled EXPIRED event is processed and cleared while quorum is absent, so no power subtraction/correction is recorded.",
      "Quorum-1 covenant signatures are stored and one delayed, malicious, leaked, or pre-produced valid signer payload later completes quorum; full covenant collusion is unnecessary.",
      "A Cosmos account can relay valid covenant material because transaction signer identity is not bound to the covenant public key; the relayer still cannot forge covenant signatures.",
      "For practical finality/reward impact, the delegated FP must satisfy eligibility, timestamped randomness, top-set, and voting/reward conditions.",
    ],
    impact: [
      "A late ACTIVE event can add the expired delegation TotalSat to finality-provider voting-power distribution caches.",
      "No correction event remains after the earlier no-quorum expiry event was cleared, so phantom/unbacked finality weight can persist indefinitely across cycles absent separate reconciliation.",
      "Finality activation hooks can add stale satoshi weight to reward-tracker and gauge paths, permitting reward over-allocation if downstream eligibility conditions hold.",
      "The underlying BTC can be withdrawable while stale finality/reward weight remains, allowing possible repeated capital reuse.",
      "The finding does not demonstrate direct BTC theft, arbitrary-outsider permissionless exploitation, affected production state, or exact profit.",
    ],
    falsePositiveAnalysis: [
      "TestActiveAndExpiredEventsSameBlock exercises ACTIVE and EXPIRED in the same batch and can net the delta to zero.",
      "BAB-H-01 requires the EXPIRED event to be processed and cleared in an earlier BeginBlock while quorum is absent, followed by late first quorum and a later ACTIVE event.",
      "TestIgnoreExpiredEventIfThereIsNoQuorum confirms the expiry event is ignored without quorum but does not add quorum after that event is cleared.",
      "The regression asserts stored GetStatus is EXPIRED while an ACTIVE event is queued and later trusted, then proves TotalSat remains in cache with no correction event.",
      "The pinned source trace found no periodic status/cache reconciliation or expiry-event rescheduling on late quorum in the traced path.",
    ],
    testEvidence: {
      scannerExecutedTests: false,
      regression: {
        path: `${SOURCE_REL}/${ALLOWED_UNTRACKED}`,
        sha256: regressionManifest.sha256,
        test: "TestLateCovenantQuorumAfterExpiryEventCreatesPhantomPower",
        seed: "1",
        validationClass: "recorded-coordinator-validation-not-executed-by-scanner",
        environment: "ephemeral Docker",
        image: "golang:1.23.8-bookworm",
        imageDigest: "sha256:0b4f8c5d414756a53ba0e4d235151f9b246552e512c3feaad5f9a3251376b279",
        command: "go test ./x/btcstaking/keeper -run TestLateCovenantQuorumAfterExpiryEventCreatesPhantomPower -count=1 -v",
        result: "PASS",
        packageTime: "0.170s",
        testTime: "0.04s",
        rewardLifecycleExecuted: false,
        directProofBoundary: "The regression directly proves persistent phantom finality distribution-cache power. Reward over-allocation is source-path-confirmed and conditional; the mock-hook regression does not execute reward-tracker/gauge lifecycle.",
        proved: [
          "Expiry event cleared with no quorum.",
          "Final covenant signature succeeds after expiry-event consumption.",
          "Stored delegation status is EXPIRED while ACTIVE event is queued.",
          "Next finality cycle cache contains delegation TotalSat.",
          "No correction event remains and stale cache persists another cycle.",
        ],
      },
      nativeWindows: {
        status: "blocked-environment-limitation-not-code-failure",
        reason: "dependency compilation blocked because wasmvm uses Unix symbols",
      },
    },
    existingCoverage: [
      { test: "TestActiveAndExpiredEventsSameBlock", path: `${SOURCE_REL}/x/btcstaking/keeper/msg_server_test.go:1499`, coverage: "ACTIVE+EXPIRED events processed in the same batch.", gap: "Does not cover expiry processed/cleared in an earlier BeginBlock before late quorum." },
      { test: "TestIgnoreExpiredEventIfThereIsNoQuorum", path: `${SOURCE_REL}/x/finality/keeper/power_dist_change_test.go:1921`, coverage: "No-quorum expiry causes no unbond subtraction.", gap: "Does not complete quorum after the ignored expiry event has been cleared." },
    ],
    mitigations: [
      "Evaluate chronological expiry before returning PENDING for missing quorum, while explicitly preserving valid pre-registration semantics.",
      "Reject AddCovenantSigs when the delegation is chronologically expired/unbonded, independent of the pre-quorum status label.",
      "After adding the signature, recompute current status and emit ACTIVE only when the delegation is currently ACTIVE.",
      "At finality event consumption, validate event height/current delegation status and use an accounted/idempotent marker or equivalent reconciliation so stale ACTIVE cannot add power.",
      "Preserve same-batch ACTIVE+EXPIRED net-zero behavior and avoid a current-tip-only skip that could suppress a necessary subtraction and create negative-delta/accounting errors.",
      "Add migration/reconciliation for voting-power caches, FP power, reward trackers, gauges, and affected expired-no-quorum delegations before enabling fixed logic.",
      "Retain the late-quorum regression plus pre-registration, same-batch, reorg, idempotence, and migration tests as remediation gates.",
    ],
    unresolvedBlockers: [
      "Current deployed Babylon version/commit and whether the vulnerable path is live are not established.",
      "No read-only inventory of expired-no-quorum delegations, late covenant submissions, or finality cache mismatches has been collected.",
      "No current valid quorum-completing covenant material or signer behavior is known.",
      "FP eligibility, timestamped randomness, active top-set membership, voting activity, and reward realization are unknown for any candidate delegation.",
      "No current reward over-allocation, withdrawable gauge amount, affected live balance, or repeated-capital-reuse instance is proven.",
      "No exact acquisition, timing, fee, reward, exit, or profit economics are available.",
    ],
    economics: {
      exactEconomicsAvailable: false,
      estimatedProfit: null,
      affectedLiveStateClaimed: false,
      currentDeploymentQueried: false,
      conclusion: "No profit estimate or live impact claim; operational route remains unknown.",
    },
    auditReviewerVerdict: {
      verdict: "VALID High conditional",
      hiddenRepairFound: false,
      source: "recorded coordinator-provided audit-reviewer verdict",
    },
    nextStep: "Check the current deployed version/state read-only, then search sanitized public state for expired-no-quorum delegations and voting-power/reward-cache mismatches; do not submit signatures or perform live actions.",
    auditClassification: "VULNERABLE/CONDITIONAL-HIGH",
    findingConfirmed: true,
    severity: "High (conditional)",
    routePositiveOperational: 0,
    routeEvidenceStatus: "unknown",
    evidenceComplete: false,
    closureEligible: false,
    executableNow: 0,
    signedActionJustified: false,
    aggregatePromotion: false,
    forkPromotion: false,
    executorPromotion: false,
    transactionPromotion: false,
  };

  raw.selfChecks = selfCheck(raw);
  writeAllowed(OUT_JSON, `${JSON.stringify(raw, null, 2)}\n`);
  writeAllowed(OUT_MD, `${renderReport(raw)}\n`);
  console.log(`wrote ${rel(OUT_JSON)} and ${rel(OUT_MD)}`);
  console.log(`sourceTag=${raw.sourceIdentity.observedExactTag} sourceCommit=${raw.sourceIdentity.observedCommit} trackedModifications=0 allowedUntracked=1 sourceFiles=${raw.sourceManifest.length} codeRefs=${raw.codeReferences.length}`);
  console.log(`finding=${raw.finding.findingId} confirmed=${raw.findingConfirmed} severity=${raw.severity} regression=${raw.testEvidence.regression.result} regressionEvidence=${raw.testEvidence.regression.validationClass} selfChecks=${raw.selfChecks.status}`);
  console.log(`auditClassification=${raw.auditClassification} routePositiveOperational=${raw.routePositiveOperational} routeEvidenceStatus=${raw.routeEvidenceStatus} evidenceComplete=${raw.evidenceComplete} closureEligible=${raw.closureEligible} executableNow=${raw.executableNow} signedActionJustified=${raw.signedActionJustified}`);
}

try {
  main();
} catch (error) {
  console.error(`scan-babylon-source-spend-authority failed: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
}
