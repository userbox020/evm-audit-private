#!/usr/bin/env node
"use strict";

// Offline-only reviewer wording correction. Reads the current sanitized R8
// package before overwrite; never reads endpoint inventories or the network.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-receive-type1-negative-check";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R7_RAW = "reports/raw/fast/critical-etherfi-behype-selected-library-binding.json";
const R7_MANIFEST = "reports/raw/fast/critical-etherfi-behype-selected-library-binding-manifest.json";
const LZ_SOURCES = [
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/MessageLibManager.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/EndpointV2.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/interfaces/IMessageLibManager.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/interfaces/IMessageLib.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/uln302/SendUln302.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/uln302/ReceiveUln302.sol",
];
const PREDECESSOR_REVISION = "etherfi-behype-receive-type1-negative-check-r8-fixed-pin-sanitized";
const PREDECESSOR_RUN = "etherfi-behype-receive-type1-r8-65ac73490281d37b3391-501f02f309bb";
const PREDECESSOR_AGGREGATE = "89666a8dd584c3108231ad4066bd824273802ee6f6ffbf9286a6e4f55575173a";
const REVISION = "etherfi-behype-receive-type1-negative-check-r8-r2-reviewer-wording-offline";
const AGENT = "critical-etherfi-behype-r8-wording-20260722";
const CLASSIFICATION = "WATCH/COVERAGE_OPEN/OPTIMISM-RECEIVE-TYPE1-NEGATIVE-SEMANTICS-BOUND/HYPEREVM-UNOBSERVED/NO-BACKEND-INDEPENDENCE-CLAIM";
const QUALIFICATION = "The two agreeing groups are observed hostname-derived provider-family groups; backend/operator independence is not established.";
const NEXT_ACTION = "Provision at least two distinct declared/observed HyperEVM provider-family groups and perform the same fresh finalized selected-library plus receive-type1 behavioral binding; economics remains blocked until two-chain coverage is complete.";

const abs = (rel) => path.join(ROOT, rel);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };

function writeOwned(rel, body) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error("write-refused");
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8");
}

function assertNoLeak(text) {
  if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("scheme-leak");
  if (/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(text)) throw new Error("host-leak");
  if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(text)) throw new Error("credential-leak");
  if (/"(?:url|domain|providerName|rawLine|headers?)"\s*:/i.test(text)) throw new Error("endpoint-field-leak");
}

function report(raw) {
  const negative = raw.exemplar.routes.find((route) => route.binding.direction === "receive").receiveType1NegativeCheck;
  return `# 🟠 WATCH — EtherFi BeHYPE receive config type-1 negative semantic check r8-r2\n\n**Run:** \`${raw.runId}\`  \n**Revision:** \`${raw.revision}\`  \n**Classification:** \`${raw.classification}\`  \n**Gates:** \`0/0/false\`; \`fork=false\`\n\n## Reviewer wording correction\n\n${QUALIFICATION}\n\nThis package is an offline-only wording correction of R8. It preserves the pin, selected-library observations, config envelopes and decoded digests, custom-error evidence, provider-group equality, gates, and leak controls byte-semantically. No endpoint inventory or network read occurred during this correction.\n\n## Preserved result\n\nAt finalized Optimism pin ${raw.pin.blockNumber} / \`${raw.pin.blockHash}\`, two observed hostname-derived provider-family groups agree on selection, code/version, applicable config, retained state, bounded anchor, and receive-side config type-1 behavior.\n\nThe direct EndpointV2 \`getConfig\` call with config type 1 produced category \`${negative.category}\`, selector \`${negative.selector}\`, decoded argument \`${negative.decodedArgument}\`, strict equality \`${negative.expected === true}\`, and ${negative.revertDataBytes} bytes of revert data represented only by digest \`${negative.revertDataDigest}\`.\n\n| Metric | Groups agreeing |\n|---|---:|\n| Selection + anchor | ${raw.consensus.selection} |\n| Code/version + anchor | ${raw.consensus.codeVersion} |\n| Applicable config + anchor | ${raw.consensus.config} |\n| Retained state + anchor | ${raw.consensus.state} |\n| Receive type-1 error + anchor | ${raw.consensus.negativeType1} |\n| Full behavioral tuple | ${raw.consensus.full} |\n\n- Exact official runtime equivalence remains null; this is behavioral binding only.\n- HyperEVM remains unobserved and coverage-open. No data is invented.\n- No backend/operator independence is claimed.\n- No economics, endpoint query, transaction, stake, message, signing, fork, or mutation occurred in this correction.\n\n**nextReadOnlyStep:** ${raw.nextReadOnlyStep}\n`;
}

