"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MODULE_PATH = path.join(__dirname, "run-profitable-async-liability-solidity-builder-image-inspect-execution-v1.js");

function freshModule() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

function prohibitProcessesAndWrites(fn) {
  const originalSpawn = childProcess.spawnSync;
  const originalWrite = fs.writeFileSync;
  const originalOpen = fs.openSync;
  const originalMkdir = fs.mkdirSync;
  let processes = 0;
  let writes = 0;
  childProcess.spawnSync = () => { processes += 1; throw new Error("PROCESS_FORBIDDEN"); };
  fs.writeFileSync = () => { writes += 1; throw new Error("WRITE_FORBIDDEN"); };
  fs.openSync = (...args) => {
    if (/[wax+]/.test(String(args[1]))) { writes += 1; throw new Error("WRITE_FORBIDDEN"); }
    return originalOpen(...args);
  };
  fs.mkdirSync = () => { writes += 1; throw new Error("WRITE_FORBIDDEN"); };
  try { return { value: fn(), processes, writes }; }
  finally {
    childProcess.spawnSync = originalSpawn;
    fs.writeFileSync = originalWrite;
    fs.openSync = originalOpen;
    fs.mkdirSync = originalMkdir;
  }
}

test("production harness source has no child_process or process execution primitive", () => {
  const source = fs.readFileSync(MODULE_PATH, "utf8");
  assert.equal(source.includes("child_process"), false);
  assert.equal(source.includes("spawnSync"), false);
  assert.equal(source.includes("execSync"), false);
  assert.equal(source.includes("executeAuthorized"), false);
  assert.equal(source.includes("loadFutureAuthorization"), false);
});

test("require/import performs zero processes and writes", () => {
  const observed = prohibitProcessesAndWrites(() => freshModule());
  assert.equal(observed.processes, 0);
  assert.equal(observed.writes, 0);
  assert.equal(typeof observed.value.simulatePlan, "function");
});

test("default validates proposal with zero processes and writes", () => {
  const proposal = freshModule();
  const observed = prohibitProcessesAndWrites(() => proposal.main([]));
  assert.equal(observed.processes, 0);
  assert.equal(observed.writes, 0);
  assert.equal(observed.value.status, "PASS");
  assert.equal(observed.value.executable, false);
  assert.equal(observed.value.executionAuthorized, false);
  assert.equal(observed.value.processCalls, 0);
  assert.equal(observed.value.writes, 0);
  assert.equal(JSON.stringify(observed.value).includes("argv"), false);
  assert.equal(JSON.stringify(observed.value).includes("C:\\"), false);
});

test("reserved and predecessor flags always fail before processes and writes", () => {
  const proposal = freshModule();
  for (const [flag, code] of [
    [proposal.EXECUTE_FLAG, "DISTINCT_HASH_PINNED_EXECUTOR_REQUIRED"],
    ["--execute-reviewed-gate0", "ARGUMENTS_REJECTED"],
    ["--execute-reviewed-image-inspect-diagnostic-v2", "ARGUMENTS_REJECTED"],
    ["--unknown", "ARGUMENTS_REJECTED"],
  ]) {
    const observed = prohibitProcessesAndWrites(() => assert.throws(() => proposal.main([flag]), new RegExp(code)));
    assert.equal(observed.processes, 0, flag);
    assert.equal(observed.writes, 0, flag);
  }
});

test("valid-looking grant and decision files cannot alter flag behavior", () => {
  const proposal = freshModule();
  const authorizationRoot = path.join(__dirname, "vendor", proposal.NAMESPACE, "authorizations");
  assert.equal(fs.existsSync(authorizationRoot), false);
  const observed = prohibitProcessesAndWrites(() => assert.throws(() => proposal.main([proposal.EXECUTE_FLAG]), /DISTINCT_HASH_PINNED_EXECUTOR_REQUIRED/));
  assert.equal(observed.processes, 0);
  assert.equal(observed.writes, 0);
  const source = fs.readFileSync(MODULE_PATH, "utf8");
  assert.equal(source.includes("fresh-execution-authority.json"), false);
  assert.equal(source.includes("fresh-execution-decision.json"), false);
});

test("exports contain pure proposal helpers and no executor", () => {
  const proposal = freshModule();
  assert.deepEqual(Object.keys(proposal).sort(), [
    "DOCKER_VERSION", "ENDPOINT", "EXECUTE_FLAG", "IMAGE", "MANIFEST_DIGEST",
    "MAX_DIAGNOSTIC_BYTES", "MAX_OUTPUT_BYTES", "NAMESPACE", "TIMEOUT_MS", "ZERO_COUNTERS",
    "buildOfflinePlan", "fileRecord", "fixtureResponses", "main", "runDefault",
    "runOfflineFixtures", "safeErrorCode", "simulatePlan", "validateAuthorityChain",
  ].sort());
  for (const forbidden of ["executeAuthorized", "processCall", "loadFutureAuthorization", "prepareRun", "openJournal", "durableWrite"]) assert.equal(Object.hasOwn(proposal, forbidden), false);
});

test("offline plan preserves exact future argv and forbidden operation design as data only", () => {
  const proposal = freshModule();
  const plan = proposal.buildOfflinePlan("<EMPTY_CONFIG>");
  assert.deepEqual(plan.versionArgv, ["--config", "<EMPTY_CONFIG>", "--host", proposal.ENDPOINT, "version", "--format", "{{json .}}"]);
  assert.deepEqual(plan.infoArgv, ["--config", "<EMPTY_CONFIG>", "--host", proposal.ENDPOINT, "info", "--format", "{{json .}}"]);
  assert.deepEqual(plan.inspectArgv, ["--config", "<EMPTY_CONFIG>", "--host", proposal.ENDPOINT, "image", "inspect", proposal.IMAGE]);
  assert.equal(plan.shell, false);
  assert.equal(plan.timeoutMs, 30000);
  assert.equal(plan.maxBufferBytes, 2097152);
  assert.deepEqual(plan.forbiddenOperations, ["pull", "tag", "fallback", "create", "start", "build", "remove"]);
});

