"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MODULE_PATH = path.join(__dirname, "run-profitable-async-liability-solidity-builder-corrected-two-build-executor-v1.js");
const AUTH_PATH = path.join(__dirname, "vendor", "profitable-async-liability-solidity-builder-corrected-two-build-executor-v1", "authorization", "current-turn-authorization.json");
const FIXTURE_PATH = path.join(__dirname, "vendor", "profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2", "fixtures", "image-inspect-match.json");
const SOURCE = fs.readFileSync(MODULE_PATH, "utf8");
const executor = require(MODULE_PATH);
function authorization() { return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8")); }
function inspect() { return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"))[0]; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

test("exports pure helpers only and no live path", () => {
  assert.deepEqual(Object.keys(executor).sort(), ["NAMESPACE", "EXECUTE_FLAG", "ENDPOINT", "IMAGE", "OUTPUT_BYTES", "OUTPUT_SHA256", "EMCC_ARGV", "ZERO_COUNTERS", "SUCCESS_COUNTERS", "CONSUMPTION_BINDING_KEYS", "buildPlan", "simulatePlan", "validateAuthorizationValue", "validateDecisionValue", "validateFinalAuthorityValue", "validateImageInspectPure"].sort());
  for (const key of ["main", "executeFixed", "callDocker", "loadDecision", "loadFinal", "stageAndConsume"]) assert.equal(Object.hasOwn(executor, key), false);
});

test("production main is argv-only with no hook option or path override", () => {
  assert.match(SOURCE, /function main\(argv\) \{/); assert.match(SOURCE, /main\(process\.argv\.slice\(2\)\)/);
  for (const bad of ["internalOptions", "options = {}", "spawnSync:", "decisionRoot", "finalRoot", "runRootOverride", "authorizationPath"]) assert.equal(SOURCE.includes(bad), false, bad);
});

test("authorization embeds exact bounded interpretation and rejects broadening", () => {
  const base = authorization(); executor.validateAuthorizationValue(base);
  assert.equal(base.boundedInterpretation, "User's current-turn 'please' responded directly to the stated requirement for fresh authorization to create/review/conditionally execute the two-build successor. It authorizes only creation, independent review, and conditional one-shot execution after approval of this exact bounded successor; it does not authorize immediate execution, broader Docker use, parser promotion, detector execution, inventory access, network access, or any retry.");
  const mutations = [(x) => { x.scope.successfulDockerCallsExactly = 18; }, (x) => { x.scope.startsExactly = 3; }, (x) => { x.scope.forbidden.pop(); }, (x) => { x.scope.sequential = "PARALLEL"; }, (x) => { x.review.selfApprovalForbidden = false; }, (x) => { x.boundedInterpretation += " broadened"; }];
  for (const mutate of mutations) { const value = clone(base); mutate(value); assert.throws(() => executor.validateAuthorizationValue(value)); }
});

test("exact successful plan is 17 calls and strictly sequential", () => {
  const plan = executor.buildPlan("<EMPTY>", "<ROOT>", "1".repeat(32));
  assert.equal(plan.operations.length, 17);
  assert.deepEqual(plan.operations, ["VERSION", "INFO", "IMAGE_INSPECT", "A_ABSENCE_BEFORE", "A_CREATE", "A_CREATED_INSPECT", "A_START_ATTACH", "A_EXITED_INSPECT", "A_RM_FORCE", "A_ABSENCE_AFTER", "B_ABSENCE_BEFORE", "B_CREATE", "B_CREATED_INSPECT", "B_START_ATTACH", "B_EXITED_INSPECT", "B_RM_FORCE", "B_ABSENCE_AFTER"]);
  assert.equal(plan.operations.filter((x) => x.endsWith("START_ATTACH")).length, 2);
  assert.equal(plan.operations.indexOf("A_ABSENCE_AFTER") < plan.operations.indexOf("B_ABSENCE_BEFORE"), true);
});

test("plan uses cached digest and excludes forbidden Docker operations", () => {
  const plan = executor.buildPlan("<EMPTY>", "<ROOT>", "2".repeat(32));
  assert.deepEqual(plan.imageInspectArgv.slice(-3), ["image", "inspect", executor.IMAGE]);
  for (const build of plan.builds) {
    assert.equal(build.createArgv.includes("--pull") && build.createArgv.includes("never"), true);
    assert.equal(build.createArgv.slice(-executor.EMCC_ARGV.length).join("\0"), executor.EMCC_ARGV.join("\0"));
    assert.equal(build.createArgv.includes("SOURCE_DATE_EPOCH"), false);
    assert.equal(build.createArgv.filter((x) => x === "--mount").length, 2); assert.equal(build.createArgv.filter((x) => x === "--tmpfs").length, 3);
    assert.equal(build.createArgv.some((x) => String(x).includes("tree-sitter-solidity.wasm") && String(x).includes("src=")), false);
  }
  const all = JSON.stringify(plan);
  for (const forbidden of ["\"pull\"", "\"tag\"", "\"login\"", "fallback", "inventory", "tcp://"]) assert.equal(all.toLowerCase().includes(forbidden), false, forbidden);
});

test("successful simulation produces exact request success and observed counters", () => {
  const result = executor.simulatePlan(); assert.equal(result.status, "SIMULATED_SUCCESS"); assert.deepEqual(result.counters, executor.SUCCESS_COUNTERS);
  assert.equal(result.observed.length, 17); assert.equal(result.counters.startRequests, 2); assert.equal(result.counters.daemonObservedStarts, 2); assert.equal(result.counters.verifiedBuilds, 2);
});

test("every planned failure stops or cleans up with honest counters", () => {
  const operations = executor.buildPlan().operations;
  for (const operation of operations) {
    const result = executor.simulatePlan(operation); assert.equal(result.status, "SIMULATED_FAILURE", operation);
    assert.equal(result.counters.processCalls, result.observed.length, operation);
    assert.equal(result.counters.startRequests >= result.counters.daemonObservedStarts, true);
    assert.equal(result.counters.createRequests >= result.counters.createSuccess, true);
    assert.equal(result.counters.removeRequests >= result.counters.removeSuccess, true);
    if (operation.startsWith("A_")) assert.equal(result.observed.some((x) => x.startsWith("B_")), false, operation);
  }
});

test("indeterminate create requests cleanup and absence", () => {
  for (const operation of ["A_CREATE", "B_CREATE"]) {
    const result = executor.simulatePlan(operation); const label = operation[0];
    assert.equal(result.observed.includes(`${label}_RM_FORCE`), true); assert.equal(result.observed.includes(`${label}_ABSENCE_AFTER`), true);
  }
});

test("correction-v2 exact User and Cmd compatibility accepts only bounded defaults", () => {
  for (const mode of ["missing", "null", "empty"]) { const value = inspect(); if (mode === "missing") delete value.Config.User; else value.Config.User = mode === "null" ? null : ""; executor.validateImageInspectPure(value); }
  for (const value of ["root", 0, false, [], {}]) { const image = inspect(); image.Config.User = value; assert.throws(() => executor.validateImageInspectPure(image)); }
  for (const mode of ["missing", "null"]) { const value = inspect(); if (mode === "missing") delete value.Config.Cmd; else value.Config.Cmd = null; executor.validateImageInspectPure(value); }
  for (const value of [[], "", {}, false, 0]) { const image = inspect(); image.Config.Cmd = value; assert.throws(() => executor.validateImageInspectPure(image)); }
});

test("no broad normalization hides any of the other seven strict mismatches", () => {
  const cases = [(x) => { x.Id = "bad"; }, (x) => { x.RepoDigests = []; }, (x) => { x.Os = "windows"; }, (x) => { x.Architecture = "arm64"; }, (x) => { x.RootFS.Layers = []; }, (x) => { x.Config.Entrypoint = []; }, (x) => { x.Config.Env.push("EXTRA=x"); }];
  for (const mutate of cases) { const image = inspect(); mutate(image); assert.throws(() => executor.validateImageInspectPure(image), /IMAGE_INSPECT_INVALID/); }
});

test("strict correction input rejects adversarial JavaScript", () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, () => 1, Symbol("x"), 1n, new Date(), new Map(), new Set(), Buffer.from([1]), new Uint8Array([1])]) { const image = inspect(); image.Extra = value; assert.throws(() => executor.validateImageInspectPure(image)); }
  let calls = 0; const getter = inspect(); Object.defineProperty(getter.Config, "Trap", { enumerable: true, get() { calls += 1; return 1; } }); assert.throws(() => executor.validateImageInspectPure(getter)); assert.equal(calls, 0);
  const json = inspect(); Object.defineProperty(json.Config, "toJSON", { value() { calls += 1; return {}; } }); assert.throws(() => executor.validateImageInspectPure(json)); assert.equal(calls, 0);
  const cycle = inspect(); cycle.Self = cycle; assert.throws(() => executor.validateImageInspectPure(cycle));
});

