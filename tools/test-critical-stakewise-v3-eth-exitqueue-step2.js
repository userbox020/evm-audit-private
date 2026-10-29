#!/usr/bin/env node
"use strict";

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const { Interface, id } = require("ethers");
const runner = require("./critical-stakewise-v3-eth-exitqueue-step2-runner.js");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_PATH = path.join(__dirname, "fixtures", "critical-stakewise-v3-eth-exitqueue-step2-fixtures.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const ADDRESS_A = fixture.addresses.alice;
const ADDRESS_B = fixture.addresses.bob;
const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;
let checks = 0;

function check(condition, message) {
  checks += 1;
  assert.ok(condition, `check ${checks}: ${message}`);
}

function equal(actual, expected, message) {
  checks += 1;
  assert.deepStrictEqual(actual, expected, `check ${checks}: ${message}`);
}

function eventFromJson(row) {
  const result = { ...row };
  for (const key of ["ticket", "shares", "timestamp", "blockNumber", "transactionIndex", "logIndex", "assets",
    "prevTicket", "newTicket", "withdrawnAssets"]) {
    if (Object.prototype.hasOwnProperty.call(result, key)) result[key] = BigInt(result[key]);
  }
  return result;
}

function rawLog(iface, eventName, args, options = {}) {
  const encoded = iface.encodeEventLog(iface.getEvent(eventName), args);
  return {
    address: options.address || ADDRESS_A,
    blockNumber: `0x${BigInt(options.blockNumber || 10).toString(16)}`,
    transactionIndex: `0x${BigInt(options.transactionIndex || 0).toString(16)}`,
    logIndex: `0x${BigInt(options.logIndex || 0).toString(16)}`,
    blockHash: options.blockHash || HASH_A,
    transactionHash: options.transactionHash || HASH_B,
    data: encoded.data,
    topics: encoded.topics,
    removed: options.removed === undefined ? false : options.removed
  };
}

function approvalAt(now) {
  const expected = {
    runnerSha256: `0x${"11".repeat(32)}`,
    packageManifestSha256: `0x${"22".repeat(32)}`,
    packageAggregateSha256: `0x${"33".repeat(32)}`,
    proposalCommitment: `0x${"44".repeat(32)}`,
    packageSourceBinding: `0x${"55".repeat(32)}`
  };
  const approvalPayload = {
    approvalId: "swv3-step2-0123456789abcdef0123456789abcdef",
    findingId: "stakewise-v3-eth-exitqueue-step2",
    chainId: 1,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    authorizedCaptureCount: 1,
    fixedOutputPath: runner.FIXED_OUTPUT_REL,
    globalConsumptionLedger: runner.GLOBAL_LEDGER_REL,
    endpointInventoryReadAuthorized: true,
    traceAuthorized: false,
    transactionsAuthorized: false,
    forkAuthorized: false,
    runnerSha256: expected.runnerSha256,
    packageManifestSha256: expected.packageManifestSha256,
    packageAggregateSha256: expected.packageAggregateSha256,
    proposalCommitment: expected.proposalCommitment,
    packageSourceBinding: expected.packageSourceBinding,
    capsCommitment: runner.bytes32Commitment(runner.CAPS),
    allowedMethods: [...runner.ALLOWED_METHODS].sort()
  };
  return {
    expected,
    approval: {
      schemaVersion: 2,
      state: "AUTHORIZED",
      approvalPayload,
      approvalCommitment: runner.bytes32Commitment(approvalPayload)
    }
  };
}

function throwsCode(fn, code, message) {
  checks += 1;
  assert.throws(fn, new RegExp(code, "u"), `check ${checks}: ${message}`);
}

async function main() {
  equal(fixture.oracleCorrectionCases.length, 22, "all requested Oracle fixture classes listed");
  const dry = runner.dryPreflight();
  equal(dry.status, "PREPARED_NOT_AUTHORIZED_NOT_EXECUTED", "dry status");
  equal([dry.authorization.proposalState, dry.authorization.proposalAuthorization], ["REVIEW_REQUESTED", "NOT_AUTHORIZED"],
    "proposal stays unauthorized");
  equal([dry.networkReads, dry.inventoryReads, dry.writes], [0, 0, 0], "check-only side effects declared zero");
  equal([dry.gates.routePositive, dry.gates.executableNow, dry.gates.signedActionJustified, dry.gates.fork],
    [0, 0, false, false], "operational gates fixed closed");
  equal(dry.localMap.boundFileCount, runner.BOUND_FILES.length, "all exact source/ABI inputs bound");
  check(/^0x[0-9a-f]{64}$/u.test(dry.localMap.packageSourceBinding), "source binding strict bytes32");

  equal(runner.parseArgs(["node", "runner", "--check-only"]), { capture: false, checkOnly: true, approvalFile: null },
    "explicit check-only mode");
  throwsCode(() => runner.parseArgs(["node", "runner", "--check-only", "--capture-once"]), "MODE_CONFLICT",
    "check-only and capture mutually exclusive");
  throwsCode(() => runner.parseArgs(["node", "runner", "--capture-once", "--output", "changed.json"]),
    "UNKNOWN_ARGUMENT", "capture output path cannot be overridden");
  const outputPath = path.join(ROOT, ...runner.FIXED_OUTPUT_REL.split("/"));
  const ledgerPath = path.join(ROOT, ...runner.GLOBAL_LEDGER_REL.split("/"));
  const before = [fs.existsSync(outputPath), fs.existsSync(ledgerPath)];
  const invoked = cp.spawnSync(process.execPath,
    [path.join(__dirname, "critical-stakewise-v3-eth-exitqueue-step2-runner.js"), "--check-only"],
    { cwd: ROOT, encoding: "utf8" });
  equal(invoked.status, 0, "check-only exits zero");
  equal(JSON.parse(invoked.stdout).status, dry.status, "check-only output");
  equal(invoked.stderr, "", "check-only stderr empty");
  equal([fs.existsSync(outputPath), fs.existsSync(ledgerPath)], before, "check-only creates no capture or ledger");

  const now = Date.parse("2026-07-30T23:40:00.000Z");
  const approvalFixture = approvalAt(now);
  equal(runner.validateApprovalEnvelope(approvalFixture.approval,
    { now, expected: approvalFixture.expected, consumed: false }).approvalId,
  approvalFixture.approval.approvalPayload.approvalId, "fresh exact approval validates");
  throwsCode(() => runner.validateApprovalEnvelope(approvalFixture.approval,
    { now, expected: approvalFixture.expected, consumed: true }), "APPROVAL_ALREADY_CONSUMED", "global replay rejected");
  const changedPath = JSON.parse(JSON.stringify(approvalFixture.approval));
  changedPath.approvalPayload.fixedOutputPath = `${runner.FIXED_OUTPUT_REL}.changed`;
  changedPath.approvalCommitment = runner.bytes32Commitment(changedPath.approvalPayload);
  throwsCode(() => runner.validateApprovalEnvelope(changedPath,
    { now, expected: approvalFixture.expected, consumed: false }), "APPROVAL_BINDING_INVALID", "output path change rejected");
  const expired = approvalAt(now).approval;
  expired.approvalPayload.issuedAt = new Date(now - 120000).toISOString();
  expired.approvalPayload.expiresAt = new Date(now - 1).toISOString();
  expired.approvalCommitment = runner.bytes32Commitment(expired.approvalPayload);
  throwsCode(() => runner.validateApprovalEnvelope(expired,
    { now, expected: approvalFixture.expected, consumed: false }), "APPROVAL_WINDOW_INVALID", "expired approval rejected");
  const badCommitment = approvalAt(now).approval;
  badCommitment.approvalCommitment = HASH_A;
  throwsCode(() => runner.validateApprovalEnvelope(badCommitment,
    { now, expected: approvalFixture.expected, consumed: false }), "APPROVAL_COMMITMENT_INVALID", "approval commitment exact");

  const registryIface = new Interface([
    "event FactoryAdded(address indexed factory)",
    "event FactoryRemoved(address indexed factory)",
    "event VaultAdded(address indexed caller,address indexed vault)",
    "event VaultImplAdded(address indexed impl)"
  ]);
  const registryRows = [
    rawLog(registryIface, "FactoryAdded", [ADDRESS_A], { address: ADDRESS_B, logIndex: 0 }),
    rawLog(registryIface, "FactoryRemoved", [ADDRESS_A], { address: ADDRESS_B, logIndex: 1, transactionHash: HASH_A })
  ].map((row) => runner.validateLog(row, new Set([ADDRESS_B]), 0n, 20n));
  const discovery = runner.parseRegistryDiscovery(registryRows);
  equal([discovery.factories.size, discovery.factoriesAdded.size, discovery.factoriesRemoved.size], [1, 1, 1],
    "removed factory remains in historical set");
  const factoryIface = new Interface([
    "event VaultCreated(address indexed admin,address indexed vault,address ownMevEscrow,bytes params)",
    "event MetaVaultCreated(address indexed caller,address indexed admin,address indexed vault,bytes params)"
  ]);
  const factoryRows = [
    rawLog(factoryIface, "VaultCreated", [ADDRESS_A, ADDRESS_B, "0x0000000000000000000000000000000000000000", "0x"],
      { address: ADDRESS_A, logIndex: 0 }),
    rawLog(factoryIface, "MetaVaultCreated", [ADDRESS_A, ADDRESS_A, ADDRESS_B, "0x"],
      { address: ADDRESS_A, logIndex: 1, transactionHash: HASH_A })
  ].map((row) => runner.validateLog(row, new Set([ADDRESS_A]), 0n, 20n));
  const created = runner.parseFactoryVaults(factoryRows);
  equal([created.vaultCreatedCount, created.metaVaultCreatedCount, created.vaults.size], [1, 1, 1],
    "both factory creation signatures supported");
  equal(runner.compareCandidateMembership(true, true), { complete: true, active: true }, "symmetric active membership");
  equal(runner.compareCandidateMembership(false, false), { complete: true, active: false }, "symmetric removed membership");
  equal(runner.compareCandidateMembership(true, false), { complete: false, active: null }, "asymmetric membership incomplete");

  const validRaw = rawLog(registryIface, "FactoryAdded", [ADDRESS_A], { address: ADDRESS_B });
  const valid = runner.validateLog(validRaw, new Set([ADDRESS_B]), 0n, 20n);
  check(valid !== null, "valid bounded nonremoved log");
  equal(runner.validateLog({ ...validRaw, removed: true }, new Set([ADDRESS_B]), 0n, 20n), null, "removed log rejected");
  equal(runner.validateLog({ ...validRaw, blockNumber: "0x20" }, new Set([ADDRESS_B]), 0n, 20n), null,
    "out-of-range log rejected");
  equal(runner.validateLog({ ...validRaw, topics: ["0x12"] }, new Set([ADDRESS_B]), 0n, 20n), null,
    "malformed topic rejected");
  equal(runner.canonicalLogsMatchHeaders([valid], new Map([["10", { number: 10n, hash: HASH_A }]])), true,
    "canonical log hash accepted");
  equal(runner.canonicalLogsMatchHeaders([valid], new Map([["10", { number: 10n, hash: HASH_B }]])), false,
    "noncanonical block hash rejected");
  const deduped = runner.dedupeLogs([valid, { ...valid }]);
  equal([deduped.ok, deduped.logs.length, deduped.duplicateCount], [true, 1, 1], "identical logs deduplicated");
  equal(runner.dedupeLogs([valid, { ...valid, data: "0x12" }]).ok, false, "conflicting duplicate rejected");

  const migrationCheckpoints = [
    { totalTickets: 2n, exitedAssets: 0n },
    { totalTickets: 4n, exitedAssets: 4n }
  ];
  equal(runner.calculateExitedAssets(migrationCheckpoints, 0, 0n, 2n),
    { ok: true, burnedShares: 2n, exitedAssets: 4n, migration: true }, "exact V2-to-V3 zero-asset migration math");
  equal(runner.calculateExitedAssets(migrationCheckpoints, 0, 0n, 3n).error, "INVALID_V2_V3_MIGRATION",
    "migration share overflow rejected");
  const migrationEvents = [
    { type: "enterV2", receiver: ADDRESS_A, ticket: 0n, shares: 2n, assets: 2n, timestamp: 1n,
      blockNumber: 1n, transactionIndex: 0n, logIndex: 0n },
    { type: "checkpoint", shares: 2n, assets: 0n, blockNumber: 2n, transactionIndex: 0n, logIndex: 0n },
    { type: "checkpoint", shares: 2n, assets: 4n, blockNumber: 3n, transactionIndex: 0n, logIndex: 0n },
    { type: "claim", receiver: ADDRESS_A, prevTicket: 0n, newTicket: 0n, withdrawnAssets: 4n,
      blockNumber: 4n, transactionIndex: 0n, logIndex: 0n }
  ];
  const migrationReplay = runner.replayHistory(migrationEvents, { completeHistory: true });
  equal([migrationReplay.prefixValid, migrationReplay.ambiguousCount, migrationReplay.activeRequestCount], [true, 0, 0],
    "migration event prefix replays completely");
  const oneTicket = fixture.oneTicketEvents.map(eventFromJson);
  equal(runner.replayHistory(oneTicket, { completeHistory: true }).provenCandidateCount, 1, "complete one-ticket prefix proven");
  const incompleteReplay = runner.replayHistory(oneTicket, { completeHistory: false });
  equal([incompleteReplay.prefixValid, incompleteReplay.provenCandidateCount, incompleteReplay.nullCandidateCount], [false, 0, 1],
    "incomplete prefix nulls proof");
  const ambiguousReplay = runner.replayHistory([...oneTicket, { ...oneTicket[2], logIndex: 1n }], { completeHistory: true });
  equal([ambiguousReplay.prefixValid, ambiguousReplay.provenCandidateCount], [false, 0], "ambiguous relevant prefix invalidates proof");

  const failClosed = runner.failClosedCapture("TERMINAL_PIN_MISMATCH", new runner.Budget().summary());
  equal(Object.values(failClosed.promotionGates), [null, null, null, null, null, null], "all failed promotion gates null");
  equal([failClosed.operationalGates.routePositive, failClosed.operationalGates.executableNow,
    failClosed.operationalGates.signedActionJustified, failClosed.operationalGates.fork], [0, 0, false, false],
  "failed operational gates remain closed");

  throwsCode(() => runner.sanitizeCapture({ receiverAddress: ADDRESS_A }), "OUTPUT_IDENTITY_LEAK", "receiver leak rejected");
  throwsCode(() => runner.sanitizeCapture({ anything: ADDRESS_A }), "OUTPUT_ADDRESS_LEAK", "raw address leak rejected");
  throwsCode(() => runner.sanitizeCapture({ positionTicket: "1" }), "OUTPUT_IDENTITY_LEAK", "ticket leak rejected");
  equal(runner.sanitizeCapture({ eventShapeCount: 2, aggregateEventShapeCommitment: HASH_A }),
    { eventShapeCount: 2, aggregateEventShapeCommitment: HASH_A }, "nonidentifying aggregate shape accepted");

  const observations = fixture.pinObservations.map((row) => ({
    ...row,
    header: { ...row.header, number: BigInt(row.header.number), timestamp: BigInt(row.header.timestamp) }
  }));
  equal(runner.selectPin(observations).families, ["F1", "F2"], "two-family plausible pin selected");
  const oversized = observations.map((row) => ({ ...row, header: { ...row.header, number: BigInt(runner.CAPS.maxPlausiblePin + 1) } }));
  equal(runner.selectPin(oversized).promotable, false, "oversized pin rejected");
  equal(runner.validateScanRange(0n, BigInt(runner.CAPS.maxScanSpanBlocks - 1)), true, "maximum scan span accepted");
  equal(runner.validateScanRange(0n, BigInt(runner.CAPS.maxScanSpanBlocks)), false, "oversized scan span rejected");

  const logBudget = new runner.Budget({ ...runner.CAPS, maxLogs: 1 });
  logBudget.consumeLogRow();
  throwsCode(() => logBudget.consumeLogRow(), "BUDGET_EXHAUSTED_LOG_ROWS", "global returned-log cap");
  const byteBudget = new runner.Budget({ ...runner.CAPS, maxAggregateResponseBytes: 1 });
  throwsCode(() => byteBudget.consumeResponseBytes(2), "BUDGET_EXHAUSTED_AGGREGATE_RESPONSE_BYTES", "global byte cap");
  const chunkBudget = new runner.Budget({ ...runner.CAPS, maxChunks: 0 });
  throwsCode(() => chunkBudget.consumeChunk(), "BUDGET_EXHAUSTED_CHUNKS", "global chunk cap");
  const timestampBudget = new runner.Budget({ ...runner.CAPS, maxTimestampFetches: 0 });
  throwsCode(() => timestampBudget.consumeTimestamp(), "BUDGET_EXHAUSTED_TIMESTAMPS", "global timestamp cap");
  const blockBudget = new runner.Budget({ ...runner.CAPS, maxBlockRequests: 0 });
  throwsCode(() => blockBudget.consume("eth_getBlockByNumber"), "BUDGET_EXHAUSTED_BLOCK_REQUESTS", "global block cap");
  let clock = 0;
  const timeBudget = new runner.Budget({ ...runner.CAPS, maxElapsedMs: 1 }, () => { clock += 2; return clock; });
  throwsCode(() => timeBudget.consume("eth_chainId"), "BUDGET_EXHAUSTED_TIME", "global elapsed-time cap");

  const exactInput = {
    version: 5,
    observedImplementationRuntimeHash: HASH_A,
    observedProxyRuntimeHash: HASH_B,
    observedVaultId: id("EthVault"),
    implementationViewMatchedSlot: true,
    implementationRegistryMember: true,
    vaultRegistryMember: true,
    factoryLineageComplete: true,
    dualFamilyAgreement: true,
    v5Bundle: {
      constructorImmutablesReconstructed: true,
      compiler: "0.8.26",
      evmVersion: "cancun",
      optimizer: true,
      optimizerRuns: 200,
      viaIR: true,
      expectedImplementationRuntimeHash: HASH_A,
      expectedProxyRuntimeHash: HASH_B,
      expectedNativeVaultId: id("EthVault")
    }
  };
  equal(runner.classifyRuntime(exactInput).exactAffectedRuntime, true, "strict exact proxy/implementation/native-ID binding");
  equal(runner.classifyRuntime({ ...exactInput, observedProxyRuntimeHash: HASH_A }).exactAffectedRuntime, false,
    "false exact proxy runtime rejected");
  equal(runner.classifyRuntime({ ...exactInput, observedImplementationRuntimeHash: HASH_B }).exactAffectedRuntime, false,
    "false exact implementation runtime rejected");
  equal(runner.classifyRuntime({ ...exactInput, implementationViewMatchedSlot: null }).exactAffectedRuntime, null,
    "view return alone does not prove implementation slot");
  const v7 = runner.classifyRuntime({ ...exactInput, version: 7 });
  equal([v7.exactAffectedRuntime, v7.v5EquivalenceClaimed, v7.newerVersionNonEquivalent], [null, false, true],
    "v7 remains non-equivalent");

  const source = fs.readFileSync(path.join(__dirname, "critical-stakewise-v3-eth-exitqueue-step2-runner.js"), "utf8");
  const mainSource = source.slice(source.indexOf("async function main"));
  check(mainSource.indexOf("if (!args.capture)") < mainSource.indexOf("runCapture(args)"), "check-only exits before capture workflow");
  const captureSource = source.slice(source.indexOf("async function runCapture"));
  check(captureSource.indexOf("validateApproval(args)") < captureSource.indexOf("consumeApprovalAtomically(authorization)"),
    "approval validated before atomic consumption");
  check(captureSource.indexOf("consumeApprovalAtomically(authorization)") < captureSource.indexOf("loadInventoryAuthorized()"),
    "global consumption occurs before inventory access");
  equal((source.match(/loadInventoryAuthorized\(\)/gu) || []).length, 2, "inventory has one definition and capture-only call");

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    fixtureClasses: fixture.oracleCorrectionCases.length,
    networkReads: 0,
    inventoryReads: 0,
    captureExecuted: false,
    writesOutsideOfflineArtifacts: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
