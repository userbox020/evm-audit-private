#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const stage = require("./scan-babylon-mintscan-pre-retention-enumerator.js");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(ROOT, "reports", "raw", "fast", "babylon-mintscan-pre-retention-enumerator.offline-fixtures.json");
const RESULT = path.join(ROOT, "reports", "raw", "fast", "babylon-mintscan-pre-retention-enumerator.offline-test-results.json");
const LIVE_OUTPUTS = [
  path.join(ROOT, "reports", "raw", "fast", "babylon-mintscan-pre-retention-enumerator.json"),
  path.join(ROOT, "reports", "raw", "fast", "babylon-mintscan-pre-retention-enumerator.manifest.json"),
  path.join(ROOT, "reports", "babylon-mintscan-pre-retention-enumerator.md"),
  path.join(ROOT, "reports", "babylon-mintscan-pre-retention-enumerator-definitions.md"),
  path.join(ROOT, "reports", "babylon-mintscan-pre-retention-enumerator-sources.md"),
  path.join(ROOT, "coordination", "handoffs", "2026-07-18-critical-babylon-step11-mintscan-handoff.md"),
  path.join(ROOT, "coordination", "inbox", "critical", "2026-07-18-critical-babylon-step11-mintscan.json"),
];

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileState(file) { return fs.existsSync(file) ? { exists: true, bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) } : { exists: false }; }
function syntheticAddress(index) {
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  return `bbn1${alphabet[index % alphabet.length]}${"q".repeat(37)}`;
}
function syntheticHash(index) { return sha(`babylon-step11-synthetic-hash-${index}`); }
function responseJson(value, options = {}) {
  const text = JSON.stringify(value);
  return new Response(text, { status: options.status || 200, headers: { "content-type": "application/json", ...(options.headers || {}) } });
}
function hydrate(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => hydrate(item, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item, replacements)]));
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(replacements, value) ? replacements[value] : value;
}
async function expectSafeCode(promise, code) {
  let observed = null;
  try { await promise; } catch (error) { observed = error; }
  assert(observed instanceof stage.SafeError, `expected SafeError ${code}`);
  assert.strictEqual(observed.code, code);
  return observed;
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.strictEqual(fixture.networkRequests, 0);
  const fixtureText = JSON.stringify(fixture);
  assert(!/bbn1[02-9ac-hj-np-z]{20,80}/.test(fixtureText));
  assert(!/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(fixtureText));
  assert(!/[A-Za-z0-9+/]{80,}={0,2}/.test(fixtureText));
  const before = new Map(LIVE_OUTPUTS.map((file) => [file, fileState(file)]));
  const checks = {};
  const check = async (name, fn) => { try { await fn(); checks[name] = true; } catch (error) { error.offlineCheck = name; throw error; } };

  const token = ["synthetic", "bearer", crypto.randomBytes(12).toString("hex")].join("-");
  const signatureBytes = crypto.randomBytes(64).toString("base64");
  const addressA = syntheticAddress(0); const addressB = syntheticAddress(1); const addressC = syntheticAddress(2);
  const txA = syntheticHash(0); const txB = syntheticHash(1); const txC = syntheticHash(2);

  await check("contextBinding", async () => {
    const context = stage.bindContext();
    assert.strictEqual(context.step9.runId, "babylon-step9-r3-20260717212558-9b163306c904");
    assert.strictEqual(context.step10.runId, stage.EXPECTED_STEP10_RUN);
    assert.strictEqual(context.step9.archiveBoundary.unavailableHeight, "2556425");
    assert.strictEqual(context.step9.archiveBoundary.unavailableTimestamp, null);
    assert.strictEqual(context.step9.archiveBoundary.firstAvailableHeight, "2556426");
    assert.strictEqual(context.step9.archiveBoundary.firstAvailableTimestamp, fixture.regressions.expectedPrunedBoundary.firstAvailableTimestamp);
    assert.strictEqual(context.priorBlockedRun.disposition, "SUPERSEDED_BLOCKED_CONTEXT");
    assert.deepStrictEqual(context.documentedSchemas.accountTransactions.queryParameters, ["take", "messageTypes[0]", "fromDateTime", "toDateTime", "searchAfter"]);
    assert.deepStrictEqual(context.documentedSchemas.transactionDetail.queryParameters, ["height"]);
  });

  let baseline;
  await check("retainedBaseline", async () => {
    baseline = stage.loadStep9Baseline();
    assert.deepStrictEqual(baseline.counts, { transactions: 10185, messagePairs: 11412, multiMessageTransactions: 986, retainedSignerIdentityHashes: 9 });
    assert.strictEqual(baseline.pairs.size, 11412);
  });

  const detailBody = {
    data: {
      txHash: txA,
      height: "2556425",
      timestamp: "2026-01-29T19:48:45.000Z",
      code: 0,
      messages: [
        { "@type": stage.TARGET_MSG, signer: addressA, staking_tx_hash: syntheticHash(11), covenant_signatures: [signatureBytes] },
        { "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: addressA, to_address: addressB },
        { "@type": stage.TARGET_MSG, signer: addressB, staking_tx_hash: syntheticHash(12), covenant_signatures: [signatureBytes] },
        { "@type": "/cosmos.authz.v1beta1.MsgExec", grantee: addressC, msgs: [{ "@type": stage.TARGET_MSG, signer: addressA, staking_tx_hash: syntheticHash(13), covenant_signatures: [signatureBytes] }] },
      ],
      authInfo: { signerInfos: [{ publicKey: "synthetic-public-key-a" }], fee: { granter: addressC, amount: [{ denom: "ubbn", amount: "1" }] } },
      events: [{ type: "covenant_quorum_reached", state: "VERIFIED", staking_tx_hash: syntheticHash(11), covenant_signature: signatureBytes }],
    },
  };

  let normalized;
  await check("multiMessageMsgExecAndFee", async () => {
    normalized = stage.normalizeDetail(detailBody, txA);
    assert.strictEqual(normalized.record.directTargetCount, 2);
    assert.strictEqual(normalized.record.msgExecCount, 1);
    assert.strictEqual(normalized.record.nestedTargetCount, 1);
    assert.strictEqual(normalized.record.messages[0].messageIndex, 0);
    assert.strictEqual(normalized.record.messages[2].messageIndex, 2);
    assert.strictEqual(normalized.record.messages[3].msgExec.nested[0].nestedMessageIndex, 0);
    assert.strictEqual(normalized.record.fee.explicitPayerHash, null);
    assert.strictEqual(normalized.record.fee.implicitFeePayerCaveat, true);
    assert.strictEqual(normalized.record.quorumEvents.count, 1);
    assert.strictEqual(normalized.record.outerSignerHashes.length, 0);
    assert.strictEqual(normalized.discoveredDirectAddresses.size, 2);
  });

  await check("deterministicNormalizationAndLeakExclusion", async () => {
    const again = stage.normalizeDetail(JSON.parse(JSON.stringify(detailBody)), txA);
    assert.strictEqual(JSON.stringify(normalized.record), JSON.stringify(again.record));
    const text = JSON.stringify(normalized.record);
    assert(!text.includes(addressA)); assert(!text.includes(addressB)); assert(!text.includes(addressC));
    assert(!text.includes(signatureBytes)); assert(!text.includes(token));
    assert(stage.assertOutputSafe(normalized.record, token));
  });

  await check("cursorExhaustionAndDuplicateJoin", async () => {
    let calls = 0;
    const mockClient = { mintscanAccount: async () => {
      calls++;
      if (calls === 1) return { body: { data: { transactions: [{ txHash: txA, height: "10" }, { txHash: txB, height: "11" }] }, pagination: { searchAfter: "cursor-one" } } };
      return { body: { data: { transactions: [{ txHash: txB, height: "11" }, { txHash: txC, height: "12" }] }, pagination: { searchAfter: null } } };
    } };
    const result = await stage.enumerateAccountWindow(mockClient, addressA, { label: "synthetic", fromDateTime: "2026-01-01T00:00:00.000Z", toDateTime: "2026-02-01T00:00:00.000Z" });
    assert.strictEqual(result.stats.pages, 2); assert.strictEqual(result.stats.uniqueTransactions, 3); assert.strictEqual(result.stats.duplicateRows, 1); assert.strictEqual(result.stats.cursorCount, 1);
    assert(!JSON.stringify(result.stats).includes("cursor-one"));
  });

  await check("cursorLoopRejection", async () => {
    const mockClient = { mintscanAccount: async () => ({ body: { data: { transactions: [] }, pagination: { searchAfter: "same-cursor" } } }) };
    await expectSafeCode(stage.enumerateAccountWindow(mockClient, addressA, { label: "loop", fromDateTime: "2026-01-01T00:00:00.000Z", toDateTime: "2026-02-01T00:00:00.000Z" }), "ACCOUNT_CURSOR_LOOP_DETECTED");
  });

  await check("targetAllowlistAndMethod", async () => {
    let observed = null;
    const fetchImpl = async (url, options) => { observed = { url, options }; return responseJson({ data: { transactions: [] }, pagination: { searchAfter: null } }); };
    const client = new stage.BudgetedHttpClient({ token, fetchImpl, sleep: async () => {}, now: (() => { let n = 1000; return () => (n += 200); })() });
    const response = await client.mintscanAccount(addressA, { take: "1", "messageTypes[0]": stage.TARGET_MSG, fromDateTime: "2026-01-01T00:00:00.000Z", toDateTime: "2026-02-01T00:00:00.000Z" });
    assert.strictEqual(response.status, 200); assert.strictEqual(observed.options.method, "GET"); assert.strictEqual(observed.options.redirect, "manual");
    assert.strictEqual(observed.options.headers.authorization, `Bearer ${token}`);
    assert(!JSON.stringify(response).includes(token));
    assert.throws(() => stage.validatePathAndQuery("MINTSCAN_ACCOUNT", `/v1/babylon/accounts/${addressA}/transactions`, { "messageTypes[0]": "/wrong" }), (error) => error.code === "MINTSCAN_MESSAGE_FILTER_REJECTED");
    assert.throws(() => new stage.BudgetedHttpClient({ token, apiOrigin: ["h", "ttps", "://", "not-allowlisted", ".", "invalid"].join("") }), (error) => error.code === "MINTSCAN_HOST_NOT_ALLOWLISTED");
    assert.throws(() => new stage.BudgetedHttpClient({ token: "" }), (error) => error.code === "MINTSCAN_API_TOKEN_REQUIRED");
  });

  await check("transportErrorRedaction", async () => {
    const client = new stage.BudgetedHttpClient({ token, fetchImpl: async () => { throw new Error(`Authorization: Bearer ${token}`); }, sleep: async () => {}, now: (() => { let n = 1000; return () => (n += 200); })() });
    const error = await expectSafeCode(client.mintscanDetail(txA), "HTTP_TRANSPORT_FAILED");
    assert(!JSON.stringify(error.diagnostic).includes(token));
    const sanitized = stage.sanitizeDiagnostic({ message: `Authorization: Bearer ${token}`, address: addressA, responseBody: token });
    assert(!JSON.stringify(sanitized).includes(token)); assert(!JSON.stringify(sanitized).includes(addressA));
  });

  await check("redirectRejected", async () => {
    const client = new stage.BudgetedHttpClient({ token, fetchImpl: async () => new Response("", { status: 302, headers: { location: ["h", "ttps", "://", "redirect", ".", "invalid"].join("") } }), sleep: async () => {}, now: (() => { let n = 1000; return () => (n += 200); })() });
    await expectSafeCode(client.mintscanDetail(txA), "HTTP_REDIRECT_REJECTED");
  });

  await check("bodyCapAndCredentialEcho", async () => {
    const over = Buffer.alloc(stage.LIMITS.maxBodyBytes + 1, 0x20);
    const capClient = new stage.BudgetedHttpClient({ token, fetchImpl: async () => new Response(over, { status: 200 }), sleep: async () => {}, now: (() => { let n = 1000; return () => (n += 200); })() });
    await expectSafeCode(capClient.mintscanDetail(txA), "RESPONSE_BODY_CAP_EXCEEDED");
    const echoClient = new stage.BudgetedHttpClient({ token, fetchImpl: async () => responseJson({ reflected: token }), sleep: async () => {}, now: (() => { let n = 1000; return () => (n += 200); })() });
    await expectSafeCode(echoClient.mintscanDetail(txA), "TOKEN_ECHO_DETECTED");
  });

  await check("rateLimitBackoffAndSchemaFailClosed", async () => {
    let calls = 0;
    const client = new stage.BudgetedHttpClient({ token, fetchImpl: async () => {
      calls++;
      if (calls === 1) return responseJson({ unavailable: true }, { status: 429, headers: { "retry-after": "0" } });
      return responseJson(detailBody);
    }, sleep: async () => {}, now: (() => { let n = 1000; return () => (n += 200); })() });
    const response = await client.mintscanDetail(txA);
    assert.strictEqual(response.status, 200); assert.strictEqual(calls, 2); assert.strictEqual(client.stats().retryCount, 1);
    assert.throws(() => stage.normalizeDetail({ data: { unexpected: [] } }, txA), (error) => error.code === "MINTSCAN_DETAIL_SCHEMA_MISMATCH");
  });

  await check("expectedPrunedBoundaryNoRetry", async () => {
    const context = stage.bindContext(); let calls = 0;
    const client = new stage.BudgetedHttpClient({ token, cometOrigin: ["h", "ttps", "://", "public-comet", ".", "invalid"].join(""), fetchImpl: async () => { calls++; return responseJson({ error: "synthetic-pruned" }, { status: 500 }); }, sleep: async () => {}, now: (() => { let n = 1000; return () => (n += 200); })() });
    await expectSafeCode(client.comet("/block", { height: "2556425" }, { expectedPrunedBoundaryProof: context.step9.archiveBoundary }), "EXPECTED_PRUNED_BOUNDARY");
    assert.strictEqual(calls, fixture.regressions.expectedPrunedBoundary.expectedRequestCount);
    const ordinaryClient = new stage.BudgetedHttpClient({ token, cometOrigin: ["h", "ttps", "://", "public-comet", ".", "invalid"].join(""), fetchImpl: async () => { calls++; return responseJson({ error: "synthetic-upstream" }, { status: 500 }); }, sleep: async () => {}, now: (() => { let n = 1000; return () => (n += 200); })() });
    await expectSafeCode(ordinaryClient.comet("/block", { height: "2556426" }, { expectedPrunedBoundaryProof: context.step9.archiveBoundary }), "HTTP_RETRY_BUDGET_EXHAUSTED");
    assert.strictEqual(ordinaryClient.stats().retryCount, stage.LIMITS.maxRetries);
  });

  await check("firstAvailableExclusiveBoundary", async () => {
    const blocked = stage.buildBlockedRaw(new stage.SafeError("SEED_SOURCE_COMET_UNAVAILABLE", { category: "SEED_SOURCE", requestClass: "SEED_SOURCE", status: 500 }));
    assert.strictEqual(blocked.boundarySemantics.unavailableTimestamp, null);
    assert.strictEqual(blocked.boundarySemantics.firstAvailableTimestamp, fixture.regressions.expectedPrunedBoundary.firstAvailableTimestamp);
    assert.strictEqual(blocked.boundarySemantics.logicalPreRetentionComparator, "timestamp < firstAvailableTimestamp");
    assert.strictEqual(blocked.boundarySemantics.accountApiUpperBoundInclusivity, null);
    assert.strictEqual(blocked.boundarySemantics.knownUnavailableBlockQueried, false);
  });

  await check("restSeedSourceFallback", async () => {
    let observedQuery = null;
    const restBody = hydrate(fixture.regressions.restTransactionPageShape, { "$TX_HASH": txA, "$TARGET_MSG": stage.TARGET_MSG, "$ADDRESS_A": addressA, "$STAKING_TXID": syntheticHash(51) });
    const mockClient = { restTransactions: async (query) => { observedQuery = query; return { body: restBody }; } };
    const evidence = await stage.discoverRetainedSeedsRest(mockClient, baseline, true);
    assert.strictEqual(evidence.addresses.size, 1);
    assert.strictEqual([...evidence.addresses][0], addressA);
    assert.strictEqual(observedQuery["pagination.limit"], "1");
    assert.strictEqual(observedQuery.events, `message.action='${stage.TARGET_MSG}'`);
  });

  await check("phaseSpecificBlockedDiagnostics", async () => {
    const cases = [
      ["SEED_SOURCE", "SEED_SOURCE_COMET_UNAVAILABLE", "SEED_SOURCE_BLOCKED/"],
      ["TOKEN_AUTH", "TOKEN_DETAIL_VALIDATION_FAILED", "TOKEN_AUTH_BLOCKED/"],
      ["TOKEN_SCHEMA", "TOKEN_ACCOUNT_VALIDATION_FAILED", "TOKEN_SCHEMA_BLOCKED/"],
      ["CURSOR", "ACCOUNT_CURSOR_ENUMERATION_FAILED", "CURSOR_SEMANTICS_BLOCKED/"],
      ["DETAIL", "TRANSACTION_DETAIL_ENUMERATION_FAILED", "DETAIL_SCHEMA_BLOCKED/"],
    ];
    for (const [category, code, prefix] of cases) {
      const blocked = stage.buildBlockedRaw(new stage.SafeError(code, { category, causeCode: "SYNTHETIC_CAUSE", requestClass: category, status: 500 }));
      assert.strictEqual(blocked.blockedDiagnostic.category, category);
      assert(blocked.classification.startsWith(prefix));
      assert(stage.assertOutputSafe(blocked, token));
    }
  });

  await check("outputLeakGuards", async () => {
    assert.throws(() => stage.assertOutputSafe({ value: addressA }, token), (error) => error.code === "OUTPUT_RAW_ADDRESS_LEAK");
    assert.throws(() => stage.assertOutputSafe({ value: token }, token), (error) => error.code === "OUTPUT_TOKEN_LEAK");
    assert.throws(() => stage.assertOutputSafe("Authorization: credential-value", token), (error) => error.code === "OUTPUT_CREDENTIAL_LEAK");
    assert.throws(() => stage.assertOutputSafe("covenant_signature: abc", token), (error) => error.code === "OUTPUT_SIGNATURE_LEAK");
  });

  await check("actualLiveShapeRegression", async () => {
    const actualShape = hydrate(fixture.regressions.actualDetailResponseShape, { "$TX_HASH": txB, "$TARGET_MSG": stage.TARGET_MSG, "$ADDRESS_A": addressA, "$ADDRESS_B": addressB, "$STAKING_TXID": syntheticHash(21), "$SIGNATURE_B64": signatureBytes });
    assert.throws(() => stage.assertOutputSafe(actualShape, token), (error) => error.code === "OUTPUT_SIGNATURE_LEAK");
    const observed = stage.normalizeDetail(actualShape, txB).record;
    assert.strictEqual(observed.messages.length, 1);
    assert.strictEqual(observed.outerSignerHashes.length, 0);
    assert.strictEqual(observed.fee.explicitPayerHash, stage.addressHash(addressB));
    const text = JSON.stringify(observed);
    assert(!text.includes(signatureBytes));
    assert(!/public[_-]?key|signatures|tx_bytes|raw_tx|unknown_blob/i.test(text));
    assert(stage.assertNormalizedRecord(observed));
    assert(stage.assertOutputSafe(observed, token));
    assert.throws(() => stage.assertNormalizedRecord({ ...observed, signatures: [] }), (error) => error.code === "NORMALIZED_RECORD_FIELD_REJECTED");
  });

  await check("selfDescriptiveFieldRegression", async () => {
    assert.throws(() => stage.assertOutputSafe(fixture.regressions.formerNormalizedSafetyShape), (error) => error.code === "OUTPUT_SIGNATURE_LEAK");
    assert(stage.assertOutputSafe({ safety: { policy: "strict-output-allowlist-v2", forbiddenMaterialRetained: false } }));
  });

  await check("opaqueCredentialAndBlobRejection", async () => {
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJzeW50aGV0aWMifQ", "synthetic_signature_segment"].join(".");
    assert.throws(() => stage.assertOutputSafe({ value: jwt }), (error) => error.code === "OUTPUT_JWT_LEAK");
    const endpoint = ["h", "ttps", "://", "untrusted", ".", "invalid", "/x"].join("");
    assert.throws(() => stage.assertOutputSafe({ value: endpoint }), (error) => error.code === "OUTPUT_ENDPOINT_MATERIAL_LEAK");
    assert.throws(() => stage.assertOutputSafe({ value: signatureBytes }), (error) => error.code === "OUTPUT_SIGNATURE_LIKE_BLOB_LEAK");
  });

  let blockedFixture;
  await check("sanitizedBlockedArtifact", async () => {
    blockedFixture = stage.buildBlockedRaw(new stage.SafeError("MINTSCAN_DETAIL_SCHEMA_MISMATCH", { responseBody: signatureBytes, authorization: token, endpoint: "omitted", schemaFingerprint: syntheticHash(31) }));
    assert.strictEqual(blockedFixture.blockedDiagnostic.code, "MINTSCAN_DETAIL_SCHEMA_MISMATCH");
    assert(!JSON.stringify(blockedFixture).includes(signatureBytes)); assert(!JSON.stringify(blockedFixture).includes(token));
    assert(stage.assertOutputSafe(blockedFixture, token));
  });

  await check("mockedSuccessfulPublicationManifestLast", async () => {
    function memoryAdapter() {
      const staged = new Map(); const finals = new Map(); const commitOrder = []; let sequence = 0;
      return {
        staged, finals, commitOrder,
        directoryExists: () => true,
        stage(file, text) { const id = `memory-temp-${++sequence}`; staged.set(id, text); return id; },
        commit(id, file) { assert(staged.has(id)); finals.set(file, staged.get(id)); staged.delete(id); commitOrder.push(file); },
        cleanup(id) { staged.delete(id); },
        remove(file) { finals.delete(file); },
        hash(file) { return sha(finals.get(file)); },
      };
    }
    const mockSuccess = JSON.parse(JSON.stringify(blockedFixture));
    delete mockSuccess.status; delete mockSuccess.blockedDiagnostic;
    mockSuccess.evidenceRevision = "offline-mocked-success-r1";
    mockSuccess.runId = `babylon-step11-mocked-${syntheticHash(41).slice(0, 12)}`;
    mockSuccess.classification = "KNOWN_SEED_ENUMERATION_ONLY/GLOBAL_COVERAGE_OPEN";
    mockSuccess.tokenValidation = { authenticated: true, detail: { status: 200, schemaFingerprint: syntheticHash(42), normalizedMessageCount: 1 }, account: { status: 200, schemaFingerprint: syntheticHash(43), normalizedRowCount: 1 } };
    mockSuccess.retainedSeedDiscovery = { source: "COMET", addressHashes: [stage.addressHash(addressA)], addressHashSaltId: stage.ADDRESS_HASH_SALT, counts: { transactions: 1, messagePairs: 1, directSigners: 1 }, pairSetSha256: syntheticHash(44), txHashSetSha256: syntheticHash(45), exactStep9Baseline: true };
    mockSuccess.windows = [{ label: "pre-retention", fromDateTime: "2026-01-01T00:00:00.000Z", toDateTime: "2026-01-29T19:48:45.000Z" }];
    mockSuccess.enumeration = { fixedPointRounds: 1, queriedSignerHashCount: 1, initialSignerHashes: [stage.addressHash(addressA)], newSignerHashes: [], signerHashes: [stage.addressHash(addressA)], accountStats: [], uniqueTransactionDetails: 1, duplicateJoins: 0, directTargetMessages: 1, msgExecCount: 0, nestedTargetCount: 0, msgExecGlobalEnumerationGap: true, signerFixedPointSufficientForGlobalCompletion: false };
    mockSuccess.retainedOverlap = { exact: true, observedTransactions: 1, observedMessagePairs: 1, missingPairCount: 0, extraPairCount: 0, pairSetSha256: syntheticHash(44), expectedTransactions: 1, expectedMessagePairs: 1 };
    mockSuccess.preRetention = { transactionCount: 1, directTargetMessages: 1, minimumHeight: normalized.record.height, maximumHeight: normalized.record.height, quorumEventCount: normalized.record.quorumEvents.count, quorumEventSourceAvailableForAllRows: true, details: [normalized.record] };
    mockSuccess.completeness = { knownSeedApiSemantics: "EXACT_RETAINED_OVERLAP_FOR_DISCOVERED_SEEDS", globalCompleteness: false, completeHistoricalSignerRosterKnown: false, globalCollectionDocumented: false, fixedPointIsDiscoveryOnly: true, productionExposure: "UNKNOWN/COVERAGE_OPEN" };
    mockSuccess.httpBudget = { requestCount: 3, retryCount: 0, elapsedMs: 1000, budgetPolicy: "bounded-readonly-v1" };
    assert(stage.assertOutputSafe(mockSuccess, token));
    const first = memoryAdapter(); const firstSummary = stage.atomicPublish(mockSuccess, token, first);
    assert(first.commitOrder[first.commitOrder.length - 1].endsWith(".manifest.json"));
    assert.strictEqual(first.staged.size, 0); assert.strictEqual(first.finals.size, 7);
    for (const text of first.finals.values()) assert(stage.assertOutputSafe(text, token));
    const second = memoryAdapter(); const secondSummary = stage.atomicPublish(mockSuccess, token, second);
    assert.deepStrictEqual(firstSummary, secondSummary);
    assert.deepStrictEqual([...first.finals.entries()], [...second.finals.entries()]);
  });

  await check("partialPublicationReconciliation", async () => {
    const reconciliation = stage.reconcilePartialPublication();
    assert.strictEqual(reconciliation.mixedArtifactsRemain, false);
    assert(["NO_PARTIAL_ARTIFACTS", "COMPLETE_SET_PRESERVED"].includes(reconciliation.status));
  });

  await check("retainedOverlapMultiMessage", async () => {
    const smallBaseline = { pairs: new Set([stage.pairKey(txA, 0), stage.pairKey(txA, 2)]), txHashes: new Set([txA]) };
    const overlap = stage.compareRetainedOverlap([normalized.record], smallBaseline, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
    assert.strictEqual(overlap.exact, false);
    const retainedRecord = { ...normalized.record, height: "2556426" };
    const exact = stage.compareRetainedOverlap([retainedRecord], smallBaseline, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
    assert.strictEqual(exact.exact, true); assert.strictEqual(exact.observedMessagePairs, 2);
  });

  const after = new Map(LIVE_OUTPUTS.map((file) => [file, fileState(file)]));
  await check("offlineDidNotPublishLiveArtifacts", async () => assert.deepStrictEqual([...after], [...before]));

  const result = {
    schemaVersion: 1,
    stage: "Babylon Step 11 offline test result",
    mode: "offline-mocked-no-network",
    deterministicResultId: sha(JSON.stringify(Object.keys(checks).sort())),
    passed: Object.values(checks).every(Boolean),
    checkCount: Object.keys(checks).length,
    checks,
    retainedBaseline: baseline.counts,
    fixtureSha256: sha(fs.readFileSync(FIXTURE)),
    toolSha256: sha(fs.readFileSync(path.join(ROOT, "tools", "scan-babylon-mintscan-pre-retention-enumerator.js"))),
    credentialMaterialRetainedOrHashed: false,
    networkRequests: 0,
    liveArtifactsChanged: false,
  };
  stage.assertOutputSafe(result);
  fs.writeFileSync(RESULT, JSON.stringify(result, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ passed: result.passed, checkCount: result.checkCount, deterministicResultId: result.deterministicResultId, networkRequests: 0, liveArtifactsChanged: false }) + "\n");
}

main().catch((error) => {
  const code = error instanceof stage.SafeError ? error.code : "OFFLINE_TEST_FAILURE";
  process.stderr.write(`Babylon Step 11 offline tests failed: ${code}${error.offlineCheck ? ` (${error.offlineCheck})` : ""}${error.diagnostic && error.diagnostic.requestClass ? ` [${error.diagnostic.requestClass}]` : ""}\n`);
  process.exitCode = 1;
});
