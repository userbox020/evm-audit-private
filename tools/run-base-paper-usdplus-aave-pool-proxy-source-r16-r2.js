"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { keccak256, toUtf8Bytes } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r16/pool-proxy-authority-r2");
const COMMAND = "node tools/run-base-paper-usdplus-aave-pool-proxy-source-r16-r2.js --once";
const TARGET_ADDRESS = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const ADMIN = "0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d";
const ADMIN_WORD = `000000000000000000000000${ADMIN.slice(2)}`;
const ADMIN_WORD_HEX = `0x${ADMIN_WORD}`;
const TARGET = "src/core/contracts/protocol/libraries/aave-upgradeability/InitializableImmutableAdminUpgradeabilityProxy.sol:InitializableImmutableAdminUpgradeabilityProxy";
const [TARGET_PATH, TARGET_NAME] = TARGET.split(":");
const VERSION = "0.8.19+commit.7dd6d404";
const COMPILER_PIN = Object.freeze({
  filename: "solc-windows-amd64-v0.8.19+commit.7dd6d404.exe",
  bytes: 9150464,
  sha256: "00d3b5ca64b097964ed6d70d9805a63fdd27113b07c1b2559dbfdd579f994508",
  keccak256: "da3dcff0fe9e3297d99ec184afab49b0eb0a95ce88ef3f44587618445cbe6546",
  version: "0.8.19",
  build: "commit.7dd6d404",
  longVersion: VERSION,
});
const LINEAGE = Object.freeze({
  r1CurrentPostFailureRunnerSha256: "533f7b2368531f96539133883217bcc26b08d1fcee6be570ca46670c799ea9a4",
  r1CurrentTestsSha256: "2fd9ba17abfe5ae1108e6374f98ea0944187adb3e17f81ca48e21d1198c8ea04",
  p0AnchorSha256: "59dea96628ff46542b92ab6793244904740881489943321911345db1551ef221",
  r1Provenance: Object.freeze({
    externallyObservedSourceRecoveryResult: "COMPILATION_TARGET_MISMATCH",
    executedPreCorrectionRunnerBytes: null,
    executedPreCorrectionRunnerSha256: null,
    executedPreCorrectionIdentityInferred: false,
    currentR1CorrectedAfterConsumedAttempt: true,
    currentR1IsExecutedByteIdentity: false,
    didNotOccur: Object.freeze(["compiler download", "compiler execution", "compilation", "authority artifact", "RPC", "fork"]),
  }),
});
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
const EXPECTED_LIBRARY_IDENTITIES = Object.freeze(EXPECTED_LIBRARY_NAMES.map(name => `src/core/contracts/protocol/libraries/logic/${name}.sol:${name}`));
const METADATA_SETTING_KEYS = Object.freeze(["compilationTarget", "evmVersion", "libraries", "metadata", "optimizer", "remappings"]);
const COMPILER_SETTING_KEYS = Object.freeze(["evmVersion", "libraries", "metadata", "optimizer", "remappings"]);
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
function pinFor(options) { if (options.testPinOverride && options.allowTestOverrides !== true) fail("CONFIG", "TEST_OVERRIDE_NOT_ALLOWED"); return options.testPinOverride || COMPILER_PIN; }
function requestPlan(compilerPath = COMPILER_PIN.filename) {
  return [...REQUESTS, Object.freeze({ origin: "https://binaries.soliditylang.org", hostname: "binaries.soliditylang.org", path: `/windows-amd64/${compilerPath}`, method: "GET", accept: "application/octet-stream", kind: "binary" })];
}
function newBudget() { return { requests: 0, bytes: 0, responses: [] }; }
function validateRequest(spec) {
  if (!spec || spec.method !== "GET" || !["sourcify.dev", "binaries.soliditylang.org"].includes(spec.hostname) || spec.origin !== `https://${spec.hostname}`
    || typeof spec.path !== "string" || spec.path.includes("\\") || !spec.path.startsWith("/") || !["application/json", "application/octet-stream"].includes(spec.accept)) fail("REQUEST", "REQUEST_NOT_ALLOWED");
  if (spec.hostname === "sourcify.dev" && spec.path !== REQUESTS[0].path) fail("REQUEST", "REQUEST_PATH_INVALID");
  if (spec.hostname === "binaries.soliditylang.org" && spec.path !== REQUESTS[1].path && spec.path !== `/windows-amd64/${COMPILER_PIN.filename}`) fail("REQUEST", "REQUEST_PATH_INVALID");
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
      const type = String(response.headers["content-type"] || "").toLowerCase(), valid = spec.kind === "json" ? /^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/.test(type) : /^(?:application\/octet-stream|application\/x-msdownload|binary\/octet-stream)(?:;|$)/.test(type);
      if (!valid) { response.resume(); done(new AuthorityError("REQUEST", "CONTENT_TYPE_INVALID")); return; }
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
function safeRelativePath(value, code = "SOURCE_PATH_INVALID") {
  if (typeof value !== "string" || value.includes("\\") || path.posix.isAbsolute(value) || value.split("/").some(segment => !segment || segment === "." || segment === "..")) fail("VALIDATION", code); return value;
}
const safeSourcePath = value => safeRelativePath(value, "SOURCE_PATH_INVALID");
function parseMetadata(value) { if (typeof value === "string") return parseJson(Buffer.from(value), "METADATA_INVALID"); if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION", "METADATA_INVALID"); return value; }
function splitFullyQualifiedName(value, errorCode = "FULLY_QUALIFIED_NAME_INVALID") {
  if (typeof value !== "string") fail("VALIDATION", errorCode); const colon = value.lastIndexOf(":");
  if (colon <= 0 || colon === value.length - 1) fail("VALIDATION", errorCode); const source = value.slice(0, colon), name = value.slice(colon + 1);
  if (!source || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) fail("VALIDATION", errorCode); return { source, name, identity: `${source}:${name}` };
}
function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !same(Object.keys(value).sort(), [...expected].sort())) fail("VALIDATION", code); return value;
}
function canonicalLibraryRows(rows, code) {
  const seen = new Set(); for (const row of rows) { if (seen.has(row.identity)) fail("VALIDATION", "LIBRARY_IDENTITY_DUPLICATE"); seen.add(row.identity); }
  rows.sort((a, b) => a.identity.localeCompare(b.identity)); if (!same(rows.map(row => row.identity), [...EXPECTED_LIBRARY_IDENTITIES].sort())) fail("VALIDATION", code); return rows;
}
function normalizeMetadataLibraries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION", "METADATA_LIBRARY_MAP_INVALID"); const rows = [];
  for (const [qualified, rawAddress] of Object.entries(value)) { const parsed = splitFullyQualifiedName(qualified, "METADATA_LIBRARY_KEY_INVALID"), resolved = address(rawAddress);
    if (typeof rawAddress !== "string" || !resolved) fail("VALIDATION", "METADATA_LIBRARY_VALUE_INVALID"); rows.push({ ...parsed, address: resolved }); }
  return canonicalLibraryRows(rows, "LIBRARY_IDENTITY_SET_MISMATCH");
}
function normalizeNestedLibraries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION", "NESTED_LIBRARY_MAP_INVALID"); const rows = [];
  for (const [source, libraries] of Object.entries(value)) { if (typeof source !== "string" || source.length === 0 || !libraries || typeof libraries !== "object" || Array.isArray(libraries) || Object.keys(libraries).length === 0) fail("VALIDATION", "NESTED_LIBRARY_SOURCE_INVALID");
    for (const [name, rawAddress] of Object.entries(libraries)) { if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || typeof rawAddress !== "string") fail("VALIDATION", "NESTED_LIBRARY_LEAF_INVALID"); const resolved = address(rawAddress); if (!resolved) fail("VALIDATION", "NESTED_LIBRARY_ADDRESS_INVALID"); rows.push({ source, name, identity: `${source}:${name}`, address: resolved }); } }
  return canonicalLibraryRows(rows, "LIBRARY_IDENTITY_SET_MISMATCH");
}
function validateOrdinarySettings(settings) {
  if (settings.evmVersion !== "paris" || settings.optimizer?.enabled !== true || settings.optimizer?.runs !== 200 || settings.metadata?.bytecodeHash !== "ipfs" || !Array.isArray(settings.remappings)) fail("VALIDATION", "COMPILER_SETTINGS_MISMATCH");
}
function validateMetadataSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || !Object.prototype.hasOwnProperty.call(settings, "compilationTarget")) fail("VALIDATION", "COMPILATION_TARGET_MISMATCH");
  exactKeys(settings, METADATA_SETTING_KEYS, "METADATA_SETTINGS_KEYS_MISMATCH"); validateOrdinarySettings(settings);
  if (!same(settings.compilationTarget, { [TARGET_PATH]: TARGET_NAME })) fail("VALIDATION", "COMPILATION_TARGET_MISMATCH"); return normalizeMetadataLibraries(settings.libraries);
}
function validateCompilerSettings(settings, location) {
  if (settings && typeof settings === "object" && Object.prototype.hasOwnProperty.call(settings, "compilationTarget")) fail("VALIDATION", `${location}_COMPILATION_TARGET_PRESENT`);
  exactKeys(settings, COMPILER_SETTING_KEYS, `${location}_SETTINGS_KEYS_MISMATCH`); validateOrdinarySettings(settings); return normalizeNestedLibraries(settings.libraries);
}
function ordinarySettings(settings) { return { evmVersion: settings.evmVersion, metadata: settings.metadata, optimizer: settings.optimizer, remappings: settings.remappings }; }
function canonicalCompilerSettings(settings, libraries) { return { ...ordinarySettings(settings), libraries }; }
function validateSourcify(payload) {
  if (!payload || Number(payload.chainId) !== 8453 || address(payload.address) !== TARGET_ADDRESS) fail("SOURCIFY", "CHAIN_OR_ADDRESS_MISMATCH");
  if (payload.match !== "exact_match" || payload.creationMatch !== "exact_match" || payload.runtimeMatch !== "exact_match") fail("SOURCIFY", "EXACT_MATCH_REQUIRED");
  if (Number(payload.matchId) !== 3701250) fail("SOURCIFY", "MATCH_ID_MISMATCH");
  const metadata = parseMetadata(payload.metadata), std = payload.stdJsonInput, compilation = payload.compilation;
  if (!std || std.language !== "Solidity" || !compilation || compilation.language !== "Solidity" || !["solc", "Solidity"].includes(compilation.compiler) || compilation.compilerVersion !== VERSION) fail("SOURCIFY", "COMPILER_IDENTITY_MISMATCH");
  if (metadata.compiler?.version !== VERSION) fail("SOURCIFY", "METADATA_COMPILER_VERSION_MISMATCH"); const qualifiedTarget = splitFullyQualifiedName(compilation.fullyQualifiedName, "COMPILATION_TARGET_MISMATCH");
  if (qualifiedTarget.source !== TARGET_PATH || qualifiedTarget.name !== TARGET_NAME) fail("SOURCIFY", "COMPILATION_TARGET_MISMATCH");
  const metadataLibraries = validateMetadataSettings(metadata.settings), stdLibraries = validateCompilerSettings(std.settings, "STD_INPUT"), compilationLibraries = validateCompilerSettings(compilation.compilerSettings, "COMPILATION");
  if (!same(canonicalCompilerSettings(std.settings, stdLibraries), canonicalCompilerSettings(compilation.compilerSettings, compilationLibraries))) fail("SOURCIFY", "COMPILER_SETTINGS_DISAGREEMENT");
  if (!same(ordinarySettings(metadata.settings), ordinarySettings(std.settings))) fail("SOURCIFY", "ORDINARY_SETTINGS_DISAGREEMENT");
  if (!same(metadataLibraries, stdLibraries) || !same(stdLibraries, compilationLibraries)) fail("SOURCIFY", "LIBRARY_MAP_DISAGREEMENT");
  const keys = Object.keys(payload.sources || {}), stdKeys = Object.keys(std.sources || {}), metadataKeys = Object.keys(metadata.sources || {}), expected = [...SOURCES].sort();
  for (const value of [...keys, ...stdKeys, ...metadataKeys]) safeSourcePath(value);
  if (!same([...keys].sort(), expected) || !same([...stdKeys].sort(), expected) || !same([...metadataKeys].sort(), expected) || new Set(keys.map(key => key.toLowerCase())).size !== keys.length) fail("SOURCIFY", "SOURCE_SET_MISMATCH");
  const sourceRows = [];
  for (const sourcePath of SOURCES) { const content = payload.sources[sourcePath]?.content, stdContent = std.sources[sourcePath]?.content, expectedHash = metadata.sources[sourcePath]?.keccak256;
    if (typeof content !== "string" || content !== stdContent || typeof expectedHash !== "string" || keccak256(toUtf8Bytes(content)).toLowerCase() !== expectedHash.toLowerCase()) fail("SOURCIFY", "SOURCE_CONTENT_OR_HASH_MISMATCH");
    const bytes = Buffer.from(content, "utf8"); sourceRows.push({ path: sourcePath, bytes: bytes.length, sha256: sha(bytes), keccak256: keccak256(bytes), content }); }
  const constructor = hex(payload.constructorArgs || payload.creationBytecode?.transformationValues?.constructorArguments || "", "CONSTRUCTOR_ARGUMENT_MISMATCH"); if (constructor !== ADMIN_WORD) fail("SOURCIFY", "CONSTRUCTOR_ARGUMENT_MISMATCH");
  const deployment = payload.deployment || {}; if (String(deployment.transactionHash || "").toLowerCase() !== "0x65ada47b1e29db97b062d601cc2d3d4ba3b4ce8d35b24efd65fd03dd1ca130f0" || Number(deployment.blockNumber) !== 2357134) fail("SOURCIFY", "DEPLOYMENT_IDENTITY_MISMATCH");
  return { metadata, std, sourceRows, libraryRows: metadataLibraries, deployment };
}

