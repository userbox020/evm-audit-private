"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { keccak256, toUtf8Bytes } = require("ethers");
const r3 = require("./run-base-paper-usdplus-aave-pool-proxy-source-r16-r3");

const clone = value => JSON.parse(JSON.stringify(value));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const code = expected => error => error?.code === expected;
const word = Buffer.from(r3.ADMIN_WORD, "hex");

function fixture() {
  const addressDigits = ["a", "b", "c", "d", "e", "f", "1", "2"], identities = r3.EXPECTED_LIBRARY_IDENTITIES.map((identity, index) => ({ identity, address: `0x${addressDigits[index].repeat(40)}` }));
  const flatLibraries = Object.fromEntries(identities.map(row => [row.identity, row.address])), nestedLibraries = {};
  for (const row of identities) { const { source, name } = r3.splitFullyQualifiedName(row.identity); (nestedLibraries[source] ||= {})[name] = row.address; }
  const ordinary = { evmVersion: "paris", libraries: nestedLibraries, metadata: { bytecodeHash: "ipfs" }, optimizer: { enabled: true, runs: 200 }, remappings: [] };
  const metadataSettings = { compilationTarget: { [r3.TARGET.split(":")[0]]: r3.TARGET.split(":")[1] }, evmVersion: ordinary.evmVersion, libraries: flatLibraries, metadata: clone(ordinary.metadata), optimizer: clone(ordinary.optimizer), remappings: [] };
  const inputSettings = clone(ordinary);
  const sources = Object.fromEntries(r3.SOURCES.map((sourcePath, index) => [sourcePath, { content: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.19;\n// fixture-${index}\n` }]));
  const metadataSources = Object.fromEntries(r3.SOURCES.map(sourcePath => [sourcePath, { keccak256: keccak256(toUtf8Bytes(sources[sourcePath].content)) }]));
  const runtimeTemplateBytes = Buffer.alloc(1300), runtimeBytes = Buffer.from(runtimeTemplateBytes); for (const start of r3.IMMUTABLE_STARTS) word.copy(runtimeBytes, start);
  const runtimeTemplate = `0x${runtimeTemplateBytes.toString("hex")}`, runtime = `0x${runtimeBytes.toString("hex")}`, creationTemplate = "0x60006000", refs = { "477": r3.IMMUTABLE_STARTS.map(start => ({ start, length: 32 })) };
  const payload = { chainId: "8453", address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", match: "exact_match", creationMatch: "exact_match", runtimeMatch: "exact_match", matchId: 3701250,
    compilation: { language: "Solidity", compiler: "solc", compilerVersion: r3.VERSION, fullyQualifiedName: r3.TARGET, compilerSettings: clone(inputSettings) }, sources,
    metadata: { language: "Solidity", compiler: { version: r3.VERSION }, settings: metadataSettings, sources: metadataSources }, stdJsonInput: { language: "Solidity", settings: inputSettings, sources: clone(sources) }, constructorArgs: r3.ADMIN_WORD_HEX,
    deployment: { transactionHash: "0x65ada47b1e29db97b062d601cc2d3d4ba3b4ce8d35b24efd65fd03dd1ca130f0", blockNumber: 2357134 },
    creationBytecode: { recompiledBytecode: creationTemplate, onchainBytecode: `${creationTemplate}${r3.ADMIN_WORD}`, linkReferences: {}, transformations: [{ type: "insert", offset: 4, reason: "constructorArguments" }], transformationValues: { constructorArguments: r3.ADMIN_WORD_HEX } },
    runtimeBytecode: { recompiledBytecode: runtimeTemplate, onchainBytecode: runtime, linkReferences: {}, immutableReferences: refs,
      transformations: r3.IMMUTABLE_STARTS.map(offset => ({ id: "477", type: "replace", offset, reason: "immutable" })), transformationValues: { immutables: { "477": r3.ADMIN_WORD_HEX } } } };
  const output = { contracts: { [r3.TARGET.split(":")[0]]: { [r3.TARGET.split(":")[1]]: { evm: { bytecode: { object: creationTemplate.slice(2), linkReferences: {} }, deployedBytecode: { object: runtimeTemplate.slice(2), linkReferences: {}, immutableReferences: clone(refs) } } } } }, errors: [] };
  const compilerBytes = Buffer.from("offline-fake-native-compiler-r3"), pin = { ...r3.COMPILER_PIN, bytes: compilerBytes.length, sha256: sha(compilerBytes), keccak256: keccak256(compilerBytes).slice(2) };
  const record = { path: pin.filename, version: pin.version, build: pin.build, longVersion: pin.longVersion, sha256: `0x${pin.sha256}`, keccak256: `0x${pin.keccak256}` }, list = { builds: [record], releases: { [pin.version]: pin.filename } };
  const sourcifyBytes = Buffer.from(JSON.stringify(payload)), listBytes = Buffer.from(JSON.stringify(list));
  const transport = async spec => { const body = spec.identity === "sourcify-contract" ? sourcifyBytes : spec.identity === "compiler-list" ? listBytes : compilerBytes; return { status: 200, redirected: false, contentType: spec.kind === "json" ? "application/json" : "application/octet-stream", contentLength: body.length, body }; };
  return { payload, output, compilerBytes, pin, record, list, sourcifyBytes, listBytes, transport };
}
async function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r16-r3-offline-")); try { return await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function options(f, root, extra = {}) {
  return { output: path.join(root, "published"), allowTestOverrides: true, testPinOverride: f.pin, transport: f.transport, compilerRunner: (_executable, _input, safety) => { extra.inspectCompiler?.(safety); return f.output; }, ...extra };
}
function walk(root, prefix = "") {
  const rows = []; for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) { const relative = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) rows.push(...walk(root, relative)); else rows.push(relative); } return rows.sort();
}
function mockHttpsRequest({ statusCode = 200, contentType = "application/json", body = Buffer.from("{}") } = {}) {
  return (_options, callback) => { const request = new EventEmitter(); request.destroy = () => {}; request.end = () => queueMicrotask(() => { const response = new EventEmitter(); response.statusCode = statusCode; response.headers = { "content-type": contentType, "content-length": String(body.length) }; response.resume = () => {};
    callback(response); queueMicrotask(() => { response.emit("data", body); response.emit("end"); }); }); return request; };
}

test("R3 CLI and output identity are exact", async () => {
  assert.equal(r3.COMMAND, "node tools/run-base-paper-usdplus-aave-pool-proxy-source-r16-r3.js --once"); assert.equal(r3.OUTPUT.endsWith(path.join("base-paper-usdplus-r16", "pool-proxy-authority-r3")), true);
  assert.equal(r3.parseCli(["--once"]), true); for (const args of [[], ["--run-once"], ["--once", "extra"]]) assert.throws(() => parseBadCli(args));
  function parseBadCli(args) { return r3.parseCli(args); }
});

test("R3 refuses output and pin overrides outside explicit tests", async () => {
  const f = fixture(); await assert.rejects(() => r3.recover({ output: path.join(os.tmpdir(), "not-r3"), transport: f.transport }), code("OUTPUT_OVERRIDE_NOT_ALLOWED"));
  await assert.rejects(() => r3.recover({ testPinOverride: f.pin, transport: f.transport }), code("TEST_OVERRIDE_NOT_ALLOWED"));
});

test("request plan is exactly three fixed public requests", () => {
  const plan = r3.requestPlan(); assert.equal(plan.length, 3); assert.deepEqual(plan.map(row => row.hostname), ["sourcify.dev", "binaries.soliditylang.org", "binaries.soliditylang.org"]);
  assert.equal(plan[2].path, `/windows-amd64/${r3.COMPILER_PIN.filename}`); for (const row of plan) assert.equal(r3.validateRequest(row), true);
});

test("request allowlist rejects method host origin path and accept changes", () => {
  for (const mutate of [x => x.identity = "synthetic", x => x.method = "POST", x => x.hostname = "example.test", x => x.origin = "http://sourcify.dev", x => x.path = "/wrong", x => x.accept = "*/*", x => x.kind = "binary", x => x.path += "\\x", x => delete x.kind, x => x.extra = true]) {
    const row = { ...r3.REQUESTS[0] }; mutate(row); assert.throws(() => r3.validateRequest(row)); }
});

test("compiler tuple accepts exact binary media tokens casing and valid parameters", () => {
  const compiler = r3.REQUESTS[2], accepted = ["application/octet-stream", "application/x-msdownload", "binary/octet-stream", "application/x-msdos-program", "Application/X-MSDOS-Program", " application/x-msdos-program ; charset=binary ", "application/x-msdos-program; name=\"solc.exe\"", "application/x-msdos-program; note=\"a;b\""];
  for (const value of accepted) assert.equal(r3.validateResponseContentType(compiler, value), value.split(";")[0].trim().toLowerCase());
});

test("JSON tuples retain application JSON and structured-suffix JSON policy", () => {
  for (const request of r3.REQUESTS.slice(0, 2)) for (const value of ["application/json", "Application/JSON; charset=utf-8", "application/vnd.sourcify+json", "application/problem+json; profile=exact"]) assert.doesNotThrow(() => r3.validateResponseContentType(request, value));
  for (const request of r3.REQUESTS.slice(0, 2)) for (const value of ["application/x-msdos-program", "application/*+json"]) assert.throws(() => r3.validateResponseContentType(request, value), code("CONTENT_TYPE_INVALID"));
});

test("x-msdos-program rejects every mutated compiler request tuple field", () => {
  const mutations = [x => x.identity = "compiler-list", x => x.origin = "https://sourcify.dev", x => x.hostname = "sourcify.dev", x => x.method = "POST", x => x.path += ".lookalike", x => x.accept = "application/x-msdos-program", x => x.kind = "binary", x => delete x.identity, x => x.extra = true];
  for (const mutate of mutations) { const request = { ...r3.REQUESTS[2] }; mutate(request); assert.throws(() => r3.validateResponseContentType(request, "application/x-msdos-program")); }
});

test("content-type parser rejects executable lookalikes multiple values controls and malformed parameters", () => {
  const compiler = r3.REQUESTS[2], rejected = ["*/*", "application/*+json", "text/plain", "application/x-executable", "application/vnd.microsoft.portable-executable", "application/exe", "application/x-msdos", "application/x-msdos-program-extra",
    "application/prefix-x-msdos-program", "application/x-msdos-program+suffix", "application/x-msdos-program,application/octet-stream", "application/x-msdos-program\r\nX: y", "application/x-msdos-program\0", "application/x-msdos-program;",
    "application/x-msdos-program;;a=b", "application/x-msdos-program;foo", "application/x-msdos-program;foo=", "application/x-msdos-program;=bar", "application/x-msdos-program;foo=\"unterminated", "application/x-msdos-program;foo=a,b"];
  for (const value of rejected) assert.throws(() => r3.validateResponseContentType(compiler, value), code("CONTENT_TYPE_INVALID"));
});

test("nativeFetch and fetchBounded both route through the shared content-type validator", async () => {
  let nativeCalls = 0, boundedCalls = 0; const nativeValidator = (spec, value) => { nativeCalls++; return r3.validateResponseContentType(spec, value); };
  const native = await r3.nativeFetch(r3.REQUESTS[0], mockHttpsRequest(), nativeValidator); assert.equal(nativeCalls, 1); assert.equal(native.body.toString(), "{}");
  const boundedValidator = (spec, value) => { boundedCalls++; return r3.validateResponseContentType(spec, value); };
  await r3.fetchBounded(r3.REQUESTS[0], r3.newBudget(), async () => ({ status: 200, redirected: false, contentType: "application/json", body: Buffer.from("{}") }), boundedValidator); assert.equal(boundedCalls, 1);
});

test("bounded fetch rejects redirects status type length body and request caps", async () => {
  const invoke = response => r3.fetchBounded(r3.REQUESTS[0], r3.newBudget(), async () => response);
  await assert.rejects(() => invoke({ status: 302, redirected: true, contentType: "application/json", body: Buffer.alloc(0) }), code("REDIRECT_REJECTED"));
  await assert.rejects(() => invoke({ status: 500, contentType: "application/json", body: Buffer.alloc(0) }), code("HTTP_STATUS_INVALID"));
  await assert.rejects(() => invoke({ status: 200, contentType: "text/plain", body: Buffer.alloc(0) }), code("CONTENT_TYPE_INVALID"));
  await assert.rejects(() => invoke({ status: 200, contentType: "application/json", body: "bad" }), code("RESPONSE_BODY_INVALID"));
  await assert.rejects(() => invoke({ status: 200, contentType: "application/json", contentLength: 2, body: Buffer.alloc(1) }), code("CONTENT_LENGTH_INVALID"));
  const budget = r3.newBudget(); budget.requests = r3.LIMITS.requests; await assert.rejects(() => r3.fetchBounded(r3.REQUESTS[0], budget, async () => null), code("REQUEST_CAP"));
});

test("response and aggregate byte caps fail closed", async () => {
  const responseBudget = r3.newBudget(); await assert.rejects(() => r3.fetchBounded(r3.REQUESTS[0], responseBudget, async () => ({ status: 200, contentType: "application/json", body: Buffer.alloc(r3.LIMITS.responseBytes + 1) })), code("RESPONSE_SIZE_CAP"));
  const totalBudget = r3.newBudget(); totalBudget.bytes = r3.LIMITS.totalBytes; await assert.rejects(() => r3.fetchBounded(r3.REQUESTS[0], totalBudget, async () => ({ status: 200, contentType: "application/json", body: Buffer.alloc(1) })), code("TOTAL_SIZE_CAP"));
});

test("metadata target is mandatory and standard input target is forbidden", () => {
  const missing = fixture().payload; delete missing.metadata.settings.compilationTarget; assert.throws(() => r3.validateSourcify(missing), code("COMPILATION_TARGET_MISMATCH"));
  for (const qualifiedName of ["bad.sol:Bad", "missing-colon", `${r3.TARGET}:Extra`]) { const mismatch = fixture().payload; mismatch.compilation.fullyQualifiedName = qualifiedName; assert.throws(() => r3.validateSourcify(mismatch), code("COMPILATION_TARGET_MISMATCH")); }
  const present = fixture().payload; present.stdJsonInput.settings.compilationTarget = clone(present.metadata.settings.compilationTarget); assert.throws(() => r3.validateSourcify(present), code("STD_INPUT_COMPILATION_TARGET_PRESENT"));
  const compilationPresent = fixture().payload; compilationPresent.compilation.compilerSettings.compilationTarget = clone(compilationPresent.metadata.settings.compilationTarget); assert.throws(() => r3.validateSourcify(compilationPresent), code("COMPILATION_COMPILATION_TARGET_PRESENT"));
});

test("derived standard input still omits compilationTarget", () => {
  const f = fixture(), derived = r3.derivedInput(f.payload.stdJsonInput); assert.equal(Object.prototype.hasOwnProperty.call(derived.input.settings, "compilationTarget"), false);
  const otherwise = clone(derived.input.settings); delete otherwise.outputSelection; assert.deepEqual(otherwise, f.payload.stdJsonInput.settings); assert.equal(derived.derivation.kind, "OUTPUT_SELECTION_ADDITION_ONLY");
});

test("happy response fixture has the exact confirmed compiler and settings shapes", () => {
  const payload = fixture().payload, validated = r3.validateSourcify(payload); assert.equal(payload.metadata.compiler.version, r3.VERSION); assert.equal(payload.compilation.compilerVersion, r3.VERSION);
  assert.deepEqual(Object.keys(payload.metadata.settings).sort(), [...r3.METADATA_SETTING_KEYS].sort()); assert.deepEqual(Object.keys(payload.stdJsonInput.settings).sort(), [...r3.COMPILER_SETTING_KEYS].sort());
  assert.deepEqual(Object.keys(payload.compilation.compilerSettings).sort(), [...r3.COMPILER_SETTING_KEYS].sort()); assert.equal(validated.libraryRows.length, 8);
  assert.equal(Object.values(payload.metadata.settings.libraries).every(value => typeof value === "string"), true); assert.equal(Object.values(payload.stdJsonInput.settings.libraries).every(value => value && typeof value === "object" && !Array.isArray(value)), true);
});

test("metadata and compilation compiler versions are both exact", () => {
  for (const mutate of [x => delete x.metadata.compiler.version, x => x.metadata.compiler.version = "0.8.20+commit.fake", x => x.compilation.compilerVersion = "0.8.20+commit.fake"]) {
    const payload = fixture().payload; mutate(payload); assert.throws(() => r3.validateSourcify(payload)); }
});

test("compilation compilerSettings is mandatory and must agree with standard input", () => {
  const cases = [x => delete x.compilation.compilerSettings, x => x.compilation.compilerSettings.evmVersion = "london",
    x => x.compilation.compilerSettings.remappings.push("x=y"), x => x.compilation.compilerSettings.libraries[r3.EXPECTED_LIBRARY_IDENTITIES[0].split(":")[0]].BorrowLogic = `0x${"99".repeat(20)}`];
  for (const mutate of cases) { const payload = fixture().payload; mutate(payload); assert.throws(() => r3.validateSourcify(payload)); }
});

test("unexpected fetched setting keys and forbidden compiler-input keys reject", () => {
  const cases = [x => x.metadata.settings.unexpected = true, x => x.metadata.settings.viaIR = false, x => x.metadata.settings.outputSelection = {}, x => x.stdJsonInput.settings.unexpected = true,
    x => x.stdJsonInput.settings.viaIR = false, x => x.stdJsonInput.settings.outputSelection = {}, x => x.compilation.compilerSettings.unexpected = true, x => x.compilation.compilerSettings.viaIR = false,
    x => x.compilation.compilerSettings.outputSelection = {}, x => x.compilation.compilerSettings.compilationTarget = clone(x.metadata.settings.compilationTarget)];
  for (const mutate of cases) { const payload = fixture().payload; mutate(payload); assert.throws(() => r3.validateSourcify(payload)); }
});

test("metadata flat library keys split at the final colon and reject malformed forms", () => {
  assert.deepEqual(r3.splitFullyQualifiedName("C:/path/File.sol:Lib"), { source: "C:/path/File.sol", name: "Lib", identity: "C:/path/File.sol:Lib" });
  for (const key of ["NoColon", ":Lib", "path.sol:", "path.sol:1Bad", "path.sol:bad-name"]) assert.throws(() => r3.splitFullyQualifiedName(key), code("FULLY_QUALIFIED_NAME_INVALID"));
  const make = () => clone(fixture().payload.metadata.settings.libraries), first = r3.EXPECTED_LIBRARY_IDENTITIES[0];
  const mutations = [x => { const value = x[first]; delete x[first]; x.NoColon = value; }, x => x[first] = { nested: true }, x => x[first] = "bad", x => delete x[first],
    x => x["extra.sol:Extra"] = `0x${"11".repeat(20)}`];
  for (const mutate of mutations) { const libraries = make(); mutate(libraries); assert.throws(() => r3.normalizeMetadataLibraries(libraries)); }
  const mixed = make(); mixed[first] = { BorrowLogic: mixed[first] }; assert.throws(() => r3.normalizeMetadataLibraries(mixed), code("METADATA_LIBRARY_VALUE_INVALID"));
});

test("nested library maps reject malformed rows leaves addresses and identity sets", () => {
  const firstIdentity = r3.EXPECTED_LIBRARY_IDENTITIES[0], { source, name } = r3.splitFullyQualifiedName(firstIdentity), make = () => clone(fixture().payload.stdJsonInput.settings.libraries);
  const mutations = [x => x[source] = `0x${"11".repeat(20)}`, x => x[source] = [], x => x[""] = { Extra: `0x${"11".repeat(20)}` }, x => x[source][name] = { nested: true },
    x => x[source][name] = [], x => x[source][name] = "bad", x => { x[source]["1Bad"] = x[source][name]; delete x[source][name]; }, x => delete x[source][name], x => x[source].Extra = `0x${"11".repeat(20)}`];
  for (const mutate of mutations) { const libraries = make(); mutate(libraries); assert.throws(() => r3.normalizeNestedLibraries(libraries)); }
});

test("all canonical library identities and addresses must agree", () => {
  const identity = r3.EXPECTED_LIBRARY_IDENTITIES[0], { source, name } = r3.splitFullyQualifiedName(identity);
  for (const mutate of [x => x.metadata.settings.libraries[identity] = `0x${"99".repeat(20)}`, x => x.stdJsonInput.settings.libraries[source][name] = `0x${"99".repeat(20)}`,
    x => x.compilation.compilerSettings.libraries[source][name] = `0x${"99".repeat(20)}`]) { const payload = fixture().payload; mutate(payload); assert.throws(() => r3.validateSourcify(payload)); }
  assert.throws(() => r3.canonicalLibraryRows([{ source, name, identity, address: r3.ADMIN }, { source, name, identity, address: r3.ADMIN }], "BAD"), code("LIBRARY_IDENTITY_DUPLICATE"));
  const caseOnly = fixture().payload; caseOnly.metadata.settings.libraries[identity] = `0x${caseOnly.metadata.settings.libraries[identity].slice(2).toUpperCase()}`;
  caseOnly.stdJsonInput.settings.libraries[source][name] = `0x${caseOnly.stdJsonInput.settings.libraries[source][name].slice(2).toUpperCase()}`; assert.doesNotThrow(() => r3.validateSourcify(caseOnly));
});

test("canonical object key reordering is accepted while remapping order is preserved", () => {
  const payload = fixture().payload, reorder = value => Object.fromEntries(Object.entries(value).reverse()); payload.metadata.settings = reorder(payload.metadata.settings); payload.metadata.settings.libraries = reorder(payload.metadata.settings.libraries);
  payload.stdJsonInput.settings = reorder(payload.stdJsonInput.settings); payload.stdJsonInput.settings.libraries = reorder(payload.stdJsonInput.settings.libraries); payload.compilation.compilerSettings = reorder(payload.compilation.compilerSettings);
  assert.doesNotThrow(() => r3.validateSourcify(payload));
  const remapped = fixture().payload; for (const settings of [remapped.metadata.settings, remapped.stdJsonInput.settings, remapped.compilation.compilerSettings]) settings.remappings = ["a=b", "c=d"]; assert.doesNotThrow(() => r3.validateSourcify(remapped));
  remapped.compilation.compilerSettings.remappings.reverse(); assert.throws(() => r3.validateSourcify(remapped), code("COMPILER_SETTINGS_DISAGREEMENT"));
  const metadataOrder = fixture().payload; for (const settings of [metadataOrder.metadata.settings, metadataOrder.stdJsonInput.settings, metadataOrder.compilation.compilerSettings]) settings.remappings = ["a=b", "c=d"];
  metadataOrder.metadata.settings.remappings.reverse(); assert.throws(() => r3.validateSourcify(metadataOrder), code("ORDINARY_SETTINGS_DISAGREEMENT"));
});

test("Sourcify identity settings sources hashes and libraries remain closed", () => {
  const first = r3.splitFullyQualifiedName(r3.EXPECTED_LIBRARY_IDENTITIES[0]);
  const cases = [x => x.matchId++, x => x.runtimeMatch = "partial_match", x => x.stdJsonInput.settings.optimizer.runs++, x => delete x.sources[r3.SOURCES[0]],
    x => x.sources[r3.SOURCES[0]].content += "x", x => x.metadata.sources[r3.SOURCES[0]].keccak256 = `0x${"00".repeat(32)}`, x => delete x.stdJsonInput.settings.libraries[first.source][first.name]];
  for (const mutate of cases) { const payload = fixture().payload; mutate(payload); assert.throws(() => r3.validateSourcify(payload)); }
});

test("source inventory includes normalized bytes SHA-256 and Keccak-256", () => {
  const f = fixture(), validated = r3.validateSourcify(f.payload); assert.equal(validated.sourceRows.length, 6);
  for (const row of validated.sourceRows) { const bytes = Buffer.from(row.content); assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, sha(bytes)); assert.equal(row.keccak256, keccak256(bytes)); assert.equal(r3.safeSourcePath(row.path), row.path); }
});

