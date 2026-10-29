#!/usr/bin/env node
"use strict";

// Offline-only evidence normalizer for the Aster BNB treasury control package.
// This file has no network client, endpoint input, RPC implementation, or subprocess use.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REVISION = "oracle-blockers-offline-r1";
const RUN_ID = "aster-bnb-treasury-control-110679576-1a8eeb2eaff0";
const NORMALIZER = "tools/normalize-critical-aster-bnb-treasury-control-offline.js";
const RETIRED_SCANNER = "tools/scan-critical-aster-bnb-treasury-control.js";
const RAW = "reports/raw/fast/critical-aster-bnb-treasury-control.json";
const REPORT = "reports/critical-aster-bnb-treasury-control.md";
const MANIFEST = "reports/raw/fast/critical-aster-bnb-treasury-control-manifest.json";
const INBOX = "coordination/inbox/critical/2026-07-18-090039-critical-aster-treasury-control-aster-bnb-treasury-control.json";
const HANDOFF = "coordination/handoffs/2026-07-18-090039-critical-aster-treasury-control-handoff.md";
const UPDATE_SELECTOR = "0x413bcb44";
const RENOUNCE_SELECTOR = "0x36568abe";

function abs(rel) { return path.join(ROOT, rel); }
function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function fileRecord(rel, role) {
  const data = fs.readFileSync(abs(rel));
  return { path: rel, role, bytes: data.length, sha256: sha256(data) };
}
function write(rel, text) {
  const allowed = new Set([RAW, REPORT, MANIFEST, INBOX, HANDOFF]);
  if (!allowed.has(rel)) throw new Error(`offline normalizer write refused: ${rel}`);
  fs.writeFileSync(abs(rel), text, "utf8");
}
function short(value, n = 18) {
  if (value == null) return "null";
  const text = String(value);
  return text.length > n + 4 ? `${text.slice(0, n)}…${text.slice(-4)}` : text;
}
function md(value) { return String(value == null ? "null" : value).replace(/\|/g, "\\|").replace(/\n/g, " "); }
function transcriptHash(transcript) { return sha256(Buffer.from(JSON.stringify(transcript), "utf8")); }

