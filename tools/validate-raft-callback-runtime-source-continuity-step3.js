#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const mode = process.argv[2];
if (process.argv.length !== 3 || !["--check-only", "--write-manifest"].includes(mode)) {
  console.error("usage: node tools/validate-raft-callback-runtime-source-continuity-step3.js --check-only|--write-manifest");
  process.exit(2);
}

const ROOT = path.resolve(__dirname, "..");
const CAPTURE = "reports/raw/fast/raft-callback-runtime-source-continuity-step3/capture.json";
const MANIFEST = "reports/raw/fast/raft-callback-runtime-source-continuity-step3/manifest.json";
const REPORT = "reports/raft-callback-runtime-source-continuity-step3.md";
const RUNNER = "tools/capture-raft-callback-runtime-source-continuity-step3.js";
const TESTER = "tools/test-raft-callback-runtime-source-continuity-step3.js";
const VALIDATOR = "tools/validate-raft-callback-runtime-source-continuity-step3.js";
const SOURCES = [
  "sources/raft-callback-runtime-source-continuity-step3/0x5f59b322eb3e16a0c78846195af1f588b77403fc/standard-input.json",
  "sources/raft-callback-runtime-source-continuity-step3/0x183015a9ba6ff60230fdeadc3f43b3d788b13e21/standard-input.json",
  "sources/raft-callback-runtime-source-continuity-step3/0xb69e35fb4a157028b92f42655090b984609ae598/standard-input.json",
  "sources/raft-callback-runtime-source-continuity-step3/0xa03342feb2e1d4690b60ef556509ec3b76c97ee7/standard-input.json",
  "sources/raft-callback-runtime-source-continuity-step3/0x9ab6b21cdf116f611110b048987e58894786c244/standard-input.json",
  "sources/raft-callback-runtime-source-continuity-step3/0xe899603576967180c7594bd5a1cad898a3e3daf3/standard-input.json"
];
const FILES = [CAPTURE, REPORT, RUNNER, TESTER, VALIDATOR, ...SOURCES];
const CLASSIFICATION = "CLOSED-CURRENT-CALLBACK-ROUTE/EXACT-RUNTIME-SOURCE-CONTINUITY/PLAIN-ERC20-ENABLED-SET";

let checks = 0;
function check(value, message) { checks += 1; if (!value) throw new Error(message); }
function read(relative) { return fs.readFileSync(path.join(ROOT, relative), "utf8"); }
function json(relative) { return JSON.parse(read(relative)); }
function sha256(relative) { return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, relative))).digest("hex"); }

function buildManifest() {
  const rows = FILES.map((file) => ({ path: file, sha256: sha256(file) }));
  const preimage = rows.map((row) => `${row.sha256}  ${row.path}`).join("\n") + "\n";
  return {
    schemaVersion: 1,
    findingId: "raft-callback-runtime-source-continuity-step3",
    pin: { chainId: 1, number: capture.pin.number, hash: capture.pin.hash, stateRoot: capture.pin.stateRoot },
    aggregatePreimageFormat: "<sha256><two spaces><path><LF>",
    aggregateSha256: crypto.createHash("sha256").update(preimage).digest("hex"),
    files: rows
  };
}

const capture = json(CAPTURE);
const report = read(REPORT);
const runner = read(RUNNER);
const tester = read(TESTER);

check(capture.classification === CLASSIFICATION, "capture classification mismatch");
check(report.includes(CLASSIFICATION), "report classification absent");
check(capture.pin.finalized === true && /^\d+$/.test(capture.pin.number), "finalized pin absent");
check(/^0x[0-9a-f]{64}$/.test(capture.pin.hash) && /^0x[0-9a-f]{64}$/.test(capture.pin.stateRoot), "pin commitment malformed");
check(capture.qualification.boundedCandidatesTested <= 128, "candidate bound exceeded");
check(capture.qualification.fullyQualifiedCandidates >= 2, "qualified family count too low");
check(capture.qualification.selectedFamilies.length >= 2, "selected family count too low");
check(capture.qualification.selectedDistinctOrigins === true && capture.qualification.operatorIndependenceClaim === false, "family qualification mismatch");
check(capture.qualification.selectionOrder.includes("no alphabetical preselection"), "selection ordering qualification absent");
check(capture.qualification.terminal.passed === true, "terminal recheck failed");
for (const row of capture.qualification.terminal.rows) {
  check(row.exact && row.number === capture.pin.number && row.hash === capture.pin.hash && row.stateRoot === capture.pin.stateRoot, "terminal tuple mismatch");
}

