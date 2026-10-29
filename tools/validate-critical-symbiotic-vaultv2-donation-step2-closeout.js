#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const runner = require("./critical-symbiotic-vaultv2-donation-step2-runner.js");

const ROOT = path.resolve(__dirname, "..");
const RAW = "reports/raw/fast/critical-symbiotic-vaultv2-donation-step2";
const CLASSIFICATION = "CAPTURE_INCOMPLETE/BUDGET_EXHAUSTED_CAUSE_UNRESOLVED/NO_RUNTIME-CONFIG-HISTORY/ALL_PROMOTION_GATES_NULL/RETRY_NOT_AUTHORIZED";
const PATHS = Object.freeze({
  approval: "coordination/decisions/symbiotic-vaultv2-donation-step2-approval.json",
  ledger: "coordination/decisions/symbiotic-vaultv2-donation-step2-consumption-ledger.json",
  capture: `${RAW}/capture.json`,
  preflightManifest: `${RAW}/manifest.json`,
  proposal: `${RAW}/proposal.json`,
  preflight: `${RAW}/preflight.json`,
  preflightReport: "reports/critical-symbiotic-vaultv2-donation-step2-preflight.md",
  runner: "tools/critical-symbiotic-vaultv2-donation-step2-runner.js",
  validator: "tools/validate-critical-symbiotic-vaultv2-donation-step2-closeout.js",
  report: "reports/critical-symbiotic-vaultv2-donation-step2-closeout.md",
  closeout: `${RAW}/closeout.json`,
  checkOnly: `${RAW}/closeout-check-only.json`,
  manifest: `${RAW}/closeout-manifest.json`,
  validatorOutput: `${RAW}/closeout-validator-output.json`,
  inbox: "coordination/inbox/critical/2026-07-31-critical-symbiotic-vaultv2-donation-step2-closeout.json",
  handoff: "coordination/handoffs/2026-07-31-critical-symbiotic-vaultv2-donation-step2-closeout.md"
});
const IMMUTABLE_EXPECTED = Object.freeze({
  [PATHS.approval]: ["3075d8caa6aa69c48dfb2edc7d1f0c5f32c44a736b2416beceb9a976f590db60", 1689],
  [PATHS.ledger]: ["45fc93d9afc78d42c344d962eb0c11d46e70c6d207fab3552913edef5f27cdb8", 287],
  [PATHS.capture]: ["4dc0b547afb9df6884595fb46d14dc5140c19d4a21c194615033d8123c5b15f9", 2167],
  [PATHS.preflightManifest]: ["94c9fa77b90bdc7a443a4abfc18be1fc456e8255666d1278c38d9f2621e4ed54", 2691],
  [PATHS.proposal]: ["87589cebcd8b78ad042d58031ed6b1db2ded3390b93eec06242a83fa7deb42d5", 9446],
  [PATHS.preflight]: ["f7cb15d473d6f8a09534740d38cce84630261c6a82dbb28bd09a113962a31f61", 26232],
  [PATHS.preflightReport]: ["0f2d2eb18a8172153842f538b43a8b6548764e2b684dcc0c1a6bcfacfb865175", 6649]
});
const PACKAGE_INPUTS = [PATHS.validator, PATHS.report, PATHS.closeout, PATHS.checkOnly, PATHS.inbox, PATHS.handoff,
  ...Object.keys(IMMUTABLE_EXPECTED)];

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function absolute(relative) { return path.join(ROOT, ...relative.split("/")); }
function record(relative) {
  const bytes = fs.readFileSync(absolute(relative));
  return { path: relative, sha256: sha(bytes), bytes: bytes.length };
}
function json(relative) { return JSON.parse(fs.readFileSync(absolute(relative), "utf8")); }
function writeJson(relative, value) {
  const target = absolute(relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function aggregate(records) { return sha(Buffer.from(canonicalJson(records), "utf8")); }

function immutableSnapshot() {
  return Object.fromEntries(Object.keys(IMMUTABLE_EXPECTED).map((relative) => [relative, record(relative)]));
}
function requireImmutable(snapshot) {
  for (const [relative, [expectedHash, expectedBytes]] of Object.entries(IMMUTABLE_EXPECTED)) {
    const actual = snapshot[relative] || record(relative);
    assert.strictEqual(actual.sha256, expectedHash, `immutable hash ${relative}`);
    assert.strictEqual(actual.bytes, expectedBytes, `immutable bytes ${relative}`);
  }
}

function captureCheckOnly() {
  const result = spawnSync(process.execPath, [absolute(PATHS.runner), "--check-only"], {
    cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 120000
  });
  assert.strictEqual(result.status, 0, `check-only exit: ${result.stderr}`);
  assert.strictEqual(result.stderr || "", "", "check-only stderr");
  const parsed = JSON.parse(result.stdout);
  const output = {
    schema: "symbiotic-vaultv2-donation-step2-closeout-check-only-v1",
    command: ["node", PATHS.runner, "--check-only"],
    exitCode: result.status,
    stdoutSha256: sha(Buffer.from(result.stdout)),
    stderrSha256: sha(Buffer.from(result.stderr || "")),
    parsed
  };
  writeJson(PATHS.checkOnly, output);
  return output;
}

function prepare() {
  const before = immutableSnapshot();
  requireImmutable(before);
  captureCheckOnly();
  const records = PACKAGE_INPUTS.map(record);
  const manifest = {
    schema: "symbiotic-vaultv2-donation-step2-closeout-package-v1",
    classification: CLASSIFICATION,
    findingId: runner.FINDING_ID,
    proposalId: runner.PROPOSAL_ID,
    approvalId: runner.REQUESTED_APPROVAL_ID,
    predecessor: {
      manifestPath: PATHS.preflightManifest,
      manifestSha256: IMMUTABLE_EXPECTED[PATHS.preflightManifest][0],
      aggregateSha256: "57c5c22bd39ae420a4a8467496b752652005683e8081c9136a4844768e4e0d86"
    },
    approvalConsumed: true,
    retryAuthorized: false,
    captureStatus: "INCOMPLETE_ALL_PROMOTION_GATES_NULL",
    captureReason: "BUDGET_EXHAUSTED",
    reasonBudgetSummaryCauseUnresolved: true,
    records,
    aggregateSha256: aggregate(records)
  };
  writeJson(PATHS.manifest, manifest);
  const after = immutableSnapshot();
  requireImmutable(after);
  assert.deepStrictEqual(after, before, "immutable evidence changed during prepare");
  return validate();
}

function validate() {
  let checks = 0;
  const check = (condition, message) => { assert(condition, message); checks += 1; };
  for (const relative of [...PACKAGE_INPUTS, PATHS.manifest]) check(fs.existsSync(absolute(relative)), `missing ${relative}`);
  const immutable = immutableSnapshot();
  for (const [relative, [expectedHash, expectedBytes]] of Object.entries(IMMUTABLE_EXPECTED)) {
    check(immutable[relative].sha256 === expectedHash, `immutable hash ${relative}`);
    check(immutable[relative].bytes === expectedBytes, `immutable bytes ${relative}`);
  }

  const approval = json(PATHS.approval);
  const ledger = json(PATHS.ledger);
  const capture = json(PATHS.capture);
  const preflightManifest = json(PATHS.preflightManifest);
  const proposal = json(PATHS.proposal);
  const closeout = json(PATHS.closeout);
  const manifest = json(PATHS.manifest);
  const checkOnly = json(PATHS.checkOnly);

  check(approval.schemaVersion === 1 && approval.state === "AUTHORIZED", "approval schema/state");
  check(approval.approvalCommitment === runner.commitment(approval.approvalPayload), "approval commitment");
  const payload = approval.approvalPayload;
  check(payload.approvalId === runner.REQUESTED_APPROVAL_ID && payload.proposalId === runner.PROPOSAL_ID &&
    payload.findingId === runner.FINDING_ID && payload.chainId === 1, "approval identifiers");
  check(payload.authorizedCaptureCount === 1 && payload.endpointInventoryReadAuthorized === true &&
    payload.transactionsAuthorized === false && payload.traceAuthorized === false && payload.forkAuthorized === false,
  "approval scope");
  check(canonicalJson(payload.allowedMethods) === canonicalJson([...runner.ALLOWED_METHODS].sort()), "approval methods");
  check(payload.fixedApprovalPath === PATHS.approval && payload.globalConsumptionLedger === PATHS.ledger &&
    payload.fixedOutputPath === PATHS.capture, "approval fixed paths");
  check(payload.runnerSha256 === `0x${record(PATHS.runner).sha256}`, "approval runner binding");
  check(payload.packageManifestSha256 === `0x${IMMUTABLE_EXPECTED[PATHS.preflightManifest][0]}` &&
    payload.packageAggregateSha256 === `0x${preflightManifest.aggregateSha256}`, "approval package binding");
  check(payload.proposalCommitment === proposal.proposalCommitment &&
    proposal.proposalCommitment === runner.commitment(proposal.payload), "approval proposal binding");
  check(payload.packageSourceBinding === proposal.payload.source.commitment &&
    payload.capsCommitment === proposal.payload.caps.commitment, "approval source/caps binding");
  check(payload.packageSourceBinding === "0x8508179ba18baeb4d488caa8ef957aeec448872e510f28692c462bea4c031985" &&
    payload.capsCommitment === "0xb95dd63c16b4df6b3520b3ca7461c1a90bb4751c702075e85097567090130d08",
  "fixed source/caps commitments");
  const issued = Date.parse(payload.issuedAt), expires = Date.parse(payload.expiresAt);
  check(Number.isFinite(issued) && Number.isFinite(expires) && issued < expires &&
    expires - issued <= runner.CAPS.maxApprovalWindowMs, "approval issuance window shape");

  check(preflightManifest.schema === "symbiotic-vaultv2-donation-step2-package-v1" &&
    preflightManifest.revision === 4 && preflightManifest.proposalId === runner.PROPOSAL_ID,
  "preflight manifest identity");
  check(preflightManifest.aggregateSha256 === "57c5c22bd39ae420a4a8467496b752652005683e8081c9136a4844768e4e0d86",
    "preflight aggregate");
  for (const row of preflightManifest.entries) {
    const current = record(row.path);
    check(current.sha256 === row.sha256 && current.bytes === row.bytes, `preflight record ${row.path}`);
  }
  check(aggregate(preflightManifest.entries) === preflightManifest.aggregateSha256, "preflight manifest aggregate recompute");

  check(ledger.schemaVersion === 1 && ledger.findingId === runner.FINDING_ID, "ledger identity");
  check(ledger.approvalId === payload.approvalId && ledger.approvalCommitment === approval.approvalCommitment,
    "ledger approval binding");
  check(ledger.status === "GLOBALLY_CONSUMED_BEFORE_INVENTORY_ACCESS", "ledger consumed-before-inventory status");

  check(capture.schemaVersion === 1 && capture.findingId === runner.FINDING_ID &&
    capture.proposalId === runner.PROPOSAL_ID, "capture identity");
  check(capture.status === "INCOMPLETE_ALL_PROMOTION_GATES_NULL" && capture.reasonCode === "BUDGET_EXHAUSTED",
    "capture exact status/reason");
  const expectedGates = ["exactSourceRuntime", "affectedZeroShareSemantics", "current18PlusUnrestrictedConfig",
    "currentFirstSoleRestartState", "historicalNominalZeroShareDeposits", "historicalActualAssetLoss",
    "confirmedDonationSequence", "attackerRedemptionProfit", "currentNetEconomics"];
  check(Object.keys(capture.promotionGates).length === 9 && expectedGates.every((key) => capture.promotionGates[key] === null),
    "nine all-null promotion gates");
  check(capture.operationalGates.routePositive === 0 && capture.operationalGates.executableNow === 0 &&
    capture.operationalGates.signedActionJustified === false && capture.operationalGates.fork === false,
  "capture operational gates");
  check(capture.captureAttempted === true, "capture attempted retained");
  check(capture.sanitized === true && capture.directIdentifiersPersisted === false &&
    capture.directRowsPersisted === false && capture.rawResponsesPersisted === false, "capture privacy fields");
  const bucketKeys = ["totalRequestCountBucket", "callRequestCountBucket", "codeRequestCountBucket",
    "storageRequestCountBucket", "logRequestCountBucket", "blockRequestCountBucket", "retryCountBucket",
    "returnedLogCountBucket", "responseByteMagnitudeBucket", "chunkCountBucket", "timestampFetchCountBucket",
    "uniqueHeaderCountBucket"];
  check(bucketKeys.every((key) => capture.budget[key] === "0"), "retained zero budget buckets");
  check(capture.budget.exhausted === null && capture.budget.allWithinCaps === true,
    "retained budget exhausted/allWithin ambiguity");

  check(closeout.schema === "symbiotic-vaultv2-donation-step2-closeout-v1" &&
    closeout.classification === CLASSIFICATION, "closeout classification");
  check(closeout["reason-budget-summary-cause-unresolved"] === true && closeout.rootCauseRetained === false,
    "reason-budget-summary cause unresolved flag");
  check(closeout.zeroEndpointCallsInferred === false && closeout.providerAbsenceInferred === false &&
    closeout.specificExhaustedResourceInferred === false && closeout.runtimeConfigHistoryAssessed === false,
  "no unsupported inference");
  check(closeout.consumption.approvalConsumed === true && closeout.consumption.retryAuthorized === false &&
    closeout.consumption.retryPerformed === false, "consumed/no-retry state");
  check(closeout.offlinePackaging.inventoryReads === 0 && closeout.offlinePackaging.networkReads === 0 &&
    closeout.offlinePackaging.rpcCalls === 0 && closeout.offlinePackaging.captureExecuted === false &&
    closeout.offlinePackaging.retryPerformed === false, "offline packaging boundary");

  check(checkOnly.exitCode === 0 && checkOnly.parsed.status === "PREPARED_NOT_AUTHORIZED_NOT_EXECUTED",
    "check-only status");
  check(checkOnly.parsed.networkReads === 0 && checkOnly.parsed.inventoryReads === 0 &&
    checkOnly.parsed.captureExecuted === false && checkOnly.parsed.writes === 0, "check-only no access/write");
  check(checkOnly.parsed.proposalId === runner.PROPOSAL_ID &&
    checkOnly.parsed.authorization.requestedApprovalId === runner.REQUESTED_APPROVAL_ID, "check-only lineage");

  check(manifest.schema === "symbiotic-vaultv2-donation-step2-closeout-package-v1" &&
    manifest.classification === CLASSIFICATION, "closeout manifest identity");
  check(manifest.approvalConsumed === true && manifest.retryAuthorized === false &&
    manifest.reasonBudgetSummaryCauseUnresolved === true, "closeout manifest state");
  check(manifest.records.length === PACKAGE_INPUTS.length, "closeout manifest record count");
  for (const row of manifest.records) {
    const current = record(row.path);
    check(PACKAGE_INPUTS.includes(row.path) && current.sha256 === row.sha256 && current.bytes === row.bytes,
      `closeout record ${row.path}`);
  }
  check(aggregate(manifest.records) === manifest.aggregateSha256, "closeout aggregate recompute");

  const jsonFiles = [PATHS.approval, PATHS.ledger, PATHS.capture, PATHS.preflightManifest, PATHS.proposal,
    PATHS.preflight, PATHS.closeout, PATHS.checkOnly, PATHS.manifest, PATHS.inbox];
  for (const relative of jsonFiles) {
    const text = fs.readFileSync(absolute(relative), "utf8");
    check(text.endsWith("\n") && !text.split(/\r?\n/u).some((line) => /[ \t]+$/u.test(line)), `JSON whitespace ${relative}`);
    check(JSON.parse(text) !== null, `JSON parse ${relative}`);
  }
  const allowedAddresses = new Set(Object.values(runner.CANONICAL).map((value) => value.toLowerCase()));
  for (const relative of [PATHS.capture, PATHS.closeout, PATHS.checkOnly, PATHS.report, PATHS.inbox, PATHS.handoff]) {
    const text = fs.readFileSync(absolute(relative), "utf8");
    for (const match of text.matchAll(/0x[0-9a-f]{40}(?![0-9a-f])/giu)) {
      check(allowedAddresses.has(match[0].toLowerCase()), `noncanonical address leak ${relative}`);
    }
    for (const match of text.matchAll(/(?:https?|wss?):\/\/[^\s"'<>`]+/giu)) {
      check(match[0] === runner.DOCS_URL, `URL leak ${relative}`);
    }
    check(!/"(?:endpointUrl|providerUrl)"\s*:/iu.test(text), `endpoint key leak ${relative}`);
    check(!/"(?:transactionHash|blockHash|rawResponse|calldata)"\s*:\s*(?:"|true\b|\{|\[|[0-9-])/iu.test(text),
      `identifier/raw value leak ${relative}`);
  }
  const report = fs.readFileSync(absolute(PATHS.report), "utf8");
  for (const phrase of [CLASSIFICATION, "reason-budget-summary-cause-unresolved=true", "does **not** prove that inventory was subsequently read",
    "zero endpoint calls", "provider absence", "which budget resource exhausted", "Root cause was not retained",
    "new separately reviewed package and new authorization", IMMUTABLE_EXPECTED[PATHS.capture][0],
    IMMUTABLE_EXPECTED[PATHS.approval][0], IMMUTABLE_EXPECTED[PATHS.ledger][0]]) {
    check(report.includes(phrase), `report missing ${phrase}`);
  }

  return {
    schema: "symbiotic-vaultv2-donation-step2-closeout-validation-v1",
    status: "PASS",
    classification: CLASSIFICATION,
    checks,
    approvalSha256: IMMUTABLE_EXPECTED[PATHS.approval][0],
    ledgerSha256: IMMUTABLE_EXPECTED[PATHS.ledger][0],
    captureSha256: IMMUTABLE_EXPECTED[PATHS.capture][0],
    preflightManifestSha256: IMMUTABLE_EXPECTED[PATHS.preflightManifest][0],
    approvedPackageAggregateSha256: preflightManifest.aggregateSha256,
    closeoutPackageAggregateSha256: manifest.aggregateSha256,
    reasonBudgetSummaryCauseUnresolved: true,
    approvalConsumed: true,
    retryAuthorized: false,
    inventoryReads: 0,
    networkReads: 0,
    rpcCalls: 0,
    retryPerformed: false
  };
}

function main() {
  const result = process.argv.includes("--prepare-closeout") ? prepare() : validate();
  if (process.argv.includes("--write-result")) writeJson(PATHS.validatorOutput, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { prepare, validate, PATHS, IMMUTABLE_EXPECTED };