function validateCorrectedState(raw) {
  const failures = [];
  const require = (condition, message) => { if (!condition) failures.push(message); };
  require(raw.runId === RUN_ID, "run ID changed");
  require(raw.revision === REVISION, "revision missing");
  require(raw.sourceRuntimeEquivalence === null, "sourceRuntimeEquivalence must be null");
  require(raw.localExactBuildEquivalence === null, "root localExactBuildEquivalence must be null");
  require(raw.localBuildAttempted === false, "root localBuildAttempted must be false");
  require(raw.sourceRuntime?.sourceRuntimeEquivalence === null, "nested sourceRuntimeEquivalence must be null");
  require(raw.sourceRuntime?.localExactBuildEquivalence === null, "localExactBuildEquivalence must be null");
  require(raw.sourceRuntime?.localBuildAttempted === false, "localBuildAttempted must be false");
  require(raw.sourceRuntime?.status === "UNPROVEN_NO_STANDARD_JSON", "source/runtime status mismatch");
  require(raw.closeSubbranch === false, "subbranch must remain open");
  require(raw.closureRule?.equivalenceMustEqualExactlyTrue === true, "strict closure rule absent");
  require(raw.closureRule?.eligible === false, "closure eligibility malformed");
  require(raw.networkRunProvenance?.networkRunnerSourceRetained === false, "network runner retention must be false");
  require(raw.networkRunProvenance?.networkRunnerSourceSha256 === null, "unretained runner cannot have an authoritative hash");
  require(raw.networkRunProvenance?.currentPostCorrectionScannerWasExactNetworkRunner === false, "current scanner provenance malformed");
  require(raw.networkRunProvenance?.finalTranscriptRetained === true, "final transcript retention missing");
  require(raw.networkRunProvenance?.finalTranscriptReadCountExact === 84, "final transcript count must be exact 84");
  require(Array.isArray(raw.rpcTranscript) && raw.rpcTranscript.length === 84, "final transcript array must contain 84 reads");
  require(raw.requestBudget?.taskTotalReconstructed === 168, "reconstructed task total mismatch");
  require(raw.requestBudget?.taskTotalExact === false, "task total must not be represented as exact");
  require(raw.requestBudget?.firstAttemptTranscriptRetained === false, "first-attempt transcript must be absent");
  const update = raw.callMatrix?.find((x) => x.selector === UPDATE_SELECTOR);
  require(update?.result?.outcome === "untested", "updateHourlyLimit must remain untested");
  require(update?.result?.classification === "WATCH/separate-minimal-new-pin-run-required", "updateHourlyLimit WATCH label mismatch");
  const renounce = raw.callMatrix?.find((x) => x.selector === RENOUNCE_SELECTOR);
  require(renounce?.result?.outcome === "success", "renounceRole outcome mismatch");
  require(renounce?.result?.classification === "expected-benign-self-renounce/source-semantics-unproven", "renounceRole qualification missing");
  require(raw.futureNetworkRunRequirements?.fullScannerRerunAllowed === false, "full scanner rerun must be forbidden");
  require(raw.futureNetworkRunRequirements?.immutableRunnerPreHashRequired === true, "immutable pre-hash requirement absent");
  require(raw.futureNetworkRunRequirements?.newRunIdRequired === true, "new run ID requirement absent");
  require(raw.offlineCorrection?.zeroNetwork === true, "offline correction must declare zero network");
  return failures;
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Aster Bridge BNB Treasury Control / Direct-Release Review", "");
  lines.push(`Signal: ${raw.signal} — **${raw.classification}**.`, "");
  lines.push(`Evidence revision: \`${raw.revision}\` under unchanged network run ID \`${raw.runId}\`. This revision is an offline normalization only.`, "");
  lines.push("## Network-run provenance", "");
  lines.push("- `networkRunnerSourceRetained=false`. The exact source that produced the final 84-read transcript is not retained or reconstructable as a hashable file.");
  lines.push(`- The current \`${RETIRED_SCANNER}\` is a retired post-correction tool and is explicitly **not** represented as the exact network runner.`);
  lines.push(`- Final transcript: exactly \`${raw.networkRunProvenance.finalTranscriptReadCountExact}\` retained reads; transcript SHA-256 \`${raw.networkRunProvenance.finalTranscriptSha256}\`.`);
  lines.push(`- Earlier attempt: transcript not retained. Task total is reconstructed as \`${raw.requestBudget.taskTotalReconstructed}\`; \`taskTotalExact=false\`.`);
  lines.push(`- Offline normalizer: \`${NORMALIZER}\`; zero network operations.`, "");
  lines.push("## Fixed-pin evidence", "");
  lines.push(`- Finalized BNB pin: block \`${raw.pin.blockNumberDecimal}\` / \`${raw.pin.blockHash}\`; terminal same-number hash recheck=${raw.terminalPinConsistency.consistent}.`);
  lines.push(`- Proxy \`${raw.proxy.address}\`: runtime \`${raw.proxy.code.keccak256}\` (${raw.proxy.code.bytes} bytes).`);
  lines.push(`- Actual EIP-1967 implementation: \`${raw.implementation.address}\`; recorded hypothesis match=${raw.implementation.recordedHypothesisMatch}.`);
  lines.push(`- Implementation runtime: \`${raw.implementation.code.keccak256}\` (${raw.implementation.code.bytes} bytes); admin=${raw.proxy.adminAddress || "zero"}; beacon=${raw.proxy.beaconAddress || "zero"}.`);
  lines.push(`- No-code caller: \`${raw.caller.address}\`; exact code \`${raw.caller.codeExact}\`.`, "");
  lines.push("## Source/runtime status", "");
  lines.push(`- Status: \`${raw.sourceRuntime.status}\`.`);
  lines.push("- `sourceRuntimeEquivalence=null`, `localExactBuildEquivalence=null`, `localBuildAttempted=false`. No standard-json compiler input was recovered and no local build was attempted.");
  lines.push("- Closure requires equivalence exactly `true`; the subbranch remains open.");
  lines.push(`- Explorer metadata/ABI context: verified=${raw.sourceRuntime.explorer.explorerVerified}; contract=${raw.sourceRuntime.explorer.contractName}; compiler=${raw.sourceRuntime.explorer.compilerVersion}; ABI functions=${raw.sourceRuntime.dispatcher.abiFunctions.length}.`);
  lines.push(`- Dispatcher heuristic: ${raw.sourceRuntime.dispatcher.completeDispatcherMap.length} comparator selectors, ${raw.sourceRuntime.dispatcher.unmappedDispatcherSelectors.length} unmapped, ${raw.sourceRuntime.dispatcher.abiSelectorsNotObservedInDispatcherComparators.length} ABI selectors absent. Limitations remain those recorded in raw JSON.`, "");
  lines.push("## Selector / call matrix", "");
  lines.push("| Selector | Signature | Outcome | Classification | Exact return/revert |", "|---|---|---|---|---|");
  for (const row of raw.callMatrix) {
    lines.push(`| ${row.selector} | ${md(row.signature)} | ${row.result.outcome} | ${md(row.result.classification)} | ${short(row.result.exactData, 22)} |`);
  }
  lines.push("", "`updateHourlyLimit(1)` remains untested/WATCH. It requires a separate minimal new-pin runner, not a full scanner rerun.", "");
  lines.push("## State and same-pin balances", "");
  lines.push(`- Initialized state: ${raw.initializedState}; paused=${raw.moduleState["paused()"]?.decoded?.[0] || "unresolved"}.`);
  lines.push(`- Default admin members: ${(raw.roles.find((x) => x.name === "DEFAULT_ADMIN_ROLE")?.members || []).join(", ") || "unresolved"}.`);
  lines.push(`- Timelock: ${raw.moduleState["TIMELOCK_ADDRESS()"]?.decoded?.[0] || "unresolved"}; withdrawal validator: ${raw.moduleState["WITHDRAW_VALIDATOR()"]?.decoded?.[0] || "unresolved"}.`);
  lines.push(`- Native BNB: \`${raw.balances.native.rawWei}\` wei = \`${raw.balances.native.formatted}\` BNB.`);
  lines.push("| Token | Raw | Exact units |", "|---|---:|---:|");
  for (const token of raw.balances.tokens) lines.push(`| ${token.symbol} | ${token.balanceRaw} | ${token.formatted} |`);
  lines.push("", "## Classification and remaining action", "");
  lines.push("- No executed outsider call returned a control-acquisition or direct-release success. This is not source-semantic closure.");
  lines.push("- Self-renounce returned success, but is labeled only `expected-benign-self-renounce/source-semantics-unproven` without runtime-equivalent source.");
  lines.push(`- Route/executable/signing remain \`${raw.routePositive}/${raw.executableNow}/${raw.signedActionJustified}\`.`);
  lines.push(`- ${raw.nextAction}`, "");
  return `${lines.join("\n")}\n`;
}

