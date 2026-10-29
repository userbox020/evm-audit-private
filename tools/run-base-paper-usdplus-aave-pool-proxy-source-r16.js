"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { keccak256, toUtf8Bytes } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r16/pool-proxy-authority");
const TARGET_ADDRESS = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const ADMIN = "0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d";
const ADMIN_WORD = `000000000000000000000000${ADMIN.slice(2)}`;
const TARGET = "src/core/contracts/protocol/libraries/aave-upgradeability/InitializableImmutableAdminUpgradeabilityProxy.sol:InitializableImmutableAdminUpgradeabilityProxy";
const TARGET_PATH = TARGET.split(":")[0], TARGET_NAME = TARGET.split(":")[1];
const VERSION = "0.8.19+commit.7dd6d404";
const SOURCES = Object.freeze([
  "src/core/contracts/dependencies/openzeppelin/contracts/Address.sol",
  "src/core/contracts/dependencies/openzeppelin/upgradeability/Proxy.sol",
  "src/core/contracts/dependencies/openzeppelin/upgradeability/BaseUpgradeabilityProxy.sol",
  "src/core/contracts/dependencies/openzeppelin/upgradeability/InitializableUpgradeabilityProxy.sol",
  "src/core/contracts/protocol/libraries/aave-upgradeability/BaseImmutableAdminUpgradeabilityProxy.sol",
  TARGET_PATH,
]);
const IMMUTABLE_STARTS = Object.freeze([274, 342, 526, 845, 886, 1177]);
const EXPECTED_LIBRARY_NAMES = Object.freeze(["BorrowLogic", "BridgeLogic", "ConfiguratorLogic", "EModeLogic", "FlashLoanLogic", "LiquidationLogic", "PoolLogic", "SupplyLogic"]);
const REQUESTS = Object.freeze([
  Object.freeze({ origin: "https://sourcify.dev", hostname: "sourcify.dev", path: "/server/v2/contract/8453/0xA238Dd80C259a72e81d7e4664a9801593F98d1c5?fields=all", method: "GET", accept: "application/json", kind: "json" }),
  Object.freeze({ origin: "https://binaries.soliditylang.org", hostname: "binaries.soliditylang.org", path: "/windows-amd64/list.json", method: "GET", accept: "application/json", kind: "json" }),
]);
const LIMITS = Object.freeze({ requests: 3, requestMs: 20000, responseBytes: 32 * 1024 * 1024, totalBytes: 96 * 1024 * 1024, compilerMs: 120000, compilerOutputBytes: 64 * 1024 * 1024 });