function fakeBindings() {
  const auth = authorization(); const out = { authorization: auth };
  for (const [index, key] of executor.CONSUMPTION_BINDING_KEYS.entries()) out[key] = ((index + 1) % 16).toString(16).repeat(64);
  return out;
}
function decision(bindings) {
  const keys = executor.CONSUMPTION_BINDING_KEYS.slice(0, 15); return { schema: `${executor.NAMESPACE}/review-decision-v1`, status: "APPROVED_UNCHANGED_FOR_ONE_CONDITIONAL_EXECUTION", authorizationId: bindings.authorization.authorizationId, executorNamespace: executor.NAMESPACE, bindings: Object.fromEntries(keys.map((key) => [key, bindings[key]])), scope: bindings.authorization.scope, verdict: "ORACLE_APPROVE_UNCHANGED_CONDITIONAL_ONE_SHOT" };
}

test("review decision binds fifteen base chain/source hashes and exact scope", () => {
  const bindings = fakeBindings(); const value = decision(bindings); executor.validateDecisionValue(value, bindings); assert.equal(Object.keys(value.bindings).length, 15);
  for (const key of Object.keys(value.bindings)) { const bad = clone(value); bad.bindings[key] = "0".repeat(64); assert.throws(() => executor.validateDecisionValue(bad, bindings)); }
});

