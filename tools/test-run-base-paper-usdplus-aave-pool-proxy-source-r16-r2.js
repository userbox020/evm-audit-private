"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { keccak256, toUtf8Bytes } = require("ethers");
const r2 = require("./run-base-paper-usdplus-aave-pool-proxy-source-r16-r2");

const clone = value => JSON.parse(JSON.stringify(value));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const code = expected => error => error?.code === expected;
const word = Buffer.from(r2.ADMIN_WORD, "hex");

function fixture() {
  const addressDigits = ["a", "b", "c", "d", "e", "f", "1", "2"], identities = r2.EXPECTED_LIBRARY_IDENTITIES.map((identity, index) => ({ identity, address: `0x${addressDigits[index].repeat(40)}` }));
  const flatLibraries = Object.fromEntries(identities.map(row => [row.identity, row.address])), nestedLibraries = {};
  for (const row of identities) { const { source, name } = r2.splitFullyQualifiedName(row.identity); (nestedLibraries[source] ||= {})[name] = row.address; }
  const ordinary = { evmVersion: "paris", libraries: nestedLibraries, metadata: { bytecodeHash: "ipfs" }, optimizer: { enabled: true, runs: 200 }, remappings: [] };
  const metadataSettings = { compilationTarget: { [r2.TARGET.split(":")[0]]: r2.TARGET.split(":")[1] }, evmVersion: ordinary.evmVersion, libraries: flatLibraries, metadata: clone(ordinary.metadata), optimizer: clone(ordinary.optimizer), remappings: [] };
  const inputSettings = clone(ordinary);
  const sources = Object.fromEntries(r2.SOURCES.map((sourcePath, index) => [sourcePath, { content: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.19;\n// fixture-${index}\n` }]));
  const metadataSources = Object.fromEntries(r2.SOURCES.map(sourcePath => [sourcePath, { keccak256: keccak256(toUtf8Bytes(sources[sourcePath].content)) }]));
  const runtimeTemplateBytes = Buffer.alloc(1300), runtimeBytes = Buffer.from(runtimeTemplateBytes); for (const start of r2.IMMUTABLE_STARTS) word.copy(runtimeBytes, start);
  const runtimeTemplate = `0x${runtimeTemplateBytes.toString("hex")}`, runtime = `0x${runtimeBytes.toString("hex")}`, creationTemplate = "0x60006000", refs = { "477": r2.IMMUTABLE_STARTS.map(start => ({ start, length: 32 })) };
  const payload = { chainId: "8453", address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", match: "exact_match", creationMatch: "exact_match", runtimeMatch: "exact_match", matchId: 3701250,
    compilation: { language: "Solidity", compiler: "solc", compilerVersion: r2.VERSION, fullyQualifiedName: r2.TARGET, compilerSettings: clone(inputSettings) }, sources,
    metadata: { language: "Solidity", compiler: { version: r2.VERSION }, settings: metadataSettings, sources: metadataSources }, stdJsonInput: { language: "Solidity", settings: inputSettings, sources: clone(sources) }, constructorArgs: r2.ADMIN_WORD_HEX,
    deployment: { transactionHash: "0x65ada47b1e29db97b062d601cc2d3d4ba3b4ce8d35b24efd65fd03dd1ca130f0", blockNumber: 2357134 },
    creationBytecode: { recompiledBytecode: creationTemplate, onchainBytecode: `${creationTemplate}${r2.ADMIN_WORD}`, linkReferences: {}, transformations: [{ type: "insert", offset: 4, reason: "constructorArguments" }], transformationValues: { constructorArguments: r2.ADMIN_WORD_HEX } },
    runtimeBytecode: { recompiledBytecode: runtimeTemplate, onchainBytecode: runtime, linkReferences: {}, immutableReferences: refs,
      transformations: r2.IMMUTABLE_STARTS.map(offset => ({ id: "477", type: "replace", offset, reason: "immutable" })), transformationValues: { immutables: { "477": r2.ADMIN_WORD_HEX } } } };
  const output = { contracts: { [r2.TARGET.split(":")[0]]: { [r2.TARGET.split(":")[1]]: { evm: { bytecode: { object: creationTemplate.slice(2), linkReferences: {} }, deployedBytecode: { object: runtimeTemplate.slice(2), linkReferences: {}, immutableReferences: clone(refs) } } } } }, errors: [] };
  const compilerBytes = Buffer.from("offline-fake-native-compiler-r2"), pin = { ...r2.COMPILER_PIN, bytes: compilerBytes.length, sha256: sha(compilerBytes), keccak256: keccak256(compilerBytes).slice(2) };
  const record = { path: pin.filename, version: pin.version, build: pin.build, longVersion: pin.longVersion, sha256: `0x${pin.sha256}`, keccak256: `0x${pin.keccak256}` }, list = { builds: [record], releases: { [pin.version]: pin.filename } };
  const sourcifyBytes = Buffer.from(JSON.stringify(payload)), listBytes = Buffer.from(JSON.stringify(list));
  const transport = async spec => { const body = spec.path.includes("contract/8453") ? sourcifyBytes : spec.path.endsWith("list.json") ? listBytes : compilerBytes; return { status: 200, redirected: false, contentType: spec.kind === "json" ? "application/json" : "application/octet-stream", contentLength: body.length, body }; };
  return { payload, output, compilerBytes, pin, record, list, sourcifyBytes, listBytes, transport };
}
async function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r16-r2-offline-")); try { return await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function options(f, root, extra = {}) {
  return { output: path.join(root, "published"), allowTestOverrides: true, testPinOverride: f.pin, transport: f.transport, compilerRunner: (_executable, _input, safety) => { extra.inspectCompiler?.(safety); return f.output; }, ...extra };
}
function walk(root, prefix = "") {
  const rows = []; for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) { const relative = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) rows.push(...walk(root, relative)); else rows.push(relative); } return rows.sort();
}

test("R2 CLI and output identity are exact", async () => {
  assert.equal(r2.COMMAND, "node tools/run-base-paper-usdplus-aave-pool-proxy-source-r16-r2.js --once"); assert.equal(r2.OUTPUT.endsWith(path.join("base-paper-usdplus-r16", "pool-proxy-authority-r2")), true);
  assert.equal(r2.parseCli(["--once"]), true); for (const args of [[], ["--run-once"], ["--once", "extra"]]) assert.throws(() => r2less(args));
  function r2less(args) { return r2.parseCli(args); }
});

test("R2 refuses output and pin overrides outside explicit tests", async () => {
  const f = fixture(); await assert.rejects(() => r2.recover({ output: path.join(os.tmpdir(), "not-r2"), transport: f.transport }), code("OUTPUT_OVERRIDE_NOT_ALLOWED"));
  await assert.rejects(() => r2.recover({ testPinOverride: f.pin, transport: f.transport }), code("TEST_OVERRIDE_NOT_ALLOWED"));
});

test("request plan is exactly three fixed public requests", () => {
  const plan = r2.requestPlan(); assert.equal(plan.length, 3); assert.deepEqual(plan.map(row => row.hostname), ["sourcify.dev", "binaries.soliditylang.org", "binaries.soliditylang.org"]);
  assert.equal(plan[2].path, `/windows-amd64/${r2.COMPILER_PIN.filename}`); for (const row of plan) assert.equal(r2.validateRequest(row), true);
});

test("request allowlist rejects method host origin path and accept changes", () => {
  for (const mutate of [x => x.method = "POST", x => x.hostname = "example.test", x => x.origin = "http://sourcify.dev", x => x.path = "/wrong", x => x.accept = "*/*", x => x.path += "\\x"]) {
    const row = { ...r2.REQUESTS[0] }; mutate(row); assert.throws(() => r2.validateRequest(row)); }
});

test("bounded fetch rejects redirects status type length body and request caps", async () => {
  const invoke = response => r2.fetchBounded(r2.REQUESTS[0], r2.newBudget(), async () => response);
  await assert.rejects(() => invoke({ status: 302, redirected: true, contentType: "application/json", body: Buffer.alloc(0) }), code("REDIRECT_REJECTED"));
  await assert.rejects(() => invoke({ status: 500, contentType: "application/json", body: Buffer.alloc(0) }), code("HTTP_STATUS_INVALID"));
  await assert.rejects(() => invoke({ status: 200, contentType: "text/plain", body: Buffer.alloc(0) }), code("CONTENT_TYPE_INVALID"));
  await assert.rejects(() => invoke({ status: 200, contentType: "application/json", body: "bad" }), code("RESPONSE_BODY_INVALID"));
  await assert.rejects(() => invoke({ status: 200, contentType: "application/json", contentLength: 2, body: Buffer.alloc(1) }), code("CONTENT_LENGTH_INVALID"));
  const budget = r2.newBudget(); budget.requests = r2.LIMITS.requests; await assert.rejects(() => r2.fetchBounded(r2.REQUESTS[0], budget, async () => null), code("REQUEST_CAP"));
});

test("response and aggregate byte caps fail closed", async () => {
  const responseBudget = r2.newBudget(); await assert.rejects(() => r2.fetchBounded(r2.REQUESTS[0], responseBudget, async () => ({ status: 200, contentType: "application/json", body: Buffer.alloc(r2.LIMITS.responseBytes + 1) })), code("RESPONSE_SIZE_CAP"));
  const totalBudget = r2.newBudget(); totalBudget.bytes = r2.LIMITS.totalBytes; await assert.rejects(() => r2.fetchBounded(r2.REQUESTS[0], totalBudget, async () => ({ status: 200, contentType: "application/json", body: Buffer.alloc(1) })), code("TOTAL_SIZE_CAP"));
});

test("metadata target is mandatory and standard input target is forbidden", () => {
  const missing = fixture().payload; delete missing.metadata.settings.compilationTarget; assert.throws(() => r2.validateSourcify(missing), code("COMPILATION_TARGET_MISMATCH"));
  for (const qualifiedName of ["bad.sol:Bad", "missing-colon", `${r2.TARGET}:Extra`]) { const mismatch = fixture().payload; mismatch.compilation.fullyQualifiedName = qualifiedName; assert.throws(() => r2.validateSourcify(mismatch), code("COMPILATION_TARGET_MISMATCH")); }
  const present = fixture().payload; present.stdJsonInput.settings.compilationTarget = clone(present.metadata.settings.compilationTarget); assert.throws(() => r2.validateSourcify(present), code("STD_INPUT_COMPILATION_TARGET_PRESENT"));
  const compilationPresent = fixture().payload; compilationPresent.compilation.compilerSettings.compilationTarget = clone(compilationPresent.metadata.settings.compilationTarget); assert.throws(() => r2.validateSourcify(compilationPresent), code("COMPILATION_COMPILATION_TARGET_PRESENT"));
});

test("derived standard input still omits compilationTarget", () => {
  const f = fixture(), derived = r2.derivedInput(f.payload.stdJsonInput); assert.equal(Object.prototype.hasOwnProperty.call(derived.input.settings, "compilationTarget"), false);
  const otherwise = clone(derived.input.settings); delete otherwise.outputSelection; assert.deepEqual(otherwise, f.payload.stdJsonInput.settings); assert.equal(derived.derivation.kind, "OUTPUT_SELECTION_ADDITION_ONLY");
});

test("happy response fixture has the exact confirmed compiler and settings shapes", () => {
  const payload = fixture().payload, validated = r2.validateSourcify(payload); assert.equal(payload.metadata.compiler.version, r2.VERSION); assert.equal(payload.compilation.compilerVersion, r2.VERSION);
  assert.deepEqual(Object.keys(payload.metadata.settings).sort(), [...r2.METADATA_SETTING_KEYS].sort()); assert.deepEqual(Object.keys(payload.stdJsonInput.settings).sort(), [...r2.COMPILER_SETTING_KEYS].sort());
  assert.deepEqual(Object.keys(payload.compilation.compilerSettings).sort(), [...r2.COMPILER_SETTING_KEYS].sort()); assert.equal(validated.libraryRows.length, 8);
  assert.equal(Object.values(payload.metadata.settings.libraries).every(value => typeof value === "string"), true); assert.equal(Object.values(payload.stdJsonInput.settings.libraries).every(value => value && typeof value === "object" && !Array.isArray(value)), true);
});

test("metadata and compilation compiler versions are both exact", () => {
  for (const mutate of [x => delete x.metadata.compiler.version, x => x.metadata.compiler.version = "0.8.20+commit.fake", x => x.compilation.compilerVersion = "0.8.20+commit.fake"]) {
    const payload = fixture().payload; mutate(payload); assert.throws(() => r2.validateSourcify(payload)); }
});

test("compilation compilerSettings is mandatory and must agree with standard input", () => {
  const cases = [x => delete x.compilation.compilerSettings, x => x.compilation.compilerSettings.evmVersion = "london",
    x => x.compilation.compilerSettings.remappings.push("x=y"), x => x.compilation.compilerSettings.libraries[r2.EXPECTED_LIBRARY_IDENTITIES[0].split(":")[0]].BorrowLogic = `0x${"99".repeat(20)}`];
  for (const mutate of cases) { const payload = fixture().payload; mutate(payload); assert.throws(() => r2.validateSourcify(payload)); }
});

test("unexpected fetched setting keys and forbidden compiler-input keys reject", () => {
  const cases = [x => x.metadata.settings.unexpected = true, x => x.metadata.settings.viaIR = false, x => x.metadata.settings.outputSelection = {}, x => x.stdJsonInput.settings.unexpected = true,
    x => x.stdJsonInput.settings.viaIR = false, x => x.stdJsonInput.settings.outputSelection = {}, x => x.compilation.compilerSettings.unexpected = true, x => x.compilation.compilerSettings.viaIR = false,
    x => x.compilation.compilerSettings.outputSelection = {}, x => x.compilation.compilerSettings.compilationTarget = clone(x.metadata.settings.compilationTarget)];
  for (const mutate of cases) { const payload = fixture().payload; mutate(payload); assert.throws(() => r2.validateSourcify(payload)); }
});

test("metadata flat library keys split at the final colon and reject malformed forms", () => {
  assert.deepEqual(r2.splitFullyQualifiedName("C:/path/File.sol:Lib"), { source: "C:/path/File.sol", name: "Lib", identity: "C:/path/File.sol:Lib" });
  for (const key of ["NoColon", ":Lib", "path.sol:", "path.sol:1Bad", "path.sol:bad-name"]) assert.throws(() => r2.splitFullyQualifiedName(key), code("FULLY_QUALIFIED_NAME_INVALID"));
  const make = () => clone(fixture().payload.metadata.settings.libraries), first = r2.EXPECTED_LIBRARY_IDENTITIES[0];
  const mutations = [x => { const value = x[first]; delete x[first]; x.NoColon = value; }, x => x[first] = { nested: true }, x => x[first] = "bad", x => delete x[first],
    x => x["extra.sol:Extra"] = `0x${"11".repeat(20)}`];
  for (const mutate of mutations) { const libraries = make(); mutate(libraries); assert.throws(() => r2.normalizeMetadataLibraries(libraries)); }
  const mixed = make(); mixed[first] = { BorrowLogic: mixed[first] }; assert.throws(() => r2.normalizeMetadataLibraries(mixed), code("METADATA_LIBRARY_VALUE_INVALID"));
});

test("nested library maps reject malformed rows leaves addresses and identity sets", () => {
  const firstIdentity = r2.EXPECTED_LIBRARY_IDENTITIES[0], { source, name } = r2.splitFullyQualifiedName(firstIdentity), make = () => clone(fixture().payload.stdJsonInput.settings.libraries);
  const mutations = [x => x[source] = `0x${"11".repeat(20)}`, x => x[source] = [], x => x[""] = { Extra: `0x${"11".repeat(20)}` }, x => x[source][name] = { nested: true },
    x => x[source][name] = [], x => x[source][name] = "bad", x => { x[source]["1Bad"] = x[source][name]; delete x[source][name]; }, x => delete x[source][name], x => x[source].Extra = `0x${"11".repeat(20)}`];
  for (const mutate of mutations) { const libraries = make(); mutate(libraries); assert.throws(() => r2.normalizeNestedLibraries(libraries)); }
});

test("all canonical library identities and addresses must agree", () => {
  const identity = r2.EXPECTED_LIBRARY_IDENTITIES[0], { source, name } = r2.splitFullyQualifiedName(identity);
  for (const mutate of [x => x.metadata.settings.libraries[identity] = `0x${"99".repeat(20)}`, x => x.stdJsonInput.settings.libraries[source][name] = `0x${"99".repeat(20)}`,
    x => x.compilation.compilerSettings.libraries[source][name] = `0x${"99".repeat(20)}`]) { const payload = fixture().payload; mutate(payload); assert.throws(() => r2.validateSourcify(payload)); }
  assert.throws(() => r2.canonicalLibraryRows([{ source, name, identity, address: r2.ADMIN }, { source, name, identity, address: r2.ADMIN }], "BAD"), code("LIBRARY_IDENTITY_DUPLICATE"));
  const caseOnly = fixture().payload; caseOnly.metadata.settings.libraries[identity] = `0x${caseOnly.metadata.settings.libraries[identity].slice(2).toUpperCase()}`;
  caseOnly.stdJsonInput.settings.libraries[source][name] = `0x${caseOnly.stdJsonInput.settings.libraries[source][name].slice(2).toUpperCase()}`; assert.doesNotThrow(() => r2.validateSourcify(caseOnly));
});

test("canonical object key reordering is accepted while remapping order is preserved", () => {
  const payload = fixture().payload, reorder = value => Object.fromEntries(Object.entries(value).reverse()); payload.metadata.settings = reorder(payload.metadata.settings); payload.metadata.settings.libraries = reorder(payload.metadata.settings.libraries);
  payload.stdJsonInput.settings = reorder(payload.stdJsonInput.settings); payload.stdJsonInput.settings.libraries = reorder(payload.stdJsonInput.settings.libraries); payload.compilation.compilerSettings = reorder(payload.compilation.compilerSettings);
  assert.doesNotThrow(() => r2.validateSourcify(payload));
  const remapped = fixture().payload; for (const settings of [remapped.metadata.settings, remapped.stdJsonInput.settings, remapped.compilation.compilerSettings]) settings.remappings = ["a=b", "c=d"]; assert.doesNotThrow(() => r2.validateSourcify(remapped));
  remapped.compilation.compilerSettings.remappings.reverse(); assert.throws(() => r2.validateSourcify(remapped), code("COMPILER_SETTINGS_DISAGREEMENT"));
  const metadataOrder = fixture().payload; for (const settings of [metadataOrder.metadata.settings, metadataOrder.stdJsonInput.settings, metadataOrder.compilation.compilerSettings]) settings.remappings = ["a=b", "c=d"];
  metadataOrder.metadata.settings.remappings.reverse(); assert.throws(() => r2.validateSourcify(metadataOrder), code("ORDINARY_SETTINGS_DISAGREEMENT"));
});

test("Sourcify identity settings sources hashes and libraries remain closed", () => {
  const first = r2.splitFullyQualifiedName(r2.EXPECTED_LIBRARY_IDENTITIES[0]);
  const cases = [x => x.matchId++, x => x.runtimeMatch = "partial_match", x => x.stdJsonInput.settings.optimizer.runs++, x => delete x.sources[r2.SOURCES[0]],
    x => x.sources[r2.SOURCES[0]].content += "x", x => x.metadata.sources[r2.SOURCES[0]].keccak256 = `0x${"00".repeat(32)}`, x => delete x.stdJsonInput.settings.libraries[first.source][first.name]];
  for (const mutate of cases) { const payload = fixture().payload; mutate(payload); assert.throws(() => r2.validateSourcify(payload)); }
});

test("source inventory includes normalized bytes SHA-256 and Keccak-256", () => {
  const f = fixture(), validated = r2.validateSourcify(f.payload); assert.equal(validated.sourceRows.length, 6);
  for (const row of validated.sourceRows) { const bytes = Buffer.from(row.content); assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, sha(bytes)); assert.equal(row.keccak256, keccak256(bytes)); assert.equal(r2.safeSourcePath(row.path), row.path); }
});

