#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const RAW = "reports/raw/fast/critical-etherfi-stargate-valid-auth-tuple-invariant.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-stargate-valid-auth-tuple-invariant-manifest.json";
const REPORT = "reports/critical-etherfi-stargate-valid-auth-tuple-invariant.md";
const INBOX = "coordination/inbox/critical/2026-07-22-critical-etherfi-stargate-valid-auth-tuple-invariant.json";
const HANDOFF = "coordination/handoffs/2026-07-22-critical-etherfi-stargate-valid-auth-tuple-invariant-handoff.md";
const SCANNER = "tools/scan-critical-etherfi-stargate-valid-auth-tuple-invariant.js";
const SOL_TEST = "targets/cash-v3/test/critical/EtherFiStargateValidAuthTupleInvariant.t.sol";
const REVISION = "stargate-valid-auth-tuple-invariant-step3-r1";
const SEED = "0x53544550335f53544152474154455f415554485f5455504c455f323032363037";
const abs = (x) => path.join(ROOT, x);
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");

const rawText = fs.readFileSync(abs(RAW), "utf8"); const raw = JSON.parse(rawText);
const manifestText = fs.readFileSync(abs(MANIFEST), "utf8"); const manifest = JSON.parse(manifestText);
const report = fs.readFileSync(abs(REPORT), "utf8");
const inboxText = fs.readFileSync(abs(INBOX), "utf8"); const inbox = JSON.parse(inboxText);
const handoff = fs.readFileSync(abs(HANDOFF), "utf8");
const scanner = fs.readFileSync(abs(SCANNER), "utf8");
const solidityTest = fs.readFileSync(abs(SOL_TEST), "utf8");

assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.classification, "PASS/BOUNDED-VALID-AUTH-TUPLE-INVARIANT");
assert.strictEqual(raw.pin.chainId, 10);
assert.strictEqual(raw.pin.blockNumber, 154534581);
assert.strictEqual(raw.pin.blockHash, "0x9e2d47b4f179b068df84fe73f11601cfa0af372d769902848222dc3a6e3c8b13");
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
for (const key of ["liveRpcCalls", "endpointInventoryRead", "envFilesRead", "privateKeysOrSigningFilesRead", "liveContractsCalled", "forkCreated", "realWithdrawalExecuted", "realBridgeExecuted", "broadcast", "fundsUsed"]) assert.strictEqual(raw.safety[key], false, key);
assert.strictEqual(raw.safety.localOnly, true);
assert.strictEqual(raw.safety.localMockStateTransitions, true);
assert.strictEqual(raw.safety.ephemeralTestIdentity, true);

assert.strictEqual(raw.sourceBinding.sourceCommitMatch, true);
assert.strictEqual(raw.sourceBinding.allStep1ClosureRowsExact, true);
assert.strictEqual(raw.sourceBinding.stargateSource.exact, true);
assert.strictEqual(raw.runtimeBindings.stargate.exactCurrentReconstructionEqualsStep2DeployedRuntime, true);
assert.strictEqual(raw.runtimeBindings.safeImplementation.exactCurrentReconstructionHashEqualsPinObservedImplementation, true);
assert.strictEqual(raw.runtimeBindings.safeImplementation.legacyLatestDynamicNotUsedAsPinAuthority, true);
assert(raw.runtimeBindings.stargate.immutableRows.length === 2);
assert(raw.runtimeBindings.safeImplementation.immutableRows.length >= 1);
assert.strictEqual(raw.semantics.allChecksPass, true);
assert(Object.values(raw.semantics.checks).every(Boolean));

const expectedFields = ["Safe", "asset", "amount", "destination EID", "destination recipient", "max slippage", "caller", "Safe nonce"];
assert.deepStrictEqual(raw.fieldInvariantMatrix.map((x) => x.field), expectedFields);
for (const field of ["Safe", "asset", "amount", "destination EID", "destination recipient", "max slippage"]) assert.strictEqual(raw.fieldInvariantMatrix.find((x) => x.field === field).cryptographicallyBound, true, field);
const caller = raw.fieldInvariantMatrix.find((x) => x.field === "caller");
assert.strictEqual(caller.cryptographicallyBound, false);
assert(caller.mutationOutcome.includes("accepted for arbitrary relayer"));
for (const field of ["destination EID", "destination recipient", "max slippage"]) {
  const row = raw.fieldInvariantMatrix.find((x) => x.field === field);
  assert.strictEqual(row.cashBound, false);
  assert.strictEqual(row.executeGuardBound, false);
  assert(row.mutationOutcome.includes("not rechecked against Cash"));
}
for (const field of ["asset", "amount"]) {
  const row = raw.fieldInvariantMatrix.find((x) => x.field === field);
  assert.strictEqual(row.cashBound, true);
  assert.strictEqual(row.executeGuardBound, true);
}

