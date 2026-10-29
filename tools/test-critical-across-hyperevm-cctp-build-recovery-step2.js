#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-across-hyperevm-cctp-build-recovery-step2";
const RAW = `reports/raw/fast/${NAME}.json`, BUILD = `reports/raw/fast/${NAME}-candidate-build.json`, TESTS = `reports/raw/fast/${NAME}-tests.json`, LEAK = `reports/raw/fast/${NAME}-leak-scan.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`, INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`, HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`, SCANNER = `tools/scan-${NAME}.js`, VALIDATOR = `tools/test-${NAME}.js`;
const abs = (rel) => path.join(ROOT, rel), read = (rel) => fs.readFileSync(abs(rel)), json = (rel) => JSON.parse(read(rel).toString("utf8")), sha = (value) => crypto.createHash("sha256").update(value).digest("hex"), hashFile = (rel) => { const body = read(rel); return { path: rel, bytes: body.length, sha256: sha(body) }; };
function assert(ok, label, checks) { checks.push({ label, passed: !!ok }); if (!ok) throw new Error(label); }
function main() {
  for (const rel of [RAW, BUILD, TESTS, LEAK, MANIFEST, REPORT, INBOX, HANDOFF, SCANNER, VALIDATOR]) if (!fs.existsSync(abs(rel))) throw new Error(`missing:${rel}`);
  const raw = json(RAW), build = json(BUILD), tests = json(TESTS), leak = json(LEAK), manifest = json(MANIFEST), inbox = json(INBOX), checks = [];
  assert(raw.classification === "WATCH/COVERAGE-BLOCKED/EXACT-CCTP-BUILD-METADATA-OBJECT-ABSENT/STEP2" && raw.exactMatch === false, "fail-closed-classification", checks);
  assert(raw.pipeline.stage === 1 && raw.pipeline.exactActiveCctpBuildRecovered === false && raw.pipeline.actualCctpGuardSemanticsPromoted === false, "pipeline-not-advanced", checks);
  assert(raw.routePositive === 0 && raw.executableNow === 0 && raw.signedActionJustified === false && raw.fork === false, "gates-closed", checks);
  assert(raw.retainedBindings.creationFamilyExact && raw.retainedBindings.creationBytes === 37196 && raw.retainedBindings.creationSha256 === "a1204240aff49e21839588bb96ce484c2259866884b69b91a1e25a9fb7488e50", "retained-creation-binding", checks);
  assert(raw.retainedBindings.normalizedRuntimeTemplateBytes === 11555 && raw.retainedBindings.normalizedRuntimeTemplateSha256 === "5b2319c1fc8a64d9fb45b7473e489c902976b0f98ae423e39ec055d431c50706", "retained-normalized-runtime", checks);
  assert(raw.retainedBindings.solcReportedImmutableReferenceCount === 15 && raw.retainedBindings.solcReportedLinkReferenceCount === 0, "immutable-link-scope", checks);
  assert(raw.retainedBindings.deployments.length === 2 && raw.retainedBindings.deployments.every((row) => row.retainedPatchedExact && !row.candidatePatchedExact), "both-active-runtime-hashes", checks);
  assert(raw.retainedBindings.deployments[0].patchedRetainedRuntimeSha256 === "f06f5859a51a1d0b987676df5a1d6bf4167037127f210c3770478f900c3f4f68", "usdc-runtime-exact", checks);
  assert(raw.retainedBindings.deployments[1].patchedRetainedRuntimeSha256 === "b91cf9a3c51533218f496ce132c6a4420a58ab7a98d1f157dce0c088a4f93e5d", "usdh-runtime-exact", checks);
  assert(raw.candidateResult.sourceCommit === "03b868a12df59c2ec2639e3a8d97597dab6cb8f2" && raw.candidateResult.fullNormalizedRuntimeByteExact === false, "candidate-commit-not-exact", checks);
  assert(raw.candidateResult.executableBodyExcludingCborByteExact && raw.candidateResult.differingByteCount === 32 && raw.candidateResult.differingRuntimeByteRangeInclusive.join(",") === "11512,11543", "cbor-only-difference", checks);
  assert(raw.candidateResult.activeMetadata.cid === "QmT2V8ejSdB8J7wtztQNfGHtZxn85f9WJADvjJC7kdVPtW" && raw.candidateResult.candidateMetadata.cid === "QmRbm2RTFUbC9AU4c2dLXBVBBFTLZgMpCpKRADjbev7zHo", "metadata-cids", checks);
  assert(raw.candidateResult.acceptedByGate === false && raw.semanticGate.promotionAllowed === false && raw.semanticGate.actualReceiveTransportBeforeNonceExact === null && raw.semanticGate.actualSharedReentrancyGuardSemanticsExact === null, "semantic-promotion-blocked", checks);
  assert(build.compiler.version === "0.8.30+commit.73712a01" && build.settings.optimizer.runs === 300 && build.settings.viaIR && build.settings.evmVersion === "prague", "compiler-settings", checks);
  assert(build.settings.metadata.bytecodeHash === "ipfs" && build.settings.metadata.useLiteralContent === true && build.closureCount === 51, "metadata-closure", checks);
  assert(Object.keys(build.artifact.immutableReferences).length === 5 && Object.values(build.artifact.immutableReferences).flat().length === 15 && Object.keys(build.artifact.linkReferences).length === 0, "solc-normalization-records", checks);
  assert(raw.localSearch.recordedCommitObjects.every((row) => !row.locallyPresent) && !raw.localSearch.exactMetadataPayloadLocallyPresent && !raw.localSearch.exactStandardJsonLocallyPresent, "missing-local-objects", checks);
  assert(raw.missingContentAddressedObjects.length === 4, "precise-missing-object-list", checks);
  assert(tests.passed && tests.build.passed && tests.checksPassed === tests.checksTotal && tests.exactMatch === false, "recovery-tests", checks);
  assert(leak.passed && leak.findingCount === 0 && leak.endpointInventoryCompared === false, "leak-scan", checks);
  assert(raw.activityScope.endpointInventoryReads === 0 && raw.activityScope.rpcCalls === 0 && raw.activityScope.httpRequests === 0 && raw.activityScope.webRequests === 0 && !raw.activityScope.forkCreated && raw.activityScope.liveCalls === 0 && raw.activityScope.signedTransactions === 0 && raw.activityScope.broadcasts === 0 && !raw.activityScope.productionMutation && !raw.activityScope.retainedCaptureRerun, "offline-scope", checks);
  assert(inbox.runId === raw.runId && inbox.exactMatch === false && inbox.routePositive === 0, "inbox-binding", checks);
  const records = manifest.records.map((row) => { const actual = hashFile(row.path); assert(actual.bytes === row.bytes && actual.sha256 === row.sha256, `record:${row.path}`, checks); return actual; });
  const aggregate = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  assert(aggregate === manifest.aggregateSha256, "manifest-aggregate", checks);
  for (const row of manifest.predecessorFiles) { const actual = hashFile(row.path); assert(actual.bytes === row.bytes && actual.sha256 === row.sha256, `predecessor:${row.path}`, checks); }
  const predecessorAggregate = sha(Buffer.from(manifest.predecessorFiles.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  assert(predecessorAggregate === manifest.predecessorAggregateSha256, "predecessor-aggregate", checks);
  process.stdout.write(JSON.stringify({ ok: true, checksPassed: checks.filter((row) => row.passed).length, checksTotal: checks.length, runId: raw.runId, classification: raw.classification, exactMatch: false, sourceCommit: raw.candidateResult.sourceCommit, compiler: build.compiler.version, settings: build.settings, records: manifest.records.length, comparatorChecks: tests.checksTotal, aggregateSha256: aggregate, pipeline: "1/5", nextGate: raw.nextGate }) + "\n");
}
try { main(); } catch (error) { process.stderr.write(JSON.stringify({ ok: false, category: String(error.message || error) }) + "\n"); process.exit(1); }
