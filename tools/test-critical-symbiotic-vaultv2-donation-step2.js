#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AbiCoder, id, zeroPadValue, toBeHex } = require("ethers");
const R = require("./critical-symbiotic-vaultv2-donation-step2-runner.js");

const ROOT = path.resolve(__dirname, "..");
const PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "critical-symbiotic-vaultv2-donation-step2-fixtures.json"), "utf8"));
const TEMP_BASE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "Temp", "opencode");
const ZERO = "0x0000000000000000000000000000000000000000";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const ENTITY = "0x3333333333333333333333333333333333333333";
const TX1 = `0x${"11".repeat(32)}`;
const TX2 = `0x${"22".repeat(32)}`;
const BLOCK_HASH = `0x${"aa".repeat(32)}`;
const abi = AbiCoder.defaultAbiCoder();
const executed = [];
const covered = new Set();
let assertions = 0;

function ok(value, message) { assert(value, message); assertions += 1; }
function equal(actual, expected, message) { assert.deepStrictEqual(actual, expected, message); assertions += 1; }
function throws(fn, pattern, message) { assert.throws(fn, pattern, message); assertions += 1; }
async function rejects(fn, pattern, message) { await assert.rejects(fn, pattern, message); assertions += 1; }
async function test(name, classes, fn, kind = "unit") {
  const before = assertions;
  for (const coverage of classes) covered.add(coverage);
  await fn();
  executed.push({ name, kind, assertions: assertions - before, coverageClasses: classes });
}
function caps(overrides = {}) { return { ...R.CAPS, ...overrides }; }
function word(value) { return zeroPadValue(toBeHex(value), 32).toLowerCase(); }
function header(number = 100n, hash = BLOCK_HASH) {
  return { number: R.toQuantity(number), hash, parentHash: `0x${"bb".repeat(32)}`, stateRoot: `0x${"cc".repeat(32)}`,
    receiptsRoot: `0x${"dd".repeat(32)}`, timestamp: "0x64" };
}
function parsedHeader(number = 100n, hash = BLOCK_HASH) {
  return { number, hash, parentHash: `0x${"bb".repeat(32)}`, stateRoot: `0x${"cc".repeat(32)}`,
    receiptsRoot: `0x${"dd".repeat(32)}`, timestamp: 100n };
}
function baseLog({ topic = id("Transfer(address,address,uint256)"), topic1 = null, data = "0x", block = 1n,
  tx = TX1, index = 0n, address = R.CANONICAL.VaultFactory } = {}) {
  return { address, blockNumber: block, transactionIndex: 0n, logIndex: index, blockHash: BLOCK_HASH,
    transactionHash: tx, data, topics: topic1 ? [topic, topic1] : [topic] };
}
function expectedBindings() {
  return {
    fixedApprovalPath: R.FIXED_APPROVAL_REL,
    fixedOutputPath: R.FIXED_OUTPUT_REL,
    globalConsumptionLedger: R.GLOBAL_LEDGER_REL,
    proposalId: R.PROPOSAL_ID,
    runnerSha256: `0x${"01".repeat(32)}`,
    packageManifestSha256: `0x${"02".repeat(32)}`,
    packageAggregateSha256: `0x${"03".repeat(32)}`,
    proposalCommitment: `0x${"04".repeat(32)}`,
    packageSourceBinding: `0x${"05".repeat(32)}`,
    capsCommitment: R.commitment(R.CAPS)
  };
}
function approvalEnvelope(now, expected = expectedBindings()) {
  const payload = {
    ...expected,
    approvalId: R.REQUESTED_APPROVAL_ID,
    findingId: R.FINDING_ID,
    chainId: R.CHAIN_ID,
    authorizedCaptureCount: 1,
    endpointInventoryReadAuthorized: true,
    transactionsAuthorized: false,
    traceAuthorized: false,
    forkAuthorized: false,
    allowedMethods: [...R.ALLOWED_METHODS].sort(),
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString()
  };
  return { schemaVersion: 1, state: "AUTHORIZED", approvalPayload: payload, approvalCommitment: R.commitment(payload) };
}
function tempPaths(root, name) {
  return { ledgerPath: path.join(root, `${name}.ledger.json`), outputPath: path.join(root, `${name}.capture.json`) };
}
function context(overrides = {}) {
  const activeCaps = caps(overrides.caps || {});
  return { caps: activeCaps, budget: new R.Budget(activeCaps, overrides.now || (() => Date.now())), nextId: 0,
    ...overrides, caps: activeCaps };
}
function exactRow({ eligible = true, nominal = 1 } = {}) {
  return { current: { classification: { exactVaultV2: true, reason: null }, config: {
    decimals: eligible ? 18 : 6, depositWhitelist: false, isDepositLimit: false, totalAssets: 1n,
    feePreview: { managementShares: 0n, performanceShares: 0n, protocolShares: 0n }
  } }, history: { zero: { complete: true, nominalCount: nominal, actualLossCount: null,
    nominalAssetMagnitude: BigInt(nominal) }, shares: { complete: true, currentSupply: 0n, currentHolderCount: 0,
    zeroSupplyWindowCount: 0, soleHolderWindowCount: 0 }, donationCandidates: 0,
  queueContext: { requestCount: 0, fillCount: 0, claimCount: 0 } } };
}
function completeSynthetic() {
  const aggregate = R.aggregateCaptureRows([exactRow()]);
  return { schemaVersion: 1, findingId: R.FINDING_ID, status: "SANITIZED_CAPTURE_COMPLETE",
    chain: { name: "ethereum-mainnet", chainId: 1 }, canonicalManifest: R.canonicalManifestEvidence(),
    pin: { identifiersPersisted: false, familyCountBucket: "1-2", commonMinimumFinalized: true, terminalRechecked: true },
    ...aggregate, operationalGates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    budget: R.privacyBudgetSummary(new R.Budget().summary()), captureAttempted: true, sanitized: true };
}