assert.strictEqual(raw.testResults.tests.testsPassed, 13);
assert.strictEqual(raw.testResults.tests.testsFailed, 0);
assert.strictEqual(raw.testResults.tests.unitTestsPassed, 11);
assert.strictEqual(raw.testResults.tests.fuzzPropertiesPassed, 2);
assert.strictEqual(raw.testResults.tests.fuzzRunsPerProperty, 256);
assert.strictEqual(raw.testResults.tests.totalFuzzCases, 512);
assert.strictEqual(raw.testResults.tests.fuzzSeed, SEED);
assert.strictEqual(raw.testResults.tests.passLines.length, 13);
assert(raw.conclusions.cryptographicBinding.includes("Safe"));
assert(raw.conclusions.callerBinding.includes("relayer-neutral"));
assert(raw.conclusions.overwriteAndReplay.includes("Invalid overwrite and replay revert"));

const tempRoot = path.join(os.tmpdir(), "opencode", "etherfi-stargate-valid-auth-step3-validator");
try {
  fs.rmSync(tempRoot, { recursive: true, force: true }); fs.mkdirSync(tempRoot, { recursive: true });
  const args = ["test", "--root", TARGET, "--out", path.join(tempRoot, "out"), "--cache-path", path.join(tempRoot, "cache"), "--no-cache", "--offline", "--match-path", "test/critical/EtherFiStargateValidAuthTupleInvariant.t.sol", "--fuzz-runs", "256", "--fuzz-seed", SEED, "-vv"];
  const run = spawnSync("forge", args, { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout || ""}\n${run.stderr || ""}`;
  assert.strictEqual(run.status, 0, "local invariant replay failed");
  assert.strictEqual(output.split(/\r?\n/).filter((x) => /^\[PASS\]/.test(x.trim())).length, 13);
  assert.strictEqual(output.split(/\r?\n/).filter((x) => /\[PASS\].*\(runs:\s*256,/.test(x)).length, 2);
  assert(/13 tests passed, 0 failed, 0 skipped \(13 total tests\)/.test(output));
} finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }

assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(manifest.classification, raw.classification);
assert.strictEqual(manifest.testSeed, SEED);
assert.strictEqual(manifest.fuzzRunsPerProperty, 256);
assert.strictEqual(manifest.totalFuzzCases, 512);
assert.strictEqual(manifest.testsPassed, 13);
assert.strictEqual(manifest.exactBinding, true);
for (const rec of manifest.records) { const data = fs.readFileSync(abs(rec.path)); assert.strictEqual(data.length, rec.bytes, `bytes ${rec.path}`); assert.strictEqual(hash(data), rec.sha256, `hash ${rec.path}`); }
const aggregate = hash(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
assert.strictEqual(aggregate, manifest.aggregateSha256);
assert.strictEqual(manifest.records.find((x) => x.path === SCANNER).sha256, raw.captureProvenance.scannerSha256);

const leak = [rawText, manifestText, report, inboxText, handoff, scanner, solidityTest].join("\n");
assert(!/https?:\/\/[a-z0-9]/i.test(leak), "URL leak");
assert(!/[?&](?:key|token|api_key|apikey)=/i.test(leak), "credential leak");
assert(!/(authorization|cookie|set-cookie)\s*[:=]/i.test(leak), "header leak");
assert(report.includes("⚪ CLEAN — BOUNDED VALID-AUTH TUPLE INVARIANT"));
assert(report.includes("caller is deliberately not signed"));
assert(report.includes("512` fuzz cases total"));
assert(report.includes("nextReadOnlyStep"));
assert(handoff.includes(raw.runId));
process.stdout.write(`PASS EtherFi Stargate valid-auth tuple Step 3 (${raw.classification}; 13 tests; 512 fuzz cases; ${manifest.records.length} records; ${manifest.aggregateSha256})\n`);
