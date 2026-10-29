#!/usr/bin/env node
"use strict";

// Strictly offline packaging-only successor. It reads and hash-binds R3 but
// performs no source lookup, compilation, RPC, fork, or state operation.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-cashmodule-source-runtime-continuity-r4";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/review-${NAME}-2026-07-24.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const R3_RAW = "reports/raw/fast/critical-etherfi-cashmodule-source-runtime-continuity-r3.json";
const R3_MANIFEST = "reports/raw/fast/critical-etherfi-cashmodule-source-runtime-continuity-r3-manifest.json";
const R3_REPORT = "reports/critical-etherfi-cashmodule-source-runtime-continuity-r3.md";
const R3_INBOX = "coordination/inbox/review-critical-etherfi-cashmodule-source-runtime-continuity-r3-2026-07-24.json";
const R3_HANDOFF = "coordination/handoffs/2026-07-24-critical-etherfi-cashmodule-source-runtime-continuity-r3-handoff.md";
const EXPECTED_R3_AGGREGATE = "ddd58f3aad994a4c48efb832e47a1ac94e603e221ded4903cd0a606653399cfa";
const EXPECTED_R3_EVIDENCE = "bf14c575225075e872fd1cc3dc8c7c50c009b8f5929f1d4b7bbb881ed3361ed2";
const CORE_RUNTIME = "0xd5a9fdc7bfbe6b1aad67f89ca343b7c0d7ef4e5be009f1f839e318c190676a96";
const SETTERS_RUNTIME = "0x7879eb1ff3bc862e351f9628fadb509b009545826e32d3415f79ddd12e51c4b5";
const CLASSIFICATION = "INFORMATIONAL/CLOSED-CURRENT-PIN/REVIEWER-R4/OFFLINE-PACKAGING-CORRECTION/R3-EXACT-RUNTIME-CONCLUSIONS-UNCHANGED/TWO-R3-PUBLIC-SOURCE-VERIFICATION-HTTP-READS/ZERO-RPC-FORK-LIVE/NO-ATTACKER-GAIN";
const AGENT = "reviewer-etherfi-cashmodule-continuity-r4-20260724";

// Fail closed if future edits accidentally try to use the platform fetch API.
Object.defineProperty(globalThis, "fetch", { value: () => { throw new Error("R4 offline packaging guard"); }, writable: false, configurable: false });

const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