test("runtime immutable references require exact ordered 32-byte entries", () => {
  const f = fixture(); assert.deepEqual(r2.immutableReferences(f.payload.runtimeBytecode.immutableReferences).map(row => row.start), r2.IMMUTABLE_STARTS);
  const mutations = [x => x["477"][0].length = 20, x => x["477"][0].start++, x => x["477"].reverse(), x => x["477"].push(clone(x["477"][0])), x => x["477"][1] = clone(x["477"][0]), x => x["478"] = []];
  for (const mutate of mutations) { const refs = clone(f.payload.runtimeBytecode.immutableReferences); mutate(refs); assert.throws(() => r2.immutableReferences(refs), code("IMMUTABLE_REFERENCES_MISMATCH")); }
});

test("runtime immutable value accepts only nested exact 32-byte padded word", () => {
  const f = fixture(); assert.equal(r2.immutableWord(f.payload.runtimeBytecode).equals(word), true);
  const mutations = [x => x.transformationValues = { "477": r2.ADMIN_WORD_HEX }, x => x.transformationValues.immutables["477"] = r2.ADMIN,
    x => x.transformationValues.immutables["477"] = `0x11${r2.ADMIN_WORD.slice(2)}`, x => x.transformationValues.immutables["478"] = r2.ADMIN_WORD_HEX];
  for (const mutate of mutations) { const section = clone(f.payload.runtimeBytecode); mutate(section); assert.throws(() => r2.immutableWord(section)); }
});