function renderInbox(raw, aggregate) {
  return `${JSON.stringify({
    findingId: raw.runId,
    revision: raw.revision,
    correctionType: "offline-evidence-correction",
    agentId: "critical-aster-treasury-control-20260718",
    role: "critical-research",
    status: "watch-only",
    classification: raw.classification,
    signal: "WATCH",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closeSubbranch: false,
    networkRunnerSourceRetained: false,
    sourceRuntimeEquivalence: null,
    localExactBuildEquivalence: null,
    localBuildAttempted: false,
    finalTranscriptReadCountExact: 84,
    finalTranscriptSha256: raw.networkRunProvenance.finalTranscriptSha256,
    taskTotalReconstructed: 168,
    taskTotalExact: false,
    updateHourlyLimit: "UNTESTED/WATCH",
    summary: "Offline oracle-blocker correction: exact 84-read transcript retained, exact runner source not retained, source/runtime equivalence unproven/null, task total reconstructed rather than exact, self-renounce semantics qualified, and updateHourlyLimit remains untested.",
    artifacts: [NORMALIZER, RETIRED_SCANNER, RAW, MANIFEST, REPORT, HANDOFF],
    manifestAggregateSha256: aggregate,
    nextAction: raw.nextAction,
  }, null, 2)}\n`;
}

