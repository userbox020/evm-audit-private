#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RAW = "reports/raw/fast/critical-etherfi-default-module-capability.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-default-module-capability-manifest.json";
const REPORT = "reports/critical-etherfi-default-module-capability.md";
const INBOX = "coordination/inbox/critical/2026-07-21-critical-etherfi-default-module-capability.json";
const HANDOFF = "coordination/handoffs/2026-07-21-critical-etherfi-default-module-capability-handoff.md";
const SCOPED = ["EtherFiLiquidModule", "EtherFiLiquidModuleWithReferrer", "FraxModule", "StargateModule", "EtherFiStakeModule", "LiquidUSDLiquifierModule"].sort();
const CAPTURE_SCANNER_SHA256 = "d610736791d4293ed67dcf3ae40b1868e847c5a944f6778756a1fab2dacbc4e5";
const abs = (p) => path.join(ROOT, p);
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");

const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
const manifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
const inbox = JSON.parse(fs.readFileSync(abs(INBOX), "utf8"));
const report = fs.readFileSync(abs(REPORT), "utf8");
const handoff = fs.readFileSync(abs(HANDOFF), "utf8");

assert.strictEqual(raw.schemaVersion, 2);
assert.strictEqual(raw.revision, "audit-reviewer-corrections-r1");
assert.strictEqual(raw.reviewerCorrectionStatus, "APPLIED");
assert.strictEqual(raw.classification, "INCOMPLETE/WATCH/SCOPED-SIX-RUNTIME-AND-TUPLE-COVERAGE-OPEN");
assert.strictEqual(raw.signal, "🟠 WATCH");
assert.strictEqual(raw.scope, "Optimism authorization and traced Safe/Cash solvency behavior for exactly six named non-Cash modules: EtherFiLiquidModule, EtherFiLiquidModuleWithReferrer, FraxModule, StargateModule, EtherFiStakeModule, LiquidUSDLiquifierModule");
assert.strictEqual(raw.reviewCoverage.onlySixNamedNonCashModules, true);
assert.strictEqual(raw.reviewCoverage.cashModuleIncludedInAuthorizationMatrix, false);
assert.strictEqual(raw.reviewCoverage.otherLiveDefaultsReviewed, false);
assert.strictEqual(raw.reviewCoverage.broadAllDefaultsConclusion, false);
assert.deepStrictEqual([...raw.reviewCoverage.scopedModuleNames].sort(), SCOPED);