test("runtime immutable transformations may be absent but if present are exact", () => {
  const f = fixture(); assert.doesNotThrow(() => r2.validateImmutableTransformations(f.payload.runtimeBytecode)); const absent = clone(f.payload.runtimeBytecode); delete absent.transformations; assert.doesNotThrow(() => r2.validateImmutableTransformations(absent));
  const mutations = [x => x[0].offset++, x => x.reverse(), x => x.push(clone(x[0])), x => x[1] = clone(x[0]), x => x[0].id = "478", x => x[0].type = "insert", x => x[0].reason = "other", x => x[0].extra = true];
  for (const mutate of mutations) { const section = clone(f.payload.runtimeBytecode); mutate(section.transformations); assert.throws(() => r2.validateImmutableTransformations(section), code("IMMUTABLE_TRANSFORMATION_MISMATCH")); }
});

test("build copies the complete immutable word at all six offsets", () => {
  const f = fixture(), build = r2.validateBuild(f.payload, f.output), bytes = Buffer.from(build.runtime.slice(2), "hex"); for (const start of r2.IMMUTABLE_STARTS) assert.equal(bytes.subarray(start, start + 32).equals(word), true);
  assert.equal(build.runtimeSha256, sha(bytes)); assert.equal(build.runtimeKeccak256, keccak256(bytes));
});

