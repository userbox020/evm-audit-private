"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  ACQUISITION_MANIFEST, BATCH_TERMINAL, COMPILER_IDENTITY, CURVE_TERMINAL, EXACT_TERMINAL, INPUT_DIRECTORY, LEGACY_TERMINAL, OUTPUT_BYTE_CAP, RUNTIME_PINS, TOOLCHAIN_PINS,
  adjudicateFixture, adjudicateProduction, assertMandatoryNonpromotion, assertNoEndpointEnvironment, assertNoLinkReferences, assertOutputByteCap, assertSanitizedBundle, parseCli,
  snapshotRuntimeAuthority, validateAuthority, validateCompilerResponse, validateRuntimeThenLoadEthers, writeDerivedBundle,
} = require("../atomic/lido-nest-bootstrap-gate1");

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileFact(filename) { const bytes = fs.readFileSync(filename); return { bytes: bytes.length, sha256: sha256(bytes) }; }
function writeJson(filename, value) { fs.writeFileSync(filename, JSON.stringify(value)); }
function setup(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lido-nest-a1-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const input = path.join(parent, "isolated-lido-nest-a1"); fs.mkdirSync(input);
  for (const row of ACQUISITION_MANIFEST) fs.copyFileSync(path.join(INPUT_DIRECTORY, row.filename), path.join(input, row.filename));
  fs.cpSync(path.join(INPUT_DIRECTORY, "toolchain-solc-0.8.23"), path.join(input, "toolchain-solc-0.8.23"), { recursive: true });
  return { parent, input, fixture: { manifest: structuredClone(ACQUISITION_MANIFEST), toolchainPins: structuredClone(TOOLCHAIN_PINS), expectedBasename: path.basename(input) }, options: { inputDirectory: input } };
}
function row(made, filename) { return made.fixture.manifest.find((item) => item.filename === filename); }
function mutateBundle(made, filename, mutation, committed = {}) {
  const target = path.join(made.input, filename); const value = JSON.parse(fs.readFileSync(target, "utf8")); mutation(value); writeJson(target, value);
  Object.assign(row(made, filename), fileFact(target), committed);
}
function adjudicate(made) { return adjudicateFixture(made.options, made.fixture); }
function changeNibble(hex, characterIndex) { const current = hex[characterIndex]; return `${hex.slice(0, characterIndex)}${current === "0" ? "1" : "0"}${hex.slice(characterIndex + 1)}`; }

