"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MODULE_PATH = path.join(__dirname, "run-profitable-async-liability-solidity-builder-image-inspect-executor-v1.js");
const AUTHORIZATION_PATH = path.join(__dirname, "vendor", "profitable-async-liability-solidity-builder-image-inspect-executor-v1", "authorization", "current-turn-authorization.json");
const SOURCE = fs.readFileSync(MODULE_PATH, "utf8");
const executor = require(MODULE_PATH);

function authorization() {
  return JSON.parse(fs.readFileSync(AUTHORIZATION_PATH, "utf8"));
}

function prohibitProcess(fn) {
  const original = childProcess.spawnSync;
  let calls = 0;
  childProcess.spawnSync = () => { calls += 1; throw new Error("REAL_PROCESS_FORBIDDEN"); };
  try { return { value: fn(), calls }; }
  finally { childProcess.spawnSync = original; }
}

test("exports are pure and contain no live executor or main", () => {
  assert.deepEqual(Object.keys(executor).sort(), [
    "NAMESPACE", "EXECUTE_FLAG", "ENDPOINT", "DOCKER_VERSION", "IMAGE", "MANIFEST_DIGEST",
    "MAX_OUTPUT_BYTES", "MAX_DIAGNOSTIC_BYTES", "TIMEOUT_MS", "ZERO_COUNTERS",
    "buildPlan", "simulateResponses", "validateAuthorizationValue", "validateDecisionValue",
    "validateFinalAuthorityValue",
  ].sort());
  for (const key of ["main", "executeFixed", "callDocker", "loadDecisionFixed", "loadFinalAuthorityFixed", "validateExecutorAuthorityFixed"]) assert.equal(Object.hasOwn(executor, key), false);
});