test("compiled and Sourcify immutable reference shapes must both match", () => {
  const f = fixture(), compiled = clone(f.output); compiled.contracts[r2.TARGET.split(":")[0]][r2.TARGET.split(":")[1]].evm.deployedBytecode.immutableReferences["477"][0].length = 20; assert.throws(() => r2.validateBuild(f.payload, compiled), code("IMMUTABLE_REFERENCES_MISMATCH"));
});

test("constructor and bytecode reconstruction remain exact", () => {
  const f = fixture(); for (const mutate of [x => x.creationBytecode.transformations[0].type = "replace", x => x.creationBytecode.onchainBytecode = "0x00", x => x.runtimeBytecode.onchainBytecode = "0x00"]) {
    const payload = clone(f.payload); mutate(payload); assert.throws(() => r2.validateBuild(payload, f.output)); }
});

test("hard-coded compiler pin has reviewed independent values", () => {
  assert.deepEqual(r2.COMPILER_PIN, { filename: "solc-windows-amd64-v0.8.19+commit.7dd6d404.exe", bytes: 9150464, sha256: "00d3b5ca64b097964ed6d70d9805a63fdd27113b07c1b2559dbfdd579f994508",
    keccak256: "da3dcff0fe9e3297d99ec184afab49b0eb0a95ce88ef3f44587618445cbe6546", version: "0.8.19", build: "commit.7dd6d404", longVersion: r2.VERSION });
});

