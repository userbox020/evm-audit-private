#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { keccak256 } = require("ethers");
const r = require("./build-aave-ethereum-emode-47-48-r7.js");
let count = 0;
const test = (name, run) => { run(); console.log(`ok ${++count} - ${name}`); };
const prepared = r.prepare();
let bundle;
test("JS literal decoding preserves JSON escapes and source characters", () => {
  assert.equal(r.decodeLiteral(String.raw`'\"line\\n\u0027quoted\u0027\x2f\"'`, 0).value, String.raw`"line\n'quoted'/"`);
  assert.equal(r.decodeLiteral('"a\\tb"', 0).value, "a\tb");
  assert.equal(r.decodeLiteral("'\\`source\\`'", 0).value, "`source`");
});
test("literal decoder rejects unsupported escapes and incomplete data", () => {
  for (const text of ["`template`", String.raw`'\u12xx'`, String.raw`'\x0z'`, String.raw`'\1'`, "'unterminated", "'raw\nnewline'"]) {
    assert.throws(() => r.decodeLiteral(text, 0), /LITERAL_/);
  }
});
test("decoding never executes appended JavaScript", () => {
  delete globalThis.r7Executed;
  const result = r.decodeLiteral("'data';globalThis.r7Executed=true;", 0);
  assert.equal(result.value, "data"); assert.equal(globalThis.r7Executed, undefined);
});
test("the recovered package is bound to the fixed historical runtime", () => {
  assert.equal(keccak256(prepared.observedRuntime), r.RUNTIME_HASH);
  assert.equal((prepared.observedRuntime.length - 2) / 2, 3866);
  assert.equal(Object.keys(prepared.input.sources).length, 36);
  assert.equal(Object.hasOwn(prepared.input.sources, "settings.json"), false);
  assert.equal(r.validateInput(prepared.input), true);
});
test("published compiler settings are reconstructed from the editor entry", () => {
  const editor = JSON.parse(prepared.editorText);
  assert.deepEqual(prepared.input.settings, JSON.parse(editor.sources["settings.json"].content));
  assert.deepEqual(r.assembleInput(editor), prepared.input);
  delete editor.sources["settings.json"];
  assert.throws(() => r.assembleInput(editor), /EDITOR_BUNDLE_INVALID/);
});
test("ambiguous source assignment is rejected", () => {
  const html = fs.readFileSync(r.PAGE, "utf8");
  assert.throws(() => r.extract(`${html}\nvar editor_contractJsonData = '{}';`), /SOURCE_ASSIGNMENT_AMBIGUOUS/);
});
test("source expressions are rejected rather than evaluated", () => {
  const html = fs.readFileSync(r.PAGE, "utf8"), match = /\bvar\s+editor_contractJsonData\s*=\s*/.exec(html);
  const literal = r.decodeLiteral(html, match.index + match[0].length);
  const modified = `${html.slice(0, literal.end)}.concat('')${html.slice(literal.end)}`;
  assert.throws(() => r.extract(modified), /SOURCE_EXPRESSION_FORBIDDEN/);
});
test("compiler sources must be literal and cannot escape the source root", () => {
  for (const alter of [
    (input) => { input.sources[r.AGENT] = { urls: ["https://example.invalid/source.sol"] }; },
    (input) => { input.sources["../outside.sol"] = { content: "pragma solidity ^0.8.27;" }; },
    (input) => { input.sources[r.AGENT].content += "\nimport '../../../../outside.sol';"; }
  ]) { const input = structuredClone(prepared.input); alter(input); assert.throws(() => r.validateInput(input)); }
});
test("missing imported literals cannot fall through to filesystem loading", () => {
  const input = structuredClone(prepared.input);
  input.sources[r.AGENT].content += "\nimport './Missing.sol';";
  assert.throws(() => r.validateInput(input), /LITERAL_SOURCE_MISSING/);
});
test("the compilation input changes only output selection", () => {
  const a = structuredClone(prepared.input), b = structuredClone(prepared.compilerInput);
  delete a.settings.outputSelection; delete b.settings.outputSelection;
  assert.deepEqual(a, b);
});
test("native compiler reproduces the deployed runtime without metadata normalization", () => {
  bundle = r.build(prepared);
  assert.equal(bundle.report.status, "AGENT_EXACT_RUNTIME_MATCH");
  assert.equal(bundle.report.runtimeMatch.fullBytes, true);
  assert.equal(bundle.runtime.instantiated.runtime, bundle.runtime.observed);
  assert.equal(bundle.report.compiledIdentity.keccak256, r.RUNTIME_HASH);
  assert.equal(bundle.report.runtimeMatch.metadataNormalization, "none");
  assert.equal(r.validateBundle(bundle), true);
});
test("every source hash agrees with the emitted compiler metadata", () => {
  const metadata = JSON.parse(bundle.output.contracts[r.AGENT].AaveEModeAgent.metadata);
  for (const [file, source] of Object.entries(metadata.sources)) assert.equal(source.keccak256, bundle.sources[file].keccak256);
});
test("R6 comparison records only actual source and setting differences", () => {
  assert.deepEqual(r.compareInputs(prepared.input, prepared.input), { sourceChanges: [], changedSettingKeys: [], unchangedSourceCount: Object.keys(prepared.input.sources).length });
  assert.deepEqual(bundle.report.r6Comparison, r.compareInputs(prepared.priorInput, prepared.input));
});
test("full agent equality does not promote broader assurance", () => {
  assert.equal(bundle.report.gates.agentExactRuntimeMatch, true);
  assert.equal(bundle.report.gates.completeRuntimeBinding, false);
  assert.equal(bundle.report.gates.completeAuthorityVerification, false);
  assert.equal(bundle.report.gates.effectiveRangeSemanticsBound, false);
});
test("altered runtime, compiler settings and complete gates are rejected", () => {
  for (const alter of [
    (value) => { value.runtime.instantiated.runtime = '0x00'; },
    (value) => { value.input.settings.optimizer.runs = 201; },
    (value) => { value.report.gates.completeRuntimeBinding = true; },
    (value) => { value.report.runtimeMatch.metadataNormalization = 'stripped'; }
  ]) { const value = structuredClone(bundle); alter(value); assert.throws(() => r.validateBundle(value)); }
});
test("saved source claims must agree with compiler metadata and R6 comparison", () => {
  for (const alter of [
    (value) => { value.sources[r.AGENT].sha256 = "00".repeat(32); },
    (value) => { value.report.settings.optimizer.runs = 201; },
    (value) => { value.report.r6Comparison.sourceChanges = []; },
    (value) => { value.report.runtimeMatch.constructorArguments[0] = "0x0000000000000000000000000000000000000000"; },
    (value) => {
      const artifact = value.output.contracts[r.AGENT].AaveEModeAgent, metadata = JSON.parse(artifact.metadata);
      metadata.sources[r.AGENT].keccak256 = `0x${"00".repeat(32)}`; artifact.metadata = JSON.stringify(metadata);
    }
  ]) { const value = structuredClone(bundle); alter(value); assert.throws(() => r.validateBundle(value)); }
});
test("prior evidence and R6 mismatch artifacts remain unchanged", () => {
  for (const [file, hash] of Object.entries(prepared.hashes)) assert.equal(r.sha(fs.readFileSync(path.join(r.ROOT, file))), hash);
  assert.equal(bundle.report.execution.rpcRequests, 0); assert.equal(bundle.report.execution.inventoryReads, 0);
  assert.equal(bundle.report.execution.pageJavaScriptExecuted, false);
});
console.log(`${count} tests passed`);
