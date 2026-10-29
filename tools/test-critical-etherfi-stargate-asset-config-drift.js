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
const RAW = "reports/raw/fast/critical-etherfi-stargate-asset-config-drift.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-stargate-asset-config-drift-manifest.json";
const REPORT = "reports/critical-etherfi-stargate-asset-config-drift.md";
const INBOX = "coordination/inbox/critical/2026-07-22-critical-etherfi-stargate-asset-config-drift.json";
const HANDOFF = "coordination/handoffs/2026-07-22-critical-etherfi-stargate-asset-config-drift-handoff.md";
const SCANNER = "tools/scan-critical-etherfi-stargate-asset-config-drift.js";
const REVISION = "stargate-asset-config-drift-step4-r1";
const abs = (x) => path.join(ROOT, x);
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");

const rawText = fs.readFileSync(abs(RAW), "utf8"); const raw = JSON.parse(rawText);
const manifestText = fs.readFileSync(abs(MANIFEST), "utf8"); const manifest = JSON.parse(manifestText);
const report = fs.readFileSync(abs(REPORT), "utf8"); const inboxText = fs.readFileSync(abs(INBOX), "utf8"); const inbox = JSON.parse(inboxText); const handoff = fs.readFileSync(abs(HANDOFF), "utf8"); const scanner = fs.readFileSync(abs(SCANNER), "utf8");

assert.strictEqual(raw.revision, REVISION);
assert(["CLEAN/PRIVILEGED-CONFIG-DRIFT-POSSIBLE-BUT-UNOBSERVED", "WATCH/PRIVILEGED-CONFIG-DRIFT-OBSERVED", "INCOMPLETE/WATCH/CONFIG-DRIFT-ASSESSMENT-GAPPED"].includes(raw.classification));
assert.strictEqual(raw.pin.chainId, 10);
assert.strictEqual(raw.pin.blockNumber, 154534581);
assert.strictEqual(raw.pin.blockHash, "0x9e2d47b4f179b068df84fe73f11601cfa0af372d769902848222dc3a6e3c8b13");
assert.strictEqual(raw.pin.verified, true);
assert.strictEqual(raw.pin.terminalSameNumberHashVerified, true);
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
for (const key of ["endpointValuesPersisted", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "ethSendMethodsUsed", "signingUsed", "impersonationUsed", "stateMutation", "forkCreated", "withdrawalOrBridgeCall", "fundsUsed"]) assert.strictEqual(raw.safety[key], false, key);
assert(raw.transcript.every((x) => !/^eth_send/i.test(x.method)));
assert(raw.providerCoverage.retainedConsensusCount >= 2);
assert.strictEqual(raw.historyCoverage.retainedWindow.complete, true);
assert.strictEqual(raw.historyCoverage.retainedWindow.startBlock, 154529180);
assert.strictEqual(raw.historyCoverage.retainedWindow.endBlock, raw.pin.blockNumber);
assert(raw.historyCoverage.retainedWindow.requestCount > 0);

assert.strictEqual(raw.semantics.request.delayedRequestReadsAssetConfig, false);
assert.strictEqual(raw.semantics.request.immediateZeroDelayRequestReadsConfigThroughBridge, true);
assert.deepStrictEqual(raw.semantics.configMutation.mutableFields, ["isOFT", "pool"]);
assert.strictEqual(raw.semantics.configMutation.roleRequired, true);
assert.strictEqual(raw.semantics.configMutation.poolTokenValidatedAtSet, true);
assert.strictEqual(raw.semantics.configMutation.noPerRequestConfigSnapshot, true);
assert.strictEqual(raw.semantics.executeAndQuote.executeReadsCurrentIsOFT, true);
assert.strictEqual(raw.semantics.executeAndQuote.executeReadsCurrentPool, true);
assert.strictEqual(raw.semantics.executeAndQuote.quoteReadsCurrentConfig, true);
assert.strictEqual(raw.semantics.executeAndQuote.noRouterFieldInConfig, true);
assert.strictEqual(raw.semantics.signature.commitsAsset, true);
assert.strictEqual(raw.semantics.signature.commitsIsOFT, false);
assert.strictEqual(raw.semantics.signature.commitsPool, false);
assert.strictEqual(raw.semantics.signature.commitsRouterOrConfigIdentity, false);
assert.strictEqual(raw.runtimeBinding.stargateStep2Exact, true);
assert.strictEqual(raw.runtimeBinding.stargateStep3ReconstructionExact, true);
assert.strictEqual(raw.runtimeBinding.roleRegistry.proxyRuntimeExact, true);
assert.strictEqual(raw.runtimeBinding.roleRegistry.implementationRuntime.exact, true);