test("official compiler list must independently match every hard-coded pin", () => {
  const real = { path: r2.COMPILER_PIN.filename, version: r2.COMPILER_PIN.version, build: r2.COMPILER_PIN.build, longVersion: r2.VERSION, sha256: `0x${r2.COMPILER_PIN.sha256}`, keccak256: `0x${r2.COMPILER_PIN.keccak256}` };
  assert.deepEqual(r2.selectCompiler({ builds: [real], releases: { "0.8.19": real.path } }), real);
  for (const field of ["path", "version", "build", "sha256", "keccak256"]) { const row = { ...real, [field]: field.includes("256") ? `0x${"00".repeat(32)}` : "wrong" }; assert.throws(() => r2.selectCompiler({ builds: [row], releases: { "0.8.19": row.path } })); }
});

test("actual compiler bytes require pinned length and both hashes", () => {
  const f = fixture(); assert.equal(r2.validateCompilerBytes(f.compilerBytes, f.record, f.pin), true);
  for (const bytes of [Buffer.concat([f.compilerBytes, Buffer.from([0])]), Buffer.from(f.compilerBytes).fill(1)]) assert.throws(() => r2.validateCompilerBytes(bytes, f.record, f.pin), code("COMPILER_BINARY_PIN_MISMATCH"));
});

