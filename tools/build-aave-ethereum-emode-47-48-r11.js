#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, ".."), OUT = "reports/raw/fast/aave-ethereum-emode-47-48-r11-source";
const RUNNER = "tools/build-aave-ethereum-emode-47-48-r11.js", TEST = "tools/test-build-aave-ethereum-emode-47-48-r11.js";
const PINS = Object.freeze({
  "tools/build-aave-ethereum-emode-47-48-r6.js": "e67c4575fb1bb88962587fb83a32151715e99d08140fe0468bf23e60f4b0ebab",
  "tools/build-aave-ethereum-emode-47-48-r7.js": "45e4f40db0fef3a94dd87df1d0ea5d292b54290fdcedff88d7080dbfaf55105b",
  "reports/raw/fast/aave-ethereum-emode-47-48-r3.json": "8d92d8ae869e98cd3d4708826cee763dcd34760f627843209e04f4d426e9ae72",
  "reports/raw/fast/aave-ethereum-emode-47-48-r10-authority.json": "50a8b33f50dea4d4dd4d91ecdc41e518af4e2a7542512041d1afaaeaec7a26fd"
});
const SPECS = Object.freeze({
  riskOracle: { address: "0x683d1a91599f971252ef171ef1f987172be8369a", name: "RiskOracle", bytes: 8164,
    keccak256: "0xe3a245fcb855fd012fe430620283344a8b44d2d22034b54b7f07b27e901bfae9",
    page: "C:/Users/MiPC/.local/share/opencode/tool-output/tool_083e564230011hmK3VixX7B36h", pageSha256: "cf4ba5e85298027afb31a76b507bc06a9222ac077c201e26da64256ea17dd237",
    target: "node_modules/aave-v3-risk-stewards/src/contracts/dependencies/RiskOracle.sol", sourceCount: 8 },
  router: { address: "0x1d85000d54ea1185c43e4f2b32833524d3cf3507", name: "LlamaguardRiskOracleRouter", bytes: 15424,
    keccak256: "0xb3c34c82746d880baf470df4d9ffff4fb9e412b34553fbed89a7c17453dfc111",
    page: "C:/Users/MiPC/.local/share/opencode/tool-output/tool_083e56237001Yb7VY8CJqDTWZJ", pageSha256: "8e9da95ed4b28ad0e037ca47ce5f7e6695f6b98002f5678119ac4ca7c170fb9b",
    target: "src/LlamaguardRiskOracleRouter.sol", sourceCount: 12 }
});
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
function read(file, hash) {
  const full = path.resolve(ROOT, file), before = fs.lstatSync(full);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024 * 1024 || path.resolve(fs.realpathSync(full)) !== full) throw Error("INPUT_PATH_INVALID");
  const bytes = fs.readFileSync(full), after = fs.lstatSync(full);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || hash && sha(bytes) !== hash) throw Error("INPUT_HASH_MISMATCH");
  return bytes;
}
for (const [file, hash] of Object.entries(PINS)) read(file, hash);
const r6 = require("./build-aave-ethereum-emode-47-48-r6.js"), r7 = require("./build-aave-ethereum-emode-47-48-r7.js");
const { keccak256 } = require("ethers");
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function sourcePath(file) {
  return /^(src|node_modules)\/[A-Za-z0-9_@./-]+\.sol$/.test(file) && !file.split("/").some(part => ["", ".", ".."].includes(part));
}
function validateInput(input, spec) {
  if (input.language !== "Solidity" || !input.sources?.[spec.target] || Object.keys(input.sources).length !== spec.sourceCount
    || input.settings?.optimizer?.enabled !== true || input.settings.optimizer.runs !== 10000 || input.settings.evmVersion !== "shanghai"
    || input.settings.viaIR !== false || stable(input.settings.metadata) !== stable({ useLiteralContent: false, bytecodeHash: "none", appendCBOR: true })
    || Object.keys(input.settings.libraries || {}).length) throw Error("INPUT_SETTINGS_INVALID");
  const mappings = input.settings.remappings;
  if (!Array.isArray(mappings) || mappings.some(m => typeof m !== "string" || !/^[A-Za-z0-9_@./-]+=[A-Za-z0-9_@./-]+$/.test(m))) throw Error("REMAPPINGS_INVALID");
  let total = 0;
  for (const [file, source] of Object.entries(input.sources)) {
    if (!sourcePath(file) || Object.keys(source || {}).join() !== "content" || typeof source.content !== "string") throw Error("NONLITERAL_SOURCE");
    total += Buffer.byteLength(source.content); if (total > 4 * 1024 * 1024) throw Error("SOURCE_BYTE_CAP");
    const scan = source.content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
    for (const statement of scan.matchAll(/\bimport\s+([^;]+);/g)) {
      const names = [...statement[1].matchAll(/['"]([^'"]+)['"]/g)];
      if (names.length !== 1) throw Error("IMPORT_INVALID");
      const name = names[0][1]; let resolved;
      if (name.startsWith(".")) resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
      else {
        const mapping = mappings.map(m => m.split("=")).filter(([prefix]) => name.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length)[0];
        resolved = mapping ? mapping[1] + name.slice(mapping[0].length) : name;
      }
      if (!sourcePath(resolved) || !Object.hasOwn(input.sources, resolved)) throw Error("IMPORT_NOT_IN_PACKAGE");
    }
  }
  return true;
}
function extract(html, spec) {
  if (typeof html !== "string" || Buffer.byteLength(html) > 4 * 1024 * 1024 || !html.includes(spec.address)
    || !html.includes("v0.8.27+commit.40a35a09")) throw Error("PAGE_SCOPE_INVALID");
  const matches = [...html.matchAll(/\bvar\s+editor_contractJsonData\s*=\s*(?!=)/g)];
  if (matches.length !== 1) throw Error("SOURCE_ASSIGNMENT_AMBIGUOUS");
  const literal = r7.decodeLiteral(html, matches[0].index + matches[0][0].length);
  if (!/^(?:\s*;|[ \t]*\r?\n\s*var\s+editor_activeFile\b)/.test(html.slice(literal.end))) throw Error("SOURCE_EXPRESSION_FORBIDDEN");
  const editor = JSON.parse(literal.value);
  if (editor.language !== "Solidity" || !editor.sources?.["settings.json"]) throw Error("EDITOR_INVALID");
  const input = { language: "Solidity", sources: Object.fromEntries(Object.entries(editor.sources).filter(([file]) => file !== "settings.json")),
    settings: JSON.parse(editor.sources["settings.json"].content) };
  validateInput(input, spec);
  const targets = Object.keys(input.sources).filter(file => file.endsWith(`/${spec.name}.sol`));
  if (targets.length !== 1) throw Error("TARGET_AMBIGUOUS");
  const observed = [...new Set((html.match(/(?:0x)?[a-fA-F0-9]{1000,}/g) || []).map(value => `0x${value.replace(/^0x/, "").toLowerCase()}`))]
    .filter(value => value.length === 2 + 2 * spec.bytes && keccak256(value) === spec.keccak256);
  if (observed.length !== 1) throw Error("PUBLISHED_RUNTIME_MISMATCH");
  return { input, target: targets[0], observedRuntime: observed[0] };
}
function prepare() {
  for (const [file, hash] of Object.entries(PINS)) read(file, hash);
  const r3 = JSON.parse(read("reports/raw/fast/aave-ethereum-emode-47-48-r3.json", PINS["reports/raw/fast/aave-ethereum-emode-47-48-r3.json"]));
  const r10 = JSON.parse(read("reports/raw/fast/aave-ethereum-emode-47-48-r10-authority.json", PINS["reports/raw/fast/aave-ethereum-emode-47-48-r10-authority.json"]));
  if (r3.sha256 !== sha(stable(r3.report)) || r10.sha256 !== sha(stable(r10.report)) || stable(r3.report.pin) !== stable(r10.report.pin)
    || r3.report.status !== "CORROBORATED_OBSERVATIONS" || r10.report.status !== "CORROBORATED_AUTHORITY_TOPOLOGY") throw Error("PRIOR_EVIDENCE_INVALID");
  const packages = {};
  for (const [key, spec] of Object.entries(SPECS)) {
    const identity = r3.report.observations.current.code[key];
    if (identity.address !== spec.address || identity.bytes !== spec.bytes || identity.keccak256 !== spec.keccak256) throw Error("HISTORICAL_IDENTITY_MISMATCH");
    const data = extract(read(spec.page, spec.pageSha256).toString("utf8"), spec), compilerInput = structuredClone(data.input);
    compilerInput.settings.outputSelection = { "*": { "": ["ast"] }, [spec.target]: { [spec.name]: ["abi", "metadata", "evm.bytecode", "evm.deployedBytecode"] } };
    packages[key] = { ...data, compilerInput };
  }
  return { packages, historicalPin: r3.report.pin };
}
function writeExclusive(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!fs.readFileSync(file).equals(bytes)) throw Error("OUTPUT_VERIFICATION_FAILED");
}
function publishSources(prepared, root = ROOT) {
  const output = path.join(root, OUT), parent = path.dirname(output);
  if (fs.existsSync(output)) throw Error("OUTPUT_EXISTS");
  if (!fs.lstatSync(parent).isDirectory() || path.resolve(fs.realpathSync(parent)) !== path.resolve(parent)) throw Error("OUTPUT_PARENT_INVALID");
  const files = {}, packages = {};
  for (const [key, pkg] of Object.entries(prepared.packages)) {
    validateInput(pkg.input, SPECS[key]);
    files[`${key}/published.input.json`] = json(pkg.input); files[`${key}/compiler.input.json`] = json(pkg.compilerInput);
    files[`${key}/observed-runtime.json`] = json({ runtime: pkg.observedRuntime });
    const sources = {};
    for (const [file, source] of Object.entries(pkg.input.sources)) {
      const bytes = Buffer.from(source.content); files[`${key}/sources/${file}`] = bytes;
      sources[file] = { sha256: sha(bytes), keccak256: keccak256(bytes) };
    }
    packages[key] = { address: SPECS[key].address, target: pkg.target, sourceURL: `https://etherscan.io/address/${SPECS[key].address}#code`,
      responseRecord: SPECS[key].page, responseRecordSha256: SPECS[key].pageSha256, sources, compilerSettings: pkg.input.settings };
  }
  const manifest = { schema: "aave-ethereum-emode-47-48-r11-source-extraction/v1", status: "SOURCE_EXTRACTED_BUILD_PENDING", generatedAt: new Date().toISOString(),
    historicalPin: prepared.historicalPin, packages, inputPins: PINS, files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, sha(bytes)])),
    execution: { publicSourceLookups: 2, pageJavaScriptExecuted: false, rpcRequests: 0, inventoryReads: 0, originalGitCommitVerified: false } };
  fs.mkdirSync(output);
  for (const [file, bytes] of Object.entries(files)) writeExclusive(path.join(output, file), bytes);
  writeExclusive(path.join(output, "extraction.json"), json(manifest));
  return { status: manifest.status, output: OUT, sha256: sha(json(manifest)), files: Object.keys(files).length };
}
function verifySources(root = ROOT) {
  const prepared = prepare(), base = path.join(root, OUT), manifest = JSON.parse(read(path.join(base, "extraction.json")));
  if (manifest.status !== "SOURCE_EXTRACTED_BUILD_PENDING" || stable(manifest.historicalPin) !== stable(prepared.historicalPin) || stable(manifest.inputPins) !== stable(PINS)) throw Error("MANIFEST_INVALID");
  const expected = {};
  for (const [key, pkg] of Object.entries(prepared.packages)) {
    expected[`${key}/published.input.json`] = sha(json(pkg.input)); expected[`${key}/compiler.input.json`] = sha(json(pkg.compilerInput));
    expected[`${key}/observed-runtime.json`] = sha(json({ runtime: pkg.observedRuntime }));
    const sources = {};
    for (const [file, source] of Object.entries(pkg.input.sources)) {
      const bytes = Buffer.from(source.content); expected[`${key}/sources/${file}`] = sha(bytes);
      sources[file] = { sha256: sha(bytes), keccak256: keccak256(bytes) };
    }
    if (stable(manifest.packages[key]) !== stable({ address: SPECS[key].address, target: pkg.target,
      sourceURL: `https://etherscan.io/address/${SPECS[key].address}#code`, responseRecord: SPECS[key].page,
      responseRecordSha256: SPECS[key].pageSha256, sources, compilerSettings: pkg.input.settings })) throw Error("MANIFEST_PROVENANCE_INVALID");
  }
  if (stable(expected) !== stable(manifest.files)) throw Error("MANIFEST_FILES_INVALID");
  for (const [file, hash] of Object.entries(expected)) read(path.join(base, file), hash);
  return { prepared, manifest };
}
function validateCompiled(output, spec, pkg) {
  const artifact = output.contracts?.[spec.target]?.[spec.name], evm = artifact?.evm?.deployedBytecode;
  if (!evm || !/^[0-9a-f]+$/.test(evm.object) || evm.object.length % 2 || Object.keys(evm.immutableReferences || {}).length
    || Object.keys(evm.linkReferences || {}).length) throw Error("UNEXPECTED_RUNTIME_SUBSTITUTIONS");
  const metadata = JSON.parse(artifact.metadata);
  if (metadata.compiler.version !== "0.8.27+commit.40a35a09" || metadata.settings.optimizer.runs !== 10000
    || metadata.settings.evmVersion !== "shanghai" || metadata.settings.viaIR === true) throw Error("COMPILER_METADATA_INVALID");
  if (Object.keys(metadata.sources).sort().join() !== Object.keys(pkg.input.sources).sort().join()) throw Error("COMPILED_SOURCE_SET_MISMATCH");
  for (const [file, source] of Object.entries(metadata.sources)) if (source.keccak256 !== keccak256(Buffer.from(pkg.input.sources[file].content))) throw Error("COMPILED_SOURCE_MISMATCH");
  const runtime = `0x${evm.object}`, identity = { bytes: evm.object.length / 2, keccak256: keccak256(runtime) };
  const exact = runtime === pkg.observedRuntime && identity.bytes === spec.bytes && identity.keccak256 === spec.keccak256;
  return { status: exact ? "EXACT_HISTORICAL_RUNTIME_MATCH" : "RUNTIME_MISMATCH", address: spec.address, target: spec.target, sourceCount: spec.sourceCount,
    identity, fullRuntimeMatch: exact, metadataNormalization: "none", immutableSubstitutions: 0, linkedLibrarySubstitutions: 0 };
}
function build(root = ROOT) {
  const base = path.join(root, OUT);
  if (fs.existsSync(path.join(base, "report.json")) || Object.keys(SPECS).some(key => fs.existsSync(path.join(base, key, "compiler.output.json")))) throw Error("BUILD_OUTPUT_EXISTS");
  const { prepared } = verifySources(root), results = {}, outputs = {};
  read(r6.SOLC, r6.SOLC_SHA);
  const { execFileSync } = require("node:child_process");
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const version = execFileSync(r6.SOLC, ["--version"], { env, encoding: "utf8", timeout: 10000 });
  if (!version.includes("0.8.27+commit.40a35a09")) throw Error("COMPILER_VERSION_MISMATCH");
  for (const [key, pkg] of Object.entries(prepared.packages)) {
    validateInput(pkg.compilerInput, SPECS[key]);
    // Keep the explorer's node_modules source names; do not substitute installed dependencies.
    const raw = execFileSync(r6.SOLC, ["--standard-json"], { input: JSON.stringify(pkg.compilerInput), cwd: ROOT, env, timeout: 120000,
      maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const output = JSON.parse(raw), errors = (output.errors || []).filter(error => error.severity === "error");
    if (errors.length) { const error = Error("COMPILATION_FAILED"); error.detail = errors.map(row => ({ code: row.errorCode, message: row.message })); throw error; }
    results[key] = validateCompiled(output, SPECS[key], pkg); outputs[key] = output;
  }
  read(r6.SOLC, r6.SOLC_SHA); verifySources(root);
  const exact = Object.values(results).every(result => result.fullRuntimeMatch);
  const report = { schema: "aave-ethereum-emode-47-48-r11-source-build/v1", generatedAt: new Date().toISOString(),
    status: exact ? "BOTH_EXACT_HISTORICAL_RUNTIME_MATCH" : "SOURCE_BINDING_INCOMPLETE", historicalPin: prepared.historicalPin, results,
    compiler: { version: "0.8.27+commit.40a35a09", sha256: r6.SOLC_SHA, evmVersion: "shanghai", optimizerRuns: 10000, viaIR: false },
    extractionSha256: sha(read(path.join(base, "extraction.json"))),
    outputHashes: Object.fromEntries(Object.entries(outputs).map(([key, output]) => [key, sha(json(output))])),
    runnerSha256: sha(read(RUNNER)), testsSha256: sha(read(TEST)),
    gates: { riskOracleRuntimeBound: results.riskOracle.fullRuntimeMatch, routerRuntimeBound: results.router.fullRuntimeMatch,
      completeRuntimeBinding: false, completeAuthorityVerification: false, effectiveRangeSemanticsBound: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false },
    limitations: ["Historical source/runtime identity only; current state is not refreshed.", "Workflow configuration, controller provenance and upstream forwarder authentication remain unbound.",
      "Creation transactions and original Git commits are not independently verified."] };
  for (const [key, output] of Object.entries(outputs)) writeExclusive(path.join(base, key, "compiler.output.json"), json(output));
  writeExclusive(path.join(base, "report.json"), json(report));
  return { status: report.status, results, sha256: sha(json(report)), network: false };
}
function verify(root = ROOT) {
  const { prepared } = verifySources(root), base = path.join(root, OUT), bytes = read(path.join(base, "report.json")), report = JSON.parse(bytes);
  if (report.extractionSha256 !== sha(read(path.join(base, "extraction.json"))) || report.runnerSha256 !== sha(read(RUNNER)) || report.testsSha256 !== sha(read(TEST))
    || stable(report.historicalPin) !== stable(prepared.historicalPin)
    || stable(report.compiler) !== stable({ version: "0.8.27+commit.40a35a09", sha256: r6.SOLC_SHA, evmVersion: "shanghai", optimizerRuns: 10000, viaIR: false })) throw Error("REPORT_PINS_INVALID");
  const results = {};
  for (const [key, spec] of Object.entries(SPECS)) {
    const output = JSON.parse(read(path.join(base, key, "compiler.output.json"), report.outputHashes[key]));
    results[key] = validateCompiled(output, spec, prepared.packages[key]);
  }
  const exact = Object.values(results).every(row => row.fullRuntimeMatch);
  if (stable(report.results) !== stable(results) || report.status !== (exact ? "BOTH_EXACT_HISTORICAL_RUNTIME_MATCH" : "SOURCE_BINDING_INCOMPLETE")
    || stable(report.gates) !== stable({ riskOracleRuntimeBound: results.riskOracle.fullRuntimeMatch, routerRuntimeBound: results.router.fullRuntimeMatch,
      completeRuntimeBinding: false, completeAuthorityVerification: false, effectiveRangeSemanticsBound: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false })) throw Error("REPORT_INVALID");
  return { status: report.status, results, reportSha256: sha(bytes), network: false, compilerRerun: false };
}
function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 1 || !["--inspect", "--extract", "--build", "--verify"].includes(argv[0])) throw Error("INVOCATION_INVALID");
    if (argv[0] === "--extract") { console.log(JSON.stringify(publishSources(prepare()))); return; }
    if (argv[0] === "--build") { console.log(JSON.stringify(build())); return; }
    if (argv[0] === "--verify") { console.log(JSON.stringify(verify())); return; }
    console.log(JSON.stringify(Object.fromEntries(Object.entries(SPECS).map(([key, spec]) => {
      const bytes = read(spec.page, spec.pageSha256), extracted = extract(bytes.toString("utf8"), spec);
      return [key, { pageSha256: sha(bytes), target: extracted.target, sources: Object.keys(extracted.input.sources), settings: extracted.input.settings,
        immutableDeclarations: Object.entries(extracted.input.sources).flatMap(([file, source]) => [...source.content.matchAll(/[^\n;]*\bimmutable\b[^;]*;/g)].map(match => ({ file, declaration: match[0] }))),
        runtimeMatchesHistoricalHash: true }];
    })), null, 2));
  } catch (error) { console.log(JSON.stringify({ status: "FAILED", code: error.message, detail: error.detail || null })); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { ROOT, OUT, RUNNER, TEST, PINS, SPECS, sha, stable, read, sourcePath, validateInput, extract, prepare, publishSources,
  verifySources, validateCompiled, build, verify };