test("production main has exact argv-only signature and no option overrides", () => {
  assert.match(SOURCE, /function main\(argv\) \{/);
  assert.equal(SOURCE.includes("internalOptions"), false);
  assert.equal(SOURCE.includes("options = {}"), false);
  assert.equal(SOURCE.includes("decisionRoot"), false);
  assert.equal(SOURCE.includes("authorizationPath"), false);
  assert.equal(SOURCE.includes("spawnSync:"), false);
  assert.match(SOURCE, /main\(process\.argv\.slice\(2\)\)/);
});

test("production source fixes executor decision final and run roots", () => {
  for (const literal of [
    "profitable-async-liability-solidity-builder-image-inspect-executor-v1-review-decision",
    "profitable-async-liability-solidity-builder-image-inspect-executor-v1-final-authority",
    'const RUNS_ROOT = path.join(PACKAGE_ROOT, "runs")',
    'const AUTHORIZATION_PATH = path.join(PACKAGE_ROOT, "authorization", "current-turn-authorization.json")',
  ]) assert.equal(SOURCE.includes(literal), true, literal);
});

test("require and pure APIs make zero real process calls", () => {
  const observed = prohibitProcess(() => {
    executor.buildPlan();
    executor.validateAuthorizationValue(authorization());
    executor.simulateResponses({
      version: { status: 0, errorCode: null },
      info: { status: 0, errorCode: null },
      inspect: { status: 0, errorCode: null },
    });
  });
  assert.equal(observed.calls, 0);
});

test("exact plan permits only version info and digest inspect", () => {
  const plan = executor.buildPlan("<EMPTY_CONFIG>");
  assert.deepEqual(plan.versionArgv, ["--config", "<EMPTY_CONFIG>", "--host", executor.ENDPOINT, "version", "--format", "{{json .}}"]);
  assert.deepEqual(plan.infoArgv, ["--config", "<EMPTY_CONFIG>", "--host", executor.ENDPOINT, "info", "--format", "{{json .}}"]);
  assert.deepEqual(plan.inspectArgv, ["--config", "<EMPTY_CONFIG>", "--host", executor.ENDPOINT, "image", "inspect", executor.IMAGE]);
  assert.equal(plan.shell, false); assert.equal(plan.timeoutMs, 30000); assert.equal(plan.maxBufferBytes, 2097152);
  const all = [...plan.versionArgv, ...plan.infoArgv, ...plan.inspectArgv];
  for (const forbidden of ["pull", "tag", "login", "create", "start", "build", "rm", "remove"]) assert.equal(all.includes(forbidden), false);
});

test("authorization validator rejects broadened scope", () => {
  const base = authorization();
  executor.validateAuthorizationValue(base);
  const mutations = [
    (x) => { x.scope.maxCalls = 4; },
    (x) => { x.scope.endpoint = "tcp://remote"; },
    (x) => { x.scope.forbidden.pop(); },
    (x) => { x.review.selfApprovalForbidden = false; },
    (x) => { x.review.distinctFinalAuthorityPackage = "other"; },
  ];
  for (const mutate of mutations) { const value = JSON.parse(JSON.stringify(base)); mutate(value); assert.throws(() => executor.validateAuthorizationValue(value)); }
});

function bindings() {
  const auth = authorization();
  return {
    authorization: auth,
    authorizationSha256: "1".repeat(64),
    executorSha256: "2".repeat(64),
    executorAuthoritySha256: "3".repeat(64),
    executorDetachedChecksumSha256: "4".repeat(64),
    decisionSha256: "5".repeat(64),
    decisionAuthoritySha256: "6".repeat(64),
    decisionDetachedChecksumSha256: "7".repeat(64),
  };
}

function validDecision(b) {
  return {
    schema: `${executor.NAMESPACE}/review-decision-v1`, status: "APPROVED_UNCHANGED_FOR_ONE_SHOT_EXECUTION",
    authorizationId: b.authorization.authorizationId, executorNamespace: executor.NAMESPACE,
    executorSha256: b.executorSha256, executorAuthoritySha256: b.executorAuthoritySha256,
    executorDetachedChecksumSha256: b.executorDetachedChecksumSha256,
    authorizationSha256: b.authorizationSha256, scope: b.authorization.scope,
    verdict: "ORACLE_APPROVE_UNCHANGED_ONE_SHOT",
  };
}

test("decision validator binds exact executor authorization and scope", () => {
  const b = bindings(); executor.validateDecisionValue(validDecision(b), b);
  for (const key of ["executorSha256", "executorAuthoritySha256", "executorDetachedChecksumSha256", "authorizationSha256"]) {
    const value = JSON.parse(JSON.stringify(validDecision(b))); value[key] = "0".repeat(64);
    assert.throws(() => executor.validateDecisionValue(value, b));
  }
  const broad = JSON.parse(JSON.stringify(validDecision(b))); broad.scope.maxCalls = 4;
  assert.throws(() => executor.validateDecisionValue(broad, b));
});

function validFinal(b) {
  return {
    schema: `${executor.NAMESPACE}/final-execution-authority-v1`, status: "FINAL_ONE_SHOT_EXECUTION_AUTHORITY",
    authorizationId: b.authorization.authorizationId, executorNamespace: executor.NAMESPACE,
    executorSha256: b.executorSha256, executorAuthoritySha256: b.executorAuthoritySha256,
    executorDetachedChecksumSha256: b.executorDetachedChecksumSha256,
    authorizationSha256: b.authorizationSha256, decisionSha256: b.decisionSha256,
    decisionAuthoritySha256: b.decisionAuthoritySha256,
    decisionDetachedChecksumSha256: b.decisionDetachedChecksumSha256,
    scope: b.authorization.scope, oracleDisposition: "ORACLE_FINAL_APPROVE_ONE_EXECUTION",
    oneShot: { consumeBeforeFirstCall: true, noReuseOnFailure: true },
  };
}

test("final authority validator binds decision and all immutable executor hashes", () => {
  const b = bindings(); executor.validateFinalAuthorityValue(validFinal(b), b);
  for (const key of ["authorizationSha256", "decisionSha256", "decisionAuthoritySha256", "decisionDetachedChecksumSha256", "executorSha256", "executorAuthoritySha256", "executorDetachedChecksumSha256"]) {
    const value = JSON.parse(JSON.stringify(validFinal(b))); value[key] = "0".repeat(64);
    assert.throws(() => executor.validateFinalAuthorityValue(value, b));
  }
  const wrong = validFinal(b); wrong.oracleDisposition = "SELF_APPROVE";
  assert.throws(() => executor.validateFinalAuthorityValue(wrong, b));
});

test("pure simulation reports accurate success counters", () => {
  const result = executor.simulateResponses({
    version: { status: 0, errorCode: null }, info: { status: 0, errorCode: null }, inspect: { status: 0, errorCode: null },
  });
  assert.equal(result.status, "SIMULATED_SUCCESS"); assert.equal(result.counters.processCalls, 3);
  assert.equal(result.counters.daemonVersionSuccess, 1); assert.equal(result.counters.daemonInfoSuccess, 1); assert.equal(result.counters.imageInspectSuccess, 1);
  for (const key of ["pullRequests", "tagRequests", "fallbackRequests", "loginRequests", "containerCreateRequests", "startRequests", "buildRequests", "removeRequests", "alternateEndpointRequests"]) assert.equal(result.counters[key], 0);
});

test("pure simulation covers cache qualification timeout and ENOBUFS codes", () => {
  const cases = [
    ["version", { status: 1, errorCode: null }, "DAEMON_VERSION_FAILED", 1],
    ["info", { status: 1, errorCode: "ETIMEDOUT" }, "DAEMON_INFO_FAILED", 2],
    ["inspect", { status: 1, errorCode: null }, "IMAGE_NOT_CACHED_OR_INSPECT_FAILED", 3],
    ["version", { status: 1, errorCode: "ENOBUFS" }, "QUALIFICATION_OUTPUT_LIMIT_EXCEEDED", 1],
    ["inspect", { status: 1, errorCode: "ENOBUFS" }, "INSPECT_OUTPUT_LIMIT_EXCEEDED", 3],
  ];
  for (const [key, response, code, calls] of cases) {
    const rows = { version: { status: 0, errorCode: null }, info: { status: 0, errorCode: null }, inspect: { status: 0, errorCode: null } };
    rows[key] = response; const result = executor.simulateResponses(rows);
    assert.equal(result.errorCode, code); assert.equal(result.counters.processCalls, calls);
  }
});

test("source reloads fixed authorities before consumption and calls", () => {
  const mainStart = SOURCE.indexOf("function main(argv)");
  const mainSource = SOURCE.slice(mainStart, SOURCE.indexOf("if (require.main", mainStart));
  const executorIndex = mainSource.indexOf("validateExecutorAuthorityFixed()");
  const decisionIndex = mainSource.indexOf("loadDecisionFixed(");
  const finalIndex = mainSource.indexOf("loadFinalAuthorityFixed(");
  const executeIndex = mainSource.indexOf("executeFixed(");
  assert.equal(executorIndex >= 0 && executorIndex < decisionIndex && decisionIndex < finalIndex && finalIndex < executeIndex, true);
  assert.equal(SOURCE.indexOf("establishConsumption(bindings)") < SOURCE.indexOf('childProcess.spawnSync("docker"'), true);
});

test("consumption schema binds nine required hashes", () => {
  for (const key of [
    "authorizationSha256", "decisionSha256", "decisionAuthoritySha256", "decisionDetachedChecksumSha256",
    "executorSha256", "executorAuthoritySha256", "executorDetachedChecksumSha256",
    "finalAuthoritySha256", "finalDetachedChecksumSha256",
  ]) assert.equal(SOURCE.includes(`${key}: bindings.${key}`), true, key);
});

test("fixed path safety runs before semantic decision and final reads", () => {
  const decisionFunction = SOURCE.slice(SOURCE.indexOf("function loadDecisionFixed"), SOURCE.indexOf("function loadFinalAuthorityFixed"));
  assert.equal(decisionFunction.indexOf("assertFixedPackageFilesSafe") < decisionFunction.indexOf("readJson(DECISION_AUTHORITY_PATH"), true);
  const finalFunction = SOURCE.slice(SOURCE.indexOf("function loadFinalAuthorityFixed"), SOURCE.indexOf("function sanitizedDockerEnv"));
  assert.equal(finalFunction.indexOf("assertFixedPackageFilesSafe") < finalFunction.indexOf("readJson(FINAL_AUTHORITY_PATH"), true);
});

test("default CLI succeeds offline and absent decision flag is structurally gated", () => {
  assert.equal(SOURCE.includes('"REVIEW_DECISION_REQUIRED"'), true);
  assert.equal(SOURCE.includes('"FINAL_EXECUTION_AUTHORITY_REQUIRED"'), true);
  assert.equal(SOURCE.includes('if (argv.length !== 1 || argv[0] !== EXECUTE_FLAG)'), true);
});