check(capture.events.completeThroughPin === true && capture.events.familyAgreement === true, "event continuity absent");
check(capture.events.rows.length === 5, "root admission count mismatch");
check(capture.events.enumerationSource.includes("two-family-block-hash-verification"), "event verification provenance absent");
const expectedEnabled = new Set([
  "0xb69e35fb4a157028b92f42655090b984609ae598",
  "0xa03342feb2e1d4690b60ef556509ec3b76c97ee7",
  "0x9ab6b21cdf116f611110b048987e58894786c244",
  "0xe899603576967180c7594bd5a1cad898a3e3daf3"
]);
check(capture.currentState.exactExpectedEnabledSet === true && capture.currentState.enabledCount === 4, "exact enabled state absent");
check(capture.currentState.enabled.every((address) => expectedEnabled.has(address.toLowerCase())), "unexpected enabled collateral");
for (const row of capture.currentState.collateral) {
  const event = capture.events.rows.find((entry) => entry.collateralToken.toLowerCase() === row.collateralToken.toLowerCase());
  check(Boolean(event), "current collateral lacks admission");
  check(event.collateralClaimToken.toLowerCase() === row.info.collateralClaimToken.toLowerCase(), "claim binding mismatch");
  check(event.debtToken.toLowerCase() === row.info.debtToken.toLowerCase(), "debt binding mismatch");
  check(event.priceFeed.toLowerCase() === row.info.priceFeed.toLowerCase(), "feed binding mismatch");
  check(row.info.splitLiquidation && row.accounting.collateralClaimTotal !== null && row.accounting.debtTotal !== null, "state/accounting binding incomplete");
}
check(capture.root.positionManager === "0x5F59b322eB3e16A0C78846195af1F588b77403FC", "root manager mismatch");
check(capture.root.rToken === "0x183015a9bA6fF60230fdEaDc3F43b3D788b13e21", "R mismatch");
check(capture.root.feeRecipientRuntime.proxy.singletonImplementation === "0x34CfAC646f301356fAa8B21e94227e3583Fe3F5F", "fee singleton resolution mismatch");

const continuity = capture.sourceContinuity.rows;
const required = continuity.filter((row) => row.required);
const collateral = continuity.filter((row) => row.role === "enabled-collateral");
check(required.length === 6 && required.every((row) => row.sourceResolved && row.exactRuntimeContinuity), "required source continuity incomplete");
check(capture.sourceContinuity.allRequiredExact === true && capture.sourceContinuity.allEnabledExactPlain === true, "continuity aggregate mismatch");
for (const row of required) {
  check(row.repository === "public-blockscout-verified", "verified-source provenance mismatch");
  check(row.config.compilerVersion === "0.8.19+commit.7dd6d404", "compiler mismatch");
  check(row.config.optimizerEnabled && row.config.optimizerRuns === 200000 && row.config.viaIR, "optimizer/viaIR mismatch");
  check(row.config.evmVersion === "london" && row.config.metadataBytecodeHash === "ipfs", "EVM/metadata mismatch");
  check(row.comparison.compiledLength === row.comparison.deployedLength, "runtime length mismatch");
  check(row.comparison.unmaskedDifferences === 0 && row.comparison.linkReferenceCount === 0, "runtime/link mismatch");
  check(row.comparison.metadataTailExact && row.comparison.exactAfterImmutableMask, "metadata/immutable comparison mismatch");
  check(SOURCES.includes(row.standardInput), "standard-input path not retained");
}
check(collateral.length === 4, "enabled collateral continuity count mismatch");
for (const row of collateral) {
  const transfer = row.ordinaryTransfer;
  check(transfer.classification === "PLAIN-ERC20-NO-ORDINARY-TRANSFER-RECIPIENT-CALLBACK", "ordinary transfer not plain ERC20");
  check(transfer.ordinaryTransferCallback === false, "ordinary callback present");
  check(!transfer.erc777Erc1820 && !transfer.erc223TokenFallback && !transfer.recipientCallbacks, "standard callback indicator present");
  check(!transfer.customLowLevelOrExternalCallsInOrdinaryPath && !transfer.hooksBeforeOrAfterBalanceMutationWithExternalCall, "custom callback path present");
}
const fee = continuity.find((row) => row.role === "fee-recipient");
check(fee && fee.required === false && fee.sourceResolved === true && fee.exactRuntimeContinuity === false, "fee source qualification mismatch");
check(capture.callbackGate.routeClosed === true, "callback route not closed");
check(capture.callbackGate.managerSafeTransferCanSynchronouslyReenterBeforeOuterIndexWrite === false, "manager reentry decision mismatch");
check(capture.callbackGate.feeRecipientCanChangeOrdinaryTransferSemantics === false, "fee semantics decision mismatch");
check(capture.gates.routePositive === false && capture.gates.executable === false && capture.gates.fork === false && capture.gates.signing === false, "execution gate open");
check(capture.gates.net === null && capture.gates.netNative === null && capture.gates.netUsd === null && capture.gates.attackerCapitalBps === null, "unreached economics non-null");
check(capture.gates.bounty === "unknown", "bounty gate mismatch");