test("Stage A1 CLI is exact, check-only capable, endpoint rejecting, and offline-source isolated", () => {
  assert.deepEqual(parseCli(["--input-dir", "in", "--check-only"]), { inputDirectory: "in", outputDirectory: null, checkOnly: true });
  assert.deepEqual(parseCli(["--input-dir", "in", "--output-dir", "out"]), { inputDirectory: "in", outputDirectory: "out", checkOnly: false });
  assert.throws(() => parseCli(["--input-dir", "in", "--check-only", "--output-dir", "out"]), /cli-mode-required/);
  assert.throws(() => parseCli(["--input-dir", "in", "--rpc-url", "x", "--check-only"]), /cli-options-invalid/);
  assert.equal(assertNoEndpointEnvironment({}), true);
  for (const name of ["RPC_URL", "ETH_RPC_URL", "WEB3_PROVIDER_URI", "RPC_ENDPOINTS_FILE", "GRAPHQL_ENDPOINTS_FILE", "HTTP_PROXY"]) assert.throws(() => assertNoEndpointEnvironment({ [name]: "redacted" }), /endpoint-environment-rejected/);
  assert.throws(() => adjudicateProduction({ inputDirectory: "wrong" }), /exact-input-required/);
  assert.throws(() => adjudicateProduction({ inputDirectory: INPUT_DIRECTORY, manifest: [] }), /production-options-invalid/);
  const source = fs.readFileSync(path.join(__dirname, "../atomic/lido-nest-bootstrap-gate1/index.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'].*collector|loadInventory|RpcBudget|fetch\(|lido-core-v4\.0\.1/);
});

test("real inputs check-only bind eight exact Solidity contracts and preserve declared blockers", () => {
  const result = adjudicateProduction({ inputDirectory: INPUT_DIRECTORY }); const exact = result.bundle["solidity-exact-bindings.json"].rows; const legacy = result.bundle["legacy-solidity-pending.json"].rows; const curve = result.bundle["curve-vyper-pending.json"]; const verdict = result.bundle["stage-a1-verdict.json"];
  assert.equal(exact.length, 8); assert.ok(exact.every((item) => item.terminalStage === EXACT_TERMINAL && item.creationBytecodeAndArgumentsExact && item.runtimeTemplateNonImmutableBytesExact && item.observedImmutableInstantiationExact && item.metadataTrailerExact && item.abiExact));
  assert.ok(exact.every((item) => item.codeGenerationSettingsExact === true && item.outputSelectionReplacedForEvidenceExtraction === true && !Object.hasOwn(item, "compilerSettingsExact")));
  assert.deepEqual(exact.map((item) => item.contractName), ["BuybackAllocator", "BuybackExecutor", "StakingRevenueSource", "OracleRouter", "StonksFactory", "Order", "Stonks", "Stonks"]);
  assert.equal(legacy.length, 2); assert.ok(legacy.every((item) => item.terminalStage === LEGACY_TERMINAL && item.rebuilt === false && item.officialCoreComparisonPerformed === false && item.provenanceClassification === "EXPLORER_SNAPSHOT_LEGACY_SOLIDITY_NOT_REBUILT")); assert.equal(result.bundle["legacy-solidity-pending.json"].officialCoreComparisonPerformed, false);
  assert.equal(curve.terminalStage, CURVE_TERMINAL); assert.equal(curve.rows.length, 5); assert.ok(curve.rows.every((item) => item.terminalStage === CURVE_TERMINAL && item.vyperRebuilt === false && item.sourceEquivalentClaimed === false && item.explorerCompilerMetadataFieldsPinnedExact === true && !Object.hasOwn(item, "compilerMetadataExact")));
  const pool = curve.rows.find((item) => item.filename === "curve-ldo-wsteth-pool.json"); assert.equal(pool.mathAddressLinkage.decodedConstructorAddressMatchesPinnedMath, true);
  assert.equal(verdict.terminalStage, BATCH_TERMINAL); assert.deepEqual([verdict.exactSolidityBundleCount, verdict.legacyIdentityOnlyCount, verdict.curvePendingCount], [8, 2, 5]); assertMandatoryNonpromotion(verdict); assertSanitizedBundle(result.bundle); assert.ok(assertOutputByteCap(result.bundle) <= OUTPUT_BYTE_CAP);
  const acquisition = result.bundle["acquisition-authority.json"]; assert.equal(acquisition.declaredPublicAcquisitionAuthorityPinned, true); assert.equal(acquisition.networkUsedDuringStageA1, false); assert.equal(acquisition.acquisitionRetrievalIndependentlyVerified, false); assert.equal(Object.hasOwn(acquisition, "publicBlockscoutAcquisitionAuthorityExact"), false);
  const toolchain = result.bundle["toolchain-authority.json"]; assert.equal(toolchain.compilerIdentity, COMPILER_IDENTITY); assert.equal(toolchain.nodeVersion, process.version); assert.equal(toolchain.nodeVersionPinned, true); assert.equal(toolchain.nodeExecutableHashPinned, false); assert.equal(toolchain.ethersRuntime.version, "6.17.0"); assert.equal(toolchain.compilerPackagesAndRuntimeDependencyTreesIncludedInUnchangedChecks, true); assert.equal(Object.hasOwn(toolchain, "allRelevantToolchainInputsIncludedInUnchangedChecks"), false); assert.deepEqual(toolchain.rootPackageJson, TOOLCHAIN_PINS.files["package.json"]); assert.deepEqual(toolchain.runtimePackageLock, RUNTIME_PINS.packageLock); assert.equal(toolchain.boundedCompleteRuntimeNodeModulesTree.sha256, RUNTIME_PINS.nodeModules.treeSha256);
});

test("bounded acquisition authority rejects missing, duplicate, malformed address, URL, filename, and file hash", (t) => {
  const missing = structuredClone(ACQUISITION_MANIFEST); missing.pop(); assert.throws(() => validateAuthority(missing), /cardinality/);
  const duplicate = structuredClone(ACQUISITION_MANIFEST); duplicate[1].address = duplicate[0].address; duplicate[1].acquisitionUrl = duplicate[0].acquisitionUrl; assert.throws(() => validateAuthority(duplicate), /duplicate/);
  const address = structuredClone(ACQUISITION_MANIFEST); address[0].address = address[0].address.toLowerCase(); assert.throws(() => validateAuthority(address));
  const url = structuredClone(ACQUISITION_MANIFEST); url[0].acquisitionUrl += "?wrong"; assert.throws(() => validateAuthority(url), /manifest-invalid/);
  const filename = structuredClone(ACQUISITION_MANIFEST); filename[0].filename = "../escape.json"; assert.throws(() => validateAuthority(filename), /manifest-invalid/);
  const kind = structuredClone(ACQUISITION_MANIFEST); kind[0].kind = "legacy-solidity"; kind[0].compilerVersion = "v0.8.9+commit.e5eed63a"; assert.throws(() => validateAuthority(kind), /kind-count/);
  const made = setup(t); fs.appendFileSync(path.join(made.input, "buyback-allocator.json"), " "); assert.throws(() => adjudicate(made), /input-pin-mismatch/);
  const extra = setup(t); fs.writeFileSync(path.join(extra.input, "extra.json"), "{}"); assert.throws(() => adjudicate(extra), /file-allowlist-mismatch/);
});

test("symlinks, toolchain changes, and exact compiler identity or diagnostics fail closed", (t) => {
  const made = setup(t); const target = path.join(made.parent, "outside.json"); fs.copyFileSync(path.join(made.input, "oracle-router.json"), target); fs.rmSync(path.join(made.input, "oracle-router.json"));
  let linked = false; try { fs.symlinkSync(target, path.join(made.input, "oracle-router.json"), "file"); linked = true; } catch (_) { t.diagnostic("symlink creation unavailable"); }
  if (linked) assert.throws(() => adjudicate(made), /input-file-invalid/);
  const toolchain = setup(t); fs.appendFileSync(path.join(toolchain.input, "toolchain-solc-0.8.23", "package", "soljson.js"), " "); assert.throws(() => adjudicate(toolchain), /toolchain-(?:tree-)?pin-mismatch/);
  const rootPackage = setup(t); fs.appendFileSync(path.join(rootPackage.input, "toolchain-solc-0.8.23", "package.json"), " "); assert.throws(() => adjudicate(rootPackage), /toolchain-(?:tree-)?pin-mismatch/);
  const wrongRuntime = structuredClone(RUNTIME_PINS); wrongRuntime.nodeVersion = "v0.0.0"; assert.throws(() => snapshotRuntimeAuthority({}, wrongRuntime), /runtime-version-mismatch/);
  assert.throws(() => validateCompilerResponse({ compilerIdentity: "wrong", results: [] }, []), /identity-or-cardinality/);
  assert.throws(() => validateCompilerResponse({ compilerIdentity: COMPILER_IDENTITY, results: [{ id: "x", errors: [{ severity: "warning" }], contract: {} }] }, ["x"]), /warning-not-allowlisted/);
  assert.throws(() => validateCompilerResponse({ compilerIdentity: COMPILER_IDENTITY, results: [{ id: "x", errors: [{ severity: "error" }], contract: {} }] }, ["x"]), /compiler-error/);
  assert.equal(assertNoLinkReferences({}, {}), true); assert.throws(() => assertNoLinkReferences({ "A.sol": { L: [{ start: 1, length: 20 }] } }, {}), /link-references-unsupported/);
});

test("clean child rejects a transitive dependency mutation before loading ethers", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lido-nest-runtime-tamper-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const nodeModules = path.join(parent, "node_modules"); fs.cpSync(path.join(__dirname, "..", "node_modules"), nodeModules, { recursive: true });
  const packageLock = path.join(parent, "package-lock.json"); fs.copyFileSync(path.join(__dirname, "..", "package-lock.json"), packageLock);
  fs.appendFileSync(path.join(nodeModules, "tslib", "tslib.js"), " ");
  const modulePath = path.join(__dirname, "../atomic/lido-nest-bootstrap-gate1/index.js");
  const script = 'const Module=require("node:module");let attempted=false;const original=Module._load;Module._load=function(request,...rest){if(request==="ethers"){attempted=true;throw new Error("ethers-loaded-before-authority");}return original.call(this,request,...rest);};try{const m=require(process.argv[1]);m.validateRuntimeThenLoadEthers({nodeModulesDirectory:process.argv[2],packageLockFile:process.argv[3]},m.RUNTIME_PINS);process.stdout.write(JSON.stringify({ok:false,attempted,code:"accepted"}));process.exitCode=3;}catch(error){process.stdout.write(JSON.stringify({ok:true,attempted,code:error.message}));if(attempted)process.exitCode=2;}';
  const child = spawnSync(process.execPath, ["-e", script, modulePath, nodeModules, packageLock], { encoding: "utf8", windowsHide: true, timeout: 120000, env: {} });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout); assert.equal(result.attempted, false); assert.match(result.code, /node-modules-tree-pin-mismatch/);
});

