#!/usr/bin/env node
"use strict";
const crypto = require("crypto"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, ".."), NAME = "critical-across-hyperevm-cctp-build-recovery-step4";
const RAW = `reports/raw/fast/${NAME}.json`, SEARCH = `reports/raw/fast/${NAME}-search-ledger.json`, TESTS = `reports/raw/fast/${NAME}-tests.json`, LEAK = `reports/raw/fast/${NAME}-leak-scan.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`, INBOX = `coordination/inbox/review-${NAME}-2026-07-25.json`, HANDOFF = `coordination/handoffs/2026-07-25-${NAME}-handoff.md`, SCANNER = `tools/scan-${NAME}.js`, VALIDATOR = `tools/test-${NAME}.js`;
const abs = (rel) => path.join(ROOT, rel), read = (rel) => fs.readFileSync(abs(rel)), json = (rel) => JSON.parse(read(rel).toString("utf8")), sha = (v) => crypto.createHash("sha256").update(v).digest("hex"), hashFile = (rel) => { const b = read(rel); return { path: rel, bytes: b.length, sha256: sha(b) }; };
function assert(ok, label, checks) { checks.push({ label, passed: !!ok }); if (!ok) throw new Error(label); }
function main() {
  for (const rel of [RAW, SEARCH, TESTS, LEAK, MANIFEST, REPORT, INBOX, HANDOFF, SCANNER, VALIDATOR]) if (!fs.existsSync(abs(rel))) throw new Error(`missing:${rel}`);
  const raw = json(RAW), search = json(SEARCH), tests = json(TESTS), leak = json(LEAK), manifest = json(MANIFEST), inbox = json(INBOX), checks = [];
  assert(raw.classification === "WATCH/COVERAGE-BLOCKED/CONTENT-ADDRESSED-LOCAL-SEARCH-NEGATIVE/ACTIVE-CID-PAYLOAD-ABSENT-IN-DECLARED-SCOPE/STEP4" && raw.activePayloadCount === 0, "classification", checks);
  assert(search.activeCid.algorithm === "sha2-256" && search.activeCid.digestLength === 32 && search.activeCid.digestHex === "45a326ca9b7fc09c89563df92941dc2675e9d98f23484d0043b02d17cc551343", "cidv0-decode", checks);
  assert(search.activeCid.multihashHex === "122045a326ca9b7fc09c89563df92941dc2675e9d98f23484d0043b02d17cc551343", "multihash", checks);
  assert(search.verification.rule.includes("SHA-256") && search.verification.activePayloadCount === 0 && search.verification.failClosed, "verification-rule", checks);
  assert(search.fileSearch.filenameIndependentContentHashing && search.fileSearch.filesHashed > 0 && search.fileSearch.bytesHashed > 0, "filename-independent-files", checks);
  assert(search.fileSearch.rootRows.find((x) => x.id === "package-cache").filesHashed > 0 && search.fileSearch.rootRows.find((x) => x.id === "compiler-cache").filesHashed > 0, "package-compiler-content", checks);
  assert(search.gitObjectSearch.blobsHashed > 0 && search.gitObjectSearch.bytesHashed > 0, "git-blobs", checks);
  assert(search.fileSearch.activePayloadMatches.length === 0 && search.gitObjectSearch.activePayloadMatches.length === 0, "active-absent", checks);
  assert(search.fileSearch.embeddedMultihashReferences >= search.fileSearch.cborMultihashReferences && search.fileSearch.embeddedMultihashReferences > 0, "reference-distinction", checks);
  assert(search.fileSearch.absenceScope.includes("not global") || search.fileSearch.absenceScope.includes("outside"), "absence-scope", checks);
  for (const category of ["secret", "size", "unreadable", "contentDisabled", "unsupported"]) assert(search.fileSearch.skipped[category].count >= 0 && /^[0-9a-f]{64}$/.test(search.fileSearch.skipped[category].aggregateSha256), `skip:${category}`, checks);
  assert(search.fileSearch.skipped.secret.count > 0 && search.fileSearch.skipped.size.count > 0 && search.fileSearch.skipped.contentDisabled.count > 0, "material-skips", checks);
  assert(search.fixtures.fixtureCount === 4 && search.fixtures.passed === 4, "fixtures-count", checks);
  assert(search.fixtures.positiveRenamedPayload.matches && !search.fixtures.positiveRenamedPayload.containsOwnCidText, "renamed-positive", checks);
  assert(!search.fixtures.negativeTextualCid.matches && search.fixtures.negativeTextualCid.containsCidText, "text-negative", checks);
  assert(!search.fixtures.cborExtractedMultihash.contentAddressMatch && search.fixtures.cborExtractedMultihash.distinction.includes("not equality"), "cbor-distinction", checks);
  assert(search.preservedStep3.candidateCount === 32 && search.preservedStep3.nearestCommit === "03b868a12df59c2ec2639e3a8d97597dab6cb8f2", "candidate-preserved", checks);
  assert(search.preservedStep3.immutableReferenceCount === 15 && search.preservedStep3.linkReferenceCount === 0 && search.preservedStep3.deployments.length === 2, "runtime-preserved", checks);
  assert(search.preservedStep3.deployedReceiveTransportBeforeNonce === null && search.preservedStep3.deployedSharedGuardCoverage === null, "semantics-null", checks);
  assert(search.publicRetrievalGate.status.includes("NOT-EXECUTED") && search.publicRetrievalGate.requiredVerification.includes("45a326"), "public-gate", checks);
  assert(tests.passed && tests.fixtures.passed === 4 && tests.scannerChecksPassed === tests.scannerChecksTotal, "tests", checks);
  assert(leak.passed && leak.findingCount === 0 && !leak.endpointInventoryCompared, "leak", checks);
  assert(raw.activityScope.endpointInventoryReads === 0 && raw.activityScope.rpcCalls === 0 && raw.activityScope.httpRequests === 0 && raw.activityScope.webRequests === 0 && !raw.activityScope.forkCreated && raw.activityScope.liveCalls === 0 && raw.activityScope.secretFileReads === 0 && !raw.activityScope.publicRetrievalExecuted, "offline", checks);
  assert(inbox.runId === raw.runId && inbox.activePayloadCount === 0 && inbox.routePositive === 0, "inbox", checks);
  const records = manifest.records.map((r) => { const a = hashFile(r.path); assert(a.bytes === r.bytes && a.sha256 === r.sha256, `record:${r.path}`, checks); return a; }), aggregate = sha(Buffer.from(records.map((r) => `${r.path}\0${r.bytes}\0${r.sha256}`).join("\n")));
  assert(aggregate === manifest.aggregateSha256, "aggregate", checks);
  for (const r of manifest.recursivePredecessor.files) { const a = hashFile(r.path); assert(a.bytes === r.bytes && a.sha256 === r.sha256, `predecessor:${r.path}`, checks); }
  const predecessorAggregate = sha(Buffer.from(manifest.recursivePredecessor.files.map((r) => `${r.path}\0${r.bytes}\0${r.sha256}`).join("\n")));
  assert(predecessorAggregate === manifest.recursivePredecessor.aggregateSha256, "predecessor-aggregate", checks);
  process.stdout.write(JSON.stringify({ ok: true, checksPassed: checks.filter((x) => x.passed).length, checksTotal: checks.length, runId: raw.runId, classification: raw.classification, candidateFilesHashed: raw.search.candidateFilesHashed, candidateBytesHashed: raw.search.candidateBytesHashed, gitBlobsHashed: raw.search.gitBlobsHashed, gitBlobBytesHashed: raw.search.gitBlobBytesHashed, skipped: Object.fromEntries(Object.entries(raw.search.skipped).map(([k, v]) => [k, v.count])), fixtures: `${raw.fixtures.passed}/${raw.fixtures.count}`, activePayloadCount: 0, records: manifest.records.length, aggregateSha256: aggregate, pipeline: "1/5", nextGate: raw.nextGate }) + "\n");
}
try { main(); } catch (error) { process.stderr.write(JSON.stringify({ ok: false, category: String(error.message || error) }) + "\n"); process.exit(1); }