class AuthorityError extends Error { constructor(stage, code) { super(code); this.stage = stage; this.code = code; } }
const fail = (stage, code) => { throw new AuthorityError(stage, code); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = value => value === null || typeof value !== "object" ? value : Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
const stableText = value => `${JSON.stringify(stable(value), null, 2)}\n`;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const hex = (value, code = "BYTECODE_INVALID") => { if (typeof value !== "string" || !/^(?:0x)?(?:[0-9a-fA-F]{2})*$/.test(value)) fail("VALIDATION", code); return value.replace(/^0x/, "").toLowerCase(); };
const address = value => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;

function parseCli(argv) { if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--once") fail("CLI", "EXPLICIT_ONCE_REQUIRED"); return true; }
function requestPlan(compilerPath = null) {
  const rows = [...REQUESTS]; if (compilerPath) rows.push(Object.freeze({ origin: "https://binaries.soliditylang.org", hostname: "binaries.soliditylang.org", path: `/windows-amd64/${compilerPath}`, method: "GET", accept: "application/octet-stream", kind: "binary" })); return rows;
}
function newBudget() { return { requests: 0, bytes: 0, responses: [] }; }
function validateRequest(spec) {
  if (!spec || spec.method !== "GET" || !["sourcify.dev", "binaries.soliditylang.org"].includes(spec.hostname) || spec.origin !== `https://${spec.hostname}`
    || typeof spec.path !== "string" || spec.path.includes("\\") || !spec.path.startsWith("/") || !["application/json", "application/octet-stream"].includes(spec.accept)) fail("REQUEST", "REQUEST_NOT_ALLOWED");
  if (spec.hostname === "sourcify.dev" && spec.path !== REQUESTS[0].path) fail("REQUEST", "REQUEST_PATH_INVALID");
  if (spec.hostname === "binaries.soliditylang.org" && spec.path !== REQUESTS[1].path && !/^\/windows-amd64\/solc-windows-amd64-v0\.8\.19\+commit\.7dd6d404\.exe$/.test(spec.path)) fail("REQUEST", "REQUEST_PATH_INVALID");
  return true;
}
function nativeFetch(spec) {
  validateRequest(spec);
  return new Promise((resolve, reject) => {
    let settled = false, bytes = 0, timer; const chunks = [];
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const req = https.request({ protocol: "https:", hostname: spec.hostname, port: 443, path: spec.path, method: "GET", headers: { accept: spec.accept }, agent: false }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); done(new AuthorityError("REQUEST", "REDIRECT_REJECTED")); return; }
      if (response.statusCode !== 200) { response.resume(); done(new AuthorityError("REQUEST", "HTTP_STATUS_INVALID")); return; }
      const type = String(response.headers["content-type"] || "").toLowerCase(), validType = spec.kind === "json" ? /^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/.test(type) : /^(?:application\/octet-stream|application\/x-msdownload|binary\/octet-stream)(?:;|$)/.test(type);
      if (!validType) { response.resume(); done(new AuthorityError("REQUEST", "CONTENT_TYPE_INVALID")); return; }
      const length = Number(response.headers["content-length"]); if (response.headers["content-length"] !== undefined && (!Number.isSafeInteger(length) || length < 0 || length > LIMITS.responseBytes)) { response.resume(); done(new AuthorityError("REQUEST", "CONTENT_LENGTH_INVALID")); return; }
      response.on("data", chunk => { bytes += chunk.length; if (bytes > LIMITS.responseBytes) { req.destroy(); done(new AuthorityError("REQUEST", "RESPONSE_SIZE_CAP")); return; } chunks.push(chunk); });
      response.on("end", () => done(null, { status: 200, contentType: type, redirected: false, body: Buffer.concat(chunks), bytes })); response.on("error", () => done(new AuthorityError("REQUEST", "TRANSPORT_FAILURE")));
    });
    timer = setTimeout(() => { req.destroy(); done(new AuthorityError("REQUEST", "REQUEST_TIMEOUT")); }, LIMITS.requestMs); req.on("error", () => done(new AuthorityError("REQUEST", "TRANSPORT_FAILURE"))); req.end();
  });
}
async function fetchBounded(spec, budget, transport = nativeFetch) {
  validateRequest(spec); if (budget.requests >= LIMITS.requests) fail("REQUEST", "REQUEST_CAP"); budget.requests++;
  const response = await transport(spec); if (!response || response.redirected || response.status !== 200) fail("REQUEST", response?.redirected ? "REDIRECT_REJECTED" : "HTTP_STATUS_INVALID");
  if (!Buffer.isBuffer(response.body)) fail("REQUEST", "RESPONSE_BODY_INVALID"); const bytes = response.body.length;
  if (response.contentLength !== undefined && (!Number.isSafeInteger(response.contentLength) || response.contentLength !== bytes || response.contentLength > LIMITS.responseBytes)) fail("REQUEST", "CONTENT_LENGTH_INVALID");
  if (bytes > LIMITS.responseBytes) fail("REQUEST", "RESPONSE_SIZE_CAP"); budget.bytes += bytes; if (budget.bytes > LIMITS.totalBytes) fail("REQUEST", "TOTAL_SIZE_CAP");
  const type = String(response.contentType || "").toLowerCase(); if (spec.kind === "json" ? !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/.test(type) : !/^(?:application\/octet-stream|application\/x-msdownload|binary\/octet-stream)(?:;|$)/.test(type)) fail("REQUEST", "CONTENT_TYPE_INVALID");
  budget.responses.push({ ordinal: budget.requests, bytes, kind: spec.kind }); return response.body;
}
function parseJson(bytes, code) { try { return JSON.parse(bytes.toString("utf8")); } catch (_) { fail("VALIDATION", code); } }

