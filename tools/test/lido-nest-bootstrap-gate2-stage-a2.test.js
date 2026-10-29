"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  A1_DIRECTORY, A1_PINS, BINDINGS, CURVE_SPECS, INPUT_DIRECTORY, OUTPUT_BYTE_CAP, PROGRAM_PINS, TERMINAL, VENDOR_DIRECTORY, VENDOR_PINS,
  adjudicateFixture, adjudicateProduction, assertMandatoryNonpromotion, assertNoEndpointEnvironment, assertOutputByteCap, assertSanitizedBundle,
  bindBlueprint, bindExactDirect, bindPool, parseCli, snapshotA1, snapshotVendor, writeDerivedBundle,
} = require("../atomic/lido-nest-bootstrap-gate2");

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileFact(filename) { const bytes = fs.readFileSync(filename); return { bytes: bytes.length, sha256: sha256(bytes) }; }
function writeJson(filename, value) { fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`); }
function repinA1(made) { const files = {}; for (const name of fs.readdirSync(made.a1).filter((name) => name !== "manifest.json")) files[name] = fileFact(path.join(made.a1, name)); writeJson(path.join(made.a1, "manifest.json"), { atomicVisibility: true, durabilityClaimed: false, endpointFree: true, files, schemaVersion: 1 }); made.fixture.a1Pins.manifest = fileFact(path.join(made.a1, "manifest.json")); }
function setup(t, copyVendor = false) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lido-nest-a2-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const input = path.join(parent, path.basename(INPUT_DIRECTORY)); fs.mkdirSync(input); for (const name of fs.readdirSync(INPUT_DIRECTORY)) { if (name.endsWith(".json")) fs.copyFileSync(path.join(INPUT_DIRECTORY, name), path.join(input, name)); } fs.mkdirSync(path.join(input, "toolchain-solc-0.8.23"));
  const a1 = path.join(parent, path.basename(A1_DIRECTORY)); fs.cpSync(A1_DIRECTORY, a1, { recursive: true });
  const vendor = copyVendor ? path.join(parent, path.basename(VENDOR_DIRECTORY)) : VENDOR_DIRECTORY; if (copyVendor) fs.cpSync(VENDOR_DIRECTORY, vendor, { recursive: true });
  return { parent, input, a1, vendor, options: { inputDirectory: input, a1Directory: a1, vendorDirectory: vendor }, fixture: { a1Pins: structuredClone(A1_PINS), vendorPins: structuredClone(VENDOR_PINS), programPins: structuredClone(PROGRAM_PINS), specs: structuredClone(CURVE_SPECS), bindings: structuredClone(BINDINGS) } };
}
function adjudicate(made) { return adjudicateFixture(made.options, made.fixture); }
function mutateExplorer(made, filename, mutation) { const target = path.join(made.input, filename); const value = JSON.parse(fs.readFileSync(target, "utf8")); mutation(value); writeJson(target, value); const next = fileFact(target); const acquisitionFile = path.join(made.a1, "acquisition-authority.json"); const acquisition = JSON.parse(fs.readFileSync(acquisitionFile, "utf8")); Object.assign(acquisition.rows.find((row) => row.filename === filename), next); writeJson(acquisitionFile, acquisition); Object.assign(made.fixture.specs.find((row) => row.filename === filename), next); repinA1(made); }
function changeNibble(hex, index) { return `${hex.slice(0, index)}${hex[index] === "0" ? "1" : "0"}${hex.slice(index + 1)}`; }
function body(value) { return value.replace(/^0x/, "").toLowerCase(); }
function syntheticCompiled(bundle, creation = bundle.creation_bytecode, runtime = bundle.deployed_bytecode) { return { evm: { bytecode: { object: creation }, deployedBytecode: { object: runtime } } }; }

test("Stage A2 CLI is exact, endpoint rejecting, offline, and production isolated", () => {
  assert.deepEqual(parseCli(["--input-dir", "in", "--a1-dir", "a1", "--check-only"]), { inputDirectory: "in", a1Directory: "a1", outputDirectory: null, checkOnly: true });
  assert.throws(() => parseCli(["--input-dir", "in", "--a1-dir", "a1", "--check-only", "--output-dir", "out"]), /cli-mode-required/); assert.throws(() => parseCli(["--input-dir", "in", "--a1-dir", "a1", "--rpc-url", "x", "--check-only"]), /cli-options-invalid/);
  assert.equal(assertNoEndpointEnvironment({}), true); for (const name of ["RPC_URL", "ETH_RPC_URL", "RPC_ENDPOINTS_FILE", "GRAPHQL_ENDPOINTS_FILE", "HTTP_PROXY"]) assert.throws(() => assertNoEndpointEnvironment({ [name]: "redacted" }), /endpoint-environment-rejected/);
  assert.throws(() => adjudicateProduction({ inputDirectory: "wrong", a1Directory: A1_DIRECTORY, vendorDirectory: VENDOR_DIRECTORY }), /exact-inputs-required/);
  const source = fs.readFileSync(path.join(__dirname, "../atomic/lido-nest-bootstrap-gate2/index.js"), "utf8"); assert.doesNotMatch(source, /fetch\(|loadInventory|RpcBudget|fork|economic harness/i);
});

test("real check-only reconstructs all five exact Vyper bundles with quarantine nonclaims", () => {
  const result = adjudicateProduction({ inputDirectory: INPUT_DIRECTORY, a1Directory: A1_DIRECTORY, vendorDirectory: VENDOR_DIRECTORY }); const verdict = result.bundle["stage-a2-verdict.json"]; const toolchain = result.bundle["vyper-toolchain-authority.json"];
  assert.equal(verdict.terminalStage, TERMINAL); assert.equal(verdict.exactVyperBindingCount, 5); assert.equal(result.bundle["curve-direct-bindings.json"].rows.length, 3); assert.equal(result.bundle["pool-immutable-binding.json"].immutableTail.length, 480); assert.equal(result.bundle["pool-blueprint-binding.json"].blueprintRuntimeEqualsPrefixPlusCompiledCreation, true);
  assert.equal(toolchain.cpythonExecutionBytesPinned, true); assert.equal(toolchain.cpythonOriginProvenanceResolved, false); assert.equal(toolchain.existingAuthorityQuarantineAcknowledged, true); assert.equal(toolchain.vyperVersion, "0.3.10"); assert.equal(toolchain.vyperCommitFileValue, "9136169"); assertMandatoryNonpromotion(verdict); assertSanitizedBundle(result.bundle); assert.ok(assertOutputByteCap(result.bundle) <= OUTPUT_BYTE_CAP);
});

test("A1 manifest, files, terminal, pending gate, and acquisition authority tampering fail closed", (t) => {
  const manifest = setup(t); fs.appendFileSync(path.join(manifest.a1, "manifest.json"), " "); assert.throws(() => adjudicate(manifest), /a1-manifest-pin-mismatch/);
  const file = setup(t); fs.appendFileSync(path.join(file.a1, "stage-a1-verdict.json"), " "); assert.throws(() => adjudicate(file), /a1-file-commitment-mismatch/);
  const verdict = setup(t); { const p = path.join(verdict.a1, "stage-a1-verdict.json"), j = JSON.parse(fs.readFileSync(p)); j.promotable = true; writeJson(p, j); repinA1(verdict); } assert.throws(() => adjudicate(verdict), /a1-verdict-mismatch/);
  const pending = setup(t); { const p = path.join(pending.a1, "curve-vyper-pending.json"), j = JSON.parse(fs.readFileSync(p)); j.exactVyperRebuildPerformed = true; writeJson(p, j); repinA1(pending); } assert.throws(() => adjudicate(pending), /a1-curve-pending-mismatch/);
  const acquisition = setup(t); { const p = path.join(acquisition.a1, "acquisition-authority.json"), j = JSON.parse(fs.readFileSync(p)); j.networkUsedDuringStageA1 = true; writeJson(p, j); repinA1(acquisition); } assert.throws(() => adjudicate(acquisition), /a1-acquisition-mismatch/);
});

test("vendored CPython, resolved wheel, manifests, commit, licenses, extras, and runner are pinned before child", (t) => {
  const made = setup(t, true); const python = path.join(made.vendor, "runtime/cpython-3.10.11-embed-amd64/python.exe"); fs.appendFileSync(python, " "); assert.throws(() => snapshotVendor(made.vendor, made.fixture.vendorPins, made.fixture.programPins), /cpython-tree-mismatch/); fs.copyFileSync(path.join(VENDOR_DIRECTORY, "runtime/cpython-3.10.11-embed-amd64/python.exe"), python);
  const wheel = path.join(made.vendor, "runtime/resolved-wheels/six-1.17.0-py2.py3-none-any/six.py"); fs.appendFileSync(wheel, " "); assert.throws(() => snapshotVendor(made.vendor, made.fixture.vendorPins, made.fixture.programPins), /resolved-wheels-tree-mismatch/); fs.copyFileSync(path.join(VENDOR_DIRECTORY, "runtime/resolved-wheels/six-1.17.0-py2.py3-none-any/six.py"), wheel);
  const authority = path.join(made.vendor, "manifests/authority-manifest.json"); fs.appendFileSync(authority, " "); assert.throws(() => snapshotVendor(made.vendor, made.fixture.vendorPins, made.fixture.programPins), /manifests-tree-mismatch/); fs.copyFileSync(path.join(VENDOR_DIRECTORY, "manifests/authority-manifest.json"), authority);
  const license = path.join(made.vendor, "licenses/vyper-0.3.10-LICENSE"); fs.appendFileSync(license, " "); assert.throws(() => snapshotVendor(made.vendor, made.fixture.vendorPins, made.fixture.programPins), /licenses-tree-mismatch/); fs.copyFileSync(path.join(VENDOR_DIRECTORY, "licenses/vyper-0.3.10-LICENSE"), license);
  fs.writeFileSync(path.join(made.vendor, "extra"), "x"); assert.throws(() => snapshotVendor(made.vendor, made.fixture.vendorPins, made.fixture.programPins), /vendor-allowlist/); fs.rmSync(path.join(made.vendor, "extra"));
  const pins = structuredClone(PROGRAM_PINS); pins.sha256 = "0".repeat(64); assert.throws(() => snapshotVendor(made.vendor, made.fixture.vendorPins, pins), /program-pin-mismatch/);
});

test("compiler version, source, settings, diagnostics, and direct bytecode mismatches fail closed", (t) => {
  const compiler = setup(t); mutateExplorer(compiler, "curve-math.json", (j) => { j.compiler_version = "v0.3.9"; }); assert.throws(() => adjudicate(compiler), /explorer-shape/);
  const source = setup(t); mutateExplorer(source, "curve-math.json", (j) => { const next = j.source_code.replace("10**18", "1000000000000000001"); assert.notEqual(next, j.source_code); j.source_code = next; }); assert.throws(() => adjudicate(source), /curve-math-(?:creation|runtime)-mismatch/);
  const settings = setup(t); mutateExplorer(settings, "curve-math.json", (j) => { j.compiler_settings.optimize = "none"; }); assert.throws(() => adjudicate(settings), /curve-math-(?:creation|runtime)-mismatch|python-child-failed/);
  const diagnostics = setup(t); mutateExplorer(diagnostics, "curve-math.json", (j) => { j.source_code += "\nimport missing_source\n"; }); assert.throws(() => adjudicate(diagnostics), /python-child-failed|vyper-diagnostic/);
  const bundle = JSON.parse(fs.readFileSync(path.join(INPUT_DIRECTORY, "curve-math.json"), "utf8")); const spec = CURVE_SPECS.find((row) => row.filename === "curve-math.json"); assert.throws(() => bindExactDirect(spec, { ...bundle, creation_bytecode: changeNibble(bundle.creation_bytecode, 100) }, syntheticCompiled(bundle)), /curve-math-creation-mismatch/); assert.throws(() => bindExactDirect(spec, { ...bundle, deployed_bytecode: changeNibble(bundle.deployed_bytecode, 100) }, syntheticCompiled(bundle)), /curve-math-runtime-mismatch/);
});

test("pool constructor, runtime prefix, immutable tail, Math, factory, address, and chainId gates are exact", (t) => {
  const pool = JSON.parse(fs.readFileSync(path.join(INPUT_DIRECTORY, "curve-ldo-wsteth-pool.json"), "utf8")); const spec = CURVE_SPECS.find((row) => row.filename === "curve-ldo-wsteth-pool.json"); const args = body(pool.constructor_args); const compiledCreation = `0x${body(pool.creation_bytecode).slice(0, -args.length)}`; const compiledRuntime = `0x${body(pool.deployed_bytecode).slice(0, -960)}`; const response = { immutableTail: body(pool.deployed_bytecode).slice(-960) }; const compiled = syntheticCompiled(pool, compiledCreation, compiledRuntime);
  assert.throws(() => bindPool(spec, { ...pool, constructor_args: changeNibble(pool.constructor_args, 20) }, compiled, response, BINDINGS, CURVE_SPECS), /pool-creation-constructor-mismatch/);
  assert.throws(() => bindPool(spec, { ...pool, deployed_bytecode: changeNibble(pool.deployed_bytecode, 100) }, compiled, response, BINDINGS, CURVE_SPECS), /pool-runtime-prefix-shape-mismatch/);
  assert.throws(() => bindPool(spec, pool, compiled, { immutableTail: changeNibble(response.immutableTail, 20) }, BINDINGS, CURVE_SPECS), /pool-immutable-tail-mismatch/);
  const wrongMath = structuredClone(pool); wrongMath.decoded_constructor_args.find((row) => row[1].name === "_math")[0] = "0x0000000000000000000000000000000000000001"; assert.throws(() => bindPool(spec, wrongMath, compiled, response, BINDINGS, CURVE_SPECS), /pool-math-linkage-mismatch/);
  for (const [mutation, code] of [[{ factory: "0x0000000000000000000000000000000000000001" }, /pool-factory-linkage-mismatch/], [{ pool: "0x0000000000000000000000000000000000000001" }, /pool-deployment-linkage-mismatch/], [{ chainId: 2 }, /pool-chainid-linkage-mismatch/]]) assert.throws(() => bindPool(spec, pool, compiled, response, { ...BINDINGS, ...mutation }, CURVE_SPECS), code);
});

test("blueprint runtime prefix and exact deployment wrapper fail closed independently", () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(INPUT_DIRECTORY, "curve-pool-implementation.json"), "utf8")); const spec = CURVE_SPECS.find((row) => row.filename === "curve-pool-implementation.json"); const compiledCreation = `0x${body(bundle.deployed_bytecode).slice(6)}`; const compiled = syntheticCompiled(bundle, compiledCreation, "0x00"); assert.equal(bindBlueprint(spec, bundle, compiled).deploymentWrapperExact, true);
  assert.throws(() => bindBlueprint(spec, { ...bundle, deployed_bytecode: changeNibble(bundle.deployed_bytecode, 20) }, compiled), /blueprint-runtime-mismatch/); assert.throws(() => bindBlueprint(spec, { ...bundle, creation_bytecode: changeNibble(bundle.creation_bytecode, 20) }, compiled), /blueprint-creation-wrapper-mismatch/);
});

test("mandatory nonpromotion, quarantine wording, recursive leakage, and output cap remain fail closed", () => {
  const verdict = { officialGitProvenanceAsserted: false, currentRuntimeAsserted: false, currentStateAsserted: false, deploymentUnchangedAsserted: false, constructorExecutionProven: false, h2OrH3HarnessPerformed: false, economicModelPerformed: false, protocolLossAsserted: false, actorProfit: "unknown", routePositive: "unknown", currentExecutable: false, promotable: false, signing: false }; assertMandatoryNonpromotion(verdict);
  for (const mutation of [{ officialGitProvenanceAsserted: true }, { currentRuntimeAsserted: true }, { currentStateAsserted: true }, { deploymentUnchangedAsserted: true }, { constructorExecutionProven: true }, { h2OrH3HarnessPerformed: true }, { economicModelPerformed: true }, { protocolLossAsserted: true }, { actorProfit: true }, { routePositive: true }, { currentExecutable: true }, { promotable: true }, { signing: true }]) assert.throws(() => assertMandatoryNonpromotion({ ...verdict, ...mutation }), /nonpromotion/);
  for (const bad of [{ source_code: "x" }, { creationBytecode: "0x" }, { constructor_args: "0x" }, { pythonPath: "C:\\Users\\x" }, { stderr: "trace" }, { error: "raw" }]) assert.throws(() => assertSanitizedBundle({ bad }), /output-leak/); assert.throws(() => assertOutputByteCap({ huge: { value: "x".repeat(OUTPUT_BYTE_CAP + 1) } }), /output-byte-cap/);
});

test("isolated fixture output is atomic and post-check input mutation exposes no artifacts", (t) => {
  const made = setup(t); const result = adjudicate(made); const output = path.join(made.parent, "output"); writeDerivedBundle(output, result); assert.deepEqual(fs.readdirSync(output).sort(), ["a1-anchor.json", "curve-direct-bindings.json", "manifest.json", "pool-blueprint-binding.json", "pool-immutable-binding.json", "stage-a2-verdict.json", "vyper-toolchain-authority.json"]);
  fs.appendFileSync(path.join(made.input, "curve-math.json"), " "); const blocked = path.join(made.parent, "blocked"); assert.throws(() => writeDerivedBundle(blocked, result), /input-a1-commitment|source-mutated/); assert.equal(fs.existsSync(blocked), false); assert.equal(fs.readdirSync(made.parent).some((name) => name.includes(".tmp-")), false);
});
