#!/usr/bin/env node
"use strict";

// Deterministic offline coordination wrapper. Reads only immutable R13-r2
// package artifacts; never reads endpoint inventories or source matrices.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-hyperevm-header-consensus-r13-r3";
const REVISION = "etherfi-hyperevm-header-consensus-r13-r3-coordination-complete";
const AGENT = "critical-etherfi-hyper-header-r13r3-20260723";
const GENERATED_AT = "2026-07-23T01:45:00.000Z";
const CLASSIFICATION = "WATCH/PREFLIGHT-PASS/HYPEREVM-BLOCK1-NINE-FAMILY-SELECTED-HEADER-CANONICAL-FINGERPRINT-CONSENSUS/CORRECTED-MATRIX-CANDIDATE-EXPECTATIONS/R14-STATE-QUALIFICATION-REQUIRED/NO-BACKEND-INDEPENDENCE-CLAIM";
const QUALIFICATION = "Nine anonymous hostname-derived groups are header-consensus-qualified only; archive qualification requires R14 state-canary verification, and backend/operator independence is not established.";
const R14_STATUS = "APPROVED_FOR_READ_ONLY_R14_STATE_CANARY_VERIFICATION_ONLY";
const NEXT = "Governance may authorize only read-only R14 state-canary verification using the hash-bound R13-r2 corrected matrix; archive qualification, economics, promotion, signing, transactions, fork creation, and mutation remain unapproved.";

const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const R2_SCANNER = "tools/scan-critical-etherfi-hyperevm-header-consensus-r13-r2.js";
const R2_VALIDATOR = "tools/test-critical-etherfi-hyperevm-header-consensus-r13-r2.js";
const R2_RAW = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-r2.json";
const R2_MANIFEST = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-r2-manifest.json";
const R2_REPORT = "reports/critical-etherfi-hyperevm-header-consensus-r13-r2.md";
const R2_MATRIX = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-r2-corrected-historical-matrix.json";
const OWNED = [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF];
const PREDECESSOR = [R2_SCANNER, R2_VALIDATOR, R2_RAW, R2_MANIFEST, R2_REPORT, R2_MATRIX];
const RECORDS = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R2_MATRIX, R2_SCANNER, R2_VALIDATOR, R2_RAW, R2_MANIFEST, R2_REPORT];

const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };

function writeOwned(rel, text) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error("write-refused"); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8"); }
function leakCheck(text, source = false) { if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("endpoint-scheme-leak"); if (!source) { const candidates = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || []; if (candidates.some((value) => !/\.(?:json|js|md|txt|sol)$/i.test(value))) throw new Error("endpoint-host-leak"); } if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer)\s*[:=]\s*[^\s,}\]]+/i.test(text)) throw new Error("secret-material-leak"); }

function boundaries(r2Raw, r2Matrix) {
  return canonical({
    classification: CLASSIFICATION,
    providerFamilyQualification: QUALIFICATION,
    backendOperatorIndependenceEstablished: false,
    backendOperatorIndependenceClaimed: false,
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, archiveQualificationClosed: true, economicsClosed: true, promotionClosed: true },
    selectedHeaderConsensus: r2Raw.selectedHeaderConsensus,
    candidateOnlyMatrix: { path: R2_MATRIX, sha256: hashFile(R2_MATRIX).sha256, matrixDigest: r2Matrix.matrixDigest, schemaValidated: true, stateExpectationCount: 8, candidateExpectationsOnly: true, stateCanariesVerified: false },
    r14Approval: { status: R14_STATUS, readOnlyStateCanaryTestingApproved: true, archiveQualificationApproved: false, economicsApproved: false, promotionApproved: false },
    leakGate: { scope: "endpoint-and-secret-material-in-r13-r3-package", scopedNotAbsolute: true, absoluteSecrecyClaim: false }
  });
}