function renderHandoff(raw, aggregate) {
  return `# Aster BNB Treasury Control — Offline Oracle-Blocker Handoff\n\n` +
    `Run ID: \`${raw.runId}\`  \nRevision: \`${raw.revision}\`  \nRole: \`critical-research\`  \nClaim: retained; do not release\n\n` +
    `## Result\n\n${raw.signal} \`${raw.classification}\`. Global route/executable/signing remains \`0/0/false\`.\n\n` +
    `## Provenance correction\n\n- Exact final transcript retained: 84 reads, SHA-256 \`${raw.networkRunProvenance.finalTranscriptSha256}\`.\n` +
    `- Exact network-runner source is not retained: \`networkRunnerSourceRetained=false\`. The retired current scanner is not represented as that runner.\n` +
    `- Task total is reconstructed as 168 from one unretained first attempt plus the exact final 84; \`taskTotalExact=false\`.\n` +
    `- This revision was produced by \`${NORMALIZER}\` with zero network operations.\n\n` +
    `## Semantic correction\n\n- \`sourceRuntimeEquivalence=null\`, \`localExactBuildEquivalence=null\`, \`localBuildAttempted=false\`, status \`UNPROVEN_NO_STANDARD_JSON\`.\n` +
    `- Closure requires equivalence exactly true.\n- Self-renounce is only \`success/expected-benign-self-renounce/source-semantics-unproven\`.\n` +
    `- \`updateHourlyLimit(1)\` remains untested/WATCH.\n\n` +
    `## Fixed evidence\n\n- Pin: \`${raw.pin.blockNumberDecimal}\` / \`${raw.pin.blockHash}\`; terminal recheck passed.\n` +
    `- Actual implementation: \`${raw.implementation.address}\`, disproving the recorded hypothesis.\n` +
    `- No executed outsider call returned control acquisition or direct value release. Exact calldata/reverts and balances remain in \`${RAW}\`.\n\n` +
    `## Integrity\n\nManifest aggregate: \`${aggregate}\`. Pre/post-correction raw hashes are recorded in the detached manifest.\n\n` +
    `## Exact remaining network action\n\n${raw.nextAction}\n`;
}

