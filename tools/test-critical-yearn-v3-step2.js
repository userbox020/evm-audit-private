#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const runner = require("./run-critical-yearn-v3-step2");
const validator = require("./validate-critical-yearn-v3-step2");
const generator = require("./generate-critical-yearn-v3-step2-manifest");

let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
function eq(a, b, message) { assert.deepStrictEqual(a, b, message); checks++; }

const inventory = runner.parseInventory(`note\nhttps://alpha.example/rpc/key\n[header: x-test=secret]\nhttps://beta.example/path\n`);
eq(inventory.length, 2, "inventory deduplicates and parses URLs");
eq(runner.familyKey("https://x.alpha.example/path"), "alpha.example", "registrable family reduction");
ok(runner.semverTarget("3.0.1"), "3.0.1 included");
ok(runner.semverTarget("3.0.3"), "3.0.3 included");
ok(runner.semverTarget("3.1.0"), "3.1.0 included");
ok(!runner.semverTarget("3.0.0"), "3.0.0 excluded");
ok(!runner.semverTarget("2.0.0"), "v2 excluded");

const logs = runner.normalizeLogs([
  { address: "0x0000000000000000000000000000000000000002", blockNumber: "0x2", blockHash: `0x${"22".repeat(32)}`, transactionHash: `0x${"33".repeat(32)}`, transactionIndex: "0x1", logIndex: "0x2", topics: [], data: "0x" },
  { address: "0x0000000000000000000000000000000000000001", blockNumber: "0x1", blockHash: `0x${"11".repeat(32)}`, transactionHash: `0x${"44".repeat(32)}`, transactionIndex: "0x0", logIndex: "0x1", topics: [], data: "0x" }
]);
eq(logs[0].blockNumber, 1, "logs sort canonically");
eq(logs[1].blockNumber, 2, "logs retain later row");

eq(runner.grossCapture(100n, 100n, 100n, 0n), 50n, "Step1 100/100/100 capture");
eq(runner.grossCapture(100n, 100n, 100n, 2_000n), 36n, "performance-fee-adjusted integer capture");
eq(runner.grossCapture(0n, 0n, 0n, 0n), 0n, "zero denominator safe");
eq(runner.rpow(1000000000393915525145987602n, 259200n), 1000102108116776650997819865n, "exact three-day DSR RAY growth");
eq(1269083508555249382456318n * (runner.rpow(1000000000393915525145987602n, 259200n) - 10n ** 27n) / 10n ** 27n, 129583727090881369588n, "exact DAI opportunity cost");
eq(runner.fixedRatio(5909333289321077304n * 10000n * 365n, 1269083508555249382456318n * 3n, 4), "5.6652", "three-day break-even bps");
ok(runner.terminalRowsExactlyTrue([{ sameHash: true, finalizedAtOrAbove: true }, { sameHash: true, finalizedAtOrAbove: true }], 2), "runner terminal exact booleans pass");
ok(!runner.terminalRowsExactlyTrue([{ sameHash: null, finalizedAtOrAbove: true }, { sameHash: true, finalizedAtOrAbove: true }], 2), "runner rejects null sameHash");
ok(!runner.terminalRowsExactlyTrue([{ sameHash: "true", finalizedAtOrAbove: true }, { sameHash: true, finalizedAtOrAbove: true }], 2), "runner rejects truthy nonboolean sameHash");
ok(!runner.terminalRowsExactlyTrue([{ sameHash: true, finalizedAtOrAbove: null }, { sameHash: true, finalizedAtOrAbove: true }], 2), "runner rejects null finalizedAtOrAbove");
ok(!runner.terminalRowsExactlyTrue([{ sameHash: true, finalizedAtOrAbove: 1 }, { sameHash: true, finalizedAtOrAbove: true }], 2), "runner rejects truthy nonboolean finalizedAtOrAbove");
for (let i = 1n; i <= 512n; i++) {
  const A = i * 1_000_003n, p = i * 17n, small = runner.grossCapture(A, A / 10n, p, 0n), large = runner.grossCapture(A, A, p, 0n);
  ok(small <= large, "gross capture monotonic in attacker deposit");
  ok(large <= p, "gross capture cannot exceed report profit");
}

const root = path.resolve(__dirname, ".."), rawPath = path.join(root, "reports/raw/fast/critical-yearn-v3-tokenized-strategy-accounting-step2.json"), reportPath = path.join(root, "reports/critical-yearn-v3-tokenized-strategy-accounting-step2.md"), inboxPath = path.join(root, "coordination/inbox/critical/yearn-v3-tokenized-strategy-accounting-step2.json"), handoffPath = path.join(root, "coordination/handoffs/2026-07-27-critical-yearn-v3-step2.md"), manifestPath = path.join(root, generator.MANIFEST_REL);
const raw = JSON.parse(fs.readFileSync(rawPath)), report = fs.readFileSync(reportPath, "utf8"), inbox = JSON.parse(fs.readFileSync(inboxPath)), handoff = fs.readFileSync(handoffPath, "utf8");
ok(validator.validateData(raw, report, inbox, handoff).checks > 40, "corrected package data validates");
for (const mutate of [
  x => { x.pin.stateRefreshTerminalRecheck[0].sameHash = null; },
  x => { x.pin.stateRefreshTerminalRecheck[0].sameHash = "true"; },
  x => { x.daiOpportunityQueryCoverage.terminalRecheck[1].finalizedAtOrAbove = null; }
]) {
  const fixture = structuredClone(raw); mutate(fixture); let rejected = false; try { validator.validateData(fixture, report, inbox, handoff); } catch { rejected = true; } ok(rejected, "null/truthy terminal fixture rejected");
}
const manifestBefore = fs.readFileSync(manifestPath), manifestHashBefore = crypto.createHash("sha256").update(manifestBefore).digest("hex"), originalWrite = fs.writeFileSync; let checkOnlyPassed = false;
try { fs.writeFileSync = () => { throw new Error("validator attempted write"); }; checkOnlyPassed = validator.validatePackage({ checkManifest: true }).checks > 0; } finally { fs.writeFileSync = originalWrite; }
ok(checkOnlyPassed, "validator succeeds with filesystem writes forbidden");
eq(crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"), manifestHashBefore, "validator leaves manifest unchanged");
const tampered = JSON.parse(manifestBefore); tampered.files[0].sha256 = "0".repeat(64); let tamperRejected = false; try { validator.verifyManifest(tampered); } catch { tamperRejected = true; } ok(tamperRejected, "manifest tamper rejected");

process.stdout.write(`${JSON.stringify({ status: "PASS", deterministicChecks: checks - 1024, fuzzCases: 512, fuzzAssertions: 1024, effectiveChecks: checks, runnerTerminalExactBooleanFixtures: 5, validatorNullRejectionFixtures: 3, manifestTamperFixtures: 1, validatorNoWriteFixtures: 1 })}\n`);