function safeSourcePath(value) {
  if (typeof value !== "string" || value.includes("\\") || path.posix.isAbsolute(value) || value.split("/").some(segment => !segment || segment === "." || segment === "..")) fail("VALIDATION", "SOURCE_PATH_INVALID"); return value;
}
function parseMetadata(value) { if (typeof value === "string") return parseJson(Buffer.from(value), "METADATA_INVALID"); if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION", "METADATA_INVALID"); return value; }
function normalizeLibraries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION", "LIBRARY_MAP_INVALID"); const rows = [];
  for (const source of Object.keys(value).sort()) { safeSourcePath(source); if (!value[source] || typeof value[source] !== "object" || Array.isArray(value[source])) fail("VALIDATION", "LIBRARY_MAP_INVALID");
    for (const name of Object.keys(value[source]).sort()) { const resolved = address(value[source][name]); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !resolved) fail("VALIDATION", "LIBRARY_MAP_INVALID"); rows.push({ source, name, address: resolved }); } }
  return rows;
}
function validateSettings(settings, requireCompilationTarget) {
  if (!settings || settings.optimizer?.enabled !== true || settings.optimizer?.runs !== 200 || settings.evmVersion !== "paris" || settings.metadata?.bytecodeHash !== "ipfs"
    || (settings.viaIR !== undefined && settings.viaIR !== false)) fail("VALIDATION", "COMPILER_SETTINGS_MISMATCH");
  if (requireCompilationTarget && (!settings.compilationTarget || Object.keys(settings.compilationTarget).length !== 1 || settings.compilationTarget[TARGET_PATH] !== TARGET_NAME)) fail("VALIDATION", "COMPILATION_TARGET_MISMATCH");
  if (!requireCompilationTarget && settings.compilationTarget !== undefined) fail("VALIDATION", "STD_INPUT_COMPILATION_TARGET_PRESENT");
}
function comparableSettings(settings) {
  return { optimizer: settings.optimizer, evmVersion: settings.evmVersion, metadata: settings.metadata, viaIR: settings.viaIR === undefined ? false : settings.viaIR,
    libraries: settings.libraries || {}, remappings: settings.remappings || [] };
}
function validateSourcify(payload) {
  if (!payload || Number(payload.chainId) !== 8453 || address(payload.address) !== TARGET_ADDRESS) fail("SOURCIFY", "CHAIN_OR_ADDRESS_MISMATCH");
  if (payload.match !== "exact_match" || payload.creationMatch !== "exact_match" || payload.runtimeMatch !== "exact_match") fail("SOURCIFY", "EXACT_MATCH_REQUIRED");
  if (Number(payload.matchId) !== 3701250) fail("SOURCIFY", "MATCH_ID_MISMATCH");
  const metadata = parseMetadata(payload.metadata), std = payload.stdJsonInput, compilation = payload.compilation;
  if (!std || std.language !== "Solidity" || !compilation || compilation.language !== "Solidity" || !["solc", "Solidity"].includes(compilation.compiler)
    || compilation.compilerVersion !== VERSION || compilation.fullyQualifiedName !== TARGET) fail("SOURCIFY", "COMPILER_IDENTITY_MISMATCH");
  validateSettings(std.settings, false); validateSettings(metadata.settings, true); if (!same(comparableSettings(std.settings), comparableSettings(metadata.settings))) fail("SOURCIFY", "METADATA_STD_SETTINGS_MISMATCH");
  const keys = Object.keys(payload.sources || {}), stdKeys = Object.keys(std.sources || {}), metadataKeys = Object.keys(metadata.sources || {});
  for (const value of [...keys, ...stdKeys, ...metadataKeys]) safeSourcePath(value); const expected = [...SOURCES].sort();
  if (!same([...keys].sort(), expected) || !same([...stdKeys].sort(), expected) || !same([...metadataKeys].sort(), expected) || new Set(keys.map(key => key.toLowerCase())).size !== keys.length) fail("SOURCIFY", "SOURCE_SET_MISMATCH");
  const sourceRows = [];
  for (const sourcePath of SOURCES) {
    const a = payload.sources[sourcePath]?.content, b = std.sources[sourcePath]?.content, expectedHash = metadata.sources[sourcePath]?.keccak256;
    if (typeof a !== "string" || a !== b || typeof expectedHash !== "string" || keccak256(toUtf8Bytes(a)).toLowerCase() !== expectedHash.toLowerCase()) fail("SOURCIFY", "SOURCE_CONTENT_OR_HASH_MISMATCH");
    sourceRows.push({ path: sourcePath, bytes: Buffer.byteLength(a), keccak256: expectedHash.toLowerCase(), sha256: sha(Buffer.from(a, "utf8")), content: a });
  }
  const metadataLibraries = normalizeLibraries(metadata.settings.libraries || {}), stdLibraries = normalizeLibraries(std.settings.libraries || {});
  if (!same(metadataLibraries, stdLibraries) || !EXPECTED_LIBRARY_NAMES.every(name => metadataLibraries.some(row => row.name === name))) fail("SOURCIFY", "LIBRARY_MAP_MISMATCH");
  const constructor = hex(payload.constructorArgs || payload.creationBytecode?.transformationValues?.constructorArguments || "", "CONSTRUCTOR_ARGUMENT_MISMATCH");
  if (constructor !== ADMIN_WORD) fail("SOURCIFY", "CONSTRUCTOR_ARGUMENT_MISMATCH");
  const deployment = payload.deployment || {}; if (String(deployment.transactionHash || "").toLowerCase() !== "0x65ada47b1e29db97b062d601cc2d3d4ba3b4ce8d35b24efd65fd03dd1ca130f0" || Number(deployment.blockNumber) !== 2357134) fail("SOURCIFY", "DEPLOYMENT_IDENTITY_MISMATCH");
  return { metadata, std, sourceRows, libraryRows: metadataLibraries, deployment };
}

