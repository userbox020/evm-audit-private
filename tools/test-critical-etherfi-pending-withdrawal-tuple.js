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
const RAW = "reports/raw/fast/critical-etherfi-pending-withdrawal-tuple.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-pending-withdrawal-tuple-manifest.json";
const REPORT = "reports/critical-etherfi-pending-withdrawal-tuple.md";
const INBOX = "coordination/inbox/critical/2026-07-21-critical-etherfi-pending-withdrawal-tuple.json";
const HANDOFF = "coordination/handoffs/2026-07-21-critical-etherfi-pending-withdrawal-tuple-handoff.md";
const SCANNER = "tools/scan-critical-etherfi-pending-withdrawal-tuple.js";
const STEP1 = "reports/raw/fast/critical-etherfi-pinbound-build-binding.json";
const REVISION = "pending-withdrawal-tuple-step2-r2-reviewer-corrected";
const abs = (x) => path.join(ROOT, x);
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
function walkFiles(dir, predicate, out = []) { if (!fs.existsSync(dir)) return out; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walkFiles(full, predicate, out); else if (predicate(full)) out.push(full); } return out; }
function sameAddress(a, b) { return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase()); }
function addressWord(address) { return Buffer.from(`${"0".repeat(24)}${String(address).replace(/^0x/i, "").toLowerCase()}`, "hex"); }
function eventMatchesState(event, state) { return sameAddress(event?.tuple?.asset, state.asset) && event?.tuple?.amount === state.amount && event?.tuple?.destEid === state.destEid && sameAddress(event?.tuple?.destRecipient, state.destRecipient) && (state.maxSlippageInBps == null || event?.tuple?.maxSlippageInBps === state.maxSlippageInBps); }

const rawText = fs.readFileSync(abs(RAW), "utf8");
const raw = JSON.parse(rawText);
const manifestText = fs.readFileSync(abs(MANIFEST), "utf8");
const manifest = JSON.parse(manifestText);
const report = fs.readFileSync(abs(REPORT), "utf8");
const inboxText = fs.readFileSync(abs(INBOX), "utf8");
const inbox = JSON.parse(inboxText);
const handoff = fs.readFileSync(abs(HANDOFF), "utf8");
const scanner = fs.readFileSync(abs(SCANNER), "utf8");
const step1 = JSON.parse(fs.readFileSync(abs(STEP1), "utf8"));

assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.classification, "exact-pending-tuple-equal");
assert.strictEqual(raw.pin.chainId, 10);
assert.strictEqual(raw.pin.blockNumber, 154534581);
assert.strictEqual(raw.pin.blockHash, "0x9e2d47b4f179b068df84fe73f11601cfa0af372d769902848222dc3a6e3c8b13");
assert.strictEqual(raw.pin.chainIdVerified, true);
assert.strictEqual(raw.pin.exactNumberHashVerified, true);
assert.strictEqual(raw.pin.terminalSameNumberHashVerified, true);
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
for (const key of ["withdrawalExecutionAttempted", "ethSendMethodsUsed", "signingUsed", "impersonationUsed", "stateMutation", "forkTransaction", "fundsUsed"]) assert.strictEqual(raw.safety[key], false, key);
assert(raw.transcript.every((x) => !/^eth_send/i.test(x.method)));

assert.strictEqual(raw.semanticInventory.qualifyingSafeKeyedModules.length, 4);
assert.strictEqual(raw.semanticInventory.nonQualifyingScopedModules.length, 2);
assert.strictEqual(raw.semanticInventory.cashGetData.key, "safe");
assert(raw.semanticInventory.nonQualifyingScopedModules.some((x) => x.name === "EtherFiStakeModule"));
assert(raw.semanticInventory.nonQualifyingScopedModules.some((x) => x.name === "LiquidUSDLiquifierModule"));
assert(Object.values(raw.defaultFlags).every((x) => x === true));

