"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");
const { keccak256, toUtf8Bytes } = require("ethers");
const r16 = require("./run-base-paper-usdplus-aave-pool-proxy-source-r16");

const clone = value => JSON.parse(JSON.stringify(value));
const code = expected => error => error?.code === expected;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const libraries = { [r16.SOURCES[0]]: Object.fromEntries(r16.EXPECTED_LIBRARY_NAMES.map((name, index) => [name, `0x${(index + 1).toString(16).padStart(40, "0")}`])) };
  const metadataSettings = { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", metadata: { bytecodeHash: "ipfs" }, compilationTarget: { [r16.TARGET.split(":")[0]]: r16.TARGET.split(":")[1] }, libraries };
  const inputSettings = clone(metadataSettings); delete inputSettings.compilationTarget;
  const sources = Object.fromEntries(r16.SOURCES.map((path, index) => [path, { content: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.19;\n// ${index}\n` }]));
  const metadataSources = Object.fromEntries(r16.SOURCES.map(path => [path, { keccak256: keccak256(toUtf8Bytes(sources[path].content)) }]));
  const runtimeTemplate = Buffer.alloc(1300), admin = Buffer.from(r16.ADMIN.slice(2), "hex"); for (const start of r16.IMMUTABLE_STARTS) admin.copy(runtimeTemplate, start);
  const runtimeOnchain = `0x${runtimeTemplate.toString("hex")}`, runtimeRecompiled = `0x${Buffer.alloc(1300).toString("hex")}`, creation = "0x60006000";
  const immutableReferences = { "477": r16.IMMUTABLE_STARTS.map(start => ({ start, length: 20 })) };
  const payload = { chainId: "8453", address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", match: "exact_match", creationMatch: "exact_match", runtimeMatch: "exact_match", matchId: 3701250,
    compilation: { language: "Solidity", compiler: "solc", compilerVersion: r16.VERSION, fullyQualifiedName: r16.TARGET }, sources,
    metadata: { language: "Solidity", settings: metadataSettings, sources: metadataSources }, stdJsonInput: { language: "Solidity", settings: inputSettings, sources: clone(sources) }, constructorArgs: `0x${r16.ADMIN_WORD}`,
    deployment: { transactionHash: "0x65ada47b1e29db97b062d601cc2d3d4ba3b4ce8d35b24efd65fd03dd1ca130f0", blockNumber: 2357134 },
    creationBytecode: { recompiledBytecode: creation, onchainBytecode: `${creation}${r16.ADMIN_WORD}`, linkReferences: {}, transformations: [{ id: "constructorArguments", offset: 4, reason: "constructorArguments" }], transformationValues: { constructorArguments: `0x${r16.ADMIN_WORD}` } },
    runtimeBytecode: { recompiledBytecode: runtimeRecompiled, onchainBytecode: runtimeOnchain, linkReferences: {}, immutableReferences,
      transformations: r16.IMMUTABLE_STARTS.map(start => ({ id: "477", offset: start, reason: "immutable" })), transformationValues: { "477": r16.ADMIN } } };
  const output = { contracts: { [r16.TARGET.split(":")[0]]: { [r16.TARGET.split(":")[1]]: { evm: { bytecode: { object: creation.slice(2), linkReferences: {} }, deployedBytecode: { object: runtimeRecompiled.slice(2), linkReferences: {}, immutableReferences } } } } }, errors: [] };
  const compilerBytes = Buffer.from("synthetic-public-compiler"), record = { path: "solc-windows-amd64-v0.8.19+commit.7dd6d404.exe", version: "0.8.19", build: "commit.7dd6d404", longVersion: r16.VERSION,
    sha256: `0x${sha(compilerBytes)}`, keccak256: keccak256(compilerBytes) };
  const list = { builds: [record], releases: { "0.8.19": record.path } };
  const transport = async spec => { const value = spec.path.includes("contract/8453") ? Buffer.from(JSON.stringify(payload)) : spec.path.endsWith("list.json") ? Buffer.from(JSON.stringify(list)) : compilerBytes;
    return { status: 200, redirected: false, contentType: spec.kind === "json" ? "application/json" : "application/octet-stream", contentLength: value.length, body: value }; };
  return { payload, output, compilerBytes, record, list, transport };
}
async function recoverWith(f, overrides = {}) {
  let published; const result = await r16.recover({ exists: () => false, transport: f.transport, compilerRunner: (_exe, _input, safety) => { overrides.inspectCompiler?.(safety); return f.output; }, publisher: bundle => { published = bundle; }, ...overrides });
  return { result, published };
}

test("CLI is exact and output is no-overwrite", async () => {
  assert.equal(r16.parseCli(["--once"]), true); for (const argv of [[], ["--run-once"], ["--once", "x"]]) assert.throws(() => r16.parseCli(argv));
  await assert.rejects(() => r16.recover({ exists: () => true }), code("OUTPUT_EXISTS_NO_OVERWRITE"));
});

test("happy path binds exact public source compiler and reconstructed runtime", async () => {
  const f = fixture(), { result, published } = await recoverWith(f); assert.equal(result.authority.classification, "EXACT_AAVE_POOL_PROXY_SOURCE_BUILD_RUNTIME_BOUND"); assert.equal(published, result);
  assert.equal(result.authority.requests.count, 3); assert.equal(result.authority.sourceCount, 6); assert.equal(result.authority.libraryCount, 8); assert.equal(result.authority.runtime.bytes, 1300);
  assert.equal(result.authority.exactLimitations.currentOnchainCodeClaim, false); assert.equal(result.authority.exactLimitations.repositoryCommitKnown, false);
});

test("request allowlist rejects host path method and unsafe forms", () => {
  const good = r16.REQUESTS[0]; for (const mutate of [x => x.hostname = "other.example", x => x.origin = "http://sourcify.dev", x => x.method = "POST", x => x.path = "/wrong", x => x.accept = "*/*"])
    { const value = { ...good }; mutate(value); assert.throws(() => r16.validateRequest(value)); }
  assert.equal(r16.requestPlan("solc-windows-amd64-v0.8.19+commit.7dd6d404.exe").length, 3);
});

test("bounded fetch rejects redirects status type length body response and total caps", async () => {
  const spec = r16.REQUESTS[0], invoke = response => r16.fetchBounded(spec, r16.newBudget(), async () => response);
  await assert.rejects(() => invoke({ status: 302, redirected: true, body: Buffer.alloc(0), contentType: "application/json" }), code("REDIRECT_REJECTED"));
  await assert.rejects(() => invoke({ status: 500, body: Buffer.alloc(0), contentType: "application/json" }), code("HTTP_STATUS_INVALID"));
  await assert.rejects(() => invoke({ status: 200, body: Buffer.alloc(0), contentType: "text/plain" }), code("CONTENT_TYPE_INVALID"));
  await assert.rejects(() => invoke({ status: 200, body: "x", contentType: "application/json" }), code("RESPONSE_BODY_INVALID"));
  await assert.rejects(() => invoke({ status: 200, body: Buffer.alloc(1), contentLength: 2, contentType: "application/json" }), code("CONTENT_LENGTH_INVALID"));
  const budget = r16.newBudget(); budget.requests = r16.LIMITS.requests; await assert.rejects(() => r16.fetchBounded(spec, budget, async () => null), code("REQUEST_CAP"));
  const total = r16.newBudget(); total.bytes = r16.LIMITS.totalBytes; await assert.rejects(() => r16.fetchBounded(spec, total, async () => ({ status: 200, body: Buffer.alloc(1), contentType: "application/json" })), code("TOTAL_SIZE_CAP"));
});

test("Sourcify match id exact statuses chain address and target are fixed", () => {
  const mutations = [[x => x.matchId++, "MATCH_ID_MISMATCH"], [x => x.match = "partial_match", "EXACT_MATCH_REQUIRED"], [x => x.creationMatch = "partial_match", "EXACT_MATCH_REQUIRED"],
    [x => x.runtimeMatch = "partial_match", "EXACT_MATCH_REQUIRED"], [x => x.chainId = 1, "CHAIN_OR_ADDRESS_MISMATCH"], [x => x.address = r16.ADMIN, "CHAIN_OR_ADDRESS_MISMATCH"],
    [x => x.compilation.fullyQualifiedName = "bad:X", "COMPILER_IDENTITY_MISMATCH"]];
  for (const [mutate, expected] of mutations) { const value = fixture().payload; mutate(value); assert.throws(() => r16.validateSourcify(value), code(expected)); }
});

test("compiler language version optimizer EVM metadata viaIR and target fail closed", () => {
  const mutations = [x => x.compilation.compilerVersion = "0.8.20", x => x.compilation.compiler = "vyper", x => x.stdJsonInput.language = "Vyper", x => x.stdJsonInput.settings.optimizer.enabled = false,
    x => x.stdJsonInput.settings.optimizer.runs = 201, x => x.stdJsonInput.settings.evmVersion = "london", x => x.stdJsonInput.settings.metadata.bytecodeHash = "none", x => x.stdJsonInput.settings.viaIR = true,
    x => x.metadata.settings.compilationTarget = { "bad.sol": "Bad" }];
  for (const mutate of mutations) { const value = fixture().payload; mutate(value); assert.throws(() => r16.validateSourcify(value)); }
});

test("library map must match metadata and contain all eight expected identities", () => {
  for (const mutate of [x => delete x.stdJsonInput.settings.libraries[r16.SOURCES[0]].BorrowLogic, x => x.stdJsonInput.settings.libraries[r16.SOURCES[0]].BorrowLogic = "bad",
    x => x.metadata.settings.libraries[r16.SOURCES[0]].BorrowLogic = r16.ADMIN]) { const value = fixture().payload; mutate(value); assert.throws(() => r16.validateSourcify(value)); }
});

test("source set content hashes path safety duplicates and case collisions reject", () => {
  const cases = [x => delete x.sources[r16.SOURCES[0]], x => x.sources[r16.SOURCES[0]].content += "x", x => x.metadata.sources[r16.SOURCES[0]].keccak256 = `0x${"00".repeat(32)}`,
    x => { x.sources["../escape.sol"] = x.sources[r16.SOURCES[0]]; }, x => { x.sources[r16.SOURCES[0].toUpperCase()] = x.sources[r16.SOURCES[0]]; }];
  for (const mutate of cases) { const value = fixture().payload; mutate(value); assert.throws(() => r16.validateSourcify(value)); }
  for (const value of ["/absolute.sol", "a\\b.sol", "a/../b.sol", "a//b.sol"]) assert.throws(() => r16.safeSourcePath(value), code("SOURCE_PATH_INVALID"));
});

test("constructor admin deployment transaction and block are exact", () => {
  const cases = [[x => x.constructorArgs = `0x${"00".repeat(32)}`, "CONSTRUCTOR_ARGUMENT_MISMATCH"], [x => x.deployment.transactionHash = `0x${"00".repeat(32)}`, "DEPLOYMENT_IDENTITY_MISMATCH"],
    [x => x.deployment.blockNumber++, "DEPLOYMENT_IDENTITY_MISMATCH"]]; for (const [mutate, expected] of cases) { const value = fixture().payload; mutate(value); assert.throws(() => r16.validateSourcify(value), code(expected)); }
});

test("official compiler list and release identity are exact", () => {
  const f = fixture(); assert.equal(r16.selectCompiler(f.list).longVersion, r16.VERSION);
  for (const mutate of [x => x.builds[0].longVersion = "0.8.20", x => x.builds.push(clone(x.builds[0])), x => x.builds[0].path = "other.exe", x => x.releases["0.8.19"] = "other.exe", x => x.builds[0].sha256 = "bad"])
    { const value = clone(f.list); mutate(value); assert.throws(() => r16.selectCompiler(value)); }
});

test("compiler bytes require both official SHA-256 and Keccak", () => {
  const f = fixture(); assert.equal(r16.validateCompilerBytes(f.compilerBytes, f.record), true); assert.throws(() => r16.validateCompilerBytes(Buffer.from("wrong"), f.record), code("COMPILER_BINARY_HASH_MISMATCH"));
  const shaWrong = { ...f.record, sha256: `0x${"00".repeat(32)}` }; assert.throws(() => r16.validateCompilerBytes(f.compilerBytes, shaWrong));
  const keccakWrong = { ...f.record, keccak256: `0x${"00".repeat(32)}` }; assert.throws(() => r16.validateCompilerBytes(f.compilerBytes, keccakWrong));
});

test("derived compiler input changes only deterministic output selection", () => {
  const f = fixture(), before = clone(f.payload.stdJsonInput), derived = r16.derivedInput(before); assert.deepEqual(derived.input.sources, before.sources);
  const settings = clone(derived.input.settings); delete settings.outputSelection; assert.deepEqual(settings, before.settings); assert.equal(derived.derivation.kind, "OUTPUT_SELECTION_ADDITION_ONLY");
});

test("compile errors and missing target reject", () => {
  const f = fixture(), errors = clone(f.output); errors.errors = [{ severity: "error", formattedMessage: "synthetic" }]; assert.throws(() => r16.validateBuild(f.payload, errors), code("COMPILER_ERRORS"));
  const missing = clone(f.output); missing.contracts = {}; assert.throws(() => r16.validateBuild(f.payload, missing), code("COMPILE_TARGET_MISSING"));
});

test("creation and runtime templates must equal Sourcify", () => {
  const f = fixture(); for (const mutate of [x => x.creationBytecode.recompiledBytecode = "0x61", x => x.runtimeBytecode.recompiledBytecode = "0x61"])
    { const value = clone(f.payload); mutate(value); assert.throws(() => r16.validateBuild(value, f.output)); }
});

test("link and immutable reference mismatch reject", () => {
  const f = fixture(), linked = clone(f.output); linked.contracts[r16.TARGET.split(":")[0]][r16.TARGET.split(":")[1]].evm.bytecode.linkReferences = { x: {} }; assert.throws(() => r16.validateBuild(f.payload, linked), code("LINK_REFERENCES_PRESENT"));
  const refs = clone(f.output); refs.contracts[r16.TARGET.split(":")[0]][r16.TARGET.split(":")[1]].evm.deployedBytecode.immutableReferences["477"][0].start++; assert.throws(() => r16.validateBuild(f.payload, refs), code("IMMUTABLE_REFERENCES_MISMATCH"));
});

test("constructor transformation offset value and reconstruction reject", () => {
  const f = fixture(); for (const mutate of [x => x.creationBytecode.transformations[0].offset++, x => x.creationBytecode.transformationValues.constructorArguments = "0x00", x => x.creationBytecode.onchainBytecode = "0x00"])
    { const value = clone(f.payload); mutate(value); assert.throws(() => r16.validateBuild(value, f.output)); }
});

test("immutable id offsets values and runtime reconstruction reject", () => {
  const f = fixture(); for (const mutate of [x => x.runtimeBytecode.transformations[0].id = "478", x => x.runtimeBytecode.transformations[0].offset++, x => x.runtimeBytecode.transformationValues["477"] = r16.TARGET_ADDRESS,
    x => x.runtimeBytecode.onchainBytecode = "0x00"]) { const value = clone(f.payload); mutate(value); assert.throws(() => r16.validateBuild(value, f.output)); }
});

test("happy reconstruction records six immutable locations and exact hashes", () => {
  const f = fixture(), out = r16.validateBuild(f.payload, f.output); assert.deepEqual(out.immutableReferences.map(row => row.start), r16.IMMUTABLE_STARTS); assert.equal(out.runtimeBytes, 1300);
  assert.equal(out.runtimeSha256, sha(Buffer.from(out.runtime.slice(2), "hex"))); assert.equal(out.runtimeKeccak256, keccak256(out.runtime));
});

test("request count byte totals and compiler argv shell environment safety are explicit", async () => {
  const f = fixture(); let observed; const { result } = await recoverWith(f, { inspectCompiler: value => { observed = value; } }); assert.deepEqual(observed, { shell: false, env: {}, argv: ["--standard-json"] });
  assert.equal(result.authority.requests.count, 3); assert.equal(result.authority.requests.bytes, result.authority.requests.responses.reduce((sum, row) => sum + row.bytes, 0));
});

test("partial staging failure invokes cleanup and never publish", async () => {
  const f = fixture(), events = [], stageAdapter = { prepare: () => ({ stage: "opaque-stage", executable: "opaque-solc", identity: { path: "toolchain/solc-0.8.19.exe", bytes: f.compilerBytes.length, sha256: sha(f.compilerBytes), keccak256: keccak256(f.compilerBytes), version: r16.VERSION, officialPath: f.record.path } }),
    publish: () => { events.push("publish"); throw new Error("synthetic"); }, cleanup: stage => events.push(`cleanup:${stage}`) };
  await assert.rejects(() => r16.recover({ exists: () => false, transport: f.transport, compilerRunner: () => f.output, stageAdapter })); assert.deepEqual(events, ["publish", "cleanup:opaque-stage"]);
});

test("all failure results preserve no real output in injected mode", async () => {
  const f = fixture(); f.payload.matchId++; const transport = async spec => ({ status: 200, redirected: false, contentType: "application/json", body: Buffer.from(JSON.stringify(f.payload)) });
  let published = false; await assert.rejects(() => r16.recover({ exists: () => false, transport, compilerRunner: () => f.output, publisher: () => { published = true; } }), code("MATCH_ID_MISMATCH")); assert.equal(published, false);
});

test("authority makes no RPC current-state fork route economics or signing claims", async () => {
  const f = fixture(), { result } = await recoverWith(f), text = JSON.stringify(result.authority), forbidden = /(?:rpc|currentState|fork|route|profit|quote|signing|broadcast|wallet)/i;
  assert.equal(forbidden.test(text), false); assert.equal(result.authority.exactLimitations.currentOnchainCodeClaim, false); assert.equal(result.authority.exactLimitations.freshStateClaim, false);
});

test("runner source contains no inventory wallet lifecycle shell or extra-host paths", () => {
  const source = fs.readFileSync(require.resolve("./run-base-paper-usdplus-aave-pool-proxy-source-r16"), "utf8");
  assert.equal(/rpc_endpoints|\.env|wallet|npm |pnpm |yarn |shell:\s*true/.test(source), false); assert.equal((source.match(/https:\/\//g) || []).length, 4);
});
