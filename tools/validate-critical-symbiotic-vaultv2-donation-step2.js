"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const runner = require("./critical-symbiotic-vaultv2-donation-step2-runner.js");

const ROOT = path.resolve(__dirname, "..");
const RAW_REL = "reports/raw/fast/critical-symbiotic-vaultv2-donation-step2";
const RAW = path.join(ROOT, RAW_REL);
const RUNNER_REL = "tools/critical-symbiotic-vaultv2-donation-step2-runner.js";
const TEST_REL = "tools/test-critical-symbiotic-vaultv2-donation-step2.js";
const FIXTURES_REL = "tools/fixtures/critical-symbiotic-vaultv2-donation-step2-fixtures.json";
const VALIDATOR_REL = "tools/validate-critical-symbiotic-vaultv2-donation-step2.js";
const REPORT_REL = "reports/critical-symbiotic-vaultv2-donation-step2-preflight.md";
const INBOX_REL = "coordination/inbox/critical/2026-07-31-critical-symbiotic-vaultv2-donation-step2.json";
const HANDOFF_REL = "coordination/handoffs/2026-07-31-critical-symbiotic-vaultv2-donation-step2-preflight.md";
const STEP1_CLOSURE_REL = "reports/raw/fast/critical-symbiotic-vaultv2-withdrawalqueue-step1/source-closure-manifest.json";
const MANIFEST_REL = `${RAW_REL}/manifest.json`;
const PROPOSAL_REL = `${RAW_REL}/proposal.json`;
const PREFLIGHT_REL = `${RAW_REL}/preflight.json`;
const TEST_CAPTURE_REL = `${RAW_REL}/offline-tests.json`;
const CHECK_CAPTURE_REL = `${RAW_REL}/check-only.json`;
const VALIDATOR_OUTPUT_REL = `${RAW_REL}/validator-output.json`;

const PACKAGE_INPUTS = [
  RUNNER_REL,
  TEST_REL,
  FIXTURES_REL,
  VALIDATOR_REL,
  REPORT_REL,
  INBOX_REL,
  HANDOFF_REL,
  PREFLIGHT_REL,
  PROPOSAL_REL,
  TEST_CAPTURE_REL,
  CHECK_CAPTURE_REL,
];

function canonicalJson(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function shaBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileHash(relativePath) {
  return shaBytes(fs.readFileSync(path.join(ROOT, relativePath)));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  const absolute = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
}

function captureNode(name, relativeScript, args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, relativeScript), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    env: { ...process.env },
  });
  assert.strictEqual(result.error, undefined, `${name}: process error`);
  assert.strictEqual(result.status, 0, `${name}: exit ${result.status}: ${result.stderr}`);
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const parsed = JSON.parse(stdout);
  return {
    schema: "symbiotic-vaultv2-donation-step2-command-capture-v1",
    name,
    executable: "node",
    script: relativeScript,
    arguments: args,
    workingDirectory: ".",
    exitCode: result.status,
    stdoutSha256: shaBytes(Buffer.from(stdout)),
    stderrSha256: shaBytes(Buffer.from(stderr)),
    stderrBytes: Buffer.byteLength(stderr),
    parsed,
  };
}

function packageEntries() {
  return PACKAGE_INPUTS.map((relativePath) => {
    const bytes = fs.readFileSync(path.join(ROOT, relativePath));
    return { path: relativePath, sha256: shaBytes(bytes), bytes: bytes.length };
  });
}