function fullProductionAdapters(overrides = {}) {
  const lifecycle = { complete: true, initialVersion: 3n, migrationCount: 0, vaultV2InitializeAtCreation: true,
    exactV2Interval: { version: 3n, fromBlock: 1n, toBlock: 100n }, noSuccessfulMigrateIntoOrDuringV2: true };
  const config = { requiredReadsComplete: true, decimals: 18, depositWhitelist: false, isDepositLimit: false,
    totalAssets: 1n, feePreview: { managementShares: 0n, performanceShares: 0n, protocolShares: 0n } };
  const current = { implementation: A, version: 3n, classification: { exactVaultV2: true, reason: null },
    conclusiveNonV2: false, config, lifecycle, completeness: { implementationAddress: true, proxyRuntimeExact: true,
      implementationCodeCanonicalNonempty: true, runtimeComparisonComplete: true, lifecycleComplete: true,
      versionImplementationBound: true } };
  const history = { zero: { complete: true, nominalCount: 1, actualLossCount: null, nominalAssetMagnitude: 1n },
    shares: { complete: true, currentSupply: 0n, currentHolderCount: 0, zeroSupplyWindowCount: 0,
      soleHolderWindowCount: 0, pendingFeeShares: 0n }, donationCandidates: 0,
    queueContext: { requestCount: 0, fillCount: 0, claimCount: 0 }, storedSupplyReconciled: true };
  const factory = { entities: [ENTITY], versions: [{ version: 3n, implementation: A, blacklisted: false }],
    addEntities: [{ entity: ENTITY, blockNumber: 1n }], versionHistory: { complete: true, migrations: [] } };
  const selected = [{ family: "F1", hostname: "one.invalid" }, { family: "F2", hostname: "two.invalid" }];
  return {
    loadInventory: async () => [{ hostname: "one.invalid" }, { hostname: "two.invalid" }],
    qualifyFamilies: async () => selected,
    selectPinnedFamilies: async () => ({ selected, selection: { promotable: true, pin: 100n,
      blockHash: BLOCK_HASH, familyCount: 2 } }),
    captureCanonicalDependencyRuntimes: async () => ({ exact: true, results: { all: true } }),
    captureFactory: async () => factory,
    readCurrentVersion: async () => 3n,
    captureEntityLifecycle: async () => lifecycle,
    captureEntityCurrent: async () => current,
    captureEntityHistory: async () => history,
    readTerminalHeader: async () => parsedHeader(100n),
    ...overrides,
    __rows: { lifecycle, config, current, history, factory, selected }
  };
}

async function fullCliCapture(root, name, adapterOverrides = {}, options = {}) {
  const now = options.now || Date.now();
  const expected = expectedBindings();
  const approval = options.approval || approvalEnvelope(now, expected);
  const approvalTemp = path.join(root, `${name}.approval.json`);
  fs.writeFileSync(approvalTemp, `${JSON.stringify(approval)}\n`, "utf8");
  const paths = tempPaths(root, name);
  let fixedPathObserved = false;
  const result = await R.executeCaptureCli(options.argv || ["node", "runner", "--capture-once", "--approval-file",
    R.FIXED_APPROVAL_REL], { packageContext: { expected }, approvalLoader: async (requestedPath) => {
      fixedPathObserved = requestedPath === path.join(ROOT, ...R.FIXED_APPROVAL_REL.split("/"));
      return JSON.parse(fs.readFileSync(approvalTemp, "utf8"));
    }, ledgerPath: paths.ledgerPath, outputPath: paths.outputPath, now,
  context: options.context || context(), adapters: fullProductionAdapters(adapterOverrides) });
  ok(fixedPathObserved, `${name} fixed approval path observed`);
  return { result, ...paths, approvalTemp, expected, now };
}
async function orchestrate(root, name, operation, options = {}) {
  const paths = tempPaths(root, name);
  const now = options.now || Date.now();
  return R.orchestrateApprovedCapture({ approval: options.approval || approvalEnvelope(now),
    expected: options.expected || expectedBindings(), now, ...paths, context: options.context || context(),
    captureOperation: operation });
}
function assertIncomplete(result, reason) {
  equal(result.status, "INCOMPLETE_ALL_PROMOTION_GATES_NULL", `${reason} incomplete status`);
  equal(result.reasonCode, reason, `${reason} fixed reason`);
  ok(Object.values(result.promotionGates).every((value) => value === null), `${reason} all-null gates`);
}
function streamResponse(value, status = 200, contentLength = null) {
  const bytes = Buffer.from(JSON.stringify(value));
  const parts = [bytes.subarray(0, Math.ceil(bytes.length / 2)), bytes.subarray(Math.ceil(bytes.length / 2))];
  return { status, redirected: false, headers: { get: () => contentLength },
    body: { async *[Symbol.asyncIterator]() { for (const part of parts) yield part; } } };
}