test("runtime immutable references require exact ordered 32-byte entries", () => {
  const f = fixture(); assert.deepEqual(r3.immutableReferences(f.payload.runtimeBytecode.immutableReferences).map(row => row.start), r3.IMMUTABLE_STARTS);
  const mutations = [x => x["477"][0].length = 20, x => x["477"][0].start++, x => x["477"].reverse(), x => x["477"].push(clone(x["477"][0])), x => x["477"][1] = clone(x["477"][0]), x => x["478"] = []];
  for (const mutate of mutations) { const refs = clone(f.payload.runtimeBytecode.immutableReferences); mutate(refs); assert.throws(() => r3.immutableReferences(refs), code("IMMUTABLE_REFERENCES_MISMATCH")); }
});

test("runtime immutable value accepts only nested exact 32-byte padded word", () => {
  const f = fixture(); assert.equal(r3.immutableWord(f.payload.runtimeBytecode).equals(word), true);
  const mutations = [x => x.transformationValues = { "477": r3.ADMIN_WORD_HEX }, x => x.transformationValues.immutables["477"] = r3.ADMIN,
    x => x.transformationValues.immutables["477"] = `0x11${r3.ADMIN_WORD.slice(2)}`, x => x.transformationValues.immutables["478"] = r3.ADMIN_WORD_HEX];
  for (const mutate of mutations) { const section = clone(f.payload.runtimeBytecode); mutate(section); assert.throws(() => r3.immutableWord(section)); }
});

