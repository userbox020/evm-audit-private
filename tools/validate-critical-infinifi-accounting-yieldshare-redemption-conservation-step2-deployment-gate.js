#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./critical-infinifi-accounting-yieldshare-redemption-conservation-step2-deployment-gate-runner.js");
const ROOT = path.resolve(__dirname, "..");
const rel = (p) => path.join(ROOT, ...p.split("/"));
const read = (p) => fs.readFileSync(rel(p));
const json = (p) => JSON.parse(read(p).toString("utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let checks = 0;
function check(v, m) { checks += 1; if (!v) throw new Error(`check ${checks} failed: ${m}`); }
function equal(a, b, m) { check(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)}`); }

check(process.argv.length === 2, "no arguments");
const scripts = [`tools/${runner.STEM}-runner.js`, `tools/test-${runner.STEM}.js`, `tools/validate-${runner.STEM}.js`];
for (const script of scripts) equal(cp.spawnSync(process.execPath, ["--check", rel(script)], { cwd: ROOT, env: {} }).status, 0, `${script} syntax`);
const forbidden = [runner.FIXED_APPROVAL_REL, runner.LEDGER_REL, runner.FIXED_OUTPUT_REL];
equal(forbidden.map((p) => fs.existsSync(rel(p))), [false, false, false], "no approval ledger capture");
const child = cp.spawnSync(process.execPath, [rel(`tools/${runner.STEM}-runner.js`), "--check-only"],
  { cwd: ROOT, encoding: "utf8", env: {}, maxBuffer: 16 * 1024 * 1024 });
equal([child.status, child.stderr], [0, ""], "check-only passes"); const preflight = json(runner.PREFLIGHT_REL);
equal(JSON.parse(child.stdout), preflight, "preflight deterministic");
equal(preflight.methods.allowed, ["eth_call", "eth_chainId", "eth_getBlockByNumber"], "methods exact");
equal([preflight.caps.maxCandidates, preflight.caps.maxRequestsPerCandidate, preflight.caps.maxTotalRequests,
  preflight.caps.retriesPerRequest, preflight.caps.requestTimeoutMs, preflight.caps.maxElapsedMs, preflight.caps.maxResponseBytes],
  [4, 4, 10, 0, 10000, 120000, 2097152], "caps exact");
equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "offline preflight");
check(runner.validateSourceBindings(), "source and config bindings");
const tests = cp.spawnSync(process.execPath, [rel(`tools/test-${runner.STEM}.js`)],
  { cwd: ROOT, encoding: "utf8", env: {}, maxBuffer: 16 * 1024 * 1024 });
equal([tests.status, tests.stderr], [0, ""], "tests pass"); const testResult = JSON.parse(tests.stdout);
equal([testResult.status, testResult.fixtureClasses, testResult.networkReads, testResult.inventoryReads,
  testResult.captureExecuted, testResult.approvalCreated], ["PASS", 32, 0, 0, false, false], "test summary");
const evidence = json(runner.EVIDENCE_MANIFEST_REL); runner.validateEvidenceManifest(evidence); check(true, "evidence valid");
equal(evidence.configurationBinding, runner.CONFIG_BINDING, "configuration exact"); equal(evidence.sourceReview, runner.SOURCE_REVIEW, "source review exact");
const packageBytes = read(runner.PACKAGE_MANIFEST_REL), pkg = JSON.parse(packageBytes); runner.validateArtifactManifest(pkg, runner.PACKAGE_ARTIFACTS, "PACKAGE"); check(true, "package valid");
const proposal = json(runner.PROPOSAL_REL); runner.validateProposal(proposal); check(true, "proposal valid");
equal(proposal.proposalPayload.runnerSha256, `0x${sha(read(`tools/${runner.STEM}-runner.js`))}`, "runner bound");
equal(proposal.proposalPayload.packageManifestSha256, `0x${sha(packageBytes)}`, "package bound");
equal(proposal.proposalPayload.packageAggregateSha256, `0x${pkg.aggregateSha256}`, "aggregate bound");
equal(proposal.proposalPayload.evidenceBinding, evidence.evidenceBinding, "evidence bound");
const review = json(runner.REVIEW_MANIFEST_REL); runner.validateArtifactManifest(review,
  [runner.PREFLIGHT_REL, runner.REPORT_REL, runner.PROPOSAL_REL, runner.PACKAGE_MANIFEST_REL, runner.EVIDENCE_MANIFEST_REL], "REVIEW"); check(true, "review valid");
const step1Expected = {
  "reports/critical-infinifi-accounting-yieldshare-redemption-conservation-step1.md": "618f027015ab1ae1dcdd50966feb549bd3c602485663120cd777e171f4786587",
  "reports/raw/fast/critical-infinifi-accounting-yieldshare-redemption-conservation-step1.json": "2824edfab6a3bc712daf85fb35d0bd651586d456da0ce30ba9e682e8ddb4a302",
  "coordination/inbox/critical/20260801-critical-infinifi-accounting-step1.json": "49bbef49142118a95bcc9ec285b02a2cb579e0737a64f0a00c644a775abbf21f",
  "coordination/handoffs/20260801-critical-infinifi-accounting-step1-handoff.md": "3a312331445172938a1f12bd7bfb2ed0eb73a2cb17fbdb2d5d0226e19fdbe6f3",
  "targets/infinifi-protocol/deployment/configuration/addresses.1.json": "502df1dc483ea097c345bdc0529fe666f86ed776535b149389ec45930f0d6399"
};
for (const [p, expected] of Object.entries(step1Expected)) equal(sha(read(p)), expected, `prior/config immutable ${p}`);
let leakMatches = 0;
for (const p of [runner.PREFLIGHT_REL, runner.PROPOSAL_REL, runner.PACKAGE_MANIFEST_REL, runner.EVIDENCE_MANIFEST_REL, runner.REVIEW_MANIFEST_REL]) {
  const content = read(p).toString("utf8"); JSON.parse(content); leakMatches += (content.match(/(?:https?|wss?):\/\//giu) || []).length;
  leakMatches += (content.match(/"0x[0-9a-fA-F]{40}"/gu) || []).length;
  leakMatches += (content.match(/"(?:calldata|address|hostname|providerIdentity|rawResponse)"\s*:/giu) || []).length;
  check(content.endsWith("\n") && !/[ \t]+$/gmu.test(content), `${p} formatting`); }
equal(leakMatches, 0, "leak scan"); equal(forbidden.map((p) => fs.existsSync(rel(p))), [false, false, false], "validator side effects zero");
process.stdout.write(`${JSON.stringify({ status: "PASS", checks, offlineFixtureChecks: testResult.checks,
  fixtureClasses: testResult.fixtureClasses, evidenceArtifacts: evidence.artifactCount, sourceHashesVerified: Object.keys(runner.SOURCE_HASHES).length,
  priorArtifactsVerified: Object.keys(step1Expected).length, packageAggregateSha256: pkg.aggregateSha256, reviewAggregateSha256: review.aggregateSha256,
  proposalStatus: `${proposal.state}/${proposal.authorization}`, leakMatches, networkReads: 0, inventoryReads: 0,
  captureExecuted: false, approvalCreated: false }, null, 2)}\n`);
