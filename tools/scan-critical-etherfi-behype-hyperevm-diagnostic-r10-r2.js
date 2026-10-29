#!/usr/bin/env node
"use strict";

// Offline-only audit-reviewer wording correction over immutable R10 evidence.
// This tool does not read endpoint inventories and performs no network calls.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-hyperevm-diagnostic-r10-r2";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R10_RAW = "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10.json";
const R10_MANIFEST = "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10-manifest.json";
const REVISION = "etherfi-behype-hyperevm-diagnostic-r10-r2-audit-reviewer-wording-correction";
const AGENT = "critical-etherfi-behype-r10-wording-20260722";
const CLASSIFICATION = "WATCH/COVERAGE_OPEN/HYPEREVM-SOLE-FAMILY-FULL-BEHAVIORAL-OBSERVATION/PROVISIONAL-FINALITY/NO-BACKEND-INDEPENDENCE-CLAIM";
const SUMMARY = "One declared/observed provider-family group completed the selected-library behavioral tuple at a sole-family provisional reported-finalized pin; this is not cross-family finality/hash consensus and does not establish backend/operator independence.";

const abs = (rel) => path.join(ROOT, rel);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const readJson = (rel) => JSON.parse(fs.readFileSync(abs(rel), "utf8"));

function writeOwned(rel, body) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error("write-refused");
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8");
}

function assertNoLeak(text) {
  if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("scheme-leak");
  if (/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(text)) throw new Error("host-leak");
  if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(text)) throw new Error("credential-leak");
  if (/"(?:url|domain|providerName|rawLine|headers?|address)"\s*:/i.test(text)) throw new Error("identifier-field-leak");
}

function routePresentation(route) {
  const successfulEvidence = route.substageOrder.filter((substage) => route.checks[substage].status === "success");
  const directionNotApplicable = route.substageOrder.filter((substage) => route.checks[substage].status === "not-applicable");
  return { routeLabel: route.routeLabel, successfulEvidence, directionNotApplicable, routeComplete: route.routeComplete };
}

function report(raw) {
  const rows = raw.reportPresentation.map((route) => `| ${route.routeLabel} | ${route.successfulEvidence.join(", ") || "none"} | ${route.directionNotApplicable.join(", ") || "none"} | ${route.routeComplete} |`).join("\n");
  return `# 🟠 WATCH — EtherFi BeHYPE HyperEVM diagnostic R10-r2\n\n**Run:** \`${raw.runId}\`  \n**Revision:** \`${raw.revision}\`  \n**Classification:** \`${raw.classification}\`  \n**Gates:** \`0/0/false\`; \`fork=false\`\n\n${SUMMARY}\n\nThe retained pin is ${raw.pin.blockNumber} / \`${raw.pin.blockHash}\`, qualified only as \`${raw.pin.qualification}\`.\n\n| Route label | Successful evidence | Direction-not-applicable | Route complete |\n|---|---|---|---|\n${rows}\n\nFor the beHYPE send route, \`receive-type1-negative\` is excluded from successful evidence and shown separately as direction-not-applicable. The raw route check remains \`status=not-applicable\` with category \`direction-not-applicable\`; no evidence value or route status changed.\n\nR10-r2 is an offline wording/presentation correction bound to immutable R10 raw and manifest artifacts. It made no network or endpoint-inventory read. R10 evidence, gates, leak protections, and next action are preserved. No economics, stake, send, message, protocol retry, sweep, signing, fork, transaction, or mutation occurred.\n\n**nextReadOnlyStep:** ${raw.nextReadOnlyStep}\n`;
}

function main() {
  const predecessor = readJson(R10_RAW); const predecessorManifest = readJson(R10_MANIFEST);
  const immutablePredecessorR10 = { status: "IMMUTABLE-PREDECESSOR/HYPEREVM-R10", runId: predecessor.runId, raw: hashFile(R10_RAW), manifest: hashFile(R10_MANIFEST), manifestAggregateSha256: predecessorManifest.aggregateSha256 };
  const generatedAt = new Date().toISOString();
  const raw = canonical({ ...predecessor, schemaVersion: 1, revision: REVISION, generatedAt, evidenceCaptureGeneratedAt: predecessor.generatedAt, scanner: SCANNER, agentId: AGENT, classification: CLASSIFICATION, summary: SUMMARY, immutablePredecessorR10, reportPresentation: predecessor.providers.flatMap((provider) => provider.routes.map(routePresentation)), offlineCorrectionR2: { networkCalls: false, endpointInventoryReads: false, evidenceValuesChanged: false, gatesChanged: false, routeCheckStatusesChanged: false, nextActionChanged: false, classificationWordingChanged: true, reportPresentationChanged: true } });
  delete raw.runId; raw.runId = `etherfi-behype-hyperevm-diagnostic-r10-r2-${digest(raw).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  writeOwned(RAW, JSON.stringify(raw, null, 2) + "\n"); writeOwned(REPORT, report(raw));
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId: raw.runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, classification: CLASSIFICATION, summary: SUMMARY, providerFamilyQualification: raw.providerFamilyQualification, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, routePresentation: raw.reportPresentation, immutablePredecessorR10, offlineCorrectionR2: raw.offlineCorrectionR2, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R10_RAW, R10_MANIFEST], nextAction: raw.nextReadOnlyStep });
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# EtherFi BeHYPE HyperEVM diagnostic R10-r2 handoff\n\n- Run \`${raw.runId}\`; classification \`${CLASSIFICATION}\`; gates \`0/0/false\`, fork=false.\n- ${SUMMARY}\n- Both routes remain complete. For beHYPE send, \`receive-type1-negative\` is report-presented only as direction-not-applicable; its raw \`not-applicable\` status is unchanged.\n- Immutable R10 predecessor run \`${predecessor.runId}\` is bound by raw and manifest hashes plus its manifest aggregate.\n- Offline correction only: no network/inventory read, evidence/gate/status/next-action change, endpoint identifiers, raw responses, secrets, economics, or mutation.\n- Next: ${raw.nextReadOnlyStep}\n`);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R10_RAW, R10_MANIFEST].map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: REVISION, runId: raw.runId, generatedAt, classification: CLASSIFICATION, summary: SUMMARY, algorithm: "sha256", providerFamilyQualification: raw.providerFamilyQualification, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, reportPresentation: raw.reportPresentation, immutablePredecessorR10, offlineCorrectionR2: raw.offlineCorrectionR2, gates: raw.gates, safety: raw.safety, records, aggregateSha256 });
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assertNoLeak(fs.readFileSync(abs(rel), "utf8"));
  process.stdout.write(JSON.stringify({ runId: raw.runId, revision: REVISION, classification: CLASSIFICATION, summary: SUMMARY, pin: raw.pin, routePresentation: raw.reportPresentation, predecessorRunId: predecessor.runId, manifestAggregateSha256: aggregateSha256, checks: { networkCalls: false, endpointInventoryReads: false, evidenceValuesChanged: false, gatesChanged: false, routeCheckStatusesChanged: false, nextActionChanged: false }, gates: raw.gates, nextReadOnlyStep: raw.nextReadOnlyStep }) + "\n");
}

main();
