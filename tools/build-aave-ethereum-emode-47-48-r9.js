#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { keccak256 } = require("ethers");
const ROOT = path.resolve(__dirname, "..");
const OUT = "reports/raw/fast/aave-ethereum-emode-47-48-r9-source";
const PAGE = "C:/Users/MiPC/.local/share/opencode/tool-output/tool_083a5e082001BK2GDn2I9gn3q3";
const PAGE_SHA = "2f7899c3315917dd16c7bac76aa41d28bcb155efeb9123ba13225b41444bf5d9";
const ADDRESS = "0xeafaefa93c6aabd5ab7e76f4c37aebe9da1e8318";
const TARGET = "lib/aave-v3-origin-private/src/contracts/extensions/v3-config-engine/AaveV3ConfigEngine.sol";
const RUNTIME_BYTES = 21262;
const RUNTIME_HASH = "0x92dd6ae1a9e49dee24c093ee982a08528f8d1f11990b9a7ac7e4338802fe3399";
const RUNNER = "tools/build-aave-ethereum-emode-47-48-r9.js";
const TEST = "tools/test-build-aave-ethereum-emode-47-48-r9.js";
const PINS = Object.freeze({
  "tools/build-aave-ethereum-emode-47-48-r6.js": "e67c4575fb1bb88962587fb83a32151715e99d08140fe0468bf23e60f4b0ebab",
  "tools/build-aave-ethereum-emode-47-48-r7.js": "45e4f40db0fef3a94dd87df1d0ea5d292b54290fdcedff88d7080dbfaf55105b",
  "reports/raw/fast/aave-ethereum-emode-47-48-r8.json": "5dc296fdff8f9fdd618cd028d8af8e75a40eb7edfcfd4197fc4a0ad623384969"
});
const VALUES = Object.freeze({
  ATOKEN_IMPL: "0xadc45df3cf1584624c97338bef33363bf5b97ada",
  VTOKEN_IMPL: "0xb27c52c7f84819e3157993489741cb60786ae330",
  POOL: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
  POOL_CONFIGURATOR: "0x64b761d848206f447fe2dd461b0c635ec39ebb27",
  ORACLE: "0x54586be62e3c3580375ae3723c145253060ca0c2",
  REWARDS_CONTROLLER: "0x8164cc65827dcfe994ab23944cbc90e0aa80bfcb",
  COLLECTOR: "0x464c71f6c2f760dda6093dcb91c24c39e5d6e18c",
  DEFAULT_INTEREST_RATE_STRATEGY: "0x9ec6f08190dea04a54f8afc53db96134e5e3fdfb"
});
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
class BuildError extends Error { constructor(code, detail = null) { super(code); this.detail = detail; } }
const fail = (code, detail) => { throw new BuildError(code, detail); };
function pinned(file, hash) {
  const full = path.isAbsolute(file) ? file : path.join(ROOT, file), before = fs.lstatSync(full);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024 * 1024 || path.resolve(fs.realpathSync(full)) !== path.resolve(full)) fail("INPUT_PATH_INVALID");
  const bytes = fs.readFileSync(full), after = fs.lstatSync(full);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha(bytes) !== hash) fail("INPUT_HASH_MISMATCH", file);
  return bytes;
}
pinned("tools/build-aave-ethereum-emode-47-48-r6.js", PINS["tools/build-aave-ethereum-emode-47-48-r6.js"]);
pinned("tools/build-aave-ethereum-emode-47-48-r7.js", PINS["tools/build-aave-ethereum-emode-47-48-r7.js"]);
const r6 = require("./build-aave-ethereum-emode-47-48-r6.js");
const r7 = require("./build-aave-ethereum-emode-47-48-r7.js");

