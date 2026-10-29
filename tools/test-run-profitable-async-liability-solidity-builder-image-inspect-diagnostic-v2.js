"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const gate = require("./run-profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2.js");

const predecessorRecords = Object.freeze([
  ["run-profitable-async-liability-solidity-builder-gate0.js", 34027, "9ee3e246cb369a1ae3c7936d4c022f9380e0cb1c1c20db00c282d5eda44e45e4"],
  ["test-run-profitable-async-liability-solidity-builder-gate0.js", 7204, "d9bba38b757801330fd762be5e64b861b46c9169fa44fa71ad65c84c8be7492b"],
]);

function prohibitProcesses(fn) {
  const original = childProcess.spawnSync;
  let calls = 0;
  childProcess.spawnSync = () => { calls += 1; throw new Error("PROCESS_CALL_FORBIDDEN"); };
  try { return { value: fn(), calls }; }
  finally { childProcess.spawnSync = original; }
}

test("default validates complete authority chain and fixtures with zero process calls", () => {
  const run = prohibitProcesses(() => gate.main([]));
  assert.equal(run.calls, 0);
  assert.equal(run.value.status, "PASS");
  assert.equal(run.value.executionAuthorized, false);
  assert.equal(run.value.processCalls, 0);
  assert.equal(run.value.fieldsComparedPerCase, 9);
  for (const key of ["rawInspectRecordsWritten", "pullRequests", "containerCreateRequests", "startRequests", "buildRequests"]) {
    assert.equal(run.value[key], 0);
  }
});

test("future flag fails for missing authority before process calls", () => {
  const original = childProcess.spawnSync;
  let calls = 0;
  childProcess.spawnSync = () => { calls += 1; throw new Error("PROCESS_CALL_FORBIDDEN"); };
  try {
    assert.throws(() => gate.main([gate.EXECUTE_FLAG]), /FRESH_EXECUTION_AUTHORITY_MISSING/);
    assert.equal(calls, 0);
  } finally { childProcess.spawnSync = original; }
});

test("old and malformed execution flags are rejected before process calls", () => {
  const original = childProcess.spawnSync;
  let calls = 0;
  childProcess.spawnSync = () => { calls += 1; throw new Error("PROCESS_CALL_FORBIDDEN"); };
  try {
    assert.throws(() => gate.main(["--execute-reviewed-gate0"]), /ARGUMENTS_REJECTED/);
    assert.throws(() => gate.main([gate.EXECUTE_FLAG, "extra"]), /ARGUMENTS_REJECTED/);
    assert.equal(calls, 0);
  } finally { childProcess.spawnSync = original; }
});

test("all fixture comparisons are deterministic, full-field, and field-specific", () => {
  const fixtures = gate.loadFixtures();
  for (const fixtureCase of fixtures.cases.comparisonCases) {
    const image = gate.applyMutation(fixtures.match[0], fixtureCase.mutation);
    const first = gate.compareImageInspect(image);
    const second = gate.compareImageInspect(image);
    assert.deepEqual(first, second, fixtureCase.name);
    assert.deepEqual(first.fields.map((field) => field.fieldId), gate.FIELD_IDS, fixtureCase.name);
    assert.deepEqual(first.summary.mismatchFieldIds, fixtureCase.mismatch, fixtureCase.name);
    for (const [fieldId, code] of Object.entries(fixtureCase.changed)) assert.equal(first.fields.find((field) => field.fieldId === fieldId).detailCode, code, fixtureCase.name);
    assert.equal(first.counters.fieldsCompared, 9, fixtureCase.name);
    assert.equal(first.counters.fieldsMatched + first.counters.fieldsMismatched, 9, fixtureCase.name);
  }
});

test("normalizations accept repo prefixes, x86_64, env order, and null user", () => {
  const base = gate.loadFixtures().match[0];
  for (const mutation of ["repo-index-prefix", "architecture-x86_64", "env-order", "user-null"]) {
    assert.deepEqual(gate.compareImageInspect(gate.applyMutation(base, mutation)).summary.mismatchFieldIds, []);
  }
  assert.equal(gate.canonicalRepoDigest(gate.IMAGE), gate.canonicalRepoDigest(`index.docker.io/emscripten/emsdk@${gate.MANIFEST_DIGEST}`));
  assert.equal(gate.canonicalRepoDigest(`library/emscripten/emsdk@${gate.MANIFEST_DIGEST}`), null);
  assert.equal(gate.parseRepoDigest(`docker.io/emscripten/emsdk@${gate.MANIFEST_DIGEST}`).repository, "emscripten/emsdk");
});

