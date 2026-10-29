#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_REL = "reports/raw/fast/critical-derive-v2-cash-pnl-deployment-economics-step2-manifest.json";
const RAW_REL = "reports/raw/fast/critical-derive-v2-cash-pnl-deployment-economics-step2.json";
const REPORT_REL = "reports/critical-derive-v2-cash-pnl-deployment-economics-step2.md";
const INBOX_REL = "coordination/inbox/critical/20260728-critical-derive-v2-cash-pnl-deployment-economics-step2.json";
const HANDOFF_REL = "coordination/handoffs/20260728-critical-derive-v2-cash-pnl-deployment-economics-step2-handoff.md";
const BACKLOG_MD = "reports/rpc-blocked-backlog.md";
const BACKLOG_JSON = "reports/raw/fast/rpc-blocked-backlog.json";
const ALGORITHM =
  "sha256(UTF-8 JSON.stringify(records sorted ascending by unsigned ordinal UTF-8 bytes of POSIX path; record key order path,sha256,bytes; no extra whitespace))";
const CLASSIFICATION = "SOURCE-PROVEN/DEPLOYMENT-COVERAGE-BLOCKED/LEGACY-PARSER/STRICT-QUALIFICATION-UNVERIFIED/NO-CURRENT-STATE-OR-ECONOMICS-BINDING";
const EXPECTED_PATHS = [
  "reports/critical-derive-v2-cash-pnl-deployment-economics-step2.md",
  "reports/raw/fast/critical-derive-v2-cash-pnl-deployment-economics-step2-tests.txt",
  "reports/raw/fast/critical-derive-v2-cash-pnl-deployment-economics-step2.json",
  "tools/generate-critical-derive-v2-step2-manifest.js",
  "tools/run-critical-derive-v2-step2.js",
  "tools/test-critical-derive-v2-step2.js",
  "tools/validate-critical-derive-v2-step2.js",
];
const PACKAGE_PATHS = [...EXPECTED_PATHS, INBOX_REL, HANDOFF_REL, BACKLOG_MD, BACKLOG_JSON];

let checks = 0;
function check(value, message) {
  checks += 1;
  if (!value) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function comparePaths(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, ...rel.split("/")));
}