function apply() {
  const preRawData = fs.readFileSync(abs(RAW));
  const raw = JSON.parse(preRawData.toString("utf8"));
  const priorManifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
  const firstCorrection = raw.revision !== REVISION;
  const preCorrectionRaw = firstCorrection
    ? { bytes: preRawData.length, sha256: sha256(preRawData) }
    : raw.offlineCorrection.preCorrectionRaw;
  const supersededManifestAggregateSha256 = firstCorrection
    ? priorManifest.aggregateSha256
    : raw.offlineCorrection.supersededManifestAggregateSha256;

  raw.revision = REVISION;
  raw.correctionType = "offline-evidence-correction/same-run-id";
  raw.artifactProducer = NORMALIZER;
  raw.legacyScannerPath = RETIRED_SCANNER;
  raw.sourceRuntimeEquivalence = null;
  raw.localExactBuildEquivalence = null;
  raw.localBuildAttempted = false;
  raw.sourceRuntime.status = "UNPROVEN_NO_STANDARD_JSON";
  raw.sourceRuntime.sourceRuntimeEquivalence = null;
  raw.sourceRuntime.localExactBuildEquivalence = null;
  raw.sourceRuntime.localBuildAttempted = false;
  raw.closeSubbranch = false;
  raw.closureRule = {
    equivalenceMustEqualExactlyTrue: true,
    sourceRuntimeEquivalenceObserved: null,
    eligible: false,
    reason: "UNPROVEN_NO_STANDARD_JSON",
  };

  const finalTranscriptSha256 = transcriptHash(raw.rpcTranscript);
  raw.networkRunProvenance = {
    networkRunnerSourceRetained: false,
    networkRunnerSourceSha256: null,
    networkRunnerSourceBytes: null,
    exactRunnerReconstructableFromRetainedFiles: false,
    currentPostCorrectionScannerWasExactNetworkRunner: false,
    currentPostCorrectionScannerRole: "retired-mutable-post-correction-tool/network-disabled",
    finalTranscriptRetained: true,
    finalTranscriptReadCountExact: raw.rpcTranscript.length,
    finalTranscriptSha256,
    finalTranscriptHashEncoding: "sha256(JSON.stringify(transcript),utf8)",
    firstAttemptTranscriptRetained: false,
  };

  delete raw.requestBudget.rpcReadsTaskTotal;
  delete raw.requestBudget.rpcCompliant;
  raw.requestBudget.finalTranscriptReadCountExact = 84;
  raw.requestBudget.finalTranscriptExact = true;
  raw.requestBudget.firstAttemptTranscriptRetained = false;
  raw.requestBudget.taskTotalReconstructed = 168;
  raw.requestBudget.taskTotalExact = false;
  raw.requestBudget.taskTotalWithinCap = null;
  raw.requestBudget.reconstructedTaskTotalExceedsCap = true;
  raw.requestBudget.budgetStatus = "WATCH/RECONSTRUCTED_OVER_CAP/FIRST_TRANSCRIPT_NOT_RETAINED";

  const update = raw.callMatrix.find((x) => x.selector === UPDATE_SELECTOR);
  if (!update) throw new Error("updateHourlyLimit row missing");
  update.minimalCalldataStatus = "untested/offline-correction-no-network";
  update.calldata = null;
  update.result = {
    outcome: "untested",
    classification: "WATCH/separate-minimal-new-pin-run-required",
    exactData: null,
    errorCode: null,
    sanitizedMessage: null,
    decodedError: null,
  };
  const renounce = raw.callMatrix.find((x) => x.selector === RENOUNCE_SELECTOR);
  if (!renounce || renounce.result.outcome !== "success") throw new Error("renounceRole success evidence missing");
  renounce.result.classification = "expected-benign-self-renounce/source-semantics-unproven";

  raw.signal = "🟠 WATCH";
  raw.classification = "INCOMPLETE/WATCH/UNPROVEN_NO_STANDARD_JSON/UPDATE-HOURLY-LIMIT-UNTESTED/BUDGET-TOTAL-RECONSTRUCTED";
  raw.escalationTriggered = false;
  raw.futureNetworkRunRequirements = {
    fullScannerRerunAllowed: false,
    separateMinimalNewPinRunRequired: true,
    immutableRunnerPreHashRequired: true,
    newRunIdRequired: true,
    requiredCalls: [
      "select one finalized pin",
      "bind proxy implementation/admin/beacon slots and actual implementation runtime",
      "prove derived caller has no code",
      "eth_call updateHourlyLimit(1) exactly once",
      "terminal same-number hash recheck",
    ],
  };
  raw.nextAction = "Run no network action in this revision. The only remaining network action is a separately authorized minimal new-pin run with a new run ID and immutable pre-run runner hash: bind the proxy/implementation and no-code caller, call updateHourlyLimit(1) exactly once, and terminally recheck the pin. Do not rerun the full scanner. Source/runtime closure separately requires recovered standard-json input and equivalence exactly true.";
  raw.offlineCorrection = {
    revision: REVISION,
    zeroNetwork: true,
    normalizerPath: NORMALIZER,
    preCorrectionRaw,
    postCorrectionRawHashLocation: `${MANIFEST} correction.postCorrectionRaw`,
    supersededManifestAggregateSha256,
    sameRunIdEvidenceCorrection: true,
  };

  const stateFailures = validateCorrectedState(raw);
  if (stateFailures.length) throw new Error(`refusing malformed corrected state: ${stateFailures.join("; ")}`);
  write(RAW, `${JSON.stringify(raw, null, 2)}\n`);
  write(REPORT, renderReport(raw));

  const records = [
    fileRecord(NORMALIZER, "offline-normalizer"),
    fileRecord(RETIRED_SCANNER, "retired-post-correction-tool-not-network-runner"),
    fileRecord(RAW, "post-correction-raw"),
    fileRecord(REPORT, "post-correction-report"),
  ];
  const aggregateSha256 = sha256(Buffer.from(records.map((x) => `${x.role}\0${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"), "utf8"));
  const rawRecord = records.find((x) => x.path === RAW);
  const manifest = {
    generatedAt: raw.generatedAt,
    runId: raw.runId,
    revision: REVISION,
    correctionType: "offline-evidence-correction/same-run-id",
    manifestVersion: 2,
    hashAlgorithm: "sha256",
    aggregateEncoding: "role\\0path\\0bytes\\0sha256 joined by newline",
    records,
    aggregateSha256,
    correction: {
      preCorrectionRaw,
      postCorrectionRaw: { bytes: rawRecord.bytes, sha256: rawRecord.sha256 },
      supersededManifestAggregateSha256,
      zeroNetwork: true,
    },
    provenance: {
      networkRunnerSourceRetained: false,
      networkRunnerSourceSha256: null,
      currentScannerIsExactNetworkRunner: false,
      finalTranscriptReadCountExact: 84,
      finalTranscriptSha256,
      firstAttemptTranscriptRetained: false,
      taskTotalReconstructed: 168,
      taskTotalExact: false,
    },
    semantics: {
      sourceRuntimeEquivalence: null,
      localExactBuildEquivalence: null,
      localBuildAttempted: false,
      status: "UNPROVEN_NO_STANDARD_JSON",
      closureRequiresEquivalenceExactlyTrue: true,
    },
    updateHourlyLimit: "UNTESTED/WATCH/SEPARATE_MINIMAL_NEW_PIN_RUN",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
  };
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  write(INBOX, renderInbox(raw, aggregateSha256));
  write(HANDOFF, renderHandoff(raw, aggregateSha256));
  console.log(`offline correction PASS revision=${REVISION} runId=${RUN_ID} aggregate=${aggregateSha256}`);
}

function selfTest() {
  const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
  if (raw.revision === REVISION) {
    const current = validateCorrectedState(raw);
    if (current.length) throw new Error(`current-state validation failed: ${current.join(";")}`);
  }
  const fixture = {
    runId: RUN_ID, revision: REVISION, sourceRuntimeEquivalence: null, localExactBuildEquivalence: null, localBuildAttempted: false,
    sourceRuntime: { sourceRuntimeEquivalence: null, localExactBuildEquivalence: null, localBuildAttempted: false, status: "UNPROVEN_NO_STANDARD_JSON" },
    closeSubbranch: false, closureRule: { equivalenceMustEqualExactlyTrue: true, eligible: false },
    networkRunProvenance: { networkRunnerSourceRetained: false, networkRunnerSourceSha256: null, currentPostCorrectionScannerWasExactNetworkRunner: false, finalTranscriptRetained: true, finalTranscriptReadCountExact: 84 },
    rpcTranscript: Array.from({ length: 84 }, (_, i) => ({ readNumber: i + 1 })),
    requestBudget: { taskTotalReconstructed: 168, taskTotalExact: false, firstAttemptTranscriptRetained: false },
    callMatrix: [
      { selector: UPDATE_SELECTOR, result: { outcome: "untested", classification: "WATCH/separate-minimal-new-pin-run-required" } },
      { selector: RENOUNCE_SELECTOR, result: { outcome: "success", classification: "expected-benign-self-renounce/source-semantics-unproven" } },
    ],
    futureNetworkRunRequirements: { fullScannerRerunAllowed: false, immutableRunnerPreHashRequired: true, newRunIdRequired: true },
    offlineCorrection: { zeroNetwork: true },
  };
  if (validateCorrectedState(fixture).length) throw new Error("valid fixture rejected");
  const malformedCases = [
    (x) => { x.sourceRuntimeEquivalence = false; },
    (x) => { x.networkRunProvenance.networkRunnerSourceRetained = true; },
    (x) => { x.requestBudget.taskTotalExact = true; },
    (x) => { x.callMatrix[0].result.outcome = "skipped"; },
    (x) => { x.callMatrix[1].result.classification = "benign"; },
    (x) => { x.futureNetworkRunRequirements.newRunIdRequired = false; },
  ];
  for (const mutate of malformedCases) {
    const candidate = JSON.parse(JSON.stringify(fixture));
    mutate(candidate);
    if (!validateCorrectedState(candidate).length) throw new Error("malformed state accepted");
  }
  const source = fs.readFileSync(__filename, "utf8");
  const forbidden = [["fe", "tch("].join(""), ["node", ":http"].join(""), ["node", ":net"].join(""), ["node", ":dns"].join("")];
  if (forbidden.some((token) => source.includes(token))) throw new Error("offline normalizer contains a network primitive");
  console.log(`self-test PASS revision=${REVISION}: null semantics, provenance, malformed-state rejection, and zero-network source`);
}

function verify() {
  const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  const semanticFailures = validateCorrectedState(raw);
  check("null-semantics-provenance", semanticFailures.length === 0, semanticFailures.join(";") || "valid");
  let recordsPass = true;
  for (const record of manifest.records) {
    const actual = fileRecord(record.path, record.role);
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) recordsPass = false;
  }
  check("manifest-records", recordsPass, `${manifest.records.length} records`);
  const aggregate = sha256(Buffer.from(manifest.records.map((x) => `${x.role}\0${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"), "utf8"));
  check("manifest-aggregate", aggregate === manifest.aggregateSha256, manifest.aggregateSha256);
  const rawRecord = manifest.records.find((x) => x.path === RAW);
  check("pre-post-raw-hashes", Boolean(manifest.correction.preCorrectionRaw.sha256) && manifest.correction.postCorrectionRaw.sha256 === rawRecord.sha256, `${manifest.correction.preCorrectionRaw.sha256}->${rawRecord.sha256}`);
  check("final-transcript", raw.rpcTranscript.length === 84 && transcriptHash(raw.rpcTranscript) === raw.networkRunProvenance.finalTranscriptSha256, raw.networkRunProvenance.finalTranscriptSha256);
  check("budget-label", raw.requestBudget.taskTotalReconstructed === 168 && raw.requestBudget.taskTotalExact === false && raw.requestBudget.taskTotalWithinCap === null, "168 reconstructed / exact=false");
  check("update-watch", raw.callMatrix.find((x) => x.selector === UPDATE_SELECTOR)?.result?.outcome === "untested", UPDATE_SELECTOR);
  const source = fs.readFileSync(abs(NORMALIZER), "utf8");
  const forbidden = [["fe", "tch("].join(""), ["node", ":http"].join(""), ["node", ":net"].join(""), ["node", ":dns"].join("")];
  check("zero-network-normalizer", !forbidden.some((token) => source.includes(token)), NORMALIZER);
  const packageText = [RAW, REPORT, MANIFEST, INBOX, HANDOFF].map((x) => fs.readFileSync(abs(x), "utf8")).join("\n");
  check("leak-scan", !/https?:\/\//i.test(packageText) && !/(?:api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,}]+/i.test(packageText), "no URL/credential material");
  check("signal", fs.readFileSync(abs(REPORT), "utf8").includes(`Signal: ${raw.signal}`), raw.signal);
  check("global-gates", raw.routePositive === 0 && raw.executableNow === 0 && raw.signedActionJustified === false, `${raw.routePositive}/${raw.executableNow}/${raw.signedActionJustified}`);
  for (const row of checks) console.log(`${row.pass ? "PASS" : "FAIL"} ${row.name}: ${row.detail}`);
  const failures = checks.filter((x) => !x.pass);
  if (failures.length) throw new Error(`verification failures: ${failures.map((x) => x.name).join(",")}`);
  console.log(`verify PASS revision=${REVISION} aggregate=${manifest.aggregateSha256}`);
}

const mode = process.argv[2] || "--apply";
if (mode === "--apply") apply();
else if (mode === "--self-test") selfTest();
else if (mode === "--verify") verify();
else throw new Error(`unknown offline mode: ${mode}`);