test("self-consistent forged list and binary fail hard-coded pin before native execution", async () => withTemp(async root => {
  const f = fixture(); let executed = false, downloads = 0; const transport = async spec => { downloads++; const body = spec.path.includes("contract/8453") ? f.sourcifyBytes : f.listBytes; return { status: 200, redirected: false, contentType: "application/json", body }; };
  await assert.rejects(() => r2.recover({ output: path.join(root, "out"), allowTestOverrides: true, transport, compilerRunner: () => { executed = true; } }), code("COMPILER_LIST_PIN_MISMATCH"));
  assert.equal(downloads, 2); assert.equal(executed, false); assert.equal(fs.existsSync(path.join(root, "out")), false);
}));

test("real staging branch succeeds with fake pinned bytes and fixed compiler safety", async () => withTemp(async root => {
  const f = fixture(); let safety; const result = await r2.recover(options(f, root, { inspectCompiler: value => { safety = value; } })); const output = path.join(root, "published");
  assert.equal(fs.existsSync(path.join(output, "authority.json")), true); assert.deepEqual(safety, { versionArgv: ["--version"], compileArgv: ["--standard-json"], shell: false, env: {} }); assert.equal(result.authority.requests.count, 3);
  assert.equal(result.authority.requests.bytes, result.authority.requests.responses.reduce((sum, row) => sum + row.bytes, 0));
}));