test("response flags, paths, compiler, settings, sources, ABI, proxy, and library declarations are exact", (t) => {
  const cases = [
    ["verification", (j) => { j.is_fully_verified = false; }, /verification-flags/],
    ["extra-key", (j) => { j.unexpected = true; }, /bundle-shape/],
    ["path-case", (j) => { j.file_path = j.file_path.toUpperCase(); }, /source-set|bundle-shape/],
    ["compiler", (j) => { j.compiler_version = "v0.8.24"; }, /bundle-shape/],
    ["settings", (j) => { j.compiler_settings.optimizer.runs += 1; }, /committed-field/],
    ["source", (j) => { j.source_code += "\n"; }, /source-set/],
    ["abi", (j) => { j.abi.pop(); }, /committed-field/],
    ["proxy", (j) => { j.proxy_type = "eip1967"; }, /bundle-shape/],
    ["library", (j) => { j.external_libraries = [{ name: "L", address: "0x0000000000000000000000000000000000000001" }]; }, /bundle-shape/],
    ["missing-constructor", (j) => { j.constructor_args = null; }, /constructor-args-required/],
  ];
  for (const [, mutation, error] of cases) { const made = setup(t); mutateBundle(made, "buyback-allocator.json", mutation); assert.throws(() => adjudicate(made), error); }
  const conflict = setup(t); mutateBundle(conflict, "buyback-allocator.json", (j) => { j.additional_sources.push({ file_path: j.file_path, source_code: `${j.source_code}\n` }); }); assert.throws(() => adjudicate(conflict), /source-path-conflict/);
});

