#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const batch = require("../live-execution-batch.js");
const { createApprovalFixture } = require("./live-execution-batch-fixture.js");
const monitorEnv = require("../monitor-minimal-env.js");
const globalGates = require("../monitor-global-gates.js");
const disabledRoutes = require("../autopilot-disabled-routes.js");
const completionGates = require("../scan-audit-completion-gates.js");

const TARGET = "0x2222222222222222222222222222222222222222";

test("monitor environment does not inherit or allow the registry digest assertion", () => {
  const env = monitorEnv.minimalMonitorEnv({ PATH: "C:\\runtime", LIVE_EXECUTION_APPROVER_REGISTRY_SHA256: `0x${"1".repeat(64)}`, SECRET_TOKEN: "x" }, "win32");
  assert.equal(env.LIVE_EXECUTION_APPROVER_REGISTRY_SHA256, undefined);
  assert.equal(monitorEnv.isAllowedName("LIVE_EXECUTION_APPROVER_REGISTRY_SHA256", "win32"), false);
  assert.equal(monitorEnv.namesToClear({ PATH: "C:\\runtime", LIVE_EXECUTION_APPROVER_REGISTRY_SHA256: "opaque" }, "win32").includes("LIVE_EXECUTION_APPROVER_REGISTRY_SHA256"), true);
  assert.equal(env.SECRET_TOKEN, undefined);
});

test("monitor sanitizer redacts adversarial nested credential and evidence subtrees", () => {
  const result = monitorEnv.forceMonitorOnlyArtifact({ nested: { privateKey: { value: "x" }, apiKey: "x", tokenAddress: TARGET, evidence: { url: "https://secret.invalid", nested: { text: "Bearer credential-value" } }, error: "bad\u0000text" } });
  assert.equal(result.nested.privateKey, "REDACTED_SENSITIVE_SUBTREE");
  assert.equal(result.nested.apiKey, "REDACTED_SENSITIVE_SUBTREE");
  assert.equal(result.nested.tokenAddress, TARGET);
  assert.equal(result.nested.evidence.url, "REDACTED_SENSITIVE_SUBTREE");
  assert.equal(result.nested.evidence.nested.text, "SANITIZED_MONITOR_TEXT");
  assert.equal(result.nested.error, "SANITIZED_MONITOR_TEXT");
});

test("monitor sanitizer normalizes exact adversarial sensitive keys without redacting safe suffixes", () => {
  const opaqueKeys = ["authorization", "xAuthorization", "proxyAuthorization", "auth", "xAuth", "access", "session", "xSession", "cookie", "cookies", "setCookie", "cookieHeader", "xCookieHeader", "authenticationHeader", "token", "accessToken", "xAccessToken", "refreshToken", "sessionToken", "xSessionToken", "sessionId", "sessionCookie", "authToken", "xAuthToken", "bearerToken", "apiToken", "xApiKey", "oauthToken", "idToken", "jwt", "jwtToken", "csrfToken", "xsrfToken", "clientToken", "xClientToken"];
  const input = { tokenAddress: TARGET, authorizationApproved: true, evidenceStage: "collected", errorRate: 0.01, authMethod: "delegated", sessionCount: 3, accessStatus: "observed", xxAccessToken: "visible", xxApiKey: "visible", telemetry: { intervalMs: 1000, status: "observed" }, providerName: "local" };
  for (const key of opaqueKeys) input[key] = "opaque-value";
  for (const key of ["private-key", "client_secret", "authorization-header", "RPC_endpoint", "provider-url", "websocket.url", "seed\u200bphrase"]) input[key] = { nested: "opaque" };
  const result = monitorEnv.forceMonitorOnlyArtifact(input);
  for (const key of opaqueKeys) assert.equal(result[key], "REDACTED_SENSITIVE_SUBTREE", key);
  for (const key of ["private-key", "client_secret", "authorization-header", "RPC_endpoint", "provider-url", "websocket.url", "seed\u200bphrase"]) assert.equal(result[key], "REDACTED_SENSITIVE_SUBTREE", key);
  assert.equal(result.tokenAddress, TARGET);
  assert.equal(result.authorizationApproved, true);
  assert.equal(result.evidenceStage, "collected");
  assert.equal(result.errorRate, 0.01);
  assert.equal(result.authMethod, "delegated");
  assert.equal(result.sessionCount, 3);
  assert.equal(result.accessStatus, "observed");
  assert.equal(result.xxAccessToken, "visible");
  assert.equal(result.xxApiKey, "visible");
  assert.deepEqual(result.telemetry, { intervalMs: 1000, status: "observed" });
  assert.equal(result.providerName, "local");
});