function validateInput(input) {
  if (!input || input.language !== "Solidity" || !input.sources?.[TARGET] || !input.settings
    || Object.keys(input.sources).length !== 25 || input.settings.optimizer?.enabled !== true || input.settings.optimizer.runs !== 200
    || input.settings.evmVersion !== "cancun" || input.settings.viaIR !== false || input.settings.metadata?.bytecodeHash !== "none"
    || input.settings.metadata?.appendCBOR !== true || Object.keys(input.settings.libraries || {}).length) fail("PACKAGE_SCHEMA_INVALID");
  const remappings = input.settings.remappings || [];
  if (!Array.isArray(remappings) || remappings.some((item) => typeof item !== "string" || !/^[A-Za-z0-9_@./:=-]+$/.test(item))) fail("REMAPPINGS_INVALID");
  let total = 0;
  for (const [file, source] of Object.entries(input.sources)) {
    if (!/^(?:lib|src)\/[A-Za-z0-9_./-]+\.sol$/.test(file) || file.split("/").includes("..") || Object.keys(source || {}).join() !== "content"
      || typeof source.content !== "string") fail("SOURCE_INVALID", file);
    total += Buffer.byteLength(source.content); if (total > 4 * 1024 * 1024) fail("SOURCE_BYTE_LIMIT");
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
function assemble(editor) {
  if (!editor || editor.language !== "Solidity" || !editor.sources?.["settings.json"] || typeof editor.sources["settings.json"].content !== "string") fail("EDITOR_BUNDLE_INVALID");
  let settings; try { settings = JSON.parse(editor.sources["settings.json"].content); } catch (_) { fail("SETTINGS_JSON_INVALID"); }
  const input = { language: editor.language, sources: Object.fromEntries(Object.entries(editor.sources).filter(([file]) => file !== "settings.json")), settings };
  validateInput(input); return input;
}
function extract(html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > 4 * 1024 * 1024 || !html.toLowerCase().includes(ADDRESS)
    || !html.includes("v0.8.27+commit.40a35a09") || !html.includes("cancun")) fail("PAGE_SCOPE_INVALID");
  const matches = [...html.matchAll(/\bvar\s+editor_contractJsonData\s*=\s*(?!=)/g)];
  if (matches.length !== 1) fail("SOURCE_ASSIGNMENT_AMBIGUOUS");
  const literal = r7.decodeLiteral(html, matches[0].index + matches[0][0].length);
  if (!/^(?:\s*;|[ \t]*\r?\n\s*var\s+editor_activeFile\b)/.test(html.slice(literal.end))) fail("SOURCE_EXPRESSION_FORBIDDEN");
  let editor; try { editor = JSON.parse(literal.value); } catch (_) { fail("SOURCE_JSON_INVALID"); }
  const input = assemble(editor);
  const runtimes = [...new Set((html.match(/(?:0x)?[a-fA-F0-9]{1000,}/g) || []).map((value) => `0x${value.replace(/^0x/, "").toLowerCase()}`))]
    .filter((value) => value.length === 2 + RUNTIME_BYTES * 2 && keccak256(value) === RUNTIME_HASH);
  if (runtimes.length !== 1) fail("PUBLISHED_RUNTIME_NOT_BOUND");
  return { editorText: literal.value, originalText: JSON.stringify(input), input, observedRuntime: runtimes[0] };
}
function immutableNames(output) {
  const names = new Map();
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.nodeType === "VariableDeclaration" && value.mutability === "immutable" && Number.isInteger(value.id) && typeof value.name === "string") names.set(String(value.id), value.name);
    for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child);
  };
  for (const source of Object.values(output.sources || {})) walk(source.ast);
  return names;
}
function instantiate(output) {
  const artifact = output.contracts?.[TARGET]?.AaveV3ConfigEngine;
  if (!artifact?.evm?.deployedBytecode?.object) fail("COMPILER_OUTPUT_INVALID");
  const runtime = Buffer.from(artifact.evm.deployedBytecode.object, "hex"), names = immutableNames(output), bindings = [];
  const seen = new Set();
  for (const [astId, refs] of Object.entries(artifact.evm.deployedBytecode.immutableReferences || {})) {
    const name = names.get(astId), value = VALUES[name];
    if (!value || seen.has(name) || !Array.isArray(refs) || !refs.length) fail("IMMUTABLE_BINDING_INVALID", { astId, name });
    seen.add(name); const word = Buffer.from(value.slice(2).padStart(64, "0"), "hex");
    for (const ref of refs) {
      if (!Number.isInteger(ref.start) || ref.length !== 32 || ref.start < 0 || ref.start + 32 > runtime.length) fail("IMMUTABLE_REFERENCE_INVALID", { astId, name });
      word.copy(runtime, ref.start);
    }
    bindings.push({ astId, name, value, offsets: refs.map(({ start, length }) => ({ start, length })) });
  }
  if (seen.size !== Object.keys(VALUES).length || Object.keys(VALUES).some((name) => !seen.has(name))) fail("IMMUTABLE_SET_INVALID");
  return { runtime: `0x${runtime.toString("hex")}`, bindings: bindings.sort((a, b) => a.name.localeCompare(b.name)), constructorArguments: Object.values(VALUES) };
}
function prepare() {
  for (const [file, hash] of Object.entries(PINS)) pinned(file, hash);
  const recovered = extract(pinned(PAGE, PAGE_SHA).toString("utf8")), compilerInput = structuredClone(recovered.input);
  compilerInput.settings.outputSelection = { "*": { "": ["ast"] }, [TARGET]: { AaveV3ConfigEngine: ["abi", "metadata", "evm.bytecode", "evm.deployedBytecode"] } };
  const hashes = { ...PINS, [RUNNER]: sha(fs.readFileSync(__filename)), [TEST]: sha(fs.readFileSync(path.join(ROOT, TEST))) };
  return { ...recovered, compilerInput, hashes };
}
function build(prepared = prepare()) {
  const output = r6.compile(prepared.compilerInput), instantiated = instantiate(output), artifact = output.contracts[TARGET].AaveV3ConfigEngine;
  const metadata = JSON.parse(artifact.metadata), identity = r6.fullIdentity(instantiated.runtime), exact = instantiated.runtime === prepared.observedRuntime && identity.keccak256 === RUNTIME_HASH;
  const sources = Object.fromEntries(Object.entries(prepared.input.sources).map(([file, source]) => [file, { sha256: sha(Buffer.from(source.content)), keccak256: keccak256(Buffer.from(source.content)) }]));
  for (const [file, source] of Object.entries(metadata.sources || {})) if (sources[file]?.keccak256 !== source.keccak256) fail("COMPILED_SOURCE_MISMATCH", file);
  const r8 = JSON.parse(pinned("reports/raw/fast/aave-ethereum-emode-47-48-r8.json", PINS["reports/raw/fast/aave-ethereum-emode-47-48-r8.json"]));
  const report = { schema: "aave-ethereum-emode-47-48-r9-source/v1", status: exact ? "CONFIG_ENGINE_EXACT_RUNTIME_MATCH" : "CONFIG_ENGINE_RUNTIME_MISMATCH",
    generatedAt: new Date().toISOString(), address: ADDRESS, historicalPin: r8.report.pin,
    provenance: { sourceURL: `https://etherscan.io/address/${ADDRESS}#code`, responseRecord: PAGE, responseRecordSha256: PAGE_SHA,
      sourceCount: Object.keys(sources).length, compilerOutputSelectionOnlyChanged: true, pageJavaScriptExecuted: false, originalGitCommit: "unknown" },
    compiler: { version: metadata.compiler.version, binarySha256: r6.SOLC_SHA, evmVersion: "cancun", optimizerRuns: 200 }, settings: prepared.input.settings,
    compiledIdentity: identity, recordedRuntimeKeccak256: RUNTIME_HASH, runtimeMatch: { fullBytes: exact, metadataNormalization: "none",
      immutableBindings: instantiated.bindings, constructorArguments: instantiated.constructorArguments, creationTransactionVerified: false },
    dependencies: { pool: VALUES.POOL, poolConfigurator: VALUES.POOL_CONFIGURATOR, oracle: VALUES.ORACLE, rewardsController: VALUES.REWARDS_CONTROLLER,
      collector: VALUES.COLLECTOR, defaultInterestRateStrategy: VALUES.DEFAULT_INTEREST_RATE_STRATEGY, aTokenImpl: VALUES.ATOKEN_IMPL, vTokenImpl: VALUES.VTOKEN_IMPL },
    gates: { configEngineExactRuntimeMatch: exact, completeRuntimeBinding: false, completeAuthorityVerification: false,
      effectiveRangeSemanticsBound: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false },
    execution: { publicSourceLookups: 2, rpcRequests: 0, inventoryReads: 0, revisionSweep: false, compilerSettingsSweep: false },
    limitations: ["Exact source/build identity is historical and does not refresh R3 state.", "Original Git commit and creation transaction are not independently certified.",
      "Hub owner/proxy admin, agent admin, RiskOracle publisher and Aave ACL authority remain unverified."] };
  return { report, input: prepared.compilerInput, originalText: prepared.originalText, editorText: prepared.editorText, output, runtime: { observed: prepared.observedRuntime, instantiated }, sources, hashes: prepared.hashes };
}
function validateBundle(bundle) {
  const original = JSON.parse(bundle.originalText), rebuilt = assemble(JSON.parse(bundle.editorText));
  if (stable(original) !== stable(rebuilt)) fail("EDITOR_RECONSTRUCTION_CHANGED");
  validateInput(original); validateInput(bundle.input);
  const { outputSelection: _a, ...before } = original.settings, { outputSelection: _b, ...after } = bundle.input.settings;
  if (stable(original.sources) !== stable(bundle.input.sources) || stable(before) !== stable(after)) fail("CODEGEN_INPUT_CHANGED");
  const instantiated = instantiate(bundle.output), exact = instantiated.runtime === bundle.runtime.observed && keccak256(bundle.runtime.observed) === RUNTIME_HASH;
  if (stable(instantiated) !== stable(bundle.runtime.instantiated) || bundle.report.status !== (exact ? "CONFIG_ENGINE_EXACT_RUNTIME_MATCH" : "CONFIG_ENGINE_RUNTIME_MISMATCH")
    || bundle.report.runtimeMatch.fullBytes !== exact || bundle.report.runtimeMatch.metadataNormalization !== "none"
    || stable(bundle.report.gates) !== stable({ configEngineExactRuntimeMatch: exact, completeRuntimeBinding: false, completeAuthorityVerification: false,
      effectiveRangeSemanticsBound: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false })) fail("REPORT_INVALID");
  if (Object.keys(bundle.sources).sort().join() !== Object.keys(original.sources).sort().join()) fail("SOURCE_MANIFEST_INVALID");
  for (const [file, source] of Object.entries(original.sources)) {
    const bytes = Buffer.from(source.content); if (bundle.sources[file]?.sha256 !== sha(bytes) || bundle.sources[file]?.keccak256 !== keccak256(bytes)) fail("SOURCE_MANIFEST_INVALID");
  }
  return true;
}
function publish(bundle) {
  validateBundle(bundle); const output = path.join(ROOT, OUT), parent = path.dirname(output);
  if (fs.existsSync(output)) fail("OUTPUT_EXISTS");
  if (!fs.lstatSync(parent).isDirectory() || path.resolve(fs.realpathSync(parent)) !== path.resolve(parent)) fail("OUTPUT_PARENT_INVALID");
  const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`), files = { "editor.bundle.json": Buffer.from(bundle.editorText),
    "published.input.json": Buffer.from(bundle.originalText), "compiler.input.json": json(bundle.input), "compiler.output.json": json(bundle.output),
    "runtime.json": json(bundle.runtime), "sources.json": json(bundle.sources), "input-pins.json": json(bundle.hashes),
    "AaveV3ConfigEngine.sol": Buffer.from(bundle.input.sources[TARGET].content) };
  bundle.report.files = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]));
  bundle.report.runnerSha256 = bundle.hashes[RUNNER]; bundle.report.testsSha256 = bundle.hashes[TEST]; files["report.json"] = json(bundle.report);
  fs.mkdirSync(output);
  for (const [name, bytes] of Object.entries(files)) { const file = path.join(output, name), fd = fs.openSync(file, "wx", 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } if (sha(fs.readFileSync(file)) !== sha(bytes)) fail("OUTPUT_VERIFICATION_FAILED"); }
  return { output: OUT, sha256: sha(files["report.json"]), report: bundle.report };
}
function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 1 || !["--check", "--build"].includes(argv[0])) fail("INVOCATION_INVALID");
    const prepared = prepare();
    if (argv[0] === "--check") { console.log(JSON.stringify({ status: "RECOVERED_PACKAGE_CHECK_PASS", sources: Object.keys(prepared.input.sources).length,
      settings: prepared.input.settings, runtimeBytes: RUNTIME_BYTES, runtimeKeccak256: keccak256(prepared.observedRuntime), network: false })); return; }
    const result = publish(build(prepared)); console.log(JSON.stringify({ status: result.report.status, compiledIdentity: result.report.compiledIdentity, output: result.output, sha256: result.sha256 }));
  } catch (error) { console.log(JSON.stringify({ status: "BUILD_FAILED", code: error instanceof BuildError || error instanceof r6.BuildError ? error.message : "UNEXPECTED", detail: error.detail || null })); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { ROOT, OUT, PAGE, PAGE_SHA, PINS, ADDRESS, TARGET, RUNTIME_BYTES, RUNTIME_HASH, VALUES, BuildError, sha, stable,
  validateInput, assemble, extract, immutableNames, instantiate, prepare, build, validateBundle, publish };
