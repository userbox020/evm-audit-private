#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./critical-uniswapx-v2-empty-batch-opening-eth-deployment-economics-step3-runner.js");

const ROOT = path.resolve(__dirname, "..");
const rel = (value) => path.join(ROOT, ...value.split("/"));
const read = (value) => fs.readFileSync(rel(value));
const json = (value) => JSON.parse(read(value).toString("utf8"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;
function check(value, message) { checks += 1; if (!value) throw new Error(`check ${checks} failed: ${message}`); }
function equal(actual, expected, message) { check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`); }

check(process.argv.length === 2, "no validator arguments");
const scripts = [`tools/${runner.STEM}-runner.js`, `tools/test-${runner.STEM}.js`, `tools/validate-${runner.STEM}.js`];
for (const script of scripts) equal(cp.spawnSync(process.execPath, ["--check", rel(script)], { cwd: ROOT, env: {} }).status, 0, `${script} syntax`);

const forbidden = [runner.FIXED_APPROVAL_REL, runner.LEDGER_REL, runner.FIXED_OUTPUT_REL];
equal(forbidden.map((value) => fs.existsSync(rel(value))), [false, false, false], "no approval ledger or capture");
const checkOnly = cp.spawnSync(process.execPath, [rel(`tools/${runner.STEM}-runner.js`), "--check-only"],
  { cwd: ROOT, encoding: "utf8", env: {}, maxBuffer: 16 * 1024 * 1024 });
equal([checkOnly.status, checkOnly.stderr], [0, ""], "check-only passes");
const preflight = json(runner.PREFLIGHT_REL);
equal(JSON.parse(checkOnly.stdout), preflight, "checked preflight deterministic");
equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "preflight side effects zero");
equal(preflight.methods.allowed, [...runner.ALLOWED_METHODS].sort(), "allowlist exact");
equal([preflight.caps.maxInventoryEntries, preflight.caps.maxFamilies, preflight.caps.maxRequestsPerFamily,
  preflight.caps.maxTotalRequests, preflight.caps.retriesPerRequest, preflight.caps.requestTimeoutMs,
  preflight.caps.maxElapsedMs, preflight.caps.maxResponseBytes], [16, 4, 8, 16, 0, 10000, 120000, 2097152], "caps exact");
equal([preflight.providerPolicy.requiredHostnameDistinctFamilies, preflight.providerPolicy.backendIndependenceProven], [2, false], "hostname policy");
equal([preflight.gates.routePositive, preflight.gates.executableNow, preflight.gates.signedActionJustified, preflight.gates.fork],
  [0, 0, false, false], "operational gates closed");

const tests = cp.spawnSync(process.execPath, [rel(`tools/test-${runner.STEM}.js`)],
  { cwd: ROOT, encoding: "utf8", env: {}, maxBuffer: 16 * 1024 * 1024 });
equal([tests.status, tests.stderr], [0, ""], "offline tests pass");
const testResult = JSON.parse(tests.stdout);
equal([testResult.status, testResult.fixtureClasses, testResult.networkReads, testResult.inventoryReads,
  testResult.captureExecuted, testResult.approvalCreated], ["PASS", 37, 0, 0, false, false], "offline behavioral result");

const corrected = json(`reports/raw/fast/${runner.STEM}.json`);
equal([corrected.freshReadOnlyNextAction.chainId, corrected.calldata.hex.length, corrected.calldata.bytes,
  corrected.runtimeArtifact.runtimeBytes, corrected.runtimeArtifact.canonicalPermit2PatchedRuntimeKeccak256],
[1, 138, 68, 13003, "0x348af5101391c6649d9ac4a623af571d3aed3e2f267fc1fda19a098993e0ea7d"], "corrected Step3 constants");
equal(corrected.freshReadOnlyNextAction.allowedMethods.sort(), [...runner.ALLOWED_METHODS].sort(), "corrected methods match runner");
equal([corrected.calldata.postPectraHardMinimumChargedGas, runner.ECONOMIC_POLICY.minChargedGas], [21830, 21830], "hard floor exact");
equal(corrected.sourceBinding.step2AggregateSha256, "8f1f804640571a0f2b0e7014f171bc193fc6b949dee7d928c393322d6046db1c", "Step2 aggregate retained");

const evidence = json(runner.EVIDENCE_MANIFEST_REL); runner.validateEvidenceManifest(evidence); check(true, "evidence manifest valid");
const packageBytes = read(runner.PACKAGE_MANIFEST_REL); const packageManifest = JSON.parse(packageBytes);
runner.validateArtifactManifest(packageManifest, runner.PACKAGE_ARTIFACTS, "PACKAGE"); check(true, "package manifest valid");
const proposal = json(runner.PROPOSAL_REL); runner.validateProposal(proposal); check(true, "proposal exact schema valid");
equal(proposal.proposalPayload.runnerSha256, `0x${sha256(read(`tools/${runner.STEM}-runner.js`))}`, "proposal runner bound");
equal(proposal.proposalPayload.packageManifestSha256, `0x${sha256(packageBytes)}`, "proposal package manifest bound");
equal(proposal.proposalPayload.packageAggregateSha256, `0x${packageManifest.aggregateSha256}`, "proposal aggregate bound");
equal(proposal.proposalPayload.evidenceBinding, evidence.evidenceBinding, "proposal evidence bound");
equal(proposal.proposalPayload, { ...proposal.proposalPayload, ...runner.commitments() }, "all fixed scope commitments bound");
equal([proposal.reviewerIssuedApprovalRequirements.issuedAt, proposal.reviewerIssuedApprovalRequirements.expiresAt,
  proposal.reviewerIssuedApprovalRequirements.approvalCommitment, proposal.reviewerIssuedApprovalRequirements.reviewMaterialManifestSha256],
[null, null, null, null], "approval unissued");
const review = json(runner.REVIEW_MANIFEST_REL);
runner.validateArtifactManifest(review, [runner.PREFLIGHT_REL, runner.REPORT_REL, runner.PROPOSAL_REL,
  runner.PACKAGE_MANIFEST_REL, runner.EVIDENCE_MANIFEST_REL], "REVIEW"); check(true, "detached review manifest valid");
check(review.artifacts.some((row) => row.path === runner.PROPOSAL_REL && row.sha256 === sha256(read(runner.PROPOSAL_REL))), "full proposal file bound");

const callFailure = runner.evaluateCallResults([{ ok: true, result: "0x" }, { ok: true, result: "0x12" }]);
equal(callFailure.reason, "CALL_REVERT_OR_NONEMPTY", "nonempty result behavior");
const estimate = runner.evaluateEstimateResults([{ ok: true, result: "0x7530" }, { ok: true, result: "0x9c40" }]);
equal(estimate.estimates.map(String), ["30000", "40000"], "estimate divergence behavior");
equal(runner.calculateEconomics(1n, 21830n, 21830n, 1n).positive, false, "nonpositive economics behavior");
const econ = runner.calculateEconomics(1000000000000000000n, 30000n, 40000n, 10000000000n);
equal([econ.gasUsed.toString(), econ.stressedBaseFee.toString(), econ.priorityCompetition.toString()],
  ["48000", "11250000000", "2812500000"], "economic arithmetic behavior");
equal(runner.positiveResult({ openingBalanceWei: "1" }, { ...econ, positive: true }, new runner.Budget().summary()).operationalGates,
  { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, "positive remains diagnostic");

for (const value of [runner.PREFLIGHT_REL, runner.PROPOSAL_REL, runner.PACKAGE_MANIFEST_REL, runner.EVIDENCE_MANIFEST_REL,
  runner.REVIEW_MANIFEST_REL]) {
  const content = read(value).toString("utf8"); JSON.parse(content);
  check(!/(?:https?|wss?):\/\//iu.test(content), `${value} no URL`);
  check(!/"0x[0-9a-fA-F]{40}"/u.test(content), `${value} no address`);
  check(!/"(?:calldata|transactionHash|rawResponse|providerIdentity|providerHash|endpointHash|hostname)"/iu.test(content), `${value} no identity/raw fields`);
  check(content.endsWith("\n") && !/[ \t]+$/gmu.test(content), `${value} formatting`);
}
equal(forbidden.map((value) => fs.existsSync(rel(value))), [false, false, false], "validation created no approval ledger capture");

process.stdout.write(`${JSON.stringify({ status: "PASS", checks, offlineFixtureChecks: testResult.checks,
  fixtureClasses: testResult.fixtureClasses, evidenceArtifacts: evidence.artifactCount,
  packageAggregateSha256: packageManifest.aggregateSha256, reviewAggregateSha256: review.aggregateSha256,
  proposalStatus: `${proposal.state}/${proposal.authorization}`, networkReads: 0, inventoryReads: 0,
  captureExecuted: false, approvalCreated: false }, null, 2)}\n`);