test("existing destination rejects without creating staging", async () => withTemp(async root => {
  const f = fixture(), output = path.join(root, "published"); fs.mkdirSync(output); fs.writeFileSync(path.join(output, "sentinel"), "keep"); await assert.rejects(() => r2.recover(options(f, root)), code("OUTPUT_EXISTS_NO_OVERWRITE")); assert.equal(fs.readFileSync(path.join(output, "sentinel"), "utf8"), "keep");
  assert.equal(fs.readdirSync(root).some(name => name.includes("stage")), false);
}));

test("mid-bundle write failure cleans invocation-owned stage and publishes nothing", async () => withTemp(async root => {
  const f = fixture(); await assert.rejects(() => r2.recover(options(f, root, { testFault: { writeRelative: "metadata.json" } })), code("INJECTED_WRITE_FAILURE")); assert.deepEqual(fs.readdirSync(root), []);
}));

test("rename failure cleans invocation-owned stage and publishes nothing", async () => withTemp(async root => {
  const f = fixture(); await assert.rejects(() => r2.recover(options(f, root, { testFault: { rename: true } })), code("INJECTED_RENAME_FAILURE")); assert.deepEqual(fs.readdirSync(root), []);
}));

test("late destination collision is not overwritten and owned stage is cleaned", async () => withTemp(async root => {
  const f = fixture(), output = path.join(root, "published"), testFault = { beforeRename: destination => { fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "sentinel"), "keep"); } };
  await assert.rejects(() => r2.recover(options(f, root, { testFault })), code("OUTPUT_EXISTS_NO_OVERWRITE")); assert.equal(fs.readFileSync(path.join(output, "sentinel"), "utf8"), "keep");
  assert.equal(fs.readdirSync(root).some(name => name.includes("stage")), false);
}));

test("compiler execution failure cleans invocation-owned stage", async () => withTemp(async root => {
  const f = fixture(), opts = options(f, root); opts.compilerRunner = () => { throw new r2.AuthorityError("COMPILER", "FAKE_EXECUTION_FAILURE"); }; await assert.rejects(() => r2.recover(opts), code("FAKE_EXECUTION_FAILURE")); assert.deepEqual(fs.readdirSync(root), []);
}));