function selectCompiler(list, pin = COMPILER_PIN) {
  if (!list || !Array.isArray(list.builds)) fail("COMPILER", "COMPILER_LIST_INVALID"); const rows = list.builds.filter(row => row.longVersion === pin.longVersion); if (rows.length !== 1) fail("COMPILER", "COMPILER_VERSION_SELECTION_FAILED"); const row = rows[0];
  if (row.path !== pin.filename || row.version !== pin.version || row.build !== pin.build || String(row.sha256 || "").toLowerCase() !== `0x${pin.sha256}` || String(row.keccak256 || "").toLowerCase() !== `0x${pin.keccak256}`) fail("COMPILER", "COMPILER_LIST_PIN_MISMATCH");
  if (list.releases?.[pin.version] !== pin.filename) fail("COMPILER", "COMPILER_RELEASE_MAP_MISMATCH"); return stable(row);
}
function validateCompilerBytes(bytes, record, pin = COMPILER_PIN) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== pin.bytes || sha(bytes) !== pin.sha256 || keccak256(bytes).slice(2).toLowerCase() !== pin.keccak256
    || String(record.sha256).toLowerCase() !== `0x${pin.sha256}` || String(record.keccak256).toLowerCase() !== `0x${pin.keccak256}`) fail("COMPILER", "COMPILER_BINARY_PIN_MISMATCH"); return true;
}
function derivedInput(std) {
  if (std?.settings?.compilationTarget !== undefined) fail("VALIDATION", "STD_INPUT_COMPILATION_TARGET_PRESENT");
  const input = clone(std), required = ["evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "evm.deployedBytecode.immutableReferences"];
  const before = sha(Buffer.from(stableText(std))), current = input.settings.outputSelection || {}, target = current[TARGET_PATH] || {}, existing = Array.isArray(target[TARGET_NAME]) ? target[TARGET_NAME] : [], selected = new Set(existing);
  for (const item of required) selected.add(item); current[TARGET_PATH] = { ...target, [TARGET_NAME]: [...selected].sort() }; input.settings.outputSelection = current;
  if (input.settings.compilationTarget !== undefined) fail("VALIDATION", "DERIVED_INPUT_COMPILATION_TARGET_PRESENT");
  return { input, derivation: { kind: "OUTPUT_SELECTION_ADDITION_ONLY", originalInputSha256: before, derivedInputSha256: sha(Buffer.from(stableText(input))), added: required.filter(item => !existing.includes(item)).sort() } };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function compileNative(executable, input) {
  const common = { cwd: path.dirname(executable), shell: false, windowsHide: true, env: {}, encoding: "utf8", timeout: LIMITS.compilerMs, maxBuffer: LIMITS.compilerOutputBytes };
  const version = spawnSync(executable, ["--version"], common); if (version.status !== 0 || version.error || !new RegExp(`Version: ${VERSION.replace(/[.+]/g, "\\$&")}\\b`).test(version.stdout || "")) fail("COMPILER", "COMPILER_VERSION_MISMATCH");
  const compiled = spawnSync(executable, ["--standard-json"], { ...common, input: JSON.stringify(input) }); if (compiled.status !== 0 || compiled.error) fail("COMPILER", compiled.error?.code === "ETIMEDOUT" ? "COMPILER_TIMEOUT" : "COMPILER_EXECUTION_FAILED");
  return parseJson(Buffer.from(compiled.stdout || ""), "COMPILER_OUTPUT_INVALID");
}
function emptyReferences(value) { return value && typeof value === "object" && Object.keys(value).length === 0 || Array.isArray(value) && value.length === 0; }
function immutableReferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value["477"])) fail("BUILD", "IMMUTABLE_REFERENCES_MISMATCH");
  const rows = value["477"].map(row => ({ start: Number(row?.start), length: Number(row?.length) })), expected = IMMUTABLE_STARTS.map(start => ({ start, length: 32 }));
  if (!same(rows, expected)) fail("BUILD", "IMMUTABLE_REFERENCES_MISMATCH"); return rows;
}
function immutableWord(section) {
  const values = section?.transformationValues;
  if (!values || typeof values !== "object" || Array.isArray(values) || Object.prototype.hasOwnProperty.call(values, "477") || !values.immutables || typeof values.immutables !== "object" || Array.isArray(values.immutables)
    || Object.keys(values.immutables).length !== 1 || !Object.prototype.hasOwnProperty.call(values.immutables, "477")) fail("BUILD", "IMMUTABLE_VALUE_SHAPE_MISMATCH");
  const value = hex(values.immutables["477"], "IMMUTABLE_VALUE_MISMATCH"); if (value !== ADMIN_WORD) fail("BUILD", "IMMUTABLE_VALUE_MISMATCH"); return Buffer.from(value, "hex");
}
function validateImmutableTransformations(section) {
  if (section.transformations === undefined) return;
  const expected = IMMUTABLE_STARTS.map(offset => ({ id: "477", type: "replace", offset, reason: "immutable" })); if (!same(section.transformations, expected)) fail("BUILD", "IMMUTABLE_TRANSFORMATION_MISMATCH");
}
function validateBuild(payload, compiled) {
  const errors = (compiled.errors || []).filter(row => row.severity === "error"); if (errors.length) fail("BUILD", "COMPILER_ERRORS");
  const target = compiled.contracts?.[TARGET_PATH]?.[TARGET_NAME]; if (!target?.evm) fail("BUILD", "COMPILE_TARGET_MISSING");
  const creationTemplate = hex(target.evm.bytecode?.object), runtimeTemplate = hex(target.evm.deployedBytecode?.object), apiCreation = hex(payload.creationBytecode?.recompiledBytecode), apiRuntime = hex(payload.runtimeBytecode?.recompiledBytecode);
  if (creationTemplate !== apiCreation) fail("BUILD", "CREATION_TEMPLATE_MISMATCH"); if (runtimeTemplate !== apiRuntime) fail("BUILD", "RUNTIME_TEMPLATE_MISMATCH");
  if (!emptyReferences(target.evm.bytecode.linkReferences || {}) || !emptyReferences(target.evm.deployedBytecode.linkReferences || {}) || !emptyReferences(payload.creationBytecode.linkReferences || {}) || !emptyReferences(payload.runtimeBytecode.linkReferences || {})) fail("BUILD", "LINK_REFERENCES_PRESENT");
  const refs = immutableReferences(target.evm.deployedBytecode.immutableReferences); if (!same(refs, immutableReferences(payload.runtimeBytecode.immutableReferences))) fail("BUILD", "IMMUTABLE_REFERENCES_MISMATCH");
  const constructorTransformations = payload.creationBytecode?.transformations, constructorRow = Array.isArray(constructorTransformations) && constructorTransformations.length === 1 ? constructorTransformations[0] : null;
  if (!constructorRow || constructorRow.type !== "insert" || constructorRow.reason !== "constructorArguments" || Number(constructorRow.offset) !== creationTemplate.length / 2
    || (constructorRow.id !== undefined && constructorRow.id !== "constructorArguments") || hex(payload.creationBytecode?.transformationValues?.constructorArguments || "", "CONSTRUCTOR_TRANSFORMATION_MISMATCH") !== ADMIN_WORD) fail("BUILD", "CONSTRUCTOR_TRANSFORMATION_MISMATCH");
  const creation = `${creationTemplate}${ADMIN_WORD}`; if (creation !== hex(payload.creationBytecode.onchainBytecode)) fail("BUILD", "CREATION_RECONSTRUCTION_MISMATCH");
  const word = immutableWord(payload.runtimeBytecode); validateImmutableTransformations(payload.runtimeBytecode); const runtimeBytes = Buffer.from(runtimeTemplate, "hex");
  for (const start of IMMUTABLE_STARTS) { if (start + word.length > runtimeBytes.length) fail("BUILD", "IMMUTABLE_RANGE_INVALID"); word.copy(runtimeBytes, start); }
  const runtime = runtimeBytes.toString("hex"); if (runtime !== hex(payload.runtimeBytecode.onchainBytecode)) fail("BUILD", "RUNTIME_RECONSTRUCTION_MISMATCH");
  return { creationTemplate: `0x${creationTemplate}`, runtimeTemplate: `0x${runtimeTemplate}`, creation: `0x${creation}`, runtime: `0x${runtime}`, runtimeBytes: runtimeBytes.length, runtimeSha256: sha(runtimeBytes), runtimeKeccak256: keccak256(runtimeBytes), immutableReferences: refs };
}

