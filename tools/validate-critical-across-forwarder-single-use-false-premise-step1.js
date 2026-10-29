"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const NAME = "critical-across-forwarder-single-use-false-premise-step1";
const CLASSIFICATION = "CLOSED/FALSE-PREMISE/NO-BASE-FORWARDER/ADMIN-CREATION/NONREENTRANT-CEI/SINGLE-USE";
const ROOT = path.resolve(__dirname, "..");
const RAW = `reports/raw/fast/${NAME}.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const INBOX = `coordination/inbox/critical/2026-07-25-${NAME}.json`;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative));
const json = (relative) => JSON.parse(read(relative));
const checks = [];
const check = (condition, label) => {
  if (!condition) throw new Error(label);
  checks.push(label);
};

const raw = json(RAW);
const tests = json(TESTS);
const manifest = json(MANIFEST);
const inbox = json(INBOX);
check(raw.classification === CLASSIFICATION && manifest.classification === CLASSIFICATION, "classification");
check(raw.pipeline.branch === 0 && raw.pipeline.total === 5, "branch-0-of-5");
check(raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false && raw.gates.fork === false, "gates");
check(raw.baseArtifactBinding.canonicalGeneratedName === "Base_Adapter" && raw.baseArtifactBinding.relayTokensInputCount === 4, "base-adapter");
check(raw.baseArtifactBinding.baseNamedConcreteInheritor === false && raw.baseArtifactBinding.localForwarderDeploymentArtifacts.length === 0, "no-base-forwarder");
check(tests.testsPassed === 5 && tests.testsFailed === 0 && tests.fuzzCases >= 256 && tests.effectiveCases === 260, "tests-and-fuzz");
check(tests.deterministicReplay === true && tests.replayCount === 2 && /^[0-9a-f]{64}$/.test(tests.normalizedPassOutputSha256), "deterministic-replay");
check(raw.productionBinding.commit === manifest.productionCommit && raw.productionBinding.source.sha256 === manifest.productionSource.sha256, "production-binding");
check(manifest.localHarness.harnessRuntimeSha256 === tests.isolatedCompile.harnessRuntimeSha256, "harness-byte-binding");
check(raw.activityScope.rpcCalls === 0 && raw.activityScope.httpRequests === 0 && raw.activityScope.forkCreated === false && raw.activityScope.signing === false && raw.activityScope.broadcasts === 0, "offline-safety");
check(inbox.routePositive === 0 && inbox.executableNow === 0 && inbox.signedActionJustified === false && inbox.fork === false, "inbox-gates");
const records = manifest.records.map((record) => {
  const value = read(record.path);
  check(value.length === record.bytes && sha(value) === record.sha256, `record:${record.path}`);
  return { path: record.path, bytes: value.length, sha256: sha(value) };
});
const aggregate = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
check(aggregate === manifest.aggregateSha256, "aggregate");
process.stdout.write(`${JSON.stringify({ ok: true, checksPassed: checks.length, checksTotal: checks.length, runId: raw.runId, classification: CLASSIFICATION, tests: "5/5", fuzzCases: tests.fuzzCases, effectiveCases: tests.effectiveCases, replayCount: tests.replayCount, normalizedPassOutputSha256: tests.normalizedPassOutputSha256, harnessRuntimeSha256: tests.isolatedCompile.harnessRuntimeSha256, manifestSha256: sha(read(MANIFEST)), aggregateSha256: aggregate })}\n`);