test("forced staging collision preserves the pre-existing path", async () => withTemp(async root => {
  const f = fixture(), collision = path.join(root, "collision"); fs.mkdirSync(collision); fs.writeFileSync(path.join(collision, "sentinel"), "keep"); await assert.rejects(() => r2.recover(options(f, root, { testStagePath: collision })), code("STAGE_COLLISION"));
  assert.equal(fs.readFileSync(path.join(collision, "sentinel"), "utf8"), "keep"); assert.equal(fs.existsSync(path.join(root, "published")), false);
}));

test("authority inventory binds every other published file and exact bytes", async () => withTemp(async root => {
  const f = fixture(); await r2.recover(options(f, root)); const output = path.join(root, "published"), authority = JSON.parse(fs.readFileSync(path.join(output, "authority.json"), "utf8"));
  const files = walk(output).filter(relative => relative !== "authority.json"), listed = authority.artifacts.map(row => row.path); assert.deepEqual(listed, [...files].sort((a, b) => a.localeCompare(b))); assert.equal(new Set(listed.map(value => value.toLowerCase())).size, listed.length);
  for (const row of authority.artifacts) { const bytes = fs.readFileSync(path.join(output, ...row.path.split("/"))); assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, sha(bytes)); assert.equal(r2.safeRelativePath(row.path, "ARTIFACT_PATH_INVALID"), row.path); }
}));

test("inventory rejects missing unlisted duplicate unsafe and byte mismatch entries", () => {
  const artifacts = new Map([["a.json", Buffer.from("a")], ["nested/b.hex", Buffer.from("bb")]]), valid = r2.artifactInventory(artifacts); assert.equal(r2.validateInventory(valid, artifacts), true);
  for (const rows of [valid.slice(1), [...valid, valid[0]], valid.map((row, index) => index ? row : { ...row, bytes: 99 }), valid.map((row, index) => index ? row : { ...row, path: "../a.json" })]) assert.throws(() => r2.validateInventory(rows, artifacts), code("ARTIFACT_INVENTORY_INVALID"));
  assert.throws(() => r2.artifactInventory(new Map([["A", Buffer.from("a")], ["a", Buffer.from("b")]])), code("ARTIFACT_INVENTORY_INVALID"));
});

test("authority includes exact R1 and P0 lineage without inferring executed bytes", async () => withTemp(async root => {
  const f = fixture(), { authority } = await r2.recover(options(f, root)); assert.deepEqual(authority.lineage, clone(r2.LINEAGE)); assert.equal(authority.lineage.r1Provenance.executedPreCorrectionRunnerBytes, null); assert.equal(authority.lineage.r1Provenance.executedPreCorrectionRunnerSha256, null);
  assert.equal(authority.lineage.r1Provenance.executedPreCorrectionIdentityInferred, false); assert.equal(authority.lineage.r1Provenance.currentR1IsExecutedByteIdentity, false);
}));

test("authority states compiler pin limitations without attestation claims", async () => withTemp(async root => {
  const f = fixture(), { authority } = await r2.recover(options(f, root)); assert.equal(authority.compilerPin.listIsPinAuthority, false); assert.equal(authority.compilerPin.signatureVerified, false); assert.equal(authority.compilerPin.independentPublisherAttestation, false);
  assert.equal(authority.compilerPin.sha256, r2.COMPILER_PIN.sha256); assert.equal(authority.compilerPin.bytes, r2.COMPILER_PIN.bytes);
}));

test("authority makes no target-state gate economics route signing or profit claim", async () => withTemp(async root => {
  const f = fixture(), { authority } = await r2.recover(options(f, root)), inspected = clone(authority); delete inspected.lineage.r1Provenance.didNotOccur;
  const text = JSON.stringify(inspected); assert.equal(/currentState|G[1-6]|redemption|economics|route|signing|profit|fork|RPC/i.test(text), false); assert.equal(authority.limitations.liveCodeCompared, false); assert.equal(authority.limitations.freshStateEstablished, false);
}));

test("runner source has no endpoint inventory wallet package lifecycle or shell execution", () => {
  const source = fs.readFileSync(require.resolve("./run-base-paper-usdplus-aave-pool-proxy-source-r16-r2"), "utf8"); assert.equal(/rpc_endpoints|graphql_endpoints|\.env|wallet|npm |pnpm |yarn |shell:\s*true/.test(source), false);
});