test("RepoDigest rejects library ambiguity, malformed, mixed, nonarray, and missing forms", () => {
  const base = gate.loadFixtures().match[0];
  const cases = new Map([["repo-library", "MALFORMED_ENTRY"], ["repo-malformed", "MALFORMED_ENTRY"], ["repo-mixed", "MALFORMED_ENTRY"], ["repo-nonarray", "TYPE_MISMATCH"], ["repo-missing", "MISSING"]]);
  for (const [mutation, code] of cases) assert.equal(gate.compareImageInspect(gate.applyMutation(base, mutation)).fields[1].detailCode, code);
});

test("nested parent state is preserved for missing and invalid RootFS and Config", () => {
  const base = gate.loadFixtures().match[0];
  assert.equal(gate.compareImageInspect(gate.applyMutation(base, "rootfs-parent-missing")).fields[4].detailCode, "PARENT_MISSING");
  for (const mutation of ["rootfs-parent-null", "rootfs-parent-array", "rootfs-parent-scalar"]) assert.equal(gate.compareImageInspect(gate.applyMutation(base, mutation)).fields[4].detailCode, "PARENT_TYPE_MISMATCH");
  const missing = gate.compareImageInspect(gate.applyMutation(base, "config-parent-missing"));
  assert.deepEqual(missing.fields.slice(5).map((field) => field.detailCode), ["PARENT_MISSING", "PARENT_MISSING", "PARENT_MISSING", "PARENT_MISSING"]);
  for (const mutation of ["config-parent-null", "config-parent-array", "config-parent-scalar"]) assert.deepEqual(gate.compareImageInspect(gate.applyMutation(base, mutation)).fields.slice(5).map((field) => field.detailCode), ["PARENT_TYPE_MISMATCH", "PARENT_TYPE_MISMATCH", "PARENT_TYPE_MISMATCH", "PARENT_TYPE_MISMATCH"]);
});

test("environment diagnostics distinguish missing, extra, duplicate, malformed, and changed", () => {
  const base = gate.loadFixtures().match[0];
  const expected = new Map([
    ["env-missing", "MISSING_KEY"],
    ["env-extra", "UNEXPECTED_KEY"],
    ["env-duplicate", "DUPLICATE_KEY"],
    ["env-malformed", "MALFORMED_ENTRY"],
    ["env-changed", "VALUE_MISMATCH"],
  ]);
  for (const [mutation, code] of expected) {
    const field = gate.compareImageInspect(gate.applyMutation(base, mutation)).fields[8];
    assert.equal(field.fieldId, "CONFIG_ENV");
    assert.equal(field.detailCode, code);
    assert.deepEqual(field.metadata.expectedKeyChecks.map((check) => check.key), ["PATH", "EMSDK"]);
  }
});

test("sensitive values, names, fingerprints, and lengths are absent", () => {
  const base = gate.loadFixtures().match[0];
  const sentinel = "SENTINEL_PRIVATE_VALUE";
  const image = gate.applyMutation(base, "env-extra");
  image.Config.Entrypoint = [`/${sentinel}`];
  image.Config.Cmd = [sentinel];
  image.Config.User = sentinel;
  const result = gate.compareImageInspect(image);
  const text = JSON.stringify(result);
  assert.equal(text.includes(sentinel), false);
  assert.equal(text.includes("UNEXPECTED_SECRET_NAME"), false);
  assert.equal(text.includes(gate.IMAGE_ENV[0]), false);
  for (const field of result.fields.filter((entry) => entry.sensitivity === "SENSITIVE_CONFIG")) {
    for (const side of [field.expected, field.actual]) {
      assert.equal(side.fingerprintSha256, null);
      assert.equal(side.canonicalBytes, null);
      assert.equal(side.itemCount, null);
    }
  }
});

test("parser rejects invalid JSON, non-singleton shape, non-object row, and oversized input", () => {
  assert.throws(() => gate.parseInspectText("not-json"), /INSPECT_JSON_INVALID/);
  assert.throws(() => gate.parseInspectText("{}"), /INSPECT_SINGLETON_ARRAY_REQUIRED/);
  assert.throws(() => gate.parseInspectText("[]"), /INSPECT_SINGLETON_ARRAY_REQUIRED/);
  assert.throws(() => gate.parseInspectText("[{},{}]"), /INSPECT_SINGLETON_ARRAY_REQUIRED/);
  assert.throws(() => gate.parseInspectText("[null]"), /IMAGE_INSPECT_ROW_OBJECT_REQUIRED/);
  assert.throws(() => gate.parseInspectText(`[${JSON.stringify("x".repeat(gate.MAX_INSPECT_BYTES))}]`), /INSPECT_INPUT_TOO_LARGE/);
});

