#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-debt-manager-share-deployment-binding";
const RAW = `reports/raw/fast/${NAME}.json`;
const EVIDENCE = `reports/raw/fast/${NAME}-evidence.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const SCANNER = `tools/scan-${NAME}.js`;
const REVISION = "debt-manager-share-deployment-binding-readonly-r1";
const CLASSIFICATIONS = new Set(["DEPLOYMENT-RELEVANT-CANDIDATE", "DORMANT/CONDITION-ABSENT", "COVERAGE-BLOCKED"]);
const ALLOWED = ["eth_call", "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs", "eth_getStorageAt"];
const abs = (x) => path.join(ROOT, x);
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");

const rawText = fs.readFileSync(abs(RAW), "utf8");
const evidenceText = fs.readFileSync(abs(EVIDENCE), "utf8");
const manifestText = fs.readFileSync(abs(MANIFEST), "utf8");
const report = fs.readFileSync(abs(REPORT), "utf8");
const inboxText = fs.readFileSync(abs(INBOX), "utf8");
const handoff = fs.readFileSync(abs(HANDOFF), "utf8");
const scanner = fs.readFileSync(abs(SCANNER), "utf8");
const raw = JSON.parse(rawText);
const evidence = JSON.parse(evidenceText);
const manifest = JSON.parse(manifestText);
const inbox = JSON.parse(inboxText);

assert.strictEqual(raw.revision, REVISION);
assert(CLASSIFICATIONS.has(raw.classification));
assert.strictEqual(raw.pipeline, "1/5");
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
assert.strictEqual(raw.safety.readOnlyRpcAuthorizedCurrentTurn, true);
assert.strictEqual(raw.safety.rpcUsed, true);
assert.strictEqual(raw.safety.endpointInventoryRead, true);
assert.strictEqual(raw.safety.endpointMaterialPersisted, false);
assert.strictEqual(raw.safety.rawRpcPersisted, false);
assert.strictEqual(raw.safety.envFilesRead, false);
assert.strictEqual(raw.safety.privateKeysRead, false);
assert.strictEqual(raw.safety.ethCallMutationSelectorsUsed, false);
assert.strictEqual(raw.safety.signedTransactions, false);
assert.strictEqual(raw.safety.broadcast, false);
assert.strictEqual(raw.safety.liveMutation, false);
assert.strictEqual(raw.safety.fundMovement, false);
assert.strictEqual(raw.safety.forkCreated, false);
assert.strictEqual(raw.safety.economicsAttempted, false);

assert.strictEqual(raw.pin.chainId, 10);
assert(Number.isInteger(raw.pin.number) && raw.pin.number > 0);
assert(/^0x[0-9a-f]{64}$/.test(raw.pin.hash));
assert.strictEqual(raw.pin.finalizedSelected, true);
assert.strictEqual(raw.pin.terminalSameNumberRecheck, true);
assert.strictEqual(raw.authoritativeLocalDeployment.proxy.toLowerCase(), raw.deploymentBinding.proxy.toLowerCase());
assert.strictEqual(raw.authoritativeLocalDeployment.chainId, 10);
assert.strictEqual(raw.deploymentBinding.exactLocalRuntime.sourceCommit, "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8");
assert.strictEqual(raw.configAndAccess.directSupplySignature, "supply(address user,address borrowToken,uint256 amount)");
assert.strictEqual(raw.configAndAccess.callerMinimumSharesOutParameter, false);
assert.strictEqual(raw.configAndAccess.zeroSharesRejected, false);
assert.strictEqual(raw.conditions.contractLevelMinimumSharesOutProtection, false);
assert.strictEqual(raw.conditions.contractLevelNonzeroMintProtection, false);
assert.strictEqual(raw.conditions.practicalProfitabilityEvaluated, false);
assert(raw.assets.length === raw.configAndAccess.borrowTokenCount);

for (const asset of raw.assets) {
  assert(/^0x[0-9a-fA-F]{40}$/.test(asset.address));
  assert(Number.isInteger(asset.decimals));
  assert.strictEqual(asset.erc20ViewsBound, true);
  assert.strictEqual(asset.transferFeeSemantics, "UNKNOWN_READ_ONLY");
  assert.strictEqual(asset.rebaseSemantics, "UNKNOWN_READ_ONLY");
  if (raw.classification !== "COVERAGE-BLOCKED") {
    assert.strictEqual(asset.enumeratedSharesRaw, asset.totalSharesRaw, `${asset.name}:share sum`);
    assert.strictEqual(asset.concentrationComplete, true, `${asset.name}:concentration`);
  }
  const A = BigInt(asset.totalAssetsRaw);
  const S = BigInt(asset.totalSharesRaw);
  for (const row of asset.thresholds) {
    const v = BigInt(row.victimAmountRaw);
    const expected = S === 0n ? 0n : (v * S < A ? 0n : v * S - A + 1n);
    assert.strictEqual(row.additionalDonationRaw, expected.toString(), `${asset.name}:${row.label}`);
  }
  if (S !== 0n && A !== 0n) assert.strictEqual(asset.noDonationMaxZeroShareVictimRaw, ((A - 1n) / S).toString());
}

assert.strictEqual(evidence.rawEndpointInventoryPersisted, false);
assert.strictEqual(evidence.rawRpcResponsesPersisted, false);
assert.strictEqual(evidence.endpointsOrDomainsPersisted, false);
assert(evidence.providerSelection.selectedProviderCount >= 2);
assert.strictEqual(evidence.providerSelection.selectedProviderCount, evidence.providerSelection.distinctAnonymousFamilyCount);
assert.strictEqual(evidence.pin.hash, raw.pin.hash);
assert.strictEqual(evidence.pin.terminalSameNumberRecheck, true);
assert.deepStrictEqual(evidence.budgets.allowedMethods, ALLOWED);
assert(evidence.budgets.actualTotal <= evidence.budgets.globalMaximum);
assert(evidence.providerRows.every((x) => x.terminalSameNumberHashMatch && x.selectedPinHashMatch));
assert(evidence.providerRows.every((x) => !Object.keys(x).some((k) => /url|domain|host|origin/i.test(k))));

if (raw.classification !== "COVERAGE-BLOCKED") {
  assert.strictEqual(raw.deploymentBinding.exactLocalRuntime.exact, true);
  assert.strictEqual(raw.supplierConcentration.deploymentToPinHistoryComplete, true);
  assert.strictEqual(raw.supplierConcentration.allCurrentAssetShareSumsExact, true);
  assert.strictEqual(raw.configAndAccess.authoritativeConfigBorrowTokensMatched, true);
}
if (raw.classification === "DEPLOYMENT-RELEVANT-CANDIDATE") {
  assert.strictEqual(raw.conditions.unpaused, true);
  assert.strictEqual(raw.conditions.anySoleOrHighConcentrationAsset, true);
}
if (raw.classification === "DORMANT/CONDITION-ABSENT") assert.strictEqual(raw.conditions.anySoleOrHighConcentrationAsset, false);

assert.strictEqual(raw.tests.passed, 4);
assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(manifest.classification, raw.classification);
assert.strictEqual(manifest.pipeline, "1/5");
assert.strictEqual(manifest.routePositive, 0);
assert.strictEqual(manifest.executableNow, 0);
assert.strictEqual(manifest.signedActionJustified, false);
assert.strictEqual(manifest.fork, false);
assert.deepStrictEqual(manifest.allowedRpcMethods, ALLOWED);
assert.strictEqual(manifest.endpointMaterialPersisted, false);
assert.strictEqual(manifest.rawRpcPersisted, false);
assert.strictEqual(manifest.pin.hash, raw.pin.hash);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(inbox.classification, raw.classification);

for (const rec of manifest.records) {
  const data = fs.readFileSync(abs(rec.path));
  assert.strictEqual(data.length, rec.bytes, `bytes:${rec.path}`);
  assert.strictEqual(sha(data), rec.sha256, `hash:${rec.path}`);
}
assert.strictEqual(sha(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")), manifest.aggregateSha256);

const outputs = [rawText, evidenceText, manifestText, report, inboxText, handoff].join("\n");
assert(!/https?:\/\//i.test(outputs), "URL leak");
assert(!/[?&](?:key|token|api_key|apikey)=/i.test(outputs), "credential leak");
assert(!/(authorization|cookie|set-cookie)\s*[:=]/i.test(outputs), "header leak");
assert(!/eth_send|eth_sign|personal_|wallet_|sendTransaction/i.test(JSON.stringify(evidence.budgets.allowedMethods)), "unsafe RPC method");
assert(scanner.includes("ALLOWED_RPC"));
assert(scanner.includes("rawRpcResponsesPersisted: false"));
assert(!/rpc_endpoints\.txt[^\n]*(?:console|write)/i.test(scanner));
assert(report.includes(raw.classification));
assert(report.includes("Pipeline:** `1/5`"));
assert(report.includes("nextGate"));
assert(handoff.includes(raw.runId));

process.stdout.write(`PASS EtherFi DebtManager deployment binding (${raw.runId}; ${raw.classification}; pin=${raw.pin.number}; providers=${manifest.providerCount}; assets=${raw.assets.length}; records=${manifest.records.length}; ${manifest.aggregateSha256})\n`);
