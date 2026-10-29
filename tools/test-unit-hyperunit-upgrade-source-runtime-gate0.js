#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  extractExplorerStandardInput,
  patchedRuntime,
  parseOfficialRegistry,
  codeInfo,
  gateDecision,
} = require("./capture-unit-hyperunit-upgrade-source-runtime-gate0");

let tests = 0;
function test(name, fn) { fn(); tests += 1; console.log(`ok ${tests} - ${name}`); }

test("extracts escaped explorer standard input", () => {
  const input = { language: "Solidity", sources: { "contracts/X.sol": { content: "contract X { string x = \\\"a'b\\\"; }" } }, settings: { optimizer: { enabled: false, runs: 200 } } };
  const escaped = JSON.stringify(JSON.stringify(input)).slice(1, -1).replace(/'/g, "\\'");
  const html = `<script>var editor_contractJsonData = '${escaped}';\nvar next = 1;</script>`;
  assert.deepStrictEqual(extractExplorerStandardInput(html), input);
});

test("patches compiler-declared immutable bytes only", () => {
  const built = `0x${"11".repeat(4)}${"00".repeat(20)}${"22".repeat(3)}`;
  const chain = `0x${"11".repeat(4)}${"ab".repeat(20)}${"22".repeat(3)}`;
  const result = patchedRuntime(built.slice(2), { "1": [{ start: 4, length: 20 }] }, chain);
  assert.strictEqual(result.equal, true);
  assert.strictEqual(result.immutableValues.length, 1);
});

test("runtime mismatch survives immutable substitution", () => {
  const built = `0x${"11".repeat(4)}${"00".repeat(20)}${"22".repeat(3)}`;
  const chain = `0x${"11".repeat(4)}${"ab".repeat(20)}${"23".repeat(3)}`;
  assert.strictEqual(patchedRuntime(built.slice(2), { "1": [{ start: 4, length: 20 }] }, chain).equal, false);
});

test("official registry requires all five and does not infer UXPL", () => {
  const text = [
    "0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463", "0xBe6727B535545C67d5cAa73dEa54865B92CF7907",
    "0x068f321Fa8Fb9f0D135f290Ef6a3e2813e1c8A29", "0x27eC642013bcB3D80CA3706599D3cdA04F6f4452",
    "0x3B4575E689DEd21CAAD31d64C4df1f10F3B2CedF",
  ].join("\n");
  const row = parseOfficialRegistry(text);
  assert.strictEqual(row.completeExpectedFive, true);
  assert.strictEqual(row.uxplAuthoritativeEntryPresent, false);
});

test("code metadata extraction is bounded", () => {
  const info = codeInfo("0x60000000");
  assert.strictEqual(info.bytes, 4);
  assert.strictEqual(info.metadataBytes, 0);
});

test("admission intersects exact source public path and material exposure", () => {
  const decision = gateDecision(
    [{ symbol: "UETH" }],
    [{ symbol: "UETH", exactRuntime: true }],
    [{ symbol: "UETH", exposure: { materialAt100WholeTokens: true }, liquidExit: { bothSidesNonzero: true, pairCode: { present: true } }, lending: { poolCode: { present: true }, aTokenCode: { present: true } } }],
    { UETH: { publicTransferPath: "PUBLIC-ERC20-TRANSFER-IN-INHERITANCE" } },
  );
  assert.strictEqual(decision.admission, "PASS");
  assert.strictEqual(decision.auditHypothesisOpened, false);
});

console.log(`PASS ${tests} tests`);