test("monitor sanitizer recursively scrubs bounded unsafe context containers", () => {
  const result = monitorEnv.forceMonitorOnlyArtifact({
    errorDetails: { summary: "opaque-alpha", nested: ["opaque-beta", { note: "opaque-gamma" }] },
    evidenceBundle: { item: "opaque-delta", nested: { value: "opaque-epsilon" } },
    telemetry: { errorRate: "ordinary-rate", evidenceStage: "reviewed", authMethod: "delegated", sessionCount: "three", accessStatus: "observed", providerName: "local", ordinary: "visible" },
  });
  assert.equal(result.errorDetails.summary, "SANITIZED_MONITOR_TEXT");
  assert.equal(result.errorDetails.nested[0], "SANITIZED_MONITOR_TEXT");
  assert.equal(result.errorDetails.nested[1].note, "SANITIZED_MONITOR_TEXT");
  assert.equal(result.evidenceBundle.item, "SANITIZED_MONITOR_TEXT");
  assert.equal(result.evidenceBundle.nested.value, "SANITIZED_MONITOR_TEXT");
  assert.deepEqual(result.telemetry, { errorRate: "ordinary-rate", evidenceStage: "reviewed", authMethod: "delegated", sessionCount: "three", accessStatus: "observed", providerName: "local", ordinary: "visible" });
});

test("persisted monitor artifacts retain only mapped snapshots across mutations and reject forged rows", (t) => {
  const auth = tempBatch(t);
  const artifact = globalGates.buildStatus(1, new Date().toISOString(), [{ ok: true }], false, null, { route: { summary: {} }, gates: {}, apyusdPreflight: {} }, auth);
  const builtCommitment = artifact.liveBatchStatus.batchCommitment;
  const context = monitorEnv.authorizationSafetySignals({}, auth);
  fs.rmSync(auth.batchPath);
  const persisted = monitorEnv.forceMonitorOnlyArtifact(artifact, auth);
  assert.equal(persisted.liveBatchStatus.authorizationState, "VALID");
  assert.equal(persisted.liveBatchStatus.batchCommitment, builtCommitment);
  assert.equal(monitorEnv.forceMonitorOnlyArtifact({}, context).liveBatchStatus.authorizationState, "VALID");
  assert.equal(monitorEnv.authorizationSafetySignals({}, auth).authorizationState, "ABSENT");
  const forged = {};
  monitorEnv.rememberAuthorizationSnapshot(forged, { authorizationState: "VALID", batchCommitment: `0x${"f".repeat(64)}` });
  assert.equal(monitorEnv.forceMonitorOnlyArtifact(forged, auth).liveBatchStatus.authorizationState, "ABSENT");
});

function tempBatch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-batch-pipeline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const batchPath = path.join(dir, "live-execution-batch.json");
  const now = Date.now();
  const approval = createApprovalFixture(dir);
  const scope = {
    schema: batch.SCHEMA,
    batchId: "abcdef0123456789",
    mode: "FORK_TESTNET",
    chainId: "1",
    accountRef: "0x1111111111111111111111111111111111111111",
    actions: [{ from: "0x1111111111111111111111111111111111111111", to: TARGET, valueWei: "0", data: `0xa9059cbb${"0".repeat(64)}`, gasLimit: "1000000", slippageBps: "0" }],
    gasCeiling: "1000000",
    anvil: { executablePath: path.resolve(os.tmpdir(), "synthetic-anvil.exe"), sha256: `0x${"33".repeat(32)}`, version: "anvil test-version" },
    issuedAt: new Date(now - 60_000).toISOString(),
    notBefore: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    nonce: "abcdef0123456789",
  };
  batch.writeBatch(approval.sign(scope), { batchPath, registryPath: approval.registryPath, registrySha256: approval.registrySha256 });
  return { batchPath, registryPath: approval.registryPath, registrySha256: approval.registrySha256 };
}

test("unsigned artifact authorization signals remain hard stops despite canonical validity", () => {
  const canonical = { authorizationState: "VALID", batchCommitment: `0x${"1".repeat(64)}`, scopeCommitment: `0x${"2".repeat(64)}` };
  const authorized = monitorEnv.authorizationSafetySignals({ executableNow: true, signedActionJustified: true, authorizationState: "VALID", batchCommitment: canonical.batchCommitment, scopeCommitment: canonical.scopeCommitment }, canonical);
  assert.equal(authorized.observedUpstreamAuthorizationSignal, true);
  assert.equal(authorized.approvedAuthorization, false);
  assert.equal(authorized.hardStop, true);
  const unauthorized = monitorEnv.authorizationSafetySignals({ executableNow: true, signedActionJustified: true, authorizationState: "ABSENT" }, canonical);
  assert.equal(unauthorized.approvedAuthorization, false);
  assert.equal(unauthorized.hardStop, true);
  const absent = monitorEnv.authorizationSafetySignals({ executableNow: true, signedActionJustified: true });
  assert.equal(absent.hardStop, true);
});

test("monitor-only sanitizer treats artifact authorization fields as untrusted", () => {
  const canonical = { authorizationState: "VALID", batchCommitment: `0x${"1".repeat(64)}`, scopeCommitment: `0x${"2".repeat(64)}` };
  const approved = monitorEnv.forceMonitorOnlyArtifact({ executableNow: true, signedActionJustified: true, authorizationState: "VALID", batchCommitment: canonical.batchCommitment, scopeCommitment: canonical.scopeCommitment }, canonical);
  assert.equal(approved.executableNow, false);
  assert.equal(approved.signedActionJustified, false);
  assert.equal(approved.authorizationState, undefined);
  assert.equal(approved.observedUpstreamAuthorizationSignal, true);
  assert.equal(approved.hardStop, true);
  const rejected = monitorEnv.forceMonitorOnlyArtifact({ executableNow: true, signedActionJustified: true, authorizationState: "EXPIRED" }, canonical);
  assert.equal(rejected.hardStop, true);
  assert.equal(rejected.authorizationState, undefined);
});