test("runtime immutable transformations may be absent but if present are exact", () => {
  const f = fixture(); assert.doesNotThrow(() => r3.validateImmutableTransformations(f.payload.runtimeBytecode)); const absent = clone(f.payload.runtimeBytecode); delete absent.transformations; assert.doesNotThrow(() => r3.validateImmutableTransformations(absent));
  const mutations = [x => x[0].offset++, x => x.reverse(), x => x.push(clone(x[0])), x => x[1] = clone(x[0]), x => x[0].id = "478", x => x[0].type = "insert", x => x[0].reason = "other", x => x[0].extra = true];
  for (const mutate of mutations) { const section = clone(f.payload.runtimeBytecode); mutate(section.transformations); assert.throws(() => r3.validateImmutableTransformations(section), code("IMMUTABLE_TRANSFORMATION_MISMATCH")); }
});

test("build copies the complete immutable word at all six offsets", () => {
  const f = fixture(), build = r3.validateBuild(f.payload, f.output), bytes = Buffer.from(build.runtime.slice(2), "hex"); for (const start of r3.IMMUTABLE_STARTS) assert.equal(bytes.subarray(start, start + 32).equals(word), true);
  assert.equal(build.runtimeSha256, sha(bytes)); assert.equal(build.runtimeKeccak256, keccak256(bytes));
});

