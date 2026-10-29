#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const r9 = require("./build-aave-ethereum-emode-47-48-r9.js");
let tests = 0;
function test(name, run) { run(); tests += 1; console.log(`ok ${tests} - ${name}`); }
const prepared = r9.prepare();

test("fixed page reconstructs the exact 25-source package", () => {
  assert.equal(Object.keys(prepared.input.sources).length, 25);
  assert.ok(prepared.input.sources[r9.TARGET]);
  assert.equal(prepared.input.settings.evmVersion, "cancun");
});
test("observed runtime identity is fixed", () => {
  assert.equal((prepared.observedRuntime.length - 2) / 2, r9.RUNTIME_BYTES);
  assert.equal(require("ethers").keccak256(prepared.observedRuntime), r9.RUNTIME_HASH);
});
test("page parser requires one literal assignment", () => {
  const page = fs.readFileSync(r9.PAGE, "utf8");
  assert.throws(() => r9.extract(page.replace("var editor_contractJsonData", "var editor_contractJsonData2")), /SOURCE_ASSIGNMENT_AMBIGUOUS/);
  assert.throws(() => r9.extract(`${page}\nvar editor_contractJsonData = '{}';`), /SOURCE_ASSIGNMENT_AMBIGUOUS/);
});
test("page parser rejects expression-bearing assignment", () => {
  const page = fs.readFileSync(r9.PAGE, "utf8"), marker = "var editor_activeFile";
  assert.throws(() => r9.extract(page.replace(marker, "+ unsafe\nvar editor_activeFile")), /SOURCE_EXPRESSION_FORBIDDEN/);
});
test("package rejects missing literal imports", () => {
  const changed = structuredClone(prepared.input), key = Object.keys(changed.sources).find((file) => file !== r9.TARGET);
  delete changed.sources[key]; assert.throws(() => r9.validateInput(changed), /PACKAGE_SCHEMA_INVALID|LITERAL_SOURCE_MISSING/);
});
test("only output selection changes for local compilation", () => {
  const original = JSON.parse(prepared.originalText), { outputSelection: _a, ...before } = original.settings;
  const { outputSelection: _b, ...after } = prepared.compilerInput.settings;
  assert.equal(r9.stable(before), r9.stable(after)); assert.equal(r9.stable(original.sources), r9.stable(prepared.compilerInput.sources));
});
const bundle = r9.build(prepared);
test("native build instantiates all eight named immutables", () => {
  assert.deepEqual(bundle.runtime.instantiated.bindings.map((row) => row.name), Object.keys(r9.VALUES).sort());
  assert.equal(bundle.runtime.instantiated.constructorArguments.length, 8);
});
test("instantiated runtime exactly matches published runtime", () => {
  assert.equal(bundle.report.status, "CONFIG_ENGINE_EXACT_RUNTIME_MATCH");
  assert.equal(bundle.runtime.instantiated.runtime, bundle.runtime.observed);
  assert.equal(bundle.report.compiledIdentity.keccak256, r9.RUNTIME_HASH);
  assert.equal(bundle.report.runtimeMatch.metadataNormalization, "none");
});
test("full bundle validation passes without promoting complete authority", () => {
  assert.equal(r9.validateBundle(bundle), true);
  assert.equal(bundle.report.gates.completeRuntimeBinding, false);
  assert.equal(bundle.report.gates.completeAuthorityVerification, false);
});
test("bundle validation rejects runtime and gate tampering", () => {
  const runtime = structuredClone(bundle); runtime.runtime.observed = `${runtime.runtime.observed.slice(0, -2)}00`;
  assert.throws(() => r9.validateBundle(runtime), /REPORT_INVALID|RUNTIME/);
  const gate = structuredClone(bundle); gate.report.gates.completeAuthorityVerification = true;
  assert.throws(() => r9.validateBundle(gate), /REPORT_INVALID/);
});
test("production output remains absent during offline tests", () => assert.equal(fs.existsSync(`${r9.ROOT}/${r9.OUT}`), false));
console.log(`${tests} tests passed`);
