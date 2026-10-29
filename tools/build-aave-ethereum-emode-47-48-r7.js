#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { keccak256 } = require("ethers");
const ROOT = path.resolve(__dirname, "..");
const OUT = "reports/raw/fast/aave-ethereum-emode-47-48-r7-source";
const R6 = "reports/raw/fast/aave-ethereum-emode-47-48-r6-offline";
const PAGE = "C:/Users/MiPC/.local/share/opencode/tool-output/tool_083394a8c001ZZ3KzhZTU5WkZC";
const PAGE_SHA = "5bbd351033d9f0d3ee705204f8a864a6b0f6161099a0f519ac2fcb66dfdb66f9";
const ADDRESS = "0xbe2840440d4f77cd98cec2de09913e6851907744";
const RUNTIME_HASH = "0xf260c42b3b701432d96f0b6864eb233845410da2053e43a50ba317708137de68";
const SOURCE_URL = `https://etherscan.io/address/${ADDRESS}#code`;
const RUNNER = "tools/build-aave-ethereum-emode-47-48-r7.js";
const TEST = "tools/test-build-aave-ethereum-emode-47-48-r7.js";
const PINS = Object.freeze({
  "tools/build-aave-ethereum-emode-47-48-r6.js": "e67c4575fb1bb88962587fb83a32151715e99d08140fe0468bf23e60f4b0ebab",
  [`${R6}/manifest.json`]: "330280529cd11d1bb481e78469281bec31feaf9fddf05792f46d1784d2c4d13a",
  [`${R6}/report.json`]: "5a89a7e4adc064538f102198c904d978f6000ed590c633f0950cabb11e74927f",
  [`${R6}/agent.input.json`]: "5c7b2be040efafb941ab01ceb91b1f82325fae106850e2937099455d0f4aa983"
});
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
class RecoveryError extends Error { constructor(code, detail = null) { super(code); this.detail = detail; } }
const fail = (code, detail) => { throw new RecoveryError(code, detail); };
function pinned(file, hash) {
  const full = path.isAbsolute(file) ? file : path.join(ROOT, file), before = fs.lstatSync(full);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024 * 1024 || path.resolve(fs.realpathSync(full)) !== path.resolve(full)) fail("INPUT_PATH_INVALID");
  const bytes = fs.readFileSync(full), after = fs.lstatSync(full);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha(bytes) !== hash) fail("INPUT_HASH_MISMATCH", file);
  return bytes;
}
pinned("tools/build-aave-ethereum-emode-47-48-r6.js", PINS["tools/build-aave-ethereum-emode-47-48-r6.js"]);
const r6 = require("./build-aave-ethereum-emode-47-48-r6.js");
const AGENT = r6.AGENT;
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);