function genericLeakCheck(rel, text) {
  check(!/https?:\/\/|wss?:\/\//i.test(text), `URL leak: ${rel}`);
  check(!/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/i.test(text), `credential leak: ${rel}`);
  check(!/"(?:endpointUrl|rpcUrl|hostname|domain|provider|headers|credentials)"\s*:/i.test(text), `identity field leak: ${rel}`);
}

const manifestBytes = read(MANIFEST_REL);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
check(manifest.aggregateAlgorithm === ALGORITHM, "aggregate algorithm mismatch");
check(manifest.pathComparator === "ascending unsigned ordinal comparison of UTF-8 encoded normalized relative POSIX path bytes using Node.js Buffer.compare", "path comparator mismatch");
check(manifest.recordCount === EXPECTED_PATHS.length && manifest.records.length === EXPECTED_PATHS.length, "record count mismatch");
const expected = [...EXPECTED_PATHS].sort(comparePaths);
check(JSON.stringify(manifest.records.map((entry) => entry.path)) === JSON.stringify(expected), "record ordering mismatch");
const seen = new Set();
for (const record of manifest.records) {
  check(Object.keys(record).join(",") === "path,sha256,bytes", `record key order: ${record.path}`);
  check(typeof record.path === "string" && record.path.length > 0 && !record.path.includes("\\"), `POSIX path: ${record.path}`);
  check(!path.posix.isAbsolute(record.path) && path.posix.normalize(record.path) === record.path && !record.path.startsWith("../"), `normalized path: ${record.path}`);
  check(!seen.has(record.path), `duplicate path: ${record.path}`);
  seen.add(record.path);
  check(/^[0-9a-f]{64}$/.test(record.sha256), `record hash format: ${record.path}`);
  check(Number.isSafeInteger(record.bytes) && record.bytes >= 0, `record bytes format: ${record.path}`);
  const bytes = read(record.path);
  check(bytes.length === record.bytes, `record byte count mismatch: ${record.path}`);
  check(sha256(bytes) === record.sha256, `record hash mismatch: ${record.path}`);
}
const aggregateSha256 = sha256(Buffer.from(JSON.stringify(manifest.records), "utf8"));
check(aggregateSha256 === manifest.aggregateSha256, "aggregate hash mismatch");
const manifestSha256 = sha256(manifestBytes);

const rawText = read(RAW_REL).toString("utf8");
const raw = JSON.parse(rawText);
check(raw.schemaVersion === 2, "raw schema");
check(raw.classification === CLASSIFICATION, "raw classification");
check(raw.status === "LEGACY_NO_TARGET_CHAIN_ID_MATCH_STRICT_UNVERIFIED", "raw status");
check(raw.qualification.inventoryEmpty === false, "inventory nonempty");
check(raw.qualification.candidatesParsed === 264 && raw.qualification.candidatesProbed === 264, "candidate/probe counts");
check(raw.qualification.probesReserved === 264 && raw.qualification.probesDispatched === 264, "probe reservation/dispatch");
check(raw.qualification.rpcFailures === 122, "RPC failure count");
check(Object.values(raw.qualification.failureCounts).reduce((sum, value) => sum + value, 0) === 122, "failure-class sum");
check(raw.qualification.legacyBigIntCoercibleSuccessfulNonTargetResults === 142, "legacy-coercible success count");
check(raw.qualification.canonicalSuccessfulChainIds === null && raw.qualification.malformedOrNullChainIdsRejected === null, "strict counts unverified");
check(raw.qualification.rpcFailures + raw.qualification.legacyBigIntCoercibleSuccessfulNonTargetResults === 264, "legacy outcome conservation");
check(raw.qualification.targetChainIdMatchesUnderLegacyParser === 0 && raw.qualification.chain957MatchesUnderLegacyParser === 0 && raw.qualification.chain901MatchesUnderLegacyParser === 0, "legacy target match count");
check(raw.qualification.strictQualificationVerified === false, "strict qualification unverified");
check(raw.qualification.finalityAttempted === false, "finality not attempted");
check(raw.offlineR2.inventoryReread === false && raw.offlineR2.rpcCalls === 0 && raw.offlineR2.captureNetworkReexecuted === false, "offline R2 purity");
check(raw.authorizationProvenance.scopeId === "derive-v2-step2-readonly-scope-20260728", "authorization scope ID");
check(JSON.stringify(raw.authorizationProvenance.authorizedInventoryFilenames) === JSON.stringify(["rpc_endpoints.txt", "graphql_endpoints.txt"]), "authorized filenames");
check(JSON.stringify(raw.authorizationProvenance.methodsDispatchedInRetainedCapture) === JSON.stringify(["eth_chainId"]), "retained method scope");
check(JSON.stringify(raw.authorizationProvenance.hardenedRunnerAllowedMethods) === JSON.stringify(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_estimateGas", "eth_getLogs", "eth_gasPrice"]), "hardened read-only method scope");
check(raw.captureSafety.publishedOpaqueIdentityCount === 0, "no published identities");

check(raw.gates.inventoryNonEmptyLiteralTrue === true && raw.gates.strictQualificationCompletedLiteralTrue === false, "qualification gates");
const postQualificationGateNames = [
  "targetChainIdMatchedLiteralTrue",
  "finalityAttemptedLiteralTrue",
  "finalizedPinLiteralTrue",
  "terminalExactHeaderLiteralTrue",
  "allSelectedFamilyReadsSucceededLiteralTrue",
  "allSelectedFamilyStateAgreementLiteralTrue",
  "allRequiredNormalizedRuntimeMatchLiteralTrue",
  "economicsBindingLiteralTrue",
  "beneficiaryCallerControlLiteralTrue",
  "operationalPromotionLiteralTrue",
];
for (const gate of postQualificationGateNames) check(raw.gates[gate] === false, `post-qualification gate false: ${gate}`);
check(raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false && raw.gates.fork === false, "action gates");
check(!Object.prototype.hasOwnProperty.call(raw.gates, "runtimeStateEconomicsAllLiteralTrue"), "bogus aggregate gate removed");

check(raw.chains.length === 2 && raw.chains.map((entry) => entry.chainId).join(",") === "957,901", "capture chains");
for (const chain of raw.chains) {
  check(chain.coverage === "BLOCKED" && chain.status === "LEGACY_NO_TARGET_CHAIN_ID_MATCH_STRICT_UNVERIFIED" && chain.reason === "LEGACY_NO_TARGET_CHAIN_ID_MATCH_STRICT_UNVERIFIED", `chain status: ${chain.chainId}`);
  check(chain.qualifiedFamilies === 0 && chain.finalityAttempted === false && chain.reportedFinalizedFamilies === 0, `chain qualification: ${chain.chainId}`);
  for (const field of ["pin", "runtimeBindings", "currentState", "currentSupply18", "currentBorrow18", "currentAccountCandidateCount", "activeEligiblePositionCount", "orderSensitivePairCount"]) {
    check(chain[field] === null, `chain null ${field}: ${chain.chainId}`);
  }
  for (const field of ["grossBorrowerBenefitCash18", "gasEstimate", "gasPriceWei", "gasCostCash18", "attributedGrossCash18", "netCash18", "callerRevenueCash18", "callerNetCash18"]) {
    check(chain.economics[field] === null, `economics null ${field}: ${chain.chainId}`);
  }
  check(chain.economics.beneficiaryControlProofLiteralTrue === false && chain.economics.economicsBindingLiteralTrue === false, `economics gates: ${chain.chainId}`);
  check(Object.values(chain.gates).every((value) => value === false), `chain gates false: ${chain.chainId}`);
  const deploymentRoot = `targets/derive-v2-core/deployments/${chain.chainId}`;
  const core = JSON.parse(read(`${deploymentRoot}/core.json`).toString("utf8"));
  const eth = JSON.parse(read(`${deploymentRoot}/ETH.json`).toString("utf8"));
  const eth2 = JSON.parse(read(`${deploymentRoot}/ETH_2.json`).toString("utf8"));
  const btc2 = JSON.parse(read(`${deploymentRoot}/BTC_2.json`).toString("utf8"));
  const expectedAddresses = {
    cash: core.cash,
    rateModel: core.rateModel,
    securityModule: core.securityModule,
    standardManager: core.srm,
    subAccounts: core.subAccounts,
    ethPerp: eth.perp,
    legacyPmrm: eth.pmrm,
    ethPmrm2: eth2.pmrm2,
    btcPmrm2: btc2.pmrm2,
    relevantErc20: null,
  };
  check(JSON.stringify(chain.documentedAddresses) === JSON.stringify(expectedAddresses), `documented address binding: ${chain.chainId}`);
}

const step1Bytes = read(raw.predecessor.step1ManifestPath);
const step1 = JSON.parse(step1Bytes.toString("utf8"));
check(sha256(step1Bytes) === raw.predecessor.step1ManifestSha256, "Step1 manifest hash");
check(step1.aggregateSha256 === raw.predecessor.step1AggregateSha256, "Step1 aggregate hash");

const report = read(REPORT_REL).toString("utf8");
check(report.includes(CLASSIFICATION.replaceAll("/", " / ")), "report classification");
check(report.includes("264") && report.includes("122") && report.includes("142"), "report qualification counts");
check(report.includes("LEGACY_NO_TARGET_CHAIN_ID_MATCH_STRICT_UNVERIFIED") && report.includes("finalityAttempted=false"), "report corrected status");
check(report.includes("Legacy `BigInt`-coercible") && report.includes("Strictly parsed successful chain IDs | null"), "report retained count semantics");
check(report.includes("null / null / null / null"), "report null economics");
check(report.includes("run-scoped HMAC") && report.includes("streaming"), "report hardening");

const inbox = JSON.parse(read(INBOX_REL).toString("utf8"));
check(inbox.classification === CLASSIFICATION, "inbox classification");
check(inbox.manifestAggregate === aggregateSha256 && inbox.manifestSha256 === manifestSha256, "inbox manifest references");
check(inbox.routePositive === 0 && inbox.executableNow === 0 && inbox.signedActionJustified === false && inbox.fork === false, "inbox gates");
const handoff = read(HANDOFF_REL).toString("utf8");
check(handoff.includes(CLASSIFICATION), "handoff classification");
check(handoff.includes(aggregateSha256) && handoff.includes(manifestSha256), "handoff manifest references");

const backlog = JSON.parse(read(BACKLOG_JSON).toString("utf8"));
const deriveRows = backlog.confirmedTargetSpecificRows.filter((entry) => entry.protocol === "Derive V2" && [957, 901].includes(entry.chainId));
check(deriveRows.length === 2, "backlog Derive rows");
check(deriveRows.every((entry) => entry.blockedChecks.some((value) => value.includes("strict target chain-ID qualification unverified"))), "backlog corrected blocker");

const preFixtureHashes = Object.fromEntries(PACKAGE_PATHS.map((rel) => [rel, sha256(read(rel))]));
const fixture = spawnSync(process.execPath, [path.join(ROOT, "tools/test-critical-derive-v2-step2.js")], { cwd: ROOT, encoding: "utf8" });
check(fixture.status === 0, "offline fixture tests");
const fixtureResult = JSON.parse(fixture.stdout.trim());
check(fixtureResult.ok === true && fixtureResult.tests === 161, "fixture result");
check(fixtureResult.network === 0 && fixtureResult.inventoryReads === 0 && fixtureResult.rpc === 0 && fixtureResult.fork === 0 && fixtureResult.stateOverride === 0 && fixtureResult.signing === 0 && fixtureResult.liveActions === 0, "fixture purity");
const postFixtureHashes = Object.fromEntries(PACKAGE_PATHS.map((rel) => [rel, sha256(read(rel))]));
check(JSON.stringify(preFixtureHashes) === JSON.stringify(postFixtureHashes), "fixture no-write guarantee");

for (const rel of PACKAGE_PATHS) {
  const bytes = read(rel);
  const text = bytes.toString("utf8");
  check(!(bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `UTF-8 BOM: ${rel}`);
  check(text.endsWith("\n"), `final LF: ${rel}`);
  check(!text.split("\n").some((line) => /[ \t]+$/.test(line)), `trailing whitespace: ${rel}`);
  genericLeakCheck(rel, text);
}

const runner = read("tools/run-critical-derive-v2-step2.js").toString("utf8");
check(runner.includes('redirect: "error"'), "runner redirect rejection");
check(runner.includes("readResponseWithCeiling") && !/\.arrayBuffer\s*\(/.test(runner), "runner streaming ceiling");
check(runner.includes("logicalBudget.reserve") && runner.includes("dispatchReserved"), "runner budget reservation");
check(runner.includes("validateBlockHeader") && runner.includes("terminalHeaderMatches"), "runner strict headers");
check(runner.includes("blockedChainResult") && runner.includes("beneficiaryControlProofLiteralTrue"), "runner blocked/promotion gates");
check(!/familyCommitment/.test(runner), "legacy family commitment removed");
check(!/\|\|\s*0n?\b/.test(runner), "numeric zero fallback removed");
check(!/runtimeStateEconomicsAllLiteralTrue/.test(runner), "bogus aggregate gate removed from runner");
check(runner.includes("parseGasEstimateResponse(gas)"), "gas estimate strict quantity parser");
check(runner.includes("parseGasPriceResponse(gasPrice)"), "gas price strict quantity parser");
check(!/gas\.ok\s*\?\s*BigInt/.test(runner) && !/gasPrice\.ok\s*\?\s*BigInt/.test(runner), "no direct BigInt gas parsing");
check(runner.includes("...invalidGasPromotionOutcome()"), "invalid gas null outcome wired into economics");

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: "check-only-no-write",
  checks,
  comparator: ALGORITHM,
  recordCount: manifest.recordCount,
  aggregateSha256,
  manifestSha256,
  fixtureTests: fixtureResult.tests,
  network: 0,
  inventoryReads: 0,
  rpc: 0,
  fork: 0,
  stateOverride: 0,
  signing: 0,
  liveActions: 0,
})}\n`);