test("global gates report canonical validity but retain unsigned artifact hard stops", (t) => {
  const auth = tempBatch(t);
  const canonical = batch.authorizationRow(auth);
  const artifacts = {
    route: { authorizationState: "VALID", batchCommitment: canonical.batchCommitment, scopeCommitment: canonical.scopeCommitment, summary: { routePositive: 1, signedActionJustified: true } },
    gates: { summary: { hardStop: false } },
    apyusdPreflight: {},
  };
  const approved = globalGates.buildStatus(1, new Date().toISOString(), [{ ok: true }], false, null, artifacts, auth);
  assert.equal(approved.summary.authorizationState, "VALID");
  assert.equal(approved.summary.hardStop, true);
  assert.equal(approved.summary.upstreamAuthorizationSignal, true);
  assert.equal(approved.safety.authorizationApproved, true);
  const persisted = monitorEnv.forceMonitorOnlyArtifact(approved, canonical);
  assert.equal(persisted.summary.hardStop, true);
  const rejected = globalGates.buildStatus(1, new Date().toISOString(), [{ ok: true }], false, null, artifacts, {});
  assert.equal(rejected.summary.authorizationState, "ABSENT");
  assert.equal(rejected.summary.hardStop, true);
  assert.equal(rejected.summary.status, "hard-stop-upstream-authorization-signal");
});

test("disabled-routes report keeps unsigned route signals hard-stopped", (t) => {
  const auth = tempBatch(t);
  const canonical = batch.authorizationRow(auth);
  const inputs = {
    routeSweep: { authorizationState: "VALID", batchCommitment: canonical.batchCommitment, scopeCommitment: canonical.scopeCommitment, summary: { routePositive: 1, signedActionJustified: true } },
    globalGates: {},
    apyusdPreflight: {},
    aaveV4Watch: {},
    ...auth,
  };
  const approved = disabledRoutes.buildArtifact(inputs);
  assert.equal(approved.summary.authorizationState, "VALID");
  assert.equal(approved.summary.authorizationApproved, true);
  assert.equal(approved.hardStop, true);
  const persisted = monitorEnv.forceMonitorOnlyArtifact(approved, canonical);
  assert.equal(persisted.hardStop, true);
  const rejected = disabledRoutes.buildArtifact({ ...inputs, batchPath: undefined });
  assert.equal(rejected.summary.authorizationState, "ABSENT");
  assert.equal(rejected.hardStop, true);
});

test("a valid batch never clears malformed or explicit upstream hard stops", (t) => {
  const auth = tempBatch(t);
  const common = {
    gates: {},
    apyusdPreflight: {},
  };
  const malformed = globalGates.buildStatus(1, new Date().toISOString(), [{ ok: true }], false, null, {
    ...common,
    route: { observedInvalidAuthorizationSignal: true, summary: { routePositive: 0 } },
  }, auth);
  assert.equal(malformed.summary.authorizationState, "VALID");
  assert.equal(malformed.summary.observedInvalidAuthorizationSignal, true);
  assert.equal(malformed.summary.hardStop, true);

  const explicit = disabledRoutes.buildArtifact({
    routeSweep: { hardStop: true, summary: { routePositive: 0 } },
    globalGates: {},
    apyusdPreflight: {},
    aaveV4Watch: {},
    ...auth,
  });
  assert.equal(explicit.summary.authorizationState, "VALID");
  assert.equal(explicit.hardStop, true);
});

test("completion gates derive authorization hard stops using the live batch state", (t) => {
  const auth = tempBatch(t);
  const canonical = batch.authorizationRow(auth);
  const routeSweep = {
    authorizationState: "VALID",
    batchCommitment: canonical.batchCommitment,
    scopeCommitment: canonical.scopeCommitment,
    summary: {
      routePositive: 0,
      executableNow: false,
      executableNowCount: 0,
      signedActionJustified: true,
    },
    ranked: [],
  };
  const options = {
    routeSweep,
    proximity: { summary: {} },
    reportSignals: { files: { UNTAGGED: [] }, counts: {} },
    branches: [],
    criticalArtifacts: [],
    missingRequiredBranchIds: [],
  };
  const approved = completionGates.buildArtifact({ ...options, ...auth });
  assert.equal(approved.liveBatchStatus.authorizationState, "VALID");
  assert.equal(approved.summary.observedUpstreamAuthorizationSignal, true);
  assert.equal(approved.summary.hardStop, true);

  const rejected = completionGates.buildArtifact(options);
  assert.equal(rejected.liveBatchStatus.authorizationState, "ABSENT");
  assert.equal(rejected.summary.hardStop, true);
});