assert.strictEqual(raw.searchCoverage.retainedWindowComplete, true);
assert.strictEqual(raw.searchCoverage.retainedWindowStartBlock, 154529180);
assert.strictEqual(raw.searchCoverage.retainedWindowEndBlock, raw.pin.blockNumber);
assert.strictEqual(raw.searchCoverage.fullModuleHistoryCovered, false);
assert.strictEqual(raw.searchCoverage.selectedEvidenceComplete, true);
assert.strictEqual(raw.searchCoverage.selectedLatestRequestEventVerified, true);
assert.strictEqual(raw.searchCoverage.selectedEventBlockVerified, true);
assert.strictEqual(raw.searchCoverage.discoveryMethod, "multi-provider-consensus per-module exact-event retained-window queries joined to exact-pin module and Cash state");
assert(raw.searchCoverage.retainedLogConsensusCount >= 2);
assert.strictEqual(raw.providerCoverage.acceptance.retainedLogConsensus, true);
assert.strictEqual(raw.providerCoverage.retainedLogConsensusCount, raw.searchCoverage.retainedLogConsensusCount);
assert.strictEqual(Object.keys(raw.searchCoverage.moduleCoverage).length, 4);
assert(Object.values(raw.searchCoverage.moduleCoverage).every((x) => x.complete && x.startsAtRetainedWindow && x.endsAtPin));
assert(!Object.prototype.hasOwnProperty.call(raw.searchCoverage, "complete"));
assert(!Object.prototype.hasOwnProperty.call(raw.searchCoverage, "searchCoverageComplete"));
assert(raw.searchCoverage.parsedLogCount > 0);

const deployed = raw.deployedSemanticsBinding;
assert.strictEqual(deployed.exact, true);
assert.strictEqual(deployed.stargate.address, "0xee77DEB6991f5d5CcAE5a327debA32d292E85c1c");
assert.strictEqual(deployed.stargate.structure, "direct-deployment-no-eip1967-slots");
for (const slot of Object.values(deployed.stargate.eip1967Slots)) { assert.strictEqual(slot.readOk, true); assert.strictEqual(slot.zero, true); assert.strictEqual(slot.address, null); }
const runtime = deployed.stargate.runtimeComparison;
assert.strictEqual(runtime.exactReconstructedRuntimeEqual, true);
assert.strictEqual(runtime.allImmutableRowsIndependentlyBound, true);
assert.strictEqual(runtime.allImmutableActualValuesMatch, true);
assert(runtime.immutableAstRowCount > 0);
assert(runtime.immutableRows.every((x) => x.independentlyBound && x.actualMatch && x.expectedValueSource === "getter" && x.getterObservedValue));
assert(Object.values(deployed.stargate.getterBindings).every((x) => x.source === "getter" && x.getterMatched));
assert.strictEqual(deployed.guardSemantics.stargateExecuteBridge.equalityGuardPresent, true);
assert.strictEqual(deployed.guardSemantics.stargateExecuteBridge.cashProcessCalledAfterEqualityGuard, true);
assert.strictEqual(deployed.guardSemantics.cashProcessWithdrawal.finalizeTimeGuardPresent, true);
assert.strictEqual(deployed.guardSemantics.cashProcessWithdrawal.guardBeforeTransfers, true);
assert.strictEqual(deployed.guardSemantics.cashProcessWithdrawal.step1CashRuntimeExact, true);
assert.strictEqual(deployed.guardSemantics.buildLinkage.sourceCommitMatch, true);
assert.strictEqual(deployed.guardSemantics.buildLinkage.standardJsonInputMatchesStep1, true);
const cashStep1 = step1.componentResults.find((x) => x.name === "CashModuleCore");
assert(cashStep1.proxyComparison.exactRuntimeEqual && cashStep1.implementationComparison.exactReconstructedEqual);