function selectCompiler(list) {
  if (!list || !Array.isArray(list.builds)) fail("COMPILER", "COMPILER_LIST_INVALID"); const rows = list.builds.filter(row => row.longVersion === VERSION);
  if (rows.length !== 1) fail("COMPILER", "COMPILER_VERSION_SELECTION_FAILED"); const row = rows[0];
  if (!/^solc-windows-amd64-v0\.8\.19\+commit\.7dd6d404\.exe$/.test(row.path || "") || row.version !== "0.8.19" || row.build !== "commit.7dd6d404"
    || !/^0x[0-9a-fA-F]{64}$/.test(row.sha256 || "") || !/^0x[0-9a-fA-F]{64}$/.test(row.keccak256 || "")) fail("COMPILER", "COMPILER_LIST_RECORD_INVALID");
  if (list.releases?.["0.8.19"] !== row.path) fail("COMPILER", "COMPILER_RELEASE_MAP_MISMATCH"); return stable(row);
}
function validateCompilerBytes(bytes, record) {
  if (!Buffer.isBuffer(bytes) || `0x${sha(bytes)}` !== record.sha256.toLowerCase() || keccak256(bytes).toLowerCase() !== record.keccak256.toLowerCase()) fail("COMPILER", "COMPILER_BINARY_HASH_MISMATCH"); return true;
}
function derivedInput(std) {
  const input = JSON.parse(JSON.stringify(std)), required = ["evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "evm.deployedBytecode.immutableReferences"];
  const before = sha(Buffer.from(stableText(std))), current = input.settings.outputSelection || {}, target = current[TARGET_PATH] || {}, selected = new Set(Array.isArray(target[TARGET_NAME]) ? target[TARGET_NAME] : []);
  for (const item of required) selected.add(item); current[TARGET_PATH] = { ...target, [TARGET_NAME]: [...selected].sort() }; input.settings.outputSelection = current;
  return { input, derivation: { kind: "OUTPUT_SELECTION_ADDITION_ONLY", originalInputSha256: before, derivedInputSha256: sha(Buffer.from(stableText(input))), added: required.filter(item => !(target[TARGET_NAME] || []).includes(item)).sort() } };
}
function compileNative(executable, input) {
  const common = { cwd: path.dirname(executable), shell: false, windowsHide: true, env: {}, encoding: "utf8", timeout: LIMITS.compilerMs, maxBuffer: LIMITS.compilerOutputBytes };
  const version = spawnSync(executable, ["--version"], common); if (version.status !== 0 || !new RegExp(`Version: ${VERSION.replace(/[.+]/g, "\\$&")}\\b`).test(version.stdout || "")) fail("COMPILER", "COMPILER_VERSION_MISMATCH");
  const compiled = spawnSync(executable, ["--standard-json"], { ...common, input: JSON.stringify(input) }); if (compiled.status !== 0 || compiled.error) fail("COMPILER", compiled.error?.code === "ETIMEDOUT" ? "COMPILER_TIMEOUT" : "COMPILER_EXECUTION_FAILED");
  return parseJson(Buffer.from(compiled.stdout || ""), "COMPILER_OUTPUT_INVALID");
}
function emptyReferences(value) { return value && typeof value === "object" && Object.keys(value).length === 0 || Array.isArray(value) && value.length === 0; }
function immutableReferences(value) {
  const rows = value?.["477"]; if (!Array.isArray(rows) || Object.keys(value).length !== 1) fail("BUILD", "IMMUTABLE_REFERENCES_MISMATCH");
  const normalized = rows.map(row => ({ start: Number(row.start), length: Number(row.length) })).sort((a, b) => a.start - b.start);
  if (!same(normalized, IMMUTABLE_STARTS.map(start => ({ start, length: 20 })))) fail("BUILD", "IMMUTABLE_REFERENCES_MISMATCH"); return normalized;
}
function transformationRows(section, reason) {
  if (!Array.isArray(section?.transformations)) fail("BUILD", "TRANSFORMATION_MISMATCH"); const values = section.transformationValues || {};
  return section.transformations.filter(row => String(row.reason || row.type || "").toLowerCase().includes(reason)).map(row => ({ id: String(row.id ?? row.offset ?? ""), offset: Number(row.offset),
    value: hex(row.value ?? values[row.id] ?? values[String(row.id)] ?? values[reason === "constructor" ? "constructorArguments" : "477"] ?? "", "TRANSFORMATION_MISMATCH") }));
}
function validateBuild(payload, compiled) {
  const errors = (compiled.errors || []).filter(row => row.severity === "error"); if (errors.length) fail("BUILD", "COMPILER_ERRORS");
  const target = compiled.contracts?.[TARGET_PATH]?.[TARGET_NAME]; if (!target?.evm) fail("BUILD", "COMPILE_TARGET_MISSING");
  const creation = hex(target.evm.bytecode?.object), runtime = hex(target.evm.deployedBytecode?.object), apiCreation = hex(payload.creationBytecode?.recompiledBytecode), apiRuntime = hex(payload.runtimeBytecode?.recompiledBytecode);
  if (creation !== apiCreation) fail("BUILD", "CREATION_TEMPLATE_MISMATCH"); if (runtime !== apiRuntime) fail("BUILD", "RUNTIME_TEMPLATE_MISMATCH");
  if (!emptyReferences(target.evm.bytecode.linkReferences || {}) || !emptyReferences(target.evm.deployedBytecode.linkReferences || {}) || !emptyReferences(payload.creationBytecode.linkReferences || {}) || !emptyReferences(payload.runtimeBytecode.linkReferences || {})) fail("BUILD", "LINK_REFERENCES_PRESENT");
  const refs = immutableReferences(target.evm.deployedBytecode.immutableReferences); if (!same(refs, immutableReferences(payload.runtimeBytecode.immutableReferences))) fail("BUILD", "IMMUTABLE_REFERENCES_MISMATCH");
  const constructorRows = transformationRows(payload.creationBytecode, "constructor"); if (constructorRows.length !== 1 || constructorRows[0].offset !== creation.length / 2 || constructorRows[0].value !== ADMIN_WORD) fail("BUILD", "CONSTRUCTOR_TRANSFORMATION_MISMATCH");
  const creationOnchain = `${creation}${ADMIN_WORD}`; if (creationOnchain !== hex(payload.creationBytecode.onchainBytecode)) fail("BUILD", "CREATION_RECONSTRUCTION_MISMATCH");
  const immutableRows = transformationRows(payload.runtimeBytecode, "immutable").sort((a, b) => a.offset - b.offset);
  if (immutableRows.length !== 6 || immutableRows.some((row, index) => row.id !== "477" || row.offset !== IMMUTABLE_STARTS[index] || row.value !== ADMIN.slice(2))) fail("BUILD", "IMMUTABLE_TRANSFORMATION_MISMATCH");
  const bytes = Buffer.from(runtime, "hex"); for (const start of IMMUTABLE_STARTS) Buffer.from(ADMIN.slice(2), "hex").copy(bytes, start);
  const runtimeOnchain = bytes.toString("hex"); if (runtimeOnchain !== hex(payload.runtimeBytecode.onchainBytecode)) fail("BUILD", "RUNTIME_RECONSTRUCTION_MISMATCH");
  return { creation: `0x${creationOnchain}`, runtime: `0x${runtimeOnchain}`, runtimeBytes: bytes.length, runtimeSha256: sha(bytes), runtimeKeccak256: keccak256(bytes), immutableReferences: refs };
}

function compilerIdentity(executable, bytes, record) {
  const stat = fs.lstatSync(executable); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length) fail("FILESYSTEM", "COMPILER_FILE_IDENTITY_INVALID");
  return { path: "toolchain/solc-0.8.19.exe", bytes: bytes.length, sha256: sha(bytes), keccak256: keccak256(bytes), version: VERSION, officialPath: record.path };
}
function writeFile(root, relative, bytes) { const file = path.join(root, ...relative.split("/")); if (!path.resolve(file).startsWith(`${path.resolve(root)}${path.sep}`)) fail("FILESYSTEM", "OUTPUT_PATH_ESCAPE"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: "wx" }); }
function finishBundle(stage, bundle, compilerBytes, compilerRecord) {
  writeFile(stage, "sourcify-response.json", stableText(bundle.payload)); writeFile(stage, "standard-input.json", stableText(bundle.input)); writeFile(stage, "standard-output.json", stableText(bundle.output));
  for (const row of bundle.sourceRows) writeFile(stage, `sources/${row.path}`, row.content); writeFile(stage, "runtime.hex", `${bundle.build.runtime}\n`); writeFile(stage, "creation.hex", `${bundle.build.creation}\n`);
  writeFile(stage, "compiler-list-record.json", stableText({ listSha256: bundle.listSha256, selected: compilerRecord })); writeFile(stage, "toolchain/identity.json", stableText(bundle.compiler)); writeFile(stage, "authority.json", stableText(bundle.authority));
}