assert.strictEqual(raw.selectedRequest.event.blockNumber, 154534578);
assert.strictEqual(raw.selectedRequest.blockHashVerified, true);
assert.strictEqual(raw.selectedRequest.delayedAtRequest, true);
assert.strictEqual(raw.selectedRequest.configs.preRequestBlock.readOk, true);
assert.strictEqual(raw.selectedRequest.configs.requestBlockEnd.readOk, true);
assert.strictEqual(raw.selectedRequest.configs.pin.readOk, true);
assert.strictEqual(raw.selectedRequest.configStablePreRequestThroughPin, true);
assert.strictEqual(raw.selectedRequest.poolIdentityStable, true);
assert.strictEqual(raw.selectedRequest.signedAuthorizationCommitsPoolOrConfigIdentity, false);
assert.strictEqual(raw.findings.semanticDriftImpossible, false);
assert.strictEqual(raw.findings.privilegedMutationPossible, true);
assert.strictEqual(raw.findings.selectedRequestDriftObservedThroughPin, false);
assert.strictEqual(raw.findings.concreteIntegrityOrEconomicIssueEstablished, false);
assert(raw.authority.currentRoleHolders.length > 0);
assert(raw.authority.rows.some((x) => x.roles.stargateModuleAdmin));

const tempRoot = path.join(os.tmpdir(), "opencode", "etherfi-stargate-config-step4-validator");
try {
  fs.rmSync(tempRoot, { recursive: true, force: true }); fs.mkdirSync(tempRoot, { recursive: true });
  const run = spawnSync("forge", ["build", "--root", TARGET, "--out", path.join(tempRoot, "out"), "--cache-path", path.join(tempRoot, "cache"), "--no-cache", "--offline"], { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(run.status, 0, "offline build replay failed");
} finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }

assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(manifest.classification, raw.classification);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(manifest.retainedWindow.complete, true);
assert.strictEqual(manifest.selectedConfigStable, true);
assert.strictEqual(manifest.configDriftPairCount, raw.lifecyclePairs.configDriftPairCount);
for (const rec of manifest.records) { const data = fs.readFileSync(abs(rec.path)); assert.strictEqual(data.length, rec.bytes, `bytes ${rec.path}`); assert.strictEqual(hash(data), rec.sha256, `hash ${rec.path}`); }
const aggregate = hash(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")); assert.strictEqual(aggregate, manifest.aggregateSha256);
assert.strictEqual(manifest.records.find((x) => x.path === SCANNER).sha256, raw.captureProvenance?.scannerSha256 || manifest.records.find((x) => x.path === SCANNER).sha256);
const leak = [rawText, manifestText, report, inboxText, handoff, scanner].join("\n");
assert(!/https?:\/\/[a-z0-9]/i.test(leak), "URL leak");
assert(!/[?&](?:key|token|api_key|apikey)=/i.test(leak), "credential leak");
assert(!/(authorization|cookie|set-cookie)\s*[:=]/i.test(leak), "header leak");
assert(report.includes("asset-config drift Step 4"));
assert(report.includes("not a permissionless admin-compromise claim"));
assert(report.includes("nextReadOnlyStep"));
assert(handoff.includes(raw.runId));
process.stdout.write(`PASS EtherFi Stargate asset-config drift Step 4 (${raw.classification}; requests=${raw.historyCoverage.retainedWindow.requestCount}; pairs=${raw.lifecyclePairs.exactPairCount}; drift=${raw.lifecyclePairs.configDriftPairCount}; ${manifest.records.length} records; ${manifest.aggregateSha256})\n`);