test("compiled and Sourcify immutable reference shapes must both match", () => {
  const f = fixture(), compiled = clone(f.output); compiled.contracts[r3.TARGET.split(":")[0]][r3.TARGET.split(":")[1]].evm.deployedBytecode.immutableReferences["477"][0].length = 20; assert.throws(() => r3.validateBuild(f.payload, compiled), code("IMMUTABLE_REFERENCES_MISMATCH"));
});

test("constructor and bytecode reconstruction remain exact", () => {
  const f = fixture(); for (const mutate of [x => x.creationBytecode.transformations[0].type = "replace", x => x.creationBytecode.onchainBytecode = "0x00", x => x.runtimeBytecode.onchainBytecode = "0x00"]) {
    const payload = clone(f.payload); mutate(payload); assert.throws(() => r3.validateBuild(payload, f.output)); }
});

test("hard-coded compiler pin has reviewed independent values", () => {
  assert.deepEqual(r3.COMPILER_PIN, { filename: "solc-windows-amd64-v0.8.19+commit.7dd6d404.exe", bytes: 9150464, sha256: "00d3b5ca64b097964ed6d70d9805a63fdd27113b07c1b2559dbfdd579f994508",
    keccak256: "da3dcff0fe9e3297d99ec184afab49b0eb0a95ce88ef3f44587618445cbe6546", version: "0.8.19", build: "commit.7dd6d404", longVersion: r3.VERSION });
});

