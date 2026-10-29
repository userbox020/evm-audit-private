#!/usr/bin/env node
"use strict";

const assert = require("assert"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, ".."), NAME = "critical-etherfi-debt-manager-eurc-zero-share-fork-poc";
const RAW = `reports/raw/fast/${NAME}.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`, INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`, HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const abs = (x) => path.join(ROOT, x), read = (x) => fs.readFileSync(abs(x), "utf8"), json = (x) => JSON.parse(read(x));
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex"), hashFile = (x) => { const b = fs.readFileSync(abs(x)); return { path: x, bytes: b.length, sha256: sha(b) }; };
for (const rel of [RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assert(fs.existsSync(abs(rel)), `missing:${rel}`);
const raw = json(RAW), manifest = json(MANIFEST), inbox = json(INBOX), report = read(REPORT), handoff = read(HANDOFF);
assert.strictEqual(raw.classification, "DEPLOYMENT_RELEVANT_LOCAL_FORK_POC/PENDING_REVIEW/NO_MARKET_PROFIT_CLAIM");
assert.strictEqual(raw.deploymentRelevantPoCSucceeds, true); assert.strictEqual(raw.pipeline.recommendation, "2/5_PENDING_INDEPENDENT_REVIEW"); assert.strictEqual(raw.pipeline.promoted, false);
assert.strictEqual(raw.fork.chainId, 10); assert.strictEqual(raw.fork.pinNumber, 154624560); assert.strictEqual(raw.fork.pinHash, "0x99e06b23d27f439a7567f5e193d94f517eb5d54e97230713d1795abb2fa1867a");
assert.strictEqual(raw.bindings.paused, false); assert.strictEqual(raw.bindings.totalAssetsRaw, "0"); assert.strictEqual(raw.bindings.totalSharesRaw, "0"); assert.strictEqual(raw.bindings.minSharesRaw, "10000000");
assert.strictEqual(raw.forge.status, "PASS"); assert.strictEqual(raw.forge.testCount, 6); assert.strictEqual(raw.proof.rollbackSnapshotDeterministic, true);
assert.strictEqual(raw.predecessorBindings.deployment.aggregateSha256, "52f426b91244e05122fab1943e80eea283c2564d8cce2f92834b93ea440e8e0d");
assert.strictEqual(raw.predecessorBindings.primitive.aggregateSha256, "84e3f7e33dbbe187c9c255bf3a84cad36a033b5806b35125689bda548310235a");
assert.strictEqual(raw.predecessorBindings.failedHistoryCapture.aggregateSha256, "8eec9b725bef9d526e8e870ef635c8ed9a9e21d1a22c700745949ea6fb4f3bfe");
const exact = raw.proof.scenarios.filter((x) => x.mode === "d_min"), before = raw.proof.scenarios.filter((x) => x.mode === "d_min_minus_1"); assert.strictEqual(exact.length, 3); assert.strictEqual(before.length, 3);
for (const row of raw.proof.scenarios) { const v = BigInt(row.victimAmountRaw), d = 10_000_000n * (v - 1n) + (row.mode === "d_min" ? 1n : 0n); assert.strictEqual(BigInt(row.donationRaw), d); assert.strictEqual(BigInt(row.attackerCapitalRaw), 10_000_000n + d); assert.strictEqual(row.conservationExcludingDealRaw, "0"); if (row.mode === "d_min") { assert.strictEqual(row.victimSharesMintedRaw, "0"); assert.strictEqual(BigInt(row.attackerTokenDeltaRaw), v); assert.strictEqual(BigInt(row.victimAggregateTokenDeltaRaw), -v); assert.strictEqual(row.finalManagerBalanceRaw, "0"); assert(row.gas.attackerWithdraw > 21_000); } else { assert(BigInt(row.victimSharesMintedRaw) > 0n); assert.strictEqual(row.gas.attackerWithdraw, null); } }
assert.deepStrictEqual(exact.map((x) => x.attackerCapitalRaw), ["10000001", "10000000000001", "100000000000001"]);
assert.strictEqual(raw.proof.repeatedVictims.repeatedVictims, 3); assert.strictEqual(raw.proof.repeatedVictims.attackerTokenDeltaRaw, "3000000"); assert.strictEqual(raw.proof.repeatedVictims.victimAggregateTokenDeltaRaw, "-3000000");
assert.strictEqual(raw.proof.safeReferenceDifferential.minimumSharesOutInDebtManagerSupply, false); assert.strictEqual(raw.proof.permissionless.productionRoleImpersonationUsed, false);
assert.strictEqual(raw.gates.routePositive, 0); assert.strictEqual(raw.gates.executableNow, 0); assert.strictEqual(raw.gates.signedActionJustified, false); assert.strictEqual(raw.gates.forkScope, "EPHEMERAL_LOCAL_ONLY");
assert.strictEqual(raw.safety.endpointMaterialPersisted, false); assert.strictEqual(raw.safety.upstreamProviderIdentifiersPersisted, false); assert.strictEqual(raw.safety.rawRpcPersisted, false); assert.strictEqual(raw.safety.privateKeysRead, false); assert.strictEqual(raw.safety.broadcast, false); assert.strictEqual(raw.safety.productionMutation, false); assert.strictEqual(raw.safety.realFunds, false);
for (const row of manifest.records) assert.deepStrictEqual(row, hashFile(row.path)); assert.strictEqual(sha(Buffer.from(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"))), manifest.aggregateSha256);
assert.strictEqual(inbox.status, raw.classification); assert.strictEqual(inbox.pipelineRecommendation, "2/5_PENDING_INDEPENDENT_REVIEW");
const generated = [read(RAW), read(MANIFEST), report, read(INBOX), handoff].join("\n"); assert(!/(?:https?|wss?):\/\//i.test(generated)); assert(!/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie)\s*[:=]\s*[^\s,}\]]+/i.test(generated));
assert(report.includes("# 🟡 VULNERABLE")); assert(report.includes("The deployment-relevant PoC succeeds")); assert(report.includes("no claim is made that this capital or a victim route is currently available")); assert(handoff.includes("2/5 pending independent review"));
process.stdout.write(`PASS DebtManager EURC local fork PoC package (tests=6; raw=${hashFile(RAW).sha256}; report=${hashFile(REPORT).sha256}; manifest=${hashFile(MANIFEST).sha256}; aggregate=${manifest.aggregateSha256})\n`);