// Decode one bounded JS string literal as data; never evaluate the surrounding script.
function decodeLiteral(text, start) {
  const quote = text[start], output = [];
  if (!["'", '"'].includes(quote)) fail("LITERAL_QUOTE_INVALID");
  for (let index = start + 1; index < text.length && index - start <= 4 * 1024 * 1024; index += 1) {
    const char = text[index];
    if (char === quote) return { value: output.join(""), end: index + 1 };
    if (char === "\n" || char === "\r") fail("LITERAL_NEWLINE_INVALID");
    if (char !== "\\") { output.push(char); continue; }
    const escape = text[++index], escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "/": "/", "`": "`" };
    if (Object.hasOwn(escapes, escape)) output.push(escapes[escape]);
    else if (escape === "u" || escape === "x") {
      const count = escape === "u" ? 4 : 2, hex = text.slice(index + 1, index + 1 + count);
      if (hex.length !== count || !/^[0-9a-f]+$/i.test(hex)) fail("LITERAL_ESCAPE_INVALID");
      output.push(String.fromCharCode(parseInt(hex, 16))); index += count;
    } else fail("LITERAL_ESCAPE_INVALID", { offset: index, escapeCodePoint: escape?.charCodeAt(0) ?? null });
  }
  fail("LITERAL_UNTERMINATED");
}
function validateInput(input) {
  if (!input || input.language !== "Solidity" || !input.sources || !input.sources[AGENT]
    || !input.settings || Object.keys(input.sources).length > 128 || Object.keys(input.sources).length < 1
    || input.settings.optimizer?.enabled !== true || input.settings.optimizer.runs !== 200
    || input.settings.evmVersion !== "shanghai" || Object.keys(input.settings.libraries || {}).length) fail("PACKAGE_SCHEMA_INVALID");
  const remappings = input.settings.remappings || [];
  if (!Array.isArray(remappings) || remappings.some((item) => typeof item !== "string" || !/^[A-Za-z0-9_@./:=-]+$/.test(item))) fail("REMAPPINGS_INVALID");
  let total = 0;
  for (const [file, source] of Object.entries(input.sources)) {
    if (!/^(src|lib)\/[A-Za-z0-9_./-]+\.sol$/.test(file) || file.split("/").includes("..") || !source
      || Object.keys(source).join() !== "content" || typeof source.content !== "string") fail("SOURCE_INVALID");
    total += Buffer.byteLength(source.content);
    if (total > 4 * 1024 * 1024) fail("SOURCE_BYTE_LIMIT");
    const scan = source.content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
    for (const statement of scan.matchAll(/\bimport\s+([^;]+);/g)) {
      const names = [...statement[1].matchAll(/['"]([^'"]+)['"]/g)];
      if (names.length !== 1) fail("IMPORT_SYNTAX_UNSUPPORTED", file);
      const resolved = r6.resolveImport(file, names[0][1], remappings);
      if (!Object.hasOwn(input.sources, resolved)) fail("LITERAL_SOURCE_MISSING", resolved);
    }
  }
  return true;
}
function assembleInput(editor) {
  if (!editor || Object.keys(editor).sort().join() !== "language,sources" || editor.language !== "Solidity"
    || !editor.sources || !editor.sources["settings.json"] || Object.keys(editor.sources["settings.json"]).join() !== "content"
    || typeof editor.sources["settings.json"].content !== "string") fail("EDITOR_BUNDLE_INVALID");
  let settings; try { settings = JSON.parse(editor.sources["settings.json"].content); } catch (_) { fail("SETTINGS_JSON_INVALID"); }
  const input = { language: editor.language, sources: Object.fromEntries(Object.entries(editor.sources).filter(([file]) => file !== "settings.json")), settings };
  validateInput(input);
  return input;
}
function extract(html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > 4 * 1024 * 1024 || !html.includes(`https://etherscan.io/address/${ADDRESS}`)
    || !html.includes("v0.8.27+commit.40a35a09")) fail("PAGE_SCOPE_INVALID");
  const matches = [...html.matchAll(/\bvar\s+editor_contractJsonData\s*=\s*(?!=)/g)];
  if (matches.length !== 1) fail("SOURCE_ASSIGNMENT_AMBIGUOUS");
  const match = matches[0], literal = decodeLiteral(html, match.index + match[0].length);
  if (!/^(?:\s*;|[ \t]*\r?\n\s*var\s+editor_activeFile\b)/.test(html.slice(literal.end))) fail("SOURCE_EXPRESSION_FORBIDDEN");
  let editor; try { editor = JSON.parse(literal.value); } catch (_) { fail("SOURCE_JSON_INVALID"); }
  const input = assembleInput(editor);
  const runtimes = [...new Set((html.match(/(?:0x)?[a-fA-F0-9]{1000,}/g) || []).map((value) => `0x${value.replace(/^0x/, "").toLowerCase()}`))]
    .filter((value) => value.length === 2 + 3866 * 2 && keccak256(value) === RUNTIME_HASH);
  if (runtimes.length !== 1) fail("PUBLISHED_RUNTIME_NOT_BOUND");
  const originalText = JSON.stringify(input);
  return { input, originalText, editorText: literal.value, observedRuntime: runtimes[0],
    literalSha256: sha(Buffer.from(originalText)), editorSha256: sha(Buffer.from(literal.value)) };
}
function prepare() {
  for (const [file, hash] of Object.entries(PINS)) pinned(file, hash);
  const priorManifest = JSON.parse(pinned(`${R6}/manifest.json`, PINS[`${R6}/manifest.json`]));
  const hashes = { ...priorManifest.sourceHashes, ...PINS, [RUNNER]: sha(fs.readFileSync(__filename)),
    [TEST]: sha(fs.readFileSync(path.join(ROOT, TEST))) };
  for (const [file, hash] of Object.entries(hashes)) pinned(file, hash);
  const r3 = JSON.parse(fs.readFileSync(path.join(ROOT, "reports/raw/fast/aave-ethereum-emode-47-48-r3.json")));
  if (r3.report.observations.current.code.agent.keccak256 !== RUNTIME_HASH || r3.report.observations.current.code.agent.bytes !== 3866) fail("HISTORICAL_IDENTITY_CHANGED");
  const recovered = extract(pinned(PAGE, PAGE_SHA).toString("utf8"));
  const compilerInput = structuredClone(recovered.input);
  compilerInput.settings.outputSelection = { "*": { "": ["ast"] }, [AGENT]: { AaveEModeAgent: ["abi", "metadata", "evm.bytecode", "evm.deployedBytecode"] } };
  return { ...recovered, compilerInput, hashes, r3, priorInput: JSON.parse(pinned(`${R6}/agent.input.json`, PINS[`${R6}/agent.input.json`])) };
}
function compareInputs(before, after) {
  const files = [...new Set([...Object.keys(before.sources), ...Object.keys(after.sources)])].sort();
  const sourceChanges = files.filter((file) => before.sources[file]?.content !== after.sources[file]?.content).map((file) => ({ file,
    beforeSha256: before.sources[file] ? sha(Buffer.from(before.sources[file].content)) : null,
    afterSha256: after.sources[file] ? sha(Buffer.from(after.sources[file].content)) : null }));
  const settings = [...new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])].filter((key) => key !== "outputSelection")
    .filter((key) => stable(before.settings[key]) !== stable(after.settings[key])).sort();
  return { sourceChanges, changedSettingKeys: settings, unchangedSourceCount: files.length - sourceChanges.length };
}
function build(prepared = prepare()) {
  const output = r6.compile(prepared.compilerInput), instantiated = r6.instantiateAgent(output);
  const artifact = output.contracts[AGENT].AaveEModeAgent, metadata = JSON.parse(artifact.metadata), sources = {};
  if (metadata.compiler.version !== "0.8.27+commit.40a35a09") fail("COMPILER_VERSION_MISMATCH");
  for (const [file, source] of Object.entries(prepared.input.sources)) sources[file] = { sha256: sha(Buffer.from(source.content)), keccak256: keccak256(Buffer.from(source.content)) };
  for (const [file, source] of Object.entries(metadata.sources)) if (sources[file]?.keccak256 !== source.keccak256) fail("COMPILED_SOURCE_MISMATCH", file);
  const identity = r6.fullIdentity(instantiated.runtime), exact = instantiated.runtime === prepared.observedRuntime && identity.keccak256 === RUNTIME_HASH;
  const report = { schema: "aave-ethereum-emode-47-48-r7-source/v1", status: exact ? "AGENT_EXACT_RUNTIME_MATCH" : "AGENT_RUNTIME_MISMATCH",
    generatedAt: new Date().toISOString(), address: ADDRESS, historicalPin: prepared.r3.report.pin,
    provenance: { sourceURL: SOURCE_URL, responseRecord: PAGE, responseRecordSha256: PAGE_SHA, decodedInputSha256: prepared.literalSha256,
      decodedEditorBundleSha256: prepared.editorSha256, inputReconstruction: "editor Solidity sources plus its published settings.json entry",
      sourceCount: Object.keys(sources).length, originalGitCommit: "unknown", compilerOutputSelectionOnlyChanged: true },
    compiler: { version: metadata.compiler.version, binarySha256: r6.SOLC_SHA, releaseAuthenticity: "previously pinned cached binary; no new release attestation" },
    settings: prepared.input.settings, compiledIdentity: identity, recordedRuntimeKeccak256: RUNTIME_HASH,
    runtimeMatch: { fullBytes: exact, metadataNormalization: "none", immutableBindings: instantiated.bindings,
      constructorArguments: instantiated.constructorArguments, creationTransactionVerified: false },
    r6Comparison: compareInputs(prepared.priorInput, prepared.input),
    gates: { agentExactRuntimeMatch: exact, completeRuntimeBinding: false, completeAuthorityVerification: false,
      effectiveRangeSemanticsBound: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false },
    execution: { compilation: "local-only", publicSourceLookups: 1, rpcRequests: 0, inventoryReads: 0, pageJavaScriptExecuted: false,
      revisionSweep: false, compilerSettingsSweep: false },
    limitations: ["The full source/runtime comparison is bound to R3's historical code hash, not fresh chain state.",
      "Constructor values are reconstructed and full-runtime checked, not recovered from a creation transaction.",
      "Hub implementation historical code, complete governing authority and oracle dependencies remain outside this recovery."] };
  for (const [file, hash] of Object.entries(prepared.hashes)) pinned(file, hash);
  pinned(PAGE, PAGE_SHA);
  return { report, sources, originalText: prepared.originalText, editorText: prepared.editorText, input: prepared.compilerInput, output,
    runtime: { observed: prepared.observedRuntime, instantiated }, hashes: prepared.hashes };
}
function validateBundle(bundle) {
  const { report, input, output, runtime } = bundle;
  const original = JSON.parse(bundle.originalText);
  if (stable(assembleInput(JSON.parse(bundle.editorText))) !== stable(original)
    || report.provenance.decodedEditorBundleSha256 !== sha(Buffer.from(bundle.editorText))) fail("EDITOR_RECONSTRUCTION_CHANGED");
  validateInput(original); validateInput(input);
  const { outputSelection: _originalSelection, ...originalSettings } = original.settings;
  const { outputSelection: _newSelection, ...compiledSettings } = input.settings;
  if (stable(original.sources) !== stable(input.sources) || stable(originalSettings) !== stable(compiledSettings)) fail("CODEGEN_INPUT_CHANGED");
  if (stable(r6.instantiateAgent(output)) !== stable(runtime.instantiated) || keccak256(runtime.observed) !== RUNTIME_HASH) fail("RUNTIME_EVIDENCE_INVALID");
  const exact = runtime.observed === runtime.instantiated.runtime;
  if (report.status !== (exact ? "AGENT_EXACT_RUNTIME_MATCH" : "AGENT_RUNTIME_MISMATCH") || report.runtimeMatch.fullBytes !== exact
    || stable(report.compiledIdentity) !== stable(r6.fullIdentity(runtime.instantiated.runtime)) || report.runtimeMatch.metadataNormalization !== "none"
    || report.provenance.decodedInputSha256 !== sha(Buffer.from(bundle.originalText))
    || stable(report.gates) !== stable({ agentExactRuntimeMatch: exact, completeRuntimeBinding: false, completeAuthorityVerification: false,
      effectiveRangeSemanticsBound: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false })) fail("REPORT_INVALID");
  const metadata = JSON.parse(output.contracts[AGENT].AaveEModeAgent.metadata);
  if (report.address !== ADDRESS || report.recordedRuntimeKeccak256 !== RUNTIME_HASH || report.compiler.version !== metadata.compiler.version
    || metadata.compiler.version !== "0.8.27+commit.40a35a09" || report.compiler.binarySha256 !== r6.SOLC_SHA
    || stable(report.settings) !== stable(original.settings) || report.provenance.sourceCount !== Object.keys(original.sources).length
    || stable(report.runtimeMatch.immutableBindings) !== stable(runtime.instantiated.bindings)
    || stable(report.runtimeMatch.constructorArguments) !== stable(runtime.instantiated.constructorArguments)) fail("REPORT_INVALID");
  if (Object.keys(bundle.sources).sort().join() !== Object.keys(input.sources).sort().join()) fail("SOURCE_MANIFEST_INVALID");
  for (const [file, source] of Object.entries(input.sources)) {
    const bytes = Buffer.from(source.content);
    if (bundle.sources[file]?.keccak256 !== keccak256(bytes) || bundle.sources[file]?.sha256 !== sha(bytes)) fail("SOURCE_MANIFEST_INVALID");
  }
  for (const [file, source] of Object.entries(metadata.sources)) if (bundle.sources[file]?.keccak256 !== source.keccak256) fail("COMPILED_SOURCE_MISMATCH");
  const priorInput = JSON.parse(pinned(`${R6}/agent.input.json`, PINS[`${R6}/agent.input.json`]));
  if (stable(report.r6Comparison) !== stable(compareInputs(priorInput, original))) fail("SOURCE_COMPARISON_INVALID");
  return true;
}
function publish(bundle) {
  validateBundle(bundle);
  for (const [file, hash] of Object.entries(bundle.hashes)) pinned(file, hash);
  const output = path.join(ROOT, OUT), parent = path.dirname(output);
  if (fs.existsSync(output)) fail("OUTPUT_EXISTS");
  if (!fs.lstatSync(parent).isDirectory() || path.resolve(fs.realpathSync(parent)) !== path.resolve(parent)) fail("OUTPUT_PARENT_INVALID");
  const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const files = { "editor.bundle.json": Buffer.from(bundle.editorText), "published.input.json": Buffer.from(bundle.originalText), "compiler.input.json": json(bundle.input),
    "compiler.output.json": json(bundle.output), "runtime.json": json(bundle.runtime), "sources.json": json(bundle.sources), "input-pins.json": json(bundle.hashes),
    "AaveEModeAgent.sol": Buffer.from(bundle.input.sources[AGENT].content),
    "BaseAaveAgent.sol": Buffer.from(bundle.input.sources["src/contracts/agent/BaseAaveAgent.sol"].content) };
  bundle.report.files = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]));
  bundle.report.runnerSha256 = bundle.hashes[RUNNER]; bundle.report.testsSha256 = bundle.hashes[TEST];
  files["report.json"] = json(bundle.report);
  fs.mkdirSync(output);
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(output, name), fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (sha(fs.readFileSync(file)) !== sha(bytes)) fail("OUTPUT_VERIFICATION_FAILED");
  }
  return { output: OUT, sha256: sha(files["report.json"]), report: bundle.report };
}
function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 1 || !["--check", "--build"].includes(argv[0])) fail("INVOCATION_INVALID");
    const prepared = prepare();
    if (argv[0] === "--check") { console.log(JSON.stringify({ status: "RECOVERED_PACKAGE_CHECK_PASS", sourceCount: Object.keys(prepared.input.sources).length,
      settings: prepared.input.settings, sourceDifference: compareInputs(prepared.priorInput, prepared.input), runtimeHash: keccak256(prepared.observedRuntime), network: false })); return; }
    const result = publish(build(prepared));
    console.log(JSON.stringify({ status: result.report.status, compiledIdentity: result.report.compiledIdentity, r6Comparison: result.report.r6Comparison, output: result.output, sha256: result.sha256 }));
  } catch (error) { console.log(JSON.stringify({ status: "RECOVERY_FAILED", code: error instanceof RecoveryError || error instanceof r6.BuildError ? error.message : "UNEXPECTED",
    detail: error instanceof RecoveryError || error instanceof r6.BuildError ? error.detail : null })); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { ROOT, OUT, PAGE, PAGE_SHA, PINS, ADDRESS, RUNTIME_HASH, AGENT, RecoveryError, sha, decodeLiteral, validateInput, assembleInput,
  extract, prepare, compareInputs, build, validateBundle, publish };