test("pure successful simulation reports accurate simulated counters without paths or argv", () => {
  const proposal = freshModule();
  const before = prohibitProcessesAndWrites(() => proposal.simulatePlan(proposal.fixtureResponses()));
  assert.equal(before.processes, 0);
  assert.equal(before.writes, 0);
  const result = before.value;
  assert.equal(result.status, "SIMULATED_DIAGNOSTIC");
  assert.equal(result.errorCode, null);
  assert.equal(result.counters.processCalls, 3);
  assert.equal(result.counters.daemonQualificationRequests, 2);
  assert.equal(result.counters.daemonQualificationSuccess, 2);
  assert.equal(result.counters.imageInspectRequests, 1);
  assert.equal(result.counters.imageInspectSuccess, 1);
  assert.equal(result.counters.diagnosticsProduced, 1);
  for (const key of ["pullRequests", "tagRequests", "fallbackRequests", "containerCreateRequests", "startRequests", "buildRequests", "removeRequests", "writes"]) assert.equal(result.counters[key], 0);
  const text = JSON.stringify(result);
  for (const forbidden of ["argv", "dockerConfig", "C:\\", proposal.ENDPOINT]) assert.equal(text.includes(forbidden), false);
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("simulated qualification failures propagate exact counts and fixed sanitized codes", () => {
  const proposal = freshModule();
  const base = proposal.fixtureResponses();
  const cases = [
    ["version", { status: 1, errorCode: "EFAIL", stdoutBytes: 0, stdout: "" }, "QUALIFICATION_VERSION_FAILED", 1],
    ["info", { status: 1, errorCode: "EFAIL", stdoutBytes: 0, stdout: "" }, "QUALIFICATION_INFO_FAILED", 2],
    ["version", { status: 0, errorCode: null, stdoutBytes: 8, stdout: "not-json" }, "QUALIFICATION_OUTPUT_INVALID", 1],
  ];
  for (const [key, response, code, calls] of cases) {
    const fixture = clone(base); fixture[key] = response;
    const result = proposal.simulatePlan(fixture);
    assert.equal(result.status, "SIMULATED_FAILURE");
    assert.equal(result.errorCode, code);
    assert.equal(result.counters.processCalls, calls);
    assert.equal(result.counters.writes, 0);
  }
});

test("simulated ENOBUFS has operation-specific fixed output-limit codes", () => {
  const proposal = freshModule();
  for (const [key, code, calls] of [
    ["version", "QUALIFICATION_OUTPUT_LIMIT_EXCEEDED", 1],
    ["info", "QUALIFICATION_OUTPUT_LIMIT_EXCEEDED", 2],
    ["inspect", "INSPECT_OUTPUT_LIMIT_EXCEEDED", 3],
  ]) {
    const fixture = clone(proposal.fixtureResponses());
    fixture[key] = { status: 1, errorCode: "ENOBUFS", stdoutBytes: 0, stdout: "" };
    const result = proposal.simulatePlan(fixture);
    assert.equal(result.errorCode, code);
    assert.equal(result.counters.processCalls, calls);
    assert.equal(result.counters.writes, 0);
  }
});

test("simulated cache absence and malformed inspect are sanitized and accurately counted", () => {
  const proposal = freshModule();
  const missing = clone(proposal.fixtureResponses());
  missing.inspect = { status: 1, errorCode: "EFAIL", stdoutBytes: 0, stdout: "" };
  const missingResult = proposal.simulatePlan(missing);
  assert.equal(missingResult.errorCode, "IMAGE_NOT_CACHED_OR_INSPECT_FAILED");
  assert.equal(missingResult.counters.processCalls, 3);
  assert.equal(missingResult.counters.imageInspectRequests, 1);
  assert.equal(missingResult.counters.imageInspectSuccess, 0);
  const malformed = clone(proposal.fixtureResponses());
  malformed.inspect = { status: 0, errorCode: null, stdoutBytes: 8, stdout: "not-json" };
  const malformedResult = proposal.simulatePlan(malformed);
  assert.equal(malformedResult.errorCode, "INSPECT_OUTPUT_INVALID");
  assert.equal(malformedResult.counters.processCalls, 3);
  assert.equal(malformedResult.counters.writes, 0);
});

test("authority declares non-executable package and future distinct executor requirements", () => {
  const proposal = freshModule();
  const chain = proposal.validateAuthorityChain();
  assert.equal(chain.authority.executable, false);
  assert.equal(chain.authority.executionAuthorized, false);
  assert.equal(chain.authority.futureExecutor.grantDropInCannotEnableThisPackage, true);
  assert.equal(chain.authority.detachedChecksumRole, "LOCAL_INTEGRITY_CHECK_ONLY_NOT_EXTERNAL_TRUST_ANCHOR");
  assert.equal(chain.manifest.futureRequirements.packageRootSafety.linkJunctionReparseRejectionRequired, true);
  assert.equal(chain.manifest.futureRequirements.currentPackageWritesConsumptionMarker, false);
  assert.deepEqual(chain.manifest.futureRequirements.consumptionMustBind, ["grantSha256", "decisionSha256", "executorSha256", "executorAuthoritySha256", "detachedExecutorChecksumSha256"]);
});