function proposalPayload(source, caps) {
  return {
    schema: "symbiotic-vaultv2-donation-step2-proposal-payload-v4",
    findingId: runner.FINDING_ID,
    proposalId: runner.PROPOSAL_ID,
    requestedApprovalId: runner.REQUESTED_APPROVAL_ID,
    chain: { name: "ethereum-mainnet", chainId: "0x1" },
    runner: { path: RUNNER_REL, sha256: fileHash(RUNNER_REL) },
    package: { manifestPath: MANIFEST_REL },
    source: {
      commit: runner.SOURCE_COMMIT,
      commitment: source.commitment,
      boundFiles: source.files,
    },
    caps: { commitment: runner.commitment(caps), values: caps },
    policy: {
      captureCount: 1,
      inventoryAccess: true,
      readOnly: true,
      noTrace: true,
      noTransaction: true,
      noFork: true,
      chainCount: 1,
      minimumFamilies: 2,
      commonMinFinalizedPin: true,
      terminalPinRecheck: true,
      orderedFactoryVersionHistory: true,
      directV2InitializationNoMigration: true,
      exactV2IntervalHistoryOnly: true,
      exactCanonicalDependencyAndProxyRuntimes: true,
      canonicalDependencyGateBeforeEntityEnumeration: true,
      dependencyFailureForcesAllNull: true,
      namedImmutableAstSlotsNoPermutations: true,
      canonicalHeaderForEveryLogBlock: true,
      storedSupplyMinusPendingFeeShares: true,
      nominalZeroShareNotActualLoss: true,
      perVaultConjunctiveEligibility: true,
      streamingBodyCaps: true,
      atomicAllNullPostLedgerFailures: true,
      fixedAllowlistReasonCodesOnly: true,
      unknownErrorsRedacted: true,
      recursiveCaseInsensitiveKeyIndependentLeakDetection: true,
      completeRequiresAllWithinCaps: true,
      productionCompleteOrAllNullEveryEntity: true,
      conclusiveNonV2RequiresExactProxyVersionCodeLifecycleDependencyAndCompletedComparator: true,
      unknownRowsNeverCountedAsLegacyOther: true,
      fullPerformNetworkCaptureAdaptersTested: true,
      strictMethods: [...runner.ALLOWED_METHODS].sort(),
    },
    privacy: { claim: "NO_DIRECT_IDENTIFIERS_OR_ROWS_PERSISTED", kThreshold: 3,
      countBuckets: ["0", "1-2", "3-9", "10+"], valueMagnitudeBuckets: true,
      canonicalManifestAddressesOnly: true },
    fixedPaths: {
      approval: runner.FIXED_APPROVAL_REL,
      output: runner.FIXED_OUTPUT_REL,
      globalLedger: runner.GLOBAL_LEDGER_REL,
    },
    proposedCommand: [
      "node",
      RUNNER_REL,
      "--capture-once",
      "--approval-file",
      runner.FIXED_APPROVAL_REL,
    ],
  };
}