function compilerIdentity(bytes, record, pin) { return { path: `toolchain/${pin.filename}`, bytes: bytes.length, sha256: sha(bytes), keccak256: keccak256(bytes), version: VERSION, officialPath: record.path }; }
function artifactPath(value) { return safeRelativePath(value, "ARTIFACT_PATH_INVALID"); }
function artifactInventory(artifacts) {
  const seen = new Set(); return [...artifacts.entries()].map(([relative, bytes]) => { artifactPath(relative); const folded = relative.toLowerCase(); if (seen.has(folded) || !Buffer.isBuffer(bytes)) fail("BUNDLE", "ARTIFACT_INVENTORY_INVALID"); seen.add(folded); return { path: relative, bytes: bytes.length, sha256: sha(bytes) }; }).sort((a, b) => a.path.localeCompare(b.path));
}
function validateInventory(inventory, artifacts) {
  if (!Array.isArray(inventory) || inventory.length !== artifacts.size) fail("BUNDLE", "ARTIFACT_INVENTORY_INVALID"); const expected = artifactInventory(artifacts); if (!same(inventory, expected)) fail("BUNDLE", "ARTIFACT_INVENTORY_INVALID"); return true;
}
function makeArtifacts(context) {
  const artifacts = new Map(), add = (relative, bytes) => { artifactPath(relative); if (artifacts.has(relative) || [...artifacts.keys()].some(key => key.toLowerCase() === relative.toLowerCase())) fail("BUNDLE", "ARTIFACT_DUPLICATE"); artifacts.set(relative, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); };
  add("sourcify-response.json", context.sourcifyBytes); add("metadata.json", stableText(context.validated.metadata)); add("fetched-standard-input.json", stableText(context.validated.std)); add("derived-compiler-input.json", stableText(context.derived.input));
  add("compiler-list.json", context.listBytes); add("compiler-build-record.json", stableText(context.record)); add("compiler-output.json", stableText(context.compiled));
  add("compiled-creation-template.hex", `${context.build.creationTemplate}\n`); add("compiled-runtime-template.hex", `${context.build.runtimeTemplate}\n`); add("reconstructed-creation.hex", `${context.build.creation}\n`); add("reconstructed-runtime.hex", `${context.build.runtime}\n`);
  for (const row of context.validated.sourceRows) add(`sources/${row.path}`, Buffer.from(row.content, "utf8")); add(context.compiler.path, context.compilerBytes); add("toolchain/identity.json", stableText(context.compiler)); return artifacts;
}
function writeOwned(stage, relative, bytes, fault) {
  artifactPath(relative); if (fault?.writeRelative === relative) fail("FILESYSTEM", "INJECTED_WRITE_FAILURE"); const file = path.join(stage, ...relative.split("/")), resolved = path.resolve(file), root = `${path.resolve(stage)}${path.sep}`;
  if (!resolved.startsWith(root)) fail("FILESYSTEM", "OUTPUT_PATH_ESCAPE"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: "wx" });
}
function createStage(output, compilerBytes, compiler, options) {
  const parent = path.dirname(output); fs.mkdirSync(parent, { recursive: true }); const stage = options.testStagePath || path.join(parent, `.pool-proxy-authority-r2-stage-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  try { fs.mkdirSync(stage, { recursive: false }); } catch (error) { if (error?.code === "EEXIST") fail("FILESYSTEM", "STAGE_COLLISION"); throw error; }
  try { writeOwned(stage, compiler.path, compilerBytes, options.testFault); } catch (error) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {} throw error; } return stage;
}
function publish(stage, output, artifacts, authority, options) {
  const compilerPath = authority.compiler.path;
  for (const [relative, bytes] of artifacts) { if (relative === compilerPath) { const actual = fs.readFileSync(path.join(stage, ...relative.split("/"))); if (!actual.equals(bytes)) fail("FILESYSTEM", "STAGED_COMPILER_CHANGED"); } else writeOwned(stage, relative, bytes, options.testFault); }
  validateInventory(authority.artifacts, artifacts); writeOwned(stage, "authority.json", stableText(authority), options.testFault);
  if (options.testFault?.beforeRename) options.testFault.beforeRename(output); if (fs.existsSync(output)) fail("OUTPUT", "OUTPUT_EXISTS_NO_OVERWRITE"); if (options.testFault?.rename) fail("FILESYSTEM", "INJECTED_RENAME_FAILURE"); fs.renameSync(stage, output);
}

async function recover(options = {}) {
  const output = options.output || OUTPUT; if (output !== OUTPUT && options.allowTestOverrides !== true) fail("CONFIG", "OUTPUT_OVERRIDE_NOT_ALLOWED"); if (fs.existsSync(output)) fail("OUTPUT", "OUTPUT_EXISTS_NO_OVERWRITE");
  const pin = pinFor(options), budget = newBudget(), transport = options.transport || nativeFetch; let stage = null, stageCreated = false;
  try {
    const sourcifyBytes = await fetchBounded(REQUESTS[0], budget, transport), payload = parseJson(sourcifyBytes, "SOURCIFY_JSON_INVALID"), validated = validateSourcify(payload);
    const listBytes = await fetchBounded(REQUESTS[1], budget, transport), list = parseJson(listBytes, "COMPILER_LIST_JSON_INVALID"), record = selectCompiler(list, pin);
    const compilerSpec = requestPlan(record.path)[2]; if (record.path !== COMPILER_PIN.filename && options.allowTestOverrides !== true) fail("COMPILER", "COMPILER_PATH_NOT_ALLOWED");
    const compilerBytes = await fetchBounded(compilerSpec, budget, transport); validateCompilerBytes(compilerBytes, record, pin); const derived = derivedInput(validated.std), compiler = compilerIdentity(compilerBytes, record, pin);
    stage = createStage(output, compilerBytes, compiler, options); stageCreated = true;
    const safety = { versionArgv: ["--version"], compileArgv: ["--standard-json"], shell: false, env: {} }, compiled = (options.compilerRunner || compileNative)(path.join(stage, ...compiler.path.split("/")), derived.input, safety);
    const build = validateBuild(payload, compiled), context = { sourcifyBytes, listBytes, payload, validated, record, compilerBytes, compiler, derived, compiled, build }, artifacts = makeArtifacts(context);
    const authority = { schema: "base-paper-usdplus-aave-pool-proxy-source-authority/v16-r2", classification: "EXACT_AAVE_POOL_PROXY_SOURCE_BUILD_RUNTIME_BOUND_CANDIDATE", command: COMMAND, generatedAt: new Date().toISOString(), chainId: 8453, address: TARGET_ADDRESS,
      sourcifyMatchId: 3701250, sourceCount: validated.sourceRows.length, libraryCount: validated.libraryRows.length, compilerVersion: VERSION, compiler, compilerPin: { ...COMPILER_PIN, provenance: "hard-coded reviewed independent pin", listIsPinAuthority: false, signatureVerified: false, independentPublisherAttestation: false },
      requests: { count: budget.requests, bytes: budget.bytes, responses: budget.responses, caps: LIMITS }, deployment: { transactionHash: validated.deployment.transactionHash.toLowerCase(), blockNumber: Number(validated.deployment.blockNumber) }, admin: ADMIN, constructorArgument: ADMIN_WORD_HEX,
      immutableId: "477", immutableWord: ADMIN_WORD_HEX, immutableLocations: build.immutableReferences, runtime: { bytes: build.runtimeBytes, sha256: build.runtimeSha256, keccak256: build.runtimeKeccak256, file: "reconstructed-runtime.hex" }, inputDerivation: derived.derivation,
      sources: validated.sourceRows.map(row => ({ path: row.path, bytes: row.bytes, sha256: row.sha256, keccak256: row.keccak256 })), lineage: clone(LINEAGE), limitations: { historicalPublicSourceBuildOnly: true, liveCodeCompared: false, freshStateEstablished: false, repositoryCommitKnown: false }, artifacts: artifactInventory(artifacts), completedAt: new Date().toISOString() };
    validateInventory(authority.artifacts, artifacts); publish(stage, output, artifacts, authority, options); stageCreated = false; stage = null; return { authority, artifacts };
  } catch (error) { if (stageCreated && stage) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {} } throw error; }
}
async function runCli(argv) {
  try { parseCli(argv); const result = await recover(); process.stdout.write(`${JSON.stringify({ classification: result.authority.classification, requests: result.authority.requests, runtime: result.authority.runtime, sourceCount: result.authority.sourceCount, compilerVersion: result.authority.compilerVersion })}\n`); }
  catch (error) { const known = error instanceof AuthorityError ? error : new AuthorityError("UNCLASSIFIED", "UNEXPECTED_FAILURE"); process.stderr.write(`${JSON.stringify({ classification: "INCOMPLETE", stage: known.stage, code: known.code })}\n`); process.exitCode = 2; }
}

module.exports = { ADMIN, ADMIN_WORD, ADMIN_WORD_HEX, AuthorityError, COMMAND, COMPILER_PIN, COMPILER_SETTING_KEYS, EXPECTED_LIBRARY_IDENTITIES, EXPECTED_LIBRARY_NAMES, IMMUTABLE_STARTS, LIMITS, LINEAGE,
  METADATA_SETTING_KEYS, OUTPUT, REQUESTS, SOURCES, TARGET, TARGET_ADDRESS, VERSION, artifactInventory, canonicalLibraryRows, compileNative, derivedInput, fetchBounded, immutableReferences, immutableWord, makeArtifacts, nativeFetch,
  newBudget, normalizeMetadataLibraries, normalizeNestedLibraries, parseCli, recover, requestPlan, safeRelativePath, safeSourcePath, selectCompiler, splitFullyQualifiedName, stableText, validateBuild, validateCompilerBytes,
  validateCompilerSettings, validateImmutableTransformations, validateInventory, validateMetadataSettings, validateRequest, validateSourcify };
if (require.main === module) runCli(process.argv.slice(2));
