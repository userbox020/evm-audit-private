"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { AbiCoder, keccak256, Interface } = require("ethers");
const { normalize, sha } = require("./run-base-paper-usdplus-source-r11");
const { requestJSON } = require("./run-base-redemption-paper-state-r1");
const { header, address: addressWord } = require("./run-base-redemption-paper-state-r1");
const { readCandidates, coreState } = require("./run-base-paper-usdplus-exit-r13");
const { A: CORE, SLOT } = require("./run-base-paper-usdplus-preflight-r10");
const { AAVE, PROXY: CASH } = require("./run-base-paper-usdplus-cash-r12");
const DIR = path.resolve(__dirname, "../reports/raw/fast/base-paper-usdplus-r13/aave");
const IMPLEMENTATION = "0x79ab8fc5ba13daf37b4e978a543286bc2a16508c";
const ACTIVE_AAVE = Object.freeze({ pool: "0xa4abc5fcba6d0d7e3d144d6dbf6cb6128599dfdb", SupplyLogic: "0x584c7d8c4cb05304fe5ac7fbc97f20a10fb07564", PoolLogic: "0xd70593841c57cbaa04957cc3eace95708e48853b" });
const VERSION = "0.8.27+commit.40a35a09";
const COMPILER_SHA = "8474166f631caa0c51618fddb89ca149080f69c27db06f94bd323eb69f87ffd8";
class AaveError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new AaveError(code); };
function librarySettings(flat) {
  const nested = {};
  if (!flat || typeof flat !== "object" || Array.isArray(flat) || Object.keys(flat).length > 16) fail("LIBRARY_SETTINGS_INVALID");
  for (const [key, address] of Object.entries(flat)) {
    const split = key.lastIndexOf(":");
    const file = key.slice(0, split), name = key.slice(split + 1);
    if (split < 0 || !file.endsWith(".sol") || file.startsWith("/") || file.split("/").some(p => p === ".." || p === "." || !p)
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !/^0x[0-9a-f]{40}$/i.test(address)) fail("LIBRARY_SETTINGS_INVALID");
    nested[file] ||= {};
    if (Object.hasOwn(nested[file], name)) fail("LIBRARY_SETTINGS_DUPLICATE");
    nested[file][name] = address.toLowerCase();
  }
  return nested;
}
async function source() {
  const filename = path.join(DIR, "source.json");
  if (fs.existsSync(filename)) fail("AAVE_SOURCE_EXISTS_NO_RETRY");
  fs.mkdirSync(DIR, { recursive: true });
  const out = { schema: "base-paper-aave-withdraw-source/v13", generatedAt: new Date().toISOString(), status: "INCOMPLETE", requests: 1,
    implementation: IMPLEMENTATION, sourceRuntimeBound: "unknown", quoteEligible: false, signing: false, transactions: 0 };
  try {
    const response = await requestJSON(new URL(`https://base.blockscout.com/api/v2/smart-contracts/${IMPLEMENTATION}`), undefined, 20000);
    const bundle = normalize(response.value, IMPLEMENTATION);
    if (bundle.name !== "L2PoolInstance" || bundle.compiler !== VERSION) fail("AAVE_SOURCE_IDENTITY_MISMATCH");
    const originalLibraries = bundle.input.settings.libraries;
    bundle.input.settings.libraries = librarySettings(originalLibraries);
    bundle.input.settings.outputSelection = { "*": { "*": ["abi", "evm.deployedBytecode"], "": ["ast"] } };
    bundle.constructorArguments = response.value.constructor_args;
    bundle.originalLibrarySettings = originalLibraries;
    if (!/^0x[0-9a-f]{128}$/i.test(bundle.constructorArguments || "")) fail("AAVE_CONSTRUCTOR_INVALID");
    const input = JSON.stringify(bundle.input, null, 2) + "\n";
    fs.writeFileSync(path.join(DIR, "pool.input.json"), input, { flag: "wx" });
    fs.writeFileSync(path.join(DIR, "pool.bundle.json"), JSON.stringify(bundle, null, 2) + "\n", { flag: "wx" });
    for (const [file, value] of Object.entries(bundle.input.sources)) {
      const destination = path.join(DIR, "sources", file);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, value.content, { flag: "wx" });
    }
    out.status = "AAVE_POOL_SOURCE_RECOVERED_BUILD_REQUIRED"; out.inputSha256 = sha(input);
    out.sourceCount = Object.keys(bundle.input.sources).length; out.libraries = bundle.input.settings.libraries; out.constructorArguments = bundle.constructorArguments;
  } catch (e) { out.code = e instanceof AaveError ? e.code : "AAVE_SOURCE_RECOVERY_FAILED"; }
  out.completedAt = new Date().toISOString(); fs.writeFileSync(filename, JSON.stringify(out, null, 2) + "\n", { flag: "wx" }); return out;
}
function poolRuntime(output, target, args) {
  if (!/^0x[0-9a-f]{128}$/i.test(args) || !/^(?:[0-9a-f]{2})+$/i.test(target.object)) fail("POOL_CONSTRUCTOR_OR_TEMPLATE_INVALID");
  const values = AbiCoder.defaultAbiCoder().decode(["address", "address"], args).map(value => value.toLowerCase());
  if (AbiCoder.defaultAbiCoder().encode(["address", "address"], values) !== args.toLowerCase()) fail("CONSTRUCTOR_NONCANONICAL");
  const definitions = Object.values(output.sources).flatMap(source => source.ast?.nodes || []).filter(node => node.nodeType === "ContractDefinition");
  const definition = name => {
    const matches = definitions.filter(node => node.name === name);
    if (matches.length !== 1) fail("POOL_AST_IDENTITY_INVALID");
    return matches[0];
  };
  const constructor = name => {
    const ctors = definition(name).nodes.filter(node => node.nodeType === "FunctionDefinition" && node.kind === "constructor");
    if (ctors.length !== 1 || ctors[0].parameters.parameters.length !== 2) fail("POOL_CONSTRUCTOR_AST_INVALID");
    return ctors[0];
  };
  for (const [name, parent] of [["L2PoolInstance", "PoolInstance"], ["PoolInstance", "Pool"]]) {
    const ctor = constructor(name), forwards = ctor.modifiers.filter(mod => mod.modifierName.name === parent);
    if (ctor.modifiers.length !== 1 || forwards.length !== 1 || forwards[0].arguments.length !== 2 || ctor.body.statements.length !== 0
      || forwards[0].arguments.some((arg, index) => arg.nodeType !== "Identifier" || arg.referencedDeclaration !== ctor.parameters.parameters[index].id)) fail("POOL_CONSTRUCTOR_FORWARDING_UNPROVEN");
  }
  const ctor = constructor("Pool");
  const assignments = ctor.body.statements.filter(stmt => stmt.expression?.nodeType === "Assignment").map(stmt => stmt.expression);
  if (ctor.modifiers.length !== 0 || assignments.length !== 2 || ctor.body.statements.length !== 3 || Object.keys(target.immutableReferences || {}).length !== 2) fail("POOL_IMMUTABLE_ASSIGNMENTS_UNPROVEN");
  const requirement = ctor.body.statements[1]?.expression, condition = requirement?.arguments?.[0];
  if (requirement?.nodeType !== "FunctionCall" || requirement.expression?.name !== "require" || condition?.nodeType !== "BinaryOperation" || condition.operator !== "!="
    || condition.leftExpression?.kind !== "typeConversion" || condition.leftExpression.expression?.typeName?.name !== "address" || condition.leftExpression.arguments?.length !== 1
    || condition.leftExpression.arguments[0]?.referencedDeclaration !== ctor.parameters.parameters[1].id || condition.rightExpression?.kind !== "typeConversion"
    || condition.rightExpression.expression?.typeName?.name !== "address" || condition.rightExpression.arguments?.length !== 1 || condition.rightExpression.arguments[0]?.value !== "0") fail("POOL_CONSTRUCTOR_GUARD_UNPROVEN");
  const bytes = Buffer.from(target.object, "hex"), occupied = new Set(), proof = [];
  for (const [index, name] of ["ADDRESSES_PROVIDER", "RESERVE_INTEREST_RATE_STRATEGY"].entries()) {
    const node = definition("Pool").nodes.find(node => node.nodeType === "VariableDeclaration" && node.name === name && node.mutability === "immutable");
    const matches = assignments.filter(assignment => assignment.operator === "=" && assignment.leftHandSide.referencedDeclaration === node?.id);
    if (!node || matches.length !== 1) fail("POOL_IMMUTABLE_ASSIGNMENTS_UNPROVEN");
    let rhs = matches[0].rightHandSide;
    if (index === 1) {
      if (rhs.kind !== "typeConversion" || rhs.expression?.typeName?.name !== "address" || rhs.arguments.length !== 1) fail("POOL_IMMUTABLE_CAST_UNPROVEN");
      rhs = rhs.arguments[0];
    }
    if (rhs.nodeType !== "Identifier" || rhs.referencedDeclaration !== ctor.parameters.parameters[index].id) fail("POOL_IMMUTABLE_VALUE_UNPROVEN");
    const refs = target.immutableReferences[String(node.id)];
    if (!Array.isArray(refs) || !refs.length) fail("POOL_IMMUTABLE_REFERENCES_INVALID");
    for (const ref of refs) {
      if (!Number.isSafeInteger(ref.start) || ref.start < 0 || ref.length !== 32 || ref.start + 32 > bytes.length) fail("POOL_IMMUTABLE_RANGE_INVALID");
      for (let i = ref.start; i < ref.start + 32; i++) {
        if (occupied.has(i) || bytes[i] !== 0) fail("POOL_IMMUTABLE_RANGE_INVALID");
        occupied.add(i);
      }
      Buffer.from(values[index].slice(2).padStart(64, "0"), "hex").copy(bytes, ref.start);
    }
    proof.push({ name, astId: node.id, constructorParameterIndex: index, value: values[index], references: refs });
  }
  return { runtime: "0x" + bytes.toString("hex"), proof };
}
function libraryRuntime(target, address, ast) {
  if (ast?.contractKind !== "library" || !/^0x[0-9a-f]{40}$/.test(address) || !/^(?:[0-9a-f]{2})+$/i.test(target.object)
    || !target.object.startsWith("73" + "00".repeat(20) + "3014") || Object.keys(target.immutableReferences || {}).length) fail("LIBRARY_SELF_PROTECTION_UNPROVEN");
  // Solidity's generated library call-protection prefix embeds the deployment address.
  return "0x73" + address.slice(2) + target.object.slice(42);
}
async function build() {
  const filename = path.join(DIR, "build.json");
  if (fs.existsSync(filename)) fail("AAVE_BUILD_EXISTS_NO_RETRY");
  const out = { schema: "base-paper-aave-withdraw-build/v13", generatedAt: new Date().toISOString(), status: "INCOMPLETE", contracts: {}, sourceRuntimeBound: "unknown", quoteEligible: false, signing: false, transactions: 0 };
  try {
    const inputText = fs.readFileSync(path.join(DIR, "pool.input.json"), "utf8"), manifest = JSON.parse(fs.readFileSync(path.join(DIR, "source.json"), "utf8"));
    if (sha(inputText) !== manifest.inputSha256) fail("AAVE_INPUT_CHANGED");
    const bundle = JSON.parse(fs.readFileSync(path.join(DIR, "pool.bundle.json"), "utf8"));
    const compiler = `C:/Users/MiPC/AppData/Local/Temp/opencode/solc-windows-amd64-v${VERSION}.exe`;
    if (!fs.existsSync(compiler)) {
      const response = await fetch(`https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/windows-amd64/solc-windows-amd64-v${VERSION}.exe`, { redirect: "error", signal: AbortSignal.timeout(60000) });
      if (!response.ok) fail("COMPILER_DOWNLOAD_FAILED");
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; if (length > 32 * 1048576) fail("COMPILER_BYTE_CAP"); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks); if (sha(bytes) !== COMPILER_SHA) fail("COMPILER_CHECKSUM_MISMATCH");
      fs.writeFileSync(compiler, bytes, { flag: "wx" });
    }
    const stat = fs.lstatSync(compiler);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1048576 || sha(fs.readFileSync(compiler)) !== COMPILER_SHA) fail("COMPILER_CHECKSUM_MISMATCH");
    const version = spawnSync(compiler, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (version.status !== 0 || !version.stdout.includes(`Version: ${VERSION}.Windows.msvc`)) fail("COMPILER_VERSION_MISMATCH");
    const compiled = spawnSync(compiler, ["--standard-json"], { input: inputText, encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1048576, windowsHide: true });
    if (compiled.status !== 0) fail("NATIVE_COMPILE_FAILED");
    const output = JSON.parse(compiled.stdout);
    if ((output.errors || []).some(row => row.severity === "error")) fail("STANDARD_JSON_COMPILE_FAILED");
    fs.writeFileSync(path.join(DIR, "compiler-output.json"), compiled.stdout, { flag: "wx" });
    const target = output.contracts?.[bundle.file]?.[bundle.name];
    if (!target) fail("POOL_TARGET_MISSING");
    const instantiated = poolRuntime(output, target.evm.deployedBytecode, bundle.constructorArguments);
    if (instantiated.runtime !== bundle.explorerRuntime) fail("POOL_EXPLORER_RUNTIME_MISMATCH");
    const record = { address: IMPLEMENTATION, runtime: instantiated.runtime, runtimeKeccak256: keccak256(instantiated.runtime), abi: target.abi,
      inputSha256: manifest.inputSha256, constructorProof: instantiated.proof };
    fs.writeFileSync(path.join(DIR, "pool.compiled.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    out.contracts.pool = { address: IMPLEMENTATION, runtimeKeccak256: record.runtimeKeccak256, runtimeLength: (record.runtime.length - 2) / 2, explorerFullByteMatch: true };
    for (const [file, libraries] of Object.entries(bundle.input.settings.libraries)) for (const [name, address] of Object.entries(libraries)) {
      const target = output.contracts?.[file]?.[name];
      const ast = output.sources[file]?.ast?.nodes?.find(node => node.nodeType === "ContractDefinition" && node.name === name);
      if (!target) fail("LIBRARY_TARGET_MISSING");
      const runtime = libraryRuntime(target.evm.deployedBytecode, address, ast);
      const record = { address, runtime, runtimeKeccak256: keccak256(runtime), abi: target.abi, inputSha256: manifest.inputSha256, sourceFile: file,
        callProtection: { start: 1, length: 20, value: address, rationale: "SOLIDITY_LIBRARY_SELF_ADDRESS_PREFIX" } };
      fs.writeFileSync(path.join(DIR, `${name}.compiled.json`), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
      out.contracts[name] = { address, runtimeKeccak256: record.runtimeKeccak256, runtimeLength: (record.runtime.length - 2) / 2, chainMatch: "unknown" };
    }
    out.compiler = VERSION; out.compilerBinarySha256 = COMPILER_SHA;
    out.status = "AAVE_POOL_AND_LIBRARIES_REBUILT_CHAIN_BINDING_REQUIRED";
  } catch (e) { out.code = e instanceof AaveError ? e.code : "AAVE_BUILD_FAILED"; }
  out.completedAt = new Date().toISOString(); fs.writeFileSync(filename, JSON.stringify(out, null, 2) + "\n", { flag: "wx" }); return out;
}
function withdrawalArtifacts(output, bundle) {
  const records = {};
  const pool = output.contracts?.[bundle.file]?.[bundle.name];
  if (!pool) fail("POOL_TARGET_MISSING");
  const instantiated = poolRuntime(output, pool.evm.deployedBytecode, bundle.constructorArguments);
  if (instantiated.runtime !== bundle.explorerRuntime) fail("POOL_EXPLORER_RUNTIME_MISMATCH");
  records.pool = { address: bundle.address, runtime: instantiated.runtime, runtimeKeccak256: keccak256(instantiated.runtime), abi: pool.abi, constructorProof: instantiated.proof };
  for (const name of ["SupplyLogic", "PoolLogic"]) {
    const files = Object.keys(bundle.input.settings.libraries).filter(file => Object.hasOwn(bundle.input.settings.libraries[file], name));
    if (files.length !== 1) fail("WITHDRAWAL_LIBRARY_IDENTITY_AMBIGUOUS");
    const file = files[0];
    const address = bundle.input.settings.libraries?.[file]?.[name], target = output.contracts?.[file]?.[name];
    const ast = output.sources[file]?.ast?.nodes?.find(node => node.nodeType === "ContractDefinition" && node.name === name);
    if (!address || !target) fail("WITHDRAWAL_LIBRARY_TARGET_MISSING");
    const runtime = libraryRuntime(target.evm.deployedBytecode, address, ast);
    records[name] = { address, runtime, runtimeKeccak256: keccak256(runtime), abi: target.abi, sourceFile: file,
      callProtection: { start: 1, length: 20, value: address, rationale: "SOLIDITY_LIBRARY_SELF_ADDRESS_PREFIX" } };
  }
  return records;
}
async function activeSourceBuild() {
  const directory = path.join(DIR, "active"), filename = path.join(directory, "source-build.json");
  if (fs.existsSync(filename)) fail("ACTIVE_AAVE_SOURCE_EXISTS_NO_RETRY");
  fs.mkdirSync(directory, { recursive: true });
  const out = { schema: "base-paper-active-aave-source-build/v13", generatedAt: new Date().toISOString(), status: "INCOMPLETE", requests: 0,
    implementation: ACTIVE_AAVE.pool, contracts: {}, selectedRuntimeBound: "unknown", quoteEligible: false, signing: false, transactions: 0 };
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(DIR, "active-pointer.json"), "utf8"));
    if (pointer.status !== "AAVE_ACTIVE_POINTER_OBSERVED_SOURCE_BINDING_REQUIRED" || pointer.observation?.implementation !== ACTIVE_AAVE.pool
      || pointer.observation.rpcStrength !== "corroborated-operator-families") fail("ACTIVE_AAVE_POINTER_REFERENCE_INVALID");
    out.requests++;
    const response = await requestJSON(new URL(`https://base.blockscout.com/api/v2/smart-contracts/${ACTIVE_AAVE.pool}`), undefined, 20000);
    const bundle = normalize(response.value, ACTIVE_AAVE.pool);
    if (bundle.name !== "L2PoolInstance" || bundle.compiler !== VERSION) fail("ACTIVE_AAVE_SOURCE_IDENTITY_MISMATCH");
    bundle.input.settings.libraries = librarySettings(bundle.input.settings.libraries);
    bundle.constructorArguments = `0x${String(response.value.constructor_args || "").replace(/^0x/, "")}`;
    if (!/^0x[0-9a-f]{128}$/i.test(bundle.constructorArguments)) fail("ACTIVE_AAVE_CONSTRUCTOR_INVALID");
    const inputText = JSON.stringify(bundle.input, null, 2) + "\n";
    fs.writeFileSync(path.join(directory, "pool.input.json"), inputText, { flag: "wx" });
    fs.writeFileSync(path.join(directory, "pool.bundle.json"), JSON.stringify(bundle, null, 2) + "\n", { flag: "wx" });
    for (const [file, source] of Object.entries(bundle.input.sources)) {
      const destination = path.join(directory, "sources", file);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, source.content, { flag: "wx" });
    }
    const compiler = `C:/Users/MiPC/AppData/Local/Temp/opencode/solc-windows-amd64-v${VERSION}.exe`, stat = fs.lstatSync(compiler);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1048576 || sha(fs.readFileSync(compiler)) !== COMPILER_SHA) fail("COMPILER_CHECKSUM_MISMATCH");
    const build = spawnSync(compiler, ["--standard-json"], { input: inputText, encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1048576, windowsHide: true });
    if (build.status !== 0) fail("ACTIVE_AAVE_COMPILE_FAILED");
    const output = JSON.parse(build.stdout);
    if ((output.errors || []).some(row => row.severity === "error")) fail("ACTIVE_AAVE_COMPILE_FAILED");
    fs.writeFileSync(path.join(directory, "compiler-output.json"), build.stdout, { flag: "wx" });
    const records = withdrawalArtifacts(output, bundle);
    for (const [name, address] of Object.entries(ACTIVE_AAVE)) if (records[name]?.address !== address) fail("ACTIVE_AAVE_LIBRARY_ADDRESS_MISMATCH");
    if (records.pool.runtimeKeccak256 !== pointer.observation.runtimeKeccak256) fail("ACTIVE_AAVE_CORROBORATED_RUNTIME_MISMATCH");
    fs.writeFileSync(path.join(directory, "withdrawal-compiled.json"), JSON.stringify(records, null, 2) + "\n", { flag: "wx" });
    out.status = "ACTIVE_AAVE_SOURCE_REBUILT_POOL_MATCHES_CORROBORATED_HASH";
    out.inputSha256 = sha(inputText); out.sourceCount = Object.keys(bundle.input.sources).length;
    for (const [name, row] of Object.entries(records)) out.contracts[name] = { address: row.address, runtimeKeccak256: row.runtimeKeccak256, runtimeLength: (row.runtime.length - 2) / 2 };
  } catch (e) { out.code = e instanceof AaveError ? e.code : "ACTIVE_AAVE_SOURCE_BUILD_FAILED"; }
  out.completedAt = new Date().toISOString(); fs.writeFileSync(filename, JSON.stringify(out, null, 2) + "\n", { flag: "wx" }); return out;
}
function withdrawalBuild() {
  const filename = path.join(DIR, "withdrawal-build.json");
  if (fs.existsSync(filename)) fail("WITHDRAWAL_BUILD_EXISTS_NO_RETRY");
  const out = { schema: "base-paper-aave-withdrawal-specific-build/v13", generatedAt: new Date().toISOString(), status: "INCOMPLETE", contracts: {},
    scope: "POOL_WITHDRAWAL_AND_ACCOUNT_READ_LIBRARIES_ONLY", sourceRuntimeBound: "unknown", quoteEligible: false, signing: false, transactions: 0 };
  try {
    const input = fs.readFileSync(path.join(DIR, "pool.input.json")), manifest = JSON.parse(fs.readFileSync(path.join(DIR, "source.json"), "utf8"));
    if (sha(input) !== manifest.inputSha256) fail("AAVE_INPUT_CHANGED");
    const output = JSON.parse(fs.readFileSync(path.join(DIR, "compiler-output.json"), "utf8"));
    const bundle = JSON.parse(fs.readFileSync(path.join(DIR, "pool.bundle.json"), "utf8"));
    const records = withdrawalArtifacts(output, bundle);
    fs.writeFileSync(path.join(DIR, "withdrawal-compiled.json"), JSON.stringify(records, null, 2) + "\n", { flag: "wx" });
    for (const [name, row] of Object.entries(records)) out.contracts[name] = { address: row.address, runtimeKeccak256: row.runtimeKeccak256, runtimeLength: (row.runtime.length - 2) / 2 };
    out.inputSha256 = manifest.inputSha256;
    out.excludedCompilerSetting = "ConfiguratorLogic is not in the recovered Pool source closure or selected withdrawal path";
    out.status = "WITHDRAWAL_LIBRARIES_REBUILT_CHAIN_BINDING_REQUIRED";
  } catch (e) { out.code = e instanceof AaveError ? e.code : "WITHDRAWAL_BUILD_FAILED"; }
  out.completedAt = new Date().toISOString(); fs.writeFileSync(filename, JSON.stringify(out, null, 2) + "\n", { flag: "wx" }); return out;
}
function declaredLibrarySettings(settings, output) {
  const normalized = {}, proof = [], seen = new Set();
  for (const [serviceFile, libraries] of Object.entries(settings)) for (const [name, address] of Object.entries(libraries)) {
    if (seen.has(name)) fail("AMBIGUOUS_SERVICE_LIBRARY_NAME");
    seen.add(name);
    const matches = Object.entries(output.sources).filter(([, source]) => (source.ast?.nodes || []).some(node => node.nodeType === "ContractDefinition" && node.contractKind === "library" && node.name === name));
    if (matches.length !== 1) fail("LIBRARY_DECLARATION_AMBIGUOUS");
    const file = matches[0][0];
    normalized[file] ||= {}; normalized[file][name] = address;
    proof.push({ name, serviceFile, declarationFile: file, address, addressChanged: false });
  }
  return { normalized, proof };
}
function activeLinkedBuild() {
  const directory = path.join(DIR, "active"), filename = path.join(directory, "linked-build.json");
  if (fs.existsSync(filename)) fail("ACTIVE_LINK_BUILD_EXISTS_NO_RETRY");
  const out = { schema: "base-paper-active-aave-linked-build/v13", generatedAt: new Date().toISOString(), status: "INCOMPLETE", requests: 0,
    implementation: ACTIVE_AAVE.pool, contracts: {}, quoteEligible: false, signing: false, transactions: 0 };
  try {
    const bundle = JSON.parse(fs.readFileSync(path.join(directory, "pool.bundle.json"), "utf8"));
    const unlinked = JSON.parse(fs.readFileSync(path.join(directory, "compiler-output.json"), "utf8"));
    const mapped = declaredLibrarySettings(bundle.input.settings.libraries, unlinked);
    bundle.input.settings.libraries = mapped.normalized;
    out.libraryPathNormalization = mapped.proof;
    const input = JSON.stringify(bundle.input, null, 2) + "\n";
    fs.writeFileSync(path.join(directory, "linked.input.json"), input, { flag: "wx" });
    const compiler = `C:/Users/MiPC/AppData/Local/Temp/opencode/solc-windows-amd64-v${VERSION}.exe`, stat = fs.lstatSync(compiler);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1048576 || sha(fs.readFileSync(compiler)) !== COMPILER_SHA) fail("COMPILER_CHECKSUM_MISMATCH");
    const built = spawnSync(compiler, ["--standard-json"], { input, encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1048576, windowsHide: true });
    if (built.status !== 0) fail("ACTIVE_LINK_COMPILE_FAILED");
    const output = JSON.parse(built.stdout);
    if ((output.errors || []).some(row => row.severity === "error")) fail("ACTIVE_LINK_COMPILE_FAILED");
    fs.writeFileSync(path.join(directory, "linked-compiler-output.json"), built.stdout, { flag: "wx" });
    const records = withdrawalArtifacts(output, bundle), pointer = JSON.parse(fs.readFileSync(path.join(DIR, "active-pointer.json"), "utf8"));
    for (const [name, address] of Object.entries(ACTIVE_AAVE)) if (records[name]?.address !== address) fail("ACTIVE_LINK_ADDRESS_MISMATCH");
    if (records.pool.runtimeKeccak256 !== pointer.observation.runtimeKeccak256) fail("ACTIVE_LINK_RUNTIME_MISMATCH");
    fs.writeFileSync(path.join(directory, "withdrawal-compiled.json"), JSON.stringify(records, null, 2) + "\n", { flag: "wx" });
    out.status = "ACTIVE_AAVE_LINKED_EXACT_POOL_MATCH"; out.inputSha256 = sha(input);
    for (const [name, value] of Object.entries(records)) out.contracts[name] = { address: value.address, runtimeKeccak256: value.runtimeKeccak256, runtimeLength: (value.runtime.length - 2) / 2 };
  } catch (e) { out.code = e instanceof AaveError ? e.code : "ACTIVE_LINK_BUILD_FAILED"; }
  out.completedAt = new Date().toISOString(); fs.writeFileSync(filename, JSON.stringify(out, null, 2) + "\n", { flag: "wx" }); return out;
}
function withdrawalGuards(configuration, userConfiguration, index, scaledBalance, virtualCash, underlyingCash) {
  if (index <= 0n) fail("LIQUIDITY_INDEX_INVALID");
  const active = Boolean(configuration & (1n << 56n)), paused = Boolean(configuration & (1n << 60n));
  const borrowingAny = Boolean(userConfiguration & BigInt("0x" + "55".repeat(32)));
  return [1n, 100n].map(size => {
    const amount = size * 1000000n, scaled = (amount * 10n ** 27n + index - 1n) / index;
    return { amountUsdcRaw: amount.toString(), scaledBurnRaw: scaled.toString(), active, paused, borrowingAny,
      scaledBalanceSufficient: scaled <= scaledBalance, virtualBalanceSufficient: amount <= virtualCash, underlyingBalanceSufficient: amount <= underlyingCash,
      checkedGuardsClear: active && !paused && !borrowingAny && scaled <= scaledBalance && amount <= virtualCash && amount <= underlyingCash,
      transferSuccess: "unknown" };
  });
}
async function bindWithdrawal(deps = {}) {
  const clock = deps.clock || Date.now, started = clock(), transport = deps.transport || requestJSON;
  const out = { schema: "base-paper-aave-withdrawal-binding/v13", generatedAt: new Date(started).toISOString(), status: "INCOMPLETE", requests: 0, bytes: 0,
    qualification: { attempted: 0, qualified: 0, selectedFamilyCount: 0, failures: {} }, observation: null,
    gates: { selectedAaveRuntimeBound: "unknown", fullWithdrawalDependenciesBound: false, quoteEligible: false, executableNow: "unknown", profitabilityClaim: false, signedActionJustified: false },
    safety: { readOnlyRpc: true, inventoryRead: false, endpointMaterialPersisted: false, walletAccess: false, signing: false, transactions: 0, retries: 0 } };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const budget = () => { if (out.requests >= 100 || clock() - started >= 180000) fail("RPC_BUDGET_EXHAUSTED"); };
  const rpc = async (candidate, method, params) => {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call"].includes(method)) fail("METHOD_FORBIDDEN");
    budget(); if (!deps.transport) await new Promise(resolve => setTimeout(resolve, 200)); budget();
    const id = ++out.requests; let response;
    try { response = await transport(candidate.url, { jsonrpc: "2.0", id, method, params }, Math.min(8000, 180000 - (clock() - started))); }
    catch { fail("TRANSPORT_UNAVAILABLE"); }
    if (clock() - started >= 180000) fail("RPC_BUDGET_EXHAUSTED");
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > 1048576) fail("RESPONSE_CAP");
    out.bytes += response.bytes; if (out.bytes > 16 * 1048576) fail("RESPONSE_CAP");
    if (response.value?.jsonrpc !== "2.0" || response.value.id !== id || Object.hasOwn(response.value, "error") || !Object.hasOwn(response.value, "result")) fail("RPC_UNAVAILABLE");
    return response.value.result;
  };
  try {
    if ((deps.core || deps.records || deps.candidates || deps.clock) && !deps.transport) fail("INJECTED_TRANSPORT_REQUIRED");
    const core = deps.core || JSON.parse(fs.readFileSync(path.join(DIR, deps.freshCore ? "core-refresh.json" : "../active-core-state.json"), "utf8"));
    if (core.status !== "TOKEN_CORE_GUARDS_CLEAR_AAVE_BINDING_REQUIRED" || core.gates?.tokenRoleRuntimeBound !== "true" || core.observation?.rpcStrength !== "corroborated-operator-families") fail("CORE_REFERENCE_INVALID");
    const pin = core.observation.pin, tag = `0x${BigInt(pin.number).toString(16)}`, block = { blockHash: pin.hash, requireCanonical: true };
    const fresh = () => { const age = BigInt(Math.floor(clock() / 1000)) - BigInt(pin.timestamp); if (age < -60n || age > 3600n) fail("CORE_PIN_STALE"); };
    fresh();
    const records = deps.records || JSON.parse(fs.readFileSync(path.join(DIR, deps.activeAave ? "active/withdrawal-compiled.json" : "withdrawal-compiled.json"), "utf8"));
    const expected = deps.activeAave ? ACTIVE_AAVE : { pool: IMPLEMENTATION, SupplyLogic: "0x034fd14b9ae6bb066a1f9f85a55e990b0b25c168", PoolLogic: "0xe51b69e5722bf547866a4d7bc190c6e81b626806" };
    for (const [name, address] of Object.entries(expected)) {
      const value = records[name];
      if (value?.address !== address || !/^0x(?:[0-9a-f]{2})+$/i.test(value.runtime || "") || keccak256(value.runtime) !== value.runtimeKeccak256) fail("AAVE_COMPILED_REFERENCE_INVALID");
    }
    const pool = new Interface(records.pool.abi), token = new Interface(["function scaledBalanceOf(address) view returns(uint256)", "function balanceOf(address) view returns(uint256)"]);
    const call = async (candidate, to, iface, name, args) => {
      if (![AAVE.pool, AAVE.aToken, CORE.usdc].includes(to) || iface.getFunction(name)?.stateMutability !== "view") fail("CALL_FORBIDDEN");
      const raw = await rpc(candidate, "eth_call", [{ to, data: iface.encodeFunctionData(name, args), gas: "0x1e8480" }, block]);
      try { const values = iface.decodeFunctionResult(name, raw); if (iface.encodeFunctionResult(name, values).toLowerCase() !== raw.toLowerCase()) fail("ABI_INVALID"); return values; }
      catch { fail("ABI_INVALID"); }
    };
    const getHeader = async (candidate, number) => { const raw = await rpc(candidate, "eth_getBlockByNumber", [number, false]); try { return header(raw); } catch { fail("HEADER_INVALID"); } };
    if (!deps.candidates) out.safety.inventoryRead = true;
    const candidates = deps.candidates || readCandidates();
    if (!Array.isArray(candidates) || candidates.length > 8) fail("CANDIDATE_CAP");
    const qualified = [];
    for (const candidate of candidates) {
      out.qualification.attempted++;
      try {
        if (await rpc(candidate, "eth_chainId", []) !== "0x2105") fail("CHAIN_MISMATCH");
        if (BigInt((await getHeader(candidate, "finalized")).number) < BigInt(pin.number)) fail("FINALITY_BEHIND_CORE_PIN");
        if (!equal(await getHeader(candidate, tag), pin)) fail("CORE_PIN_DISAGREEMENT");
        const code = await rpc(candidate, "eth_getCode", [expected.pool, block]);
        if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) fail("CODE_INVALID");
        await call(candidate, AAVE.pool, pool, "getConfiguration", [CORE.usdc]);
        qualified.push(candidate); out.qualification.qualified = qualified.length;
      } catch (e) {
        const code = e instanceof AaveError ? e.code : "UNEXPECTED_FAILURE";
        out.qualification.failures[code] = (out.qualification.failures[code] || 0) + 1;
        if (["RPC_BUDGET_EXHAUSTED", "RESPONSE_CAP"].includes(code)) throw e;
      }
    }
    const selected = [];
    for (const candidate of qualified) if (candidate.family && !selected.some(other => other.family === candidate.family)) selected.push(candidate);
    if (selected.length < 2) fail("TWO_CAPABLE_FAMILIES_UNAVAILABLE");
    selected.length = 2; out.qualification.selectedFamilyCount = 2;
    if (deps.pointerOnly) {
      const observations = [];
      for (const candidate of selected) {
        const pointer = addressWord(await rpc(candidate, "eth_getStorageAt", [AAVE.pool, SLOT, block]));
        if (/^0x0{40}$/.test(pointer)) fail("AAVE_IMPLEMENTATION_ABSENT");
        const runtime = await rpc(candidate, "eth_getCode", [pointer, block]);
        if (typeof runtime !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(runtime) || runtime.length > 65538) fail("ACTIVE_AAVE_RUNTIME_INVALID");
        observations.push({ implementation: pointer, runtimeKeccak256: keccak256(runtime), runtimeLength: (runtime.length - 2) / 2 });
      }
      if (!equal(observations[0], observations[1])) fail("AAVE_POINTER_DISAGREEMENT");
      for (const candidate of selected) if (!equal(await getHeader(candidate, tag), pin)) fail("TERMINAL_PIN_CHANGED");
      fresh();
      out.observation = { pin, corePinMatched: true, rpcStrength: "corroborated-operator-families", upstreamIndependenceProven: false,
        ...observations[0], previousSourceImplementation: IMPLEMENTATION, previousSourceMatchesPointer: observations[0].implementation === IMPLEMENTATION };
      out.status = "AAVE_ACTIVE_POINTER_OBSERVED_SOURCE_BINDING_REQUIRED";
      out.completedAt = new Date(clock()).toISOString(); return out;
    }
    const views = [];
    for (const candidate of selected) {
      const matches = {};
      for (const [name, address] of Object.entries(expected)) {
        const code = await rpc(candidate, "eth_getCode", [address, block]);
        if (typeof code !== "string" || code.toLowerCase() !== records[name].runtime) fail("AAVE_RUNTIME_MISMATCH");
        matches[name] = { address, runtimeKeccak256: records[name].runtimeKeccak256, fullByteMatch: true };
      }
      const pointer = addressWord(await rpc(candidate, "eth_getStorageAt", [AAVE.pool, SLOT, block]));
      if (pointer !== expected.pool) {
        out.failureContext = { expected: expected.pool, observed: pointer, pin, corroborated: false };
        fail("AAVE_IMPLEMENTATION_CHANGED");
      }
      const configuration = (await call(candidate, AAVE.pool, pool, "getConfiguration", [CORE.usdc]))[0][0];
      const userConfiguration = (await call(candidate, AAVE.pool, pool, "getUserConfiguration", [CASH]))[0][0];
      const index = (await call(candidate, AAVE.pool, pool, "getReserveNormalizedIncome", [CORE.usdc]))[0];
      const scaled = (await call(candidate, AAVE.aToken, token, "scaledBalanceOf", [CASH]))[0];
      const virtualCash = (await call(candidate, AAVE.pool, pool, "getVirtualUnderlyingBalance", [CORE.usdc]))[0];
      const cash = (await call(candidate, CORE.usdc, token, "balanceOf", [AAVE.aToken]))[0];
      views.push({ runtimeBound: matches, implementation: pointer, configurationRaw: configuration.toString(), userConfigurationRaw: userConfiguration.toString(),
        liquidityIndexRay: index.toString(), scaledATokenBalanceRaw: scaled.toString(), virtualUnderlyingRaw: virtualCash.toString(), actualUnderlyingRaw: cash.toString(),
        sizeGuards: withdrawalGuards(configuration, userConfiguration, index, scaled, virtualCash, cash), remainingExternalCallsVerified: false });
    }
    if (!equal(views[0], views[1])) fail("AAVE_STATE_DISAGREEMENT");
    for (const candidate of selected) { if (!equal(await getHeader(candidate, tag), pin)) fail("TERMINAL_PIN_CHANGED"); }
    fresh();
    out.observation = { pin, corePinMatched: true, rpcStrength: "corroborated-operator-families", upstreamIndependenceProven: false, ...views[0] };
    out.gates.selectedAaveRuntimeBound = "true";
    out.status = "AAVE_WITHDRAWAL_LIBRARIES_BOUND_EXTERNAL_CALLS_UNPROVEN";
  } catch (e) { out.code = e instanceof AaveError ? e.code : "AAVE_BINDING_FAILED"; }
  out.completedAt = new Date(clock()).toISOString(); return out;
}
async function bindOnce(freshCore = false) {
  const filename = path.join(DIR, freshCore ? "fresh-withdrawal-state.json" : "withdrawal-state.json");
  if (fs.existsSync(filename)) fail("AAVE_BINDING_EXISTS_NO_RETRY");
  if (freshCore) {
    const coreFilename = path.join(DIR, "core-refresh.json");
    if (fs.existsSync(coreFilename)) fail("CORE_REFRESH_EXISTS_NO_RETRY");
    const core = await coreState({ activeToken: true }), encoded = JSON.stringify(core, null, 2) + "\n";
    if (/(?:https?|wss?):\/\//i.test(encoded)) fail("OUTPUT_NOT_SANITIZED");
    fs.writeFileSync(coreFilename, encoded, { flag: "wx" });
  }
  const out = await bindWithdrawal({ freshCore }), encoded = JSON.stringify(out, null, 2) + "\n";
  if (/(?:https?|wss?):\/\//i.test(encoded)) fail("OUTPUT_NOT_SANITIZED");
  fs.writeFileSync(filename, encoded, { flag: "wx" }); return out;
}
async function pointerOnce() {
  const filename = path.join(DIR, "active-pointer.json");
  if (fs.existsSync(filename)) fail("POINTER_DIAGNOSTIC_EXISTS_NO_RETRY");
  const out = await bindWithdrawal({ freshCore: true, pointerOnly: true }), encoded = JSON.stringify(out, null, 2) + "\n";
  if (/(?:https?|wss?):\/\//i.test(encoded)) fail("OUTPUT_NOT_SANITIZED");
  fs.writeFileSync(filename, encoded, { flag: "wx" }); return out;
}
async function activeBindOnce() {
  const filename = path.join(DIR, "active/withdrawal-state.json");
  if (fs.existsSync(filename)) fail("ACTIVE_BINDING_EXISTS_NO_RETRY");
  const out = await bindWithdrawal({ freshCore: true, activeAave: true }), encoded = JSON.stringify(out, null, 2) + "\n";
  if (/(?:https?|wss?):\/\//i.test(encoded)) fail("OUTPUT_NOT_SANITIZED");
  fs.writeFileSync(filename, encoded, { flag: "wx" }); return out;
}
module.exports = { librarySettings, poolRuntime, libraryRuntime, withdrawalArtifacts, declaredLibrarySettings, withdrawalGuards, bindWithdrawal, source, build, DIR, IMPLEMENTATION, VERSION, COMPILER_SHA, ACTIVE_AAVE };
if (require.main === module) {
  const mode = process.argv.slice(2).join(" ");
  if (!["--source-once", "--build-once", "--withdrawal-build-once", "--bind-once", "--bind-fresh-once", "--pointer-once", "--active-source-build-once", "--active-link-build-once", "--active-bind-once"].includes(mode)) throw new Error("EXPLICIT_AAVE_SOURCE_OR_BUILD_REQUIRED");
  Promise.resolve().then(() => mode === "--source-once" ? source() : mode === "--build-once" ? build() : mode === "--pointer-once" ? pointerOnce() : mode === "--active-source-build-once" ? activeSourceBuild() : mode === "--active-link-build-once" ? activeLinkedBuild() : mode === "--active-bind-once" ? activeBindOnce() : mode === "--bind-once" || mode === "--bind-fresh-once" ? bindOnce(mode === "--bind-fresh-once") : withdrawalBuild()).then(out => { console.log(JSON.stringify(out)); if (out.status === "INCOMPLETE") process.exitCode = 1; }).catch(() => { console.error("R13_AAVE_FAILED_CLOSED"); process.exitCode = 1; });
}