function main() {
  const generatedAt = new Date().toISOString();
  const predecessorRawBytes = fs.readFileSync(abs(RAW)); const predecessorManifestBytes = fs.readFileSync(abs(MANIFEST));
  const predecessorRaw = JSON.parse(predecessorRawBytes.toString("utf8")); const predecessorManifest = JSON.parse(predecessorManifestBytes.toString("utf8"));
  if (predecessorRaw.revision !== PREDECESSOR_REVISION || predecessorRaw.runId !== PREDECESSOR_RUN || predecessorManifest.revision !== PREDECESSOR_REVISION || predecessorManifest.runId !== PREDECESSOR_RUN || predecessorManifest.aggregateSha256 !== PREDECESSOR_AGGREGATE) throw new Error("predecessor-identity-mismatch");
  const predecessorRawRecord = predecessorManifest.records.find((row) => row.path === RAW);
  if (!predecessorRawRecord || predecessorRawRecord.bytes !== predecessorRawBytes.length || predecessorRawRecord.sha256 !== sha(predecessorRawBytes)) throw new Error("predecessor-raw-binding-mismatch");
  const predecessorRecord = {
    status: "IMMUTABLE-HASH-BOUND-PREDECESSOR/R8-BEFORE-REVIEWER-WORDING-CORRECTION",
    runId: predecessorRaw.runId,
    revision: predecessorRaw.revision,
    raw: { path: RAW, bytes: predecessorRawBytes.length, sha256: sha(predecessorRawBytes) },
    manifest: { path: MANIFEST, bytes: predecessorManifestBytes.length, sha256: sha(predecessorManifestBytes), aggregateSha256: predecessorManifest.aggregateSha256 },
    predecessorArtifactsAvailableAfterMutableOverwrite: false,
  };
  const raw = canonical({
    ...predecessorRaw,
    schemaVersion: 2,
    revision: REVISION,
    generatedAt,
    scanner: SCANNER,
    agentId: AGENT,
    classification: CLASSIFICATION,
    providerFamilyQualification: QUALIFICATION,
    backendOperatorIndependenceEstablished: false,
    backendOperatorIndependenceClaimed: false,
    reviewerCorrection: { offlineOnly: true, networkCalls: false, endpointInventoryReads: false, evidenceValuesChanged: false, wordingOnly: true },
    immutablePredecessorR8: predecessorRecord,
    predecessorEvidenceCollectionSafety: predecessorRaw.safety,
    safety: { ...predecessorRaw.safety, endpointInventoriesReadThisRun: false, networkCalls: false, offlineCorrection: true, sourceEvidenceCollectedInPriorAuthorizedReadOnlyRun: true },
    nextReadOnlyStep: NEXT_ACTION,
  });
  delete raw.runId;
  const runId = `etherfi-behype-receive-type1-r8-r2-${digest(raw).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`; raw.runId = runId;
  writeOwned(RAW, JSON.stringify(raw, null, 2) + "\n");
  writeOwned(REPORT, report(raw));
  const receiveType1Result = raw.exemplar.routes.find((route) => route.binding.direction === "receive").receiveType1NegativeCheck;
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, classification: CLASSIFICATION, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, consensus: raw.consensus, receiveType1Result, behavioralConsensusReady: raw.behavioralConsensusReady, hyperevm: raw.hyperevm, immutablePredecessorR8: predecessorRecord, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R7_RAW, R7_MANIFEST, ...LZ_SOURCES], nextAction: NEXT_ACTION });
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  const handoff = `# EtherFi BeHYPE receive type-1 check r8-r2 reviewer wording handoff\n\n- Run \`${runId}\`; classification \`${CLASSIFICATION}\`; gates \`0/0/false\`, fork=false.\n- ${QUALIFICATION}\n- Preserved Optimism pin ${raw.pin.blockNumber} / \`${raw.pin.blockHash}\`; exact-pin/complete observed groups ${raw.metrics.exactPinFamilies}/${raw.metrics.completeFamilies}.\n- Preserved selection/code/config/state/negative/full agreement ${raw.consensus.selection}/${raw.consensus.codeVersion}/${raw.consensus.config}/${raw.consensus.state}/${raw.consensus.negativeType1}/${raw.consensus.full}.\n- Receive type-1 expected custom error remains selector=${receiveType1Result.selector}, argument=${receiveType1Result.decodedArgument}, strict=${receiveType1Result.strictCustomErrorEncoding}.\n- Backend/operator independence is not established or claimed. Exact official runtime equivalence remains null.\n- Offline correction only: no network/inventory/economics/transaction/stake/message/signing/fork/mutation.\n- Next: ${NEXT_ACTION}\n`;
  writeOwned(HANDOFF, handoff);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R7_RAW, R7_MANIFEST, ...LZ_SOURCES].map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 2, revision: REVISION, runId, generatedAt, classification: CLASSIFICATION, algorithm: "sha256", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, consensus: raw.consensus, expectedReceiveType1Semantics: raw.expectedReceiveType1Semantics, receiveType1Result, behavioralConsensusReady: raw.behavioralConsensusReady, hyperevm: raw.hyperevm, immutablePredecessorR8: predecessorRecord, immutablePredecessorR7: raw.immutablePredecessorR7, officialLayerZero: raw.officialLayerZero, gates: raw.gates, safety: raw.safety, reviewerCorrection: raw.reviewerCorrection, records, aggregateSha256 });
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assertNoLeak(fs.readFileSync(abs(rel), "utf8"));
  process.stdout.write(JSON.stringify({ runId, revision: REVISION, classification: CLASSIFICATION, providerFamilyQualification: QUALIFICATION, predecessorRunId: predecessorRecord.runId, pin: raw.pin, consensus: raw.consensus, manifestAggregateSha256: aggregateSha256, gates: raw.gates, currentRunNetworkCalls: false, currentRunEndpointInventoryReads: false, nextReadOnlyStep: NEXT_ACTION }) + "\n");
}

try { main(); } catch { process.stderr.write("offline r8 reviewer correction failed: sanitized internal error\n"); process.exitCode = 1; }
