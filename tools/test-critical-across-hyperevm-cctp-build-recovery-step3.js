#!/usr/bin/env node
"use strict";
const crypto = require("crypto"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, ".."), NAME = "critical-across-hyperevm-cctp-build-recovery-step3";
const RAW = `reports/raw/fast/${NAME}.json`, SEARCH = `reports/raw/fast/${NAME}-search-ledger.json`, BUILD = `reports/raw/fast/${NAME}-build-bundle.json`, TESTS = `reports/raw/fast/${NAME}-tests.json`, LEAK = `reports/raw/fast/${NAME}-leak-scan.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`, INBOX = `coordination/inbox/review-${NAME}-2026-07-24.json`, HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`, SCANNER = `tools/scan-${NAME}.js`, VALIDATOR = `tools/test-${NAME}.js`;
const abs = (rel) => path.join(ROOT, rel), read = (rel) => fs.readFileSync(abs(rel)), json = (rel) => JSON.parse(read(rel).toString("utf8")), sha = (v) => crypto.createHash("sha256").update(v).digest("hex"), digest = (v) => sha(Buffer.from(JSON.stringify(v))), hashFile = (rel) => { const b = read(rel); return { path: rel, bytes: b.length, sha256: sha(b) }; };
function assert(ok, label, checks) { checks.push({ label, passed: !!ok }); if (!ok) throw new Error(label); }
function main() {
  for (const rel of [RAW, SEARCH, BUILD, TESTS, LEAK, MANIFEST, REPORT, INBOX, HANDOFF, SCANNER, VALIDATOR]) if (!fs.existsSync(abs(rel))) throw new Error(`missing:${rel}`);
  const raw = json(RAW), search = json(SEARCH), build = json(BUILD), tests = json(TESTS), leak = json(LEAK), manifest = json(MANIFEST), inbox = json(INBOX), checks = [];
  assert(raw.classification === "WATCH/COVERAGE-BLOCKED/DETERMINISTIC-LOCAL-SEARCH-NEGATIVE/EXACT-CCTP-METADATA-CLOSURE-ABSENT/STEP3" && !raw.exactMatch, "classification", checks);
  assert(raw.pipeline.stage === 1 && raw.pipeline.deployedSemantics === null && !raw.pipeline.actualCctpGuardSemanticsPromoted, "pipeline-null-semantics", checks);
  assert(raw.routePositive === 0 && raw.executableNow === 0 && !raw.signedActionJustified && !raw.fork, "gates", checks);
  assert(search.discovery.declaredRoots.length === 6 && search.discovery.declaredGlobs.length >= 7 && search.discovery.exclusions.length >= 10, "declared-search-policy", checks);
  assert(search.discovery.secretPathPolicy.matchBeforeStatOrRead && search.discovery.secretPathPolicy.contentRead === false, "secret-policy", checks);
  assert(search.discovery.counts.secretPathsSkipped > 0 && search.discovery.skippedSecrets.length === search.discovery.counts.secretPathsSkipped && search.discovery.skippedSecrets.every((x) => !x.contentRead), "secret-paths-skipped", checks);
  assert(search.discovery.counts.activeMetadataPayloadMatches === 0 && search.discovery.counts.matchingClosureMatches === 0, "negative-fail-predicate", checks);
  assert(search.discovery.matchingNonSensitivePaths.every((x) => /^[0-9a-f]{64}$/.test(x.sha256) && x.classification === "reference-only"), "safe-matches-hash-bound", checks);
  assert(search.gitObjectSearch.fullReachableCommitCount > 0 && search.gitObjectSearch.abbreviatedObjects.every((x) => !x.present), "git-search", checks);
  assert(search.candidateLedger.candidateCount === search.candidateLedger.rows.length && search.candidateLedger.candidateCount >= 31, "candidate-count", checks);
  assert(search.candidateLedger.nearest.rank === 1 && search.candidateLedger.nearest.commit === "03b868a12df59c2ec2639e3a8d97597dab6cb8f2", "nearest-commit", checks);
  assert(search.candidateLedger.nearest.markerMisses === 0 && search.candidateLedger.nearest.constructorAddressArgs === 6 && search.candidateLedger.nearest.buildEvidence.runtimeLengthDelta === 0 && search.candidateLedger.nearest.buildEvidence.executableBodyDiffBytes === 0 && search.candidateLedger.nearest.buildEvidence.fullRuntimeDiffBytes === 32, "nearest-evidence", checks);
  assert(search.candidateLedger.objectiveOrder.length === 9 && raw.candidate.nearestObjectiveDistance.join(",") === search.candidateLedger.nearest.objectiveDistance.join(","), "objective-order", checks);
  assert(build.sourceCommit === "03b868a12df59c2ec2639e3a8d97597dab6cb8f2" && build.compiler.version === "0.8.30+commit.73712a01", "build-commit-compiler", checks);
  assert(/^[0-9a-f]{64}$/.test(build.compiler.binarySha256) && build.settings.sha256 === digest(build.settings.value) && build.standardJsonInput.sha256 && build.standardJsonOutput.sha256, "compiler-input-output-bindings", checks);
  assert(build.buildInfo.sha256 && build.artifact.sha256 && build.artifact.runtimeSha256 && build.comparator.sha256 === digest(build.comparator.value), "artifact-comparator-bindings", checks);
  assert(build.artifact.runtimeBytes === 11555 && Object.values(build.artifact.immutableReferences).flat().length === 15 && Object.keys(build.artifact.linkReferences).length === 0, "runtime-normalization", checks);
  assert(build.comparator.value.differingBytes.length === 32 && build.comparator.value.differenceCategory === "runtime-CBOR-IPFS-digest", "cbor-comparator", checks);
  assert(raw.retained.creationSha256 === "a1204240aff49e21839588bb96ce484c2259866884b69b91a1e25a9fb7488e50" && raw.retained.normalizedRuntimeSha256 === "5b2319c1fc8a64d9fb45b7473e489c902976b0f98ae423e39ec055d431c50706", "retained-creation-runtime", checks);
  assert(raw.retained.deployments[0].patchedRetainedRuntimeSha256 === "f06f5859a51a1d0b987676df5a1d6bf4167037127f210c3770478f900c3f4f68" && raw.retained.deployments[1].patchedRetainedRuntimeSha256 === "b91cf9a3c51533218f496ce132c6a4420a58ab7a98d1f157dce0c088a4f93e5d", "both-active-runtimes", checks);
  assert(raw.semantics.deployedReceiveTransportBeforeNonce === null && raw.semantics.deployedSharedGuardCoverage === null, "deployed-semantics-null", checks);
  assert(tests.passed && tests.scannerChecksPassed === tests.scannerChecksTotal && tests.candidates.count === search.candidateLedger.candidateCount, "tests", checks);
  assert(leak.passed && leak.findingCount === 0 && !leak.endpointInventoryCompared, "leak", checks);
  assert(raw.activityScope.endpointInventoryReads === 0 && raw.activityScope.rpcCalls === 0 && raw.activityScope.httpRequests === 0 && raw.activityScope.webRequests === 0 && !raw.activityScope.forkCreated && raw.activityScope.liveCalls === 0 && raw.activityScope.secretFileReads === 0 && !raw.activityScope.productionMutation, "offline-scope", checks);
  assert(inbox.runId === raw.runId && !inbox.exactMatch && inbox.routePositive === 0, "inbox", checks);
  const records = manifest.records.map((r) => { const a = hashFile(r.path); assert(a.bytes === r.bytes && a.sha256 === r.sha256, `record:${r.path}`, checks); return a; }), aggregate = sha(Buffer.from(records.map((r) => `${r.path}\0${r.bytes}\0${r.sha256}`).join("\n")));
  assert(aggregate === manifest.aggregateSha256, "aggregate", checks);
  for (const r of manifest.recursivePredecessor.files) { const a = hashFile(r.path); assert(a.bytes === r.bytes && a.sha256 === r.sha256, `predecessor:${r.path}`, checks); }
  const predecessorAggregate = sha(Buffer.from(manifest.recursivePredecessor.files.map((r) => `${r.path}\0${r.bytes}\0${r.sha256}`).join("\n")));
  assert(predecessorAggregate === manifest.recursivePredecessor.aggregateSha256, "predecessor-aggregate", checks);
  process.stdout.write(JSON.stringify({ ok: true, checksPassed: checks.filter((x) => x.passed).length, checksTotal: checks.length, runId: raw.runId, classification: raw.classification, exactMatch: false, searchCounts: raw.discovery.counts, candidateCount: raw.candidate.count, nearestCommit: raw.candidate.nearestCommit, scannerChecks: tests.scannerChecksTotal, records: manifest.records.length, aggregateSha256: aggregate, pipeline: "1/5", nextGate: raw.nextGate }) + "\n");
}
try { main(); } catch (error) { process.stderr.write(JSON.stringify({ ok: false, category: String(error.message || error) }) + "\n"); process.exit(1); }
