#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { keccak256, zeroPadValue } = require("ethers");
const ROOT = path.resolve(__dirname, "..");
const OUT = "reports/raw/fast/aave-ethereum-emode-47-48-r6-offline";
const AGENT = "src/contracts/agent/AaveEModeAgent.sol";
const AAVE = "targets/aave-risk-agents-c09d73bc";
const CHAOS = "targets/chaos-agents-b365c58b";
const V3 = "lib/aave-helpers/lib/aave-address-book/lib/aave-v3-origin/";
const UTILS = `${V3}lib/solidity-utils/`;
const OZ = `${UTILS}lib/openzeppelin-contracts-upgradeable/`;
const SOLC = "C:/Users/MiPC/AppData/Roaming/svm/0.8.27/solc-0.8.27";
const SOLC_SHA = "8474166f631caa0c51618fddb89ca149080f69c27db06f94bd323eb69f87ffd8";
const FIXTURE = "reports/raw/fast/aave-ethereum-emode-47-48-r5-proxy-code.json";
const EXPLORER = Object.freeze({
  AgentHub: { file: "C:/Users/MiPC/.local/share/opencode/tool-output/tool_0820c1dfe001e6AOCX91vm1bjX",
    sha256: "2034a9f6b6167ed0946df1866d2625bacae211786c32d6e8cddc4907952a3b2b", runtimeKeccak256: "0x654f68fa72fa38eafbc5e15039fbad0aa373c95378c9b0322bca4fd8041ac538" },
  RangeValidationModule: { file: "C:/Users/MiPC/.local/share/opencode/tool-output/tool_0820c123000153Hbxl0mhfaCHs",
    sha256: "16febbbdeac92c942f0ce02103c7e13d1aef5d9d649a44a1c88509fe50d3f500", runtimeKeccak256: "0x14f776d0b21549fc4e478acbf64e084f12424da69124c061140a1dbc1a3e5cfb" }
});
const PINS = Object.freeze({
  "tools/run-aave-ethereum-emode-47-48-r5.js": "2b0678fea95aca0203a52ff502603eddcc8ea1c7f64b25ba81ed723d9ac39ed5",
  "reports/raw/fast/aave-ethereum-emode-47-48-r5.json": "75d205ff5178a733482fc55bb04313425573c256e8cc0aef4873d47fce809c45",
  [FIXTURE]: "ee16fb63f85e6d9c5ec15fdf0ad5965dac35b15ca498dac98334cde1cedba6b0"
});
const REPOS = Object.freeze({
  aave: { root: AAVE, commit: "c09d73bc4080a7d14114957dc30cbdfe0b4cb326", prefix: "" },
  chaos: { root: CHAOS, commit: "b365c58bf040c32521266cf10a4e70da9a8b7d4f", prefix: "lib/chaos-agents/" },
  helpers: { root: `${AAVE}/lib/aave-helpers`, commit: "8611451ca42c5ad846764c711ef063df8c914bb4", prefix: "lib/aave-helpers/" },
  book: { root: `${AAVE}/lib/aave-helpers/lib/aave-address-book`, commit: "a3b91a1248388bc7b39c7e8f1d642f4a68ff3f82", prefix: "lib/aave-helpers/lib/aave-address-book/" },
  origin: { root: `${AAVE}/${V3}`, commit: "1ce897ba99d5a9ab659861b591576cd4278e9e27", prefix: V3 },
  utils: { root: `${CHAOS}/lib/solidity-utils`, commit: "039931241e49d78b4d0a798e1fff4da3eb40cc35", prefix: UTILS },
  ozUpgradeable: { root: `${CHAOS}/lib/solidity-utils/lib/openzeppelin-contracts-upgradeable`, commit: "fa525310e45f91eb20a6d3baa2644be8e0adba31", prefix: OZ },
  oz: { root: `${CHAOS}/lib/solidity-utils/lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts`, commit: "69c8def5f222ff96f2b5beff05dfba996368aa79", prefix: `${OZ}lib/openzeppelin-contracts/` }
});
const EDGES = [
  ["aave", "lib/chaos-agents", "chaos"], ["aave", "lib/aave-helpers", "helpers"], ["helpers", "lib/aave-address-book", "book"],
  ["book", "lib/aave-v3-origin", "origin"], ["origin", "lib/solidity-utils", "utils"],
  ["utils", "lib/openzeppelin-contracts-upgradeable", "ozUpgradeable"], ["ozUpgradeable", "lib/openzeppelin-contracts", "oz"]
];
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
class BuildError extends Error { constructor(code, detail = null) { super(code); this.detail = detail; } }
const fail = (code, detail) => { throw new BuildError(code, detail); };
function pinned(relative, expected) {
  const file = path.isAbsolute(relative) ? relative : path.join(ROOT, relative), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024 || path.resolve(fs.realpathSync(file)) !== path.resolve(file)) fail("INPUT_PATH_INVALID");
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== expected) fail("INPUT_HASH_MISMATCH", relative);
  return bytes;
}
pinned("tools/run-aave-ethereum-emode-47-48-r5.js", PINS["tools/run-aave-ethereum-emode-47-48-r5.js"]);
const r5 = require("./run-aave-ethereum-emode-47-48-r5.js"), { r4 } = r5;
const childEnv = () => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP, TMP: process.env.TMP, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_GLOBAL: "NUL", GIT_CONFIG_SYSTEM: "NUL" });
function git(repo, args, input) {
  try {
    return execFileSync("git", ["-c", "protocol.allow=never", ...args], { cwd: path.join(ROOT, repo.root), env: childEnv(),
      input, timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (_) { fail("LOCAL_GIT_OBJECT_UNAVAILABLE", { root: repo.root, commit: repo.commit, operation: args[0] }); }
}
function gitBlob(repo, file) {
  if (!/^[A-Za-z0-9_./-]+$/.test(file) || file.split("/").includes("..") || file.startsWith("/")) fail("SOURCE_PATH_INVALID");
  const raw = git(repo, ["cat-file", "--batch"], `${repo.commit}:${file}\n`), newline = raw.indexOf(10);
  const header = raw.subarray(0, newline).toString("utf8").match(/^([0-9a-f]{40}) blob ([0-9]+)$/);
  if (!header) fail("LOCAL_BLOB_MISSING", { root: repo.root, commit: repo.commit, file });
  const size = Number(header[2]), bytes = raw.subarray(newline + 1, newline + 1 + size);
  const oid = crypto.createHash("sha1").update(Buffer.from(`blob ${size}\0`)).update(bytes).digest("hex");
  if (size > 1048576 || bytes.length !== size || oid !== header[1]) fail("GIT_BLOB_INVALID");
  return { bytes, oid };
}
function verifyRepositories() {
  const manifest = {};
  for (const [key, repo] of Object.entries(REPOS)) {
    const tree = git(repo, ["rev-parse", `${repo.commit}^{tree}`]).toString("utf8").trim();
    if (!/^[0-9a-f]{40}$/.test(tree)) fail("GIT_TREE_INVALID");
    manifest[key] = { ...repo, tree, sourceBasis: "committed Git objects; worktree excluded" };
  }
  for (const [parent, file, child] of EDGES) {
    const line = git(REPOS[parent], ["ls-tree", REPOS[parent].commit, file]).toString("utf8").trim();
    if (line !== `160000 commit ${REPOS[child].commit}\t${file}`) fail("DEPENDENCY_PIN_MISMATCH", { parent, file, child });
  }
  return manifest;
}
function resolveImport(importer, name, remappings) {
  if (!/^[A-Za-z0-9_@./-]+\.sol$/.test(name) || name.startsWith("/")) fail("IMPORT_INVALID", name);
  let result;
  if (name.startsWith(".")) result = path.posix.normalize(path.posix.join(path.posix.dirname(importer), name));
  else {
    const candidates = remappings.map((row) => {
      const [left, replacement] = row.split("="), colon = left.indexOf(":");
      return { context: colon < 0 ? "" : left.slice(0, colon), prefix: colon < 0 ? left : left.slice(colon + 1), replacement };
    }).filter((row) => importer.startsWith(row.context) && name.startsWith(row.prefix))
      .sort((a, b) => b.context.length - a.context.length || b.prefix.length - a.prefix.length);
    if (!candidates.length) fail("IMPORT_UNMAPPED", { importer, name });
    result = `${candidates[0].replacement}${name.slice(candidates[0].prefix.length)}`;
  }
  if (result.split("/").includes("..") || !/^(src|lib)\/[A-Za-z0-9_./-]+\.sol$/.test(result)) fail("IMPORT_OUTSIDE_SCOPE", result);
  return result;
}
function agentInput() {
  const remapBlob = gitBlob(REPOS.aave, "remappings.txt"), configBlob = gitBlob(REPOS.aave, "foundry.toml");
  const config = configBlob.bytes.toString("utf8");
  if (!config.includes("solc = '0.8.27'") || !config.includes("bytecode_hash = 'none'") || !config.includes("optimizer_runs = 200")
    || !config.includes("evm_version = 'shanghai'")) fail("BUILD_CONFIG_MISMATCH");
  const remappings = remapBlob.bytes.toString("utf8").trim().split(/\r?\n/).map((line) => line.endsWith("/") ? line : `${line}/`);
  const sources = {}, manifest = {}, queue = [AGENT];
  let bytes = 0;
  while (queue.length) {
    const file = queue.shift(); if (Object.hasOwn(sources, file)) continue;
    if (Object.keys(sources).length >= 128) fail("SOURCE_COUNT_LIMIT");
    const [key, repo] = Object.entries(REPOS).filter(([, row]) => file.startsWith(row.prefix)).sort((a, b) => b[1].prefix.length - a[1].prefix.length)[0];
    const blob = gitBlob(repo, file.slice(repo.prefix.length)), content = new TextDecoder("utf8", { fatal: true }).decode(blob.bytes);
    bytes += blob.bytes.length; if (bytes > 8 * 1024 * 1024) fail("SOURCE_BYTE_LIMIT");
    sources[file] = { content }; manifest[file] = { repository: key, commit: repo.commit, blob: blob.oid, sha256: sha(blob.bytes), keccak256: keccak256(blob.bytes) };
    const scan = content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
    for (const statement of scan.matchAll(/\bimport\s+([^;]+);/g)) {
      const names = [...statement[1].matchAll(/['"]([^'"]+)['"]/g)];
      if (names.length !== 1) fail("IMPORT_SYNTAX_UNSUPPORTED", file);
      queue.push(resolveImport(file, names[0][1], remappings));
    }
  }
  return { input: { language: "Solidity", sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))),
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai", metadata: { bytecodeHash: "none" }, remappings,
      outputSelection: { "*": { "": ["ast"] }, [AGENT]: { AaveEModeAgent: ["abi", "metadata", "evm.bytecode", "evm.deployedBytecode"] } } } },
    manifest, config: { foundryBlob: configBlob.oid, remappingBlob: remapBlob.oid, directoryRemappingsNormalizedWithTrailingSlash: true } };
}
function coreInput() {
  const sources = {}, settings = [], artifacts = {};
  for (const name of ["AgentHub", "RangeValidationModule"]) {
    const file = `${CHAOS}/out-shanghai/${name}.sol/${name}.json`, artifact = JSON.parse(pinned(file, r4.PINS[file])); artifacts[name] = artifact;
    const { compilationTarget, ...rest } = artifact.metadata.settings; settings.push(rest);
    for (const [source, meta] of Object.entries(artifact.metadata.sources)) {
      if (!/^(src|lib)\/[A-Za-z0-9_./-]+\.sol$/.test(source) || source.split("/").includes("..")) fail("SOURCE_PATH_INVALID");
      const content = fs.readFileSync(path.join(ROOT, CHAOS, source), "utf8").replace(/\r\n/g, "\n");
      if (keccak256(Buffer.from(content)) !== meta.keccak256) fail("CORE_SOURCE_MISMATCH", source);
      sources[source] = { content };
    }
  }
  if (r4.stable(settings[0]) !== r4.stable(settings[1])) fail("CORE_SETTINGS_MISMATCH");
  return { artifacts, input: { language: "Solidity", sources, settings: { ...settings[0], outputSelection: {
    "src/contracts/AgentHub.sol": { AgentHub: ["abi", "metadata", "evm.bytecode", "evm.deployedBytecode"] },
    "src/contracts/modules/RangeValidationModule.sol": { RangeValidationModule: ["abi", "metadata", "evm.bytecode", "evm.deployedBytecode"] }
  } } } };
}
function fullIdentity(runtime) {
  if (typeof runtime !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(runtime) || runtime.length > 131074) fail("RUNTIME_INVALID");
  return { bytes: (runtime.length - 2) / 2, keccak256: keccak256(runtime) };
}
function verifyProxy(runtime, expected) {
  const observed = fullIdentity(runtime);
  if (observed.bytes !== expected.bytes || observed.keccak256 !== expected.keccak256) fail("PROXY_FULL_RUNTIME_MISMATCH");
  return { ...observed, exactFullRuntimeMatch: true, metadataNormalization: "none" };
}
function retainedRuntimes() {
  const observed = {};
  for (const [name, source] of Object.entries(EXPLORER)) {
    const text = pinned(source.file, source.sha256).toString("utf8");
    const values = [...new Set((text.match(/(?:0x)?[a-fA-F0-9]{1000,}/g) || []).map((value) => `0x${value.replace(/^0x/, "").toLowerCase()}`))]
      .filter((value) => (value.length - 2) % 2 === 0 && keccak256(value) === source.runtimeKeccak256);
    if (values.length !== 1) fail("RETAINED_RUNTIME_UNAVAILABLE", name);
    observed[name] = { ...source, runtime: values[0], evidence: "retained public explorer response; no new retrieval" };
  }
  return observed;
}
function compareCore(runtime, observed) {
  const compiled = r4.codeIdentity(runtime), recorded = r4.codeIdentity(observed.runtime);
  return { exactFullRuntimeMatch: compiled.keccak256 === recorded.keccak256,
    normalizedRuntimeMatch: compiled.executableKeccak256 === recorded.executableKeccak256 && compiled.executableBytes === recorded.executableBytes,
    metadataPolicy: "validated Solidity 0.8.27 IPFS trailer for this implementation, not for the proxy",
    observedFullRuntime: fullIdentity(observed.runtime), compiledMetadataHex: compiled.metadataHex, observedMetadataHex: recorded.metadataHex };
}
function prepare() {
  for (const [file, hash] of Object.entries(PINS)) pinned(file, hash);
  const previous = JSON.parse(pinned("reports/raw/fast/aave-ethereum-emode-47-48-r5.json", PINS["reports/raw/fast/aave-ethereum-emode-47-48-r5.json"]));
  r5.validateReport(previous.report);
  if (previous.sha256 !== sha(r4.stable(previous.report)) || previous.report.implementation?.address !== r4.A.hubImplementation) fail("SLOT_EVIDENCE_INVALID");
  const sourceHashes = { ...previous.report.sourceHashes, ...PINS,
    "tools/build-aave-ethereum-emode-47-48-r6.js": sha(fs.readFileSync(__filename)),
    "tools/test-build-aave-ethereum-emode-47-48-r6.js": sha(fs.readFileSync(path.join(__dirname, "test-build-aave-ethereum-emode-47-48-r6.js"))) };
  for (const [file, hash] of Object.entries(sourceHashes)) pinned(file, hash);
  const authority = r4.readAuthority(), fixture = JSON.parse(pinned(FIXTURE, PINS[FIXTURE]));
  const proxy = verifyProxy(fixture.runtime, authority.r3.report.observations.current.code.hub);
  pinned(SOLC, SOLC_SHA);
  const version = execFileSync(SOLC, ["--version"], { encoding: "utf8", timeout: 10000, env: childEnv() }).trim();
  if (!version.includes("0.8.27+commit.40a35a09.Windows.msvc")) fail("COMPILER_VERSION_MISMATCH");
  return { authority, sourceHashes, proxy, observed: retainedRuntimes(), repositories: verifyRepositories(), agent: agentInput(), core: coreInput(), compiler: { path: SOLC,
    sha256: SOLC_SHA, version, releaseAuthenticity: "local cached binary; no new release attestation" } };
}
function compile(input) {
  if (input.language !== "Solidity" || Object.entries(input.sources || {}).some(([file, source]) => !/^(src|lib)\/[A-Za-z0-9_./-]+\.sol$/.test(file)
    || file.split("/").includes("..") || Object.keys(source).join() !== "content" || typeof source.content !== "string")) fail("NONLITERAL_COMPILER_INPUT");
  pinned(SOLC, SOLC_SHA);
  let raw;
  try { raw = execFileSync(SOLC, ["--standard-json"], { input: JSON.stringify(input), cwd: ROOT, env: childEnv(),
    timeout: 120000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (_) { fail("COMPILER_PROCESS_FAILED"); }
  pinned(SOLC, SOLC_SHA);
  let output; try { output = JSON.parse(raw.toString("utf8")); } catch (_) { fail("COMPILER_JSON_INVALID"); }
  const errors = (output.errors || []).filter((error) => error.severity === "error");
  if (errors.length) fail("COMPILATION_FAILED", errors.map((error) => ({ code: error.errorCode, message: error.message, location: error.sourceLocation })));
  return output;
}
function instantiateAgent(output) {
  const contract = output.contracts?.[AGENT]?.AaveEModeAgent, refs = contract?.evm?.deployedBytecode?.immutableReferences;
  if (!refs || Object.keys(refs).length !== 4 || Object.keys(contract.evm.deployedBytecode.linkReferences || {}).length) fail("IMMUTABLE_SCHEMA_INVALID");
  fullIdentity(`0x${contract.evm.deployedBytecode.object}`);
  const runtime = Buffer.from(contract.evm.deployedBytecode.object, "hex"), declarations = new Map();
  const walk = (value, source) => {
    if (!value || typeof value !== "object") return;
    if (value.nodeType === "VariableDeclaration" && value.mutability === "immutable") declarations.set(String(value.id), { node: value, source });
    for (const child of Object.values(value)) if (child && typeof child === "object") {
      if (Array.isArray(child)) child.forEach((item) => walk(item, source)); else walk(child, source);
    }
  };
  for (const [source, value] of Object.entries(output.sources)) walk(value.ast, source);
  const short = Buffer.alloc(32), updateType = Buffer.from("EModeCategoryUpdate"); updateType.copy(short); short[31] = updateType.length;
  const values = { AGENT_HUB: zeroPadValue(r4.A.hub, 32), RANGE_VALIDATION_MODULE: zeroPadValue(r4.A.range, 32),
    POOL: zeroPadValue(r4.A.pool, 32), UPDATE_TYPE: `0x${short.toString("hex")}` };
  const bindings = [], occupied = new Set(), names = new Set();
  for (const [id, offsets] of Object.entries(refs)) {
    const declaration = declarations.get(id), name = declaration?.node.name;
    const expectedSource = name === "AGENT_HUB" ? "lib/chaos-agents/src/contracts/agent/BaseAgent.sol" : "src/contracts/agent/BaseAaveAgent.sol";
    if (!Object.hasOwn(values, name) || declaration.source !== expectedSource || names.has(name) || !offsets.length) fail("IMMUTABLE_DECLARATION_INVALID");
    names.add(name);
    for (const { start, length } of offsets) {
      if (!Number.isInteger(start) || length !== 32 || start < 0 || start + length > runtime.length
        || !runtime.subarray(start, start + length).equals(Buffer.alloc(32))) fail("IMMUTABLE_OFFSET_INVALID");
      for (let index = start; index < start + length; index += 1) { if (occupied.has(index)) fail("IMMUTABLE_OVERLAP"); occupied.add(index); }
      Buffer.from(values[name].slice(2), "hex").copy(runtime, start);
    }
    bindings.push({ astId: id, name, source: declaration.source, value: values[name], offsets });
  }
  return { runtime: `0x${runtime.toString("hex")}`, bindings, constructorArguments: [r4.A.hub, r4.A.range, "", r4.A.pool] };
}
function build(prepared = prepare()) {
  const agentOutput = compile(prepared.agent.input), coreOutput = compile(prepared.core.input);
  const agent = instantiateAgent(agentOutput), agentIdentity = fullIdentity(agent.runtime), core = {};
  for (const [name, file] of [["AgentHub", "src/contracts/AgentHub.sol"], ["RangeValidationModule", "src/contracts/modules/RangeValidationModule.sol"]]) {
    const runtime = `0x${coreOutput.contracts[file][name].evm.deployedBytecode.object}`, identity = fullIdentity(runtime);
    const matchesPriorBuild = runtime === prepared.core.artifacts[name].deployedBytecode.object;
    if (!matchesPriorBuild) fail("CORE_REBUILD_MISMATCH", name);
    const comparison = compareCore(runtime, prepared.observed[name]);
    core[name] = { ...identity, matchesPriorBuild, explorerComparison: comparison,
      historicalFullRuntimeMatch: name === "RangeValidationModule" ? identity.keccak256 === prepared.authority.r3.report.observations.current.code.range.keccak256 : "unknown",
      historicalNormalizedRuntimeMatch: name === "RangeValidationModule" ? comparison.normalizedRuntimeMatch
        && comparison.observedFullRuntime.keccak256 === prepared.authority.r3.report.observations.current.code.range.keccak256 : "unknown" };
  }
  const agentMatches = agentIdentity.keccak256 === prepared.authority.r3.report.observations.current.code.agent.keccak256
    && agentIdentity.bytes === prepared.authority.r3.report.observations.current.code.agent.bytes;
  const report = { schema: "aave-ethereum-emode-47-48-r6-offline/v1", status: "OFFLINE_BUILD_COMPLETE", generatedAt: new Date().toISOString(),
    historicalPin: r4.PIN, compiler: prepared.compiler, proxy: prepared.proxy, agent: { ...agentIdentity, historicalFullRuntimeMatch: agentMatches,
      immutableBindings: agent.bindings, constructorArguments: agent.constructorArguments }, core,
    gates: { proxyFullByteIdentityVerified: true, agentExactRuntimeMatch: agentMatches,
      rangeHistoricalNormalizedMatch: core.RangeValidationModule.historicalNormalizedRuntimeMatch, completeRuntimeBinding: false,
      completeAuthorityVerification: false, effectiveRangeSemanticsBound: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false },
    safety: { network: false, inventoryReads: 0, rpcRequests: 0, checkoutMutation: false, signing: false },
    limitations: ["Git-object builds exclude dirty/partial worktrees; exact source revisions are enforced through gitlinks.",
      "Proxy identity uses full recorded bytes without metadata normalization; it does not alone prove proxy governance authority.",
      "Core rebuild equality is not historical deployed-code equality. Hub comparison is explorer-only; Range explorer bytes are hash-bound to R3.",
      "Agent constructor arguments are reconstructed from pinned source and scoped references, not a recovered creation transaction.",
      "Historical observations are not refreshed; oracle dependencies and complete effective-path authority remain open."] };
  for (const [file, hash] of Object.entries(prepared.sourceHashes)) pinned(file, hash);
  for (const source of Object.values(EXPLORER)) pinned(source.file, source.sha256);
  return { report, agent, observed: prepared.observed, agentInput: prepared.agent.input, agentOutput, coreInput: prepared.core.input, coreOutput,
    manifest: { repositories: prepared.repositories, gitlinks: EDGES, agentSources: prepared.agent.manifest, agentConfiguration: prepared.agent.config,
      sourceHashes: prepared.sourceHashes, compiler: prepared.compiler } };
}
function publish(bundle) {
  const output = path.join(ROOT, OUT), parent = path.dirname(output);
  if (fs.existsSync(output)) fail("OUTPUT_EXISTS");
  for (const [file, hash] of Object.entries(bundle.manifest.sourceHashes)) pinned(file, hash);
  if (!fs.lstatSync(parent).isDirectory() || path.resolve(fs.realpathSync(parent)) !== path.resolve(parent)) fail("OUTPUT_PARENT_INVALID");
  const files = { "agent.input.json": bundle.agentInput, "agent.output.json": bundle.agentOutput, "core.input.json": bundle.coreInput,
    "core.output.json": bundle.coreOutput, "agent-runtime.json": bundle.agent, "observed-runtimes.json": bundle.observed, "manifest.json": bundle.manifest };
  bundle.report.files = Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha(Buffer.from(`${JSON.stringify(data, null, 2)}\n`))]));
  bundle.report.runnerSha256 = bundle.manifest.sourceHashes["tools/build-aave-ethereum-emode-47-48-r6.js"];
  bundle.report.testsSha256 = bundle.manifest.sourceHashes["tools/test-build-aave-ethereum-emode-47-48-r6.js"];
  files["report.json"] = bundle.report;
  fs.mkdirSync(output);
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(output, name), bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (sha(fs.readFileSync(file)) !== sha(bytes)) fail("OUTPUT_VERIFICATION_FAILED");
  }
  return { output: OUT, sha256: sha(fs.readFileSync(path.join(output, "report.json"))), report: bundle.report };
}
function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 1 || !["--check", "--build"].includes(argv[0])) fail("INVOCATION_INVALID");
    const prepared = prepare();
    if (argv[0] === "--check") { console.log(JSON.stringify({ status: "OFFLINE_INPUT_CHECK_PASS", agentSources: Object.keys(prepared.agent.input.sources).length,
      coreSources: Object.keys(prepared.core.input.sources).length, compilerSha256: SOLC_SHA, proxyFullByteIdentityVerified: true, network: false })); return; }
    const result = publish(build(prepared));
    console.log(JSON.stringify({ status: result.report.status, agent: result.report.agent, core: result.report.core, output: result.output, sha256: result.sha256 }));
  } catch (error) { console.log(JSON.stringify({ status: "OFFLINE_BUILD_FAILED", code: error instanceof BuildError ? error.message : "UNEXPECTED", detail: error instanceof BuildError ? error.detail : null })); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { ROOT, OUT, AGENT, REPOS, PINS, SOLC, SOLC_SHA, EXPLORER, BuildError, sha, gitBlob, verifyRepositories, resolveImport,
  agentInput, coreInput, verifyProxy, fullIdentity, retainedRuntimes, compareCore, prepare, compile, instantiateAgent, build, publish };