test("creation, runtime metadata, immutable occurrences, constructor encoding, and decoded facts fail closed", (t) => {
  const creation = setup(t); mutateBundle(creation, "buyback-allocator.json", (j) => { j.creation_bytecode = changeNibble(j.creation_bytecode, 100); }); assert.throws(() => adjudicate(creation), /creation-bytecode/);
  const runtime = setup(t); mutateBundle(runtime, "buyback-allocator.json", (j) => { j.deployed_bytecode = changeNibble(j.deployed_bytecode, 200); }); assert.throws(() => adjudicate(runtime), /runtime-template/);
  const metadata = setup(t); mutateBundle(metadata, "buyback-allocator.json", (j) => { j.deployed_bytecode = changeNibble(j.deployed_bytecode, j.deployed_bytecode.length - 5); }); assert.throws(() => adjudicate(metadata), /runtime-template|metadata/);
  const immutable = setup(t); mutateBundle(immutable, "buyback-allocator.json", (j) => { const character = 2 + 754 * 2; j.deployed_bytecode = changeNibble(j.deployed_bytecode, character); }); assert.throws(() => adjudicate(immutable), /immutable-occurrence/);
  const constructor = setup(t); mutateBundle(constructor, "buyback-allocator.json", (j) => { j.constructor_args = changeNibble(j.constructor_args, 10); }); assert.throws(() => adjudicate(constructor), /creation-bytecode|constructor/);
  const decoded = setup(t); mutateBundle(decoded, "buyback-allocator.json", (j) => { j.decoded_constructor_args[0][0][5] = "50000000000000000000001"; }); { const changed = JSON.parse(fs.readFileSync(path.join(decoded.input, "buyback-allocator.json"), "utf8")); row(decoded, "buyback-allocator.json").decodedArgsSha256 = sha256(JSON.stringify(changed.decoded_constructor_args)); } assert.throws(() => adjudicate(decoded), /constructor-decoded/);
});

