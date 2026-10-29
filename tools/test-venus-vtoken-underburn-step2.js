#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const capturePath = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-capture.json");
const summaryPath = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-summary.json");
const reportPath = path.join(ROOT, "reports/critical-venus-vtoken-underburn-step2.md");
let passed = 0;
function test(ok, label) { if (!ok) throw new Error(label); passed++; }
function ceilDiv(a, b) { return a === 0n ? 0n : (a - 1n) / b + 1n; }
const O = 10n ** 18n;

test(ceilDiv(0n, 7n) === 0n && ceilDiv(8n, 7n) === 2n, "ceilDiv");
for (let i = 1n; i <= 512n; i++) {
  const R = 1n + i * 7919n * 10n ** 11n;
  const A = 1n + i * 104729n;
  const B = A * O / R;
  const rem = A * O - B * R;
  test(rem >= 0n && rem < R, `rational bound ${i}`);
  const integerExcess = A - B * R / O;
  test(integerExcess <= ceilDiv(R, O), `integer bound ${i}`);
  const roundedUp = ceilDiv(A * O, R);
  test(roundedUp * R >= A * O, `isolated round-up ${i}`);
}

const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const report = fs.readFileSync(reportPath, "utf8");
test(capture.coverage.chainsRequested === 8 && capture.coverage.chainsWithFinalizedPin === 8, "chain coverage");
test(capture.chains.every(c => /^\d+$/.test(c.pin.number) && /^0x[0-9a-f]{64}$/.test(c.pin.hash)), "canonical pins");
test(capture.chains.every(c => c.coverage.terminal.allMatch === true), "terminal rechecks");
test(capture.coverage.coreMarketsEnumerated === 52, "core count");
test(capture.coverage.isolatedPoolsEnumerated === 19 && capture.coverage.isolatedMarketsEnumerated === 114, "isolated counts");
test(capture.gates.operationalRoutePositive === 0 && capture.gates.executableNow === 0 && capture.gates.fork === false, "gates");
test(Object.values(capture.leakGuard).every(x => x === 0), "leak guard counts");
const exact = capture.chains.find(c => c.chainId === 56).core.markets.filter(m => m.runtime.exactSelectedSourceRuntime);
test(exact.length === 1 && exact[0].symbol === "vSXP" && exact[0].state.mintPaused === true, "exact affected market closed");
test(summary.coverage.bnbCoreRowsWithCurrentRate > 0 && summary.coverage.bnbCoreRowsWithCurrentRate < 52, "null preservation count");
test(summary.bnbCore.topCompleteStateScenarios.every(x => x.maximumSameBlockNetUpperUsd < 0), "complete scenarios negative");
test(summary.classification === capture.classification, "classification consistency");
for (const file of [capturePath, summaryPath, reportPath]) {
  const text = fs.readFileSync(file, "utf8");
  test(!/https?:\/\//i.test(text), `no URL ${path.basename(file)}`);
  test(!/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}/.test(text), `no token-like hostname ${path.basename(file)}`);
}
console.log(`PASS ${passed}/${passed} offline fixture/integrity assertions; 512 formula cases; no files written`);