const selected = raw.selected;
assert(selected);
assert.strictEqual(selected.module, "StargateModule");
assert.strictEqual(selected.modulePending, true);
assert.strictEqual(selected.cashPending, true);
assert.strictEqual(selected.latestRequestMatchesState, true);
assert.strictEqual(selected.laterNonmatchingEventExists, false);
assert(selected.latestRequestEvent);
assert(!Object.prototype.hasOwnProperty.call(selected, "matchingRequestEvent"));
assert.strictEqual(selected.observationBinding.blockNumber, raw.pin.blockNumber);
assert.strictEqual(selected.observationBinding.blockHash, raw.pin.blockHash);
const pairEvents = raw.requestLogs.filter((x) => x.module === selected.module && sameAddress(x.safe, selected.safe)).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
assert.strictEqual(pairEvents.length, selected.pairRequestEventCount);
const latest = pairEvents[pairEvents.length - 1];
assert.strictEqual(latest.transactionHash, selected.latestRequestEvent.transactionHash);
assert.strictEqual(latest.logIndex, selected.latestRequestEvent.logIndex);
assert.strictEqual(eventMatchesState(latest, selected.moduleState), true);
assert.strictEqual(selected.lastMatchingEvent.transactionHash, latest.transactionHash);
const recomputed = { cashHasOneToken: selected.cashState.tokens.length === 1 && selected.cashState.amounts.length === 1, recipientIsModule: sameAddress(selected.cashState.recipient, selected.moduleAddress), assetEqual: selected.cashState.tokens.length === 1 && sameAddress(selected.cashState.tokens[0], selected.moduleState.asset), amountEqual: selected.cashState.amounts.length === 1 && selected.cashState.amounts[0] === selected.moduleState.amount };
assert.deepStrictEqual(recomputed, selected.comparison.checks);
assert.strictEqual(selected.comparison.equal, true);
assert.strictEqual(selected.comparison.keying.moduleRecordKey, "safe");
assert.strictEqual(selected.comparison.keying.cashPendingWithdrawalKey, "safe");
assert.strictEqual(selected.comparison.keying.requestIdentifier, null);
assert(selected.comparison.keying.requestIdentifierCaveat.startsWith("These four scoped module records"));
assert(raw.implications.validSignatureIsolation.startsWith("Unproven"));

assert.strictEqual(raw.r1Predecessor.revision, "pending-withdrawal-tuple-step2-r1");
assert.strictEqual(raw.r1Predecessor.runId, "etherfi-pending-withdrawal-tuple-154534581-9e2d47b4f179-7f6b3d09d70e");
assert.strictEqual(raw.r1Predecessor.preservationMode, "summary-provenance-and-package-hashes-only");
assert.strictEqual(raw.r1Predecessor.originalFilesManifestBoundInR2, false);
assert.strictEqual(raw.r1Predecessor.packageHashes.manifestAggregateSha256, "1d6cd10df07b0c1b577d6ca11a9203cb5787f368bdfe3644f917a605ccee2a31");
for (const value of Object.values(raw.r1Predecessor.packageHashes).filter((x) => typeof x === "string")) assert(/^[0-9a-f]{64}$/.test(value));

const stargateSource = fs.readFileSync(path.join(TARGET, "src", "modules", "stargate", "StargateModule.sol"), "utf8");
const cashSource = fs.readFileSync(path.join(TARGET, "src", "modules", "cash", "CashModuleStorageContract.sol"), "utf8");
assert(stargateSource.includes("withdrawalRequest.recipient != address(this) || withdrawalRequest.tokens.length != 1 || withdrawalRequest.tokens[0] != withdrawal.asset || withdrawalRequest.amounts[0] != withdrawal.amount"));
assert(stargateSource.indexOf("cashModule.processWithdrawal(safe)") > stargateSource.indexOf("withdrawalRequest.recipient != address(this)"));
assert(cashSource.includes("pendingWithdrawalRequest.finalizeTime > block.timestamp"));
assert(cashSource.indexOf("execTransactionFromModule", cashSource.indexOf("pendingWithdrawalRequest.finalizeTime > block.timestamp")) > cashSource.indexOf("pendingWithdrawalRequest.finalizeTime > block.timestamp"));