async function recover(options = {}) {
  const output = options.output || OUTPUT, exists = options.exists || fs.existsSync; if (exists(output)) fail("OUTPUT", "OUTPUT_EXISTS_NO_OVERWRITE"); const budget = newBudget(), transport = options.transport || nativeFetch;
  let stage = null;
  try {
    const sourcifyBytes = await fetchBounded(REQUESTS[0], budget, transport), payload = parseJson(sourcifyBytes, "SOURCIFY_JSON_INVALID"), validated = validateSourcify(payload);
    const listBytes = await fetchBounded(REQUESTS[1], budget, transport), list = parseJson(listBytes, "COMPILER_LIST_JSON_INVALID"), record = selectCompiler(list), compilerSpec = requestPlan(record.path)[2];
    const compilerBytes = await fetchBounded(compilerSpec, budget, transport); validateCompilerBytes(compilerBytes, record); const derived = derivedInput(validated.std);
    let compiled, compiler;
    if (options.stageAdapter) {
      const prepared = options.stageAdapter.prepare(compilerBytes, record); stage = prepared.stage; compiler = prepared.identity;
      compiled = (options.compilerRunner || compileNative)(prepared.executable, derived.input, { shell: false, env: {}, argv: ["--standard-json"] });
    }
    else if (options.compilerRunner) { compiled = options.compilerRunner(null, derived.input, { shell: false, env: {}, argv: ["--standard-json"] }); compiler = { path: "toolchain/solc-0.8.19.exe", bytes: compilerBytes.length, sha256: sha(compilerBytes), keccak256: keccak256(compilerBytes), version: VERSION, officialPath: record.path }; }
    else {
      const parent = path.dirname(output); fs.mkdirSync(parent, { recursive: true }); stage = path.join(parent, `.pool-proxy-authority-stage-${process.pid}-${crypto.randomBytes(8).toString("hex")}`); fs.mkdirSync(stage, { recursive: false });
      const executable = path.join(stage, "toolchain", "solc-0.8.19.exe"); fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, compilerBytes, { flag: "wx" }); compiler = compilerIdentity(executable, compilerBytes, record); compiled = compileNative(executable, derived.input);
    }
    const build = validateBuild(payload, compiled), authority = { schema: "base-paper-usdplus-aave-pool-proxy-source-authority/v16", classification: "EXACT_AAVE_POOL_PROXY_SOURCE_BUILD_RUNTIME_BOUND", generatedAt: new Date().toISOString(),
      chainId: 8453, address: TARGET_ADDRESS, sourcifyMatchId: 3701250, sourceCount: validated.sourceRows.length, libraryCount: validated.libraryRows.length, compilerVersion: VERSION,
      compiler, requests: { count: budget.requests, bytes: budget.bytes, responses: budget.responses, caps: LIMITS }, deployment: { transactionHash: validated.deployment.transactionHash.toLowerCase(), blockNumber: Number(validated.deployment.blockNumber) },
      admin: ADMIN, constructorArgument: `0x${ADMIN_WORD}`, immutableId: "477", immutableLocations: build.immutableReferences, runtime: { bytes: build.runtimeBytes, sha256: build.runtimeSha256, keccak256: build.runtimeKeccak256, file: "runtime.hex" },
      inputDerivation: derived.derivation, exactLimitations: { currentOnchainCodeClaim: false, freshStateClaim: false, repositoryCommitKnown: false, repositoryCommitAttributionClaim: false,
        sourceAuthority: "SOURCIFY_EXACT_MATCH_AND_LOCAL_RECOMPILATION", externalDeploymentContextSelfAttested: false }, completedAt: new Date().toISOString() };
    const bundle = { payload, input: derived.input, output: compiled, sourceRows: validated.sourceRows, listSha256: sha(listBytes), compiler, build, authority };
    if (options.stageAdapter) { options.stageAdapter.publish(stage, bundle, compilerBytes, record); stage = null; }
    else if (options.publisher) options.publisher(bundle, compilerBytes, record); else { finishBundle(stage, bundle, compilerBytes, record); fs.renameSync(stage, output); stage = null; }
    return bundle;
  } catch (error) { if (stage) { try { if (options.stageAdapter) options.stageAdapter.cleanup(stage); else fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {} } throw error; }
}
async function runCli(argv) {
  try { parseCli(argv); const result = await recover(); process.stdout.write(`${JSON.stringify({ classification: result.authority.classification, requests: result.authority.requests, runtime: result.authority.runtime, sourceCount: result.authority.sourceCount, compilerVersion: result.authority.compilerVersion })}\n`); }
  catch (error) { const known = error instanceof AuthorityError ? error : new AuthorityError("UNCLASSIFIED", "UNEXPECTED_FAILURE"); process.stderr.write(`${JSON.stringify({ classification: "INCOMPLETE", stage: known.stage, code: known.code })}\n`); process.exitCode = 2; }
}

module.exports = { ADMIN, ADMIN_WORD, AuthorityError, EXPECTED_LIBRARY_NAMES, IMMUTABLE_STARTS, LIMITS, OUTPUT, REQUESTS, SOURCES, TARGET, TARGET_ADDRESS, VERSION, compileNative, derivedInput,
  fetchBounded, hex, immutableReferences, nativeFetch, newBudget, normalizeLibraries, parseCli, recover, requestPlan, safeSourcePath, selectCompiler, stableText, transformationRows,
  validateBuild, validateCompilerBytes, validateRequest, validateSettings, validateSourcify };
if (require.main === module) runCli(process.argv.slice(2));