test("official compiler list must independently match every hard-coded pin", () => {
  const real = { path: r3.COMPILER_PIN.filename, version: r3.COMPILER_PIN.version, build: r3.COMPILER_PIN.build, longVersion: r3.VERSION, sha256: `0x${r3.COMPILER_PIN.sha256}`, keccak256: `0x${r3.COMPILER_PIN.keccak256}` };
  assert.deepEqual(r3.selectCompiler({ builds: [real], releases: { "0.8.19": real.path } }), real);
  for (const field of ["path", "version", "build", "sha256", "keccak256"]) { const row = { ...real, [field]: field.includes("256") ? `0x${"00".repeat(32)}` : "wrong" }; assert.throws(() => r3.selectCompiler({ builds: [row], releases: { "0.8.19": row.path } })); }
});

test("actual compiler bytes require pinned length and both hashes", () => {
  const f = fixture(); assert.equal(r3.validateCompilerBytes(f.compilerBytes, f.record, f.pin), true);
  for (const bytes of [Buffer.concat([f.compilerBytes, Buffer.from([0])]), Buffer.from(f.compilerBytes).fill(1)]) assert.throws(() => r3.validateCompilerBytes(bytes, f.record, f.pin), code("COMPILER_BINARY_PIN_MISMATCH"));
});

