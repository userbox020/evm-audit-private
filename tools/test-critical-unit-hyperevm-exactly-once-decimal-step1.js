#!/usr/bin/env node
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-unit-hyperevm-exactly-once-decimal-step1";
const RAW = `reports/raw/fast/${NAME}.json`, TESTS = `reports/raw/fast/${NAME}-tests.json`, LEAK = `reports/raw/fast/${NAME}-leak-scan.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const scan = require(`./scan-${NAME}.js`);
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const file = (r) => fs.readFileSync(path.join(ROOT, r));
const json = (r) => JSON.parse(file(r));
const raw = json(RAW), tests = json(TESTS), leak = json(LEAK), manifest = json(MANIFEST);
assert.strictEqual(raw.pin.chainId, 999); assert(raw.pin.strictFamilyCount >= 3); assert.strictEqual(raw.pin.terminalRecheckPassed, true); assert.strictEqual(raw.pin.backendOperatorIndependenceEstablished, false);
assert.deepStrictEqual(raw.scope.strictAssets, ["UBTC", "UETH", "USOL", "UPUMP", "UFART"]); assert.strictEqual(raw.scope.uxplSeparate, true); assert.strictEqual(raw.assets.length, 5);
for (const a of raw.assets) { assert(Number.isInteger(a.decimals)); assert(/^\d+$/.test(a.totalSupplyRaw)); assert(/^0x[0-9a-f]{64}$/i.test(a.proxyRuntimeKeccak256)); assert(/^0x[0-9a-f]{64}$/i.test(a.implementationRuntimeKeccak256)); assert.strictEqual(a.adminAddress, null); assert.strictEqual(a.beaconAddress, null); assert(a.stateFamilyAgreement.agreed); assert(a.history.crossFamilyAgreement.agreed); assert.strictEqual(a.history.coverage.globallyComplete, false); assert(a.history.coverage.creationBlock >= 0); assert.strictEqual(a.history.coverage.retainedTailWindow.toBlock, raw.pin.blockNumber); assert.notStrictEqual(a.upgradeHistoryCurrentMatchesSlot, false); assert.strictEqual(a.conservation.genesisMintEqualsCurrentTotalSupply, true); assert.strictEqual(a.conservation.systemBalanceReconciles, null); assert(a.callableSelectors.length >= 20); }
assert.strictEqual(raw.operationApi.addressGeneration.called, false); assert.strictEqual(raw.operationApi.retriesSubmitted, false); assert.strictEqual(raw.operationApi.operationsSubmitted, false); assert.strictEqual(raw.graphqlPrefilter.usedForFinality, false); assert.strictEqual(raw.operationSchema.modelOnly, true);
assert.strictEqual(raw.pipeline.stage, 0); assert.strictEqual(raw.gates.routePositive, 0); assert.strictEqual(raw.gates.executableNow, 0); assert.strictEqual(raw.gates.signedActionJustified, false); assert.strictEqual(raw.gates.fork, false);
const rerun = scan.runModelTests(4096); assert.strictEqual(rerun.status, "PASS"); assert(rerun.fuzzEffectiveCases >= 4096 * 6); assert.strictEqual(tests.status, "PASS"); assert.strictEqual(leak.status, "PASS");
for (const r of manifest.records) { const b = file(r.path); assert.strictEqual(b.length, r.bytes); assert.strictEqual(sha(b), r.sha256); } const aggregate = sha(Buffer.from(manifest.records.map((r) => `${r.path}\0${r.bytes}\0${r.sha256}`).join("\n"))); assert.strictEqual(aggregate, manifest.aggregateSha256);
for (const rel of [RAW, TESTS, LEAK, MANIFEST, `reports/${NAME}.md`, `coordination/inbox/critical/2026-07-25-${NAME}.json`, `coordination/handoffs/2026-07-25-${NAME}-handoff.md`]) { const t = file(rel).toString("utf8"); assert(!/(?:https?|wss?):\/\//i.test(t)); assert(!/"(?:transactionHash|sourceTxHash|destinationTxHash)"\s*:\s*"(?:0x)?[0-9a-z]{32,}"/i.test(t)); assert(!/"signatures"\s*:/i.test(t)); }
process.stdout.write(`${JSON.stringify({ status: "PASS", runId: raw.runId, pin: raw.pin, assets: raw.assets.map((x) => x.symbol), operationRows: raw.operationApi.operationRowsObserved, duplicateAndConservation: raw.duplicateAndConservation, storedTests: tests, independentModelFuzz: rerun, manifestAggregateSha256: manifest.aggregateSha256, gates: raw.gates }, null, 2)}\n`);