function main() {
  for (const rel of [SCANNER, VALIDATOR, ...PREDECESSOR]) if (!fs.existsSync(abs(rel))) throw new Error(`missing-${rel}`);
  const r2Raw = json(R2_RAW); const r2Manifest = json(R2_MANIFEST); const r2Matrix = json(R2_MATRIX);
  if (r2Raw.classification !== CLASSIFICATION || r2Raw.providerFamilyQualification !== QUALIFICATION || r2Raw.r14Approval.status !== R14_STATUS || r2Raw.r14Approval.archiveQualificationApproved !== false || r2Raw.r14Approval.economicsApproved !== false || r2Raw.r14Approval.promotionApproved !== false || r2Raw.correctedMatrix.candidateExpectationsOnly !== true || r2Raw.correctedMatrix.stateCanariesVerified !== false) throw new Error("r13-r2-boundaries-invalid");
  const predecessorBinding = canonical({ status: "IMMUTABLE-PREDECESSOR/R13-R2-TECHNICAL-PACKAGE", runId: r2Raw.runId, manifestAggregateSha256: r2Manifest.aggregateSha256, artifacts: PREDECESSOR.map(hashFile) });
  const bounded = boundaries(r2Raw, r2Matrix);
  const ownership = canonical({ ownedPackagePaths: OWNED, ownedWritableArtifactPaths: [RAW, MANIFEST, REPORT, INBOX, HANDOFF], readOnlyHashBoundPredecessorPaths: PREDECESSOR, manifestRecordPaths: RECORDS, predecessorArtifactsMayBeOverwritten: false });
  const runSeed = canonical({ revision: REVISION, generatedAt: GENERATED_AT, predecessorBinding, bounded, ownership });
  const runId = `etherfi-hyperevm-header-consensus-r13-r3-${digest(runSeed)}-${hashFile(SCANNER).sha256}`;
  const safety = canonical({ offline: true, endpointReads: false, inventoryReads: false, sourceMarkdownReads: false, economics: false, transactions: false, forkCreated: false, signing: false, mutation: false, predecessorArtifactsModified: false, coordinatorCodeOrStateFilesEdited: false, requestedInboxAndHandoffCreated: true });
  const raw = canonical({ schemaVersion: 1, revision: REVISION, generatedAt: GENERATED_AT, runId, scanner: SCANNER, agentId: AGENT, role: "critical-research", coordinationStatus: "COMPLETE", ...bounded, predecessorBinding, scannerOwnership: ownership, safety, r14GovernanceReadiness: { status: "READY_FOR_NARROW_READ_ONLY_R14_AUTHORIZATION", coordinationArtifactsComplete: true, technicalEvidenceRequalified: false, archiveQualificationReady: false, economicsReady: false, promotionReady: false }, nextReadOnlyStep: NEXT });
  writeOwned(RAW, JSON.stringify(raw, null, 2) + "\n");
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, classification: CLASSIFICATION, coordinationStatus: "COMPLETE", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, gates: bounded.gates, selectedHeaderConsensus: bounded.selectedHeaderConsensus, candidateOnlyMatrix: bounded.candidateOnlyMatrix, r14Approval: bounded.r14Approval, r14GovernanceReadiness: raw.r14GovernanceReadiness, predecessorBinding, artifacts: RECORDS, nextAction: NEXT });
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  const handoff = `# EtherFi HyperEVM header consensus R13-r3 handoff\n\n- **Run:** \`${runId}\`\n- **Classification:** \`${CLASSIFICATION}\`\n- **Gates:** \`routePositive=0; executableNow=0; signedActionJustified=false; fork=false; archiveQualificationClosed=true; economicsClosed=true; promotionClosed=true\`\n- **Provider qualification:** ${QUALIFICATION}\n- **Candidate-only matrix:** \`${R2_MATRIX}\`; SHA-256 \`${bounded.candidateOnlyMatrix.sha256}\`; schema validated; eight candidate expectations; state canaries unverified.\n- **R14 approval:** \`${R14_STATUS}\`; read-only state-canary testing only. Archive qualification, economics, promotion, signing, transactions, fork creation, and mutation are not approved.\n- **Predecessor:** immutable R13-r2 run \`${r2Raw.runId}\`; aggregate \`${r2Manifest.aggregateSha256}\`; all six technical artifacts hash-bound.\n- **Coordination:** COMPLETE; governance readiness \`READY_FOR_NARROW_READ_ONLY_R14_AUTHORIZATION\`.\n- **Leak caveat:** endpoint/secret-material scoped only; not an absolute secrecy claim.\n- **Next:** ${NEXT}\n`;
  writeOwned(HANDOFF, handoff);
  const report = `# 🟠 WATCH — EtherFi HyperEVM R13-r3 coordination wrapper\n\n**Run:** \`${runId}\`  \n**Classification:** \`${CLASSIFICATION}\`  \n**Gates:** \`0/0/false\`; \`fork=false\`\n\n${QUALIFICATION}\n\nR13-r3 adds coordination completeness only. It preserves and hash-binds R13-r2 technical evidence without requalification or modification. Nine groups remain header-consensus-qualified, zero are archive-qualified, and the selected-header canonical fingerprint caveats remain unchanged. The corrected matrix contains candidate expectations only and must be verified in R14.\n\n**R14 governance readiness:** \`READY_FOR_NARROW_READ_ONLY_R14_AUTHORIZATION\` under \`${R14_STATUS}\`. No archive qualification, economics, promotion, signing, transaction, fork, or mutation approval.\n\nLeak checking is endpoint/secret-material scoped and is not an absolute secrecy claim. No endpoint, inventory, or source-matrix reads occurred.\n\n**nextReadOnlyStep:** ${NEXT}\n`;
  writeOwned(REPORT, report);
  const records = RECORDS.map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: REVISION, generatedAt: GENERATED_AT, runId, classification: CLASSIFICATION, algorithm: "sha256", coordinationStatus: "COMPLETE", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, gates: bounded.gates, candidateOnlyMatrix: bounded.candidateOnlyMatrix, r14Approval: bounded.r14Approval, r14GovernanceReadiness: raw.r14GovernanceReadiness, predecessorBinding, scannerOwnership: ownership, leakGate: bounded.leakGate, safety, records, aggregateSha256 });
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) leakCheck(read(rel), rel === SCANNER || rel === VALIDATOR);
  process.stdout.write(JSON.stringify({ runId, classification: CLASSIFICATION, coordinationStatus: "COMPLETE", manifestAggregateSha256: aggregateSha256, artifacts: { raw: RAW, manifest: MANIFEST, report: REPORT, inbox: INBOX, handoff: HANDOFF, correctedMatrix: bounded.candidateOnlyMatrix }, predecessorAggregateSha256: r2Manifest.aggregateSha256, r14GovernanceReadiness: raw.r14GovernanceReadiness, r14Approval: bounded.r14Approval, checks: safety }) + "\n");
}

main();