function preparePackage() {
  assert(!fs.existsSync(path.join(ROOT, runner.FIXED_APPROVAL_REL)), "approval must not exist while preparing");
  assert(!fs.existsSync(path.join(ROOT, runner.GLOBAL_LEDGER_REL)), "ledger must not exist while preparing");
  assert(!fs.existsSync(path.join(ROOT, runner.FIXED_OUTPUT_REL)), "capture output must not exist while preparing");

  const offlineTests = captureNode("offline-fixture-tests", TEST_REL, []);
  const checkOnly = captureNode("default-check-only", RUNNER_REL, []);
  assert.strictEqual(offlineTests.parsed.status, "PASS");
  assert.strictEqual(offlineTests.parsed.testCaseCount, 51);
  assert.strictEqual(offlineTests.parsed.assertionCount, 171);
  assert.strictEqual(offlineTests.parsed.coverageClassCount, 77);
  assert.deepStrictEqual(offlineTests.parsed.unit, { testCaseCount: 36, assertionCount: 108, coverageClassCount: 62 });
  assert.deepStrictEqual(offlineTests.parsed.e2e, { testCaseCount: 15, assertionCount: 63, coverageClassCount: 15 });
  assert.strictEqual(offlineTests.parsed.proposalId, runner.PROPOSAL_ID);
  assert.strictEqual(checkOnly.parsed.authorization.defaultMode, "CHECK_ONLY");
  assert.strictEqual(checkOnly.parsed.status, "PREPARED_NOT_AUTHORIZED_NOT_EXECUTED");
  assert.strictEqual(checkOnly.parsed.captureExecuted, false);
  assert.strictEqual(checkOnly.parsed.networkReads, 0);
  assert.strictEqual(checkOnly.parsed.inventoryReads, 0);
  writeJson(TEST_CAPTURE_REL, offlineTests);
  writeJson(CHECK_CAPTURE_REL, checkOnly);

  const source = runner.loadSourceBinding();
  const preflight = {
    schema: "symbiotic-vaultv2-donation-step2-preflight-v4",
    findingId: runner.FINDING_ID,
    proposalId: runner.PROPOSAL_ID,
    status: "PREPARED_REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED",
    authorization: "NOT_AUTHORIZED",
    execution: "NOT_EXECUTED",
    requestedApprovalId: runner.REQUESTED_APPROVAL_ID,
    canonicalDiscoveryEvidence: runner.canonicalManifestEvidence(),
    localSource: { commit: runner.SOURCE_COMMIT, commitment: source.commitment },
    defaultCheckOnly: checkOnly.parsed,
    offlineTests: offlineTests.parsed,
    pinPolicy: "minimum finalized height across at least two hostname-distinct qualified families, exact common-pin header agreement, terminal same-number/hash recheck",
    classification: {
      sourcePrimitive: 1,
      localRoutePositive: 1,
      exactSourceRuntime: null,
      affectedSemantics: null,
      current18PlusUnrestricted: null,
      currentFirstSoleRestart: null,
      historicalNominalZeroShareDeposit: null,
      historicalActualAssetLoss: null,
      confirmedDonationSequence: null,
      attackerRedemptionProfit: null,
      currentEconomics: null,
      netEconomics: null,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      fork: false,
    },
    privacy: { claim: "NO_DIRECT_IDENTIFIERS_OR_ROWS_PERSISTED", countBuckets: ["0", "1-2", "3-9", "10+"],
      valueMagnitudeBuckets: true, canonicalManifestAddressesOnly: true },
    captureExecuted: false,
    networkReads: 0,
    inventoryReads: 0,
  };
  writeJson(PREFLIGHT_REL, preflight);

  const payload = JSON.parse(JSON.stringify(proposalPayload(source, runner.CAPS)));
  const proposal = {
    schema: "symbiotic-vaultv2-donation-step2-proposal-v1",
    revision: 4,
    proposalId: runner.PROPOSAL_ID,
    state: "REVIEW_REQUESTED_NOT_AUTHORIZED",
    authorizesExecution: false,
    payload,
    proposalCommitment: runner.commitment(payload),
    reviewerRequirements: {
      independentReviewerRequired: true,
      approvalMustBeSeparate: true,
      reviewerIdentity: null,
      decision: null,
      issuedAt: null,
      expiresAt: null,
      packageManifestSha256: null,
      packageAggregateSha256: null,
    },
  };
  writeJson(PROPOSAL_REL, proposal);

  const entries = packageEntries();
  const manifest = {
    schema: "symbiotic-vaultv2-donation-step2-package-v1",
    revision: 4,
    findingId: runner.FINDING_ID,
    proposalId: runner.PROPOSAL_ID,
    state: "PREPARED_REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED",
    approvalIssued: false,
    captureExecuted: false,
    entries,
    aggregateSha256: shaBytes(Buffer.from(canonicalJson(entries))),
  };
  writeJson(MANIFEST_REL, manifest);
  return validatePackage();
}