const tempRoot = path.join(os.tmpdir(), "opencode", "etherfi-pending-withdrawal-step2-r2-offline-test");
const outDir = path.join(tempRoot, "out");
const cacheDir = path.join(tempRoot, "cache");
const infoDir = path.join(tempRoot, "build-info");
try {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  const run = spawnSync("forge", ["build", "--root", TARGET, "--out", outDir, "--cache-path", cacheDir, "--build-info", "--build-info-path", infoDir, "--no-cache", "--offline"], { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(run.status, 0, "offline build failed");
  const infoFiles = walkFiles(infoDir, (x) => x.endsWith(".json"));
  assert.strictEqual(infoFiles.length, 1);
  const buildInfo = JSON.parse(fs.readFileSync(infoFiles[0], "utf8"));
  assert.strictEqual(hash(canonical(buildInfo.input)), raw.build.standardJsonInputSha256);
  assert.strictEqual(hash(canonical(buildInfo.input)), step1.build.standardJsonInputSha256);
  assert.strictEqual(Object.keys(buildInfo.input.sources || {}).length, raw.build.sourceCount);
  const specs = { EtherFiLiquidModule: ["EtherFiLiquidModule.sol", "EtherFiLiquidModule.json"], EtherFiLiquidModuleWithReferrer: ["EtherFiLiquidModuleWithReferrer.sol", "EtherFiLiquidModuleWithReferrer.json"], FraxModule: ["FraxModule.sol", "FraxModule.json"], StargateModule: ["StargateModule.sol", "StargateModule.json"], EtherFiStakeModule: ["EtherFiStakeModule.sol", "EtherFiStakeModule.json"], LiquidUSDLiquifierModule: ["LiquidUSDLiquifierOP.sol", "LiquidUSDLiquifierOPModule.json"], CashModuleCore: ["CashModuleCore.sol", "CashModuleCore.json"], EtherFiDataProvider: ["EtherFiDataProvider.sol", "EtherFiDataProvider.json"] };
  for (const [name, [dir, file]] of Object.entries(specs)) { const artifact = JSON.parse(fs.readFileSync(path.join(outDir, dir, file), "utf8")); assert.strictEqual(hash(canonical(artifact.abi)), raw.build.abiEvidence[name].abiSha256, `ABI ${name}`); }
  const stargateArtifact = JSON.parse(fs.readFileSync(path.join(outDir, "StargateModule.sol", "StargateModule.json"), "utf8"));
  const reconstructed = Buffer.from(stargateArtifact.deployedBytecode.object.replace(/^0x/i, ""), "hex");
  for (const row of runtime.immutableRows) for (const position of row.positions) addressWord(row.expectedValue).copy(reconstructed, position.start);
  const observedRuntime = Buffer.from(deployed.stargate.deployedRuntime.replace(/^0x/i, ""), "hex");
  assert(reconstructed.equals(observedRuntime));
  assert.strictEqual(hash(reconstructed), runtime.reconstructedRuntimeSha256);
  assert.strictEqual(hash(observedRuntime), runtime.deployedRuntimeSha256);
} finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }

assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.classification, raw.classification);
assert.strictEqual(manifest.retainedWindowComplete, true);
assert.strictEqual(manifest.fullModuleHistoryCovered, false);
assert.strictEqual(manifest.selectedEvidenceComplete, true);
assert.strictEqual(manifest.deployedSemanticsExact, true);
assert.strictEqual(manifest.latestRetainedWindowRequestEventVerified, true);
assert(!Object.prototype.hasOwnProperty.call(manifest, "searchCoverageComplete"));
assert.deepStrictEqual(manifest.r1Predecessor, raw.r1Predecessor);
for (const rec of manifest.records) { const data = fs.readFileSync(abs(rec.path)); assert.strictEqual(data.length, rec.bytes, `bytes ${rec.path}`); assert.strictEqual(hash(data), rec.sha256, `hash ${rec.path}`); }
const aggregate = hash(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
assert.strictEqual(aggregate, manifest.aggregateSha256);
const scannerRecord = manifest.records.find((x) => x.path === SCANNER);
assert(scannerRecord);
assert.strictEqual(scannerRecord.sha256, raw.captureProvenance.scannerSha256);

const leak = [rawText, manifestText, report, inboxText, handoff, scanner].join("\n");
assert(!/https?:\/\/[a-z0-9]/i.test(leak), "URL leak");
assert(!/[?&](?:key|token|api_key|apikey)=/i.test(leak), "credential leak");
assert(!/(authorization|cookie|set-cookie)\s*[:=]/i.test(leak), "header leak");
assert(report.includes("Step 2 r2 reviewer-corrected"));
assert(report.includes("Deployed guard binding"));
assert(report.includes("Retained-window completeness: `true`; full-module-history coverage: `false`"));
assert(report.includes("The four qualifying source surfaces are keyed only by `safe`; there is no separate request ID."));
assert(report.includes("valid-signature"));
assert(report.includes("nextReadOnlyStep"));
assert(handoff.includes(raw.runId));
assert(handoff.includes("full module history covered: `false`"));
process.stdout.write(`PASS EtherFi pending-withdrawal Step 2 r2 (${raw.classification}; selected=${Boolean(raw.selected)}; ${manifest.records.length} records; ${manifest.aggregateSha256})\n`);
