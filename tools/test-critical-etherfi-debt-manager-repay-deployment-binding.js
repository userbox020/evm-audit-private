#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-debt-manager-repay-deployment-binding";
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const CLASSIFICATION = "INFORMATIONAL/DEPLOYMENT-UNBOUND/BOUNDED-REPAY-ROUNDING/TERMINAL-NORMALIZED-DUST/LOCAL-ROUTE-ONLY";
const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
function check(ok, message) { if (!ok) throw new Error(message); }
function hashFile(rel) { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; }

const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
const manifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
check(raw.classification === CLASSIFICATION, "classification drift");
check(raw.conclusion.advances === false && raw.gates.routePositive === 0 && raw.gates.executableNow === 0, "gate drift");
check(raw.gates.fork === false && raw.forkDecision.run === false, "fork gate drift");
check(raw.safety.readOnlyRpc && !raw.safety.signedActions && !raw.safety.broadcasts && !raw.safety.productionMutation, "safety drift");
check(raw.pin.finalized === true && raw.providerCoverage.exactHeaderFamilyCount >= 2 && raw.providerCoverage.exactDecodedCoreStateFamilyCount >= 2 && raw.providerCoverage.borrowerSampleStateFamilyCount === 1 && raw.providerCoverage.roleStateFamilyCount === 1, "pin/provider evidence incomplete");
check(raw.sourceContinuity.exactSourceRuntimeContinuity === true, "DebtManager source/runtime continuity absent");
check(raw.borrowHistory.windowComplete === true && raw.borrowHistory.fullHistoryClaimed === false && raw.borrowHistory.agreeingFamilyCount >= 2, "bounded borrow-history evidence incomplete");
check(raw.offchainAttribution.borrowerAttributableServiceOrValueBound === false && raw.netEconomics.exactNetUsd6Raw === null, "unsupported attribution/economics promotion");
check(raw.onchainPrerequisites.vulnerableBorrowTokenCount === 0 && raw.onchainPrerequisites.liquidVulnerableBorrowTokenCount === 0, "fork-close premise changed; independent review required");
check(raw.onchainPrerequisites.terminalDustBorrowTokenCount > 0 && raw.assets.some((x) => x.repaymentMath?.terminalNormalizedDust), "terminal-dust deployment row absent");
check(raw.onchainPrerequisites.terminalDustBorrowTokenCount === raw.assets.length, "minimum-debt terminal-dust matrix incomplete");
check(raw.configurationDrift.activeBorrowTokenCount > raw.configurationDrift.localDeclaredBorrowTokenCount && raw.configurationDrift.activeTokensNotMappedToFixtureName.length > 0, "active/local borrow-token drift absent");
check(!JSON.stringify(raw).match(/https?:\/\//i), "endpoint leak");
const recomputed = manifest.records.map((record) => {
  const current = hashFile(record.path);
  check(current.bytes === record.bytes && current.sha256 === record.sha256, `manifest mismatch: ${record.path}`);
  return current;
});
const aggregate = sha(recomputed.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
check(aggregate === manifest.aggregateSha256, "manifest aggregate mismatch");
check(manifest.runId === raw.runId, "run identity mismatch");
console.log(JSON.stringify({ ok: true, tests: 14, runId: raw.runId, classification: raw.classification, pin: raw.pin, manifestAggregateSha256: aggregate }, null, 2));