test("serialized diagnostics are allowlisted, bounded, and contain zero tripwire activity", () => {
  const result = gate.compareImageInspect(gate.applyMutation(gate.loadFixtures().match[0], "aggregate"));
  assert.equal(gate.validateDiagnosticSchema(result), true);
  assert.equal(Buffer.byteLength(JSON.stringify(result)) <= gate.MAX_DIAGNOSTIC_BYTES, true);
  assert.deepEqual(Object.keys(result), ["schema", "status", "namespace", "runId", "predecessor", "input", "counters", "summary", "fields", "equalityClaimed", "promotionAllowed"]);
  for (const key of ["dockerInvocations", "rawInspectRecordsWritten", "pullRequests", "containerCreateRequests", "startRequests", "buildRequests"]) {
    assert.equal(result.counters[key], 0);
  }
  const text = JSON.stringify(result).toLowerCase();
  for (const forbidden of ["stdout", "stderr", "dockerconfig", "c:\\", "hostpath", "sourcedir", "outputdir"]) assert.equal(text.includes(forbidden), false);
});

test("comparison metadata rejects source, runId, byte, and sentinel injection", () => {
  const base = gate.loadFixtures().match[0];
  for (const input of [
    { source: "SENTINEL_PRIVATE_VALUE" }, { runId: "SENTINEL_PRIVATE_VALUE" }, { runId: "../private" },
    { bytesAccepted: "1" }, { bytesAccepted: -1 }, { bytesAccepted: gate.MAX_INSPECT_BYTES + 1 }, { extra: "SENTINEL_PRIVATE_VALUE" },
    { source: "DOCKER_IMAGE_INSPECT_MEMORY_ONLY", runId: "offline-fixture" },
  ]) assert.throws(() => gate.compareImageInspect(base, input));
  assert.doesNotThrow(() => gate.compareImageInspect(base, { source: "DOCKER_IMAGE_INSPECT_MEMORY_ONLY", runId: "a".repeat(16), bytesAccepted: 1 }));
  const text = JSON.stringify(gate.loadFixtures().match);
  assert.throws(() => gate.parseInspectText(text, { bytesAccepted: Buffer.byteLength(text) + 1 }), /INPUT_BYTES_INCONSISTENT/);
});