test("self-consistent forged list and binary fail hard-coded pin before native execution", async () => withTemp(async root => {
  const f = fixture(); let executed = false, downloads = 0; const transport = async spec => { downloads++; const body = spec.path.includes("contract/8453") ? f.sourcifyBytes : f.listBytes; return { status: 200, redirected: false, contentType: "application/json", body }; };
  await assert.rejects(() => r3.recover({ output: path.join(root, "out"), allowTestOverrides: true, transport, compilerRunner: () => { executed = true; } }), code("COMPILER_LIST_PIN_MISMATCH"));
  assert.equal(downloads, 2); assert.equal(executed, false); assert.equal(fs.existsSync(path.join(root, "out")), false);
}));

test("full injected recovery accepts compiler x-msdos-program and publishes", async () => withTemp(async root => {
  const f = fixture(); let compiled = false; const transport = async spec => { const body = spec.identity === "sourcify-contract" ? f.sourcifyBytes : spec.identity === "compiler-list" ? f.listBytes : f.compilerBytes;
    return { status: 200, redirected: false, contentType: spec.identity === "compiler-binary" ? "Application/X-MSDOS-Program; name=\"solc.exe\"" : "application/json", contentLength: body.length, body }; };
  const result = await r3.recover(options(f, root, { transport, compilerRunner: () => { compiled = true; return f.output; } })); assert.equal(compiled, true); assert.equal(result.authority.schema, "base-paper-usdplus-aave-pool-proxy-source-authority/v16-r3");
  assert.equal(fs.existsSync(path.join(root, "published", "authority.json")), true);
}));

test("bad compiler media length SHA or Keccak never stages or invokes compiler", async () => withTemp(async root => {
  const base = fixture(), cases = [
    { name: "media", body: base.compilerBytes, pin: base.pin, record: base.record, contentType: "application/x-executable", code: "CONTENT_TYPE_INVALID" },
    { name: "length", body: Buffer.concat([base.compilerBytes, Buffer.from([0])]), pin: base.pin, record: base.record, contentType: "application/x-msdos-program", code: "COMPILER_BINARY_PIN_MISMATCH" },
    { name: "sha", body: base.compilerBytes, pin: { ...base.pin, sha256: "00".repeat(32) }, record: { ...base.record, sha256: `0x${"00".repeat(32)}` }, contentType: "application/x-msdos-program", code: "COMPILER_BINARY_PIN_MISMATCH" },
    { name: "keccak", body: base.compilerBytes, pin: { ...base.pin, keccak256: "00".repeat(32) }, record: { ...base.record, keccak256: `0x${"00".repeat(32)}` }, contentType: "application/x-msdos-program", code: "COMPILER_BINARY_PIN_MISMATCH" },
  ];
  for (const row of cases) { const caseRoot = path.join(root, row.name); fs.mkdirSync(caseRoot); const list = { builds: [row.record], releases: { [row.pin.version]: row.pin.filename } }, listBytes = Buffer.from(JSON.stringify(list)); let executed = false;
    const transport = async spec => { const body = spec.identity === "sourcify-contract" ? base.sourcifyBytes : spec.identity === "compiler-list" ? listBytes : row.body; return { status: 200, redirected: false, contentType: spec.identity === "compiler-binary" ? row.contentType : "application/json", contentLength: body.length, body }; };
    await assert.rejects(() => r3.recover({ output: path.join(caseRoot, "published"), allowTestOverrides: true, testPinOverride: row.pin, transport, compilerRunner: () => { executed = true; return base.output; } }), code(row.code));
    assert.equal(executed, false); assert.deepEqual(fs.readdirSync(caseRoot), []); }
}));

