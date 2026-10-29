#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as runner from "./critical-40acres-legacy-jit-deployment-step2-v2-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, "..");
const files = [
  `tools/${runner.PACKAGE_ID}-runner.mjs`,
  `tools/test-${runner.PACKAGE_ID}.mjs`,
  `tools/validate-${runner.PACKAGE_ID}.mjs`,
  `tools/fixtures/${runner.PACKAGE_ID}-fixtures.json`,
  runner.RECOMMENDED_ARTIFACT_MANIFEST
];
let checks = 0;
const check = (value, message) => { checks += 1; assert.ok(value, `check ${checks}: ${message}`); };
const equal = (actual, expected, message) => { checks += 1; assert.deepEqual(actual, expected, `check ${checks}: ${message}`); };
const hashes = {};

check(process.argv.length === 2, "validator accepts no arguments");
for (const relative of files) {
  const absolute = path.join(ROOT, ...relative.split("/")), bytes = fs.readFileSync(absolute);
  hashes[relative] = crypto.createHash("sha256").update(bytes).digest("hex");
  check(bytes.length > 0, `${relative} nonempty`);
  if (relative.endsWith(".mjs")) equal(spawnSync(process.execPath, ["--check", absolute], { cwd: ROOT, env: {}, encoding: "utf8" }).status, 0, `${relative} syntax`);
}
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", `${runner.PACKAGE_ID}-fixtures.json`), "utf8"));
equal([fixture.schemaVersion, fixture.packageId, fixture.sourceCommit, fixture.fixtureClasses.length],
  [1, runner.PACKAGE_ID, runner.SOURCE_COMMIT, 86], "fixture manifest binding");

const artifactManifestBytes = fs.readFileSync(path.join(ROOT, ...runner.RECOMMENDED_ARTIFACT_MANIFEST.split("/")));
const artifactManifest = JSON.parse(artifactManifestBytes), artifacts = runner.loadArtifactManifest(runner.RECOMMENDED_ARTIFACT_MANIFEST);
equal([artifactManifest.schemaVersion, artifactManifest.packageId, artifactManifest.sourceCommit, artifactManifest.artifacts.length],
  [2, runner.PREDECESSOR_PACKAGE_ID, runner.SOURCE_COMMIT, 4], "reused hard-pinned artifact manifest schema/source/count");
equal(artifacts.manifestSha256, crypto.createHash("sha256").update(artifactManifestBytes).digest("hex"), "artifact manifest hash");
equal([artifacts.manifestSha256, artifacts.provenanceAggregateSha256],
  [runner.EXPECTED_ARTIFACT_MANIFEST_SHA256, runner.EXPECTED_PROVENANCE_AGGREGATE_SHA256], "runner hard-pinned manifest/provenance constants");
equal(artifactManifest.provenanceAggregateSha256,
  crypto.createHash("sha256").update(Buffer.from(runner.canonicalJson({ provenance: artifactManifest.provenance,
    referenceRules: artifactManifest.referenceRules, artifacts: artifactManifest.artifacts }))).digest("hex"),
  "provenance aggregate");
equal([new Set(artifactManifest.artifacts.map((row) => row.path)).size, new Set(artifactManifest.artifacts.map((row) => row.family)).size],
  [4, 4], "artifact manifest unique paths/families");
for (const [index, row] of artifactManifest.artifacts.entries()) {
  const bytes = fs.readFileSync(path.join(ROOT, ...row.path.split("/"))), artifact = JSON.parse(bytes), entry = artifacts.entries[index];
  equal(crypto.createHash("sha256").update(bytes).digest("hex"), row.sha256, `${row.family} file hash binding`);
  check(entry.lengthBytes > 0 && entry.strippedLengthBytes > 0, `${row.family} nonempty code`);
  check(/^0x[0-9a-f]{64}$/u.test(entry.templateZeroedFullKeccak256) && /^0x[0-9a-f]{64}$/u.test(entry.informationalStrippedKeccak256), `${row.family} informational Keccak fields`);
  equal([entry.promotable, entry.fullRuntimeKeccak256, artifact.id, artifact.metadata.compiler.version,
    artifact.metadata.settings.evmVersion, artifact.metadata.settings.viaIR, artifact.metadata.settings.optimizer.enabled,
    artifact.metadata.settings.optimizer.runs, artifact.metadata.settings.metadata.bytecodeHash, artifact.metadata.settings.metadata.appendCBOR],
  [row.promotable, row.promotable ? entry.templateZeroedFullKeccak256 : null, row.artifactId, row.compilerVersion, "cancun", true, true, 500, "none", false], `${row.family} compiler/settings/promotion base`);
}