function writeOwned(rel, text) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text, "utf8");
}
function verifyR3Manifest() {
  const manifest = JSON.parse(fs.readFileSync(abs(R3_MANIFEST), "utf8"));
  for (const row of manifest.records) {
    const current = hashFile(row.path);
    if (current.bytes !== row.bytes || current.sha256 !== row.sha256) throw new Error(`R3 record mismatch: ${row.path}`);
  }
  const aggregate = sha(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"));
  if (aggregate !== manifest.aggregateSha256 || aggregate !== EXPECTED_R3_AGGREGATE) throw new Error("R3 aggregate mismatch");
  return manifest;
}

function main() {
  const generatedAt = new Date().toISOString();
  const r3Manifest = verifyR3Manifest();
  const r3 = JSON.parse(fs.readFileSync(abs(R3_RAW), "utf8"));
  if (r3.safety.publicSourceVerificationReads !== 2) throw new Error("R3 public source-verification read count mismatch");
  if (r3.safety.rpcInventoryRead !== false || r3.safety.rpcCalls !== 0 || r3.safety.fork !== false || r3.safety.transactions !== false || r3.safety.signedActions !== false || r3.safety.broadcasts !== false || r3.safety.productionMutation !== false) throw new Error("R3 scoped activity facts mismatch");
  if (r3.evidenceCommitmentSha256 !== EXPECTED_R3_EVIDENCE) throw new Error("R3 evidence commitment mismatch");
  const core = r3.components.find((row) => row.component === "CashModuleCore");
  const setters = r3.components.find((row) => row.component === "CashModuleSetters");
  if (core?.runtime?.onchainKeccak256 !== CORE_RUNTIME || setters?.runtime?.onchainKeccak256 !== SETTERS_RUNTIME) throw new Error("R3 runtime conclusion mismatch");
  if (!r3.binding.exactSourceRuntimeContinuity || !r3.binding.deployedWithdrawalStateMachineSemanticsJoined) throw new Error("R3 exact continuity conclusion mismatch");

  const retainedTechnicalEvidence = {
    correction: r3.correction,
    fixedPin: r3.fixedPin,
    components: r3.components,
    binding: r3.binding,
    currentConfigurationGate: r3.currentConfigurationGate,
    conclusion: r3.conclusion,
    localBuild: r3.localBuild,
    evidenceCommitmentSha256: r3.evidenceCommitmentSha256,
    nextGate: r3.nextGate,
  };
  const result = {
    schemaVersion: 1,
    revision: "cashmodule-source-runtime-continuity-reviewer-r4-offline-packaging-correction",
    runId: `etherfi-cashmodule-continuity-r4-${r3.fixedPin.number}-${CORE_RUNTIME.slice(2, 14)}-${SETTERS_RUNTIME.slice(2, 14)}-${EXPECTED_R3_AGGREGATE.slice(0, 12)}`,
    generatedAt,
    agentId: AGENT,
    role: "reviewer",
    classification: CLASSIFICATION,
    correctionScope: {
      packagingOnly: true,
      technicalConclusionChanged: false,
      runtimeHashesChanged: false,
      fixedPinChanged: false,
      classificationRemainsCurrentPinClosure: true,
      correctedStatement: "R3 performed exactly two public source-verification HTTP reads. R3 recorded zero RPC inventory reads, zero RPC calls, zero fork execution, zero transactions, zero signing, zero broadcasts, and zero production mutation. R4 itself is offline packaging-only and performed zero HTTP reads of any kind and the same zero RPC/fork/live activity.",
    },
    activityScope: {
      r3Historical: {
        publicSourceVerificationReads: 2,
        rpcInventoryReads: 0,
        rpcCalls: 0,
        forkExecutions: 0,
        transactions: 0,
        signedActions: 0,
        broadcasts: 0,
        productionMutations: 0,
      },
      r4PackagingRun: {
        offlinePackagingOnly: true,
        publicSourceVerificationReads: 0,
        otherHttpReads: 0,
        rpcInventoryReads: 0,
        rpcCalls: 0,
        forkExecutions: 0,
        transactions: 0,
        signedActions: 0,
        broadcasts: 0,
        productionMutations: 0,
        compilationRuns: 0,
      },
    },
    predecessorR3: {
      runId: r3.runId,
      classification: r3.classification,
      raw: hashFile(R3_RAW),
      report: hashFile(R3_REPORT),
      inbox: hashFile(R3_INBOX),
      handoff: hashFile(R3_HANDOFF),
      manifest: { ...hashFile(R3_MANIFEST), aggregateSha256: EXPECTED_R3_AGGREGATE, recordCount: r3Manifest.records.length },
      records: r3Manifest.records,
    },
    retainedTechnicalEvidence,
    retainedTechnicalEvidenceSha256: sha(canonical(retainedTechnicalEvidence)),
    r4Conclusion: {
      status: r3.conclusion.status,
      currentPinClosure: true,
      exactSourceRuntimeContinuity: true,
      coreRuntimeKeccak256: CORE_RUNTIME,
      settersRuntimeKeccak256: SETTERS_RUNTIME,
      branchPipeline: r3.conclusion.branchPipeline,
      extractionPipeline: r3.conclusion.extractionPipeline,
      globalHighestPipeline: r3.conclusion.globalHighestPipeline,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      attackerGainRaw: "0",
    },
    nextGate: r3.nextGate,
  };

  const rawText = JSON.stringify(result, null, 2) + "\n";
  const reportText = `# Ether.fi CashModule continuity — reviewer R4 packaging correction\n\n**Signal:** ⚪ CLEAN for current-pin permissionless extraction; conditional integration semantics retained.  \n**Classification:** \`${CLASSIFICATION}\`  \n**Pin:** Optimism \`${r3.fixedPin.number}\` / \`${r3.fixedPin.hash}\`.\n\n## Activity-scope correction\n\nR3 performed exactly **2 public source-verification HTTP reads**. R3 recorded **0 RPC inventory reads, 0 RPC calls, 0 fork executions, 0 transactions, 0 signing operations, 0 broadcasts, and 0 production mutations**.\n\nR4 is packaging-only and was produced offline: **0 public source-verification HTTP reads, 0 other HTTP reads, 0 RPC inventory reads, 0 RPC calls, 0 fork executions, 0 transactions, 0 signing operations, 0 broadcasts, 0 production mutations, and 0 compilation runs**.\n\nThis wording correction does not change any R3 technical result.\n\n## Immutable R3 binding\n\n- R3 manifest aggregate: \`${EXPECTED_R3_AGGREGATE}\` (${r3Manifest.records.length} records).\n- R3 evidence commitment: \`${r3.evidenceCommitmentSha256}\`.\n- Core runtime: \`${CORE_RUNTIME}\`.\n- Setters runtime: \`${SETTERS_RUNTIME}\`.\n- Source bundles: Core **${core.sourceMatchCount}/${core.sourceCount}**, Setters **${setters.sourceMatchCount}/${setters.sourceCount}**.\n- Exact source/runtime continuity and deployed withdrawal-state-machine join remain **true**.\n- Current token gate remains **20 tokens / 60 probes / 20 standard-boolean exact / 0 false, fee, partial, or unresolved / attacker gain 0**.\n\n## Disposition\n\nCurrent-pin closure is unchanged. Branch \`${r3.conclusion.branchPipeline}\`; extraction \`${r3.conclusion.extractionPipeline}\`; global highest \`${r3.conclusion.globalHighestPipeline}\`. Reopen only under the R3 next gate.\n`;
  const inbox = {
    findingId: NAME,
    agentId: AGENT,
    role: "reviewer",
    status: "closed-current-pin-packaging-correction",
    classification: CLASSIFICATION,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    activityScope: { historicalR3PublicSourceVerificationReads: 2, r4PublicSourceVerificationReads: 0, r4OtherHttpReads: 0, rpcInventoryReads: 0, rpcCalls: 0, forkExecutions: 0, transactions: 0, signedActions: 0, broadcasts: 0, productionMutations: 0 },
    summary: "Offline R4 packaging correction binds R3 unchanged and records its exactly two public source-verification HTTP reads alongside zero RPC/fork/live activity; exact runtimes and current-pin closure are unchanged.",
    artifacts: [RAW, REPORT, MANIFEST],
    nextAction: result.nextGate,
  };
  const handoffText = `# Handoff: ${NAME}\n\n- R4 itself is offline packaging-only: 0 public source-verification HTTP reads, 0 other HTTP reads, 0 RPC inventory reads, 0 RPC calls, 0 forks, 0 transactions, 0 signing, 0 broadcasts, 0 production mutations, and 0 compilation runs.\n- Historical R3 performed exactly 2 public source-verification HTTP reads; its RPC/fork/live counts above were zero.\n- R3 aggregate \`${EXPECTED_R3_AGGREGATE}\` and all ${r3Manifest.records.length} records are hash-bound unchanged.\n- Core \`${CORE_RUNTIME}\`; Setters \`${SETTERS_RUNTIME}\`; exact continuity and deployed semantic join unchanged.\n- Current-pin closure, 20-token/60-probe negative gate, attacker gain 0, branch 1/5, extraction 0/5, and global DebtManager donation 2/5 are unchanged.\n- Validate with \`node ${VALIDATOR}\`.\n`;
  writeOwned(RAW, rawText);
  writeOwned(REPORT, reportText);
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, handoffText);
  const predecessorRecords = [hashFile(R3_MANIFEST), ...r3Manifest.records];
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF].map(hashFile).concat(predecessorRecords);
  const manifest = { schemaVersion: 1, revision: result.revision, runId: result.runId, generatedAt, records, aggregateSha256: sha(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")) };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, runId: result.runId, classification: CLASSIFICATION, r3PublicSourceVerificationReads: 2, r4PublicSourceVerificationReads: 0, r4OtherHttpReads: 0, r3ManifestAggregateSha256: EXPECTED_R3_AGGREGATE, coreRuntime: CORE_RUNTIME, settersRuntime: SETTERS_RUNTIME, branchPipeline: result.r4Conclusion.branchPipeline, extractionPipeline: result.r4Conclusion.extractionPipeline, globalHighestPipeline: result.r4Conclusion.globalHighestPipeline, manifestAggregateSha256: manifest.aggregateSha256 }, null, 2));
}

try { main(); } catch (error) { console.error(`cashmodule continuity r4 packaging failed: ${String(error?.message || error).slice(0, 1200)}`); process.exit(1); }