async function main() {
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(TEMP_BASE, "sym-v2-step2-r3-"));
  let output;
  try {
    await test("approval-success-ledger-output-orchestrator", ["approval-orchestrator-end-to-end"], async () => {
      const result = await orchestrate(tempRoot, "approval-success", async () => completeSynthetic());
      equal(result.status, "SANITIZED_CAPTURE_COMPLETE", "complete orchestration");
      ok(fs.existsSync(tempPaths(tempRoot, "approval-success").ledgerPath), "temporary ledger created");
      ok(fs.existsSync(tempPaths(tempRoot, "approval-success").outputPath), "temporary output created");
    });

    await test("approval-replay-path-expiry-and-mode-conflicts", ["approval-replay-path-expiry", "mode-conflicts"], async () => {
      const now = Date.now();
      await orchestrate(tempRoot, "replay", async () => completeSynthetic(), { now });
      fs.unlinkSync(tempPaths(tempRoot, "replay").outputPath);
      await rejects(() => orchestrate(tempRoot, "replay", async () => completeSynthetic(), { now }), /APPROVAL_ALREADY_CONSUMED/u,
        "replay rejected by real ledger");
      const wrong = approvalEnvelope(now);
      wrong.approvalPayload.fixedOutputPath = "wrong";
      wrong.approvalCommitment = R.commitment(wrong.approvalPayload);
      await rejects(() => orchestrate(tempRoot, "wrong-path", async () => completeSynthetic(), { now, approval: wrong }),
        /APPROVAL_BINDING_INVALID/u, "path substitution rejected");
      const expired = approvalEnvelope(now);
      expired.approvalPayload.issuedAt = new Date(now - 700000).toISOString();
      expired.approvalPayload.expiresAt = new Date(now - 1).toISOString();
      expired.approvalCommitment = R.commitment(expired.approvalPayload);
      await rejects(() => orchestrate(tempRoot, "expired", async () => completeSynthetic(), { now, approval: expired }),
        /APPROVAL_WINDOW_INVALID/u, "expiry rejected");
      throws(() => R.parseArgs(["node", "runner", "--check-only", "--capture-once"]), /MODE_CONFLICT/u, "mode conflict");
    });

    const factoryArtifact = JSON.parse(fs.readFileSync(path.join(ROOT, "targets", "symbiotic-core-83a3a9ab", "out",
      "VaultFactory.sol", "VaultFactory.json"), "utf8"));
    const factoryRuntime = R.exactArtifactRuntime(factoryArtifact);
    async function dependencyResult(rootName, code, artifactLoader = () => factoryArtifact) {
      const ctx = context();
      ctx.dependencyBindings = [["VaultFactory", "fixture-artifact"]];
      ctx.artifactLoader = artifactLoader;
      ctx.rpcRequest = async () => ({ ok: true, result: code });
      return orchestrate(tempRoot, rootName, async () => {
        await R.captureCanonicalDependencyRuntimes([{ family: "F1" }, { family: "F2" }], 1n, ctx);
        return completeSynthetic();
      }, { context: ctx });
    }

    await test("dependency-gate-exact-before-entity-work", ["dependency-gate-before-entity-work"], async () => {
      const result = await dependencyResult("dependency-exact", factoryRuntime);
      equal(result.status, "SANITIZED_CAPTURE_COMPLETE", "exact dependency gate passes");
    });
    await test("dependency-gate-matched-runtime-mismatch", ["dependency-runtime-mismatch", "mandatory-incomplete-atomic-output"], async () => {
      assertIncomplete(await dependencyResult("dependency-mismatch", `${factoryRuntime.slice(0, -2)}00`),
        "DEPENDENCY_RUNTIME_MISMATCH");
    });
    await test("dependency-gate-dual-family-disagreement", ["dependency-dual-family-disagreement"], async () => {
      const ctx = context();
      ctx.dependencyBindings = [["VaultFactory", "fixture-artifact"]];
      ctx.artifactLoader = () => factoryArtifact;
      ctx.rpcRequest = async (endpoint) => ({ ok: true, result: endpoint.family === "F1" ? factoryRuntime :
        `${factoryRuntime.slice(0, -2)}00` });
      assertIncomplete(await orchestrate(tempRoot, "dependency-dual", async () => {
        await R.captureCanonicalDependencyRuntimes([{ family: "F1" }, { family: "F2" }], 1n, ctx);
        return completeSynthetic();
      }, { context: ctx }), "DEPENDENCY_DUAL_FAMILY_RUNTIME_UNBOUND");
    });
    await test("dependency-gate-empty-and-malformed-code", ["dependency-empty-malformed-code"], async () => {
      assertIncomplete(await dependencyResult("dependency-empty", "0x"), "DEPENDENCY_RUNTIME_EMPTY_OR_MALFORMED");
      assertIncomplete(await dependencyResult("dependency-malformed", "0XRAWDECODE"), "DEPENDENCY_RUNTIME_EMPTY_OR_MALFORMED");
    });
    await test("dependency-source-reconstruction-failure", ["dependency-source-reconstruction-failure"], async () => {
      assertIncomplete(await dependencyResult("dependency-source", factoryRuntime, () => ({})),
        "DEPENDENCY_SOURCE_RECONSTRUCTION_FAILED");
    });

    await test("qualification-threshold-failure-through-orchestrator", ["qualification-failure"], async () => {
      const ctx = context();
      ctx.rpcRequest = async (_endpoint, method) => method === "eth_chainId" ? { ok: true, result: "0x1" } :
        { ok: true, result: header() };
      const result = await orchestrate(tempRoot, "qualification", async () => {
        await R.qualifyFamilies([{ hostname: "one.invalid" }], ctx);
        return completeSynthetic();
      }, { context: ctx });
      assertIncomplete(result, "QUALIFICATION_INCOMPLETE");
    });
    await test("common-pin-header-mismatch-through-orchestrator", ["common-pin-failure"], async () => {
      const ctx = context();
      ctx.rpcRequest = async (endpoint) => ({ ok: true, result: header(100n,
        endpoint.family === "F1" ? BLOCK_HASH : `0x${"ee".repeat(32)}`) });
      const qualified = [{ family: "F1", hostname: "one.invalid", finalized: parsedHeader() },
        { family: "F2", hostname: "two.invalid", finalized: parsedHeader(101n) }];
      assertIncomplete(await orchestrate(tempRoot, "pin", async () => {
        await R.selectPinnedFamilies(qualified, ctx);
        return completeSynthetic();
      }, { context: ctx }), "PIN_VALIDATION_INCOMPLETE");
    });
    await test("terminal-pin-mismatch-through-orchestrator", ["terminal-pin-failure"], async () => {
      assertIncomplete(await orchestrate(tempRoot, "terminal", async () => {
        if (!R.terminalPinRecheck({ promotable: true, pin: 1n, blockHash: BLOCK_HASH, familyCount: 2 },
          [{ header: parsedHeader(1n) }, { header: parsedHeader(1n, `0x${"ee".repeat(32)}`) }])) {
          throw new Error("TERMINAL_PIN_MISMATCH");
        }
        return completeSynthetic();
      }), "TERMINAL_PIN_INCOMPLETE");
    });

    for (const [name, error, reason, coverage] of [
      ["history", "MALFORMED_VAULT_HISTORY", "HISTORY_INCOMPLETE", "history-failure"],
      ["runtime", "RUNTIME_BINDING_INCOMPLETE", "RUNTIME_BINDING_INCOMPLETE", "runtime-failure"],
      ["config", "REQUIRED_READ_INCOMPLETE", "CONFIG_READ_INCOMPLETE", "required-config-read-failure"]
    ]) await test(`${name}-failure-through-orchestrator`, [coverage], async () => {
      assertIncomplete(await orchestrate(tempRoot, name, async () => { throw new Error(error); }), reason);
    });

    const canonicalLog = baseLog({ address: A });
    await test("production-canonical-log-match-and-mismatch", ["canonical-log-match-mismatch"], async () => {
      const good = context();
      good.rpcRequest = async () => ({ ok: true, result: header(1n) });
      const success = await orchestrate(tempRoot, "canonical-good", async () => {
        await R.validateCanonicalLogBlocks([{ family: "F1" }, { family: "F2" }], [canonicalLog], good);
        return completeSynthetic();
      }, { context: good });
      equal(success.status, "SANITIZED_CAPTURE_COMPLETE", `canonical log production path ${success.reasonCode || ""}`);
      const bad = context();
      bad.rpcRequest = async () => ({ ok: true, result: header(1n, `0x${"ee".repeat(32)}`) });
      assertIncomplete(await orchestrate(tempRoot, "canonical-bad", async () => {
        await R.validateCanonicalLogBlocks([{ family: "F1" }, { family: "F2" }], [canonicalLog], bad);
        return completeSynthetic();
      }, { context: bad }), "CANONICAL_LOG_INCOMPLETE");
    });
    await test("production-log-dedup-and-conflict", ["production-log-dedup-conflict"], async () => {
      const deduped = R.dedupeLogs([canonicalLog, { ...canonicalLog }]);
      ok(deduped.ok && deduped.logs.length === 1 && deduped.duplicateCount === 1, "real dedupe");
      ok(!R.dedupeLogs([canonicalLog, { ...canonicalLog, data: "0x00" }]).ok, "real conflicting duplicate");
    });
    await test("per-vault-conjunction-production-aggregate", ["production-per-vault-gate-orchestration"], async () => {
      const split = R.aggregateCaptureRows([exactRow({ eligible: false }), exactRow({ eligible: true, nominal: 0 })]);
      equal(split.currentConjunctiveEligibility.eligibleVaultCountBucket, "1-2", "only same eligible row counted");
      const none = R.aggregateCaptureRows([exactRow({ eligible: false }), { ...exactRow(), current: {
        ...exactRow().current, config: { ...exactRow().current.config, depositWhitelist: true } } }]);
      equal(none.currentConjunctiveEligibility.eligibleVaultCountBucket, "0", "cross-row OR rejected");
    });

    await test("fixed-reason-enum-and-unknown-redaction", ["fixed-error-reason-enum", "unknown-error-redaction",
      "uppercase-ethers-error-redaction"], async () => {
      equal(R.mapPostLedgerFailure(new Error("BUDGET_EXHAUSTED_TOTAL_REQUESTS")), "BUDGET_EXHAUSTED", "budget enum");
      const raw = "CALL_EXCEPTION 0X" + "AB".repeat(32) + " data=0XDEADBEEF";
      const result = await orchestrate(tempRoot, "unknown", async () => { throw new Error(raw); });
      assertIncomplete(result, "INTERNAL_FAILURE_REDACTED");
      const persisted = fs.readFileSync(tempPaths(tempRoot, "unknown").outputPath, "utf8");
      ok(!persisted.toUpperCase().includes("CALL_EXCEPTION") && !persisted.includes("DEADBEEF"), "raw ethers error absent");
    });
    await test("nested-case-insensitive-key-independent-sanitizer", ["nested-key-independent-privacy"], async () => {
      throws(() => R.sanitizeCapture({ nested: ["ethers raw 0X" + "AA".repeat(20)] }), /OUTPUT_HEX_IDENTIFIER_LEAK/u,
        "uppercase nested address rejected");
      throws(() => R.sanitizeCapture({ nested: [["raw 0X" + "BB".repeat(32)]] }), /OUTPUT_HEX_IDENTIFIER_LEAK/u,
        "uppercase nested 32-byte value rejected");
      throws(() => R.sanitizeCapture({ safeKey: "CC".repeat(32) }), /OUTPUT_HASH_LEAK/u,
        "unprefixed 32-byte value rejected");
      throws(() => R.sanitizeCapture({ safeKey: ["0xdeadbeef"] }), /OUTPUT_HEX_IDENTIFIER_LEAK/u, "calldata independent of key");
      throws(() => R.sanitizeCapture({ TrAnSaCtIoNhAsH: "redacted" }), /OUTPUT_IDENTITY_LEAK/u, "key case insensitive");
    });
    await test("successful-complete-synthetic-real-orchestrator", ["successful-complete-synthetic-orchestration",
      "all-null-gates"], async () => {
      const result = await orchestrate(tempRoot, "synthetic-complete", async () => completeSynthetic());
      equal(result.status, "SANITIZED_CAPTURE_COMPLETE", "synthetic complete");
      equal(result.currentConjunctiveEligibility.eligibleVaultCountBucket, "1-2", "per-vault gate complete");
      const incomplete = R.failClosedCapture("HISTORY_INCOMPLETE");
      ok(Object.values(incomplete.promotionGates).every((value) => value === null), "mandatory all-null helper shape");
    });

    await test("ordered-factory-version-and-blacklist-history", ["ordered-factory-version-blacklist-history"], async () => {
      const versions = [{ version: 1n, implementation: A, blacklisted: false }, { version: 2n, implementation: B, blacklisted: true }];
      const logs = [baseLog({ topic: id("Whitelist(address)"), topic1: zeroPadValue(A, 32), index: 0n }),
        baseLog({ topic: id("Whitelist(address)"), topic1: zeroPadValue(B, 32), index: 1n }),
        baseLog({ topic: id("Blacklist(uint64)"), topic1: word(2), index: 2n })];
      ok(R.reconcileFactoryVersionHistory(versions, logs).complete, "ordered registry complete");
      ok(!R.reconcileFactoryVersionHistory([{ ...versions[0], implementation: B }, versions[1]], logs).complete,
        "position mismatch rejected");
    });
    await test("entity-intervals-and-legacy-exclusion", ["entity-migration-intervals-and-legacy-exclusion"], async () => {
      const add = { blockNumber: 1n, transactionHash: TX1, transactionIndex: 0n, logIndex: 0n };
      const initial = { blockNumber: 1n, transactionHash: TX1, transactionIndex: 0n, logIndex: 2n, version: 1n };
      const vaultInit = { blockNumber: 1n, transactionHash: TX1, transactionIndex: 0n, logIndex: 1n };
      const migrated = { blockNumber: 2n, transactionHash: TX2, transactionIndex: 0n, logIndex: 1n, version: 3n };
      const lifecycle = R.buildEntityImplementationIntervals({ addEntity: add, initialized: [initial, migrated],
        vaultInitializes: [vaultInit], migrations: [{ blockNumber: 2n, transactionHash: TX2, transactionIndex: 0n,
          logIndex: 2n, newVersion: 3n }], currentVersion: 3n, pin: 10n });
      ok(lifecycle.complete && lifecycle.exactV2Interval === null, "migrated legacy not attributed to exact V2");
    });
    await test("exact-proxy-and-vault-immutable-bindings", ["exact-proxy-runtime-admin-immutable",
      "exact-vault-named-immutable-ast-slots"], async () => {
      const artifactRoot = path.join(ROOT, "targets", "symbiotic-core-83a3a9ab", "out");
      const proxyArtifact = JSON.parse(fs.readFileSync(path.join(artifactRoot, "MigratableEntityProxy.sol",
        "MigratableEntityProxy.json"), "utf8"));
      const proxy = R.proxyImmutableBinding();
      ok(typeof R.normalizeRuntimeArtifact(proxyArtifact, proxy.values, proxy.plan) === "string", "exact proxy runtime");
      const vaultArtifact = JSON.parse(fs.readFileSync(path.join(artifactRoot, "VaultV2.sol", "VaultV2.json"), "utf8"));
      const vault = R.vaultImmutableBinding();
      ok(typeof R.normalizeRuntimeArtifact(vaultArtifact, vault.values, vault.plan) === "string", "exact named VaultV2 runtime");
      ok(Object.values(vault.plan).every((entry) => entry.artifactAstId && entry.constructorArgument &&
        entry.sourceDeclarationByteOffset >= 0), "all immutable AST/source/constructor slots");
    });
    await test("stored-supply-pending-fee-reconciliation", ["stored-share-supply-minus-pending-fees"], async () => {
      const replay = R.replayShareTransfers([{ type: "transfer", from: ZERO, to: A, value: 10n, blockNumber: 1n,
        transactionIndex: 0n, logIndex: 0n }], true);
      ok(R.reconcileStoredShareSupply(replay, 12n, 2n).complete, "fee-adjusted replay");
      ok(!R.reconcileStoredShareSupply(replay, 13n, 2n).complete, "fee-adjusted mismatch");
    });
    await test("nominal-versus-actual-loss", ["nominal-versus-actual-asset-loss"], async () => {
      const deposit = { type: "deposit", assets: 10n, shares: 0n, vault: ENTITY, transactionHash: TX1, logIndex: 2n };
      const inbound = [{ to: ENTITY, value: 10n, transactionHash: TX1, logIndex: 1n }];
      equal(R.classifyZeroShareDepositEvidence(deposit, inbound, null).actualAssetLoss, null, "unknown token remains null");
      equal(R.classifyZeroShareDepositEvidence(deposit, inbound, true).actualAssetLoss, true, "exact standard token proves loss");
    });

    await test("check-only-zero-access-and-write", ["check-only-zero-access-write"], async () => {
      const dry = R.dryPreflight();
      equal([dry.status, dry.networkReads, dry.inventoryReads, dry.captureExecuted, dry.writes],
        ["PREPARED_NOT_AUTHORIZED_NOT_EXECUTED", 0, 0, false, 0], "check-only boundary");
    });
    await test("streaming-body-without-length-and-cap-abort", ["streaming-body-no-content-length-and-abort",
      "cap-maxResponseBytes", "cap-maxAggregateResponseBytes"], async () => {
      const good = context();
      const parsed = await R.rpcRequest({ url: ["http", "://", "fixture.invalid"].join("") }, "eth_chainId", [], good,
        async () => streamResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }));
      ok(parsed.ok, "streaming absent length success");
      const tinySingle = context({ caps: { maxResponseBytes: 4, retriesPerRequest: 0 } });
      await rejects(() => R.rpcRequest({ url: ["http", "://", "fixture.invalid"].join("") }, "eth_chainId", [], tinySingle,
        async () => streamResponse({ jsonrpc: "2.0", id: 1, result: "0x1" })), /SINGLE_RESPONSE_BYTES/u, "single cap");
      const tinyAggregate = context({ caps: { maxResponseBytes: 1000, maxAggregateResponseBytes: 4, retriesPerRequest: 0 } });
      await rejects(() => R.rpcRequest({ url: ["http", "://", "fixture.invalid"].join("") }, "eth_chainId", [], tinyAggregate,
        async () => streamResponse({ jsonrpc: "2.0", id: 1, result: "0x1" })), /AGGREGATE_RESPONSE_BYTES/u, "aggregate cap");
    });
    await test("inventory-byte-entry-family-no-truncation", ["inventory-no-truncation", "cap-maxInventoryBytes",
      "cap-maxInventoryEntries", "cap-maxFamilies"], async () => {
      throws(() => R.parseInventoryText("x".repeat(11), caps({ maxInventoryBytes: 10 })), /INVENTORY_BYTE_CAP/u, "bytes");
      const urls = [0, 1, 2].map((i) => ["http", "://", `fixture-${i}.invalid`].join("")).join("\n");
      throws(() => R.parseInventoryText(urls, caps({ maxInventoryEntries: 2 })), /INVENTORY_ENTRY_CAP/u, "entries");
      throws(() => R.parseInventoryText(urls, caps({ maxInventoryEntries: 3, maxFamilies: 2 })), /FAMILY_CAP/u, "families");
    });

    await test("chain-and-min-family-caps", ["cap-chains", "cap-minDistinctFamilies"], async () => {
      const ctx = context();
      ctx.rpcRequest = async () => ({ ok: true, result: "0x2" });
      await rejects(() => R.qualifyFamilies([{ hostname: "wrong.invalid" }], ctx), /TWO_FAMILY_THRESHOLD/u, "wrong chain excluded");
      equal(R.CAPS.chains, 1, "single chain bound");
    });
    await test("entity-and-version-caps", ["cap-maxEntities", "cap-maxVersions"], async () => {
      const b1 = new R.Budget(caps({ maxEntities: 1 }));
      throws(() => R.enforceNumericCap(2, b1.caps.maxEntities, "ENTITIES", b1), /ENTITIES/u, "entity cap");
      const b2 = new R.Budget(caps({ maxVersions: 1 }));
      throws(() => R.enforceNumericCap(2, b2.caps.maxVersions, "VERSIONS", b2), /VERSIONS/u, "version cap");
    });
    await test("unique-log-chunk-span-caps", ["cap-maxUniqueHeaders", "cap-maxLogs", "cap-maxChunks",
      "cap-maxScanSpanBlocks"], async () => {
      const unique = new R.Budget(caps({ maxUniqueHeaders: 0 }));
      throws(() => unique.observeHeader(1n), /UNIQUE_HEADERS/u, "unique headers");
      const logs = new R.Budget(caps({ maxLogs: 0 }));
      throws(() => logs.consumeLog(), /RETURNED_LOGS/u, "returned logs");
      const chunks = new R.Budget(caps({ maxChunks: 0 }));
      throws(() => chunks.consumeChunk(), /CHUNKS/u, "chunks");
      const span = context({ caps: { maxScanSpanBlocks: 1 } });
      await rejects(() => R.scanLogs([{ family: "F1" }], {}, 0n, 2n, span), /SCAN_SPAN/u, "scan span");
    });
    await test("log-chunk-size-materially-controls-requests", ["cap-maxLogChunkBlocks"], async () => {
      const ctx = context({ caps: { maxLogChunkBlocks: 2 } });
      let requests = 0;
      ctx.rpcRequest = async () => { requests += 1; return { ok: true, result: [] }; };
      await R.scanLogs([{ family: "F1" }], {}, 0n, 4n, ctx);
      equal(requests, 3, "five blocks chunked 2/2/1");
    });
    await test("request-category-and-retry-caps", ["cap-maxTotalRequests", "cap-maxCallRequests", "cap-maxCodeRequests",
      "cap-maxStorageRequests", "cap-maxLogRequests", "cap-maxBlockRequests", "cap-maxRetries"], async () => {
      for (const [key, method, reason, retry] of [
        ["maxTotalRequests", "eth_chainId", "TOTAL_REQUESTS", false], ["maxCallRequests", "eth_call", "CALL_REQUESTS", false],
        ["maxCodeRequests", "eth_getCode", "CODE_REQUESTS", false], ["maxStorageRequests", "eth_getStorageAt", "STORAGE_REQUESTS", false],
        ["maxLogRequests", "eth_getLogs", "LOG_REQUESTS", false], ["maxBlockRequests", "eth_getBlockByNumber", "BLOCK_REQUESTS", false],
        ["maxRetries", "eth_chainId", "RETRIES", true]
      ]) {
        const budget = new R.Budget(caps({ [key]: 0, maxTimestampFetches: 10 }));
        throws(() => budget.consume(method, retry), new RegExp(reason, "u"), key);
      }
    });
    await test("retry-count-and-timeout-caps", ["cap-retriesPerRequest", "cap-requestTimeoutMs"], async () => {
      const retryCtx = context({ caps: { retriesPerRequest: 1 } });
      let attempts = 0;
      const result = await R.rpcRequest({ url: ["http", "://", "fixture.invalid"].join("") }, "eth_chainId", [], retryCtx,
        async () => { attempts += 1; return { status: 500, redirected: false, headers: { get: () => null }, body: null }; });
      equal([attempts, retryCtx.budget.retries, result.ok], [2, 1, false], "one retry charged");
      const timeoutCtx = context({ caps: { retriesPerRequest: 0, requestTimeoutMs: 1 } });
      const timeoutResult = await R.rpcRequest({ url: ["http", "://", "fixture.invalid"].join("") }, "eth_chainId", [], timeoutCtx,
        async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))));
      equal(timeoutResult.error, "TRANSPORT_FAILURE", "timeout aborts");
    });
    await test("elapsed-and-timestamp-caps", ["cap-maxElapsedMs", "cap-maxTimestampFetches"], async () => {
      let now = 0;
      const timed = new R.Budget(caps({ maxElapsedMs: 1 }), () => now);
      now = 2;
      throws(() => timed.checkTime(), /TIME/u, "elapsed");
      const timestamps = new R.Budget(caps({ maxTimestampFetches: 0 }));
      throws(() => timestamps.consumeTimestampFetch(), /TIMESTAMP_FETCHES/u, "timestamp");
    });
    await test("approval-window-age-skew-caps", ["cap-maxApprovalWindowMs", "cap-maxApprovalIssuedAgeMs",
      "cap-maxApprovalFutureSkewMs"], async () => {
      const now = Date.now();
      for (const kind of ["window", "age", "skew"]) {
        const envelope = approvalEnvelope(now);
        if (kind === "window") envelope.approvalPayload.expiresAt = new Date(now + R.CAPS.maxApprovalWindowMs + 10000).toISOString();
        if (kind === "age") envelope.approvalPayload.issuedAt = new Date(now - R.CAPS.maxApprovalIssuedAgeMs - 1).toISOString();
        if (kind === "skew") envelope.approvalPayload.issuedAt = new Date(now + R.CAPS.maxApprovalFutureSkewMs + 1).toISOString();
        envelope.approvalCommitment = R.commitment(envelope.approvalPayload);
        throws(() => R.validateApprovalEnvelope(envelope, { now, expected: expectedBindings(), consumed: false }),
          /APPROVAL_WINDOW_INVALID/u, kind);
      }
    });

    await test("e2e-real-perform-complete-success", ["e2e-production-complete-success"], async () => {
      const run = await fullCliCapture(tempRoot, "e2e-success");
      equal(run.result.status, "SANITIZED_CAPTURE_COMPLETE", "full perform success");
      equal(run.result.coverage.exactRuntimeComplete, true, "full runtime complete");
      equal(run.result.coverage.historyComplete, true, "full history complete");
      ok(fs.existsSync(run.ledgerPath) && fs.existsSync(run.outputPath), "full atomic artifacts");
    }, "e2e");
    await test("e2e-real-perform-config-null", ["e2e-production-config-null"], async () => {
      const base = fullProductionAdapters();
      const run = await fullCliCapture(tempRoot, "e2e-config", {
        captureEntityCurrent: async () => ({ ...base.__rows.current, config: null })
      });
      assertIncomplete(run.result, "CONFIG_READ_INCOMPLETE");
    }, "e2e");
    await test("e2e-real-perform-malformed-entity", ["e2e-production-malformed-entity"], async () => {
      const base = fullProductionAdapters();
      const run = await fullCliCapture(tempRoot, "e2e-entity", {
        captureFactory: async () => ({ ...base.__rows.factory, entities: ["malformed"] })
      });
      assertIncomplete(run.result, "ENTITY_MALFORMED_INCOMPLETE");
    }, "e2e");
    await test("e2e-real-perform-proxy-incomplete", ["e2e-production-proxy-incomplete"], async () => {
      const base = fullProductionAdapters();
      const run = await fullCliCapture(tempRoot, "e2e-proxy", {
        captureEntityCurrent: async () => ({ ...base.__rows.current, completeness: {
          ...base.__rows.current.completeness, proxyRuntimeExact: false } })
      });
      assertIncomplete(run.result, "PROXY_RUNTIME_INCOMPLETE");
    }, "e2e");
    await test("e2e-real-perform-code-incomplete", ["e2e-production-code-incomplete"], async () => {
      const base = fullProductionAdapters();
      const run = await fullCliCapture(tempRoot, "e2e-code", {
        captureEntityCurrent: async () => ({ ...base.__rows.current, completeness: {
          ...base.__rows.current.completeness, implementationCodeCanonicalNonempty: false } })
      });
      assertIncomplete(run.result, "ENTITY_MALFORMED_INCOMPLETE");
    }, "e2e");
    await test("e2e-real-perform-lifecycle-version-gap", ["e2e-production-lifecycle-version-gap"], async () => {
      const run = await fullCliCapture(tempRoot, "e2e-lifecycle", { captureEntityLifecycle: async () => ({ complete: false }) });
      assertIncomplete(run.result, "ENTITY_LIFECYCLE_INCOMPLETE");
    }, "e2e");
    await test("e2e-real-perform-runtime-unknown", ["e2e-production-runtime-unknown"], async () => {
      const base = fullProductionAdapters();
      const run = await fullCliCapture(tempRoot, "e2e-runtime", {
        captureEntityCurrent: async () => ({ ...base.__rows.current, classification: { exactVaultV2: null },
          completeness: { ...base.__rows.current.completeness, runtimeComparisonComplete: false } })
      });
      assertIncomplete(run.result, "RUNTIME_BINDING_INCOMPLETE");
    }, "e2e");
    await test("e2e-real-perform-history-incomplete", ["e2e-production-history-incomplete"], async () => {
      const base = fullProductionAdapters();
      const run = await fullCliCapture(tempRoot, "e2e-history", {
        captureEntityHistory: async () => ({ ...base.__rows.history, zero: { complete: false } })
      });
      assertIncomplete(run.result, "HISTORY_INCOMPLETE");
    }, "e2e");
    await test("e2e-real-perform-canonical-log-failure", ["e2e-production-canonical-log-failure"], async () => {
      const run = await fullCliCapture(tempRoot, "e2e-canonical", {
        captureEntityHistory: async () => { throw new Error("LOG_CANONICAL_HASH_MISMATCH"); }
      });
      assertIncomplete(run.result, "CANONICAL_LOG_INCOMPLETE");
    }, "e2e");
    await test("e2e-real-perform-stored-supply-incomplete", ["e2e-production-stored-supply-incomplete"], async () => {
      const base = fullProductionAdapters();
      const run = await fullCliCapture(tempRoot, "e2e-supply", {
        captureEntityHistory: async () => ({ ...base.__rows.history, storedSupplyReconciled: false })
      });
      assertIncomplete(run.result, "STORED_SUPPLY_INCOMPLETE");
    }, "e2e");
    await test("e2e-real-perform-cap-exhaustion", ["e2e-production-cap-exhaustion"], async () => {
      const run = await fullCliCapture(tempRoot, "e2e-cap", {
        captureFactory: async (_selected, _pin, ctx) => ctx.budget.stop("ENTITIES")
      });
      assertIncomplete(run.result, "BUDGET_EXHAUSTED");
    }, "e2e");
    await test("e2e-real-perform-unknown-error-redacted", ["e2e-production-unknown-redacted"], async () => {
      const run = await fullCliCapture(tempRoot, "e2e-unknown", {
        captureFactory: async () => { throw new Error("CALL_EXCEPTION 0X" + "AB".repeat(32)); }
      });
      assertIncomplete(run.result, "INTERNAL_FAILURE_REDACTED");
      const persisted = fs.readFileSync(run.outputPath, "utf8");
      ok(!persisted.includes("CALL_EXCEPTION") && !persisted.includes("ABAB"), "unknown detail absent");
    }, "e2e");
    await test("e2e-real-perform-terminal-mismatch", ["e2e-production-terminal-mismatch"], async () => {
      const run = await fullCliCapture(tempRoot, "e2e-terminal", {
        readTerminalHeader: async (endpoint) => parsedHeader(100n,
          endpoint.family === "F1" ? BLOCK_HASH : `0x${"ee".repeat(32)}`)
      });
      assertIncomplete(run.result, "TERMINAL_PIN_INCOMPLETE");
    }, "e2e");
    await test("e2e-fixed-cli-path-replay-expiry-mode", ["e2e-fixed-cli-path-replay-expiry-mode"], async () => {
      const first = await fullCliCapture(tempRoot, "e2e-cli-replay");
      equal(first.result.status, "SANITIZED_CAPTURE_COMPLETE", "initial fixed CLI capture");
      fs.unlinkSync(first.outputPath);
      await rejects(() => R.executeCaptureCli(["node", "runner", "--capture-once", "--approval-file", R.FIXED_APPROVAL_REL], {
        packageContext: { expected: first.expected }, approvalLoader: async () => JSON.parse(fs.readFileSync(first.approvalTemp, "utf8")),
        ledgerPath: first.ledgerPath, outputPath: first.outputPath, now: first.now, context: context(),
        adapters: fullProductionAdapters() }), /APPROVAL_ALREADY_CONSUMED/u, "full CLI replay");
      await rejects(() => R.executeCaptureCli(["node", "runner", "--capture-once", "--approval-file", first.approvalTemp], {}),
        /APPROVAL_PATH_INVALID/u, "alternate actual CLI approval path rejected");
      await rejects(() => R.executeCaptureCli(["node", "runner", "--check-only", "--capture-once"], {}), /MODE_CONFLICT/u,
        "actual CLI mode conflict");
      const now = Date.now();
      const expired = approvalEnvelope(now);
      expired.approvalPayload.issuedAt = new Date(now - 700000).toISOString();
      expired.approvalPayload.expiresAt = new Date(now - 1).toISOString();
      expired.approvalCommitment = R.commitment(expired.approvalPayload);
      const expiredFile = path.join(tempRoot, "e2e-expired.approval.json");
      fs.writeFileSync(expiredFile, JSON.stringify(expired), "utf8");
      await rejects(() => R.executeCaptureCli(["node", "runner", "--capture-once", "--approval-file", R.FIXED_APPROVAL_REL], {
        packageContext: { expected: expectedBindings() }, approvalLoader: async () => JSON.parse(fs.readFileSync(expiredFile, "utf8")),
        ...tempPaths(tempRoot, "e2e-expired"), now, context: context(), adapters: fullProductionAdapters()
      }), /APPROVAL_WINDOW_INVALID/u, "full CLI expiry");
    }, "e2e");
    await test("e2e-conclusive-non-v2-complete", ["e2e-conclusive-non-v2-classification"], async () => {
      const base = fullProductionAdapters();
      const nonV2 = { ...base.__rows.current, classification: { exactVaultV2: false, reason: "RUNTIME_BINDING_NEGATIVE" },
        conclusiveNonV2: true, config: null };
      const run = await fullCliCapture(tempRoot, "e2e-nonv2", { captureEntityCurrent: async () => nonV2 });
      equal(run.result.status, "SANITIZED_CAPTURE_COMPLETE", "conclusive non-V2 complete");
      equal(run.result.coverage.legacyOrOtherCountBucket, "1-2", "conclusive non-V2 bucket");
    }, "e2e");

    await test("executed-test-accounting-and-workspace-boundary", ["test-accounting-integrity"], async () => {
      equal(PLAN.schemaVersion, 4, "coverage plan schema");
      equal(PLAN.proposalId, R.PROPOSAL_ID, "coverage plan proposal");
      const missing = PLAN.coverageClasses.filter((name) => !covered.has(name));
      equal(missing, [], "every declared coverage class executed");
      ok(executed.every((entry) => entry.assertions > 0), "every prior test case has assertions");
      ok(!fs.existsSync(path.join(ROOT, ...R.FIXED_OUTPUT_REL.split("/"))), "workspace capture absent");
      ok(!fs.existsSync(path.join(ROOT, ...R.GLOBAL_LEDGER_REL.split("/"))), "workspace ledger absent");
    });

    const unitRows = executed.filter((row) => row.kind === "unit");
    const e2eRows = executed.filter((row) => row.kind === "e2e");
    const summary = (rows) => ({ testCaseCount: rows.length,
      assertionCount: rows.reduce((sum, row) => sum + row.assertions, 0),
      coverageClassCount: new Set(rows.flatMap((row) => row.coverageClasses)).size });
    output = { schema: "symbiotic-vaultv2-step2-executed-tests-v4", status: "PASS",
      proposalId: R.PROPOSAL_ID, requestedApprovalId: R.REQUESTED_APPROVAL_ID, testCaseCount: executed.length,
      assertionCount: assertions, coverageClassCount: covered.size, declaredCoverageClassCount: PLAN.coverageClasses.length,
      unit: summary(unitRows), e2e: summary(e2eRows), tests: executed,
      networkReads: 0, inventoryReads: 0, captureExecuted: false, workspaceCaptureWrites: 0,
      workspaceLedgerWrites: 0, temporaryArtifactsRemoved: false, routePositive: 0, executableNow: 0,
      signedActionJustified: false, fork: false };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  output.temporaryArtifactsRemoved = !fs.existsSync(tempRoot);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