const target = path.join(ROOT, "targets", "40-acres-loan-contracts");
function local(executable, args) {
  const child = spawnSync(executable, args, { cwd: target, encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed: ${child.stderr}`);
  return child.stdout.trimEnd();
}
equal(local("git", ["rev-parse", "HEAD"]), artifactManifest.provenance.head, "exact HEAD");
equal(local("git", ["rev-parse", "HEAD^{tree}"]), artifactManifest.provenance.tree, "exact HEAD tree");
const untrackedAllowed = runner.validateTrackedStatus(local("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
equal(untrackedAllowed, ["test/audit/LegacyV2EpochRewardJitDifferential.t.sol"], "only untracked audit file allowed/recorded");
equal(spawnSync("git", ["diff", "--quiet", "--", "src", "foundry.toml", "foundry.lock", "lib"], { cwd: target, env: process.env }).status, 0, "tracked production/config/gitlinks clean");
equal(spawnSync("git", ["diff", "--cached", "--quiet", "--", "src", "foundry.toml", "foundry.lock", "lib"], { cwd: target, env: process.env }).status, 0, "staged production/config/gitlinks clean");
const recursivePins = runner.parseSubmoduleStatus(local("git", ["submodule", "status", "--recursive"]));
equal(recursivePins, artifactManifest.provenance.recursiveGitlinks, "recursive gitlink pins");
const topPins = local("git", ["ls-files", "-s", "lib"]).split(/\r?\n/u).filter(Boolean).map((line) => {
  const match = line.match(/^160000 ([0-9a-f]{40}) 0\t(.+)$/u); if (!match) throw new Error("top gitlink parse"); return { path: match[2], commit: match[1] };
});
equal(topPins, artifactManifest.provenance.topLevelGitlinks, "top-level gitlink pins");
const forgeVersion = local("forge", ["--version"]);
check(forgeVersion.includes("forge Version: 1.5.1-stable") && forgeVersion.includes(`Commit SHA: ${artifactManifest.provenance.toolchain.forgeCommit}`), "Foundry version/commit");
for (const row of artifactManifest.provenance.files) {
  const bytes = fs.readFileSync(path.join(ROOT, ...row.path.split("/")));
  equal(crypto.createHash("sha256").update(bytes).digest("hex"), row.sha256, `${row.path} provenance hash`);
}
const uupsLines = fs.readFileSync(path.join(ROOT, ...artifactManifest.referenceRules.uupsSelf.sourcePath.split("/")), "utf8").split(/\r?\n/u);
equal(uupsLines[artifactManifest.referenceRules.uupsSelf.sourceLine - 1].trim(), "address private immutable __self = address(this);", "UUPS __self source semantic");
const portfolioLines = fs.readFileSync(path.join(ROOT, ...artifactManifest.referenceRules.portfolioSelf.sourcePath.split("/")), "utf8").split(/\r?\n/u);
equal(portfolioLines[artifactManifest.referenceRules.portfolioSelf.sourceLine - 1].trim(), "library PortfolioLoanLib {", "Portfolio library declaration semantic");

const preflightChild = spawnSync(process.execPath, [path.join(HERE, `${runner.PACKAGE_ID}-runner.mjs`), "--check-only"],
  { cwd: ROOT, env: {}, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
equal([preflightChild.status, preflightChild.stderr], [0, ""], "check-only runner");
equal(JSON.parse(preflightChild.stdout), runner.preflight(), "deterministic check-only output");
const preflight = JSON.parse(preflightChild.stdout);
equal(preflight.transport, { mode: "JSON_RPC_SINGLETON_HTTP", requestBody: "SINGLE_OBJECT_NEVER_ARRAY", responseBody: "SINGLE_OBJECT_NEVER_ARRAY",
  automaticMultiRequestFallback: false }, "singleton transport declaration");
equal([preflight.predecessor.outputSha256, preflight.predecessor.transportStatus, preflight.predecessor.causeInference,
  preflight.predecessor.predecessorReadByV2Capture], [runner.PREDECESSOR_OUTPUT_SHA256, "V1_TRANSPORT_INCONCLUSIVE", false, false], "predecessor metadata only");
equal(preflight.outputPath, { fixedPath: runner.FIXED_OUTPUT_REL, writeMode: "wx", reservationBeforeRpc: true,
  sameReservedInodeFinalization: true, hardCrashLeavesReservationMarker: true,
  lifecycleStatuses: [runner.RESERVATION_STATUS, runner.STARTED_STATUS, runner.FAILURE_STATUS], failureMarkerStatus: runner.FAILURE_STATUS,
  reservationMarkerStatus: runner.RESERVATION_STATUS, startedMarkerStatus: runner.STARTED_STATUS,
  countSemantics: { started: "NULL_MEANS_INDETERMINATE", failureExact: "EXACT_FROM_MUTABLE_TRANSPORT_TELEMETRY",
    failureUnknown: "NULL_NEVER_COERCED_TO_ZERO" } }, "fixed v2 atomic wx output lifecycle");
check(!/batch/iu.test(JSON.stringify(preflight)), "preflight contains no legacy batch terminology");
check(!fs.existsSync(path.join(ROOT, ...runner.FIXED_OUTPUT_REL.split("/"))), "v2 output absent before capture");

const testChild = spawnSync(process.execPath, [path.join(HERE, `test-${runner.PACKAGE_ID}.mjs`)],
  { cwd: ROOT, env: {}, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
equal([testChild.status, testChild.stderr], [0, ""], "offline fixture test");
const testResult = JSON.parse(testChild.stdout);
equal([testResult.status, testResult.fixtureClasses, testResult.mockedRpcElements, testResult.liveNetworkReads, testResult.networkCaptureExecuted],
  ["PASS", 86, 15, 0, false], "offline test summary");

const sourceText = fs.readFileSync(path.join(HERE, `${runner.PACKAGE_ID}-runner.mjs`), "utf8");
check(!/readFileSync\([^)]*(?:rpc_endpoints\.txt|graphql_endpoints\.txt|\.env)/iu.test(sourceText), "no protected inventory reads");
check(!/eth_send|personal_|debug_|trace_|createFork|impersonat/iu.test(sourceText), "no signing mutation fork trace methods");
check(sourceText.includes("export async function rpcRequest") && sourceText.includes("rpcManySingleton") && !sourceText.includes("rpcBatch") &&
  !sourceText.includes("maxBatchRequests"), "singleton-only transport implementation");
const orchestrationSource = sourceText.slice(sourceText.indexOf("export async function orchestrateCliCapture"), sourceText.indexOf("function parseArgs"));
check(orchestrationSource.indexOf("const reserved = reserveFixedOutput") >= 0 &&
  orchestrationSource.indexOf("const reserved = reserveFixedOutput") < orchestrationSource.indexOf("markCaptureStarted") &&
  orchestrationSource.indexOf("markCaptureStarted") < orchestrationSource.indexOf("const output = await runCaptureImpl") &&
  orchestrationSource.includes("writeReservedJson") && orchestrationSource.includes("CAPTURE_FAILURE"), "CLI reserves/fsyncs before capture and persists failure on same descriptor");
const mainSource = sourceText.slice(sourceText.indexOf("async function main"));
check(mainSource.includes("orchestrateCliCapture") && !mainSource.includes("await runCapture("), "actual CLI capture path cannot bypass reservation orchestration");
const captureSource = sourceText.slice(sourceText.indexOf("export async function runCapture"), sourceText.indexOf("function parseArgs"));
check(captureSource.indexOf("verifyLocalProvenance()") >= 0 && captureSource.indexOf("verifyLocalProvenance()") < captureSource.indexOf("new Budget(CAPS)") &&
  captureSource.indexOf("new Budget(CAPS)") < captureSource.indexOf("pinChain("), "runCapture local provenance precedes immutable budget and RPC");
check(!captureSource.includes("dependencies.caps") && captureSource.includes("CAP_OVERRIDE_FORBIDDEN"), "production capture cap override impossible");
const localPrecondition = runner.verifyLocalProvenance();
equal([localPrecondition.verified, localPrecondition.manifestSha256, localPrecondition.provenanceAggregateSha256],
  [true, runner.EXPECTED_ARTIFACT_MANIFEST_SHA256, runner.EXPECTED_PROVENANCE_AGGREGATE_SHA256], "atomic local provenance verifier");
equal([runner.CANDIDATES.length, new Set(runner.CANDIDATES.map((row) => row.chain)).size], [1, 1], "candidate and chain caps");
equal([runner.CAPS.maxCandidates, runner.CAPS.maxChains, runner.CAPS.maxRpcElements, runner.CAPS.maxHttpRequests, runner.CAPS.retries, runner.CAPS.concurrency],
  [1, 1, 45, 45, 0, 1], "strict singleton request caps");
equal(runner.CANDIDATES[0], { id: "A", chain: "base", loan: "0x87f18b377e625b62c708d5f6ea96ec193558efd0", expectedVault: null,
  provenance: "OFFICIAL_REPO_LIVE_LEGACY_LOAN", applicability: "LEGACY_V2_CLAIM_CANDIDATE" }, "fixed candidate A binding");
check(!runner.CANDIDATES.some((row) => row.loan.toLowerCase().startsWith("0x1dc")), "excluded Base 0x1Dc candidate");

process.stdout.write(`${JSON.stringify({ status: "PASS", checks, offlineFixtureChecks: testResult.checks,
  fixtureClasses: fixture.fixtureClasses.length, mockedRpcElements: testResult.mockedRpcElements,
  networkCaptureExecuted: false, liveNetworkReads: 0, untrackedAuditFiles: untrackedAllowed,
  postOutputValidationMode: "SCHEMA_AND_INTERNAL_CONSISTENCY_ONLY_NO_RAW_RUNTIME_ACCESS",
  artifactCount: artifacts.entries.length, provenanceAggregateSha256: artifacts.provenanceAggregateSha256, files: hashes }, null, 2)}\n`);
