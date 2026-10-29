#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-across-hyperevm-fallback-sponsorship-step1";
const RAW = `reports/raw/fast/${NAME}.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const LEAK = `reports/raw/fast/${NAME}-leak-scan.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const SOL_TEST = "targets/across-contracts/test/evm/foundry/local/HyperCoreFallbackSponsorshipInvariant.t.sol";
const abs = (rel) => path.join(ROOT, rel);
const json = (rel) => JSON.parse(fs.readFileSync(abs(rel), "utf8"));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };

function assert(ok, label, checks) { checks.push({ label, passed: !!ok }); if (!ok) throw new Error(label); }

function main() {
  for (const rel of [RAW, TESTS, LEAK, MANIFEST, REPORT, INBOX, HANDOFF, SCANNER, VALIDATOR, SOL_TEST]) if (!fs.existsSync(abs(rel))) throw new Error(`missing:${rel}`);
  const raw = json(RAW), tests = json(TESTS), leak = json(LEAK), manifest = json(MANIFEST), inbox = json(INBOX), checks = [];
  assert(raw.binding.chainId === 999, "chain999", checks);
  assert(raw.binding.pin.finalizedSelected && raw.binding.pin.terminalRecheckPassed, "pin-finalized-terminal", checks);
  assert(/^0x[0-9a-f]{64}$/.test(raw.binding.pin.hash), "pin-hash", checks);
  assert(raw.binding.strictQualifiedFamilyCount >= 2, "strict-family-threshold", checks);
  assert(raw.binding.bindingAgreement, "binding-agreement", checks);
  assert(raw.binding.allSourceRuntimeEquivalent === false, "qualified-source-runtime-gap", checks);
  assert(raw.binding.allDirectDeployments, "direct-deployments", checks);
  assert(raw.binding.allDonationWithdrawerRolesActive, "withdrawer-roles", checks);
  assert(raw.binding.pauseSurfaceAbsent, "pause-surface-absent", checks);
  assert(raw.binding.directPermissionlessModuleEntrypointRejected, "direct-module-call-rejected", checks);
  assert(raw.binding.deployments.length === 3, "three-active-handler-bindings", checks);
  assert(raw.binding.deployments.every((row) => row.moduleSourceRuntimeEquivalent && row.donationSourceRuntimeEquivalent), "module-donation-source-runtime-equivalence", checks);
  assert(raw.binding.deployments.find((row) => row.id === "oft-usdt").handlerSourceRuntimeEquivalent, "oft-handler-source-runtime-equivalence", checks);
  assert(raw.binding.deployments.filter((row) => row.id.startsWith("cctp")).every((row) => !row.handlerSourceRuntimeEquivalent), "cctp-handler-source-gap-explicit", checks);
  assert(new Set(raw.binding.deployments.filter((row) => row.id.startsWith("cctp")).map((row) => row.handlerNormalizedRuntimeSha256)).size === 1, "cctp-handler-runtime-family-agreement", checks);
  assert(raw.binding.deployments.every((row) => row.moduleGetterMatchesArtifact && row.donationBoxGetterMatchesArtifact), "immutable-config-binding", checks);
  assert(raw.binding.historyFamilyCount >= 2, "history-family-threshold", checks);
  assert(raw.binding.history.allFallbackDonationTransfersExact, "fallback-donation-history-conservation", checks);
  assert(raw.binding.history.allFallbackRecipientTransfersExact, "fallback-recipient-history-conservation", checks);
  assert(raw.binding.history.receiptsChecked === raw.binding.history.fallbackEventCount, "all-fallback-receipts-checked", checks);
  assert(tests.passed && tests.fixedAndFuzzFunctions === 17, "solidity-tests-pass", checks);
  assert(tests.fuzzFunctions === 3 && tests.fuzzExecutions >= 768, "fuzz-count", checks);
  assert(raw.invariant.sharedFundSubsidyConditionalPrimitive, "conditional-under-delivery-primitive", checks);
  assert(raw.invariant.attackerValueDeltaCurrent === "0", "current-attacker-delta-zero", checks);
  assert(raw.pipeline.stage === 1 && raw.pipeline.callbackReachabilitySurvives === false && raw.pipeline.cctpCallbackReachabilityExact === null, "pipeline-fail-closed", checks);
  assert(raw.forkDecision.executed === false && raw.forkDecision.stopFailClosed, "fork-not-run", checks);
  assert(raw.routePositive === 0 && raw.executableNow === 0 && raw.signedActionJustified === false, "global-gates-closed", checks);
  assert(raw.safety.signedTransactions === false && raw.safety.broadcasts === false && raw.safety.productionMutation === false && raw.safety.privateKeyReads === false, "safety", checks);
  assert(leak.passed && leak.findingCount === 0, "leak-scan", checks);
  assert(inbox.runId === raw.runId && inbox.routePositive === 0 && inbox.fork === false, "inbox-binding", checks);
  const records = manifest.records.map((row) => { const actual = hashFile(row.path); assert(actual.bytes === row.bytes && actual.sha256 === row.sha256, `record:${row.path}`, checks); return actual; });
  const aggregate = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  assert(aggregate === manifest.aggregateSha256, "manifest-aggregate", checks);
  process.stdout.write(JSON.stringify({ ok: true, checksPassed: checks.filter((x) => x.passed).length, checksTotal: checks.length, runId: raw.runId, classification: raw.classification, aggregateSha256: aggregate, tests }) + "\n");
}

try { main(); } catch (error) { process.stderr.write(JSON.stringify({ ok: false, category: String(error.message || error) }) + "\n"); process.exit(1); }