assert.strictEqual(raw.pin.chainId, 10);
assert.strictEqual(raw.pin.finalizedSelected, true);
assert.strictEqual(raw.pin.exactNumberHashMatch, true);
assert.strictEqual(raw.pin.terminalSameNumberHashMatch, true);
for (const field of ["routePositive", "executableNow"]) assert.strictEqual(raw[field], 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
assert.strictEqual(inbox.routePositive, 0);
assert.strictEqual(inbox.executableNow, 0);
assert.strictEqual(inbox.signedActionJustified, false);
assert.strictEqual(manifest.routePositive, 0);
assert.strictEqual(manifest.executableNow, 0);
assert.strictEqual(manifest.signedActionJustified, false);

assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(manifest.revision, raw.revision);
assert.strictEqual(inbox.revision, raw.revision);
assert(report.includes(raw.runId));
assert(report.includes(raw.revision));
assert(handoff.includes(raw.runId));
assert(handoff.includes(raw.revision));

const captureSuffix = raw.runId.split("-").at(-1);
const currentScannerSha256 = hash(fs.readFileSync(abs("tools/scan-critical-etherfi-default-module-capability.js")));
assert.strictEqual(captureSuffix, "d610736791d4");
assert.strictEqual(CAPTURE_SCANNER_SHA256.slice(0, 12), captureSuffix);
assert.strictEqual(raw.captureProvenance.captureRunId, raw.runId);
assert.strictEqual(raw.captureProvenance.captureScannerSha256, CAPTURE_SCANNER_SHA256);
assert.strictEqual(raw.captureProvenance.runIdSuffix, captureSuffix);
assert.strictEqual(raw.captureProvenance.runIdSuffixBindsCaptureScannerHash, true);
assert.strictEqual(raw.captureProvenance.captureTimestamp, raw.generatedAt);
assert.deepStrictEqual(raw.captureProvenance.capturePin, raw.pin);
assert.strictEqual(raw.publicationProvenance.currentPublicationScannerSha256, currentScannerSha256);
assert.notStrictEqual(raw.publicationProvenance.currentPublicationScannerSha256, raw.captureProvenance.captureScannerSha256);
assert.strictEqual(raw.publicationProvenance.mode, "offline-publication-repackage");
assert.strictEqual(raw.publicationProvenance.laterCorrectionsOfflineNoNetwork, true);
assert.strictEqual(raw.publicationProvenance.networkCallsForPublicationCorrections, 0);
assert.strictEqual(raw.publicationProvenance.byteIdenticalCaptureReproductionClaimed, false);
assert.strictEqual(raw.publicationProvenance.newNetworkRunWouldDeriveNewRunId, true);
assert(/retained capture identity/i.test(raw.publicationProvenance.statement));
assert(/not a byte-identical reproduction/i.test(raw.publicationProvenance.statement));
assert.deepStrictEqual(inbox.captureProvenance, raw.captureProvenance);
assert.deepStrictEqual(inbox.publicationProvenance, raw.publicationProvenance);

assert.strictEqual(raw.authorizationMatrix.length, 22);
assert.strictEqual(raw.authorizationMatrixScope, "six named non-Cash modules only");
assert.strictEqual(raw.cashModuleIncludedInAuthorizationMatrix, false);
assert.deepStrictEqual([...new Set(raw.authorizationMatrix.map((x) => x.module))].sort(), SCOPED);
assert(!raw.authorizationMatrix.some((x) => x.module === "CashModule"));
assert(raw.deployment.unreviewedDefaults.every((x) => !x.scoped));
assert(raw.deployment.unidentifiedDefaults.every((x) => x.name === null && x.reviewStatus === "outside-six-not-reviewed"));
assert.strictEqual(raw.deployment.returnedDefaultPredicateCount, raw.deployment.defaultModules.length);
assert.strictEqual(raw.deployment.scopedPredicateCount, 6);
assert.strictEqual(raw.deployment.observedDefaultModuleCount, 11);
assert.strictEqual(raw.deployment.unreviewedDefaultCount, raw.deployment.observedDefaultModuleCount - raw.deployment.scopedPredicateCount);
assert.strictEqual(raw.deployment.unreviewedDefaults.length, raw.deployment.unreviewedDefaultCount);
assert.strictEqual(raw.deployment.unreviewedDefaultCount, 5);
assert.strictEqual(raw.deployment.otherUnreviewedDefaultCountExcludingCashModule, 4);
assert.strictEqual(raw.reviewCoverage.observedDefaultCount, 11);
assert.strictEqual(raw.reviewCoverage.scopedDefaultCount, 6);
assert.strictEqual(raw.reviewCoverage.unreviewedDefaultCount, 5);
assert.strictEqual(raw.reviewCoverage.otherUnreviewedDefaultCountExcludingCashModule, 4);
assert.strictEqual(raw.deployment.allReturnedPredicatesExact, true);
for (const row of raw.deployment.modulePredicateRows.filter((x) => x.returnedDefault || x.scoped)) {
  assert.strictEqual(row.isDefault, true, `isDefault ${row.address}`);
  assert.strictEqual(row.isWhitelisted, true, `isWhitelisted ${row.address}`);
}

assert.strictEqual(raw.outsiderProbes.length, 14);
assert.strictEqual(raw.probeSemantics.total, 14);
assert.strictEqual(raw.probeSemantics.strictExpectedSelectorMatches, 14);
assert.strictEqual(raw.probeSemantics.providerErrors, 0);
assert.strictEqual(raw.probeSemantics.malformedSuccesses, 0);
assert.strictEqual(raw.probeSemantics.unknownOrEmptySelectors, 0);
assert.strictEqual(raw.probeSemantics.allStrictlyFailedClosed, true);
assert.strictEqual(raw.allOutsiderProbesFailedClosed, true);
for (const probe of raw.outsiderProbes) {
  assert.strictEqual(probe.outcome, "revert", `outcome ${probe.name}`);
  assert.strictEqual(probe.strictFailedClosed, true, `strict ${probe.name}`);
  assert(/^0x[0-9a-f]{8}$/.test(probe.actualRevertSelector), `selector ${probe.name}`);
  assert(probe.expectedRevertSelectors.includes(probe.actualRevertSelector), `expected selector ${probe.name}`);
  assert(probe.expectedRevertSignatures.length > 0, `expected signature ${probe.name}`);
}
assert(/outsider rejection only/i.test(raw.probeSemantics.alteredTupleLimitation));

assert.strictEqual(raw.localVerification.pinBound, false);
assert.strictEqual(raw.localVerification.authoritativeForFixedPinEquality, false);
assert.strictEqual(raw.localVerification.fixedPinSourceRuntimeEquality, null);
assert(/non-pin-bound/i.test(raw.localVerification.caveat));
assert.strictEqual(raw.deployment.dataProviderRuntimeSourceMismatchCaveat, true);
assert(/conditional/i.test(raw.finalStateSolvency.conclusionScope));
assert(/persistent approvals/i.test(raw.finalStateSolvency.approvalsAndCallbacks));
assert(/rebasing/i.test(raw.finalStateSolvency.residual));

assert.strictEqual(typeof raw.source.closure.complete, "boolean");
assert.strictEqual(manifest.sourceClosureComplete, raw.source.closure.complete);
assert.strictEqual(manifest.publicationCorrectionStatus, "APPLIED");
assert.strictEqual(manifest.observedDefaultCount, 11);
assert.strictEqual(manifest.scopedDefaultCount, 6);
assert.strictEqual(manifest.unreviewedDefaultCount, manifest.observedDefaultCount - manifest.scopedDefaultCount);
assert.strictEqual(manifest.otherUnreviewedDefaultCountExcludingCashModule, 4);
assert(raw.source.closure.files.length > 15);
if (!raw.source.closure.complete) {
  assert(raw.source.closure.unresolved.length > 0);
  assert(raw.classification.includes("WATCH"));
} else assert.strictEqual(raw.source.closure.unresolved.length, 0);

for (const record of manifest.records) {
  const b = fs.readFileSync(abs(record.path));
  assert.strictEqual(b.length, record.bytes, `byte count ${record.path}`);
  assert.strictEqual(hash(b), record.sha256, `hash ${record.path}`);
}
const scannerRecord = manifest.records.find((x) => x.path === "tools/scan-critical-etherfi-default-module-capability.js");
assert(scannerRecord, "scanner manifest record");
assert.strictEqual(scannerRecord.sha256, currentScannerSha256);
assert.strictEqual(manifest.publicationProvenance.currentPublicationScannerSha256, scannerRecord.sha256);
assert.strictEqual(manifest.captureProvenance.captureScannerSha256, CAPTURE_SCANNER_SHA256);
assert.strictEqual(manifest.captureProvenance.captureRunId, manifest.runId);
assert.notStrictEqual(manifest.captureProvenance.captureScannerSha256, scannerRecord.sha256);
const aggregate = hash(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
assert.strictEqual(aggregate, manifest.aggregateSha256);
for (const source of raw.source.closure.files) assert(manifest.records.some((x) => x.path === source.path && x.sha256 === source.sha256), `closure manifest ${source.path}`);

const generatedLeakText = [JSON.stringify(raw), JSON.stringify(manifest), JSON.stringify(inbox), report, handoff, fs.readFileSync(abs("tools/scan-critical-etherfi-default-module-capability.js"), "utf8")].join("\n");
assert(!/https?:\/\/[a-z0-9]/i.test(generatedLeakText), "endpoint/url leak");
assert(!/(authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/i.test(generatedLeakText), "header leak");
assert(!/[?&](?:key|token|api_key|apikey)=[^\s&"']+/i.test(generatedLeakText), "query credential leak");
assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(generatedLeakText), "private-key block leak");
assert(raw.budgets.rpc.readsUsed <= raw.budgets.rpc.maxReads);
assert(raw.budgets.providerSelection.calls <= raw.budgets.providerSelection.maxCalls);
assert(report.includes("requiredForRoutePositive"));
assert(report.includes("nextReadOnlyStep"));
assert(report.includes("CashModule is not in the 22-row"));
assert(/five live defaults including CashModule/i.test(report));
assert(/CashModule and four other live defaults/i.test(report));
assert(/11 observed minus 6 scoped equals 5 unreviewed/i.test(handoff));
assert(/CashModule and four other live defaults/i.test(handoff));
assert(!/CashModule and 5 non-scoped live defaults/i.test(report + handoff));
assert(!/\. five live defaults/.test(report + JSON.stringify(raw.blockers)));
assert(!/unidentified rows, are/i.test(report + JSON.stringify(raw.blockers)));
assert(report.includes(CAPTURE_SCANNER_SHA256));
assert(report.includes(currentScannerSha256));
assert(report.includes(raw.captureProvenance.captureTimestamp));
assert(/later reviewer\/publication corrections were offline with no network calls/i.test(report));
assert(/not a byte-identical reproduction/i.test(report));
assert(handoff.includes(CAPTURE_SCANNER_SHA256));
assert(handoff.includes(currentScannerSha256));
assert(/offline\/no-network/i.test(handoff));
assert(/new network run would derive a new runId/i.test(handoff));

process.stdout.write(`PASS corrected EtherFi six-module offline validation (${manifest.records.length} records; ${manifest.aggregateSha256})\n`);