test("real staging branch succeeds with fake pinned bytes and fixed compiler safety", async () => withTemp(async root => {
  const f = fixture(); let safety; const result = await r3.recover(options(f, root, { inspectCompiler: value => { safety = value; } })); const output = path.join(root, "published");
  assert.equal(fs.existsSync(path.join(output, "authority.json")), true); assert.deepEqual(safety, { versionArgv: ["--version"], compileArgv: ["--standard-json"], shell: false, env: {} }); assert.equal(result.authority.requests.count, 3);
  assert.equal(result.authority.requests.bytes, result.authority.requests.responses.reduce((sum, row) => sum + row.bytes, 0));
}));

test("existing destination rejects without creating staging", async () => withTemp(async root => {
  const f = fixture(), output = path.join(root, "published"); fs.mkdirSync(output); fs.writeFileSync(path.join(output, "sentinel"), "keep"); await assert.rejects(() => r3.recover(options(f, root)), code("OUTPUT_EXISTS_NO_OVERWRITE")); assert.equal(fs.readFileSync(path.join(output, "sentinel"), "utf8"), "keep");
  assert.equal(fs.readdirSync(root).some(name => name.includes("stage")), false);
}));

test("mid-bundle write failure cleans invocation-owned stage and publishes nothing", async () => withTemp(async root => {
  const f = fixture(); await assert.rejects(() => r3.recover(options(f, root, { testFault: { writeRelative: "metadata.json" } })), code("INJECTED_WRITE_FAILURE")); assert.deepEqual(fs.readdirSync(root), []);
}));

test("rename failure cleans invocation-owned stage and publishes nothing", async () => withTemp(async root => {
  const f = fixture(); await assert.rejects(() => r3.recover(options(f, root, { testFault: { rename: true } })), code("INJECTED_RENAME_FAILURE")); assert.deepEqual(fs.readdirSync(root), []);
}));

test("late destination collision is not overwritten and owned stage is cleaned", async () => withTemp(async root => {
  const f = fixture(), output = path.join(root, "published"), testFault = { beforeRename: destination => { fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "sentinel"), "keep"); } };
  await assert.rejects(() => r3.recover(options(f, root, { testFault })), code("OUTPUT_EXISTS_NO_OVERWRITE")); assert.equal(fs.readFileSync(path.join(output, "sentinel"), "utf8"), "keep");
  assert.equal(fs.readdirSync(root).some(name => name.includes("stage")), false);
}));

test("compiler execution failure cleans invocation-owned stage", async () => withTemp(async root => {
  const f = fixture(), opts = options(f, root); opts.compilerRunner = () => { throw new r3.AuthorityError("COMPILER", "FAKE_EXECUTION_FAILURE"); }; await assert.rejects(() => r3.recover(opts), code("FAKE_EXECUTION_FAILURE")); assert.deepEqual(fs.readdirSync(root), []);
}));

test("forced staging collision preserves the pre-existing path", async () => withTemp(async root => {
  const f = fixture(), collision = path.join(root, "collision"); fs.mkdirSync(collision); fs.writeFileSync(path.join(collision, "sentinel"), "keep"); await assert.rejects(() => r3.recover(options(f, root, { testStagePath: collision })), code("STAGE_COLLISION"));
  assert.equal(fs.readFileSync(path.join(collision, "sentinel"), "utf8"), "keep"); assert.equal(fs.existsSync(path.join(root, "published")), false);
}));

test("authority inventory binds every other published file and exact bytes", async () => withTemp(async root => {
  const f = fixture(); await r3.recover(options(f, root)); const output = path.join(root, "published"), authority = JSON.parse(fs.readFileSync(path.join(output, "authority.json"), "utf8"));
  const files = walk(output).filter(relative => relative !== "authority.json"), listed = authority.artifacts.map(row => row.path); assert.deepEqual(listed, [...files].sort((a, b) => a.localeCompare(b))); assert.equal(new Set(listed.map(value => value.toLowerCase())).size, listed.length);
  for (const row of authority.artifacts) { const bytes = fs.readFileSync(path.join(output, ...row.path.split("/"))); assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, sha(bytes)); assert.equal(r3.safeRelativePath(row.path, "ARTIFACT_PATH_INVALID"), row.path); }
}));

test("inventory rejects missing unlisted duplicate unsafe and byte mismatch entries", () => {
  const artifacts = new Map([["a.json", Buffer.from("a")], ["nested/b.hex", Buffer.from("bb")]]), valid = r3.artifactInventory(artifacts); assert.equal(r3.validateInventory(valid, artifacts), true);
  for (const rows of [valid.slice(1), [...valid, valid[0]], valid.map((row, index) => index ? row : { ...row, bytes: 99 }), valid.map((row, index) => index ? row : { ...row, path: "../a.json" })]) assert.throws(() => r3.validateInventory(rows, artifacts), code("ARTIFACT_INVENTORY_INVALID"));
  assert.throws(() => r3.artifactInventory(new Map([["A", Buffer.from("a")], ["a", Buffer.from("b")]])), code("ARTIFACT_INVENTORY_INVALID"));
});