function validatePackage() {
  let checks = 0;
  const check = (condition, message) => { assert(condition, message); checks += 1; };

  for (const relativePath of [...PACKAGE_INPUTS, MANIFEST_REL, STEP1_CLOSURE_REL]) {
    check(fs.existsSync(path.join(ROOT, relativePath)), `missing ${relativePath}`);
  }
  check(!fs.existsSync(path.join(ROOT, runner.FIXED_APPROVAL_REL)), "approval unexpectedly exists");
  check(!fs.existsSync(path.join(ROOT, runner.GLOBAL_LEDGER_REL)), "global ledger unexpectedly exists");
  check(!fs.existsSync(path.join(ROOT, runner.FIXED_OUTPUT_REL)), "capture output unexpectedly exists");

  const manifest = readJson(MANIFEST_REL);
  check(manifest.schema === "symbiotic-vaultv2-donation-step2-package-v1", "manifest schema");
  check(manifest.revision === 4 && manifest.proposalId === runner.PROPOSAL_ID, "manifest R4 proposal binding");
  check(manifest.approvalIssued === false && manifest.captureExecuted === false, "manifest authorization state");
  check(manifest.entries.length === PACKAGE_INPUTS.length, "manifest entry count");
  for (const entry of manifest.entries) {
    check(PACKAGE_INPUTS.includes(entry.path), `unexpected manifest entry ${entry.path}`);
    const bytes = fs.readFileSync(path.join(ROOT, entry.path));
    check(entry.sha256 === shaBytes(bytes), `hash mismatch ${entry.path}`);
    check(entry.bytes === bytes.length, `byte mismatch ${entry.path}`);
  }
  check(manifest.aggregateSha256 === shaBytes(Buffer.from(canonicalJson(manifest.entries))), "aggregate mismatch");

  const tests = readJson(TEST_CAPTURE_REL);
  const checkOnly = readJson(CHECK_CAPTURE_REL);
  check(tests.exitCode === 0 && tests.stderrBytes === 0, "offline tests command failed");
  check(tests.parsed.status === "PASS" && tests.parsed.testCaseCount === 51 && tests.parsed.assertionCount === 171 &&
    tests.parsed.coverageClassCount === 77 && tests.parsed.declaredCoverageClassCount === 77, "executed tests result");
  check(canonicalJson(tests.parsed.unit) === canonicalJson({ testCaseCount: 36, assertionCount: 108,
    coverageClassCount: 62 }), "unit accounting");
  check(canonicalJson(tests.parsed.e2e) === canonicalJson({ testCaseCount: 15, assertionCount: 63,
    coverageClassCount: 15 }), "e2e accounting");
  check(tests.parsed.proposalId === runner.PROPOSAL_ID && tests.parsed.requestedApprovalId === runner.REQUESTED_APPROVAL_ID,
    "offline test IDs");
  check(tests.parsed.networkReads === 0 && tests.parsed.inventoryReads === 0 && tests.parsed.captureExecuted === false, "offline test access");
  check(tests.parsed.workspaceCaptureWrites === 0 && tests.parsed.workspaceLedgerWrites === 0 &&
    tests.parsed.temporaryArtifactsRemoved === true, "temporary-only test writes");
  check(Array.isArray(tests.parsed.tests) && tests.parsed.tests.length === tests.parsed.testCaseCount, "test-name rows");
  check(new Set(tests.parsed.tests.map((row) => row.name)).size === tests.parsed.testCaseCount, "unique test names");
  check(tests.parsed.tests.every((row) => typeof row.name === "string" && ["unit", "e2e"].includes(row.kind) &&
    Number.isInteger(row.assertions) && row.assertions > 0 && Array.isArray(row.coverageClasses) &&
    row.coverageClasses.length > 0), "test row schema");
  check(tests.parsed.tests.reduce((sum, row) => sum + row.assertions, 0) === tests.parsed.assertionCount,
    "independent assertion sum");
  for (const kind of ["unit", "e2e"]) {
    const rows = tests.parsed.tests.filter((row) => row.kind === kind);
    const independentlyParsed = { testCaseCount: rows.length,
      assertionCount: rows.reduce((sum, row) => sum + row.assertions, 0),
      coverageClassCount: new Set(rows.flatMap((row) => row.coverageClasses)).size };
    check(canonicalJson(independentlyParsed) === canonicalJson(tests.parsed[kind]), `independent ${kind} accounting`);
  }
  check(checkOnly.exitCode === 0 && checkOnly.stderrBytes === 0, "check-only command failed");
  check(checkOnly.parsed.authorization.defaultMode === "CHECK_ONLY" && checkOnly.parsed.status === "PREPARED_NOT_AUTHORIZED_NOT_EXECUTED", "check-only state");
  check(checkOnly.parsed.networkReads === 0 && checkOnly.parsed.inventoryReads === 0 && checkOnly.parsed.writes === 0, "check-only access");

  const coveragePlan = readJson(FIXTURES_REL);
  check(coveragePlan.schemaVersion === 4 && coveragePlan.proposalId === runner.PROPOSAL_ID, "coverage plan/ID binding");
  check(Array.isArray(coveragePlan.coverageClasses) && coveragePlan.coverageClasses.length === 77 &&
    new Set(coveragePlan.coverageClasses).size === 77, "declared coverage classes");
  const executedCoverage = [...new Set(tests.parsed.tests.flatMap((row) => row.coverageClasses))].sort();
  check(canonicalJson(executedCoverage) === canonicalJson([...coveragePlan.coverageClasses].sort()),
    "declared coverage equals executed coverage");
  for (const required of [
    "approval-success-ledger-output-orchestrator", "approval-replay-path-expiry-and-mode-conflicts",
    "dependency-gate-exact-before-entity-work", "dependency-gate-matched-runtime-mismatch",
    "dependency-gate-dual-family-disagreement", "dependency-gate-empty-and-malformed-code",
    "dependency-source-reconstruction-failure", "qualification-threshold-failure-through-orchestrator",
    "common-pin-header-mismatch-through-orchestrator", "terminal-pin-mismatch-through-orchestrator",
    "history-failure-through-orchestrator", "runtime-failure-through-orchestrator",
    "config-failure-through-orchestrator", "production-canonical-log-match-and-mismatch",
    "production-log-dedup-and-conflict", "per-vault-conjunction-production-aggregate",
    "fixed-reason-enum-and-unknown-redaction", "nested-case-insensitive-key-independent-sanitizer",
    "successful-complete-synthetic-real-orchestrator"
  ]) check(tests.parsed.tests.some((row) => row.name === required), `missing executed test ${required}`);
  for (const required of [
    "e2e-real-perform-complete-success", "e2e-real-perform-config-null", "e2e-real-perform-malformed-entity",
    "e2e-real-perform-proxy-incomplete", "e2e-real-perform-code-incomplete",
    "e2e-real-perform-lifecycle-version-gap", "e2e-real-perform-runtime-unknown",
    "e2e-real-perform-history-incomplete", "e2e-real-perform-canonical-log-failure",
    "e2e-real-perform-stored-supply-incomplete", "e2e-real-perform-cap-exhaustion",
    "e2e-real-perform-unknown-error-redacted", "e2e-real-perform-terminal-mismatch",
    "e2e-fixed-cli-path-replay-expiry-mode", "e2e-conclusive-non-v2-complete"
  ]) check(tests.parsed.tests.some((row) => row.name === required && row.kind === "e2e"), `missing full e2e ${required}`);
  for (const key of Object.keys(runner.CAPS)) check(executedCoverage.includes(`cap-${key}`), `cap not executed ${key}`);

  const source = runner.loadSourceBinding();
  const proposal = readJson(PROPOSAL_REL);
  check(proposal.state === "REVIEW_REQUESTED_NOT_AUTHORIZED" && proposal.authorizesExecution === false, "proposal state");
  check(proposal.revision === 4 && proposal.proposalId === runner.PROPOSAL_ID &&
    proposal.payload.requestedApprovalId === runner.REQUESTED_APPROVAL_ID, "new proposal/approval IDs");
  check(proposal.proposalCommitment === runner.commitment(proposal.payload), "proposal commitment");
  check(proposal.payload.runner.sha256 === fileHash(RUNNER_REL), "runner binding");
  check(proposal.payload.source.commitment === source.commitment, "source binding");
  check(canonicalJson(proposal.payload.source.boundFiles) === canonicalJson(source.files), "source/artifact file binding");
  check(proposal.payload.caps.commitment === runner.commitment(runner.CAPS), "caps binding");
  check(canonicalJson(proposal.payload.policy.strictMethods) === canonicalJson([...runner.ALLOWED_METHODS].sort()), "method binding");
  check(Object.values(proposal.reviewerRequirements).filter((v) => v === null).length === 6, "review fields must be null");
  const runtimePackageContext = runner.packageValidationContext();
  check(runtimePackageContext.expected.proposalCommitment === proposal.proposalCommitment, "runtime proposal validation");
  check(runtimePackageContext.expected.packageAggregateSha256 === `0x${manifest.aggregateSha256}`, "runtime manifest validation");
  check(runtimePackageContext.expected.proposalId === runner.PROPOSAL_ID, "runtime proposal ID validation");

  const preflight = readJson(PREFLIGHT_REL);
  check(preflight.authorization === "NOT_AUTHORIZED" && preflight.execution === "NOT_EXECUTED" &&
    preflight.proposalId === runner.PROPOSAL_ID, "preflight state/ID");
  check(preflight.captureExecuted === false && preflight.networkReads === 0 && preflight.inventoryReads === 0, "preflight access");
  for (const gate of ["exactSourceRuntime", "affectedSemantics", "current18PlusUnrestricted", "currentFirstSoleRestart",
    "historicalNominalZeroShareDeposit", "historicalActualAssetLoss", "confirmedDonationSequence", "attackerRedemptionProfit",
    "currentEconomics", "netEconomics"]) {
    check(preflight.classification[gate] === null, `${gate} must be null`);
  }
  check(preflight.classification.routePositive === 0 && preflight.classification.executableNow === 0, "operational gates");
  check(preflight.classification.signedActionJustified === false && preflight.classification.fork === false, "signed/fork gates");
  check(canonicalJson(preflight.canonicalDiscoveryEvidence) === canonicalJson(runner.canonicalManifestEvidence()), "canonical discovery evidence");

  const sanitizedFiles = [PREFLIGHT_REL, PROPOSAL_REL, TEST_CAPTURE_REL, CHECK_CAPTURE_REL, INBOX_REL];
  const allowedAddresses = new Set(Object.values(runner.CANONICAL).filter((v) => /^0x[0-9a-fA-F]{40}$/.test(v)).map((v) => v.toLowerCase()));
  for (const relativePath of sanitizedFiles) {
    const text = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    for (const match of text.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) check(allowedAddresses.has(match[0].toLowerCase()), `noncanonical address in ${relativePath}`);
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) check(match[0] === runner.DOCS_URL, `unexpected URL in ${relativePath}`);
    check(!/"(?:endpointUrl|providerUrl|transactionHash|rawResponse|calldata)"\s*:\s*"[^\"]+"/i.test(text), `identity/raw value in ${relativePath}`);
  }

  const report = fs.readFileSync(path.join(ROOT, REPORT_REL), "utf8");
  for (const phrase of [
    "NOT_AUTHORIZED / NOT_EXECUTED", runner.PROPOSAL_ID, runner.REQUESTED_APPROVAL_ID,
    "before `captureFactory`, entity enumeration, or history", "DEPENDENCY_SOURCE_RECONSTRUCTION_FAILED",
    "DEPENDENCY_DUAL_FAMILY_RUNTIME_UNBOUND", "DEPENDENCY_RUNTIME_EMPTY_OR_MALFORMED", "DEPENDENCY_RUNTIME_MISMATCH",
    "never enter output", "INTERNAL_FAILURE_REDACTED", "case-insensitive", "key-independent",
    "Production complete-or-all-null invariant", "Unknown rows are never counted as legacy/other",
    "Helper/unit | 36 | 108 | 62", "Full mocked production E2E | 15 | 63 | 15",
    "**Total** | **51** | **171** | **77**", "real fixed-CLI parser", "actual `performNetworkCapture`",
    "alternate actual CLI approval-file path rejection", "Workspace approval/ledger/capture writes are zero",
    "totalSupply() - managementFeeShares", "same-vault conjunction", "budget.summary.allWithinCaps=true",
    runner.FIXED_APPROVAL_REL, runner.GLOBAL_LEDGER_REL,
  ]) check(report.includes(phrase), `report missing phrase: ${phrase}`);
  check(report.includes("No configurator, entity proxy, implementation, or version-registry address is claimed"),
    "missing excluded-address disclaimer");

  const runnerSource = fs.readFileSync(path.join(ROOT, RUNNER_REL), "utf8");
  const testSource = fs.readFileSync(path.join(ROOT, TEST_REL), "utf8");
  for (const marker of ["reconcileFactoryVersionHistory", "buildEntityImplementationIntervals", "exactV2Interval",
    "captureCanonicalDependencyRuntimes", "proxyImmutableBinding", "vaultImmutableBinding", "validateCanonicalLogBlocks",
    "reconcileStoredShareSupply", "classifyZeroShareDepositEvidence", "countBucket", "magnitudeBucket",
    "maxInventoryBytes", "readResponseBodyCapped", "maxTimestampFetches", "maxUniqueHeaders",
    "writeSanitizedCaptureAtomically", "orchestrateApprovedCapture", "mapPostLedgerFailure", "FIXED_REASON_CODES",
    "INTERNAL_FAILURE_REDACTED", "assertFactoryCaptureComplete", "assertEntityCaptureComplete",
    "conclusiveNonV2", "executeCaptureCli", "performNetworkCapture", "allWithinCaps"])
    check(runnerSource.includes(marker), `runner missing ${marker}`);
  const networkCaptureSource = runnerSource.slice(runnerSource.indexOf("async function performNetworkCapture"),
    runnerSource.indexOf("async function orchestrateApprovedCapture"));
  check(networkCaptureSource.indexOf("captureCanonicalDependencyRuntimes") >= 0 &&
    networkCaptureSource.indexOf("captureCanonicalDependencyRuntimes") < networkCaptureSource.indexOf("captureFactory"),
  "dependency gate precedes entity enumeration");
  check(networkCaptureSource.indexOf("assertFactoryCaptureComplete(factory)") >= 0 &&
    networkCaptureSource.indexOf("assertEntityCaptureComplete(current, history)") >= 0 &&
    networkCaptureSource.indexOf("assertEntityCaptureComplete(current, history)") < networkCaptureSource.indexOf("rows.push"),
  "per-entity completeness precedes aggregation");
  const runCaptureSource = runnerSource.slice(runnerSource.indexOf("async function runCapture"),
    runnerSource.indexOf("async function executeCaptureCli"));
  check(runCaptureSource.includes("captureOperation: () => performNetworkCapture(context)"),
    "fixed CLI run invokes real performNetworkCapture");
  const orchestratorSource = runnerSource.slice(runnerSource.indexOf("async function orchestrateApprovedCapture"),
    runnerSource.indexOf("async function runCapture"));
  check(orchestratorSource.includes("mapPostLedgerFailure(error)") && !orchestratorSource.includes("error.message") &&
    !orchestratorSource.includes("error.stack") && !orchestratorSource.includes("error.name"), "post-ledger error redaction");
  check(!runnerSource.includes("error.stack") && runnerSource.includes("RUNNER_FAILURE_REDACTED"),
    "top-level stderr redaction");
  check(!runnerSource.includes("slice(0, CAPS.maxInventoryEntries)"), "inventory truncation retained");
  check(!runnerSource.includes("response.arrayBuffer()"), "nonstreaming body retained");
  check(testSource.includes("R.executeCaptureCli") && testSource.includes("R.FIXED_APPROVAL_REL") &&
    testSource.includes("R.performNetworkCapture") === false && testSource.includes("fullProductionAdapters"),
  "full E2E fixed CLI and perform adapter path");
  check(runnerSource.indexOf("consumeApprovalAtomically(authorization, ledgerPath)") <
    runnerSource.lastIndexOf("writeSanitizedCaptureAtomically(output, outputPath)"),
    "post-ledger write path ordering");

  for (const relativePath of [FIXTURES_REL, INBOX_REL, PREFLIGHT_REL, PROPOSAL_REL, TEST_CAPTURE_REL, CHECK_CAPTURE_REL, MANIFEST_REL]) {
    const text = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    check(text.endsWith("\n") && !text.split(/\r?\n/u).some((line) => /[ \t]+$/u.test(line)), `JSON whitespace ${relativePath}`);
    check(JSON.parse(text) !== null, `JSON parse ${relativePath}`);
  }

  const step1Closure = readJson(STEP1_CLOSURE_REL);
  const step1Tests = step1Closure.entries.filter((entry) => entry.namespacedStageTest === true);
  check(step1Tests.length === 5, "Step1 test binding count");
  for (const entry of step1Tests) {
    check(fileHash(`targets/symbiotic-core-83a3a9ab/${entry.path}`) === entry.sha256, `Step1 test changed: ${entry.path}`);
  }
  const diff = spawnSync("git", ["diff", "--exit-code", "--", "src", "test/vault", "test/invariant"], {
    cwd: path.join(ROOT, "targets/symbiotic-core-83a3a9ab"), encoding: "utf8", windowsHide: true,
  });
  check(diff.status === 0, `production/upstream tracked diff: ${diff.stdout}${diff.stderr}`);

  const result = {
    schema: "symbiotic-vaultv2-donation-step2-validation-v4",
    proposalId: runner.PROPOSAL_ID,
    requestedApprovalId: runner.REQUESTED_APPROVAL_ID,
    status: "PASS",
    checks,
    packageAggregateSha256: manifest.aggregateSha256,
    proposalCommitment: proposal.proposalCommitment,
    sourceCommitment: source.commitment,
    runnerSha256: fileHash(RUNNER_REL),
    unitTestCases: 36,
    unitAssertions: 108,
    unitCoverageClasses: 62,
    e2eTestCases: 15,
    e2eAssertions: 63,
    e2eCoverageClasses: 15,
    totalTestCases: 51,
    totalAssertions: 171,
    totalCoverageClasses: 77,
    networkReads: 0,
    inventoryReads: 0,
    captureExecuted: false,
    writesOutsideOfflineArtifacts: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
  };
  return result;
}

function main() {
  const result = process.argv.includes("--prepare-package") ? preparePackage() : validatePackage();
  if (process.argv.includes("--write-result")) writeJson(VALIDATOR_OUTPUT_REL, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validatePackage, preparePackage };
