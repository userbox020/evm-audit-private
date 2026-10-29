#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const r = require("./build-aave-ethereum-emode-47-48-r11.js"), prepared = r.prepare();

test("fixed deployment packages preserve source counts, settings and historical runtime hashes", () => {
  assert.equal(prepared.historicalPin.number, 25930340);
  for (const [key, pkg] of Object.entries(prepared.packages)) {
    assert.equal(Object.keys(pkg.input.sources).length, r.SPECS[key].sourceCount);
    assert.equal((pkg.observedRuntime.length - 2) / 2, r.SPECS[key].bytes);
    const before = structuredClone(pkg.input), after = structuredClone(pkg.compilerInput);
    delete before.settings.outputSelection; delete after.settings.outputSelection;
    assert.deepEqual(after, before); assert.equal(r.validateInput(pkg.compilerInput, r.SPECS[key]), true);
  }
});
test("only literal closed-package sources and exact recorded settings are admitted", () => {
  const spec = r.SPECS.router;
  for (const mutate of [x => { x.settings.optimizer.runs = 200; }, x => { x.settings.viaIR = true; }, x => { x.settings.evmVersion = "cancun"; },
    x => { x.sources[spec.target] = { urls: ["https://invalid.example/source"] }; },
    x => { x.sources[spec.target].content += '\nimport "./Missing.sol";'; },
    x => { x.sources["src/../Escape.sol"] = x.sources[spec.target]; delete x.sources[spec.target]; }]) {
    const input = structuredClone(prepared.packages.router.input); mutate(input);
    assert.throws(() => r.validateInput(input, spec));
  }
});
test("data-only extraction rejects ambiguous assignments, page expressions and wrong runtime scope", () => {
  const spec = r.SPECS.router, html = r.read(spec.page, spec.pageSha256).toString("utf8");
  assert.throws(() => r.extract(`${html}\nvar editor_contractJsonData = '{}';`, spec), /SOURCE_ASSIGNMENT_AMBIGUOUS/);
  assert.throws(() => r.extract(html.replace(/var editor_activeFile/, "+ untrustedExpression(); var editor_activeFile"), spec), /SOURCE_EXPRESSION_FORBIDDEN/);
  assert.throws(() => r.extract(html, { ...spec, keccak256: `0x${"0".repeat(64)}` }), /PUBLISHED_RUNTIME_MISMATCH/);
});
test("source publication is append-only and verifies against pinned page content", () => {
  const root = fs.mkdtempSync("C:/Users/MiPC/AppData/Local/Temp/opencode/emode-r11-");
  fs.mkdirSync(path.join(root, "reports/raw/fast"), { recursive: true });
  try {
    const result = r.publishSources(prepared, root); assert.equal(result.files, 26);
    assert.equal(r.verifySources(root).manifest.status, "SOURCE_EXTRACTED_BUILD_PENDING");
    assert.throws(() => r.publishSources(prepared, root), /OUTPUT_EXISTS/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("source path validation rejects traversal, alternate roots and absolute paths", () => {
  for (const name of ["../x.sol", "src/../x.sol", "src//x.sol", "C:/x.sol", "src/./x.sol", "node_modules/x\\y.sol", "other/x.sol"])
    assert.equal(r.sourcePath(name), false);
  assert.equal(r.sourcePath("node_modules/@openzeppelin/contracts/access/Ownable.sol"), true);
});
test("unbound immutable or library substitutions cannot be hidden by runtime comparison", () => {
  const spec = r.SPECS.router;
  for (const evm of [{ object: "00", immutableReferences: { 1: [{ start: 0, length: 32 }] } }, { object: "00", linkReferences: { library: {} } }]) {
    const output = { contracts: { [spec.target]: { [spec.name]: { evm: { deployedBytecode: evm } } } } };
    assert.throws(() => r.validateCompiled(output, spec, prepared.packages.router), /UNEXPECTED_RUNTIME_SUBSTITUTIONS/);
  }
});
test("saved compilation package verifies without rerunning compiler", { skip: !fs.existsSync(path.join(r.ROOT, r.OUT, "report.json")) }, () => {
  const verified = r.verify(); assert.equal(verified.status, "BOTH_EXACT_HISTORICAL_RUNTIME_MATCH");
  assert.equal(verified.compilerRerun, false); assert.equal(verified.network, false);
  assert.throws(() => r.build(), /BUILD_OUTPUT_EXISTS/);
});