for (const source of SOURCES) {
  const input = json(source);
  check(input.language === "Solidity", "standard input language mismatch");
  check(input.settings.optimizer.enabled === true && input.settings.optimizer.runs === 200000, "standard input optimizer mismatch");
  check(input.settings.viaIR === true && input.settings.evmVersion === "london", "standard input build settings mismatch");
  check(input.settings.metadata.bytecodeHash === "ipfs", "standard input metadata mismatch");
  check(Object.keys(input.sources).length >= 1 && Object.values(input.sources).every((row) => typeof row.content === "string" && row.content.length > 0), "standard input source absent");
}

for (const key of ["transactions", "stateOverrides", "traces", "signing", "forks", "secretReads", "rawEndpointUrlsStored", "endpointDomainsStored", "credentialsStored", "headersStored", "rawSecretResponsesStored", "envOrKeyFilesRead"]) {
  check(capture.purity[key] === 0, `purity counter nonzero: ${key}`);
}
check(capture.purity.endpointInventoryReads === 1 && capture.purity.endpointOnArgv === false && capture.purity.leakGuard === "PASS", "endpoint/privacy controls mismatch");
for (const text of [read(CAPTURE), report]) {
  check(!/https?:\/\//i.test(text), "URL persisted in sanitized artifact");
  check(!/[a-z0-9-]+\.(?:com|io|org|net|xyz|app|pro|dev)(?:[/:"\\]|$)/i.test(text), "domain persisted in sanitized artifact");
  check(!/Bearer\s/i.test(text), "header/token persisted");
}
check(runner.includes("urls.fill(\"\");") && runner.includes("leakGuard(output);"), "runner secret controls absent");
check(runner.includes("compareRuntime") && runner.includes("metadataTailExact") && runner.includes("unmaskedDifferences"), "runtime comparator absent");
check(tester.includes("ERC223 callback classified") && tester.includes("opt-in callback not confused with ordinary transfer"), "callback fixtures absent");
check(report.includes("No fork was authorized by the gate or performed"), "fork decision absent from report");
check(report.includes("zero differences outside compiler-declared immutable spans"), "runtime conclusion absent from report");

for (const file of FILES) {
  const text = read(file);
  check(text.endsWith("\n"), `missing final newline: ${file}`);
  check(!/[ \t]+$/m.test(text), `trailing whitespace: ${file}`);
}

if (mode === "--write-manifest") {
  const target = path.join(ROOT, MANIFEST);
  fs.writeFileSync(target, `${JSON.stringify(buildManifest(), null, 2)}\n`);
}

const manifest = json(MANIFEST);
check(manifest.aggregatePreimageFormat === "<sha256><two spaces><path><LF>", "manifest format mismatch");
check(manifest.files.length === FILES.length, "manifest file count mismatch");
for (const row of manifest.files) check(sha256(row.path) === row.sha256, `manifest hash mismatch: ${row.path}`);
const preimage = manifest.files.map((row) => `${row.sha256}  ${row.path}`).join("\n") + "\n";
check(crypto.createHash("sha256").update(preimage).digest("hex") === manifest.aggregateSha256, "manifest aggregate mismatch");

console.log(`PASS ${checks} Step3 validation checks; aggregate=${manifest.aggregateSha256}`);