test("final authority binds decision plus all pre-final immutable records", () => {
  const bindings = fakeBindings();
  const keys = executor.CONSUMPTION_BINDING_KEYS.filter((key) => !["finalAuthoritySha256", "finalDetachedChecksumSha256"].includes(key));
  const value = { schema: `${executor.NAMESPACE}/final-execution-authority-v1`, status: "FINAL_ONE_SHOT_TWO_BUILD_EXECUTION_AUTHORITY", authorizationId: bindings.authorization.authorizationId, executorNamespace: executor.NAMESPACE, bindings: Object.fromEntries(keys.map((key) => [key, bindings[key]])), scope: bindings.authorization.scope, oracleDisposition: "ORACLE_FINAL_APPROVE_ONE_CONDITIONAL_EXECUTION", oneShot: { consumeBeforeFirstDockerCall: true, noRetry: true, noBuildBAfterBuildAFailure: true } };
  executor.validateFinalAuthorityValue(value, bindings);
  const bad = clone(value); bad.oneShot.noRetry = false; assert.throws(() => executor.validateFinalAuthorityValue(bad, bindings));
});

test("consumption binds twenty hashes including source and published records", () => {
  assert.equal(executor.CONSUMPTION_BINDING_KEYS.length, 20); assert.equal(new Set(executor.CONSUMPTION_BINDING_KEYS).size, 20);
  for (const key of ["parserCSha256", "parserHeaderSha256", "grammarJsonSha256", "publishedWasmSha256", "correctionV2PackageSha256", "decisionSha256", "finalAuthoritySha256"]) assert.equal(executor.CONSUMPTION_BINDING_KEYS.includes(key), true);
  assert.match(SOURCE, /bindings: Object\.fromEntries\(CONSUMPTION_BINDING_KEYS\.map/);
});

test("source consumes before Docker and rehashes published WASM twice", () => {
  assert.equal(SOURCE.indexOf("stageAndConsume(bindings)") < SOURCE.indexOf('childProcess.spawnSync("docker"'), true);
  assert.equal((SOURCE.match(/fileRecord\(resolveRecord\(PUBLISHED_RECORD\)\)/g) || []).length >= 2, true);
  assert.equal(SOURCE.includes("publishedWasmMounted"), false);
});

test("journal fsync fixed sanitized records and artifacts omit bodies argv env paths", () => {
  assert.match(SOURCE, /fs\.fsyncSync\(fd\); seq \+= 1/); assert.match(SOURCE, /const row = \{ seq, phase, operation, counters \}/);
  const journalSection = SOURCE.slice(SOURCE.indexOf("function openJournal"), SOURCE.indexOf("function callDocker"));
  for (const forbidden of ["stdout", "stderr", "argv", "env", "sourceDir", "outputDir"]) assert.equal(journalSection.includes(forbidden), false, forbidden);
});

test("raw process bodies are memory-only bounded and errors fixed", () => {
  assert.match(SOURCE, /maxBuffer: MAX_OUTPUT_BYTES/); assert.match(SOURCE, /timeout: TIMEOUT_MS/); assert.match(SOURCE, /shell: false/);
  assert.equal(SOURCE.includes("result.stdout"), true); assert.equal(SOURCE.includes("writeFileSync(result.stdout"), false); assert.equal(SOURCE.includes("result.stderr"), false);
});

test("success requires equality published rehash removals and absence", () => {
  assert.equal(executor.SUCCESS_COUNTERS.removeSuccess, 2); assert.equal(executor.SUCCESS_COUNTERS.cleanupAbsenceVerified, 2); assert.equal(executor.SUCCESS_COUNTERS.verifiedBuilds, 2);
  assert.equal(executor.OUTPUT_BYTES, 508582); assert.equal(executor.OUTPUT_SHA256, "07420813d7668445152a5d5d2017e0fb84cb27342257e1add3cc7462eec7f811");
  assert.match(SOURCE, /partialOutputsQuarantined: true/); assert.match(SOURCE, /parserPromotion: false, detectorRun: false/);
});

test("fixed authority roots and sole blocked flag are structural", () => {
  for (const literal of [`${executor.NAMESPACE}-review-decision`, `${executor.NAMESPACE}-final-authority`, 'const RUNS_ROOT = path.join(PACKAGE_ROOT, "runs")', 'const AUTHORIZATION_PATH = path.join(PACKAGE_ROOT, "authorization", "current-turn-authorization.json")']) assert.equal(SOURCE.includes(literal), true, literal);
  assert.equal(SOURCE.includes('if (argv.length !== 1 || argv[0] !== EXECUTE_FLAG)'), true); assert.equal(SOURCE.includes('throw new Error("REVIEW_DECISION_REQUIRED")'), true);
});

test("pure APIs make zero process calls and writes", () => {
  const originalSpawn = childProcess.spawnSync; const originals = [fs.writeFileSync, fs.writeSync, fs.mkdirSync, fs.renameSync]; let calls = 0; let writes = 0;
  childProcess.spawnSync = () => { calls += 1; throw new Error("FORBIDDEN"); };
  fs.writeFileSync = () => { writes += 1; throw new Error("FORBIDDEN"); }; fs.writeSync = () => { writes += 1; throw new Error("FORBIDDEN"); }; fs.mkdirSync = () => { writes += 1; throw new Error("FORBIDDEN"); }; fs.renameSync = () => { writes += 1; throw new Error("FORBIDDEN"); };
  try { executor.buildPlan(); executor.simulatePlan(); executor.validateAuthorizationValue(authorization()); executor.validateImageInspectPure(inspect()); assert.equal(calls, 0); assert.equal(writes, 0); }
  finally { childProcess.spawnSync = originalSpawn; [fs.writeFileSync, fs.writeSync, fs.mkdirSync, fs.renameSync] = originals; }
});

test("production claims remain closed before review", () => {
  assert.equal(SOURCE.includes("SEALED_EXECUTOR_REVIEW_REQUIRED_NOT_EXECUTED"), true);
  assert.equal(SOURCE.includes("executionAuthorized: false"), true);
  for (const forbidden of ["PARSER_PROMOTION_ALLOWED", "DETECTOR_RUN_ALLOWED", "verifiedReproducible: true"]) assert.equal(SOURCE.includes(forbidden), false);
});