test("Vyper identities stay pending and Math linkage, compiler metadata, source, blueprint, and flags fail closed", (t) => {
  const math = setup(t); mutateBundle(math, "curve-ldo-wsteth-pool.json", (j) => { const oldRaw = j.constructor_args.replace(/^0x/, ""); const wordOffset = 4 * 64; const encodedAddress = `${"0".repeat(24)}${"1".padStart(40, "0")}`; const encoded = `${oldRaw.slice(0, wordOffset)}${encodedAddress}${oldRaw.slice(wordOffset + 64)}`; j.constructor_args = encoded; assert.ok(j.creation_bytecode.toLowerCase().endsWith(oldRaw.toLowerCase())); j.creation_bytecode = `${j.creation_bytecode.slice(0, -oldRaw.length)}${encoded}`; const entry = j.decoded_constructor_args.find((item) => item[1].name === "_math"); entry[0] = "0x0000000000000000000000000000000000000001"; }); row(math, "curve-ldo-wsteth-pool.json").decodedArgsSha256 = sha256(JSON.stringify(JSON.parse(fs.readFileSync(path.join(math.input, "curve-ldo-wsteth-pool.json"), "utf8")).decoded_constructor_args)); assert.throws(() => adjudicate(math), /^Error: lido-nest-a1-curve-math-linkage-mismatch$/);
  const compiler = setup(t); mutateBundle(compiler, "curve-math.json", (j) => { j.compiler_version = "v0.3.9"; }); assert.throws(() => adjudicate(compiler), /bundle-shape/);
  const source = setup(t); mutateBundle(source, "curve-math.json", (j) => { j.source_code = ""; }); assert.throws(() => adjudicate(source), /source-entry-invalid/);
  const flags = setup(t); mutateBundle(flags, "curve-math.json", (j) => { j.is_partially_verified = false; }); assert.throws(() => adjudicate(flags), /verification-flags/);
  const blueprint = setup(t); mutateBundle(blueprint, "curve-pool-implementation.json", (j) => { j.is_blueprint = false; }); assert.throws(() => adjudicate(blueprint), /bundle-shape/);
});

test("mandatory nonpromotion, sanitization, and byte cap reject promotion and raw evidence", () => {
  const verdict = { routePositive: "unknown", currentExecutable: false, promotable: false, signing: false, protocolLossAsserted: false, actorProfit: "unknown", currentStateAsserted: false, fullConstructorExecutionProof: false };
  assertMandatoryNonpromotion(verdict);
  for (const mutation of [{ routePositive: true }, { currentExecutable: true }, { promotable: true }, { signing: true }, { protocolLossAsserted: true }, { actorProfit: true }, { currentStateAsserted: true }, { fullConstructorExecutionProof: true }]) assert.throws(() => assertMandatoryNonpromotion({ ...verdict, ...mutation }), /nonpromotion/);
  for (const bad of [{ source_code: "contract X{}" }, { additional_sources: [] }, { additionalSources: [] }, { "Additional-Sources": [] }, { creation_bytecode: "0x00" }, { creationBytecode: "0x00" }, { "Creation-Byte_Code": "0x00" }, { deployed_bytecode: "0x00" }, { deployedBytecode: "0x00" }, { constructor_args: "0x00" }, { constructorArgs: "0x00" }, { acquisitionUrl: "https://forbidden.invalid" }, { userPath: "C:\\Users\\forbidden" }]) assert.throws(() => assertSanitizedBundle({ bad }), /output-leak/);
  assert.throws(() => assertOutputByteCap({ huge: { value: "x".repeat(OUTPUT_BYTE_CAP + 1) } }), /output-byte-cap/);
});

test("isolated fixture output is atomic and source mutation before rename exposes nothing", (t) => {
  const made = setup(t); const result = adjudicate(made); const output = path.join(made.parent, "fixture-output"); writeDerivedBundle(output, result);
  assert.deepEqual(fs.readdirSync(output).sort(), ["acquisition-authority.json", "curve-vyper-pending.json", "legacy-solidity-pending.json", "manifest.json", "solidity-exact-bindings.json", "stage-a1-verdict.json", "toolchain-authority.json"]);
  const text = fs.readdirSync(output).map((name) => fs.readFileSync(path.join(output, name), "utf8")).join("\n"); assert.doesNotMatch(text, /source_code|creation_bytecode|deployed_bytecode|constructor_args|https?:\/\/|wss?:\/\/|\\Users\\/i);
  const changed = setup(t); const changedResult = adjudicate(changed); fs.appendFileSync(path.join(changed.input, "oracle-router.json"), " "); const blocked = path.join(changed.parent, "blocked-output"); assert.throws(() => writeDerivedBundle(blocked, changedResult), /input-/); assert.equal(fs.existsSync(blocked), false); assert.equal(fs.readdirSync(changed.parent).some((name) => name.includes(".tmp-")), false);
});