test("authority includes exact R1 R2 and actual P0 lineage without stale advisory hash", async () => withTemp(async root => {
  const f = fixture(), { authority } = await r3.recover(options(f, root)); assert.deepEqual(authority.lineage, clone(r3.LINEAGE)); assert.equal(authority.lineage.r1Provenance.executedPreCorrectionRunnerBytes, null); assert.equal(authority.lineage.r1Provenance.executedPreCorrectionRunnerSha256, null);
  assert.equal(authority.lineage.r1Provenance.executedPreCorrectionIdentityInferred, false); assert.equal(authority.lineage.r1Provenance.currentR1IsExecutedByteIdentity, false);
  assert.equal(authority.lineage.r1CurrentPostFailureRunnerSha256, "533f7b2368531f96539133883217bcc26b08d1fcee6be570ca46670c799ea9a4"); assert.equal(authority.lineage.r1CurrentTestsSha256, "2fd9ba17abfe5ae1108e6374f98ea0944187adb3e17f81ca48e21d1198c8ea04");
  assert.equal(authority.lineage.p0AnchorSha256, "59dea96628ff46542b92ab6793244904740881489943321911345db1551ef221"); assert.equal(JSON.stringify(authority.lineage).includes("a6d73"), false);
  const predecessor = authority.lineage.r2Provenance; assert.equal(predecessor.reviewedRunnerSha256, "fce62c1443f19059b25f9a7524a5423f95f3f12349a3a419c79abd1313794f43"); assert.equal(predecessor.reviewedTestsSha256, "5788d263cc2bd170a4f407f76383ce5dd2b5e2a2c62cc915ed1357e6a591fc32");
  assert.equal(predecessor.offlineTests, "41/41"); assert.equal(predecessor.review, "R2_RETRY_JUSTIFIED"); assert.deepEqual(predecessor.preliminaryGuardFailure, { code: "OUTPUT_PARENT_MISSING", nodeStarted: false, attempt: false });
  assert.equal(predecessor.command, "node tools/run-base-paper-usdplus-aave-pool-proxy-source-r16-r2.js --once"); assert.deepEqual(predecessor.terminal, { classification: "INCOMPLETE", stage: "REQUEST", code: "CONTENT_TYPE_INVALID" });
  assert.equal(predecessor.failedRequestOrdinal, null); assert.equal(predecessor.requestOrdinalProven, false); for (const field of ["compilerExecution", "compilation", "stageCreation", "publication", "compilerBytesPassedPinValidation", "compilerBytesReachedNativeExecution", "postHocFailureArtifactCreated"]) assert.equal(predecessor[field], false);
  assert.equal(predecessor.outputAbsentAfterward, true); assert.equal(predecessor.ownedStageCountAfterward, 0); assert.equal(predecessor.causalDiagnosis, "STRONGLY_SUPPORTED_BY_PREEXISTING_INDEPENDENT_PUBLIC_RESPONSE_RESEARCH;NOT_DIRECTLY_OBSERVED_FROM_R2_TERMINAL_OUTPUT;FAILED_REQUEST_ORDINAL_UNPROVEN");
  assert.equal(predecessor.provenanceKind, "REVIEW_SUPPLIED_CONTINUATION_PROVENANCE_NOT_R2_MACHINE_OUTPUT"); assert.equal(Object.prototype.hasOwnProperty.call(predecessor, "httpResponseBodyBegan"), false);
}));

test("authority states compiler pin limitations without attestation claims", async () => withTemp(async root => {
  const f = fixture(), { authority } = await r3.recover(options(f, root)); assert.equal(authority.compilerPin.listIsPinAuthority, false); assert.equal(authority.compilerPin.signatureVerified, false); assert.equal(authority.compilerPin.independentPublisherAttestation, false);
  assert.equal(authority.compilerPin.sha256, r3.COMPILER_PIN.sha256); assert.equal(authority.compilerPin.bytes, r3.COMPILER_PIN.bytes);
}));

test("authority makes no target-state gate economics route signing or profit claim", async () => withTemp(async root => {
  const f = fixture(), { authority } = await r3.recover(options(f, root)), inspected = clone(authority); delete inspected.lineage.r1Provenance.didNotOccur;
  const text = JSON.stringify(inspected); assert.equal(/currentState|G[1-6]|redemption|economics|route|signing|profit|fork|RPC/i.test(text), false); assert.equal(authority.limitations.liveCodeCompared, false); assert.equal(authority.limitations.freshStateEstablished, false);
}));

test("runner source has no endpoint inventory wallet package lifecycle or shell execution", () => {
  const source = fs.readFileSync(require.resolve("./run-base-paper-usdplus-aave-pool-proxy-source-r16-r3"), "utf8"); assert.equal(/rpc_endpoints|graphql_endpoints|\.env|wallet|npm |pnpm |yarn |shell:\s*true/.test(source), false);
});

test("predecessor and R3 workspace outputs and owned stages remain absent", () => {
  const workspace = path.resolve(__dirname, ".."), parent = path.join(workspace, "reports/raw/fast/base-paper-usdplus-r16"); assert.equal(fs.existsSync(parent), true);
  for (const name of ["pool-proxy-authority", "pool-proxy-authority-r2", "pool-proxy-authority-r3"]) assert.equal(fs.existsSync(path.join(parent, name)), false);
  const stages = fs.readdirSync(parent).filter(name => name.startsWith(".pool-proxy-authority-stage-") || name.startsWith(".pool-proxy-authority-r2-stage-") || name.startsWith(".pool-proxy-authority-r3-stage-")); assert.deepEqual(stages, []);
});