test("schema validator rejects metadata and schema mutation injection", () => {
  const base = gate.compareImageInspect(gate.loadFixtures().match[0]);
  const mutations = [
    (x) => { x.schema = "SENTINEL_PRIVATE_VALUE"; },
    (x) => { x.namespace = "SENTINEL_PRIVATE_VALUE"; },
    (x) => { x.status = "PASS"; },
    (x) => { x.runId = "SENTINEL_PRIVATE_VALUE"; },
    (x) => { x.input.source = "SENTINEL_PRIVATE_VALUE"; },
    (x) => { x.input.bytesAccepted = -1; },
    (x) => { x.counters.pullRequests = 1; },
    (x) => { x.summary.fieldsMatched = 8; },
    (x) => { x.summary.mismatchFieldIds = ["CONFIG_ENV"]; },
    (x) => { x.fields[0].fieldId = "CONFIG_ENV"; },
    (x) => { x.fields[0].detailCode = "SENTINEL_PRIVATE_VALUE"; },
    (x) => { x.fields[0].matched = false; },
    (x) => { x.fields[0].actual.fingerprintPolicy = "OMITTED_SENSITIVE"; },
    (x) => { x.fields[1].metadata.candidateCount = -1; },
    (x) => { x.fields[8].metadata.expectedKeyChecks[0].key = "SENTINEL_PRIVATE_VALUE"; },
    (x) => { x.fields[8].metadata.expectedKeyChecks[0].valueMatched = false; },
    (x) => { x.fields[0].actual.present = false; x.fields[0].actual.jsonType = "missing"; x.fields[0].actual.itemCount = null; x.fields[0].actual.canonicalBytes = null; x.fields[0].actual.fingerprintSha256 = null; },
    (x) => { x.fields[0].detailCode = "PARENT_MISSING"; x.fields[0].matched = false; x.fields[0].actual.present = false; x.fields[0].actual.jsonType = "missing"; x.fields[0].actual.itemCount = null; x.fields[0].actual.canonicalBytes = null; x.fields[0].actual.fingerprintSha256 = null; x.summary.fieldsMatched = 8; x.summary.fieldsMismatched = 1; x.summary.mismatchFieldIds = ["IMAGE_ID"]; x.counters.fieldsMatched = 8; x.counters.fieldsMismatched = 1; x.status = "IMAGE_INSPECT_DIAGNOSIS_MISMATCH"; },
    (x) => { x.fields[0].metadata.candidateCount = 1; },
    (x) => { x.fields[0].metadata.firstMismatchIndex = 0; },
    (x) => { x.fields[4].metadata.firstMismatchIndex = 0; },
    (x) => { x.fields[1].metadata.matchingCandidateCount = 0; },
    (x) => { x.fields[1].metadata.malformedEntryCount = 1; },
    (x) => { x.fields[4].actual.itemCount = 4; },
    (x) => { x.fields[5].detailCode = "ORDER_MISMATCH"; x.fields[5].matched = false; x.summary.fieldsMatched = 8; x.summary.fieldsMismatched = 1; x.summary.mismatchFieldIds = ["CONFIG_USER"]; x.counters.fieldsMatched = 8; x.counters.fieldsMismatched = 1; x.status = "IMAGE_INSPECT_DIAGNOSIS_MISMATCH"; },
    (x) => { x.fields[6].detailCode = "TYPE_MISMATCH"; x.fields[6].matched = false; x.summary.fieldsMatched = 8; x.summary.fieldsMismatched = 1; x.summary.mismatchFieldIds = ["CONFIG_ENTRYPOINT"]; x.counters.fieldsMatched = 8; x.counters.fieldsMismatched = 1; x.status = "IMAGE_INSPECT_DIAGNOSIS_MISMATCH"; },
    (x) => { x.fields[7].detailCode = "VALUE_MISMATCH"; x.fields[7].matched = false; x.summary.fieldsMatched = 8; x.summary.fieldsMismatched = 1; x.summary.mismatchFieldIds = ["CONFIG_CMD"]; x.counters.fieldsMatched = 8; x.counters.fieldsMismatched = 1; x.status = "IMAGE_INSPECT_DIAGNOSIS_MISMATCH"; },
    (x) => { x.fields[8].metadata.unexpectedEntryCount = 1; },
    (x) => { x.equalityClaimed = true; },
    (x) => { x.promotionAllowed = true; },
    (x) => { x.injected = "SENTINEL_PRIVATE_VALUE"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = JSON.parse(JSON.stringify(base)); mutate(value);
    assert.throws(() => gate.validateDiagnosticSchema(value), `mutation-${index}`);
  }
});

test("field semantic validator rejects causal contradictions from mismatch diagnostics", () => {
  const baseImage = gate.loadFixtures().match[0];
  const mutations = [
    ["repo-malformed", (x) => { x.fields[1].metadata.malformedEntryCount = 0; }],
    ["repo-digest", (x) => { x.fields[1].metadata.matchingCandidateCount = 1; }],
    ["diff-count", (x) => { x.fields[4].actual.itemCount = x.fields[4].expected.itemCount; }],
    ["diff-ids", (x) => { x.fields[4].metadata.firstMismatchIndex = null; }],
    ["env-malformed", (x) => { x.fields[8].metadata.malformedEntryCount = 0; }],
    ["env-duplicate", (x) => { x.fields[8].metadata.duplicateKeyCount = 0; }],
    ["env-missing", (x) => { x.fields[8].metadata.expectedKeyChecks[1].present = true; x.fields[8].metadata.expectedKeyChecks[1].valueMatched = true; }],
    ["env-extra", (x) => { x.fields[8].metadata.unexpectedEntryCount = 0; }],
    ["env-changed", (x) => { x.fields[8].metadata.expectedKeyChecks[0].valueMatched = true; }],
    ["config-parent-missing", (x) => { x.fields[8].metadata.expectedKeyChecks[0].present = true; }],
  ];
  for (const [mutation, contradict] of mutations) {
    const value = gate.compareImageInspect(gate.applyMutation(baseImage, mutation)); contradict(value);
    assert.throws(() => gate.validateDiagnosticSchema(value), mutation);
  }
});

test("terminal predecessor tool records remain exact", () => {
  for (const [name, bytes, sha256] of predecessorRecords) {
    assert.deepEqual(gate.fileRecord(path.join(__dirname, name)), { bytes, sha256 });
  }
  const chain = gate.validateAuthorityChain();
  assert.equal(chain.authority.executionAuthorized, false);
  assert.equal(chain.diagnostic.terminalPredecessor.facts.exactFailedImageField, null);
  assert.equal(chain.diagnostic.terminalPredecessor.facts.authorizationConsumed, true);
});

test("raw fixture text is accepted only in memory and result records no raw output", () => {
  const fixturePath = path.join(__dirname, "vendor", gate.NAMESPACE, "fixtures", "image-inspect-match.json");
  const text = fs.readFileSync(fixturePath, "utf8");
  const result = gate.parseInspectText(text);
  assert.equal(result.status, "IMAGE_INSPECT_DIAGNOSIS_MATCH");
  assert.equal(result.input.bytesAccepted, Buffer.byteLength(text));
  assert.equal(result.input.rawRetained, false);
  assert.equal(result.counters.rawInspectRecordsWritten, 0);
});
